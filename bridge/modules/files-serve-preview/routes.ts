// ── /v1/serve/* — REST endpoints for the per-CWD live-preview tool ──────────
// State lives in bridge/files/serve.ts (kept in core because the proxy
// middleware, WS-upgrade hook, and killAllSync() are wired directly into
// bridge/server.ts at boot); these routes are thin handlers around it.
'use strict';

const serveLib = require('../../files/serve');

function registerServeRoutes(app): void {
  // Boot probe — frontend can render disabled cards for missing runtimes.
  app.get('/v1/serve/runtimes', (_req, res) => {
    res.json({ success: true, runtimes: serveLib.RUNTIMES });
  });

  app.get('/v1/serve/status', (req, res) => {
    if (req.query?.id) {
      const e = serveLib.findById(String(req.query.id));
      return res.json({ success: true, entry: e ? serveLib.entryToPublic(e) : null });
    }
    if (req.query?.cwd) {
      try {
        const e = serveLib.findByCwd(String(req.query.cwd));
        return res.json({ success: true, entry: e ? serveLib.entryToPublic(e) : null });
      } catch (e) {
        return res.status(400).json({ success: false, error: (e as Error).message });
      }
    }
    res.json({ success: true, entries: serveLib.listEntries() });
  });

  app.get('/v1/serve/profiles', (_req, res) => {
    res.json({ success: true, profiles: serveLib.loadStoredProfiles() });
  });

  app.post('/v1/serve/start', async (req, res) => {
    try {
      const body = req.body || {};
      const entry = await serveLib.startServe({
        cwd:        body.cwd,
        profile:    body.profile,
        cmdLine:    body.cmdLine,
        sessionId:  body.sessionId ?? null,
        keepAlive:  !!body.keepAlive,
        ttlMs:      body.ttlMs ?? 60 * 60_000,
      });
      res.json({ success: true, entry: serveLib.entryToPublic(entry) });
    } catch (e) {
      res.status(400).json({ success: false, error: (e as Error).message });
    }
  });

  app.post('/v1/serve/stop/:id', async (req, res) => {
    try {
      await serveLib.stopServe(req.params.id, 'manual');
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: (e as Error).message });
    }
  });

  app.post('/v1/serve/touch/:id', (req, res) => {
    const ok = serveLib.touch(req.params.id);
    if (!ok) return res.status(404).json({ success: false, error: 'not found' });
    res.json({ success: true });
  });

  app.post('/v1/serve/keep-alive/:id', (req, res) => {
    const keepAlive = !!(req.body?.keepAlive);
    const ok = serveLib.setKeepAlive(req.params.id, keepAlive);
    if (!ok) return res.status(404).json({ success: false, error: 'not found' });
    res.json({ success: true, keepAlive });
  });



  app.get('/v1/serve/shares', (_req, res) => {
    res.json({ success: true, shares: serveLib.listShares() });
  });

  app.post('/v1/serve/share/:id', (req, res) => {
    try {
      const share = serveLib.createShare(req.params.id, req.body?.ttlMs ?? 60 * 60_000, req.body?.label);
      res.json({ success: true, share });
    } catch (e) {
      res.status(400).json({ success: false, error: (e as Error).message });
    }
  });

  app.post('/v1/serve/shares/:token/revoke', (req, res) => {
    const ok = serveLib.revokeShare(req.params.token);
    if (!ok) return res.status(404).json({ success: false, error: 'not found' });
    res.json({ success: true });
  });

  app.post('/v1/serve/active-session', (req, res) => {
    const sessionId = req.body?.sessionId ?? null;
    serveLib.setActiveSession(sessionId === null ? null : String(sessionId));
    res.json({ success: true, activeSessionId: serveLib.getActiveSession() });
  });

  app.get('/v1/serve/logs/:id', (req, res) => {
    const lines = serveLib.getLogs(req.params.id);
    if (lines === null) return res.status(404).json({ success: false, error: 'not found' });
    res.json({ success: true, lines });
  });
}

module.exports = { registerServeRoutes };
