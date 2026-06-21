#!/usr/bin/env node
// @ts-check
'use strict';
// NOTE: `document` below appears in functions serialized via .toString() and eval'd in the page; typed via mcp/_dom-eval.d.ts

// On Windows the Docker/KasmVNC path below doesn't apply — delegate to the
// native sibling which spawns Chromium and drives it over raw CDP (bun's
// built-in `ws`, not Playwright — its bundled transport hangs under
// bun-on-Windows; see memory windows-remote-browser-blocked). Top-level
// `return` is valid in CommonJS (Node wraps modules in a function); verified
// under bun too. mcp-registry.json points to this file for both platforms;
// the dispatcher keeps the JSON platform-agnostic.
if (process.platform === 'win32') {
  module.exports = require('./desktop-browser-server.win.js');
  // @ts-ignore -- valid CommonJS top-level return (Node wraps each module in a function); the mcp tsconfig models the file as a module and flags it
  return;
}

// ── desktop-browser MCP ──────────────────────────────────────────────────────
// Runs Chromium inside a Docker container (lscr.io/linuxserver/chromium) on the
// Pi itself. The container exposes two surfaces:
//   :3011  KasmVNC web UI  (slow, for the user's window in the YHA frontend)
//   :9333  Chromium CDP    (fast, for the model — Playwright connectOverCDP)
//
// Lifecycle is tied to the MCP process: on initialize we run `docker compose up
// -d`; on shutdown we run `docker compose stop`. Toggling this MCP off in the
// MCP prefs tab therefore stops the container — no orphaned Chromium.
//
// Tool surface mirrors bridge/mcp/playwright-server.js so a model can swap to
// the same prompts.

const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const http = require('http');
const { StringDecoder } = require('string_decoder');
const _stdinDecoder = new StringDecoder('utf8');

const COMPOSE_FILE = path.join(__dirname, '..', 'docker-compose.browser.yml');
const CONTAINER_NAME = 'yha-chromium';
const KASM_URL = 'http://127.0.0.1:3011/';
// 9333, not 9222: 9222 is reserved by the host Chrome that the legacy
// `playwright-mcp` server (formerly named `web`) uses for real-mode CDP.
// 3011, not 3001/3000: those are taken by other host services.
const CDP_URL = 'http://127.0.0.1:9333';
const CDP_PORT = 9333;
const KASM_PORT = 3011;
const EXCHANGE_DIR = path.join(__dirname, 'exchange');
if (!fs.existsSync(EXCHANGE_DIR)) fs.mkdirSync(EXCHANGE_DIR, { recursive: true });

const DOCKER_BIN = resolveDockerBin();
const DOCKER_ENV = resolveDockerEnv();

function resolveDockerBin() {
  if (process.env.YHA_DOCKER_BIN) return process.env.YHA_DOCKER_BIN;
  if (process.platform === 'darwin') {
    const dockerDesktopBin = '/Applications/Docker.app/Contents/Resources/bin/docker';
    if (fs.existsSync(dockerDesktopBin)) return dockerDesktopBin;
  }
  return 'docker';
}

function resolveDockerEnv() {
  if (process.env.DOCKER_HOST || process.platform !== 'darwin') return process.env;
  const userSocket = path.join(process.env.HOME || '', '.docker', 'run', 'docker.sock');
  if (!fs.existsSync(userSocket)) return process.env;
  return { ...process.env, DOCKER_HOST: 'unix://' + userSocket };
}

function runDockerSync(args, options = {}) {
  return spawnSync(DOCKER_BIN, args, { env: DOCKER_ENV, ...options });
}

// ── MCP stdio transport ──────────────────────────────────────────────────────

let inputBuffer = '';

function sendMessage(msg) {
  const json = JSON.stringify(msg);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(json, 'utf8') + '\r\n\r\n' + json);
}

function logErr(...args) {
  // stdout is reserved for MCP frames — diagnostics go to stderr where the
  // bridge captures them.
  process.stderr.write('[desktop-browser] ' + args.join(' ') + '\n');
}

