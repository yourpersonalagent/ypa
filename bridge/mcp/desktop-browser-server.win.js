#!/usr/bin/env node
// @ts-check
'use strict';
// NOTE: document/location/HTMLInputElement/HTMLTextAreaElement below appear in functions serialized via .toString() and eval'd in the page; typed via mcp/_dom-eval.d.ts

// ── desktop-browser MCP — Windows native ─────────────────────────────────────
// Drop-in sibling of desktop-browser-server.js for Windows hosts. Instead of
// running Chromium in a Linux container with KasmVNC, this file:
//   - spawns a headed Chromium directly (chrome.exe --remote-debugging-port),
//     with a persistent profile at %LOCALAPPDATA%\YHA\desktop-browser so logins
//     survive
//   - drives it over the raw Chrome DevTools Protocol via bun's built-in `ws`
//     (NOT Playwright — its bundled WS transport hangs under bun-on-Windows;
//     see memory: windows-remote-browser-blocked)
//   - mounts a WS bridge (_screencast-server.js) that pipes Page.startScreencast
//     to a <canvas> in the YHA frontend (replaces the KasmVNC iframe)
//
// Tool surface (search/navigate/click/.../get_status/restart) mirrors the
// Linux file so the same model prompts work unchanged. The frontend
// distinguishes between the two via `get_status.mode` ("native-windows"
// vs "docker-linux").

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { CdpClient, discoverBrowserWsUrl, listPageTargets, httpGetJson } = require('./_cdp-client');
const _stdinDecoder = new StringDecoder('utf8');

const CDP_HOST = '127.0.0.1';
const CDP_PORT = 9333;
const CDP_URL = 'http://' + CDP_HOST + ':' + CDP_PORT;
const PROFILE_DIR = path.join(
  process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
  'YHA', 'desktop-browser'
);
const EXCHANGE_DIR = path.join(__dirname, 'exchange');
if (!fs.existsSync(EXCHANGE_DIR)) fs.mkdirSync(EXCHANGE_DIR, { recursive: true });
if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });

// ── MCP stdio transport ──────────────────────────────────────────────────────

let inputBuffer = '';

function sendMessage(msg) {
  const json = JSON.stringify(msg);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(json, 'utf8') + '\r\n\r\n' + json);
}

function logErr(...args) {
  process.stderr.write('[desktop-browser/win] ' + args.join(' ') + '\n');
}

