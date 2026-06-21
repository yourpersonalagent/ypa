#!/usr/bin/env node
// @ts-check
// Stdio MCP server "pet-vision" — exposes a single `pet_observe` tool that
// returns a natural-language description of the floating pet's current
// surroundings (nearest button/input/panel, top visible buttons by
// importance, focused element, active UI region).
//
// The bridge holds the snapshot in-memory under bridge/modules/pet/lib/vision.ts,
// populated by the FE's usePetWorldModel hook whenever the pet has come
// to rest. This MCP child is a thin read-through that calls
//   GET /proxy/pet-vision/snapshot?prose=1
// and returns the bridge's pre-formatted English.
//
// Why a dedicated server and not a tool on meta-bridge:
//   • cleanly disable-able from the registry without touching meta-bridge
//   • surfaces in the MCP-Tools aggregator under its own name so tool
//     listings don't grow noisy
//   • near-zero memory footprint — just a stdio loop forwarding one HTTP
//     request per call.
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

if (!USE_HTTP) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

async function bridgeFetch(method, urlPath) {
  const url = BRIDGE_BASE + urlPath;
  const res = await fetch(url, {
    method,
    headers: { 'Authorization': `Bearer ${BRIDGE_KEY}` },
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { ok: false, error: text.slice(0, 200) }; }
  return { status: res.status, json };
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
        serverInfo: { name: 'pet-vision', version: '1.0.0' },
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
            name: 'pet_observe',
            description:
              'Describe the YHA floating pet\'s current surroundings in the user interface — where it sits, the nearest interactive elements (button, input, panel), which buttons are most visually prominent, which element has keyboard focus, and which UI region the pet is currently over (chat, chat-input, command-palette, header, panel, free). ' +
              'Returns a multi-line natural-language summary. Useful when the user asks "what is the pet looking at?" or when an agent wants to ground its next suggestion in the user\'s on-screen context. ' +
              'The snapshot is captured ~2 seconds after the pet stops moving and is invalidated when the pet is hidden or behind UI — call this only when the pet is visible.',
            inputSchema: {
              type: 'object',
              properties: {
                raw: {
                  type: 'boolean',
                  description: 'When true, also return the raw JSON snapshot under a "raw" field so the model can drive precise pixel decisions instead of just reading prose. Defaults to false.',
                },
              },
            },
          },
          {
            name: 'pet_commands',
            description:
              'List the YHA application\'s available commands — the canonical catalog of user-interface actions, settings toggles, view switches, color themes, layout presets, panel actions, harness controls and module-contributed commands that the user can reach through the `/` palette (Ctrl+P / Cmd+P). ' +
              'Each entry has an id, a human label, a group (layout, color-theme, design, view, model, session, cwd, prefs, panel, header, workflow, harness, chat, or module:<name>), optional keywords for fuzzy match, and current state (active toggle, current value) when applicable. ' +
              'Default behavior (no arguments) returns a high-level overview: which groups exist and how many commands each contains — call again with `group: "<name>"` to expand a single category instead of overloading the response with all ~150 entries at once. ' +
              'Use this to discover what the user can do (settings, views, themes), to find the exact command id before recommending an action, or to inspect the current state of a setting (`active: true`, `value: "horizontal"`).',
            inputSchema: {
              type: 'object',
              properties: {
                group: {
                  type: 'string',
                  description: 'Filter by group name (e.g. "view", "color-theme", "layout", "prefs", "module:pet"). When omitted and no query is set, returns a high-level group overview instead of the full catalog so a default call stays small.',
                },
                query: {
                  type: 'string',
                  description: 'Case-insensitive substring filter across id / label / keywords. Combines with `group` (filters within that group) or stands alone (searches all groups). Use this to find a specific command like `query: "theme"` or `query: "header"`.',
                },
                raw: {
                  type: 'boolean',
                  description: 'When true, also return the raw JSON catalog under a "raw" field. Lets the agent reason over the structured shape (id, group, keywords, state) instead of parsing prose. Defaults to false.',
                },
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
    if (name === 'pet_observe') {
      await handlePetObserve(id, args);
      return;
    }
    if (name === 'pet_commands') {
      await handlePetCommands(id, args);
      return;
    }
    sendMessage({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown tool: ' + name } });
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

async function handlePetObserve(id, args) {
  const wantRaw = args && args.raw === true;
  // Always fetch the prose form; raw=1 path also retrieves the full object.
  const { status, json } = await bridgeFetch('GET', '/proxy/pet-vision/snapshot?prose=1');
  if (status === 404) {
    sendMessage({
      jsonrpc: '2.0', id,
      result: {
        content: [{
          type: 'text',
          text: 'No pet-vision snapshot is available right now. The pet may be hidden, behind-UI, or has not come to rest since the bridge started. Ask the user to make the pet visible and try again.',
        }],
      },
    });
    return;
  }
  if (status !== 200 || !json.ok) {
    throw new Error(json.error || `HTTP ${status}`);
  }
  let text = json.prose || '(empty snapshot)';
  if (wantRaw) {
    const { status: rawStatus, json: rawJson } = await bridgeFetch('GET', '/proxy/pet-vision/snapshot');
    if (rawStatus === 200 && rawJson.ok && rawJson.snapshot) {
      text += '\n\n--- raw snapshot ---\n' + JSON.stringify(rawJson.snapshot, null, 2);
    }
  }
  sendMessage({
    jsonrpc: '2.0', id,
    result: { content: [{ type: 'text', text }] },
  });
}

async function handlePetCommands(id, args) {
  const wantRaw = !!(args && args.raw === true);
  const group = args && typeof args.group === 'string' ? args.group.trim() : '';
  const query = args && typeof args.query === 'string' ? args.query.trim() : '';
  const params = new URLSearchParams({ prose: '1' });
  if (group) params.set('group', group);
  if (query) params.set('query', query);
  const { status, json } = await bridgeFetch('GET', '/proxy/pet-vision/catalog?' + params.toString());
  if (status === 404) {
    sendMessage({
      jsonrpc: '2.0', id,
      result: {
        content: [{
          type: 'text',
          text: 'No command catalog has been pushed yet. The YHA frontend either has not connected or is still booting. Ask the user to reload the UI and try again.',
        }],
      },
    });
    return;
  }
  if (status !== 200 || !json.ok) {
    throw new Error(json.error || `HTTP ${status}`);
  }
  let text = json.prose || '(empty catalog)';
  if (wantRaw) {
    const { status: rawStatus, json: rawJson } = await bridgeFetch('GET', '/proxy/pet-vision/catalog');
    if (rawStatus === 200 && rawJson.ok && Array.isArray(rawJson.commands)) {
      // Apply the same filters on the raw payload so `raw` matches `prose`.
      const filtered = rawJson.commands.filter((c) => {
        if (group && c.group !== group) return false;
        if (!query) return true;
        const q = query.toLowerCase();
        if (String(c.id || '').toLowerCase().includes(q)) return true;
        if (String(c.label || '').toLowerCase().includes(q)) return true;
        if (Array.isArray(c.keywords) && c.keywords.some((k) => String(k).toLowerCase().includes(q))) return true;
        return false;
      });
      text += '\n\n--- raw catalog (' + filtered.length + ' entries) ---\n' + JSON.stringify(filtered, null, 2);
    }
  }
  sendMessage({
    jsonrpc: '2.0', id,
    result: { content: [{ type: 'text', text }] },
  });
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
