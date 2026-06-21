// ── Provider lookup, model resolution, shared provider helpers ───────────────
'use strict';

const fs = require('fs');
const path = require('path');

const { config, activeModels, getSystemPromptsMap } = require('../core/state');
const { buildModelList, detectModelType, getDynamicModels } = require('../models');

function findProvider(modelIdOrNum, providerNameHint?: string) {
  // Explicit provider override: look up directly by provider name
  if (providerNameHint) {
    const provider = config.providers.find((p) => p.name === providerNameHint);
    if (provider) {
      const id = String(modelIdOrNum);
      return { provider, model: { model_id: id, type: detectModelType(id) } };
    }
  }

  const id = String(modelIdOrNum);

  if (/^\d+$/.test(id)) {
    const models = buildModelList();
    const found = models.find((m) => String(m.id) === id);
    if (found) return findProvider(found.name);
    return null;
  }

  if (id.startsWith('claude-')) {
    const ap = config.providers.find((p) => p.name === 'Anthropic');
    if (!ap) return null;
    // Caller can force a specific Claude routing via providerNameHint:
    //   - 'Anthropic-SUB' / 'Anthropic-SUB2' / 'Anthropic Subscription' → subscription path
    //   - 'Anthropic API' / 'Anthropic'                                 → API key path
    // Otherwise fall back to whatever activeModels has selected.
    let providerLabel: string;
    if (
      /^Anthropic-SUB\d*$/.test(String(providerNameHint || '')) ||
      providerNameHint === 'Anthropic Subscription' ||
      providerNameHint === 'Anthropic API'
    ) {
      providerLabel = providerNameHint;
    } else {
      const active = activeModels.llm.provider;
      providerLabel =
        activeModels.llm.model === id && (/^Anthropic-SUB\d*$/.test(String(active)) || active === 'Anthropic Subscription')
          ? active
          : 'Anthropic API';
    }
    return { provider: { ...ap, name: providerLabel }, model: { model_id: id, type: 'llm' } };
  }

  for (const p of config.providers) {
    if (!p.models) continue;
    const model = p.models[id];
    if (model) return { provider: p, model };
  }

  const { openai, openaiImage, google, grok, openrouter, nvidia, byProvider } = getDynamicModels();
  const dynamicProviderMap = [
    { list: openai, name: 'OpenAI' },
    { list: openaiImage, name: 'OpenAI' },
    { list: google, name: 'Google' },
    { list: grok, name: 'Grok' },
    { list: openrouter, name: 'OpenRouter' },
    { list: nvidia, name: 'NVIDIA' },
  ];
  for (const { list, name } of dynamicProviderMap) {
    if (list.some((m) => m.id === id || m.name === id)) {
      const provider = config.providers.find((pr) => pr.name === name);
      if (provider) return { provider, model: { model_id: id, type: detectModelType(id) } };
    }
  }

  // Custom dynamic providers (Ollama, LM Studio, …) — live-fetched into
  // modelCaches.byProvider by fetchExtraProvidersModels.
  if (byProvider) {
    for (const [providerName, list] of Object.entries(byProvider)) {
      if (!Array.isArray(list)) continue;
      if (list.some((m) => m.id === id || m.name === id)) {
        const provider = config.providers.find((pr) => pr.name === providerName);
        if (provider) return { provider, model: { model_id: id, type: detectModelType(id) } };
      }
    }
  }

  return null;
}

function resolveModelId(raw) {
  const value = String(raw || '');
  if (/^\d+$/.test(value)) {
    const models = buildModelList();
    return models.find((m) => String(m.id) === value)?.name ?? value;
  }
  return value;
}

function isClaudeModel(id) {
  return /^(?:claude-|sonnet$|opus$|haiku$)/i.test(String(id).trim());
}
function isGeminiModel(id) {
  return /^gemini-/i.test(String(id));
}

// Infer api_style from model id when no provider entry is available.
// Mirrors the old model-name regexes exactly so existing routing is preserved.
function inferApiStyleFromModelId(id: string): 'anthropic' | 'openai' | 'google' {
  if (isClaudeModel(id)) return 'anthropic';
  if (isGeminiModel(id)) return 'google';
  return 'openai';
}

