// ── Build the full numbered model list from caches + config ──────────────────
// Subscription models are fanned out per harness instance: one row per
// (model, claudeInstance) pair, each tagged with its synthetic provider name
// (`Anthropic-SUB`, `Anthropic-SUB2`, …). Same for Codex (`OpenAI-SUB`, …).
// The provider chip + tooltip in the UI lets the user pick a specific
// subscription; the chat route's resolveRouteType() reverses the synthetic
// name back to the underlying instance.
'use strict';

const fs = require('fs');
const path = require('path');
const { config, CODEX_BIN, modelCaches } = require('../core/state');
const { detectModelType, detectModelCategory, detectCapabilities, CATEGORIES, expandHome } = require('./detect');
const { findConfigKey, getModelPricing, getConfigMeta } = require('./config');
const { buildClaudeSubscriptionModelList, stripClaudeDateSuffix } = require('./claude-subscription');

// Per-provider+model user override stored under provider.models[name].userCategory.
// Returns one of CATEGORIES if the override is valid, otherwise null.
function getUserCategoryOverride(providerName, modelName, configKey) {
  const p = config.providers.find((pp) => pp.name === providerName);
  if (!p?.models) return null;
  const entry = p.models[configKey || modelName] || p.models[modelName];
  const cat = entry && typeof entry.userCategory === 'string' ? entry.userCategory.trim() : '';
  return cat && CATEGORIES.includes(cat) ? cat : null;
}

// Resolve the category to surface on a model entry. User override wins; otherwise
// the heuristic. Also returns `categoryAuto` so the UI can tell the user what
// the detector said vs. what they overrode it to.
function resolveCategory(providerName, modelName, configKey) {
  const auto = detectModelCategory(modelName);
  const override = getUserCategoryOverride(providerName, modelName, configKey);
  return { category: override || auto, categoryAuto: auto, categoryOverride: override };
}