function handleMessage(msg) {
  if (msg.method === 'initialize') {
    sendMessage({
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'web', version: '1.0.0-win' }
      }
    });
    bootChromium().catch((e) => logErr('boot failed:', e.message));
    startWatchdog();
  } else if (msg.method === 'initialized' || msg.method === 'notifications/initialized') {
    /* notification */
  } else if (msg.method === 'ping') {
    sendMessage({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else if (msg.method === 'tools/list') {
    sendMessage({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
  } else if (msg.method === 'tools/call') {
    handleToolCall(msg.id, msg.params.name, msg.params.arguments || {});
  } else if (msg.id !== undefined) {
    sendMessage({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
  }
}

process.stdin.on('data', (chunk) => {
  inputBuffer += _stdinDecoder.write(chunk);
  while (true) {
    const headerEnd = inputBuffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;
    const clMatch = inputBuffer.slice(0, headerEnd).match(/Content-Length:\s*(\d+)/i);
    if (!clMatch) { inputBuffer = inputBuffer.slice(headerEnd + 4); break; }
    const len = parseInt(clMatch[1], 10);
    const bodyStart = headerEnd + 4;
    if (inputBuffer.length < bodyStart + len) break;
    const body = inputBuffer.slice(bodyStart, bodyStart + len);
    inputBuffer = inputBuffer.slice(bodyStart + len);
    try { handleMessage(JSON.parse(body)); } catch (_) { /* parse errors ignored */ }
  }
});

process.stdin.on('end', () => shutdownAndExit());
process.on('SIGTERM', () => shutdownAndExit());
process.on('SIGINT', () => shutdownAndExit());
require('./_parent-watchdog').installParentWatchdog(shutdownAndExit);

process.on('unhandledRejection', (reason) => {
  const r = /** @type {any} */ (reason);
  logErr('unhandledRejection:', r && r.message ? r.message : String(r));
});
process.on('uncaughtException', (err) => {
  logErr('uncaughtException:', err && err.message ? err.message : String(err));
});

let shuttingDown = false;
async function shutdownAndExit() {
  if (shuttingDown) return;
  shuttingDown = true;
  try { if (screencastServer) await screencastServer.shutdown(); } catch (_) {}
  await teardownBrowser().catch(() => {});
  process.exit(0);
}

// ── Tool surface ─────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'search',
    description: 'Search the web by driving the visible Windows-local Chromium through Google (or DuckDuckGo). Returns title/url/snippet for the top results — same data shape as the websearch MCP, but coming from a real, fingerprint-clean Chrome the user can also see in the BrowserWindow.',
    inputSchema: {
      type: 'object',
      properties: {
        query:  { type: 'string',  description: 'Search query — natural language.' },
        limit:  { type: 'number',  description: 'Max number of results (default 10, max 25).' },
        engine: { type: 'string',  enum: ['google', 'duckduckgo'], description: 'Search engine. Default google. Switch to duckduckgo if Google rate-limits.' },
      },
      required: ['query'],
    },
  },
  {
    name: 'navigate',
    description: 'Navigate the desktop browser to a URL. Drives a real Chromium running on the Windows host (visible to the user via the YHA browser window — rendered as a live canvas streamed over CDP). Sub-50 ms localhost CDP — fast and reliable.',
    inputSchema: {
      type: 'object',
      properties: {
        url:      { type: 'string', description: 'URL to load.' },
        wait_for: { type: 'string', description: 'Wait condition: load (default), domcontentloaded, networkidle.' },
        timeout:  { type: 'number', description: 'Navigation timeout in ms (default 30000).' }
      },
      required: ['url']
    }
  },
  {
    name: 'click',
    description: 'Click an element on the current page (CSS selector or visible text).',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the element.' },
        text:     { type: 'string', description: 'Visible text of the element (alternative to selector).' }
      }
    }
  },
  {
    name: 'fill',
    description: 'Fill a form field on the current page (input, textarea, search box).',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of the input/textarea.' },
        value:    { type: 'string', description: 'Value to enter.' }
      },
      required: ['selector', 'value']
    }
  },
  {
    name: 'type',
    description: 'Type text into the currently focused element. Useful after a click() that put focus on a field, or for keyboard interactions in elements without a stable selector.',
    inputSchema: {
      type: 'object',
      properties: {
        text:  { type: 'string', description: 'Text to type.' },
        delay: { type: 'number', description: 'Per-keystroke delay in ms (default 0).' }
      },
      required: ['text']
    }
  },
  {
    name: 'get_content',
    description: 'Read text or HTML of the currently loaded page (or one element by CSS selector).',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector — omit for full body.' },
        format:   { type: 'string', enum: ['text', 'html'], description: 'Output format (default text).' }
      }
    }
  },
  {
    name: 'screenshot',
    description: 'Capture a screenshot of the current page and save it to disk. Returns metadata only — the model does NOT see the image. Fast (CDP).',
    inputSchema: {
      type: 'object',
      properties: {
        full_page: { type: 'boolean', description: 'Capture full scrollable page (default false).' },
        selector:  { type: 'string', description: 'Screenshot only this element (CSS selector).' }
      }
    }
  },
  {
    name: 'screenshot_view',
    description: 'Capture a screenshot AND return it inline so a vision-capable model can see the page. ANTHROPIC/CLAUDE MODELS ONLY — others receive raw base64 as text.',
    inputSchema: {
      type: 'object',
      properties: {
        full_page: { type: 'boolean', description: 'Capture full scrollable page (default false).' },
        selector:  { type: 'string', description: 'Screenshot only this element (CSS selector).' }
      }
    }
  },
  {
    name: 'evaluate',
    description: 'Run arbitrary JavaScript in the current page context and return the result.',
    inputSchema: {
      type: 'object',
      properties: {
        script: { type: 'string', description: 'JavaScript expression or statements (last expression is returned).' }
      },
      required: ['script']
    }
  },
  {
    name: 'pdf',
    description: 'Save the current page as a PDF file to the exchange folder.',
    inputSchema: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Output filename (default page_<timestamp>.pdf).' },
        format:   { type: 'string', description: 'Paper format: A4 (default), Letter, A3, etc.' }
      }
    }
  },
  {
    name: 'get_status',
    description: 'Get current browser state: Chromium running, CDP connected, current URL, screencast WS path for the user window.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'restart',
    description: 'Close and re-launch Chromium. Use to recover from a hung browser or to discard a misbehaving page state. Profile (logins, cookies) is preserved.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'show_window',
    description: 'Move the Chromium window on-screen at a sane default position. Use when the user wants to interact with the browser natively instead of through the canvas.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'hide_window',
    description: 'Move the Chromium window off-screen. Frees screen real estate while keeping the browser running — the canvas in the YHA frontend continues to work.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  }
];