// Single source of truth for stream dispatch. Prefers the provider entry's
// explicit api_style; falls back to the model-name regex for cases where the
// provider entry isn't known yet (e.g. dynamic model lookup hasn't run).
function getApiStyle(modelId, providerHint?: string): 'anthropic' | 'openai' | 'google' {
  if (providerHint) {
    const p = config.providers.find((pr) => pr.name === providerHint);
    if (p?.api_style) return p.api_style;
  }
  const found = findProvider(modelId, providerHint);
  if (found?.provider?.api_style) return found.provider.api_style;
  return inferApiStyleFromModelId(String(modelId));
}

// ── Synthetic per-instance provider names ────────────────────────────────────
// Each subscription instance is exposed as its own provider in the model list.
// Provider name = `<base>-SUB` (first instance) / `<base>-SUB2` / `<base>-SUB3`
// where base is "Anthropic" for claudeInstances, "OpenAI" for codexInstances.
// Tooltip in the UI shows the instance.label; the chip text is just the suffix.

function _claudeInstanceProviderName(index) {
  return index === 0 ? 'Anthropic-SUB' : `Anthropic-SUB${index + 1}`;
}
function _codexInstanceProviderName(index) {
  return index === 0 ? 'OpenAI-SUB' : `OpenAI-SUB${index + 1}`;
}

function getClaudeInstanceProviders() {
  const list = config.defaults?.claudeInstances || [];
  return list.map((inst, i) => ({
    name: _claudeInstanceProviderName(i),
    index: i,
    label: inst.label,
    configDir: inst.configDir,
    claudeBin: inst.claudeBin,
  }));
}

function getCodexInstanceProviders() {
  const list = config.defaults?.codexInstances || [];
  return list.map((inst, i) => ({
    name: _codexInstanceProviderName(i),
    index: i,
    label: inst.label,
    configDir: inst.configDir,
    codexBin: inst.codexBin,
  }));
}

// Map a provider name back to its underlying instance, with backward-compat
// for the legacy "Anthropic Subscription" / "OpenAI Subscription" labels
// (both alias to the first configured instance — matches behavior pre-fanout).
function resolveSubscriptionProvider(providerName) {
  if (!providerName) return null;
  const claudeMatch = /^Anthropic-SUB(\d*)$/.exec(providerName);
  if (claudeMatch || providerName === 'Anthropic Subscription') {
    const index = claudeMatch ? (claudeMatch[1] ? parseInt(claudeMatch[1], 10) - 1 : 0) : 0;
    const list = config.defaults?.claudeInstances || [];
    const inst = list[index];
    if (!inst) return null;
    return { kind: 'claude', index, instance: inst, providerName: _claudeInstanceProviderName(index) };
  }
  const codexMatch = /^OpenAI-SUB(\d*)$/.exec(providerName);
  if (codexMatch || providerName === 'OpenAI Subscription') {
    const index = codexMatch ? (codexMatch[1] ? parseInt(codexMatch[1], 10) - 1 : 0) : 0;
    const list = config.defaults?.codexInstances || [];
    const inst = list[index];
    if (!inst) return null;
    return { kind: 'codex', index, instance: inst, providerName: _codexInstanceProviderName(index) };
  }
  return null;
}

function isClaudeSubscriptionProvider(providerName) {
  return /^Anthropic-SUB\d*$/.test(providerName) || providerName === 'Anthropic Subscription';
}
function isCodexSubscriptionProvider(providerName) {
  return /^OpenAI-SUB\d*$/.test(providerName) || providerName === 'OpenAI Subscription';
}

function isSubscriptionModel(name, providerHint) {
  if (providerHint) return isClaudeSubscriptionProvider(providerHint);
  const models = buildModelList();
  const model = models.find((m) => m.name === name);
  if (model) return isClaudeSubscriptionProvider(model.provider);
  // Versioned IDs (e.g. claude-haiku-4-5-20251001) may not be in the list if the API
  // now returns only base names — check if the stripped base name is a subscription model.
  const baseName = name.replace(/-\d{8}$/, '').replace(/-[a-z]+-\d{8}$/, '');
  if (baseName !== name) {
    const baseModel = models.find((m) => m.name === baseName);
    if (baseModel) return isClaudeSubscriptionProvider(baseModel.provider);
  }
  return false;
}

