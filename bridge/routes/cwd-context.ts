// ── Routes for cwd-scoped shared context ─────────────────────────────────────
'use strict';

const {
  readCwdContext,
  writeCwdContext,
  cwdContextEvents,
  MAX_LINES,
  normalizeCwd,
} = require('../context/cwd');

const sseClients: Set<any> = new Set();

function sseBroadcast(event: string, data: unknown): void {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of [...sseClients]) {
    try {
      res.write(payload);
      if (typeof res.flush === 'function') res.flush();
    } catch (_) {
      sseClients.delete(res);
    }
  }
}

cwdContextEvents.on('changed', (state) => {
  sseBroadcast('cwd-context:changed', state);
});

function registerCwdContextRoutes(app): void {
  app.get('/v1/cwd-context/events', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const flushSse = () => {
      if (typeof (res as any).flush === 'function') {
        try { (res as any).flush(); } catch (_) {}
      }
    };

    const cwd = normalizeCwd(req.query?.cwd);
    if (cwd) {
      try {
        const snap = await readCwdContext(cwd);
        res.write(`event: cwd-context:snapshot\ndata: ${JSON.stringify({ ...snap, maxLines: MAX_LINES })}\n\n`);
        flushSse();
      } catch (_) {}
    }

    sseClients.add(res);
    const ping = setInterval(() => {
      try {
        res.write(': ping\n\n');
        flushSse();
      } catch (_) {
        clearInterval(ping);
        sseClients.delete(res);
      }
    }, 25_000);
    ping.unref();

    req.on('close', () => {
      clearInterval(ping);
      sseClients.delete(res);
    });
  });

  app.get('/v1/cwd-context', async (req, res) => {
    const cwd = normalizeCwd(req.query?.cwd);
    if (!cwd) return res.status(400).json({ success: false, error: 'cwd query parameter required' });
    try {
      const state = await readCwdContext(cwd);
      res.json({ success: true, ...state, maxLines: MAX_LINES });
    } catch (e) {
      res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.put('/v1/cwd-context', async (req, res) => {
    try {
      const body = req.body || {};
      const cwd = normalizeCwd(body.cwd);
      if (!cwd) return res.status(400).json({ success: false, error: 'cwd required' });
      if (!Array.isArray(body.lines)) {
        return res.status(400).json({ success: false, error: 'lines must be an array' });
      }
      if (body.lines.length > MAX_LINES) {
        return res.status(400).json({ success: false, error: `too many lines (max ${MAX_LINES})` });
      }
      const state = await writeCwdContext({ cwd, lines: body.lines, updatedBy: 'user' });
      res.json({ success: true, ...state, maxLines: MAX_LINES });
    } catch (e) {
      res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
}

module.exports = { registerCwdContextRoutes };