// ── Chromium + CDP lifecycle ─────────────────────────────────────────────────

let cdp = null;            // CdpClient bound to the browser-level ws endpoint
let mainSession = null;    // flatten-mode sessionId for the primary page target
let pageTargetId = null;   // primary page targetId
let chromeProc = null;     // spawned chrome.exe child (null when we reused one)
let browserStartTime = null;
let screencastServer = null;
let currentUrl = null;
let lastBootError = null;   // surfaced via get_status + the screencast health probe

// Locate the headed Chromium. Playwright's executablePath() is a pure path
// lookup (no WS transport) so it's safe under bun even though launching via
// Playwright is not. Fall back to scanning the browser cache.
function resolveChromeExe() {
  try {
    const { chromium } = require('playwright');
    const p = chromium.executablePath();
    if (p && fs.existsSync(p)) return p;
  } catch (_) { /* fall through to cache scan */ }
  const base = path.join(
    process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'),
    'ms-playwright'
  );
  try {
    const dirs = fs.readdirSync(base).filter((d) => /^chromium-\d+$/.test(d)).sort().reverse();
    for (const d of dirs) {
      for (const sub of ['chrome-win64', 'chrome-win']) {
        const exe = path.join(base, d, sub, 'chrome.exe');
        if (fs.existsSync(exe)) return exe;
      }
    }
  } catch (_) { /* no cache dir */ }
  throw new Error('Chromium executable not found. Run: cd bridge/mcp && bunx playwright install chromium');
}

function ensureScreencastServer() {
  if (screencastServer) return screencastServer;
  screencastServer = require('./_screencast-server').start({
    getCdp: () => cdp,
    getPageTargetId: () => pageTargetId,
    isReady: () => !!(cdp && !cdp.closed && mainSession),
    getBootError: () => lastBootError,
    ensureBoot: () => { bootChromium().catch(() => {}); },
    logger: logErr,
  });
  return screencastServer;
}

