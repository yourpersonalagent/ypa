#!/usr/bin/env node
// @ts-check
// Stdio MCP server "chat-history" — exposes the bridge's session/message
// store (bridge/data/sessions.db, written by the new bun:sqlite session
// layer) to partner agents (Claude Code, Codex, etc.) as three tools:
//
//   session_get(id)               → full session metadata + ordered messages
//   session_search(query, ...)    → SQLite LIKE search + optional RAG
//                                   (rag_search sourceKind:'session') merged
//                                   into one ranked, source-tagged result set
//   session_sql(query, params)    → read-only raw SQL for power queries
//
// SQL access is direct via bun:sqlite in readonly mode — WAL on the writer
// side means concurrent reads are safe and we don't go through the bridge
// HTTP layer. RAG access still proxies through the bridge so the vector
// store stays single-writer (same pattern as rag-search-server.js).
//
// Why bun:sqlite (not better-sqlite3): the writer in bridge/sessions-internal
// switched to bun:sqlite because better-sqlite3's native binding isn't
// compiled on this box. The launcher in bridge/mcp-registry.json runs this
// server with `bun`, so bun:sqlite is available in-process.
'use strict';

const { StringDecoder } = require('string_decoder');
const fs = require('fs');
const path = require('path');
const { Database } = require('bun:sqlite');

// Inherit BRIDGE_INTERNAL_KEY + PORT from the parent (the bridge's MCP
// launcher). Fall back to bridge/.env for any env vars the bridge knew
// about that didn't propagate into the child.
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

const SESSIONS_DB_PATH = path.join(__dirname, '..', 'data', 'sessions.db');

// ── SQLite handle (lazy, readonly) ───────────────────────────────────────────
let _db = null;
function db() {
  if (_db) return _db;
  if (!fs.existsSync(SESSIONS_DB_PATH)) {
    throw new Error(`sessions.db not found at ${SESSIONS_DB_PATH}`);
  }
  _db = new Database(SESSIONS_DB_PATH, { readonly: true });
  // Readonly + WAL: safe to coexist with the bridge writer.
  _db.exec('PRAGMA query_only = ON');
  return _db;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function _snip(s, max) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

// Accept "s1779138145072", "#s/s1779138145072", or a full
// https://…/ypa#s/s1779138145072 URL — return the bare id.
function normalizeSessionId(input) {
  const raw = String(input || '').trim();
  if (!raw) return '';
  const hashIdx = raw.lastIndexOf('#s/');
  if (hashIdx !== -1) return raw.slice(hashIdx + 3).split(/[?&]/)[0];
  const slashIdx = raw.lastIndexOf('s/');
  if (slashIdx !== -1 && raw.slice(slashIdx + 2).match(/^s\d+/)) {
    return raw.slice(slashIdx + 2).split(/[?&]/)[0];
  }
  return raw;
}

function parseJsonSafe(s, fallback) {
  if (!s) return fallback;
  try { return JSON.parse(s); } catch { return fallback; }
}

// Build a compact text projection of an assistant message's data.blocks[]
// so search/preview output is human-readable without dumping raw JSON.
function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return '';
  const parts = [];
  for (const b of blocks) {
    if (!b || typeof b !== 'object') continue;
    if (b.type === 'text' && typeof b.content === 'string') parts.push(b.content);
    else if (b.type === 'thinking' && typeof b.content === 'string') parts.push('[thinking] ' + b.content);
    else if (b.type === 'tool-call') {
      const name = b.name || 'tool';
      const detail = typeof b.detail === 'string' ? b.detail
        : (b.detail ? JSON.stringify(b.detail) : '');
      parts.push(`[tool ${name}] ${detail}`);
    } else if (b.type === 'tool-result') {
      const name = b.name || 'tool';
      const detail = typeof b.detail === 'string' ? b.detail
        : (b.detail ? JSON.stringify(b.detail) : '');
      parts.push(`[result ${name}] ${detail}`);
    }
  }
  return parts.join('\n');
}

// Project a row → light envelope. Heavy content (full blocks) stays out
// of search results; session_get returns it explicitly.
function projectMessageRow(row, { includeRaw = false } = {}) {
  const data = parseJsonSafe(row.data, {});
  const text = row.text && row.text.trim()
    ? row.text
    : blocksToText(data.blocks);
  const out = {
    seq: row.seq,
    role: row.role,
    ts: row.ts,
    text,
  };
  if (data.meta) out.meta = data.meta;
  if (includeRaw && data.blocks) out.blocks = data.blocks;
  return out;
}

