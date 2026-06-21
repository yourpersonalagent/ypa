// ── Routes for the shared "important" memory ─────────────────────────────────
// Public (auth-gated) endpoints under /v1/important and an SSE stream.
// Internal-key-gated endpoints under /proxy/important for the MCP child to
// write through the bridge so updates are broadcast to all SSE clients.
'use strict';

const {
  readImportant,
  writeImportant,
  addLine,
  removeLine,
  markSeen,
  importantEvents,
  MAX_LINES,
} = require('../context/global');
const { BRIDGE_INTERNAL_KEY } = require('../core/state');
const { timingSafeEqualStr } = require('../core/secure-compare');

function isInternalAuthorized(req): boolean {
  const authHeader = String(req.headers['x-api-key'] || req.headers['authorization'] || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  return Boolean(token) && timingSafeEqualStr(token, BRIDGE_INTERNAL_KEY);
}

// ── SSE clients ──────────────────────────────────────────────────────────────
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

importantEvents.on('changed', (state) => {
  sseBroadcast('important:changed', state);
});

function registerImportantRoutes(app): void {
  // SSE must be registered before any /:id-style siblings (none here, but follow convention).
  app.get('/v1/important/events', async (req, res) => {
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

    try {
      const snap = await readImportant();
      res.write(`event: important:snapshot\ndata: ${JSON.stringify(snap)}\n\n`);
      flushSse();
    } catch (_) {}

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

  // ── Public (user-facing) ───────────────────────────────────────────────────
  app.get('/v1/important', async (req, res) => {
    try {
      let state = await readImportant();
      if (req.query?.seen === '1') {
        state = await markSeen();
      }
      res.json({ success: true, ...state, maxLines: MAX_LINES });
    } catch (e) {
      res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.put('/v1/important', async (req, res) => {
    try {
      const body = req.body || {};
      if (!Array.isArray(body.lines)) {
        return res.status(400).json({ success: false, error: 'lines must be an array' });
      }
      if (body.lines.length > MAX_LINES) {
        return res.status(400).json({ success: false, error: `too many lines (max ${MAX_LINES})` });
      }
      const state = await writeImportant({ lines: body.lines, updatedBy: 'user' });
      res.json({ success: true, ...state, maxLines: MAX_LINES });
    } catch (e) {
      res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // ── Internal (MCP child / bridge subprocess) ───────────────────────────────
  app.get('/proxy/important', async (req, res) => {
    if (!isInternalAuthorized(req)) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    try {
      const state = await readImportant();
      res.json({ success: true, ...state, maxLines: MAX_LINES });
    } catch (e) {
      res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/proxy/important/set', async (req, res) => {
    if (!isInternalAuthorized(req)) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    try {
      const body = req.body || {};
      if (!Array.isArray(body.lines)) {
        return res.status(400).json({ success: false, error: 'lines must be an array' });
      }
      const state = await writeImportant({ lines: body.lines, updatedBy: 'model' });
      res.json({ success: true, ...state, maxLines: MAX_LINES });
    } catch (e) {
      res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/proxy/important/add', async (req, res) => {
    if (!isInternalAuthorized(req)) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    try {
      const body = req.body || {};
      if (typeof body.text !== 'string') {
        return res.status(400).json({ success: false, error: 'text must be a string' });
      }
      const state = await addLine(body.text, 'model');
      res.json({ success: true, ...state, maxLines: MAX_LINES });
    } catch (e) {
      res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  app.post('/proxy/important/remove', async (req, res) => {
    if (!isInternalAuthorized(req)) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    try {
      const body = req.body || {};
      const ref: { index?: number; text?: string } = {};
      if (typeof body.index === 'number') ref.index = body.index;
      if (typeof body.text === 'string') ref.text = body.text;
      if (ref.index === undefined && ref.text === undefined) {
        return res.status(400).json({ success: false, error: 'provide index or text' });
      }
      const state = await removeLine(ref, 'model');
      res.json({ success: true, ...state, maxLines: MAX_LINES });
    } catch (e) {
      res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
    }
  });
}

module.exports = { registerImportantRoutes };