// Single-flight: concurrent callers share the in-flight boot promise so we
// don't end up spawning two Chromium processes racing for the same profile dir.
let _bootInFlight = null;
function bootChromium() {
  if (_bootInFlight) return _bootInFlight;
  _bootInFlight = (async () => {
    if (cdp && !cdp.closed && mainSession) return;

    // Start the screencast WS server first (idempotent): writes the port file
    // the go-core proxy reads, and its health endpoint reflects readiness so
    // the frontend probe doesn't false-positive before CDP is live.
    ensureScreencastServer();

    // Reuse an already-running Chrome on the debug port if present (a prior MCP
    // boot, or a manual launch) — avoids a profile-lock handoff that would
    // immediately exit our freshly spawned process.
    let wsUrl = null;
    try {
      const v = await httpGetJson(CDP_URL + '/json/version', 1200);
      if (v && v.webSocketDebuggerUrl) wsUrl = v.webSocketDebuggerUrl;
    } catch (_) { /* not running — spawn below */ }

    if (!wsUrl) {
      const exe = resolveChromeExe();
      chromeProc = spawn(exe, [
        '--remote-debugging-port=' + CDP_PORT,
        '--remote-debugging-address=' + CDP_HOST,
        // Chrome >=111 rejects DevTools ws upgrades from a disallowed Origin.
        // Our client sends none, but be explicit so a future proxy hop can't
        // break the handshake.
        '--remote-allow-origins=*',
        '--user-data-dir=' + PROFILE_DIR,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-blink-features=AutomationControlled',
        // We hide the window off-screen (hideWindowImpl) but still need
        // Page.startScreencast to keep emitting frames. Windows' native
        // occlusion detection would mark an off-screen window "occluded" and
        // halt compositing (→ zero frames); these switches keep the renderer
        // painting regardless of visibility. The Linux/Xvfb path never needed
        // this (no occlusion detection on a virtual display).
        '--disable-features=CalculateNativeWindowOcclusion',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
        '--window-size=1280,800',
        'about:blank',
      ], { stdio: 'ignore', windowsHide: false });
      chromeProc.on('exit', (code) => { if (!shuttingDown) logErr('chrome exited, code=' + code); });
      wsUrl = await discoverBrowserWsUrl(CDP_HOST, CDP_PORT, { timeoutMs: 30000 });
    }

    const client = await CdpClient.connect(wsUrl);
    client.on('disconnect', () => { if (client === cdp) { cdp = null; mainSession = null; } });
    cdp = client;

    // Pick or create a page target, then attach a flatten session for tools.
    const pages = await listPageTargets(CDP_HOST, CDP_PORT);
    if (pages.length) {
      pageTargetId = pages[0].id;
    } else {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
      pageTargetId = targetId;
    }
    mainSession = await cdp.attachToPage(pageTargetId);
    await cdp.send('Page.enable', {}, mainSession);
    await cdp.send('Runtime.enable', {}, mainSession);
    cdp.onEvent('Page.frameNavigated', (p) => {
      if (p && p.frame && !p.frame.parentId) currentUrl = p.frame.url;
    }, mainSession);
    try { const href = await evalExpr('location.href'); if (typeof href === 'string') currentUrl = href; } catch (_) {}

    // A fresh boot lands on about:blank, which under Windows dark mode paints
    // near-black — the screencast would show a black void with no hint that the
    // browser is alive or how to drive it. Render a friendly start page so the
    // idle window is clearly "ready" and the user can type a URL / search.
    // Skip it when we reused an already-running Chrome that's on a real page.
    if (!currentUrl || /^about:blank/.test(currentUrl)) {
      try { await injectStartPage(); } catch (e) { logErr('start-page inject failed:', e.message); }
    }

    browserStartTime = Date.now();
    try { await hideWindowImpl(); } catch (e) { logErr('hide-on-boot failed:', e.message); }
    lastBootError = null;
  })().catch((e) => {
    lastBootError = e && e.message ? e.message : String(e);
    throw e;
  });
  _bootInFlight.finally(() => { _bootInFlight = null; });
  return _bootInFlight;
}

function isTransientBrowserCrash(err) {
  const msg = String(err && err.message || err || '');
  return /target page|browser has been closed|target closed|browser closed|connection closed|cdp connection closed|session with given id|inspected target|websocket|ECONNREFUSED|ECONNRESET|EPIPE|protocol error/i
    .test(msg);
}

async function withBrowser(fn) {
  try {
    return await fn();
  } catch (e) {
    if (!isTransientBrowserCrash(e)) throw e;
    logErr('transient crash detected — recovering:', e.message);
    await teardownBrowser();
    await bootChromium();
    return await fn();
  }
}

let _watchdogStarted = false;
function startWatchdog() {
  if (_watchdogStarted) return;
  _watchdogStarted = true;
  setInterval(async () => {
    if (shuttingDown || _bootInFlight) return;
    if (!cdp || cdp.closed) return; // not booted — boot happens on demand
    try {
      await cdp.send('Browser.getVersion'); // cheap browser-level round-trip
    } catch (e) {
      logErr('watchdog: CDP dead — recovering:', e.message);
      await teardownBrowser();
      try { await bootChromium(); } catch (e2) { logErr('watchdog boot failed:', e2.message); }
    }
  }, 15_000).unref();
}

// Ensure CDP is connected and a page session exists; returns the page session.
async function ensureCdp() {
  if (!cdp || cdp.closed || !mainSession) await bootChromium();
  return mainSession;
}