function projectSessionRow(row) {
  return {
    id: row.id,
    name: row.name,
    workingDir: row.working_dir,
    category: row.category,
    sensitivity: row.sensitivity,
    createdAt: row.created_at,
    lastUsed: row.last_used,
    viewedAt: row.viewed_at,
    participants: parseJsonSafe(row.participants, null),
    data: parseJsonSafe(row.data, {}),
  };
}

// ── Bridge HTTP (for parallel RAG hop) ──────────────────────────────────────
async function bridgeFetch(method, urlPath, body) {
  const url = BRIDGE_BASE + urlPath;
  const init = { method, headers: { 'Authorization': `Bearer ${BRIDGE_KEY}` } };
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

// ── Read-only SQL guard ──────────────────────────────────────────────────────
// PRAGMA query_only=ON on the connection already blocks writes, but we
// also pre-screen for obvious DDL/DML keywords so the error surfaces
// cleanly to the caller rather than as a cryptic SQLite "attempt to write
// a readonly database".
const WRITE_KEYWORDS = /\b(insert|update|delete|drop|alter|create|attach|detach|replace|truncate|vacuum|reindex|pragma)\b/i;
function assertReadOnlySql(sql) {
  const stripped = String(sql).replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  // Allow read-only PRAGMAs like `pragma table_info(...)` — but we'd
  // rather be conservative; if the caller needs a pragma they can fetch
  // it client-side. Block all PRAGMAs.
  if (WRITE_KEYWORDS.test(stripped)) {
    throw new Error('Only read-only SELECT/WITH queries are allowed.');
  }
  if (!/^\s*(select|with)\b/i.test(stripped)) {
    throw new Error('Query must begin with SELECT or WITH.');
  }
}

// ── Tool implementations ────────────────────────────────────────────────────
function tool_session_get(args) {
  const id = normalizeSessionId(args.id);
  if (!id) throw new Error('id is required (accepts "s1779…" or a full URL)');
  const includeBlocks = args.includeBlocks !== false; // default true
  const limit = Number.isInteger(args.limit) && args.limit > 0 ? args.limit : 0;

  const sessRow = db().prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  if (!sessRow) {
    return `No session with id "${id}".`;
  }
  const session = projectSessionRow(sessRow);

  let msgStmt = 'SELECT seq, role, ts, text, data FROM messages WHERE session_id = ? ORDER BY seq ASC';
  const params = [id];
  if (limit > 0) { msgStmt += ' LIMIT ?'; params.push(limit); }
  const msgRows = db().prepare(msgStmt).all(...params);
  const messages = msgRows.map((r) => projectMessageRow(r, { includeRaw: includeBlocks }));

  const header = [
    `Session ${session.id} — ${session.name || '(no title)'}`,
    `  cwd:         ${session.workingDir || '—'}`,
    `  category:    ${session.category || '—'}`,
    `  sensitivity: ${session.sensitivity || '—'}`,
    `  created:     ${new Date(session.createdAt).toISOString()}`,
    `  last_used:   ${new Date(session.lastUsed).toISOString()}`,
    `  messages:    ${messages.length}${limit > 0 ? ` (limited from ${msgRows.length === limit ? '≥' + limit : msgRows.length})` : ''}`,
  ].join('\n');

  const lines = messages.map((m, i) => {
    const ts = new Date(m.ts).toISOString();
    const text = _snip(m.text, 4000);
    return `── [${i + 1}] ${m.role} @ ${ts} (seq ${m.seq}) ──\n${text}`;
  });

  return header + '\n\n' + (lines.length ? lines.join('\n\n') : '(no messages)');
}

function _sqlSearch(args) {
  const q = String(args.query || '').trim();
  if (!q) throw new Error('query is required');
  const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 100) : 20;

  const where = [];
  // bun:sqlite requires the placeholder prefix in the bind-object keys
  // (":pat", not "pat"). better-sqlite3 was lenient — keep them prefixed
  // so the code is explicit and portable.
  const params = {};
  // SQLite LIKE is case-insensitive for ASCII by default; lowercase both
  // sides to handle unicode roughly.
  where.push('(lower(m.text) LIKE :pat OR lower(m.data) LIKE :pat)');
  params[':pat'] = '%' + q.toLowerCase() + '%';

  if (args.workingDir) {
    where.push('s.working_dir = :wd');
    params[':wd'] = String(args.workingDir);
  }
  if (args.category) {
    where.push('s.category = :cat');
    params[':cat'] = String(args.category);
  }
  if (args.sensitivity) {
    where.push('s.sensitivity = :sens');
    params[':sens'] = String(args.sensitivity);
  }
  if (args.role) {
    where.push('m.role = :role');
    params[':role'] = String(args.role);
  }
  if (Number.isFinite(args.since)) {
    where.push('m.ts >= :since');
    params[':since'] = Number(args.since);
  }
  if (Number.isFinite(args.until)) {
    where.push('m.ts <= :until');
    params[':until'] = Number(args.until);
  }

  const sql = `
    SELECT
      s.id AS session_id,
      s.name AS session_name,
      s.working_dir,
      s.category,
      m.seq, m.role, m.ts, m.text, m.data
    FROM messages m
    JOIN sessions s ON s.id = m.session_id
    WHERE ${where.join(' AND ')}
    ORDER BY m.ts DESC
    LIMIT :limit
  `;
  params[':limit'] = limit;
  const rows = db().prepare(sql).all(params);
  return rows.map((r) => {
    const data = parseJsonSafe(r.data, {});
    const text = r.text && r.text.trim() ? r.text : blocksToText(data.blocks);
    return {
      source: 'sql',
      sessionId: r.session_id,
      sessionName: r.session_name,
      workingDir: r.working_dir,
      category: r.category,
      seq: r.seq,
      role: r.role,
      ts: r.ts,
      snippet: _snip(text, 300),
    };
  });
}

