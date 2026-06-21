#!/usr/bin/env node
// @ts-check
// ── yha-bridge-stub ──────────────────────────────────────────────────────────
// Tiny MCP stdio server that proxies every JSON-RPC frame to YHA's
// /proxy/mcp-bridge/rpc endpoint. YHA aggregates all of its currently-running
// MCP servers and exposes them as one. Hosts only need to register THIS stub.
//
// Env:
//   YHA_BRIDGE_URL  default https://127.0.0.1:8443
//   YHA_MCP_TOOL_ALIAS_MODE=grok  flatten tool names for clients (notably
//                                 Grok Build) that reserve "__" in qualified
//                                 MCP tool names. The stub maps tools/list
//                                 names like "web__search" -> "web_search"
//                                 and maps tools/call back before proxying.
'use strict';

const URL = require('node:url').URL;

const RAW = process.env.YHA_BRIDGE_URL || 'https://127.0.0.1:8443';
const ENDPOINT = new URL('/proxy/mcp-bridge/rpc', RAW);
const lib = ENDPOINT.protocol === 'https:' ? require('node:https') : require('node:http');

// Shared bridge key. /proxy/mcp-bridge/rpc requires x-bridge-key when YHA runs
// with a shared YHA_BRIDGE_KEY (funnel-exposed deployments). The materialize
// path now injects YHA_BRIDGE_KEY into the MCP server env table for harnesses
// (grok/codex/claude), so the CLI passes it explicitly to the stub. Fallback
// read of bridge/.env is kept for pre-existing configs, manual `grok mcp add`,
// or stripped-env cases. Empty when no shared key (dev) — route skips check.
const BRIDGE_KEY = (() => {
  if (process.env.YHA_BRIDGE_KEY) return process.env.YHA_BRIDGE_KEY;
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    const txt = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = /^\s*YHA_BRIDGE_KEY\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let v = m[1].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      return v;
    }
  } catch (_) {}
  return '';
})();
const DEBUG = process.env.YHA_BRIDGE_DEBUG === '1';
const TOOL_ALIAS_MODE = String(process.env.YHA_MCP_TOOL_ALIAS_MODE || '').toLowerCase();
const ALIAS_TO_REAL = new Map();
const REAL_TO_ALIAS = new Map();
const path = require('node:path');
const os = require('node:os');
const DEBUG_LOG_PATH = path.join(os.tmpdir(), 'yha-bridge-stub.log');
const DEBUG_LOG_MAX_BYTES = 10 * 1024 * 1024; // 10 MB, then rotate once
function dlog(...args) {
  if (!DEBUG) return;
  try {
    const fs = require('node:fs');
    try {
      const st = fs.statSync(DEBUG_LOG_PATH);
      if (st && st.size > DEBUG_LOG_MAX_BYTES) {
        try { fs.renameSync(DEBUG_LOG_PATH, DEBUG_LOG_PATH + '.1'); } catch (_) {}
      }
    } catch (_) { /* file may not exist yet */ }
    fs.appendFileSync(DEBUG_LOG_PATH, `[${new Date().toISOString()}] ${args.join(' ')}\n`);
  } catch (_) {}
}
dlog('boot', 'pid=', process.pid, 'endpoint=', ENDPOINT.href);

let buf = '';