function isSlashCommand(input) {
  return /^\/[a-z]/.test(String(input).trim());
}

const getDefaultSystem = () =>
  getSystemPromptsMap()[config.defaults?.preset] ||
  'You are a helpful assistant. Always respond in the same language the user writes in, defaulting to English.';

const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function presetText(nameOrText) {
  if (nameOrText === null || nameOrText === undefined || nameOrText === '') return '';
  const s = String(nameOrText);
  if (/^\d+$/.test(s)) {
    const vals = Object.values(getSystemPromptsMap());
    return vals[parseInt(s, 10)] || getDefaultSystem();
  }
  const presets = getSystemPromptsMap();
  if (presets[s]) return presets[s];
  return s;
}

function historyModeNotice() {
  const mode = String(config.defaults?.chat_history_mode || 'turns');
  if (mode === 'split_80_20') {
    return 'History policy: context is intentionally mixed (about 20% earliest + 80% most recent) to preserve origin and recency under budget.';
  }
  if (mode === 'turns_chars') {
    return 'History policy: context is trimmed to recent turns and a recent-character budget.';
  }
  return 'History policy: context is trimmed to recent turns.';
}

function getInstalledPluginDirs() {
  const pluginsFile = path.join(
    process.env.HOME || process.env.USERPROFILE || require('os').homedir(),
    '.claude',
    'plugins',
    'installed_plugins.json'
  );
  try {
    const data = JSON.parse(fs.readFileSync(pluginsFile, 'utf8'));
    const dirs = [];
    for (const entries of Object.values(data.plugins || {}) as any[]) {
      for (const entry of entries) {
        if (entry.installPath) dirs.push(entry.installPath);
      }
    }
    return dirs;
  } catch (_) {
    return [];
  }
}

let _agentsCache = null;
let _agentsCacheTime = 0;
const AGENTS_CACHE_TTL = 30_000;

function loadAgentsJson() {
  const now = Date.now();
  if (_agentsCache && now - _agentsCacheTime < AGENTS_CACHE_TTL) return _agentsCache;

  const agentsDir = path.join(process.env.HOME || process.env.USERPROFILE || require('os').homedir(), '.claude', 'agents');
  const result = {};
  try {
    const files = fs.readdirSync(agentsDir).filter((f) => f.endsWith('.md'));
    for (const file of files) {
      try {
        const content = fs.readFileSync(path.join(agentsDir, file), 'utf8');
        const fm = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
        if (!fm) continue;
        const meta: Record<string, any> = {};
        fm[1].split('\n').forEach((line) => {
          const match = line.match(/^(\w+):\s*(.+)$/);
          if (match) meta[match[1].trim()] = match[2].trim();
        });
        const name = meta.name || path.basename(file, '.md');
        const description = meta.description || '';
        const prompt = fm[2].trim();
        result[name] = { description, prompt };
      } catch (_) {}
    }
  } catch (_) {}

  _agentsCache = result;
  _agentsCacheTime = now;
  return result;
}

const PERM_DENIED_PATTERNS = [
  'Claude requested permissions',
  "hasn't granted it yet",
  'requires approval',
  'This command requires approval',
  'permission denied',
  'Permission denied',
  'Bash command contains multiple operations',
];