async function teardownBrowser() {
  try { if (cdp) cdp.close(); } catch (_) {}
  cdp = null;
  mainSession = null;
  pageTargetId = null;
  const proc = chromeProc;
  chromeProc = null;
  if (proc && !proc.killed) {
    await /** @type {Promise<void>} */ (new Promise((resolve) => {
      let done = false;
      const fin = () => { if (!done) { done = true; resolve(); } };
      proc.once('exit', fin);
      try { proc.kill(); } catch (_) { fin(); }
      setTimeout(fin, 3000); // don't hang shutdown if the process lingers
    }));
  }
}

// Run a JS expression in the page and return its (by-value) result.
async function evalExpr(expression, { awaitPromise = true } = {}) {
  const { result, exceptionDetails } = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise,
    returnByValue: true,
    userGesture: true,
  }, mainSession);
  if (exceptionDetails) {
    const d = exceptionDetails.exception;
    throw new Error((d && (d.description || d.value)) || exceptionDetails.text || 'evaluate failed');
  }
  return result ? result.value : undefined;
}

// Paint the boot start page into the current (about:blank) document. Injected
// rather than navigated so the page URL stays about:blank and the user's typed
// URL drives the very first real navigation via the page's own form handler
// (which rides the existing screencast keyboard forwarding — no extra plumbing).
async function injectStartPage() {
  await evalExpr('(' + _startPageInBrowser.toString() + ')()');
}

// Wait for a one-shot Page lifecycle event on the main session, with timeout.
function waitForPageEvent(method, timeoutMs) {
  let off = null;
  let timer = null;
  const cleanup = () => { if (off) { off(); off = null; } if (timer) { clearTimeout(timer); timer = null; } };
  const promise = /** @type {Promise<void>} */ (new Promise((resolve, reject) => {
    off = cdp.onEvent(method, () => resolve(), mainSession);
    timer = setTimeout(() => reject(new Error(method + ' timeout')), timeoutMs);
  })).finally(cleanup);
  return { promise, cancel: cleanup };
}

async function hideWindowImpl() {
  await ensureCdp();
  const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: pageTargetId });
  await cdp.send('Browser.setWindowBounds', {
    windowId,
    bounds: { left: -2400, top: -2400, width: 1280, height: 800, windowState: 'normal' },
  });
}

async function showWindowImpl() {
  await ensureCdp();
  const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId: pageTargetId });
  await cdp.send('Browser.setWindowBounds', {
    windowId,
    bounds: { left: 100, top: 100, width: 1280, height: 800, windowState: 'normal' },
  });
}

// ── Tool dispatch ────────────────────────────────────────────────────────────

function handleToolCall(id, name, args) {
  (async () => {
    try {
      let result;
      if (name === 'search')                result = await withBrowser(() => toolSearch(args));
      else if (name === 'navigate')         result = await withBrowser(() => toolNavigate(args));
      else if (name === 'click')            result = await withBrowser(() => toolClick(args));
      else if (name === 'fill')             result = await withBrowser(() => toolFill(args));
      else if (name === 'type')             result = await withBrowser(() => toolType(args));
      else if (name === 'get_content')      result = await withBrowser(() => toolGetContent(args));
      else if (name === 'screenshot')       result = await withBrowser(() => toolScreenshot(args));
      else if (name === 'screenshot_view') {
        const meta = await withBrowser(() => toolScreenshot(args));
        const buf = fs.readFileSync(meta.path);
        sendMessage({
          jsonrpc: '2.0', id,
          result: { content: [
            { type: 'text',  text: JSON.stringify(meta, null, 2) },
            { type: 'image', data: buf.toString('base64'), mimeType: 'image/png' }
          ]}
        });
        return;
      }
      else if (name === 'evaluate')         result = await withBrowser(() => toolEvaluate(args));
      else if (name === 'pdf')              result = await withBrowser(() => toolPdf(args));
      else if (name === 'get_status')       result = await toolGetStatus();
      else if (name === 'restart')          result = await toolRestart();
      else if (name === 'show_window')    { await showWindowImpl(); result = { window_visible: true }; }
      else if (name === 'hide_window')    { await hideWindowImpl(); result = { window_visible: false }; }
      else throw new Error('Unknown tool: ' + name);

      sendMessage({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      });
    } catch (e) {
      sendMessage({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true }
      });
    }
  })();
}