async function _ragSearch(args) {
  // Parallel hop. We tolerate failure here — if no sessions RAG DB is
  // configured (or the bridge isn't reachable) we just return [].
  try {
    // Without an explicit workingDir, cwd-mode DBs (the common case for
    // sessions corpora) would be filtered out by routeFromCwd(null), leaving
    // zero routed DBs and 0 RAG hits. Falling back to all:true here is safe
    // because sourceKind:'session' already restricts results downstream.
    const hasCwd = !!args.workingDir;
    const body = {
      query: String(args.query),
      sourceKind: 'session',
      k: Number.isInteger(args.k) ? args.k : 8,
      rerank: args.rerank !== false,
      cwd: hasCwd ? args.workingDir : undefined,
      all: !hasCwd,
    };
    const result = await bridgeFetch('POST', '/proxy/context-rag/search', body);
    const hits = result.hits || [];
    return hits.map((h) => ({
      source: 'rag',
      sessionId: h.sourceId,
      sessionName: null,
      seq: null,
      role: null,
      ts: null,
      snippet: _snip(h.text, 300),
      score: h.rerankScore != null ? Number(h.rerankScore) : null,
      distance: h.distance != null ? Number(h.distance) : null,
      dbId: h.dbId,
    }));
  } catch (_) {
    return [];
  }
}

async function tool_session_search(args) {
  if (!args.query || !String(args.query).trim()) throw new Error('query is required');
  const useRag = args.rag !== false;
  const [sqlHits, ragHits] = await Promise.all([
    Promise.resolve().then(() => _sqlSearch(args)),
    useRag ? _ragSearch(args) : Promise.resolve([]),
  ]);

  if (!sqlHits.length && !ragHits.length) {
    return `No hits for "${_snip(args.query, 80)}".`;
  }

  const lines = [];
  if (sqlHits.length) {
    lines.push(`── SQL (LIKE) hits: ${sqlHits.length} ──`);
    sqlHits.forEach((h, i) => {
      const ts = h.ts ? new Date(h.ts).toISOString() : '—';
      lines.push(
        `[sql:${i + 1}] ${h.sessionId} (${h.role} @ ${ts}, seq ${h.seq}) — ${h.sessionName || '(no title)'}`,
        `    cwd:${h.workingDir || '—'} cat:${h.category || '—'}`,
        `    ${h.snippet}`,
      );
    });
  }
  if (ragHits.length) {
    if (lines.length) lines.push('');
    lines.push(`── RAG (embedding) hits: ${ragHits.length} ──`);
    ragHits.forEach((h, i) => {
      const score = h.score != null ? `rerank=${h.score.toFixed(3)}`
        : h.distance != null ? `dist=${h.distance.toFixed(3)}`
        : '—';
      lines.push(
        `[rag:${i + 1}] ${h.sessionId} (${score}, db:${h.dbId || '?'})`,
        `    ${h.snippet}`,
      );
    });
  }
  return lines.join('\n');
}

