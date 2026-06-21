// ── Config-core routes ──────────────────────────────────────────────────────
// Extracted from handler.ts (registerConfigRoutes) — see ./handler.ts.
// Covers GET /v1/config/, dynamic provider CRUD, per-provider fetch-models, the
// big PATCH /v1/config/ (key/endpoint/defaults), the auto-title / categorizer /
// file-categorizer / sorter worker controls, rate-limit + context telemetry.
//
// `context-generator` and `mcp-client` are looked up on demand via the
// module-api helper so disabling either in modules.json degrades cleanly:
// context-generator admin endpoints return 501 and MCP cache invalidations
// turn into no-ops.
'use strict';

const fs = require('fs');
const path = require('path');

const {
  config,
  CLAUDE_BIN,
  CODEX_BIN,
  GROK_BIN,
  writeEnvKey,
  saveConfig,
  getSystemPromptsMap,
} = require('../core/state');
const { getModuleApi } = require('../core/modules');
const { PLATFORM } = require('../core/platform');
const { listSkills } = require('./skills-helpers');
const { getHome } = require('./paths');
const { loadAgentsJson } = require('../providers');
const { invalidateModelCache } = require('../models');

function _mcp() { return getModuleApi('mcp-client'); }

const HARDCODED_NLM_DEFAULT = '/home/user/notebooklm-py/venv/bin/notebooklm';

