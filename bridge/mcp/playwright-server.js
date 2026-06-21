#!/usr/bin/env node
// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const { StringDecoder } = require('string_decoder');
const _stdinDecoder = new StringDecoder('utf8');

// ── MCP stdio transport ──────────────────────────────────────────────────────

let inputBuffer = '';

function sendMessage(msg) {
  const json = JSON.stringify(msg);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(json, 'utf8') + '\r\n\r\n' + json);
}

function handleMessage(msg) {
  if (msg.method === 'initialize') {
    sendMessage({
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'playwright-mcp', version: '2.0.0' }
      }
    });
  } else if (msg.method === 'initialized' || msg.method === 'notifications/initialized') {
    // notification — no response
  } else if (msg.method === 'ping') {
    sendMessage({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else if (msg.method === 'tools/list') {
    sendMessage({
      jsonrpc: '2.0', id: msg.id,
      result: {
        tools: [
          {
            name: 'search',
            description: 'Search the web and return the top results with titles, URLs, and snippets. Use this for ANY current information need: news, facts, people, places, products, latest events, "what is X", "who is Y", "how to Z" — anything you would google. Drives a real Chrome (Google by default, DuckDuckGo fallback) so you see live results without bot-detection or stripped HTML. Prefer this over generic web-search tools when you need authoritative, current data.',
            inputSchema: {
              type: 'object',
              properties: {
                query: { type: 'string', description: 'Search query — natural language, like you would type into Google.' },
                limit: { type: 'number', description: 'Max number of results to return (default 10).' },
                engine: { type: 'string', enum: ['google', 'duckduckgo'], description: 'Search engine. Default google. Switch to duckduckgo if google rate-limits.' }
              },
              required: ['query']
            }
          },
          {
            name: 'browse',
            description: 'Browse any URL — load the page in a real authenticated Chrome and return title, text, and links. Use for: reading articles, checking websites, viewing social media (Twitter/X, Reddit, YouTube comments), accessing logged-in sites, checking dashboards, following up on search hits. Sees fully JS-rendered live content with your real cookies and login sessions — beats generic web-fetch tools that only see static HTML.',
            inputSchema: {
              type: 'object',
              properties: {
                url: { type: 'string', description: 'URL to load.' },
                wait_for: { type: 'string', description: 'Wait condition: load (default), domcontentloaded, networkidle.' },
                screenshot: { type: 'boolean', description: 'Also save a screenshot after loading.' },
                timeout: { type: 'number', description: 'Navigation timeout in ms (default 30000).' }
              },
              required: ['url']
            }
          },
          {
            name: 'get_content',
            description: 'Read the text or HTML of the currently loaded page (or a specific element by CSS selector). Use after browse/search to extract the full body, an article, a sidebar, or any element.',
            inputSchema: {
              type: 'object',
              properties: {
                selector: { type: 'string', description: 'CSS selector — omit for full page body.' },
                format: { type: 'string', enum: ['text', 'html'], description: 'Output format (default text).' }
              }
            }
          },
          {
            name: 'screenshot',
            description: 'Capture a visual screenshot of the current page (full page or just one element) and save it to disk. Returns only the file path/metadata — the model does NOT see the image. Use when you only need to persist the screenshot for the user. If you need to actually look at the page, use screenshot_view instead.',
            inputSchema: {
              type: 'object',
              properties: {
                full_page: { type: 'boolean', description: 'Capture full scrollable page (default false).' },
                selector: { type: 'string', description: 'Screenshot only this element (CSS selector).' }
              }
            }
          },
          {
            name: 'screenshot_view',
            description: 'Capture a screenshot AND return it inline so the model can actually see the page. Use this whenever you need to visually inspect what the browser is showing (debug a layout, read a chart, dismiss a popup you cannot describe by selector, verify a navigation result). ANTHROPIC/CLAUDE MODELS ONLY — other providers (OpenAI, Gemini) will receive the raw base64 as text and waste tokens without being able to see it.',
            inputSchema: {
              type: 'object',
              properties: {
                full_page: { type: 'boolean', description: 'Capture full scrollable page (default false).' },
                selector: { type: 'string', description: 'Screenshot only this element (CSS selector).' }
              }
            }
          },
          {
            name: 'click',
            description: 'Click an element on the current page (by CSS selector or visible text). Use to navigate links, submit forms, expand "show more" buttons, dismiss popups, switch tabs.',
            inputSchema: {
              type: 'object',
              properties: {
                selector: { type: 'string', description: 'CSS selector of the element.' },
                text: { type: 'string', description: 'Visible text of the element (alternative to selector).' }
              }
            }
          },
          {
            name: 'fill',
            description: 'Fill a form field on the current page (input, textarea, search box). Use for login fields, search bars, message composers, comment inputs.',
            inputSchema: {
              type: 'object',
              properties: {
                selector: { type: 'string', description: 'CSS selector of the input/textarea.' },
                value: { type: 'string', description: 'Value to enter.' }
              },
              required: ['selector', 'value']
            }
          },
          {
            name: 'evaluate',
            description: 'Run arbitrary JavaScript in the current page context and return the result. Use for advanced scraping, structured data extraction, DOM walks, reading hidden state, or anything the simpler tools cannot do.',
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
            description: 'Save the current page as a PDF file to the exchange folder. Use when the user wants a printable/archivable copy of a page.',
            inputSchema: {
              type: 'object',
              properties: {
                filename: { type: 'string', description: 'Output filename (default page_<timestamp>.pdf).' },
                format: { type: 'string', description: 'Paper format: A4 (default), Letter, A3, etc.' }
              }
            }
          },
          {
            name: 'get_status',
            description: 'Get current browser state: active mode (real/stealth/normal), whether a page is loaded, current URL, configured CDP endpoint, fallback info.',
            inputSchema: { type: 'object', properties: {}, required: [] }
          },
          {
            name: 'close_browser',
            description: 'Close (or disconnect, in real mode) the browser instance and free resources.',
            inputSchema: { type: 'object', properties: {}, required: [] }
          }
        ]
      }
    });
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
    try { handleMessage(JSON.parse(body)); } catch (e) { /* ignore */ }
  }
});

process.stdin.on('end', () => shutdownAndExit());
process.on('SIGTERM', () => shutdownAndExit());
process.on('SIGINT', () => shutdownAndExit());
require('./_parent-watchdog').installParentWatchdog(shutdownAndExit);

async function shutdownAndExit() {
  await teardownBrowser();
  process.exit(0);
}

// ── Browser state ────────────────────────────────────────────────────────────

const EXCHANGE_DIR = path.join(__dirname, 'exchange');
if (!fs.existsSync(EXCHANGE_DIR)) fs.mkdirSync(EXCHANGE_DIR, { recursive: true });

let browserInstance = null;
let pageInstance = null;
let fallbackReason = null;

function getInitialMode() {
  let configured = '';
  let cdpUrl = '';
  try {
    const prefsPath = path.join(__dirname, '..', 'prefs.json');
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    configured = String(prefs?.defaults?.playwright_default_mode || '').trim();
    cdpUrl = String(prefs?.defaults?.playwright_real_url || '').trim();
  } catch (e) { /* fall through */ }

  // Explicit force
  if (configured === 'normal' || configured === 'stealth' || configured === 'real') return configured;
  // 'auto' (or unset): prefer real if a CDP URL is configured, else stealth
  const envUrl = (process.env.YHA_WINDOWS_CHROME_URL || '').trim();
  if (envUrl || cdpUrl) return 'real';
  return 'stealth';
}

let currentMode = getInitialMode();

function getCdpUrl() {
  const envUrl = (process.env.YHA_WINDOWS_CHROME_URL || '').trim();
  if (envUrl) return envUrl;
  try {
    const prefsPath = path.join(__dirname, '..', 'prefs.json');
    const prefs = JSON.parse(fs.readFileSync(prefsPath, 'utf8'));
    return String(prefs?.defaults?.playwright_real_url || '').trim();
  } catch (e) {
    return '';
  }
}

// browser.close() does the right thing in both modes:
// - launch():          terminates the spawned Chromium process
// - connectOverCDP():  only disconnects the WebSocket; the remote Chrome keeps running
async function teardownBrowser() {
  if (!browserInstance) return;
  try { await browserInstance.close(); } catch (e) { /* ignore */ }
  browserInstance = null;
  pageInstance = null;
}

async function launchBrowser(mode) {
  if (browserInstance) {
    if (currentMode === mode) return; // already running in right mode
    await teardownBrowser();
  }

  currentMode = mode;

  if (mode === 'real') {
    const cdpUrl = getCdpUrl();
    if (!cdpUrl) {
      fallbackReason = 'No CDP URL configured (defaults.playwright_real_url) — falling back to stealth.';
      currentMode = 'stealth';
      return launchBrowser('stealth');
    }
    const { chromium: chromiumCdp } = require('playwright');
    // Real Chrome over CDP is mostly fine, but the connection occasionally
    // drops mid-handshake (Windows side waking up, transient network blip).
    // Default playwright timeout is 30s with no retry — one bad attempt would
    // burn a full toolcall. Three short attempts (5s each, 400ms in between)
    // total ≤ ~16s in the worst case, faster than a single 30s hang AND
    // resilient to transient failures.
    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        browserInstance = await chromiumCdp.connectOverCDP(cdpUrl, { timeout: 5000 });
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (attempt < 3) await new Promise((r) => setTimeout(r, 400));
      }
    }
    if (lastErr) {
      fallbackReason = 'Real Chrome unreachable at ' + cdpUrl + ' (' + lastErr.message + ', after 3 attempts) — falling back to stealth. Start the YHA Browser shortcut on Windows to use real mode.';
      currentMode = 'stealth';
      return launchBrowser('stealth');
    }
    fallbackReason = null;
    const contexts = browserInstance.contexts();
    const ctx = contexts.length ? contexts[0] : await browserInstance.newContext();
    const pages = ctx.pages();
    pageInstance = pages.length ? pages[0] : await ctx.newPage();
    return;
  }

  if (mode === 'stealth') {
    let launched = false;
    // 1) rebrowser-playwright — closes the Runtime.Enable CDP leak that defeats stealth-plugin
    try {
      const { chromium: chromiumRebrowser } = require('rebrowser-playwright');
      browserInstance = await chromiumRebrowser.launch({ headless: true });
      launched = true;
    } catch (e) { /* fall through to playwright-extra */ }

    // 2) playwright-extra + stealth plugin
    if (!launched) {
      try {
        const { chromium: chromiumExtra } = require('playwright-extra');
        const StealthPlugin = require('puppeteer-extra-plugin-stealth');
        chromiumExtra.use(StealthPlugin());
        browserInstance = await chromiumExtra.launch({ headless: true });
        launched = true;
      } catch (e) { /* fall through to manual stealth */ }
    }

    // 3) Last resort: vanilla playwright with manual flags
    if (!launched) {
      const { chromium: chromiumVanilla } = require('playwright');
      browserInstance = await chromiumVanilla.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
          '--disable-web-security',
          '--disable-features=IsolateOrigins,site-per-process'
        ]
      });
    }

    const ctx = await browserInstance.newContext({
      viewport: { width: 1280, height: 800 },
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      locale: 'en-US'
    });
    // Manual fingerprint patches on top — applied regardless of which engine launched
    await ctx.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      Object.defineProperty(navigator, 'languages', { get: () => ['en-US', 'en'] });
      window.chrome = { runtime: {} };
    });
    pageInstance = await ctx.newPage();
    return;
  }

  // 'normal'
  const { chromium: chromiumNormal } = require('playwright');
  browserInstance = await chromiumNormal.launch({ headless: true });
  const ctx = await browserInstance.newContext({ viewport: { width: 1280, height: 800 } });
  pageInstance = await ctx.newPage();
}

