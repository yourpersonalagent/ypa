#!/usr/bin/env node
// @ts-check
// Stdio MCP server "agent-multichat" — exposes 5 tools for reading/writing
// multichat group state. Read/write goes through the bridge HTTP layer
// (/proxy/multichat-agents/*) so the bridge stays the single writer.
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
        serverInfo: { name: 'agent-multichat', version: '1.0.0' },
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
            name: 'peers',
            description:
              'List all active multichat group peers. Returns group metadata, slot list with status and last-message digest. Use to understand what sibling agents are currently doing.',
            inputSchema: {
              type: 'object',
              properties: {
                groupId: { type: 'string', description: 'Group ID. Omit to list all groups.' },
              },
            },
          },
          {
            name: 'peer_status',
            description: 'Get the current phase and slot status for a specific multichat group.',
            inputSchema: {
              type: 'object',
              properties: {
                groupId: { type: 'string' },
              },
              required: ['groupId'],
            },
          },
          {
            name: 'peer_last',
            description:
              'Get the last message digest from a specific agent slot. Returns a scrubbed summary (no file paths, no long tokens).',
            inputSchema: {
              type: 'object',
              properties: {
                groupId: { type: 'string' },
                slotIdx: { type: 'integer', minimum: 0 },
              },
              required: ['groupId', 'slotIdx'],
            },
          },
          {
            name: 'my_slot',
            description:
              'Identify which slot this agent occupies in a multichat group. Pass the current session ID.',
            inputSchema: {
              type: 'object',
              properties: {
                groupId: { type: 'string' },
                sessionId: { type: 'string' },
              },
              required: ['groupId', 'sessionId'],
            },
          },
          {
            name: 'emit_plan',
            description:
              "Submit a plan during the plan phase of a multichat turn. Only callable when the group phase is 'plan'. Calling twice overwrites the previous plan (last-write-wins).",
            inputSchema: {
              type: 'object',
              properties: {
                groupId: { type: 'string' },
                slotIdx: { type: 'integer', minimum: 0 },
                plan: {
                  type: 'string',
                  description: 'Your plan text. 2-5 sentences describing what you intend to do.',
                },
              },
              required: ['groupId', 'slotIdx', 'plan'],
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
    let text;

    if (name === 'peers') {
      if (args.groupId) {
        const result = await bridgeFetch('GET', `/proxy/multichat-agents/groups/${args.groupId}`);
        text = JSON.stringify(result, null, 2);
      } else {
        const result = await bridgeFetch('GET', '/proxy/multichat-agents/groups');
        text = JSON.stringify(result, null, 2);
      }

    } else if (name === 'peer_status') {
      const result = await bridgeFetch('GET', `/proxy/multichat-agents/groups/${args.groupId}`);
      const slots = (result.slots || []).map(s => `Slot ${s.idx} (${s.id}): ${s.status}`).join('\n');
      text = `Group ${args.groupId} — phase: ${result.phase}, turn: ${result.currentTurn}, mode: ${result.mode}\n${slots}`;

    } else if (name === 'peer_last') {
      const result = await bridgeFetch('GET', `/proxy/multichat-agents/groups/${args.groupId}`);
      const slot = (result.slots || []).find(s => s.idx === args.slotIdx);
      if (!slot) throw new Error(`Slot ${args.slotIdx} not found in group ${args.groupId}`);
      text = slot.lastDigest != null ? String(slot.lastDigest) : '(no digest yet)';

    } else if (name === 'my_slot') {
      const result = await bridgeFetch('GET', `/proxy/multichat-agents/groups/${args.groupId}`);
      const slot = (result.slots || []).find(s => s.sessionId === args.sessionId);
      if (!slot) throw new Error(`Session ${args.sessionId} not found in group ${args.groupId}`);
      text = JSON.stringify({ idx: slot.idx, id: slot.id, mode: result.mode, phase: result.phase }, null, 2);

    } else if (name === 'emit_plan') {
      await bridgeFetch('POST', `/proxy/multichat-agents/groups/${args.groupId}/emit-plan`, {
        slotIdx: args.slotIdx,
        plan: args.plan,
      });
      text = `Plan submitted for slot ${args.slotIdx}.`;

    } else {
      sendMessage({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown tool: ' + name } });
      return;
    }

    sendMessage({
      jsonrpc: '2.0', id,
      result: { content: [{ type: 'text', text }] },
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
