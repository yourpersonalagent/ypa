// Search provider config — order, enabled flags, endpoint URLs, surface toggle.
// Plain JS so both the bridge parent (tsx) and the MCP child (node) can require it.
'use strict';

const fs = require('fs');
const path = require('path');

// Path stays at `bridge/search-config.json` (user state file kept outside
// the module dir during the modular migration). __dirname is
// bridge/modules/search; two `..` reach bridge/.
const CONFIG_PATH = path.join(__dirname, '..', '..', 'search-config.json');

const DEFAULT_PROVIDERS = [
  { name: 'tavily',         enabled: true, priority: 1, endpoint: 'https://api.tavily.com/search' },
  { name: 'exa',            enabled: true, priority: 2, endpoint: 'https://api.exa.ai/search' },
  { name: 'google_cse',     enabled: true, priority: 3, endpoint: 'https://www.googleapis.com/customsearch/v1' },
  { name: 'bing',           enabled: true, priority: 4, endpoint: 'https://api.bing.microsoft.com/v7.0/search' },
  { name: 'brave',          enabled: true, priority: 5, endpoint: 'https://api.search.brave.com/res/v1/web/search' },
  // Real-Chrome Google search via the legacy `playwright-mcp` MCP (Windows
  // CDP / stealth). No API key, no quota — works when that MCP is running.
  { name: 'playwright_mcp', enabled: true, priority: 6, endpoint: '' },
  // Same idea, but routed through the *visible* Pi-local Docker Chromium
  // (the new `web` MCP). Use this when you want searches to actually drive
  // the browser the user can see in the BrowserWindow.
  { name: 'web_mcp',        enabled: true, priority: 7, endpoint: '' },
];

function defaultConfig() {
  return { surface: 'both', providers: DEFAULT_PROVIDERS.map((p) => ({ ...p })) };
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    const surface = (raw.surface === 'bridge' || raw.surface === 'mcp') ? raw.surface : 'both';
    const providers = Array.isArray(raw.providers) && raw.providers.length
      ? raw.providers
      : DEFAULT_PROVIDERS.map((p) => ({ ...p }));
    // Ensure all known providers exist (in case the file was written before a new one was added)
    for (const def of DEFAULT_PROVIDERS) {
      if (!providers.find((p) => p.name === def.name)) providers.push({ ...def });
    }
    return { surface, providers };
  } catch (_) {
    return defaultConfig();
  }
}

function writeAtomic(filePath, data) {
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, filePath);
}

function save(cfg) {
  writeAtomic(CONFIG_PATH, cfg);
}

module.exports = { load, save, defaultConfig, DEFAULT_PROVIDERS, CONFIG_PATH };
