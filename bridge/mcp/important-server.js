#!/usr/bin/env node
// @ts-check
// Stdio MCP server "important" — exposes a tiny shared notepad of 5–7 short
// keyword-style lines visible to every model and to the user. Read/write goes
// through the bridge HTTP layer (/proxy/important/*) so the bridge stays the
// single writer and can broadcast SSE updates to the UI.
'use strict';

const { StringDecoder } = require('string_decoder');
const fs = require('fs');
const path = require('path');

// Load bridge/.env for any vars the bridge process knew about; BRIDGE_INTERNAL_KEY
// and PORT are already inherited via process.env from the parent.
{
  const envPath = path.join(__dirname, '..', '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      const val = t.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
      if (key && !(key in process.env)) process.env[key] = val;
    }
  }
}

const BRIDGE_PORT = parseInt(process.env.PORT || '8443', 10);
const USE_HTTP = process.env.USE_HTTP === 'true';
const BRIDGE_BASE = `${USE_HTTP ? 'http' : 'https'}://127.0.0.1:${BRIDGE_PORT}`;
const BRIDGE_KEY = process.env.BRIDGE_INTERNAL_KEY || '';

// Allow self-signed bridge certs when running over https
if (!USE_HTTP) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

async function bridgeFetch(method, urlPath, body) {
  const url = BRIDGE_BASE + urlPath;
  const init = {
    method,
    headers: { 'Authorization': `Bearer ${BRIDGE_KEY}` },
  };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { success: false, error: text.slice(0, 200) }; }
  if (!res.ok || json.success === false) {
    throw new Error(json.error || `HTTP ${res.status}`);
  }
  return json;
}

function formatState(state) {
  const lines = state.lines || [];
  const maxLines = state.maxLines || 7;
  if (!lines.length) {
    return `(empty — no important notes yet. Add one with important_add.)\n\nMax ${maxLines} lines.`;
  }
  const numbered = lines.map((l, i) => `${i + 1}. ${l}`).join('\n');
  return `${numbered}\n\n(${lines.length} / ${maxLines} lines)`;
}

// ── MCP stdio transport ──────────────────────────────────────────────────────
const _stdinDecoder = new StringDecoder('utf8');
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
        serverInfo: { name: 'important', version: '1.0.0' },
      },
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
            name: 'important_read',
            description:
              'Read the shared "Important" notepad — a tiny memory of up to 7 short keyword-style lines visible to every agent and the user. Use this to recall facts/thoughts left by yourself, other agents, or the user. The same content is auto-injected into every system prompt, so you usually already see it; call this only to confirm or refresh.',
            inputSchema: { type: 'object', properties: {} },
          },
          {
            name: 'important_set',
            description:
              'Replace the entire "Important" notepad with a new list (up to 7 short keyword-style entries). Use sparingly — prefer important_add / important_remove for incremental updates so other agents and the user can see the diff.',
            inputSchema: {
              type: 'object',
              properties: {
                lines: {
                  type: 'array',
                  items: { type: 'string' },
                  maxItems: 7,
                  description: 'New full list of lines, max 7. Each line up to ~200 chars; keep them short, keyword-style.',
                },
              },
              required: ['lines'],
            },
          },
          {
            name: 'important_add',
            description:
              'Append a single short, keyword-style line to the shared "Important" notepad. If already at 7 lines, the oldest line is evicted. Use for facts/thoughts worth keeping across the session and across agents.',
            inputSchema: {
              type: 'object',
              properties: {
                text: { type: 'string', description: 'A short keyword-style note. ~200 chars max; one line.' },
              },
              required: ['text'],
            },
          },
          {
            name: 'important_remove',
            description:
              'Remove a line from the shared "Important" notepad — by 1-based index or by exact text match.',
            inputSchema: {
              type: 'object',
              properties: {
                index: { type: 'integer', minimum: 1, maximum: 7, description: '1-based index of the line to remove' },
                text: { type: 'string', description: 'Exact text of the line to remove' },
              },
            },
          },
        ],
      },
    });
  } else if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params;
    handleToolCall(msg.id, name, args || {});
  } else if (msg.id !== undefined) {
    sendMessage({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
  }
}

async function handleToolCall(id, name, args) {
  try {
    let state;
    if (name === 'important_read') {
      state = await bridgeFetch('GET', '/proxy/important');
    } else if (name === 'important_set') {
      state = await bridgeFetch('POST', '/proxy/important/set', { lines: Array.isArray(args.lines) ? args.lines : [] });
    } else if (name === 'important_add') {
      state = await bridgeFetch('POST', '/proxy/important/add', { text: String(args.text || '') });
    } else if (name === 'important_remove') {
      const body = {};
      if (typeof args.index === 'number') body.index = args.index;
      if (typeof args.text === 'string') body.text = args.text;
      state = await bridgeFetch('POST', '/proxy/important/remove', body);
    } else {
      sendMessage({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown tool: ' + name } });
      return;
    }
    sendMessage({
      jsonrpc: '2.0', id,
      result: { content: [{ type: 'text', text: formatState(state) }] },
    });
  } catch (e) {
    sendMessage({
      jsonrpc: '2.0', id,
      result: {
        content: [{ type: 'text', text: 'Error: ' + (e instanceof Error ? e.message : String(e)) }],
        isError: true,
      },
    });
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
    try { handleMessage(JSON.parse(body)); } catch (_) { /* ignore parse errors */ }
  }
});

process.stdin.on('end', () => { inputBuffer += _stdinDecoder.end(); process.exit(0); });
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT',  () => process.exit(0));
require('./_parent-watchdog').installParentWatchdog();
