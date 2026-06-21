// ── Search provider config + usage HTTP routes ────────────────────────────────
// Reads/writes bridge/search-config.json (priority/enabled/endpoint/surface)
// and bridge/search-usage.json (per-provider daily/monthly counters).
// API keys themselves are kept out of these JSON files — they're written to
// bridge/.env via the existing writeEnvKey() helper, mirroring the pattern
// used by /v1/config/ for LLM provider keys.
'use strict';

const searchCfg = require('./search-config');
const searchUsage = require('./search-usage');
const { writeEnvKey } = require('../../core/state');
const { getModuleApi } = require('../../core/modules');

// Env-var name per provider (matches each adapter's `envKey` field).
const PROVIDER_ENV_KEYS = {
  tavily:     'TAVILY_API_KEY',
  exa:        'EXA_API_KEY',
  google_cse: 'GOOGLE_CSE_KEY',
  bing:       'BING_API_KEY',
  brave:      'BRAVE_API_KEY',
};

// Provider-specific cap metadata for the UI (kept here so the frontend doesn't
// need to import the JS adapters). Mirrors the `cap` field on each adapter.
const PROVIDER_CAPS = {
  tavily:         { window: 'month', limit: 1000 },
  exa:            { window: 'month', limit: 1000 },
  google_cse:     { window: 'day',   limit: 100  },
  bing:           { window: 'month', limit: 1000 },
  brave:          { window: 'month', limit: 2000 },
  // No external quota — the count shown is informational only. The frontend
  // renders "X this month" without a slash when limit is null.
  playwright_mcp: { window: 'month', limit: null },
  web_mcp:        { window: 'month', limit: null },
};

const PROVIDER_API_KEY_URLS = {
  tavily:     'https://app.tavily.com/home',
  exa:        'https://dashboard.exa.ai/api-keys',
  // Custom Search JSON API needs a plain "API key" credential — NOT OAuth and
  // NOT a service account. Google's wizard funnels new users into the OAuth
  // flow, so we link straight to the Credentials page; the user clicks
  // "+ Create credentials" → "API key" (the popup hands back the key inline).
  // The cx (Search Engine ID) is a separate thing, exposed next to the cx
  // input below. NOTE: Google announced 2027-01-01 deprecation of this API
  // for new customers; existing keys keep working until then.
  google_cse: 'https://console.cloud.google.com/apis/credentials',
  bing:       'https://portal.azure.com/#create/Microsoft.BingSearch',
  // Brave Search API — "Subscriptions" page is where you create/copy the
  // API key (X-Subscription-Token). Free plan: 2 000 / month, 1 q/s.
  brave:      'https://api-dashboard.search.brave.com/app/keys',
};

// Where to manage the Programmable Search Engine and copy its cx id.
const GOOGLE_CSE_CX_URL = 'https://programmablesearchengine.google.com/controlpanel/all';
// One-time step before the API key works: enable the Custom Search JSON API
// for the active Cloud project. Linked next to the provider name.
const GOOGLE_CSE_ENABLE_URL = 'https://console.cloud.google.com/apis/library/customsearch.googleapis.com';

function maskKey(env) {
  const v = process.env[env];
  if (!v) return '';
  if (v.length <= 12) return '••••';
  return v.slice(0, 6) + '…' + v.slice(-4);
}

function buildProviderView(providers, usage) {
  return providers.map((p) => {
    const env = PROVIDER_ENV_KEYS[p.name];
    const cap = PROVIDER_CAPS[p.name] || null;
    const has_key = !!process.env[env];
    const key_hint = has_key ? maskKey(env) : '';
    let used_day = 0;
    let used_month = 0;
    let used_total = 0;
    if (usage.providers[p.name]) {
      used_day   = usage.providers[p.name].daily[searchUsage.todayStr()]      || 0;
      used_month = usage.providers[p.name].monthly[searchUsage.thisMonthStr()] || 0;
      used_total = usage.providers[p.name].total                              || 0;
    }
    const extra: Record<string, unknown> = {};
    if (p.name === 'google_cse') {
      extra.cx_set = !!process.env.GOOGLE_CSE_CX;
      extra.cx_url = GOOGLE_CSE_CX_URL;
      extra.enable_api_url = GOOGLE_CSE_ENABLE_URL;
    }
    return {
      name: p.name,
      enabled: p.enabled !== false,
      priority: p.priority,
      endpoint: p.endpoint,
      cap,
      has_key,
      key_hint,
      api_key_url: PROVIDER_API_KEY_URLS[p.name] || null,
      used_today: used_day,
      used_this_month: used_month,
      used_total,
      ...extra,
    };
  });
}