function handleMessage(msg) {
  if (msg.method === 'initialize') {
    sendMessage({
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'web', version: '1.0.0' }
      }
    });
    // Bring the container up in the background so the first tool call doesn't
    // pay the cold-start cost. If it fails, we surface the error on the next
    // tool call rather than failing the handshake.
    bootContainer().catch((e) => logErr('boot failed:', e.message));
    // Health-check loop — recovers from labwc/Wayland aborts inside the
    // container without the user noticing.
    startWatchdog();
  } else if (msg.method === 'initialized' || msg.method === 'notifications/initialized') {
    // notification — no response
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
    try { handleMessage(JSON.parse(body)); } catch (e) { /* ignore parse errors */ }
  }
});

process.stdin.on('end', () => shutdownAndExit());
process.on('SIGTERM', () => shutdownAndExit());
process.on('SIGINT', () => shutdownAndExit());

// Defense against the bun --watch re-exec orphan path: detect stdin pipe
// destruction or being reparented to init, then exit cleanly.
require('./_parent-watchdog').installParentWatchdog(shutdownAndExit);

// Last-resort: a stray rejection from inside Playwright's WS handlers (very
// common when the container dies mid-call) must not kill the MCP — that's
// what produces the "orphan tool call" symptom. Log and stay alive.
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
  await teardownBrowser().catch(() => {});
  // Stop (not down) — preserves the named container so volumes survive.
  try {
    runDockerSync(['compose', '-f', COMPOSE_FILE, 'stop'], { stdio: 'ignore', timeout: 30_000 });
  } catch (_) { /* best-effort */ }
  process.exit(0);
}

// ── Tool surface ─────────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'search',
    description: 'Search the web by driving the visible Pi-local Chromium through Google (or DuckDuckGo). Returns title/url/snippet for the top results — same data shape as the websearch MCP, but coming from a real, fingerprint-clean Chrome the user can also see in the BrowserWindow.',
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
    description: 'Navigate the desktop browser to a URL. Drives a real Chromium running on the host (visible to the user via the YHA browser window). Sub-50 ms localhost CDP — fast and reliable. Use for the same workflows as web__browse, when you specifically want the user to be able to watch / take over the session for logins or captchas.',
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
    description: 'Capture a screenshot of the current page and save it to disk. Returns metadata only — the model does NOT see the image. Fast (CDP, not noVNC).',
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
    description: 'Get current browser state: container running, CDP connected, current URL, KasmVNC URL for the user window.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'restart',
    description: 'Stop and re-start the container. Use to recover from a hung Chromium or to discard a misbehaving page state.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  }
];

// ── Container + CDP lifecycle ────────────────────────────────────────────────

let browserInstance = null;
let pageInstance = null;
let containerStartTime = null;

function isPortReady(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: 800 }, (res) => {
      // 9222 returns JSON; 3001 returns HTML — both are "alive" if we got a response
      res.resume();
      resolve(true);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
}

function isPortOpen(port) {
  return new Promise((resolve) => {
    const net = require('net');
    const sock = net.createConnection({ host: '127.0.0.1', port, timeout: 600 });
    sock.once('connect', () => { sock.end(); resolve(true); });
    sock.once('error',   () => resolve(false));
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
  });
}

async function waitForPort(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isPortOpen(port)) return true;
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

// Single-flight: concurrent callers (e.g. several parallel tool calls all
// hitting ensurePage() during a labwc crash) share a single in-flight boot
// promise instead of stampeding `docker compose up -d` and CDP reconnects.
let _bootInFlight = null;
function bootContainer() {
  if (_bootInFlight) return _bootInFlight;
  _bootInFlight = (async () => {
    // The container's /config volume must exist with PUID=1000 ownership
    // before first start. Wrong/missing ownership → labwc aborts ~15 s in
    // and the whole container exits cleanly. Idempotent guard.
    const configDir = path.join(path.dirname(COMPOSE_FILE), 'browser-config');
    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
      try { fs.chownSync(configDir, 1000, 1000); } catch (_) { /* needs root */ }
    }

    // `docker compose up -d` is idempotent — re-runs are no-ops if the
    // container is already running.
    const r = runDockerSync(['compose', '-f', COMPOSE_FILE, 'up', '-d'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120_000,
    });
    if (r.status !== 0) {
      throw new Error('docker compose up failed: ' + (r.stderr ? r.stderr.toString() : 'exit ' + r.status));
    }
    containerStartTime = Date.now();

    const cdpUp = await waitForPort(CDP_PORT, 30_000);
    if (!cdpUp) throw new Error('CDP did not become ready on :' + CDP_PORT + ' within 30 s');
    await waitForPort(KASM_PORT, 15_000);

    await connectPlaywright();
  })();
  // Clear the in-flight pointer once the boot resolves (success or failure)
  // so a subsequent crash gets a fresh attempt instead of replaying the
  // cached error promise forever.
  _bootInFlight.finally(() => { _bootInFlight = null; });
  return _bootInFlight;
}

