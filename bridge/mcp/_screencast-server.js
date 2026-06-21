// @ts-check
'use strict';

// ── CDP screencast → WebSocket bridge ────────────────────────────────────────
// Used by desktop-browser-server.win.js. Binds a WebSocket server on an
// ephemeral 127.0.0.1 port and writes the chosen port to
// exchange/desktop-browser-stream.port so go-core's reverse proxy can find
// it (target rewritten on every request — port can change across MCP boots).
//
// Drives Chromium over the raw Chrome DevTools Protocol via the shared
// CdpClient (bun's built-in `ws`); NOT Playwright — its bundled WS transport
// hangs under bun-on-Windows (see memory: windows-remote-browser-blocked).
//
// Per-client flow:
//   - on connect: attach an isolated flatten-mode CDP session to the current
//     page (the raw-CDP equivalent of page.context().newCDPSession(page)),
//     enable Page, send Page.startScreencast, ack each frame
//   - inbound JSON messages → CDP Input.* / Emulation.* calls on that session
//   - on disconnect: stop the screencast and detach the session
//
// The server is lazy: if no clients are connected, no CDP traffic is
// generated at all (so the off-screen Chromium stays at ~0% CPU). The health
// endpoint (GET /) doubles as the frontend's boot probe — it kicks a boot when
// the browser isn't live yet and reports readiness / the last boot error.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { WebSocketServer } = require('ws');

const EXCHANGE_DIR = path.join(__dirname, 'exchange');
const PORT_FILE = path.join(EXCHANGE_DIR, 'desktop-browser-stream.port');

const DEFAULT_PRESET = { fps: 15, jpeg_quality: 55, max_dim: 1600 };

// hooks: { getCdp, getPageTargetId, isReady, getBootError, ensureBoot, logger }
//   getCdp()         → the shared CdpClient (or null before boot)
//   getPageTargetId()→ the current page target id (or null)
//   isReady()        → true once CDP is connected and a page is attached
//   getBootError()   → last boot error message string (or null)
//   ensureBoot()     → kick a single-flight (re)boot; fire-and-forget
//   logger(...args)  → stderr logger
function start(hooks) {
  const getCdp = hooks.getCdp;
  const getPageTargetId = hooks.getPageTargetId;
  const isReady = hooks.isReady || (() => false);
  const getBootError = hooks.getBootError || (() => null);
  const ensureBoot = hooks.ensureBoot || (() => {});
  const log = hooks.logger || ((...a) => process.stderr.write('[screencast] ' + a.join(' ') + '\n'));

  if (!fs.existsSync(EXCHANGE_DIR)) fs.mkdirSync(EXCHANGE_DIR, { recursive: true });

  // GET / is both go-core's pre-upgrade health check AND the frontend's boot
  // probe. While the browser isn't live we kick a (single-flight) boot and
  // answer 503 so the frontend keeps polling; once ready we answer 200 so the
  // probe resolves and the client opens the screencast WS. The `error` field
  // carries the last boot failure so the UI can show it instead of a blank
  // 45 s timeout.
  const httpServer = http.createServer((req, res) => {
    let ready = false;
    try { ready = !!isReady(); } catch (_) {}
    let bootErr = null;
    if (!ready) {
      try { ensureBoot(); } catch (_) {}
      try { bootErr = getBootError() || null; } catch (_) {}
    }
    res.statusCode = ready ? 200 : 503;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      ok: ready,
      booting: !ready,
      error: bootErr,
      clients: wss ? wss.clients.size : 0,
    }));
  });

  const wss = new WebSocketServer({ server: httpServer });
  wss.on('connection', (ws, req) => handleConnection(ws, req, { getCdp, getPageTargetId, log }));

  httpServer.listen(0, '127.0.0.1', () => {
    const { port } = /** @type {import('net').AddressInfo} */ (httpServer.address());
    try { fs.writeFileSync(PORT_FILE, String(port)); } catch (e) { log('port file write failed:', e.message); }
    log('listening on 127.0.0.1:' + port);
  });

  return {
    info() { const a = /** @type {import('net').AddressInfo | null} */ (httpServer.address()); return { port: a ? a.port : null, clientCount: wss.clients.size }; },
    async shutdown() {
      try { fs.unlinkSync(PORT_FILE); } catch (_) {}
      for (const ws of wss.clients) { try { ws.close(); } catch (_) {} }
      await /** @type {Promise<void>} */ (new Promise((res) => { try { wss.close(() => res()); } catch (_) { res(); } }));
      await /** @type {Promise<void>} */ (new Promise((res) => { try { httpServer.close(() => res()); } catch (_) { res(); } }));
    },
  };
}