function registerSearchRoutes(app) {
  // ── GET /v1/search/config/ — config + masked-key view + per-provider usage ──
  app.get('/v1/search/config/', (_req, res) => {
    const cfg = searchCfg.load();
    const usage = searchUsage.load();
    res.json({
      success: true,
      surface: cfg.surface,
      providers: buildProviderView(cfg.providers, usage),
    });
  });

  // ── PATCH /v1/search/config/ — update one provider OR the surface toggle ────
  // Body shape (any subset):
  //   { provider, api_key?, endpoint?, enabled?, priority?, cx? }   // Google CSE only: cx
  //   { surface: 'bridge' | 'mcp' | 'both' }
  //   { reorder: ['tavily','exa','google_cse','bing'] }              // priority array
  app.patch('/v1/search/config/', async (req, res) => {
    const body = req.body || {};
    const cfg = searchCfg.load();
    let mcpAction: 'start' | 'stop' | null = null;

    // Surface toggle
    if (body.surface && (body.surface === 'bridge' || body.surface === 'mcp' || body.surface === 'both')) {
      const prev = cfg.surface;
      cfg.surface = body.surface;
      // When the surface includes the MCP path, ensure the websearch MCP server
      // is running; when it switches to bridge-only, stop it.
      const wantMcp = body.surface === 'mcp' || body.surface === 'both';
      const hadMcp  = prev === 'mcp' || prev === 'both';
      if (wantMcp && !hadMcp) mcpAction = 'start';
      if (!wantMcp && hadMcp) mcpAction = 'stop';
    }

    // Reorder priorities
    if (Array.isArray(body.reorder)) {
      const order = body.reorder.filter((n) => cfg.providers.find((p) => p.name === n));
      let i = 1;
      for (const name of order) {
        const p = cfg.providers.find((pp) => pp.name === name);
        if (p) p.priority = i++;
      }
    }

    // Per-provider update
    if (body.provider) {
      const p = cfg.providers.find((pp) => pp.name === body.provider);
      if (p) {
        if (body.endpoint !== undefined) {
          const raw = String(body.endpoint || '');
          // Validate the URL before persisting. Empty string clears the
          // override (provider falls back to its built-in default). Anything
          // else must be a parseable URL with an https:// scheme, or http://
          // pointed at an explicit localhost host. Without this gate, a
          // hostile prefs PATCH could redirect the provider's outbound
          // request (carrying the API key) at an attacker-controlled host.
          if (raw === '') {
            p.endpoint = '';
          } else {
            let parsed: URL | null = null;
            try { parsed = new URL(raw); } catch (_) { /* fall through to reject */ }
            if (!parsed) {
              return res.status(400).json({ success: false, error: `invalid endpoint URL: ${raw}` });
            }
            const isLoopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1' || parsed.hostname === '[::1]';
            if (parsed.protocol === 'https:') {
              p.endpoint = raw;
            } else if (parsed.protocol === 'http:' && isLoopback) {
              p.endpoint = raw;
            } else {
              return res.status(400).json({ success: false, error: `endpoint must be https:// (or http:// for explicit localhost); got ${parsed.protocol}//${parsed.hostname}` });
            }
          }
        }
        if (body.enabled  !== undefined) p.enabled  = !!body.enabled;
        if (typeof body.priority === 'number' && body.priority > 0) p.priority = body.priority;
        const env = PROVIDER_ENV_KEYS[p.name];
        if (env && body.api_key && !String(body.api_key).startsWith('••') && String(body.api_key).length > 4) {
          writeEnvKey(env, String(body.api_key));
        }
        if (p.name === 'google_cse' && body.cx && !String(body.cx).startsWith('••') && String(body.cx).length > 2) {
          writeEnvKey('GOOGLE_CSE_CX', String(body.cx));
        }
      }
    }

    searchCfg.save(cfg);

    // Apply MCP start/stop AFTER config save, so the running server picks up
    // the latest endpoints/order on its next call (config is re-read on every
    // orchestrator.search).
    if (mcpAction) {
      try {
        const mcp = getModuleApi('mcp-client');
        if (!mcp) {
          return res.status(501).json({ success: false, error: 'mcp-client module is disabled' });
        }
        const { startMcpServer, stopMcpServer, readUpstreamRegistry } = mcp;
        if (mcpAction === 'start') {
          const reg = readUpstreamRegistry().mcpServers || {};
          if (reg.websearch) await startMcpServer('websearch', reg.websearch);
        } else {
          stopMcpServer('websearch');
        }
      } catch (e) {
        // Don't fail the config save if MCP start/stop hiccups — the user can
        // toggle it manually from the MCP tab.
        const msg = e instanceof Error ? e.message : String(e);
        return res.json({ success: true, mcpAction, mcpError: msg });
      }
    }

    res.json({ success: true, mcpAction });
  });

  // ── GET /v1/search/usage — full usage file ──────────────────────────────────
  app.get('/v1/search/usage', (_req, res) => {
    res.json({ success: true, usage: searchUsage.load() });
  });

  // ── DELETE /v1/search/usage — reset (all or one provider) ───────────────────
  app.delete('/v1/search/usage', (req, res) => {
    const provider = req.query?.provider ? String(req.query.provider) : null;
    searchUsage.reset(provider);
    res.json({ success: true });
  });
}

module.exports = { registerSearchRoutes, PROVIDER_ENV_KEYS, PROVIDER_CAPS, PROVIDER_API_KEY_URLS };