// MCP stdio transport (spec 2024-11-05): one JSON message per line, no embedded newlines.
function writeFrame(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

// One POST to YHA. Resolves to the parsed JSON-RPC frame (or null for a 204
// notification ack). Throws only on a transport-level failure (fetch reject),
// which rpc() retries. An HTTP-status error (e.g. 503 when external sharing is
// off, 401 on a bad bridge key) resolves to a well-formed JSON-RPC error frame
// — the body is {"error":"…"}, NOT a JSON-RPC envelope, and forwarding it raw
// would break the host's handshake / tools list.
async function rpcOnce(envelope) {
  const payload = JSON.stringify(envelope);
  const headers = { 'Content-Type': 'application/json' };
  if (BRIDGE_KEY) headers['x-bridge-key'] = BRIDGE_KEY;
  // Forwarded by spawn-time env so per-session bridge tools (e.g. AskUser)
  // can address the right SSE stream and answer endpoint. Optional; tools
  // that don't need session context still work without it.
  if (process.env.YHA_SESSION_ID) headers['X-Yha-Session-Id'] = process.env.YHA_SESSION_ID;
  const fetchOpts = { method: 'POST', headers, body: payload };
  // Disable TLS verification only for HTTPS endpoints (self-signed localhost cert).
  if (ENDPOINT.protocol === 'https:') fetchOpts.tls = { rejectUnauthorized: false };
  const res = await fetch(ENDPOINT.href, fetchOpts);
  if (res.status === 204) return null; // notification ack
  const text = await res.text();
  if (!res.ok) {
    return {
      jsonrpc: '2.0',
      id: envelope.id,
      error: { code: -32603, message: `YHA bridge HTTP ${res.status}: ${text.slice(0, 200)}` },
    };
  }
  try { return JSON.parse(text); }
  catch (_) {
    return {
      jsonrpc: '2.0',
      id: envelope.id,
      error: { code: -32603, message: `Bad YHA response: ${text.slice(0, 200)}` },
    };
  }
}

// Retry only transport failures — the backend is still booting / momentarily
// unreachable at session start. HTTP-status errors are already shaped above and
// returned as-is (no point retrying a 503/401). Happy path takes the first try
// with zero added latency.
async function rpc(envelope) {
  const ATTEMPTS = 4;
  let lastErr;
  for (let i = 0; i < ATTEMPTS; i++) {
    try {
      return await rpcOnce(envelope);
    } catch (e) {
      lastErr = e;
      if (i < ATTEMPTS - 1) await new Promise((r) => setTimeout(r, 250 * (i + 1)));
    }
  }
  return {
    jsonrpc: '2.0',
    id: envelope.id,
    error: { code: -32603, message: `YHA bridge unreachable: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}` },
  };
}

function shouldAliasTools() {
  return TOOL_ALIAS_MODE === 'grok' || TOOL_ALIAS_MODE === 'flat';
}

function aliasToolName(realName) {
  const raw = String(realName || '').trim();
  if (!raw || !shouldAliasTools()) return raw;
  if (REAL_TO_ALIAS.has(raw)) return REAL_TO_ALIAS.get(raw);

  // Grok Build reserves "__" as the server/tool delimiter in its internal
  // qualified name. YHA's aggregator intentionally exposes provider-scoped
  // names like "chat-history__session_search", so flatten just the delimiter
  // to a single underscore for Grok-facing discovery. Keep the map in-process
  // so tools/call can recover the original name exactly.
  let alias = raw.replace(/__+/g, '_');
  if (!alias) alias = raw;
  let candidate = alias;
  let n = 2;
  while (ALIAS_TO_REAL.has(candidate) && ALIAS_TO_REAL.get(candidate) !== raw) {
    candidate = `${alias}_${n++}`;
  }
  alias = candidate;
  ALIAS_TO_REAL.set(alias, raw);
  REAL_TO_ALIAS.set(raw, alias);
  return alias;
}

function realToolName(alias) {
  const name = String(alias || '');
  if (!shouldAliasTools()) return name;
  if (ALIAS_TO_REAL.has(name)) return ALIAS_TO_REAL.get(name);
  // Fallback for clients that call without a prior tools/list in this stub
  // process. Only use when unambiguous enough for YHA's common namespace style.
  return name;
}

function rewriteOutboundForAlias(resp) {
  if (!shouldAliasTools() || !resp || typeof resp !== 'object') return resp;
  const tools = resp?.result?.tools;
  if (!Array.isArray(tools)) return resp;
  const next = { ...resp, result: { ...resp.result, tools: tools.map((tool) => {
    if (!tool || typeof tool !== 'object' || typeof tool.name !== 'string') return tool;
    return {
      ...tool,
      name: aliasToolName(tool.name),
      description: tool.description
        ? `${tool.description}\n\n(YHA real tool: ${tool.name})`
        : `(YHA real tool: ${tool.name})`,
    };
  }) } };
  return next;
}

function rewriteInboundForAlias(msg) {
  if (!shouldAliasTools() || !msg || typeof msg !== 'object') return msg;
  if (msg.method !== 'tools/call') return msg;
  const name = msg?.params?.name;
  if (typeof name !== 'string') return msg;
  const real = realToolName(name);
  if (real === name) return msg;
  return { ...msg, params: { ...msg.params, name: real } };
}

// Answer the MCP handshake locally so the stub completes its connection with
// the host even while the YHA backend is still booting at session start.
// Without this, a transport error or 503 on `initialize` yields no valid result
// and the host leaves MCP-Tools stuck "connecting" for the whole session.
// Mirrors what /proxy/mcp-bridge/rpc returns for these methods.
function localResult(method) {
  switch (method) {
    case 'initialize':
      return {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {}, prompts: {}, resources: {} },
        serverInfo: { name: 'MCP-Tools', version: '1.0' },
      };
    case 'ping':
      return {};
    default:
      return undefined;
  }
}

async function handle(msg) {
  if (DEBUG) dlog('IN', JSON.stringify(msg).slice(0, 500));
  const isNotification = msg.id === undefined || msg.id === null;

  // Lifecycle notifications need no upstream round-trip.
  if (msg.method === 'notifications/initialized' || msg.method === 'notifications/cancelled') return;

  const local = localResult(msg.method);
  if (local !== undefined) {
    if (isNotification) return;
    if (DEBUG) dlog('OUT(local)', msg.method);
    writeFrame({ jsonrpc: '2.0', id: msg.id, result: local });
    return;
  }

  const upstreamMsg = rewriteInboundForAlias(msg);
  const resp = rewriteOutboundForAlias(await rpc(upstreamMsg));
  if (isNotification || !resp) return;
  if (DEBUG) dlog('OUT', JSON.stringify(resp).slice(0, 300));
  writeFrame(resp);
}

process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, nl).replace(/\r$/, '');
    buf = buf.slice(nl + 1);
    if (!line.trim()) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch (_) { dlog('parse-error', line.slice(0, 200)); continue; }
    handle(parsed).catch((e) => {
      if (parsed?.id !== undefined && parsed?.id !== null) {
        writeFrame({
          jsonrpc: '2.0',
          id: parsed.id,
          error: { code: -32603, message: e instanceof Error ? e.message : String(e) },
        });
      }
    });
  }
});

process.stdin.on('end', () => process.exit(0));
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