function registerConfigCoreRoutes(app) {
  const DEFAULT_OVERWRITE_TOOLS = [
    'Write',
    'Read',
    'Edit',
    'Bash',
    'Task',
    'Glob',
    'Grep',
    'MultiEdit',
    'WebFetch',
  ];

  // ── GET /v1/config/ — return config with masked API keys ────────────────────
  app.get('/v1/config/', async (req, res) => {
    const providers = config.providers.map((p) => ({
      name: p.name,
      endpoint: p.endpoint || '',
      api_style: p.api_style || 'openai',
      env_key: p.env_key || '',
      fetch_live: !!p.fetch_live,
      preset_id: p.preset_id || '',
      hidden: !!p.hidden,
      has_key: !!p.api_key,
      key_hint: p.api_key ? p.api_key.slice(0, 8) + '…' + p.api_key.slice(-4) : '',
      models: p.models ? Object.keys(p.models) : [],
    }));
    const skills = await listSkills();
    const homeDir = getHome();
    // Prefer config.defaults.claudeBin over the boot-time CLAUDE_BIN
    // autodetect. Defaults wins because:
    //   - it's user-editable from the prefs UI (the "general binary" input
    //     writes here),
    //   - it gets rewritten by /v1/harness/refresh + boot-time auto-fix
    //     when the previous version's path stops existing (Claude Code
    //     auto-update case).
    // CLAUDE_BIN is the boot-time fallback for users who haven't set
    // defaults.claudeBin yet — on Windows that's now also auto-detected
    // by findClaudeBin() under %APPDATA%\Claude\claude-code\.
    const effectiveClaudeBin = (config.defaults && config.defaults.claudeBin) || CLAUDE_BIN;
    // Same fallback chain as claudeBin: user-set defaults wins, boot-time
    // autodetect is the fallback. Without these top-level entries the
    // frontend's "Fetch from server" button reads undefined for codex/grok
    // and shows an empty path even when the binary IS installed.
    const effectiveCodexBin = (config.defaults && config.defaults.codexBin) || CODEX_BIN;
    const effectiveGrokBin = (config.defaults && config.defaults.grokBin) || GROK_BIN;
    const presetsMap = getSystemPromptsMap();
    res.json({
      success: true,
      config: {
        claudeBin: effectiveClaudeBin,
        codexBin: effectiveCodexBin,
        grokBin: effectiveGrokBin,
        // Surface the bridge SERVER's OS so the FE can pick shell syntax
        // (bash vs PowerShell) when generating copy-pasteable auth
        // commands. PLATFORM values: 'linux' | 'darwin' | 'win32' | …
        serverPlatform: PLATFORM,
        defaults: config.defaults,
        homeDir,
        providers,
        presetsMap,
        agents: loadAgentsJson(),
        presets: Object.keys(presetsMap),
        toolSets: config.toolSets || {},
        skillSets: config.skillSets || {},
        skillSetsActiveInChat: Array.isArray(config.skillSetsActiveInChat) ? config.skillSetsActiveInChat : [],
        skillNames: skills.map((s) => s.name),
        claudeInstances: config.defaults?.claudeInstances || [],
        codexInstances: config.defaults?.codexInstances || [],
        grokInstances: config.defaults?.grokInstances || [],
      },
    });
  });

  // ── Dynamic provider CRUD ───────────────────────────────────────────────────
  // GET    /v1/config/provider-presets        — read-only preset list
  // POST   /v1/config/providers               — add provider (from preset or custom)
  // PATCH  /v1/config/providers/:name         — edit existing provider
  // DELETE /v1/config/providers/:name[?force] — soft-hide (default) or remove
  //
  // These coexist with the legacy `PATCH /v1/config/ { provider, api_key }`
  // path used by the simple key+endpoint editor. New UI prefers the CRUD
  // routes; the legacy path is kept so older callers don't break.
  const VALID_API_STYLES = new Set(['anthropic', 'openai', 'google']);

  function _autoEnvKeyFor(name: string): string {
    const slug = String(name)
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '');
    return slug ? `PROVIDER_${slug}_KEY` : '';
  }

  function _findProviderByName(name: string) {
    const lower = String(name).toLowerCase();
    return config.providers.find((p) => String(p.name).toLowerCase() === lower);
  }

  app.get('/v1/config/provider-presets', (_req, res) => {
    try {
      const { PROVIDER_PRESETS } = require('./provider-presets');
      const activeNames = new Set(
        (config.providers || []).map((p) => String(p.name).toLowerCase())
      );
      const activePresetIds = new Set(
        (config.providers || []).map((p) => p.preset_id).filter(Boolean)
      );
      const presets = PROVIDER_PRESETS.map((p) => ({
        ...p,
        active: activePresetIds.has(p.id) || activeNames.has(p.default_name.toLowerCase()),
      }));
      res.json({ success: true, presets });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e?.message || String(e) });
    }
  });

  app.post('/v1/config/providers', async (req, res) => {
    const body = (req.body || {}) as {
      preset_id?: string;
      name?: string;
      endpoint?: string;
      api_key?: string;
      api_style?: string;
      env_key?: string;
      fetch_live?: boolean;
    };
    const { findPreset } = require('./provider-presets');

    const preset = body.preset_id ? findPreset(body.preset_id) : undefined;
    if (body.preset_id && !preset) {
      return res.status(400).json({ success: false, error: `unknown preset_id: ${body.preset_id}` });
    }
    const name = String(body.name || preset?.default_name || '').trim();
    if (!name) return res.status(400).json({ success: false, error: 'name required' });
    if (_findProviderByName(name)) {
      return res.status(409).json({ success: false, error: `provider "${name}" already exists` });
    }

    const endpoint = String(body.endpoint ?? preset?.endpoint ?? '').trim();
    if (!/^https?:\/\//i.test(endpoint)) {
      return res.status(400).json({ success: false, error: 'endpoint must be http(s):// URL' });
    }

    const api_style = String(body.api_style || preset?.api_style || 'openai');
    if (!VALID_API_STYLES.has(api_style)) {
      return res.status(400).json({ success: false, error: 'api_style must be anthropic | openai | google' });
    }

    // env_key: explicit > preset > auto-generated from name (only if a key is
    // being saved or if a preset declared one). An empty env_key means "no
    // auth" — used by local/no-key servers like Ollama.
    let env_key = body.env_key !== undefined ? String(body.env_key).trim() : (preset?.env_key ?? '');
    const wantsKey = typeof body.api_key === 'string' && body.api_key.length > 0;
    if (!env_key && wantsKey) env_key = _autoEnvKeyFor(name);

    const fetch_live = body.fetch_live !== undefined ? !!body.fetch_live : !!preset?.fetch_live;

    const entry: any = {
      name,
      endpoint,
      api_style,
      env_key,
      fetch_live,
    };
    if (preset) entry.preset_id = preset.id;

    config.providers.push(entry);

    if (wantsKey) {
      const apiKey = String(body.api_key);
      entry.api_key = apiKey;
      if (env_key) writeEnvKey(env_key, apiKey);
    }

    try {
      await saveConfig();
      invalidateModelCache();
      res.json({
        success: true,
        provider: {
          name: entry.name,
          endpoint: entry.endpoint,
          api_style: entry.api_style,
          env_key: entry.env_key,
          fetch_live: entry.fetch_live,
          preset_id: entry.preset_id || '',
          has_key: !!entry.api_key,
        },
      });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e?.message || String(e) });
    }
  });

  app.patch('/v1/config/providers/:name', async (req, res) => {
    const target = _findProviderByName(req.params.name);
    if (!target) return res.status(404).json({ success: false, error: 'provider not found' });

    const body = (req.body || {}) as {
      name?: string;
      endpoint?: string;
      api_key?: string;
      api_style?: string;
      env_key?: string;
      fetch_live?: boolean;
      hidden?: boolean;
    };

    // Rename — must be unique. Also rewrite defaults references so feature
    // gates (autoTitle / categorizer / image_provider / …) keep working.
    if (body.name !== undefined) {
      const newName = String(body.name).trim();
      if (!newName) return res.status(400).json({ success: false, error: 'name cannot be empty' });
      if (newName !== target.name) {
        const collision = config.providers.find(
          (p) => p !== target && String(p.name).toLowerCase() === newName.toLowerCase()
        );
        if (collision) return res.status(409).json({ success: false, error: `provider "${newName}" already exists` });
        const oldName = target.name;
        target.name = newName;
        const d = config.defaults || {};
        const refs = [
          ['autoTitle', 'provider'],
          ['contextCategorizer', 'provider'],
          ['contextSorter', 'provider'],
          ['fileCategorizer', 'provider'],
          ['inputAutocomplete', 'provider'],
        ];
        for (const [section, field] of refs) {
          if (d[section] && d[section][field] === oldName) d[section][field] = newName;
        }
        for (const flat of ['image_provider', 'audio_provider', 'video_provider', 'llm_provider']) {
          if (d[flat] === oldName) d[flat] = newName;
        }
      }
    }

    if (body.endpoint !== undefined) {
      const ep = String(body.endpoint).trim();
      if (ep && !/^https?:\/\//i.test(ep)) {
        return res.status(400).json({ success: false, error: 'endpoint must be http(s):// URL' });
      }
      target.endpoint = ep;
    }

    if (body.api_style !== undefined) {
      const s = String(body.api_style);
      if (!VALID_API_STYLES.has(s)) {
        return res.status(400).json({ success: false, error: 'api_style must be anthropic | openai | google' });
      }
      target.api_style = s;
    }

    if (body.env_key !== undefined) target.env_key = String(body.env_key).trim();
    if (body.fetch_live !== undefined) target.fetch_live = !!body.fetch_live;
    if (body.hidden !== undefined) target.hidden = !!body.hidden;

    if (typeof body.api_key === 'string' && body.api_key && !body.api_key.startsWith('••')) {
      target.api_key = body.api_key;
      if (!target.env_key) target.env_key = _autoEnvKeyFor(target.name);
      if (target.env_key) writeEnvKey(target.env_key, body.api_key);
    }

    try {
      await saveConfig();
      invalidateModelCache();
      res.json({
        success: true,
        provider: {
          name: target.name,
          endpoint: target.endpoint || '',
          api_style: target.api_style || 'openai',
          env_key: target.env_key || '',
          fetch_live: !!target.fetch_live,
          preset_id: target.preset_id || '',
          hidden: !!target.hidden,
          has_key: !!target.api_key,
        },
      });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e?.message || String(e) });
    }
  });

  app.delete('/v1/config/providers/:name', async (req, res) => {
    const target = _findProviderByName(req.params.name);
    if (!target) return res.status(404).json({ success: false, error: 'provider not found' });
    const force = String(req.query.force || '') === '1';

    if (force) {
      const idx = config.providers.indexOf(target);
      if (idx >= 0) config.providers.splice(idx, 1);
    } else {
      target.hidden = true;
    }

    try {
      await saveConfig();
      invalidateModelCache();
      res.json({ success: true, removed: force, hidden: !force });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e?.message || String(e) });
    }
  });

  // POST /v1/config/providers/:name/fetch-models — trigger on-demand model fetch
  app.post('/v1/config/providers/:name/fetch-models', async (req, res) => {
    const target = _findProviderByName(req.params.name);
    if (!target) return res.status(404).json({ success: false, error: 'provider not found' });
    if (!target.fetch_live) return res.status(400).json({ success: false, error: 'fetch_live not enabled' });

    try {
      const {
        fetchAnthropicModels, fetchOpenAIModels, fetchOpenAIImageModels, fetchGoogleModels,
        fetchGrokModels, fetchOpenRouterModels, fetchNVIDIAModels, fetchDeepSeekModels,
        fetchModelsGeneric,
      } = require('../models/fetch');
      const { modelCaches } = require('../core/state');

      const BUILT_IN: Record<string, [() => Promise<void>, string]> = {
        'Anthropic':   [fetchAnthropicModels,   'anthropic'],
        'OpenAI':      [fetchOpenAIModels,       'openai'],
        'OpenAI-Image':[fetchOpenAIImageModels,  'openaiImage'],
        'Google':      [fetchGoogleModels,       'google'],
        'Grok':        [fetchGrokModels,         'grok'],
        'OpenRouter':  [fetchOpenRouterModels,   'openrouter'],
        'NVIDIA':      [fetchNVIDIAModels,        'nvidia'],
        'DeepSeek':    [fetchDeepSeekModels,     'deepseek'],
      };

      let count = 0;
      const entry = BUILT_IN[target.name];
      if (entry) {
        const [fetcher, cacheKey] = entry;
        await fetcher();
        const cache = modelCaches[cacheKey];
        count = Array.isArray(cache) ? cache.length : 0;
      } else {
        const models = await fetchModelsGeneric(target);
        if (models) {
          modelCaches.byProvider[target.name] = models;
          modelCaches.list = null;
          count = models.length;
        }
      }

      invalidateModelCache();
      res.json({ success: true, count });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e?.message || String(e) });
    }
  });

  // ── PATCH /v1/config/ — update provider key / endpoint / defaults ───────────
  app.patch('/v1/config/', async (req, res) => {
    const { provider, api_key, endpoint, defaults } = req.body;
    if (provider) {
      const p = config.providers.find((p) => p.name === provider);
      if (p) {
        if (api_key && !api_key.startsWith('••') && api_key.length > 4) {
          p.api_key = api_key;
          if (p.env_key) writeEnvKey(p.env_key, api_key);
        }
        if (endpoint !== undefined) p.endpoint = endpoint;
      }
    }
    let chatHistoryPolicyChanged = false;
    if (defaults && typeof defaults === 'object') {
      config.defaults = config.defaults || {};
      if (defaults.useAgents !== undefined) config.defaults.useAgents = !!defaults.useAgents;
      if (defaults.tool_command_overwrite_enabled !== undefined) {
        config.defaults.tool_command_overwrite_enabled = !!defaults.tool_command_overwrite_enabled;
      }
      const numFields = [
        'agent_max_iter',
        'tool_max_iter',
        'tool_result_limit',
        'tool_preview_limit',
        'chat_history_max_turns',
        'chat_history_max_chars',
        'partnerForwardLimit',
      ];
      for (const f of numFields) {
        if (defaults[f] !== undefined) {
          const v = parseInt(defaults[f], 10);
          if (!isNaN(v) && v > 0) {
            if ((f === 'chat_history_max_turns' || f === 'chat_history_max_chars') && config.defaults[f] !== v) {
              chatHistoryPolicyChanged = true;
            }
            config.defaults[f] = v;
          }
        }
      }
      if (defaults.chat_history_mode !== undefined) {
        const mode = String(defaults.chat_history_mode);
        if (['turns', 'turns_chars', 'split_80_20'].includes(mode)) {
          if (config.defaults.chat_history_mode !== mode) chatHistoryPolicyChanged = true;
          config.defaults.chat_history_mode = mode;
        }
      }
      if (defaults.notebooklm_bin !== undefined) {
        config.defaults.notebooklm_bin =
          String(defaults.notebooklm_bin).trim() || HARDCODED_NLM_DEFAULT;
      }
      if (defaults.playwright_real_url !== undefined) {
        const raw = String(defaults.playwright_real_url || '').trim();
        if (!raw) {
          delete config.defaults.playwright_real_url;
        } else if (/^https?:\/\/[^\s]+$/i.test(raw)) {
          config.defaults.playwright_real_url = raw;
        } else {
          return res.status(400).json({ success: false, error: 'playwright_real_url must be http(s)://host:port' });
        }
      }
      if (defaults.playwright_default_mode !== undefined) {
        const m = String(defaults.playwright_default_mode || '').trim();
        if (!m) {
          delete config.defaults.playwright_default_mode;
        } else if (['auto', 'normal', 'stealth', 'real'].includes(m)) {
          config.defaults.playwright_default_mode = m;
        } else {
          return res.status(400).json({ success: false, error: 'playwright_default_mode must be auto | normal | stealth | real' });
        }
      }
      if (defaults.codexBin !== undefined) {
        config.defaults.codexBin =
          String(defaults.codexBin).trim() || CODEX_BIN || 'codex';
      }
      if (defaults.codexExecMode !== undefined) {
        const mode = String(defaults.codexExecMode);
        config.defaults.codexExecMode = ['bypass', 'full-auto'].includes(mode) ? mode : 'bypass';
      }
      if (defaults.anthropicApiMode !== undefined) {
        config.defaults.anthropicApiMode =
          defaults.anthropicApiMode === 'binary' ? 'binary' : 'api';
      }
      if (defaults.claudeRuntime !== undefined) {
        config.defaults.claudeRuntime =
          defaults.claudeRuntime === 'sdk' ? 'sdk' : 'binary';
      }
      if (defaults.workingDir !== undefined) {
        if (!defaults.workingDir) {
          delete config.defaults.workingDir;
        } else {
          const abs = path.resolve(String(defaults.workingDir));
          try {
            if (!(await fs.promises.stat(abs)).isDirectory())
              return res.status(400).json({ success: false, error: 'Not a directory' });
            config.defaults.workingDir = abs;
          } catch (e) {
            return res.status(400).json({ success: false, error: e.message });
          }
        }
      }
      // Q16 / A.1: `workingDirs` is a list of additional folders surfaced
      // alongside the standard `workingDir` (FilePicker scope dropdown,
      // "+ add folder" in prefs). Each entry must be an existing absolute
      // directory; empty array clears the list.
      if (defaults.workingDirs !== undefined) {
        const raw = Array.isArray(defaults.workingDirs) ? defaults.workingDirs : [];
        const resolved: string[] = [];
        const seen = new Set<string>();
        for (const entry of raw) {
          const s = String(entry || '').trim();
          if (!s) continue;
          const abs = path.resolve(s);
          if (seen.has(abs)) continue;
          try {
            if (!(await fs.promises.stat(abs)).isDirectory())
              return res.status(400).json({ success: false, error: `Not a directory: ${abs}` });
          } catch (e) {
            return res.status(400).json({ success: false, error: e.message });
          }
          resolved.push(abs);
          seen.add(abs);
        }
        if (resolved.length) config.defaults.workingDirs = resolved;
        else delete config.defaults.workingDirs;
      }
      if (defaults.tool_command_overwrite_tools !== undefined) {
        const arr = Array.isArray(defaults.tool_command_overwrite_tools)
          ? defaults.tool_command_overwrite_tools
          : [];
        const cleaned = [...new Set(arr.map((v) => String(v || '').trim()).filter(Boolean))];
        config.defaults.tool_command_overwrite_tools = cleaned.length
          ? cleaned
          : [...DEFAULT_OVERWRITE_TOOLS];
      }
      if (defaults.enabledHarnessTypes !== undefined) {
        const arr = Array.isArray(defaults.enabledHarnessTypes)
          ? defaults.enabledHarnessTypes
          : [];
        const cleaned = [...new Set(arr.map((v) => String(v || '').trim()).filter(Boolean))];
        config.defaults.enabledHarnessTypes = cleaned;
      }
      if (defaults.autoTitle !== undefined) {
        const at = defaults.autoTitle as Record<string, unknown>;
        config.defaults.autoTitle = config.defaults.autoTitle || {};
        if (at.enabled !== undefined) config.defaults.autoTitle.enabled = !!at.enabled;
        if (typeof at.model === 'string' && at.model.trim())
          config.defaults.autoTitle.model = at.model.trim();
        if (typeof at.provider === 'string' && at.provider.trim())
          config.defaults.autoTitle.provider = at.provider.trim();
      }
      // Per-stage enable/disable toggles (Phase 1.7 — user request 2026-05-06).
      // The categorizer's runtime gate falls back to autoTitle.enabled when its
      // own config is undefined; once a user explicitly sets the flag here it
      // becomes authoritative. Same for the sorter.
      if (defaults.contextCategorizer !== undefined) {
        const cc = defaults.contextCategorizer as Record<string, unknown>;
        config.defaults.contextCategorizer = config.defaults.contextCategorizer || {};
        if (cc.enabled !== undefined) config.defaults.contextCategorizer.enabled = !!cc.enabled;
        if (typeof cc.model === 'string' && cc.model.trim())
          config.defaults.contextCategorizer.model = cc.model.trim();
        if (typeof cc.provider === 'string' && cc.provider.trim())
          config.defaults.contextCategorizer.provider = cc.provider.trim();
      }
      if (defaults.contextSorter !== undefined) {
        const cs = defaults.contextSorter as Record<string, unknown>;
        config.defaults.contextSorter = config.defaults.contextSorter || {};
        if (cs.enabled !== undefined) config.defaults.contextSorter.enabled = !!cs.enabled;
      }
      // Phase 4.1 — file-categorizer (keep-notes) toggle. Falls back to
      // contextCategorizer / autoTitle when undefined; explicit settings
      // here become authoritative.
      if (defaults.fileCategorizer !== undefined) {
        const fc = defaults.fileCategorizer as Record<string, unknown>;
        config.defaults.fileCategorizer = config.defaults.fileCategorizer || {};
        if (fc.enabled !== undefined) config.defaults.fileCategorizer.enabled = !!fc.enabled;
        if (typeof fc.model === 'string' && fc.model.trim())
          config.defaults.fileCategorizer.model = fc.model.trim();
        if (typeof fc.provider === 'string' && fc.provider.trim())
          config.defaults.fileCategorizer.provider = fc.provider.trim();
      }
      // ── LINK / contextLink (Phase 3.4c — editable from UI) ─────────────────
      // Keeps audit-trail symmetry with categorizer/sorter — every change
      // goes through saveConfig() and lands in config-history. The watchdog
      // re-reads `config.defaults.contextLink` on each tick, so adapter /
      // host / vaultRoot changes apply at the next sync. `syncIntervalMs`
      // still requires a bridge restart (the timer is set once in
      // startLinkWorker).
      if (defaults.contextLink !== undefined && typeof defaults.contextLink === 'object' && defaults.contextLink) {
        const cl = defaults.contextLink as Record<string, unknown>;
        config.defaults.contextLink = config.defaults.contextLink || {};
        if (cl.enabled !== undefined) config.defaults.contextLink.enabled = !!cl.enabled;
        if (cl.adapter !== undefined) {
          const a = String(cl.adapter || '').trim();
          if (['mock', 'obsidian-rest'].includes(a)) {
            config.defaults.contextLink.adapter = a;
          } else if (a === '') {
            delete config.defaults.contextLink.adapter;
          } else {
            return res.status(400).json({ success: false, error: 'contextLink.adapter must be one of: mock, obsidian-rest' });
          }
        }
        if (cl.obsidianHost !== undefined) {
          const h = String(cl.obsidianHost || '').trim();
          if (h === '') {
            delete config.defaults.contextLink.obsidianHost;
          } else if (/^https?:\/\/[^\s/]+(:\d+)?$/.test(h)) {
            config.defaults.contextLink.obsidianHost = h.replace(/\/+$/, '');
          } else {
            return res.status(400).json({ success: false, error: 'contextLink.obsidianHost must be http(s)://host[:port]' });
          }
        }
        if (cl.vaultRoot !== undefined) {
          const v = String(cl.vaultRoot || '').trim().replace(/^\/+|\/+$/g, '');
          // Validate: no `..` traversal, no whitespace, no shell-meta. Empty
          // means "vault root = the vault itself" which is the common case.
          if (v === '') {
            delete config.defaults.contextLink.vaultRoot;
          } else if (!/^[A-Za-z0-9._\-/]+$/.test(v) || v.split('/').some(seg => seg === '..' || seg === '')) {
            return res.status(400).json({ success: false, error: 'contextLink.vaultRoot may only contain [A-Za-z0-9._-/], no `..`' });
          } else {
            config.defaults.contextLink.vaultRoot = v;
          }
        }
        if (cl.syncIntervalMs !== undefined) {
          const n = parseInt(String(cl.syncIntervalMs), 10);
          if (Number.isFinite(n) && n >= 30_000 && n <= 24 * 60 * 60_000) {
            config.defaults.contextLink.syncIntervalMs = n;
          } else {
            return res.status(400).json({ success: false, error: 'contextLink.syncIntervalMs must be between 30000 (30 s) and 86400000 (24 h)' });
          }
        }
        if (cl.syncSensitivity !== undefined && typeof cl.syncSensitivity === 'object' && cl.syncSensitivity) {
          const ss = cl.syncSensitivity as Record<string, unknown>;
          config.defaults.contextLink.syncSensitivity = config.defaults.contextLink.syncSensitivity || {};
          // public is always true (filter has no opt-out for public — it's a
          // tier *included* by default). private is the opt-in toggle.
          // system is hard-coded false in the engine; ignored here.
          if (ss.private !== undefined) config.defaults.contextLink.syncSensitivity.private = !!ss.private;
        }
      }
      // ── Rate limiter (Phase 1.10) ──────────────────────────────────────────
      // `defaults.rateLimit.<providerName>.{rpm,concurrency}` overrides the
      // per-provider bucket caps. `defaults.rateLimit.default` is the
      // catch-all when a provider has no explicit override. Validation is
      // permissive — invalid values fall back to the existing bucket cfg
      // (the limiter re-reads on every refill, see _readCfg there).
      if (defaults.rateLimit !== undefined && typeof defaults.rateLimit === 'object' && defaults.rateLimit) {
        const rl = defaults.rateLimit as Record<string, unknown>;
        config.defaults.rateLimit = (config.defaults.rateLimit || {}) as Record<string, { rpm?: number; concurrency?: number }>;
        for (const [provider, val] of Object.entries(rl)) {
          if (!val || typeof val !== 'object') continue;
          const v = val as Record<string, unknown>;
          const target = (config.defaults.rateLimit[provider] = config.defaults.rateLimit[provider] || {});
          if (typeof v.rpm === 'number' && v.rpm > 0 && v.rpm <= 10000) target.rpm = Math.floor(v.rpm);
          if (typeof v.concurrency === 'number' && v.concurrency > 0 && v.concurrency <= 100) target.concurrency = Math.floor(v.concurrency);
        }
      }
    }
    try {
      await saveConfig();
      invalidateModelCache();
      // Soft-fail: when mcp-client is disabled, the tool-groups cache it
      // owns doesn't exist, so there's nothing to invalidate.
      const mcpInv = _mcp();
      if (mcpInv) mcpInv.invalidateToolGroupsCache();
      if (chatHistoryPolicyChanged) {
        // Re-prune cached per-session histories so the new max_turns/max_chars
        // policy takes effect on the next prompt instead of waiting for a
        // pushHistory (which only happens on the next user/assistant turn).
        try {
          const { rebuildChatHistoryFromDisplay } = require('../sessions-internal/history');
          rebuildChatHistoryFromDisplay();
        } catch (_) {}
      }
      res.json({ success: true, defaults: config.defaults });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── GET /v1/config/auto-title/status — live worker state ────────────────────
  app.get('/v1/config/auto-title/status', (_req, res) => {
    try {
      const cg = getModuleApi('context-generator');
      if (!cg) return res.status(501).json({ ok: false, error: 'context-generator module is disabled' });
      const status = cg.autoTitle.getAutoTitleStatus();
      res.json({ success: true, ...status });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── POST /v1/config/auto-title/run-now ──────────────────────────────────────
  // Manual escape hatch — short-circuits the 3-min watchdog. Useful when a
  // user just configured the provider and doesn't want to wait. Returns
  // `{ success, kicked, reason? }` — `kicked: false` is informational, not an
  // error (e.g. `nothing-to-do` simply means the queue is empty).
  app.post('/v1/config/auto-title/run-now', (_req, res) => {
    try {
      const cg = getModuleApi('context-generator');
      if (!cg) return res.status(501).json({ ok: false, error: 'context-generator module is disabled' });
      res.json({ success: true, ...cg.autoTitle.runNow() });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── POST /v1/config/auto-title/force-retry ──────────────────────────────────
  // Resets the `_nameSource = 'fallback'` marker on every previously-abandoned
  // session and kicks the worker. Use case: the cheap-model provider was
  // misconfigured for a while, the sessions all hit MAX_TITLE_ATTEMPTS, the
  // user has now fixed the config and wants to retry. Returns `{ success,
  // reset, kicked }`. `reset` = number of sessions un-fallback'd.
  app.post('/v1/config/auto-title/force-retry', (_req, res) => {
    try {
      const cg = getModuleApi('context-generator');
      if (!cg) return res.status(501).json({ ok: false, error: 'context-generator module is disabled' });
      res.json({ success: true, ...cg.autoTitle.forceRetryAbandoned() });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── POST /v1/config/auto-title/skip-stuck ────────────────────────────────────
  // Manually marks every currently-pending (and optionally specified) session
  // as `_nameSource = 'fallback'` with a synthesized name from the first user
  // message. Use case: a session keeps failing in ways the junk-detector can't
  // recognise (rare model bug, weird content). Body (optional):
  //   { sids?: string[] }  — when provided, only these sessions are skipped.
  // Returns `{ success, skipped, details: [{sid, name}] }`.
  app.post('/v1/config/auto-title/skip-stuck', (req, res) => {
    try {
      const cg = getModuleApi('context-generator');
      if (!cg) return res.status(501).json({ ok: false, error: 'context-generator module is disabled' });
      const body = (req.body || {}) as { sids?: unknown };
      let sids: string[] | undefined;
      if (Array.isArray(body.sids)) {
        sids = body.sids.filter((x): x is string => typeof x === 'string' && x.length > 0);
      }
      res.json({ success: true, ...cg.autoTitle.skipStuck(sids) });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── GET /v1/config/auto-title/debug ──────────────────────────────────────────
  // Returns up to 50 most-stuck sessions (abandoned first, then highest-attempts)
  // with the info the user needs to decide what to do: name, attempts, skip
  // reason, message count, user/assistant previews. Drives the "Inspect" panel
  // in the Generator tab.
  app.get('/v1/config/auto-title/debug', (_req, res) => {
    try {
      const cg = getModuleApi('context-generator');
      if (!cg) return res.status(501).json({ ok: false, error: 'context-generator module is disabled' });
      res.json({ success: true, ...cg.autoTitle.getDebugInfo() });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── POST /v1/config/categorizer/run-now ─────────────────────────────────────
  app.post('/v1/config/categorizer/run-now', (_req, res) => {
    try {
      const cg = getModuleApi('context-generator');
      if (!cg) return res.status(501).json({ ok: false, error: 'context-generator module is disabled' });
      res.json({ success: true, ...cg.categorizer.runNow() });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── POST /v1/config/categorizer/force-rebuild ───────────────────────────────
  // Clears `category` + `tags` + `categorizedAt` on every session and
  // immediately kicks the worker (gated on the title worker being clear).
  // Destructive — use after a category-list edit or to recover from a bad
  // model run. Returns `{ success, reset, kicked }`.
  app.post('/v1/config/categorizer/force-rebuild', (_req, res) => {
    try {
      const cg = getModuleApi('context-generator');
      if (!cg) return res.status(501).json({ ok: false, error: 'context-generator module is disabled' });
      res.json({ success: true, ...cg.categorizer.forceRebuild() });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── POST /v1/config/file-categorizer/run-now ────────────────────────────────
  // Phase 4.1 — kick the keep-notes file classifier. Returns the same shape
  // as the session-categorizer: `{ kicked, reason? }`.
  app.post('/v1/config/file-categorizer/run-now', (_req, res) => {
    try {
      const cg = getModuleApi('context-generator');
      if (!cg) return res.status(501).json({ ok: false, error: 'context-generator module is disabled' });
      res.json({ success: true, ...cg.fileCategorizer.runNow() });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── POST /v1/config/file-categorizer/force-rebuild ──────────────────────────
  // Strip topics/tags/keywords/categorizedAt from every keep-notes file so
  // the worker re-classifies the entire corpus on the next tick. Sensitivity
  // and category lines are preserved (those carry user overrides).
  app.post('/v1/config/file-categorizer/force-rebuild', (_req, res) => {
    try {
      const cg = getModuleApi('context-generator');
      if (!cg) return res.status(501).json({ ok: false, error: 'context-generator module is disabled' });
      res.json({ success: true, ...cg.fileCategorizer.forceRebuild() });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── GET /v1/config/file-categorizer/status ──────────────────────────────────
  app.get('/v1/config/file-categorizer/status', (_req, res) => {
    try {
      const cg = getModuleApi('context-generator');
      if (!cg) return res.status(501).json({ ok: false, error: 'context-generator module is disabled' });
      res.json({ success: true, ...cg.fileCategorizer.getFileCategorizerStatus() });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── POST /v1/config/sorter/run-now ──────────────────────────────────────────
  app.post('/v1/config/sorter/run-now', (_req, res) => {
    try {
      const cg = getModuleApi('context-generator');
      if (!cg) return res.status(501).json({ ok: false, error: 'context-generator module is disabled' });
      res.json({ success: true, ...cg.sorter.runNow() });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── POST /v1/config/sorter/force-rebuild ────────────────────────────────────
  // Wipes every session's `wikiContentHash` + `wikiGenerated` flag so the
  // sorter re-renders every page from scratch. Use after a Markdown template
  // change (e.g. new frontmatter field) or when migrating to a new Obsidian
  // vault layout.
  app.post('/v1/config/sorter/force-rebuild', (_req, res) => {
    try {
      const cg = getModuleApi('context-generator');
      if (!cg) return res.status(501).json({ ok: false, error: 'context-generator module is disabled' });
      res.json({ success: true, ...cg.sorter.forceRebuild() });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── Phase 5 — Stuck-item routes for categorizer / file-categorizer / sorter ─
  // Per user feedback 2026-05-07 ("simple fix that solves that problem … some
  // kind of problem solving interface where I can manually edit the problem
  // … automatic skip-all-stuck for categorizer and the sorter would make
  // sense"): generalises the auto-title /skip-stuck + /debug + /force-retry
  // pattern across all three downstream workers, plus a /manual edit route
  // for the two categorizers (the sorter's output is deterministic so it
  // gets only retry / skip).
  //
  // Shape mirrors the auto-title routes:
  //   POST /skip-stuck  body: { sids?: string[] | paths?: string[] }
  //   GET  /debug       returns: { rows: DebugRow[], pending, abandoned }
  //   POST /force-retry returns: { reset, kicked }
  //   POST /manual      body: { sid|path, category|topics, tags?, keywords? }

  // Categorizer ────────────────────────────────────────────────────────────
  app.post('/v1/config/categorizer/skip-stuck', (req, res) => {
    try {
      const cg = getModuleApi('context-generator');
      if (!cg) return res.status(501).json({ ok: false, error: 'context-generator module is disabled' });
      const body = (req.body || {}) as { sids?: unknown };
      const sids = Array.isArray(body.sids)
        ? body.sids.filter((x): x is string => typeof x === 'string' && x.length > 0)
        : undefined;
      res.json({ success: true, ...cg.categorizer.skipStuck(sids) });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/v1/config/categorizer/debug', (_req, res) => {
    try {
      const cg = getModuleApi('context-generator');
      if (!cg) return res.status(501).json({ ok: false, error: 'context-generator module is disabled' });
      res.json({ success: true, ...cg.categorizer.getDebugInfo() });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/v1/config/categorizer/force-retry', (_req, res) => {
    try {
      const cg = getModuleApi('context-generator');
      if (!cg) return res.status(501).json({ ok: false, error: 'context-generator module is disabled' });
      res.json({ success: true, ...cg.categorizer.forceRetryAbandoned() });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/v1/config/categorizer/manual', (req, res) => {
    try {
      const cg = getModuleApi('context-generator');
      if (!cg) return res.status(501).json({ ok: false, error: 'context-generator module is disabled' });
      const body = (req.body || {}) as {
        sid?:      unknown;
        category?: unknown;
        tags?:     unknown;
        keywords?: unknown;
      };
      const sid = typeof body.sid === 'string' ? body.sid : '';
      const category = typeof body.category === 'string' ? body.category : '';
      if (!sid)      return res.status(400).json({ success: false, error: 'sid required' });
      if (!category) return res.status(400).json({ success: false, error: 'category required' });
      const tags     = Array.isArray(body.tags)     ? body.tags     : undefined;
      const keywords = Array.isArray(body.keywords) ? body.keywords : undefined;
      const out = cg.categorizer.applyManualCategory(sid, { category, tags, keywords });
      if (!out.applied) return res.status(400).json({ success: false, error: out.reason });
      return res.json({ success: true, ...out });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // File-Categorizer ────────────────────────────────────────────────────────
  app.post('/v1/config/file-categorizer/skip-stuck', (req, res) => {
    try {
      const cg = getModuleApi('context-generator');
      if (!cg) return res.status(501).json({ ok: false, error: 'context-generator module is disabled' });
      const body = (req.body || {}) as { paths?: unknown };
      const paths = Array.isArray(body.paths)
        ? body.paths.filter((x): x is string => typeof x === 'string' && x.length > 0)
        : undefined;
      res.json({ success: true, ...cg.fileCategorizer.skipStuck(paths) });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/v1/config/file-categorizer/debug', (_req, res) => {
    try {
      const cg = getModuleApi('context-generator');
      if (!cg) return res.status(501).json({ ok: false, error: 'context-generator module is disabled' });
      res.json({ success: true, ...cg.fileCategorizer.getDebugInfo() });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/v1/config/file-categorizer/force-retry', (_req, res) => {
    try {
      const cg = getModuleApi('context-generator');
      if (!cg) return res.status(501).json({ ok: false, error: 'context-generator module is disabled' });
      res.json({ success: true, ...cg.fileCategorizer.forceRetryAbandoned() });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/v1/config/file-categorizer/manual', (req, res) => {
    try {
      const cg = getModuleApi('context-generator');
      if (!cg) return res.status(501).json({ ok: false, error: 'context-generator module is disabled' });
      const body = (req.body || {}) as {
        path?:     unknown;
        topics?:   unknown;
        tags?:     unknown;
        keywords?: unknown;
      };
      const filePath = typeof body.path === 'string' ? body.path : '';
      if (!filePath) return res.status(400).json({ success: false, error: 'path required' });
      const topics   = Array.isArray(body.topics)   ? body.topics   : undefined;
      const tags     = Array.isArray(body.tags)     ? body.tags     : undefined;
      const keywords = Array.isArray(body.keywords) ? body.keywords : undefined;
      const out = cg.fileCategorizer.applyManualCategory(filePath, { topics, tags, keywords });
      if (!out.applied) return res.status(400).json({ success: false, error: out.reason });
      return res.json({ success: true, ...out });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // Sorter ──────────────────────────────────────────────────────────────────
  app.post('/v1/config/sorter/skip-stuck', (req, res) => {
    try {
      const cg = getModuleApi('context-generator');
      if (!cg) return res.status(501).json({ ok: false, error: 'context-generator module is disabled' });
      const body = (req.body || {}) as { sids?: unknown };
      const sids = Array.isArray(body.sids)
        ? body.sids.filter((x): x is string => typeof x === 'string' && x.length > 0)
        : undefined;
      res.json({ success: true, ...cg.sorter.skipStuck(sids) });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/v1/config/sorter/debug', (_req, res) => {
    try {
      const cg = getModuleApi('context-generator');
      if (!cg) return res.status(501).json({ ok: false, error: 'context-generator module is disabled' });
      res.json({ success: true, ...cg.sorter.getDebugInfo() });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/v1/config/sorter/force-retry', (_req, res) => {
    try {
      const cg = getModuleApi('context-generator');
      if (!cg) return res.status(501).json({ ok: false, error: 'context-generator module is disabled' });
      res.json({ success: true, ...cg.sorter.forceRetryAbandoned() });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── GET /v1/config/rate-limit/status — token-bucket telemetry (Phase 1.10) ─
  // Snapshot of every per-provider rate-limit bucket the bridge has handed
  // out a token from since boot. Used by the System Preferences "Rate limits"
  // diagnostic strip + the ContextHub Settings tab.
  app.get('/v1/config/rate-limit/status', (_req, res) => {
    try {
      const rateLimiter = require('./core/rate-limiter');
      const status = rateLimiter.getStatus();
      // Surface the configured caps too so the UI can tell the user what they
      // can override under `config.defaults.rateLimit.<provider>.{rpm,concurrency}`.
      const cfg = (config.defaults?.rateLimit ?? {}) as Record<string, { rpm?: number; concurrency?: number }>;
      res.json({ success: true, ...status, configured: cfg });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── GET /v1/config/context/status — Categorizer + Sorter worker state ──────
  // Sister-endpoint to /v1/config/auto-title/status. Used by the ContextHub
  // Generator-tab and (later) the Pet-Console health indicator. Returns the
  // categorizer fields at the top level (back-compat) and the sorter snapshot
  // under `sorter:` so the Hub can render the Phase 2 StageCard live.
  app.get('/v1/config/context/status', (_req, res) => {
    try {
      const cg = getModuleApi('context-generator');
      if (!cg) return res.status(501).json({ ok: false, error: 'context-generator module is disabled' });
      const sensitivity              = require('../modules/context-generator/sensitivity');
      const status = cg.categorizer.getCategorizerStatus();
      let sorter: Record<string, unknown> | null = null;
      try {
        sorter = cg.sorter.getSorterStatus();
      } catch (_) { /* sorter not loaded — UI shows disabled */ }
      res.json({
        success:        true,
        ...status,
        whitelistSize:  sensitivity.whitelistSize(),
        whitelistTtlMs: sensitivity.SESSION_TTL_MS,
        bridgeMode:     (config.defaults?.contextBridge?.mode as string) || 'standalone',
        sensitivityPolicy: (config.defaults?.contextBridge?.sensitivityPolicy as string) || 'always-prompt',
        sorter,
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  // ── PATCH /v1/config/context/bridge ─────────────────────────────────────────
  // Body: { mode?: 'standalone' | 'mcp' | 'both',
  //         sensitivityPolicy?: 'always-prompt' | 'session-whitelist' | 'never-prompt-system' }
  // Phase 1b / Adaption 3 (Bridge-Toggle) + Adaption 6 (Sensitivity policy).
  // Stored under config.defaults.contextBridge so it persists across restarts.
  // The actual MCP wiring is consumed by Phase 3 (LINK / Hermes) — this route
  // exists today so the Hub can show + toggle the desired mode without losing
  // it on reload. Keeping the storage forward-compatible: extra keys are
  // preserved on partial updates.
  app.patch('/v1/config/context/bridge', async (req, res) => {
    const body = (req.body || {}) as {
      mode?: string;
      sensitivityPolicy?: string;
    };
    const VALID_MODES   = new Set(['standalone', 'mcp', 'both']);
    const VALID_POLICY  = new Set(['always-prompt', 'session-whitelist', 'never-prompt-system']);
    config.defaults = config.defaults || {};
    config.defaults.contextBridge = config.defaults.contextBridge || {
      mode:               'standalone',
      sensitivityPolicy:  'always-prompt',
    };
    if (typeof body.mode === 'string') {
      if (!VALID_MODES.has(body.mode)) {
        return res.status(400).json({
          success: false,
          error:   'mode must be standalone | mcp | both',
        });
      }
      config.defaults.contextBridge.mode = body.mode;
    }
    if (typeof body.sensitivityPolicy === 'string') {
      if (!VALID_POLICY.has(body.sensitivityPolicy)) {
        return res.status(400).json({
          success: false,
          error:   'sensitivityPolicy must be always-prompt | session-whitelist | never-prompt-system',
        });
      }
      config.defaults.contextBridge.sensitivityPolicy = body.sensitivityPolicy;
    }
    try {
      await saveConfig();
      res.json({
        success:           true,
        mode:              config.defaults.contextBridge.mode,
        sensitivityPolicy: config.defaults.contextBridge.sensitivityPolicy,
      });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });
}

module.exports = { registerConfigCoreRoutes };