// ── Tool implementations ─────────────────────────────────────────────────────
// Page interactions run through Runtime.evaluate (click/fill/get_content) so
// the behaviour matches the Linux file's Playwright calls closely without
// needing coordinate-based Input dispatch. The functions below are stringified
// and evaluated in the page context, so they may only reference page globals.

function _extractGoogle(max) {
  const out = [];
  const seen = new Set();
  const anchors = document.querySelectorAll('a[href]');
  for (const a of anchors) {
    if (out.length >= max) break;
    const href = a.href;
    if (!href.startsWith('http')) continue;
    if (/^https?:\/\/(www\.)?google\./i.test(href)) continue;
    if (/google\.com\/(search|maps|imgres|url|aclk)/i.test(href)) continue;
    if (seen.has(href)) continue;
    const h3 = a.querySelector('h3');
    const title = h3 ? h3.innerText.trim() : '';
    if (!title) continue;
    let snippet = '';
    let n = a.parentElement;
    for (let i = 0; i < 6 && n; i++) {
      const txt = (n.innerText || '').trim();
      if (txt && txt.length > title.length + 30) {
        snippet = txt.split('\n').slice(1).join(' ').replace(/\s+/g, ' ').trim().slice(0, 280);
        if (snippet) break;
      }
      n = n.parentElement;
    }
    seen.add(href);
    out.push({ title, url: href, snippet });
  }
  return out;
}

function _extractDdg(max) {
  const out = [];
  document.querySelectorAll('.result, .web-result').forEach((r) => {
    if (out.length >= max) return;
    const a = r.querySelector('a.result__a, a[href]');
    const sn = r.querySelector('.result__snippet, .result-snippet');
    if (!a) return;
    const href = a.href;
    if (!href.startsWith('http')) return;
    out.push({
      title: (a.innerText || '').trim(),
      url: href,
      snippet: sn ? (sn.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 280) : '',
    });
  });
  return out;
}

async function toolSearch(args) {
  if (!args.query || !String(args.query).trim()) throw new Error('query is required');
  const limit = Math.max(1, Math.min(parseInt(args.limit) || 10, 25));
  const engine = args.engine === 'duckduckgo' ? 'duckduckgo' : 'google';
  await ensureCdp();
  const url = engine === 'google'
    ? 'https://www.google.com/search?q=' + encodeURIComponent(args.query) + '&hl=en'
    : 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(args.query);
  await toolNavigate({ url, wait_for: 'load' });

  const extractor = engine === 'google' ? _extractGoogle : _extractDdg;
  const results = await evalExpr('(' + extractor.toString() + ')(' + limit + ')');

  return {
    query: args.query,
    engine,
    count: results.length,
    results,
    hint: results.length === 0
      ? 'No results parsed — selectors may have changed. Try engine="duckduckgo" or browse the search URL directly.'
      : undefined,
  };
}

async function toolNavigate(args) {
  await ensureCdp();
  const waitFor = args.wait_for || 'load';
  const timeout = args.timeout || 30000;
  const evName = waitFor === 'domcontentloaded' ? 'Page.domContentEventFired' : 'Page.loadEventFired';
  const waited = waitForPageEvent(evName, timeout);
  const nav = await cdp.send('Page.navigate', { url: args.url }, mainSession);
  if (nav.errorText) { waited.cancel(); throw new Error('navigation failed: ' + nav.errorText); }
  try { await waited.promise; } catch (_) { /* timed out — return current state anyway */ }
  // networkidle isn't a CDP lifecycle event; approximate with a short settle.
  if (waitFor === 'networkidle') await new Promise((r) => setTimeout(r, 500));
  const title = await evalExpr('document.title');
  const href = await evalExpr('location.href');
  currentUrl = typeof href === 'string' ? href : currentUrl;
  return { url: currentUrl, title };
}