async function ensurePage() {
  if (!browserInstance || !pageInstance) {
    await launchBrowser(currentMode);
  }
  return pageInstance;
}

// ── Tool dispatch ────────────────────────────────────────────────────────────

function handleToolCall(id, name, args) {
  (async () => {
    try {
      let result;
      if (name === 'search') result = await toolSearch(args);
      else if (name === 'browse') result = await toolBrowse(args);
      else if (name === 'get_content') result = await toolGetContent(args);
      else if (name === 'screenshot') result = await toolScreenshot(args);
      else if (name === 'screenshot_view') {
        const meta = await toolScreenshot(args);
        const buf = fs.readFileSync(meta.path);
        sendMessage({
          jsonrpc: '2.0', id,
          result: { content: [
            { type: 'text', text: JSON.stringify(meta, null, 2) },
            { type: 'image', data: buf.toString('base64'), mimeType: 'image/png' }
          ]}
        });
        return;
      }
      else if (name === 'click') result = await toolClick(args);
      else if (name === 'fill') result = await toolFill(args);
      else if (name === 'evaluate') result = await toolEvaluate(args);
      else if (name === 'pdf') result = await toolPdf(args);
      else if (name === 'get_status') result = toolGetStatus();
      else if (name === 'close_browser') result = await toolCloseBrowser();
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

async function toolSetMode(args) {
  const prev = currentMode;
  await launchBrowser(args.mode);
  return {
    mode: args.mode,
    changed: prev !== args.mode,
    message: 'Browser is now in ' + args.mode + ' mode.'
  };
}

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
          snippet: sn ? (sn.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 280) : ''
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
      : undefined
  };
}

async function toolBrowse(args) {
  const p = await ensurePage();
  await p.goto(args.url, {
    waitUntil: args.wait_for || 'load',
    timeout: args.timeout || 30000
  });
  const title = await p.title();
  const url = p.url();
  const text = await p.evaluate(() => {
    const body = document.body;
    return body ? body.innerText.slice(0, 8000) : '';
  });
  const links = await p.evaluate(() =>
    Array.from(document.querySelectorAll('a[href]'))
      .slice(0, 30)
      .map(a => ({ text: (a.innerText || '').trim().slice(0, 120), href: a.href }))
      .filter(l => l.href && l.href.startsWith('http'))
  );

  const result = { title, url, text_content: text, links };

  if (args.screenshot) {
    const fname = 'browse_' + Date.now() + '.png';
    await p.screenshot({ path: path.join(EXCHANGE_DIR, fname) });
    result.screenshot = fname;
  }

  return result;
}

async function toolScreenshot(args) {
  const p = await ensurePage();
  const fname = 'screenshot_' + Date.now() + '.png';
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

function toolGetStatus() {
  const status = {
    mode: currentMode,
    browser_open: browserInstance !== null,
    current_url: pageInstance ? pageInstance.url() : null,
    cdp_url_configured: getCdpUrl() || null
  };
  if (fallbackReason) status.auto_fallback = fallbackReason;
  return status;
}

async function toolCloseBrowser() {
  const wasReal = currentMode === 'real';
  await teardownBrowser();
  return {
    message: wasReal
      ? 'Disconnected from real Chrome. Browser on Windows keeps running.'
      : 'Browser closed.'
  };
}
