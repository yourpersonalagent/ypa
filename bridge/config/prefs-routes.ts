// ── User preferences routes (server-side settings store) ───────────────────
// Extracted from handler.ts (registerConfigRoutes) — see ./handler.ts.
'use strict';

const fs = require('fs');

function registerPrefsRoutes(app) {
  // ── User preferences (server-side settings store) ───────────────────────────
  // Per-user (Q16) — routed via bridge/core/paths.ts.
  const PREFS_PATH = require('../core/paths').prefs;

  async function readPrefs() {
    try {
      return JSON.parse(await fs.promises.readFile(PREFS_PATH, 'utf8'));
    } catch (_) {
      return {};
    }
  }

  app.get('/v1/prefs/', async (req, res) => {
    res.json({ success: true, prefs: await readPrefs() });
  });

  app.patch('/v1/prefs/', async (req, res) => {
    try {
      if (typeof req.body !== 'object' || Array.isArray(req.body))
        return res.status(400).json({ success: false, error: 'body must be object' });
      const updated = { ...(await readPrefs()), ...req.body };
      // prefs.json holds secrets (YHA Net bearer tokens, etc.) — keep it
      // owner-only. writeFile's mode only applies on create, so chmod the
      // existing file too (best-effort; a no-op on Windows).
      await fs.promises.writeFile(PREFS_PATH, JSON.stringify(updated, null, 2), { encoding: 'utf8', mode: 0o600 });
      try { await fs.promises.chmod(PREFS_PATH, 0o600); } catch (_) { /* non-POSIX FS */ }
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e.message });
    }
  });
}

module.exports = { registerPrefsRoutes };