// Heuristic: classify a thrown error from Playwright/CDP as a transient
// "the browser died under us" condition that warrants a single retry after
// re-booting the container. Anything else is propagated as-is so real bugs
// (bad selectors, malformed args) stay visible.
function isTransientBrowserCrash(err) {
  const msg = String(err && err.message || err || '');
  return /target page|browser has been closed|target closed|browser closed|connection closed|websocket|ECONNREFUSED|ECONNRESET|EPIPE|connectOverCDP|cdp connect failed|browser context|protocol error/i
    .test(msg);
}

// Wrap a tool action in a one-shot retry: if the first attempt fails with a
// transient crash signal, force a fresh container boot + Playwright reconnect
// then retry once. Concurrent callers share the boot via _bootInFlight.
async function withBrowser(fn) {
  try {
    return await fn();
  } catch (e) {
    if (!isTransientBrowserCrash(e)) throw e;
    logErr('transient crash detected — recovering:', e.message);
    // Drop the dead handle so ensurePage runs a full re-boot.
    try { if (browserInstance) await browserInstance.close(); } catch (_) {}
    browserInstance = null;
    pageInstance = null;
    await bootContainer();
    return await fn();
  }
}

// Container watchdog: poll CDP every 15 s. If unreachable for 2 consecutive
// polls, kick a recovery boot. Survives labwc/Wayland crashes invisibly to
// the model — by the time the next tool call lands, the container is back.
let _watchdogStarted = false;
function startWatchdog() {
  if (_watchdogStarted) return;
  _watchdogStarted = true;
  let consecutiveFails = 0;
  setInterval(async () => {
    if (shuttingDown || _bootInFlight) return;
    const ok = await isPortOpen(CDP_PORT);
    if (ok) { consecutiveFails = 0; return; }
    consecutiveFails++;
    if (consecutiveFails >= 2) {
      consecutiveFails = 0;
      logErr('watchdog: CDP unreachable for 2 polls — recovering');
      try { await bootContainer(); } catch (e) { logErr('watchdog recovery failed:', e.message); }
    }
  }, 15_000).unref();
}

async function connectPlaywright() {
  if (browserInstance) {
    try { await browserInstance.close(); } catch (_) {}
    browserInstance = null;
    pageInstance = null;
  }
  const { chromium } = require('playwright');
  let lastErr = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      browserInstance = await chromium.connectOverCDP(CDP_URL, { timeout: 5000 });
      lastErr = null;
      break;
    } catch (e) {
      lastErr = e;
      if (attempt < 5) await new Promise((r) => setTimeout(r, 600));
    }
  }
  if (lastErr) throw new Error('CDP connect failed at ' + CDP_URL + ': ' + lastErr.message);

  const contexts = browserInstance.contexts();
  const ctx = contexts.length ? contexts[0] : await browserInstance.newContext();
  const pages = ctx.pages();
  pageInstance = pages.length ? pages[0] : await ctx.newPage();
}

async function ensurePage() {
  if (!browserInstance || !pageInstance) {
    await bootContainer();
  } else {
    // Page might have been closed by the user via the noVNC window —
    // grab a fresh one if so.
    try {
      if (pageInstance.isClosed && pageInstance.isClosed()) {
        const ctx = browserInstance.contexts()[0] || await browserInstance.newContext();
        pageInstance = await ctx.newPage();
      }
    } catch (_) {
      await connectPlaywright();
    }
  }
  return pageInstance;
}

