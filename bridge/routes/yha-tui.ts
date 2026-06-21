// ── /__yha/api/* — operator console HTTP shim ───────────────────────────
//
// The web UI (Rewind page, Prefs modal, #debug surfaces) needs a way to
// trigger commands that today's yha.sh / pm2 own. Rather than each
// caller spawning a CLI process, this shim translates HTTP requests
// into the YHA-TUI-Daemon's unix-socket wire protocol — the daemon is
// the single source of truth for "what just happened" regardless of
// who triggered it.
//
// Routes:
//   POST /__yha/api/cmd            {cmd, args?, origin}  → {ok, job_id}
//   GET  /__yha/api/status                              → StatusSnap
//   GET  /__yha/api/jobs                                → JobInfo[]
//   GET  /__yha/api/jobs/:id/log?since=N                → {data, next_offset, done}
//
// Loopback-only by intent (single-owner, see plan §1+§2 K). Gated by
// the same authMiddleware that fronts the rest of /v1/*; no
// bridge-internal key is used because the daemon's unix socket already
// provides the per-user filesystem permission gate (mode 0600).
//
// See docs/YHA-TUI-Replacement-Plan.md §7 for the wire protocol the
// daemon speaks; this shim is the thinnest possible translator.
'use strict';

const net = require('net');
const path = require('path');
const fs = require('fs');
const logger = require('../core/logger');

const DAEMON_SOCKET = process.env.YHA_TUI_SOCKET ||
  path.join(__dirname, '..', 'state', 'yha-tui', 'daemon.sock');

// Single in-flight request per connection — we open a fresh socket per
// HTTP call to keep the shim stateless. The daemon's per-conn writer
// goroutine doesn't care, and the v1 traffic shape (handful of clicks
// per minute) doesn't justify connection pooling.

function dialDaemon(): Promise<any> {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(DAEMON_SOCKET);
    const onErr = (e: any) => {
      sock.removeListener('connect', onOk);
      reject(e);
    };
    const onOk = () => {
      sock.removeListener('error', onErr);
      resolve(sock);
    };
    sock.once('error', onErr);
    sock.once('connect', onOk);
  });
}

// Send a single envelope and wait for the next envelope back. The
// daemon writes its response as the immediate next line on the same
// connection (with matching `id`), so we don't need request multiplex.
function callDaemon(env: any, timeoutMs = 5000): Promise<any> {
  return new Promise(async (resolve, reject) => {
    let sock: any;
    try {
      sock = await dialDaemon();
    } catch (e) {
      return reject(e);
    }
    const id = 'http-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
    let buf = '';
    const cleanup = () => {
      try { sock.end(); } catch {}
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('daemon timeout'));
    }, timeoutMs);
    sock.on('data', (chunk: Buffer) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl < 0) return;
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      let parsed: any;
      try { parsed = JSON.parse(line); }
      catch {
        clearTimeout(timer); cleanup();
        return reject(new Error('bad json from daemon: ' + line.slice(0, 200)));
      }
      // Filter for our reply id — ignore unsolicited broadcasts.
      if (parsed.id && parsed.id !== id) return;
      clearTimeout(timer); cleanup();
      resolve(parsed);
    });
    sock.on('error', (e: any) => {
      clearTimeout(timer); cleanup();
      reject(e);
    });
    sock.on('end', () => {
      clearTimeout(timer);
      // If we never got a reply, fall through to the timeout/error path.
    });
    const envWithId = { ...env, id };
    sock.write(JSON.stringify(envWithId) + '\n');
  });
}

function daemonUnreachable(res: any, err: any): void {
  const msg = err instanceof Error ? err.message : String(err);
  logger.warn?.('yha-tui.unreachable', { error: msg, socket: DAEMON_SOCKET });
  res.status(503).json({
    ok: false,
    error: 'YHA-TUI-Daemon unreachable',
    detail: msg,
    socket: DAEMON_SOCKET,
    hint: 'pm2 status YHA-TUI-Daemon',
  });
}