// ── Provider route resolution ─────────────────────────────────────────────────
// Single source of truth: given a model + providerHint, decide which streaming
// path to use. Callers (stream route, employee runner, etc.) all use this so the
// subscription-vs-API decision is never duplicated.
//
// Returns one of:
//   { type: 'codex', subscription?: { instance, index } }
//   { type: 'external', providerName: string | null }  — null = auto-detect by model name
//   { type: 'direct-anthropic' }
//   { type: 'claude', resolvedProvider: <provider-name>, subscription?: { instance, index } }
//
// `subscription` is populated when the providerHint resolves to a specific
// claudeInstance / codexInstance — the chat route uses it to pin
// CLAUDE_CONFIG_DIR / CODEX_HOME to that instance, overriding any
// HarnessInstance / CodexInstance picker value.
function resolveRouteType(modelId, providerHint, opts) {
  const isSlash = Boolean(opts?.isSlash);
  const subResolved = resolveSubscriptionProvider(providerHint);

  // Slash commands always run through Claude binary — skip all external routing
  if (isSlash) {
    return {
      type: 'claude',
      resolvedProvider: _resolveClaudeProvider(modelId, providerHint),
      ...(subResolved?.kind === 'claude' ? { subscription: { instance: subResolved.instance, index: subResolved.index } } : {}),
    };
  }

  // Codex binary path (runs regardless of Anthropic provider config)
  if (String(modelId).startsWith('codex/')) {
    return {
      type: 'codex',
      ...(subResolved?.kind === 'codex' ? { subscription: { instance: subResolved.instance, index: subResolved.index } } : {}),
    };
  }

  // Explicit non-Anthropic provider → route through that provider's API
  // (BUT: an Anthropic-SUBn / OpenAI-SUBn label is a subscription, not an external provider;
  //  'Anthropic API' is a synthetic picker name meaning "API-billed Claude" — it must fall
  //  through to the Claude routing below, not be treated as an unknown external provider.)
  const hint = String(providerHint || '').trim();
  if (
    hint &&
    hint !== 'Anthropic' &&
    hint !== 'Anthropic API' &&
    !isClaudeSubscriptionProvider(hint) &&
    !isCodexSubscriptionProvider(hint)
  ) {
    return { type: 'external', providerName: hint, api_style: getApiStyle(modelId, hint) };
  }

  // Non-Claude model with no Claude-flavored hint → external API (auto-detect)
  if (!isClaudeModel(modelId) && !isClaudeSubscriptionProvider(hint)) {
    return { type: 'external', providerName: null, api_style: getApiStyle(modelId) };
  }

  // Claude model: resolve subscription status, then pick binary vs direct API
  const resolvedProvider = _resolveClaudeProvider(modelId, providerHint);
  const apiKey = opts?.apiKey;
  const apiMode = opts?.apiMode;
  // claudeRuntime: 'binary' and anthropicApiMode: 'binary'/'sdk' are explicit
  // user choices — honor them even when an API key is configured. 'sdk' routes
  // API-paid models through the Claude Agent SDK harness (rather than the
  // direct streamAnthropic path), which surfaces reasoning + MCP tools.
  const claudeRuntime = opts?.claudeRuntime;
  if (
    apiKey
    && !isClaudeSubscriptionProvider(resolvedProvider)
    && apiMode !== 'binary'
    && apiMode !== 'sdk'
    && claudeRuntime !== 'binary'
  ) {
    return { type: 'direct-anthropic' };
  }

  return {
    type: 'claude',
    resolvedProvider,
    ...(subResolved?.kind === 'claude' ? { subscription: { instance: subResolved.instance, index: subResolved.index } } : {}),
  };
}

function _resolveClaudeProvider(modelId, providerHint) {
  if (isClaudeSubscriptionProvider(providerHint)) return providerHint || 'Anthropic-SUB';
  // 'Anthropic' and 'Anthropic API' both mean API-billed (non-subscription) path.
  if (providerHint === 'Anthropic' || providerHint === 'Anthropic API') return 'Anthropic';
  // No hint — look up in model list (returns first matching synthetic name e.g. "Anthropic-SUB")
  if (isSubscriptionModel(modelId)) {
    const models = buildModelList();
    const m = models.find((x) => x.name === modelId);
    return m?.provider || 'Anthropic-SUB';
  }
  return 'Anthropic';
}

module.exports = {
  findProvider,
  resolveModelId,
  isClaudeModel,
  isGeminiModel,
  inferApiStyleFromModelId,
  getApiStyle,
  isSubscriptionModel,
  isClaudeSubscriptionProvider,
  isCodexSubscriptionProvider,
  resolveSubscriptionProvider,
  getClaudeInstanceProviders,
  getCodexInstanceProviders,
  isSlashCommand,
  resolveRouteType,
  getDefaultSystem,
  EFFORT_LEVELS,
  presetText,
  historyModeNotice,
  getInstalledPluginDirs,
  loadAgentsJson,
  PERM_DENIED_PATTERNS,
  buildImportantFooter: require('../context/global').buildImportantFooter,
};