async function teardownBrowser() {
  if (!browserInstance) return;
  try { await browserInstance.close(); } catch (e) { /* ignore */ }
  browserInstance = null;
  pageInstance = null;
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

async function toolSearch(args) {
  if (!args.query || !String(args.query).trim()) throw new Error('query is required');
  const limit = Math.max(1, Math.min(parseInt(args.limit) || 10, 25));
  const engine = args.engine === 'duckduckgo' ? 'duckduckgo' : 'google';
  const p = await ensurePage();
  const url = engine === 'google'
    ? 'https://www.google.com/search?q=' + encodeURIComponent(args.query) + '&hl=en'
    : 'https://html.duckduckgo.com/html/?q=' + encodeURIComponent(args.query);
  await p.goto(url, { waitUntil: 'load', timeout: 30000 });

  let results;
  if (engine === 'google') {
    results = await p.evaluate((max) => {
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
    }, limit);
  } else {
    results = await p.evaluate((max) => {
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
    }, limit);
  }

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
  const p = await ensurePage();
  await p.goto(args.url, {
    waitUntil: args.wait_for || 'load',
    timeout: args.timeout || 30000
  });
  const title = await p.title();
  return { url: p.url(), title, kasmvnc: KASM_URL };
}

async function toolClick(args) {
  const p = await ensurePage();
  if (args.text) {
    await p.click('text=' + args.text);
  } else if (args.selector) {
    await p.click(args.selector);
  } else {
    throw new Error('Provide selector or text');
  }
  return { clicked: args.selector || args.text, current_url: p.url() };
}

async function toolFill(args) {
  const p = await ensurePage();
  await p.fill(args.selector, args.value);
  return { filled: args.selector, value: args.value };
}

async function toolType(args) {
  const p = await ensurePage();
  await p.keyboard.type(args.text, { delay: args.delay || 0 });
  return { typed: args.text };
}

async function toolGetContent(args) {
  const p = await ensurePage();
  if (args.selector) {
    const el = await p.$(args.selector);
    if (!el) throw new Error('Element not found: ' + args.selector);
    return args.format === 'html' ? await el.innerHTML() : await el.innerText();
  }
  if (args.format === 'html') return await p.content();
  return await p.evaluate(() => document.body ? document.body.innerText : '');
}

async function toolScreenshot(args) {
  const p = await ensurePage();
  const fname = 'desktop_screenshot_' + Date.now() + '.png';
  const fpath = path.join(EXCHANGE_DIR, fname);

  if (args.selector) {
    const el = await p.$(args.selector);
    if (!el) throw new Error('Element not found: ' + args.selector);
    await el.screenshot({ path: fpath });
  } else {
    await p.screenshot({ path: fpath, fullPage: args.full_page || false });
  }
  return { filename: fname, path: fpath, size_bytes: fs.statSync(fpath).size };
}

async function toolEvaluate(args) {
  const p = await ensurePage();
  const result = await p.evaluate(args.script);
  return { result };
}

async function toolPdf(args) {
  const p = await ensurePage();
  const fname = args.filename || ('page_' + Date.now() + '.pdf');
  const fpath = path.join(EXCHANGE_DIR, fname);
  await p.pdf({ path: fpath, format: args.format || 'A4' });
  return { filename: fname, path: fpath, size_bytes: fs.statSync(fpath).size };
}

async function toolGetStatus() {
  const cdpReady = await isPortOpen(CDP_PORT);
  const kasmReady = await isPortOpen(KASM_PORT);
  let currentUrl = null;
  try { if (pageInstance && !pageInstance.isClosed?.()) currentUrl = pageInstance.url(); } catch (_) {}
  return {
    container: CONTAINER_NAME,
    cdp_ready: cdpReady,
    kasmvnc_ready: kasmReady,
    kasmvnc_url: KASM_URL,
    cdp_url: CDP_URL,
    browser_connected: browserInstance !== null,
    current_url: currentUrl,
    uptime_seconds: containerStartTime ? Math.floor((Date.now() - containerStartTime) / 1000) : null,
  };
}

async function toolRestart() {
  await teardownBrowser();
  runDockerSync(['compose', '-f', COMPOSE_FILE, 'restart'], { stdio: 'ignore', timeout: 60_000 });
  containerStartTime = Date.now();
  await waitForPort(CDP_PORT, 30_000);
  await connectPlaywright();
  return { restarted: true, ...(await toolGetStatus()) };
}