function registerYhaTuiRoutes(app: any): void {
  // POST /__yha/api/cmd
  app.post('/__yha/api/cmd', async (req: any, res: any) => {
    const body = req.body || {};
    const cmd = typeof body.cmd === 'string' ? body.cmd.trim() : '';
    if (!cmd) return res.status(400).json({ ok: false, error: 'cmd required' });
    const args = Array.isArray(body.args) ? body.args.map(String) : [];
    const origin = typeof body.origin === 'string' ? body.origin : 'web-ui';
    try {
      const reply = await callDaemon({ op: 'cmd', cmd, args, origin });
      if (reply.op === 'error') {
        return res.status(400).json({ ok: false, error: reply.err, code: reply.code });
      }
      return res.json({ ok: true, job_id: reply.job_id, job: reply.job || null });
    } catch (e) {
      return daemonUnreachable(res, e);
    }
  });

  // GET /__yha/api/status
  app.get('/__yha/api/status', async (_req: any, res: any) => {
    try {
      const reply = await callDaemon({ op: 'status' });
      if (reply.op === 'error') {
        return res.status(500).json({ ok: false, error: reply.err });
      }
      return res.json({ ok: true, status: reply.status });
    } catch (e) {
      return daemonUnreachable(res, e);
    }
  });

  // GET /__yha/api/jobs
  app.get('/__yha/api/jobs', async (_req: any, res: any) => {
    try {
      const reply = await callDaemon({ op: 'list-jobs' });
      if (reply.op === 'error') {
        return res.status(500).json({ ok: false, error: reply.err });
      }
      return res.json({ ok: true, jobs: reply.jobs || [] });
    } catch (e) {
      return daemonUnreachable(res, e);
    }
  });

  // GET /__yha/api/jobs/:id/log?since=<offset>
  // Reads the on-disk log file directly — no socket roundtrip needed
  // since the daemon writes durably to bridge/state/yha-tui/jobs/<id>.log.
  // Returns whatever's available now plus the new cursor. Web UI polls
  // this for incremental updates; SSE is deliberately not implemented
  // in v1 (the daemon's unix socket is the streaming surface, not HTTP).
  app.get('/__yha/api/jobs/:id/log', (req: any, res: any) => {
    const id = String(req.params.id || '').replace(/[^A-Za-z0-9-]/g, '');
    if (!id) return res.status(400).json({ ok: false, error: 'bad job id' });
    const since = Math.max(0, parseInt(String(req.query?.since || '0'), 10) || 0);
    const logPath = path.join(__dirname, '..', 'state', 'yha-tui', 'jobs', `${id}.log`);
    fs.stat(logPath, (err, st) => {
      if (err) {
        return res.status(404).json({ ok: false, error: 'no such job log', job_id: id });
      }
      if (since >= st.size) {
        // Nothing new — also check for done.json to tell caller it's safe to stop.
        const donePath = path.join(__dirname, '..', 'state', 'yha-tui', 'jobs', `${id}.done.json`);
        fs.access(donePath, (accessErr) => {
          res.json({ ok: true, data: '', next_offset: st.size, done: !accessErr });
        });
        return;
      }
      // Cap read at 1 MiB per poll to keep the response bounded.
      const wantBytes = Math.min(st.size - since, 1024 * 1024);
      fs.open(logPath, 'r', (openErr, fd) => {
        if (openErr) return res.status(500).json({ ok: false, error: openErr.message });
        const buf = Buffer.allocUnsafe(wantBytes);
        fs.read(fd, buf, 0, wantBytes, since, (readErr, bytesRead) => {
          fs.close(fd, () => {});
          if (readErr) return res.status(500).json({ ok: false, error: readErr.message });
          const donePath = path.join(__dirname, '..', 'state', 'yha-tui', 'jobs', `${id}.done.json`);
          fs.access(donePath, (accessErr) => {
            res.json({
              ok: true,
              data: buf.slice(0, bytesRead).toString('utf8'),
              next_offset: since + bytesRead,
              done: !accessErr && since + bytesRead >= st.size,
            });
          });
        });
      });
    });
  });
}

module.exports = { registerYhaTuiRoutes };