function readCodexSubscriptionModelsFromCache() {
  const instances = Array.isArray(config.defaults?.codexInstances)
    ? config.defaults.codexInstances
    : [];
  const dirs = instances.length
    ? instances.map((inst) => expandHome(inst?.configDir)).filter(Boolean)
    : [expandHome(process.env.CODEX_HOME || '~/.codex')];
  const out = new Map();
  for (const dir of dirs) {
    try {
      const data = JSON.parse(fs.readFileSync(path.join(dir, 'models_cache.json'), 'utf8'));
      const models = Array.isArray(data?.models) ? data.models : [];
      for (const model of models) {
        const name = String(model?.slug || '').trim();
        if (!name || (model?.visibility && model.visibility !== 'list')) continue;
        if (!/^(gpt-|o[134]|chatgpt-)/i.test(name)) continue;
        out.set(name, {
          name,
          displayName: String(model.display_name || name).trim(),
          description: String(model.description || '').trim(),
          context_length: model.max_context_window || model.context_window || undefined,
          vision: Array.isArray(model.input_modalities) && model.input_modalities.includes('image'),
          reasoning:
            Array.isArray(model.supported_reasoning_levels) &&
            model.supported_reasoning_levels.length > 0,
          tools: true,
        });
      }
    } catch (_) {
      // Best-effort only; the async refresh path will still try the CLI.
    }
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function buildModelList() {
  if (modelCaches.list) return modelCaches.list;

  const out = [];
  const seen = new Set();
  let idx = 1;

  // Harness enable gate (from prefs/Harness tab "Enabled Harness Types").
  // Absence of the key → legacy behaviour (show configured harnesses).
  // Presence → only the ticked ones surface their SUB models and get routed to.
  const enabledHarnessTypes = Array.isArray(config.defaults?.enabledHarnessTypes)
    ? config.defaults.enabledHarnessTypes
    : null;
  const isHarnessEnabled = (t) => !enabledHarnessTypes || enabledHarnessTypes.includes(t);

  // 1. Anthropic Subscription (runs via Claude binary OAuth — no API billing)
  if (isHarnessEnabled('claude')) {
    // Union CLI/state-discovered models with the newest Anthropic API id per
    // family (opus / sonnet / haiku). Full API names are required — bare
    // rolling aliases like "opus" are rejected by the upstream API.
    const subscriptionModels = buildClaudeSubscriptionModelList();
    // Subscription models — fan out per claudeInstance. Each (model, instance)
    // pair gets its own row with provider `Anthropic-SUB` / `Anthropic-SUB2` / …
    // The picker chip shows the suffix; the tooltip surfaces `instanceLabel`.
    const claudeInstances = config.defaults?.claudeInstances || [];
    const claudeInstanceProviders = claudeInstances.length
      ? claudeInstances.map((inst, i) => ({
          providerName: i === 0 ? 'Anthropic-SUB' : `Anthropic-SUB${i + 1}`,
          instanceLabel: inst.label,
          instanceConfigDir: inst.configDir,
          instanceIndex: i,
        }))
      : [{ providerName: 'Anthropic-SUB', instanceLabel: '', instanceConfigDir: '', instanceIndex: 0 }];

    const subSeen = new Set();
    for (const name of subscriptionModels) {
      const configKey = findConfigKey(name);
      const caps = detectCapabilities(name, getConfigMeta(configKey || name));
      const pricing = getModelPricing(configKey || name);
      for (const inst of claudeInstanceProviders) {
        out.push({
          id: idx++,
          name,
          provider: inst.providerName,
          instanceLabel: inst.instanceLabel,
          instanceConfigDir: inst.instanceConfigDir,
          instanceIndex: inst.instanceIndex,
          type: 'llm',
          ...caps,
          ...pricing,
        });
      }
      subSeen.add(name);
      // Don't add to outer `seen` — base name should still be eligible for the
      // Anthropic API row (the API and SUB variants of the same model coexist).
    }
  }

  // 2. Anthropic API — full live list. The API row is now a sibling of the
  // SUB rows (each represents a different routing/billing path for the same
  // model name), so we DO emit it even when the base name is covered by SUB.
  const ap = config.providers.find((p) => p.name === 'Anthropic');
  for (const m of modelCaches.anthropic) {
    if (seen.has(m.name)) continue;
    const base = stripClaudeDateSuffix(m.id);
    const configKey = findConfigKey(m.name);
    const pricing = getModelPricing(configKey || base || m.name);
    const entry: any = {
      id: idx++,
      name: m.name,
      provider: 'Anthropic API',
      type: 'llm',
      displayName: m.displayName,
      ...detectCapabilities(m.name, getConfigMeta(configKey || base || m.name)),
      ...pricing,
    };
    if (configKey && configKey !== m.name) entry.configKey = configKey;
    else if (base !== m.name) entry.configKey = base;
    out.push(entry);
    seen.add(m.name);
  }
  // Fallback: if live fetch hasn't run yet, add from config
  if (!modelCaches.anthropic.length && ap?.models) {
    for (const name of Object.keys(ap.models)) {
      if (!seen.has(name)) {
        out.push({
          id: idx++,
          name,
          provider: 'Anthropic API',
          type: 'llm',
          ...detectCapabilities(name, getConfigMeta(name)),
          ...getModelPricing(name),
        });
        seen.add(name);
      }
    }
  }

  // 3. OpenAI — LLM + image models
  const oap = config.providers.find((p) => p.name === 'OpenAI');
  const openAIAllModels = [
    ...(modelCaches.openai.length
      ? modelCaches.openai
      : Object.keys(oap?.models || {}).map((n) => ({ name: n }))),
    ...modelCaches.openaiImage,
  ];
  for (const m of openAIAllModels) {
    if (!seen.has(m.name)) {
      const configKey = findConfigKey(m.name);
      const pricing = getModelPricing(configKey || m.name);
      const entry: any = {
        id: idx++,
        name: m.name,
        provider: 'OpenAI',
        type: detectModelType(m.name),
        ...detectCapabilities(m.name, getConfigMeta(configKey || m.name)),
        ...pricing,
      };
      if (configKey && configKey !== m.name) entry.configKey = configKey;
      out.push(entry);
      seen.add(m.name);
    }
  }

  // 4. Google / Gemini
  const gp = config.providers.find((p) => p.name === 'Google');
  const googleModels = modelCaches.google.length
    ? modelCaches.google
    : Object.keys(gp?.models || {}).map((n) => ({ name: n }));
  for (const m of googleModels) {
    if (!seen.has(m.name)) {
      const configKey = findConfigKey(m.name);
      const pricing = getModelPricing(configKey || m.name);
      const entry: any = {
        id: idx++,
        name: m.name,
        provider: 'Google',
        type: detectModelType(m.name),
        displayName: m.displayName,
        ...detectCapabilities(m.name, getConfigMeta(configKey || m.name)),
        ...pricing,
      };
      if (configKey && configKey !== m.name) entry.configKey = configKey;
      out.push(entry);
      seen.add(m.name);
    }
  }

  // 5. Grok / xAI
  const gkp = config.providers.find((p) => p.name === 'Grok');
  const grokModels = modelCaches.grok.length
    ? modelCaches.grok
    : Object.keys(gkp?.models || {}).map((n) => ({ name: n }));
  for (const m of grokModels) {
    if (!seen.has(m.name)) {
      out.push({
        id: idx++,
        name: m.name,
        provider: 'Grok',
        type: detectModelType(m.name),
        ...detectCapabilities(m.name, getConfigMeta(m.name)),
        ...getModelPricing(m.name),
      });
      seen.add(m.name);
    }
  }

  // 6. OpenRouter — live-fetched models (all chat-compatible via OpenAI-compat API)
  const orp = config.providers.find((p) => p.name === 'OpenRouter');
  const openRouterModels = modelCaches.openrouter.length
    ? modelCaches.openrouter
    : Object.keys(orp?.models || {}).map((n) => ({ name: n }));
  for (const m of openRouterModels) {
    if (!seen.has(m.name)) {
      const configKey = findConfigKey(m.name);
      const pricing = getModelPricing(configKey || m.name);
      // Merge config meta (lower priority) with live OpenRouter metadata (higher priority).
      // Live supported_parameters wins; config fills in anything OpenRouter doesn't declare.
      const cfgMeta = getConfigMeta(configKey || m.name);
      const meta = m.tools !== undefined ? { ...(cfgMeta || {}), tools: m.tools } : cfgMeta;
      const entry: any = {
        id: idx++,
        name: m.name,
        provider: 'OpenRouter',
        type: detectModelType(m.name),
        displayName: m.displayName,
        ...detectCapabilities(m.name, meta),
        ...pricing,
      };
      if (configKey && configKey !== m.name) entry.configKey = configKey;
      out.push(entry);
      seen.add(m.name);
    }
  }

  // 7. NVIDIA NIM — live-fetched models
  const nvp = config.providers.find((p) => p.name === 'NVIDIA');
  const nvidiaModels = modelCaches.nvidia.length
    ? modelCaches.nvidia
    : Object.keys(nvp?.models || {}).map((n) => ({ name: n }));
  for (const m of nvidiaModels) {
    if (!seen.has(m.name)) {
      const configKey = findConfigKey(m.name);
      const pricing = getModelPricing(configKey || m.name);
      const entry: any = {
        id: idx++,
        name: m.name,
        provider: 'NVIDIA',
        type: detectModelType(m.name),
        ...detectCapabilities(m.name, getConfigMeta(configKey || m.name)),
        ...pricing,
      };
      if (configKey && configKey !== m.name) entry.configKey = configKey;
      out.push(entry);
      seen.add(m.name);
    }
  }

  // 8b. Codex / OpenAI Subscription — fan out per codexInstance same way as Claude.
  if (
    isHarnessEnabled('codex') &&
    (
      config.defaults?.codexBin ||
      CODEX_BIN !== 'codex' ||
      (config.defaults?.codexInstances || []).length
    )
  ) {
    const cachedCodexSubModels = readCodexSubscriptionModelsFromCache();
    const CODEX_SUB_MODELS = modelCaches.codexSubscription.length
      ? modelCaches.codexSubscription
      : cachedCodexSubModels.length
        ? cachedCodexSubModels
        : [{
            name: 'default',
            displayName: 'Codex default',
            description: 'Uses the authenticated Codex subscription default model.',
            vision: true,
            reasoning: true,
            tools: true,
          }];
    const codexInstances = config.defaults?.codexInstances || [];
    const codexInstanceProviders = codexInstances.length
      ? codexInstances.map((inst, i) => ({
          providerName: i === 0 ? 'OpenAI-SUB' : `OpenAI-SUB${i + 1}`,
          instanceLabel: inst.label,
          instanceConfigDir: inst.configDir,
          instanceIndex: i,
        }))
      : [{ providerName: 'OpenAI-SUB', instanceLabel: '', instanceConfigDir: '', instanceIndex: 0 }];

    for (const item of CODEX_SUB_MODELS) {
      const name = typeof item === 'string' ? item : item.name;
      const fullId = 'codex/' + name;
      for (const inst of codexInstanceProviders) {
        const entry: any = {
          id: idx++,
          name: fullId,
          provider: inst.providerName,
          instanceLabel: inst.instanceLabel,
          instanceConfigDir: inst.instanceConfigDir,
          instanceIndex: inst.instanceIndex,
          type: 'llm',
          tools: typeof item === 'string' ? true : !!item.tools,
          vision: typeof item === 'string' ? /^gpt-4|^gpt-5|^chatgpt-/i.test(name) : !!item.vision,
          reasoning: typeof item === 'string' ? name.startsWith('o') : !!item.reasoning,
        };
        if (typeof item !== 'string') {
          if (item.displayName) entry.displayName = item.displayName;
          if (item.description) entry.description = item.description;
          if (item.context_length) entry.context_length = item.context_length;
        }
        out.push(entry);
      }
    }
  }

  // 8bb. Grok Build Subscription — fan out per grokInstance same way as Codex.
  // `grok models` returns only the names this OAuth session has access to
  // (today: just `grok-build` on SuperGrok). Each (model, instance) pair gets
  // its own row tagged `Grok-SUB` / `Grok-SUB2` / … The Go-core route layer's
  // `^Grok-SUB\d*$` matcher reverses the synthetic name back to the instance.
  if (
    isHarnessEnabled('grok') &&
    (
      config.defaults?.grokBin ||
      (config.defaults?.grokInstances || []).length
    )
  ) {
    const GROK_SUB_FALLBACK = ['grok-build'];
    const grokSubModels = modelCaches.grokSubscription.length
      ? modelCaches.grokSubscription
      : GROK_SUB_FALLBACK;
    const grokInstances = config.defaults?.grokInstances || [];
    const grokInstanceProviders = grokInstances.length
      ? grokInstances.map((inst, i) => ({
          providerName: i === 0 ? 'Grok-SUB' : `Grok-SUB${i + 1}`,
          instanceLabel: inst.label,
          instanceConfigDir: inst.configDir,
          instanceIndex: i,
        }))
      : [{ providerName: 'Grok-SUB', instanceLabel: '', instanceConfigDir: '', instanceIndex: 0 }];

    for (const name of grokSubModels) {
      for (const inst of grokInstanceProviders) {
        out.push({
          id: idx++,
          name,
          provider: inst.providerName,
          instanceLabel: inst.instanceLabel,
          instanceConfigDir: inst.instanceConfigDir,
          instanceIndex: inst.instanceIndex,
          type: 'llm',
          tools: true,
          vision: true,
          reasoning: true,
        });
      }
    }

    // Grok-SUB media — grok-imagine-image-pro / grok-imagine-video. Only emitted
    // when at least one grokInstance has a usable auth.json (validated by the
    // fetcher into modelCaches.grokSubscriptionMedia). The MCP media-server
    // dispatches `Grok-SUB*` providers to api.x.ai using the OAuth `key` token
    // from auth.json instead of the team's API key.
    const grokSubMedia = modelCaches.grokSubscriptionMedia || [];
    for (const media of grokSubMedia) {
      for (const inst of grokInstanceProviders) {
        out.push({
          id: idx++,
          name: media.name,
          provider: inst.providerName,
          instanceLabel: inst.instanceLabel,
          instanceConfigDir: inst.instanceConfigDir,
          instanceIndex: inst.instanceIndex,
          type: media.kind,
          tools: false,
          vision: false,
          reasoning: false,
        });
      }
    }
  }

  // 8c. DeepSeek — live models + config aliases (old names like deepseek-chat are valid aliases)
  const dsp = config.providers.find((p) => p.name === 'DeepSeek');
  const deepseekModels = [
    ...modelCaches.deepseek,
    ...Object.keys(dsp?.models || {}).map((n) => ({ name: n })),
  ];
  for (const m of deepseekModels) {
    if (!seen.has(m.name)) {
      const configKey = findConfigKey(m.name);
      const pricing = getModelPricing(configKey || m.name);
      const entry: any = {
        id: idx++,
        name: m.name,
        provider: 'DeepSeek',
        type: detectModelType(m.name),
        ...detectCapabilities(m.name, getConfigMeta(configKey || m.name)),
        ...pricing,
      };
      if (configKey && configKey !== m.name) entry.configKey = configKey;
      out.push(entry);
      seen.add(m.name);
    }
  }

  // 9. All other configured providers — merges any models stored under
  // `p.models` in config.json with live-fetched models in
  // `modelCaches.byProvider[p.name]` (populated by fetchExtraProvidersModels
  // for entries with fetch_live:true). Hidden providers are skipped entirely.
  const handled = new Set([
    'Anthropic',
    'OpenAI',
    'Google',
    'Grok',
    'OpenRouter',
    'NVIDIA',
    'DeepSeek',
  ]);
  for (const p of config.providers) {
    if (handled.has(p.name) || p.hidden) continue;
    const liveModels = modelCaches.byProvider?.[p.name] || [];
    const configNames = p.models ? Object.keys(p.models) : [];
    const names = new Set<string>([
      ...liveModels.map((m) => m.name),
      ...configNames,
    ]);
    if (!names.size) continue;
    for (const name of names) {
      if (seen.has(name)) continue;
      out.push({
        id: idx++,
        name,
        provider: p.name,
        type: p.models?.[name]?.type || 'llm',
        ...detectCapabilities(name, getConfigMeta(name)),
        ...getModelPricing(name),
      });
      seen.add(name);
    }
  }

  // ── Category + modality pass ──────────────────────────────────────────────
  // Surface `category` on every entry (canonical CATEGORIES value) plus
  // `categoryAuto` (what the detector guessed) and `categoryOverride` (set
  // iff the user picked something different in prefs/Models). Subscription
  // rows (Anthropic-SUB, OpenAI-SUB, Grok-SUB) always read from the base API
  // provider's model config for overrides, since the SUB row never has its
  // own config.
  //
  // `modality` is the coarse picker bucket: 'llm' | 'image' | 'video' |
  // 'tts' | 'stt' | 'music' | 'realtime' | 'embedding' | 'other'. Derived
  // from the final category so the FE picker can branch the UI (e.g. show
  // the media param panel for image/video) without regex-matching ids.
  const modalityOf = (cat: string): string => {
    if (cat === 'llm' || cat === 'image' || cat === 'video' || cat === 'tts' || cat === 'stt' || cat === 'music' || cat === 'realtime') return cat;
    if (cat === 'embedding' || cat === 'code-embedding') return 'embedding';
    return 'other';
  };
  for (const entry of out) {
    const baseProvider = entry.provider === 'Anthropic-SUB' || /^Anthropic-SUB\d+$/.test(entry.provider)
      ? 'Anthropic'
      : entry.provider === 'OpenAI-SUB' || /^OpenAI-SUB\d+$/.test(entry.provider)
      ? 'OpenAI'
      : entry.provider === 'Grok-SUB' || /^Grok-SUB\d+$/.test(entry.provider)
      ? 'Grok'
      : entry.provider === 'Anthropic API'
      ? 'Anthropic'
      : entry.provider;
    const lookupName = entry.name.startsWith('codex/') ? entry.name.slice('codex/'.length) : entry.name;
    const { category, categoryAuto, categoryOverride } = resolveCategory(
      baseProvider,
      lookupName,
      entry.configKey
    );
    entry.category = category;
    entry.categoryAuto = categoryAuto;
    if (categoryOverride) entry.categoryOverride = categoryOverride;
    entry.modality = modalityOf(category);
  }

  modelCaches.list = out;
  return out;
}

module.exports = { buildModelList };