async function handleConnection(ws, _req, { getCdp, getPageTargetId, log }) {
  let cdp = null;            // shared CdpClient captured at attach time
  let pageSessionId = null;  // our isolated flatten session on the page target
  const offFns = [];         // event unsubscribers, drained on close
  let preset = { ...DEFAULT_PRESET };
  let viewport = { w: 1280, h: 800 };
  let lastMouse = { x: 0, y: 0 };
  let closed = false;
  let lastAckAt = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function safeSend(obj) {
    if (closed || ws.readyState !== 1) return;
    try { ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj)); } catch (_) {}
  }
  function safeSendBinary(buf) {
    if (closed || ws.readyState !== 1) return;
    try { ws.send(buf, { binary: true }); } catch (_) {}
  }

  // Route a CDP command over our page session. Rejects if the browser died;
  // callers swallow + log so a transient failure doesn't tear down the WS.
  function send(method, params) {
    if (!cdp || cdp.closed || !pageSessionId) return Promise.reject(new Error('CDP session not attached'));
    return cdp.send(method, params || {}, pageSessionId);
  }

  async function attach() {
    cdp = getCdp();
    if (!cdp || cdp.closed) throw new Error('No CDP connection — desktop-browser not booted yet');
    const targetId = getPageTargetId();
    if (!targetId) throw new Error('No page target — desktop-browser not booted yet');

    pageSessionId = await cdp.attachToPage(targetId);

    // Frames are base64 JPEG; forward as binary to avoid the b64 overhead on
    // the wire and the decode cost on the client. The ack must echo the
    // frame's own (integer) session id — distinct from our CDP page session,
    // over which the ack command itself is routed.
    //
    // Rate-limit by PACING THE ACK, not via startScreencast's everyNthFrame:
    // that option counts compositor frames, so on a static/low-activity page
    // it drops the initial frame entirely (verified: everyNthFrame=4 → zero
    // frames on a quiet page). Chrome holds the next frame until we ack, so
    // capturing every frame (everyNthFrame:1) and delaying the ack to
    // ~1000/fps both caps CPU and guarantees the current view paints at once.
    offFns.push(cdp.onEvent('Page.screencastFrame', async (params) => {
      if (closed) return;
      const buf = Buffer.from(params.data, 'base64');
      safeSend({ type: 'frame_meta', bytes: buf.length, ts: params.metadata && params.metadata.timestamp });
      safeSendBinary(buf);
      const interval = 1000 / Math.max(1, preset.fps);
      const wait = Math.max(0, interval - (Date.now() - lastAckAt));
      if (wait > 0) await sleep(wait);
      if (closed) return;
      lastAckAt = Date.now();
      try { await send('Page.screencastFrameAck', { sessionId: params.sessionId }); }
      catch (_) { /* page may have died — disconnect/reattach will recover */ }
    }, pageSessionId));

    offFns.push(cdp.onEvent('Page.frameNavigated', (params) => {
      if (params.frame && !params.frame.parentId) safeSend({ type: 'navigated', url: params.frame.url });
    }, pageSessionId));

    // Page domain must be enabled per-session for screencast + navigation events.
    await send('Page.enable', {});
    // Under Windows dark mode, a page that doesn't paint its own background
    // composites on Chrome's near-black base, streaming as a black void during
    // loads/blank tabs. Override the base to white so such pages render light;
    // sites with their own background paint over it, unaffected. (The idle boot
    // page is a special case — about:blank ignores this override under forced
    // dark — handled by the injected start page in desktop-browser-server.win.js.)
    try { await send('Emulation.setDefaultBackgroundColorOverride', { color: { r: 255, g: 255, b: 255, a: 255 } }); }
    catch (e) { log('setDefaultBackgroundColorOverride failed:', e.message); }
    await applyViewport();
    await startCast();
    safeSend({ type: 'ready', preset, viewport });
  }

  async function applyViewport() {
    try {
      await send('Emulation.setDeviceMetricsOverride', {
        width: viewport.w, height: viewport.h,
        deviceScaleFactor: 1, mobile: false,
      });
    } catch (e) { log('setDeviceMetricsOverride failed:', e.message); }
  }

  async function startCast() {
    try {
      await send('Page.startScreencast', {
        format: 'jpeg',
        quality: preset.jpeg_quality,
        maxWidth: preset.max_dim || Math.max(viewport.w, 1280),
        maxHeight: preset.max_dim || Math.max(viewport.h, 800),
        everyNthFrame: 1, // rate is bounded by ack pacing (see screencastFrame)
      });
    } catch (e) { log('startScreencast failed:', e.message); }
  }

  async function stopCast() {
    try { await send('Page.stopScreencast'); } catch (_) {}
  }

  async function reconfigure(next) {
    preset = { ...preset, ...next };
    await stopCast();
    await startCast();
    safeSend({ type: 'preset', preset });
  }

  async function dispatchMouse(m) {
    lastMouse = { x: m.x, y: m.y };
    const evType = m.action === 'down' ? 'mousePressed'
      : m.action === 'up' ? 'mouseReleased'
      : 'mouseMoved';
    try {
      await send('Input.dispatchMouseEvent', {
        type: evType,
        x: m.x, y: m.y,
        button: m.button || 'none',
        buttons: m.buttons || 0,
        clickCount: m.clickCount || (evType === 'mouseMoved' ? 0 : 1),
        modifiers: m.modifiers || 0,
      });
    } catch (e) { log('mouse dispatch failed:', e.message); }
  }

  async function dispatchWheel(w) {
    try {
      await send('Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x: w.x, y: w.y,
        deltaX: w.deltaX || 0, deltaY: w.deltaY || 0,
        modifiers: w.modifiers || 0,
      });
    } catch (e) { log('wheel dispatch failed:', e.message); }
  }

  async function dispatchKey(k) {
    const evType = k.action === 'up' ? 'keyUp'
      : k.action === 'char' ? 'char'
      : 'keyDown';
    try {
      await send('Input.dispatchKeyEvent', {
        type: evType,
        text: k.text || (evType === 'char' ? k.key : undefined),
        unmodifiedText: k.text,
        key: k.key,
        code: k.code,
        modifiers: k.modifiers || 0,
        windowsVirtualKeyCode: k.windowsVirtualKeyCode,
        nativeVirtualKeyCode: k.nativeVirtualKeyCode,
      });
    } catch (e) { log('key dispatch failed:', e.message); }
  }

  async function insertText(t) {
    if (!t) return;
    try { await send('Input.insertText', { text: t }); }
    catch (e) { log('insertText failed:', e.message); }
  }

  // Browser-chrome navigation (address bar + back/forward/reload in the UI).
  // Runs on this connection's page session, which is the SAME page target the
  // model drives over MCP — so a user nav here is visible to the model's next
  // get_status, and the model's navs surface back to the address bar via the
  // Page.frameNavigated → {type:'navigated'} forwarding above.
  async function navigateTo(url) {
    if (!url || typeof url !== 'string') return;
    try { await send('Page.navigate', { url }); }
    catch (e) { log('navigate failed:', e.message); }
  }

  // CDP has no goBack/goForward; walk the navigation history explicitly.
  async function historyGo(delta) {
    try {
      const h = await send('Page.getNavigationHistory');
      const idx = h.currentIndex + delta;
      if (idx >= 0 && idx < h.entries.length) {
        await send('Page.navigateToHistoryEntry', { entryId: h.entries[idx].id });
      }
    } catch (e) { log('history nav failed:', e.message); }
  }

  async function reloadPage() {
    try { await send('Page.reload', {}); }
    catch (e) { log('reload failed:', e.message); }
  }

  // Serialize message handling. The client sends `config` then `resize`
  // back-to-back on connect; ws emits them as separate events whose async
  // handlers would otherwise interleave their stopCast()/startCast() calls and
  // could leave the screencast stopped or applied out of order. Chaining keeps
  // each message fully processed before the next begins.
  let msgChain = Promise.resolve();
  ws.on('message', (raw) => {
    msgChain = msgChain.then(() => handleMessage(raw)).catch((e) => log('message handler error:', e.message));
  });

  async function handleMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch (_) { return; }
    switch (msg.type) {
      case 'config':
        await reconfigure({ fps: msg.fps, jpeg_quality: msg.jpeg_quality, max_dim: msg.max_dim });
        break;
      case 'resize':
        viewport = { w: Math.max(320, Math.round(msg.w)), h: Math.max(240, Math.round(msg.h)) };
        await applyViewport();
        // Restart with new max dims so the encoder budget matches the canvas.
        await stopCast(); await startCast();
        safeSend({ type: 'viewport', viewport });
        break;
      case 'mouse': await dispatchMouse(msg); break;
      case 'wheel': await dispatchWheel(msg); break;
      case 'key':   await dispatchKey(msg); break;
      case 'paste': await insertText(msg.text); break;
      case 'navigate':  await navigateTo(msg.url); break;
      case 'goBack':    await historyGo(-1); break;
      case 'goForward': await historyGo(1); break;
      case 'reload':    await reloadPage(); break;
      case 'ping':  safeSend({ type: 'pong', t: Date.now() }); break;
      default: /* ignore unknown */ break;
    }
  }

  ws.on('close', async () => {
    closed = true;
    for (const off of offFns.splice(0)) { try { off(); } catch (_) {} }
    await stopCast();
    if (cdp && pageSessionId) { try { await cdp.detach(pageSessionId); } catch (_) {} }
    cdp = null;
    pageSessionId = null;
  });
  ws.on('error', (e) => log('ws error:', e.message));

  try { await attach(); }
  catch (e) {
    log('attach failed:', e.message);
    safeSend({ type: 'error', message: e.message });
    try { ws.close(); } catch (_) {}
  }
}

module.exports = { start };
