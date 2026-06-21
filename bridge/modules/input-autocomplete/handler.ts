// Routes for the input-autocomplete module.
//
//   POST /v1/input-autocomplete/suggest   { text } → { suggestion }
//   GET  /v1/input-autocomplete/config                → { config }
//   PATCH /v1/input-autocomplete/config   { ... }    → { config }
//
// Config is stored under config.defaults.inputAutocomplete and persisted via
// the standard config writer (same pattern as defaults.autoTitle).
'use strict';

const { _complete } = require('./llm');

const DEFAULTS = {
  enabled:               false,
  model:                 'nvidia/nemotron-mini-4b-instruct',
  provider:              'NVIDIA',
  // Two debounces, picked per keystroke based on whether the current value
  // ends at a "boundary" (whitespace / sentence punctuation). Boundary =
  // the user has finished a word, so a short wait feels snappy. Mid-word
  // = they're still typing, so wait a lot longer before guessing.
  debounceBoundaryMs:    500,
  debounceMidwordMs:     2000,
  maxTokens:             40,
  temperature:           0.4,
  minChars:              3,
  // How many characters of the previous turn (assistant or user) to send
  // as conversational context with each suggestion request. 0 disables.
  historyChars:          400,
  // 'chat' → /chat/completions with instruct prompt (works with any model).
  // 'fim'  → /completions with FIM token wrapping (starcoder2/codestral format).
  //           Requires a base/code model that has a /completions endpoint.
  completionMode: 'chat',
};

function _readCfg(): typeof DEFAULTS {
  const { config } = require('../../core/state');
  const cur = (config.defaults && config.defaults.inputAutocomplete) || {};
  return { ...DEFAULTS, ...cur };
}

async function _writeCfg(patch: Partial<typeof DEFAULTS>): Promise<typeof DEFAULTS> {
  const { config, saveConfig } = require('../../core/state');
  config.defaults = config.defaults || {};
  config.defaults.inputAutocomplete = { ..._readCfg(), ...patch };
  await saveConfig();
  return config.defaults.inputAutocomplete;
}

function registerRoutes(app: any): void {
  app.get('/v1/input-autocomplete/config', (_req: any, res: any) => {
    res.json({ config: _readCfg() });
  });

  app.patch('/v1/input-autocomplete/config', async (req: any, res: any) => {
    const body = req.body || {};
    const patch: Partial<typeof DEFAULTS> = {};
    if (typeof body.enabled === 'boolean')              patch.enabled = body.enabled;
    if (typeof body.model === 'string' && body.model)   patch.model = body.model;
    if (typeof body.provider === 'string' && body.provider) patch.provider = body.provider;
    if (Number.isFinite(body.debounceBoundaryMs))       patch.debounceBoundaryMs = Math.max(60,  Math.min(10_000, Number(body.debounceBoundaryMs)));
    if (Number.isFinite(body.debounceMidwordMs))        patch.debounceMidwordMs  = Math.max(60,  Math.min(10_000, Number(body.debounceMidwordMs)));
    if (Number.isFinite(body.maxTokens))                patch.maxTokens  = Math.max(8,  Math.min(200,  Number(body.maxTokens)));
    if (Number.isFinite(body.temperature))              patch.temperature = Math.max(0, Math.min(2,    Number(body.temperature)));
    if (Number.isFinite(body.minChars))                 patch.minChars   = Math.max(1,  Math.min(40,   Number(body.minChars)));
    if (Number.isFinite(body.historyChars))             patch.historyChars = Math.max(0, Math.min(4000, Number(body.historyChars)));
    if (body.completionMode === 'chat' || body.completionMode === 'fim') patch.completionMode = body.completionMode;
    const next = await _writeCfg(patch);
    res.json({ config: next });
  });

  app.post('/v1/input-autocomplete/suggest', async (req: any, res: any) => {
    const cfg = _readCfg();
    if (!cfg.enabled) {
      return res.status(409).json({ error: 'input-autocomplete-disabled' });
    }
    const text = typeof req.body?.text === 'string' ? req.body.text : '';
    if (!text || text.length < cfg.minChars) {
      return res.json({ suggestion: '' });
    }
    if (text.length > 8_000) {
      return res.status(413).json({ error: 'text-too-long' });
    }

    const { config } = require('../../core/state');
    const provider = (config.providers || []).find((p: any) => p.name === cfg.provider);
    if (!provider || !provider.api_key) {
      return res.status(503).json({ error: 'provider-unavailable', provider: cfg.provider });
    }

    // historyTail is FE-sliced (the FE owns the chat store). We cap it
    // server-side as a defence against runaway payloads.
    const rawTail = typeof req.body?.historyTail === 'string' ? req.body.historyTail : '';
    const historyTail = cfg.historyChars > 0 ? rawTail.slice(-cfg.historyChars) : '';

    const suggestion = await _complete(text, cfg.model, provider, {
      maxTokens:              cfg.maxTokens,
      temperature:            cfg.temperature,
      historyTail,
      useCompletionsEndpoint: cfg.completionMode === 'fim',
    });
    res.json({ suggestion: suggestion || '' });
  });
}

module.exports = { registerRoutes, DEFAULTS };