// Runs in the browser context (injected via evalExpr). Keep self-contained —
// no Node refs, no closures over server state. Builds the idle "ready" screen
// with a URL/search box; on submit the page navigates itself (so the user's
// keystrokes, already forwarded by the screencast, drive the first nav).
function _startPageInBrowser() {
  document.title = 'Remote Browser';
  document.documentElement.style.colorScheme = 'light';
  document.body.innerHTML =
    '<div id="yha-start"><div class="yha-card">' +
      '<div class="yha-title">Remote Browser</div>' +
      '<div class="yha-sub">Ready. The assistant can browse here on your behalf — ' +
        'and you can take over any time for logins, captchas, or clicking around.</div>' +
      '<form id="yha-f"><input id="yha-u" type="text" ' +
        'placeholder="Type a URL or search, then press Enter" ' +
        'autocomplete="off" autocapitalize="off" spellcheck="false"></form>' +
    '</div></div>';
  var css = document.createElement('style');
  css.textContent =
    'html,body{margin:0;height:100%}' +
    '#yha-start{height:100vh;display:flex;align-items:center;justify-content:center;' +
      'background:#f6f7f9;font-family:system-ui,Segoe UI,Arial,sans-serif;color:#1a1a1a}' +
    '.yha-card{width:min(560px,86vw);text-align:center}' +
    '.yha-title{font-size:28px;font-weight:650;margin:0 0 8px}' +
    '.yha-sub{font-size:14px;color:#555;margin:0 0 22px;line-height:1.5}' +
    '#yha-u{width:100%;box-sizing:border-box;padding:13px 16px;font-size:16px;' +
      'border:1px solid #cfd4dc;border-radius:10px;outline:none;background:#fff}' +
    '#yha-u:focus{border-color:#6b8afd;box-shadow:0 0 0 3px rgba(107,138,253,.25)}';
  document.head.appendChild(css);
  var u = document.getElementById('yha-u');
  function go() {
    var v = (u.value || '').trim();
    if (!v) return;
    var url;
    if (/^https?:\/\//i.test(v)) url = v;
    else if (v.indexOf(' ') === -1 && /^[^\s.]+(\.[^\s.]+)+$/.test(v)) url = 'https://' + v;
    else url = 'https://www.google.com/search?q=' + encodeURIComponent(v);
    window.location.assign(url);
  }
  // Handle Enter explicitly: a CDP-synthesised Enter keydown does NOT trigger a
  // form's implicit submission (verified), so the <form> submit event alone
  // would never fire under the screencast's forwarded keystrokes.
  u.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); go(); }
  });
  document.getElementById('yha-f').addEventListener('submit', function (e) { e.preventDefault(); go(); });
  u.focus();
  return location.href;
}

function _clickInPage(sel, txt) {
  let el = null;
  if (sel) {
    el = document.querySelector(sel);
  } else if (txt) {
    const t = String(txt).trim();
    const nodes = document.querySelectorAll('a,button,[role=button],input[type=submit],input[type=button],summary,label,[onclick]');
    for (const n of nodes) {
      const s = (n.innerText || n.value || '').trim();
      if (s === t) { el = n; break; }
    }
    if (!el) for (const n of nodes) {
      const s = (n.innerText || n.value || '').trim();
      if (s.includes(t)) { el = n; break; }
    }
  }
  if (!el) return { ok: false };
  try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
  el.click();
  return { ok: true, url: location.href };
}

async function toolClick(args) {
  await ensureCdp();
  if (!args.text && !args.selector) throw new Error('Provide selector or text');
  const expr = '(' + _clickInPage.toString() + ')('
    + JSON.stringify(args.selector || null) + ',' + JSON.stringify(args.text || null) + ')';
  const r = await evalExpr(expr);
  if (!r || !r.ok) throw new Error('Element not found: ' + (args.selector || args.text));
  currentUrl = r.url || currentUrl;
  return { clicked: args.selector || args.text, current_url: currentUrl };
}

function _fillInPage(sel, value) {
  const el = document.querySelector(sel);
  if (!el) return { ok: false };
  el.focus();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  if (desc && desc.set) desc.set.call(el, value); else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return { ok: true };
}

async function toolFill(args) {
  await ensureCdp();
  const expr = '(' + _fillInPage.toString() + ')('
    + JSON.stringify(args.selector) + ',' + JSON.stringify(args.value) + ')';
  const r = await evalExpr(expr);
  if (!r || !r.ok) throw new Error('Element not found: ' + args.selector);
  return { filled: args.selector, value: args.value };
}

