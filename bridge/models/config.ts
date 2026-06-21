// ── Config-side model lookup, pricing, capability meta, cache invalidation ────
'use strict';

const fs = require('fs');
const { config, CONFIG_PATH, modelCaches, writeJsonSync } = require('../core/state');
const logger = require('../core/logger');

// Per-provider serialization for `config.providers[i].models` mutations + the
// follow-up `writeJsonSync(CONFIG_PATH, config)` call. Without this lock, two
// concurrent fetch-models POSTs for the same provider could interleave their
// merge/write phases against the shared `op.models` ref and lose a half of
// either fetch's pricing delta. The lock is per-provider so unrelated
// providers (OpenRouter vs. NVIDIA) still progress in parallel.
const _providerConfigChain = new Map<string, Promise<void>>();

async function withProviderConfigLock(providerName: string, fn: () => void | Promise<void>): Promise<void> {
  const prev = _providerConfigChain.get(providerName) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(async () => { await fn(); });
  _providerConfigChain.set(providerName, next.catch(() => {}));
  try {
    await next;
  } finally {
    // GC the slot once the chain has drained — concurrent callers would have
    // observed `prev` before we overwrote, so dropping the entry here only
    // frees memory; subsequent calls get a fresh resolved Promise.
    if (_providerConfigChain.get(providerName) === next.catch(() => {})) {
      _providerConfigChain.delete(providerName);
    }
  }
}

// Normalise a model name for fuzzy matching
function normModelName(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/-\d{4}-\d{2}-\d{2}$/, '')
    .replace(/-\d{8}$/, '')
    .replace(/[.\-_\s]/g, '');
}

function getProviderForModel(modelId) {
  if (!modelId) return 'unknown';
  const n = normModelName(modelId);
  for (const p of config.providers) {
    if (!p.models) continue;
    for (const key of Object.keys(p.models)) {
      if (normModelName(key) === n) return p.name;
    }
  }
  return 'unknown';
}

function findConfigKey(name) {
  const n = normModelName(name);
  for (const p of config.providers) {
    if (!p.models) continue;
    for (const key of Object.keys(p.models)) {
      if (normModelName(key) === n) return key;
    }
  }
  return null;
}

// Remove config.json entries for a provider whose names no longer appear in
// the live API list. Serialized per-provider via `withProviderConfigLock` so
// concurrent fetch-models calls can't interleave their merge/prune writes.
async function pruneStaleConfigModels(providerName, liveIds): Promise<void> {
  if (!liveIds.length) return;
  await withProviderConfigLock(providerName, () => {
    const p = config.providers.find((pr) => pr.name === providerName);
    if (!p?.models) return;
    const liveNorm = new Set(liveIds.map((id) => normModelName(id)));
    const PRICE_FIELDS = ['price_input', 'price_output', 'price_per_image', 'price_per_second'];
    const toRemove = Object.keys(p.models).filter((key) => {
      if (liveNorm.has(normModelName(key))) return false;
      const m = p.models[key];
      if (PRICE_FIELDS.some((f) => m[f] !== undefined)) return false;
      return true;
    });
    if (!toRemove.length) return;
    for (const key of toRemove) delete p.models[key];
    try {
      writeJsonSync(CONFIG_PATH, config);
      logger.info('models.pruned-stale', { provider: providerName, count: toRemove.length, models: toRemove.join(', ') });
    } catch (e) {
      logger.warn('models.prune-write-failed', { error: e instanceof Error ? e.message : String(e) });
    }
    modelCaches.list = null;
  });
}

function getModelPricing(modelName) {
  for (const p of config.providers) {
    if (!p.models) continue;
    const m = p.models[modelName];
    if (m) {
      const out: Record<string, any> = {};
      if (m.price_input !== undefined) out.price_input = m.price_input;
      if (m.price_output !== undefined) out.price_output = m.price_output;
      if (m.price_per_image !== undefined) out.price_per_image = m.price_per_image;
      if (m.price_per_second !== undefined) out.price_per_second = m.price_per_second;
      if (m.context_length !== undefined) out.context_length = m.context_length;
      return Object.keys(out).length ? out : null;
    }
  }
  return null;
}

// Read capability flags declared in config.json for a model.
// Returns a meta object suitable for passing to detectCapabilities(), or undefined if nothing found.
// Priority for callers: live provider API data > this config meta > regex heuristic.
function getConfigMeta(modelName) {
  for (const p of config.providers) {
    if (!p.models) continue;
    const m = p.models[modelName];
    if (!m) continue;
    const meta: Record<string, any> = {};
    if (m.supports_function_calling !== undefined) meta.tools = !!m.supports_function_calling;
    if (m.supports_vision !== undefined) meta.vision = !!m.supports_vision;
    if (m.supports_reasoning !== undefined) meta.reasoning = !!m.supports_reasoning;
    return Object.keys(meta).length ? meta : undefined;
  }
  return undefined;
}

// Invalidate the cached model list (called after config changes)
function invalidateModelCache() {
  modelCaches.list = null;
}

// Return the live-fetched model arrays (used by findProvider fallback)
function getDynamicModels() {
  return {
    anthropic: modelCaches.anthropic,
    claudeSubscription: modelCaches.claudeSubscription,
    openai: modelCaches.openai,
    openaiImage: modelCaches.openaiImage,
    codexSubscription: modelCaches.codexSubscription,
    google: modelCaches.google,
    grok: modelCaches.grok,
    openrouter: modelCaches.openrouter,
    nvidia: modelCaches.nvidia,
    deepseek: modelCaches.deepseek,
    byProvider: modelCaches.byProvider || {},
  };
}

module.exports = {
  normModelName,
  getProviderForModel,
  findConfigKey,
  pruneStaleConfigModels,
  withProviderConfigLock,
  getModelPricing,
  getConfigMeta,
  invalidateModelCache,
  getDynamicModels,
};