function tool_session_sql(args) {
  const sql = String(args.query || '').trim();
  if (!sql) throw new Error('query is required');
  assertReadOnlySql(sql);
  const params = args.params;
  const limit = Number.isInteger(args.limit) && args.limit > 0 ? Math.min(args.limit, 500) : 100;

  const stmt = db().prepare(sql);
  let rows;
  if (Array.isArray(params)) rows = stmt.all(...params);
  else if (params && typeof params === 'object') rows = stmt.all(params);
  else rows = stmt.all();

  const truncated = rows.length > limit;
  const out = truncated ? rows.slice(0, limit) : rows;
  const header = `${out.length} row${out.length === 1 ? '' : 's'}${truncated ? ` (truncated from ${rows.length})` : ''}`;
  return header + '\n' + JSON.stringify(out, null, 2);
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
        serverInfo: { name: 'chat-history', version: '1.0.0' },
      },
    });
  } else if (msg.method === 'initialized' || msg.method === 'notifications/initialized') {
    // notification
  } else if (msg.method === 'ping') {
    sendMessage({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else if (msg.method === 'tools/list') {
    sendMessage({
      jsonrpc: '2.0', id: msg.id,
      result: {
        tools: [
          {
            name: 'session_get',
            description:
              "Fetch a single chat session from bridge/data/sessions.db: metadata + ordered messages. The id can be the bare session id (e.g. \"s1779138145072\"), the URL-fragment form (\"#s/s1779138145072\"), or the full https://…/ypa#s/s1779138145072 URL. Set includeBlocks=false to suppress the full data.blocks[] payload when you only need text. Use limit to cap the number of messages returned (default: all).",
            inputSchema: {
              type: 'object',
              properties: {
                id: { type: 'string', description: 'Session id, "#s/<id>", or full session URL.' },
                includeBlocks: { type: 'boolean', description: 'When true (default) include data.blocks[] (tool calls, thinking, etc) in each assistant message.' },
                limit: { type: 'integer', description: 'Max messages to return (chronological, oldest first). 0/omitted = all.' },
              },
              required: ['id'],
            },
          },
          {
            name: 'session_search',
            description:
              "Search chat history for a query string. Runs two strategies in parallel and merges the results, each hit labeled with its source: (1) SQL LIKE over messages.text and messages.data (JSON), with optional filters; (2) RAG embedding search (rag_search sourceKind:'session') when a sessions RAG DB is configured. Use this when looking up something specific the user said/decided/saw in a past conversation. Set rag=false to skip the embedding hop and run SQL only (faster, exact match).",
            inputSchema: {
              type: 'object',
              properties: {
                query:       { type: 'string', description: 'Phrase to find. SQL uses LIKE %query%, RAG uses topical similarity.' },
                workingDir:  { type: 'string', description: 'Restrict to sessions whose working_dir matches (exact).' },
                category:    { type: 'string', description: 'Restrict by sessions.category (e.g. "frontend", "backend").' },
                sensitivity: { type: 'string', description: 'Restrict by sessions.sensitivity ("public" | "system" | "sensitive").' },
                role:        { type: 'string', enum: ['user','assistant','system','tool'], description: 'Restrict by message role.' },
                since:       { type: 'number', description: 'Lower bound for messages.ts (epoch ms).' },
                until:       { type: 'number', description: 'Upper bound for messages.ts (epoch ms).' },
                limit:       { type: 'integer', description: 'Max SQL hits to return (default 20, max 100).' },
                k:           { type: 'integer', description: 'Max RAG hits to return (default 8).' },
                rerank:      { type: 'boolean', description: 'Pass-through to RAG search; defaults true.' },
                rag:         { type: 'boolean', description: 'Set false to skip the embedding hop and return SQL hits only. Defaults true.' },
              },
              required: ['query'],
            },
          },
          {
            name: 'session_sql',
            description:
              "Execute a read-only SELECT/WITH query against bridge/data/sessions.db. Tables: `sessions(id, name, created_at, last_used, viewed_at, working_dir, participants, name_source, category, sensitivity, in_memory_only, data, updated_at)` and `messages(session_id, seq, role, ts, text, streaming, live_token, live_deadline, data)`. JSON columns: sessions.data, sessions.participants, messages.data — use json_extract() on them. Connection is opened readonly with query_only=ON, and queries that aren't SELECT/WITH are rejected. Results are returned as JSON; limit caps row count (default 100, max 500). Use this for aggregates, custom joins, or grouping that session_search can't express.",
            inputSchema: {
              type: 'object',
              properties: {
                query:  { type: 'string', description: 'SELECT or WITH … SELECT statement.' },
                params: { description: 'Bind parameters: an array for "?" placeholders, or an object for ":name" placeholders.' },
                limit:  { type: 'integer', description: 'Max rows to include in the response (default 100, max 500).' },
              },
              required: ['query'],
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
    if (name === 'session_get')         text = tool_session_get(args);
    else if (name === 'session_search') text = await tool_session_search(args);
    else if (name === 'session_sql')    text = tool_session_sql(args);
    else {
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

process.stdin.on('end', () => {
  inputBuffer += _stdinDecoder.end();
  try { _db && _db.close(); } catch (_) {}
  process.exit(0);
});
process.on('SIGTERM', () => { try { _db && _db.close(); } catch (_) {} process.exit(0); });
process.on('SIGINT',  () => { try { _db && _db.close(); } catch (_) {} process.exit(0); });
require('./_parent-watchdog').installParentWatchdog();