async function toolType(args) {
  await ensureCdp();
  const text = String(args.text == null ? '' : args.text);
  const delay = args.delay || 0;
  if (delay > 0) {
    for (const ch of text) {
      await cdp.send('Input.insertText', { text: ch }, mainSession);
      await new Promise((r) => setTimeout(r, delay));
    }
  } else {
    await cdp.send('Input.insertText', { text }, mainSession);
  }
  return { typed: text };
}

function _getElement(sel, asHtml) {
  const el = document.querySelector(sel);
  if (!el) return { nf: true };
  return { v: asHtml ? el.innerHTML : el.innerText };
}

async function toolGetContent(args) {
  await ensureCdp();
  if (args.selector) {
    const expr = '(' + _getElement.toString() + ')('
      + JSON.stringify(args.selector) + ',' + (args.format === 'html') + ')';
    const r = await evalExpr(expr);
    if (r && r.nf) throw new Error('Element not found: ' + args.selector);
    return r.v;
  }
  if (args.format === 'html') return await evalExpr('document.documentElement.outerHTML');
  return await evalExpr('document.body ? document.body.innerText : ""');
}

function _rectOf(sel) {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, width: r.width, height: r.height };
}

async function toolScreenshot(args) {
  await ensureCdp();
  const fname = 'desktop_screenshot_' + Date.now() + '.png';
  const fpath = path.join(EXCHANGE_DIR, fname);
  const params = { format: 'png' };

  if (args.selector) {
    const rect = await evalExpr('(' + _rectOf.toString() + ')(' + JSON.stringify(args.selector) + ')');
    if (!rect) throw new Error('Element not found: ' + args.selector);
    params.clip = { x: rect.x, y: rect.y, width: Math.max(1, rect.width), height: Math.max(1, rect.height), scale: 1 };
    params.captureBeyondViewport = true;
  } else if (args.full_page) {
    const m = await cdp.send('Page.getLayoutMetrics', {}, mainSession);
    const cs = m.cssContentSize || m.contentSize;
    params.clip = { x: 0, y: 0, width: Math.ceil(cs.width), height: Math.ceil(cs.height), scale: 1 };
    params.captureBeyondViewport = true;
  }

  const { data } = await cdp.send('Page.captureScreenshot', params, mainSession);
  fs.writeFileSync(fpath, Buffer.from(data, 'base64'));
  return { filename: fname, path: fpath, size_bytes: fs.statSync(fpath).size };
}

async function toolEvaluate(args) {
  await ensureCdp();
  const result = await evalExpr(String(args.script));
  return { result };
}

// Paper dimensions in inches for Page.printToPDF.
const PDF_FORMATS = {
  A3: [11.69, 16.54], A4: [8.27, 11.69], A5: [5.83, 8.27],
  Letter: [8.5, 11], Legal: [8.5, 14], Tabloid: [11, 17],
};

async function toolPdf(args) {
  await ensureCdp();
  const fname = args.filename || ('page_' + Date.now() + '.pdf');
  const fpath = path.join(EXCHANGE_DIR, fname);
  const dims = PDF_FORMATS[args.format] || PDF_FORMATS.A4;
  const { data } = await cdp.send('Page.printToPDF', {
    paperWidth: dims[0], paperHeight: dims[1], printBackground: true,
  }, mainSession);
  fs.writeFileSync(fpath, Buffer.from(data, 'base64'));
  return { filename: fname, path: fpath, size_bytes: fs.statSync(fpath).size };
}

async function toolGetStatus() {
  const ready = !!(cdp && !cdp.closed && mainSession);
  const screencast = screencastServer ? screencastServer.info() : null;
  return {
    mode: 'native-windows',
    cdp_url: CDP_URL,
    cdp_ready: ready,
    browser_connected: ready,
    current_url: currentUrl,
    profile_dir: PROFILE_DIR,
    screencast_path: '/proxy/desktop-browser-stream',
    screencast_port: screencast ? screencast.port : null,
    screencast_clients: screencast ? screencast.clientCount : 0,
    uptime_seconds: browserStartTime ? Math.floor((Date.now() - browserStartTime) / 1000) : null,
    boot_error: lastBootError || undefined,
  };
}

async function toolRestart() {
  await teardownBrowser();
  await bootChromium();
  return { restarted: true, ...(await toolGetStatus()) };
}
