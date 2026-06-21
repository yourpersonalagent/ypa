// @ts-check
'use strict';

// ── Minimal Chrome DevTools Protocol client ──────────────────────────────────
// One browser-level WebSocket, "flatten" mode: every session multiplexes over
// the single socket and messages carry a `sessionId`. A sessionId of undefined
// targets the browser itself (Target.* / Browser.*). Multiple sessions can
// attach to the same page target (Target.attachToTarget{flatten:true}) so the
// tool driver and each screencast client get an isolated session — the raw-CDP
// equivalent of Playwright's page.context().newCDPSession(page).
//
// Why this exists: Playwright's bundled WebSocket transport hangs under
// bun-on-Windows (both launchPersistentContext and connectOverCDP). bun's
// built-in `ws` + a raw chrome.exe spawn are proven to work, so we drive
// Chromium directly. See memory: windows-remote-browser-blocked.

const http = require('http');
const WebSocket = require('ws');
const { EventEmitter } = require('events');

function httpGetJson(url, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('http timeout')); });
  });
}

class CdpClient extends EventEmitter {
  constructor(ws) {
    super();
    this.setMaxListeners(0); // many per-session frame/event listeners
    this.ws = ws;
    this._id = 0;
    this._pending = new Map();
    this._closed = false;
    ws.on('message', (data) => this._onMessage(data));
    ws.on('close', () => this._onClose());
    ws.on('error', (e) => this.emit('transport-error', e));
  }

  static async connect(wsUrl, { timeoutMs = 10000 } = {}) {
    const ws = new WebSocket(wsUrl, { perMessageDeflate: false, maxPayload: 256 * 1024 * 1024 });
    await /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('CDP ws connect timeout')), timeoutMs);
      ws.once('open', () => { clearTimeout(t); resolve(); });
      ws.once('error', (e) => { clearTimeout(t); reject(e); });
    }));
    return new CdpClient(ws);
  }

  // Send a CDP command. Resolves with `result`, rejects on protocol error or
  // a closed connection. `sessionId` undefined → browser-level command.
  send(method, params = {}, sessionId) {
    if (this._closed) return Promise.reject(new Error('CDP connection closed'));
    const id = ++this._id;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify(msg), (err) => {
          if (err) { this._pending.delete(id); reject(err); }
        });
      } catch (e) {
        this._pending.delete(id);
        reject(e);
      }
    });
  }

  // Subscribe to a CDP event. When sessionId is given only that session's
  // events match (events are tagged by the session that enabled the domain).
  // Returns an unsubscribe fn.
  onEvent(method, fn, sessionId) {
    const key = (sessionId ? sessionId + ':' : '') + method;
    this.on(key, fn);
    return () => this.off(key, fn);
  }

  _onMessage(data) {
    let msg;
    try { msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf8')); }
    catch (_) { return; }
    if (msg.id && this._pending.has(msg.id)) {
      const { resolve, reject } = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else resolve(msg.result);
      return;
    }
    if (msg.method) {
      // Emit a session-scoped key and a bare key so subscribers choose the
      // granularity they need.
      if (msg.sessionId) this.emit(msg.sessionId + ':' + msg.method, msg.params, msg.sessionId);
      this.emit(msg.method, msg.params, msg.sessionId);
    }
  }

  _onClose() {
    if (this._closed) return;
    this._closed = true;
    for (const { reject } of this._pending.values()) reject(new Error('CDP connection closed'));
    this._pending.clear();
    this.emit('disconnect');
  }

  get closed() { return this._closed; }

  close() { try { this.ws.close(); } catch (_) {} }

  // Attach to a page target and return its flatten-mode sessionId.
  async attachToPage(targetId) {
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    return sessionId;
  }

  async detach(sessionId) {
    if (!sessionId) return;
    try { await this.send('Target.detachFromTarget', { sessionId }); } catch (_) {}
  }
}

// Poll http://host:port/json/version until it yields a browser
// webSocketDebuggerUrl (i.e. Chrome's DevTools endpoint is up).
async function discoverBrowserWsUrl(host, port, { timeoutMs = 30000, intervalMs = 400 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try {
      const v = await httpGetJson(`http://${host}:${port}/json/version`, 1500);
      if (v && v.webSocketDebuggerUrl) return v.webSocketDebuggerUrl;
    } catch (e) { lastErr = e; }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error('CDP /json/version not ready on ' + host + ':' + port +
    (lastErr ? ' (' + lastErr.message + ')' : ''));
}

// List page-type targets via the HTTP endpoint (no ws required yet).
async function listPageTargets(host, port) {
  const list = await httpGetJson(`http://${host}:${port}/json/list`, 2000);
  return Array.isArray(list) ? list.filter((t) => t.type === 'page') : [];
}

module.exports = { CdpClient, discoverBrowserWsUrl, listPageTargets, httpGetJson };
