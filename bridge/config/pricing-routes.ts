// ── Pricing / LiteLLM-preview routes ───────────────────────────────────────
// Extracted from handler.ts (registerConfigRoutes) — see ./handler.ts.
'use strict';

const { config, saveConfig } = require('../core/state');
const { BridgeProviderError } = require('../core/errors');
const { normModelName, detectModelType, invalidateModelCache, getDynamicModels } = require('../models');

function registerPricingRoutes(app) {
  // ── GET /v1/config/litellm-preview — fetch LiteLLM pricing and show preview ─
  app.get('/v1/config/litellm-preview', async (req, res) => {
    let litellm;
    try {
      const r = await fetch(
        'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json'
      );
      if (!r.ok) throw new BridgeProviderError(`HTTP ${r.status}`, 502, { upstreamStatus: r.status });
      litellm = await r.json();
    } catch (e) {
      return res.status(502).json({ success: false, error: `Fetch failed: ${e.message}` });
    }
    delete litellm.sample_spec;

    const normToLitellm = new Map();
    for (const key of Object.keys(litellm)) {
      const bare = key.includes('/') ? key.split('/').slice(1).join('/') : key;
      normToLitellm.set(normModelName(bare), key);
      normToLitellm.set(normModelName(key), key);
    }

    const PROVIDER_PREFIXES = {
      Anthropic: ['anthropic/'],
      OpenAI: ['openai/'],
      Google: ['google/', 'gemini/'],
      DeepSeek: ['deepseek/'],
      Grok: ['xai/', 'grok/'],
      Mistral: ['mistral/'],
      Groq: ['groq/'],
      Cohere: ['cohere/'],
    };

    function findLitellm(localName, providerName) {
      if (litellm[localName]) return localName;
      for (const pfx of PROVIDER_PREFIXES[providerName] || []) {
        const k = pfx + localName;
        if (litellm[k]) return k;
      }
      const n = normModelName(localName);
      if (normToLitellm.has(n)) return normToLitellm.get(n);
      return null;
    }

    const round3 = (v) => Math.round(v * 1e9) / 1e9;
    const BOOL_CAPS = [
      'supports_vision',
      'supports_function_calling',
      'supports_reasoning',
      'supports_prompt_caching',
      'supports_system_messages',
    ];
    const results: any[] = [];

    for (const p of config.providers) {
      if (!p.models) continue;
      for (const [localName, m] of Object.entries(p.models)) {
        const lkey = findLitellm(localName, p.name);
        if (!lkey) continue;
        const l = litellm[lkey];
        const changes: Record<string, any> = {};

        const newIn = l.input_cost_per_token ? round3(l.input_cost_per_token * 1e6) : null;
        const newOut = l.output_cost_per_token ? round3(l.output_cost_per_token * 1e6) : null;
        if (newIn != null)
          changes.price_input = { from: (m as any).price_input ?? null, to: newIn };
        if (newOut != null)
          changes.price_output = { from: (m as any).price_output ?? null, to: newOut };

        const newCtx = l.max_input_tokens || l.max_tokens || null;
        if (newCtx)
          changes.context_length = { from: (m as any).context_length ?? null, to: newCtx };

        for (const cap of BOOL_CAPS) {
          if (l[cap] !== undefined && l[cap] !== null)
            changes[cap] = { from: (m as any)[cap] ?? null, to: l[cap] };
        }

        if (Object.keys(changes).length)
          results.push({ localName, provider: p.name, litellmKey: lkey, changes });
      }
    }
    res.json({ success: true, matches: results, total: Object.keys(litellm).length });
  });

  // ── PATCH /v1/config/pricing — update per-model pricing / capabilities ───────
  app.patch('/v1/config/pricing', async (req, res) => {
    const {
      model,
      price_input,
      price_output,
      price_per_image,
      price_per_second,
      context_length,
      supports_vision,
      supports_function_calling,
      supports_reasoning,
      supports_prompt_caching,
      supports_system_messages,
      userCategory,
    } = req.body || {};
    if (!model) return res.status(400).json({ success: false, error: 'model required' });

    const _setOrDel = (obj, key, val) => {
      if (val === null || val === undefined) {
        delete obj[key];
      } else {
        obj[key] = typeof val === 'boolean' ? val : Number(val);
      }
    };

    // userCategory uses string semantics (not number/bool). Empty string / null
    // clears the override and falls back to auto-detected category.
    const { CATEGORIES } = require('../models/detect');
    const _setCategory = (obj, val) => {
      if (val === '' || val === null || val === undefined) {
        delete obj.userCategory;
        return;
      }
      const s = String(val).trim();
      if (!CATEGORIES.includes(s)) return;
      obj.userCategory = s;
    };

    let found = false;
    let matchedProvider: string | null = null;
    let overrideBefore: string | null = null;
    const applyPricing = (m) => {
      overrideBefore = m?.userCategory || null;
      if (price_input !== undefined) _setOrDel(m, 'price_input', price_input);
      if (price_output !== undefined) _setOrDel(m, 'price_output', price_output);
      if (price_per_image !== undefined) _setOrDel(m, 'price_per_image', price_per_image);
      if (price_per_second !== undefined) _setOrDel(m, 'price_per_second', price_per_second);
      if (context_length !== undefined) _setOrDel(m, 'context_length', context_length);
      if (supports_vision !== undefined) _setOrDel(m, 'supports_vision', supports_vision);
      if (supports_function_calling !== undefined)
        _setOrDel(m, 'supports_function_calling', supports_function_calling);
      if (supports_reasoning !== undefined) _setOrDel(m, 'supports_reasoning', supports_reasoning);
      if (supports_prompt_caching !== undefined)
        _setOrDel(m, 'supports_prompt_caching', supports_prompt_caching);
      if (supports_system_messages !== undefined)
        _setOrDel(m, 'supports_system_messages', supports_system_messages);
      if (userCategory !== undefined) _setCategory(m, userCategory);
    };

    // 1. Exact match
    for (const p of config.providers) {
      if (!p.models?.[model]) continue;
      applyPricing(p.models[model]);
      found = true;
      matchedProvider = p.name;
      break;
    }

    // 2. Normalised match
    if (!found) {
      const nmodel = normModelName(model);
      outer: for (const p of config.providers) {
        if (!p.models) continue;
        for (const [key, m] of Object.entries(p.models)) {
          if (normModelName(key) === nmodel) {
            applyPricing(m);
            found = true;
            matchedProvider = p.name;
            break outer;
          }
        }
      }
    }

    // 3. Auto-create from live API model lists
    if (!found) {
      const n = normModelName(model);
      const live = getDynamicModels();
      const providerName = live.anthropic?.some((m) => normModelName(m.id) === n)
        ? 'Anthropic'
        : live.claudeSubscription?.some((name) => normModelName(name) === n)
          ? 'Anthropic'
          : live.openai?.some((m) => normModelName(m.id) === n)
            ? 'OpenAI'
            : live.openaiImage?.some((m) => normModelName(m.id) === n)
              ? 'OpenAI'
              : live.google?.some((m) => normModelName(m.id) === n)
                ? 'Google'
                : live.grok?.some((m) => normModelName(m.id) === n)
                  ? 'Grok'
                  : live.deepseek?.some((m) => normModelName(m.id) === n)
                    ? 'DeepSeek'
                    : live.nvidia?.some((m) => normModelName(m.id) === n)
                      ? 'NVIDIA'
                      : null;
      if (providerName) {
        const targetProvider = config.providers.find((pr) => pr.name === providerName);
        if (targetProvider) {
          if (!targetProvider.models) targetProvider.models = {};
          targetProvider.models[model] = { model_id: model, type: detectModelType(model) };
          applyPricing(targetProvider.models[model]);
          found = true;
          matchedProvider = providerName;
        }
      }
    }

    if (!found)
      return res.json({ success: false, skipped: true, error: 'model not found in config' });
    try {
      await saveConfig();
      invalidateModelCache();
      // Emit override_set / override_cleared events so the model tracker
      // surfaces user-driven category changes alongside auto-detected ones.
      if (userCategory !== undefined && matchedProvider) {
        try {
          const tracker = require('../modules/model-tracker/tracker');
          const after = userCategory === '' || userCategory === null ? null : String(userCategory).trim();
          if (after !== overrideBefore) {
            tracker.recordOverride(matchedProvider, model, after, overrideBefore);
          }
        } catch (_) {}
      }
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });
}

module.exports = { registerPricingRoutes };
