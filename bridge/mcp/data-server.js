#!/usr/bin/env node
// @ts-check
'use strict';

// Database MCP — SQLite, MySQL, PostgreSQL via knex.
// Persistent connections across turns (Map<id, knexInstance>).

const { StringDecoder } = require('string_decoder');
const _stdinDecoder = new StringDecoder('utf8');
const crypto = require('crypto');

// ── MCP stdio transport ──────────────────────────────────────────────────────

// Cap a single tool-result payload before it leaves this process. Large reads
// (SELECT * FROM logs, multi-MB blob columns) used to send the whole JSON as
// one MCP frame, which buffers in V8 heap on both ends. With YHA_MCP_TOOL_RESULT_MAX_BYTES
// the server truncates and appends a footer so callers know the cut happened.
// Default matches `code-server`'s 256 KB stdout cap.
const MCP_TOOL_RESULT_MAX_BYTES = (() => {
  const v = Number(process.env.YHA_MCP_TOOL_RESULT_MAX_BYTES);
  return Number.isFinite(v) && v > 0 ? v : 262144;
})();

function _capResultText(text) {
  if (typeof text !== 'string') return { text, truncated: false };
  const buf = Buffer.byteLength(text, 'utf8');
  if (buf <= MCP_TOOL_RESULT_MAX_BYTES) return { text, truncated: false };
  // Slicing on byte count would break a multi-byte char; over-trim by a
  // single code unit so the resulting string stays valid UTF-8. Most
  // callers don't depend on bytewise-exact length; the footer makes the
  // cut explicit.
  const slice = text.slice(0, MCP_TOOL_RESULT_MAX_BYTES);
  return {
    text: `${slice}\n\n[truncated: ${buf} bytes → ${MCP_TOOL_RESULT_MAX_BYTES}; set YHA_MCP_TOOL_RESULT_MAX_BYTES to raise]`,
    truncated: true,
  };
}

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
        serverInfo: { name: 'data-access', version: '1.0.0' }
      }
    });
  } else if (msg.method === 'initialized' || msg.method === 'notifications/initialized') {
    // notification — no response needed
  } else if (msg.method === 'ping') {
    sendMessage({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else if (msg.method === 'tools/list') {
    sendMessage({ jsonrpc: '2.0', id: msg.id, result: { tools: TOOLS } });
  } else if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params;
    handleToolCall(msg.id, name, args || {});
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
    try { handleMessage(JSON.parse(body)); } catch (_) {}
  }
});

process.stdin.on('end', () => { inputBuffer += _stdinDecoder.end(); process.exit(0); });
process.on('SIGTERM', () => { closeAll(); process.exit(0); });
process.on('SIGINT',  () => { closeAll(); process.exit(0); });
require('./_parent-watchdog').installParentWatchdog(() => { try { closeAll(); } catch (_) {} });

// ── Connection registry ──────────────────────────────────────────────────────

// Bounded LRU + idle-timeout. Callers are expected to invoke `db_disconnect`,
// but a leaky session would otherwise leave knex pools open until the process
// exits. Cap at MAX_CONNECTIONS and evict the least-recently-used; idle
// connections older than IDLE_TIMEOUT_MS get closed by a sweep.
const MAX_CONNECTIONS = 10;
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

const connections = new Map(); // id → { db, type, label, lastUsedAt }

function touchConnection(id) {
  const conn = connections.get(id);
  if (conn) conn.lastUsedAt = Date.now();
  return conn;
}

function evictLruIfNeeded() {
  while (connections.size >= MAX_CONNECTIONS) {
    let oldestId = null;
    let oldestTs = Infinity;
    for (const [id, conn] of connections.entries()) {
      if (conn.lastUsedAt < oldestTs) {
        oldestTs = conn.lastUsedAt;
        oldestId = id;
      }
    }
    if (!oldestId) break;
    const conn = connections.get(oldestId);
    try { conn.db.destroy(); } catch (_) {}
    connections.delete(oldestId);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [id, conn] of connections.entries()) {
    if (now - conn.lastUsedAt > IDLE_TIMEOUT_MS) {
      try { conn.db.destroy(); } catch (_) {}
      connections.delete(id);
    }
  }
}, 60 * 1000).unref?.();

function closeAll() {
  for (const { db } of connections.values()) {
    try { db.destroy(); } catch (_) {}
  }
  connections.clear();
}

function newId() {
  return crypto.randomBytes(4).toString('hex');
}

// ── Tool definitions ─────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'db_connect',
    description: 'Open a database connection. For SQLite pass the absolute file path as connectionString (e.g. "/data/mydb.sqlite"). For MySQL/PostgreSQL pass a full connection URL (e.g. "mysql://user:pass@host/db" or "postgresql://user:pass@host/db"). Returns a connectionId for subsequent calls.',
    inputSchema: {
      type: 'object',
      properties: {
        type:             { type: 'string', enum: ['sqlite', 'mysql', 'pg'], description: 'Database type' },
        connectionString: { type: 'string', description: 'File path for SQLite, connection URL for MySQL/PostgreSQL' },
        label:            { type: 'string', description: 'Optional human-readable label for this connection' }
      },
      required: ['type', 'connectionString']
    }
  },
  {
    name: 'db_query',
    description: 'Execute a SELECT (or any read-only) SQL statement. Returns up to 500 rows as a JSON array.',
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string', description: 'ID from db_connect' },
        sql:          { type: 'string', description: 'SQL query to run' },
        params:       { type: 'array',  description: 'Positional bind parameters (optional)', items: {} }
      },
      required: ['connectionId', 'sql']
    }
  },
  {
    name: 'db_execute',
    description: 'Execute a write SQL statement (INSERT, UPDATE, DELETE, CREATE, DROP …). Returns affected row count.',
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string', description: 'ID from db_connect' },
        sql:          { type: 'string', description: 'SQL to execute' },
        params:       { type: 'array',  description: 'Positional bind parameters (optional)', items: {} }
      },
      required: ['connectionId', 'sql']
    }
  },
  {
    name: 'db_tables',
    description: 'List all tables (and views) in the connected database.',
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string', description: 'ID from db_connect' }
      },
      required: ['connectionId']
    }
  },
  {
    name: 'db_schema',
    description: 'Describe the columns and types of a table.',
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string', description: 'ID from db_connect' },
        tableName:    { type: 'string', description: 'Table name to inspect' }
      },
      required: ['connectionId', 'tableName']
    }
  },
  {
    name: 'list_connections',
    description: 'List all active database connections.',
    inputSchema: { type: 'object', properties: {}, required: [] }
  },
  {
    name: 'db_disconnect',
    description: 'Close and remove a database connection.',
    inputSchema: {
      type: 'object',
      properties: {
        connectionId: { type: 'string', description: 'ID from db_connect' }
      },
      required: ['connectionId']
    }
  }
];

// ── Tool implementations ─────────────────────────────────────────────────────

async function toolDbConnect({ type, connectionString, label }) {
  let knex;
  if (type === 'sqlite') {
    knex = require('knex')({
      client: 'better-sqlite3',
      connection: { filename: connectionString },
      useNullAsDefault: true,
    });
  } else if (type === 'mysql') {
    knex = require('knex')({
      client: 'mysql2',
      connection: connectionString,
    });
  } else if (type === 'pg') {
    knex = require('knex')({
      client: 'pg',
      connection: connectionString,
    });
  } else {
    throw new Error('Unknown type: ' + type);
  }

  // Verify connection works
  await knex.raw('SELECT 1');

  evictLruIfNeeded();
  const id = newId();
  connections.set(id, { db: knex, type, label: label || connectionString, lastUsedAt: Date.now() });
  return { connectionId: id, type, label: label || connectionString, message: 'Connected.' };
}

async function toolDbQuery({ connectionId, sql, params }) {
  const conn = touchConnection(connectionId);
  if (!conn) throw new Error('Unknown connectionId: ' + connectionId);
  const rows = await conn.db.raw(sql, params || []);
  // knex raw returns different shapes per driver
  let data;
  if (conn.type === 'sqlite') {
    data = Array.isArray(rows) ? rows : (rows.rows ?? rows);
  } else if (conn.type === 'mysql') {
    data = rows[0];
  } else {
    data = rows.rows;
  }
  const limited = Array.isArray(data) ? data.slice(0, 500) : data;
  return { rows: limited, count: Array.isArray(limited) ? limited.length : null };
}

async function toolDbExecute({ connectionId, sql, params }) {
  const conn = touchConnection(connectionId);
  if (!conn) throw new Error('Unknown connectionId: ' + connectionId);
  const result = await conn.db.raw(sql, params || []);
  let affected = null;
  if (conn.type === 'sqlite') {
    affected = result?.changes ?? null;
  } else if (conn.type === 'mysql') {
    affected = result[0]?.affectedRows ?? null;
  } else {
    affected = result?.rowCount ?? null;
  }
  return { affectedRows: affected, message: 'Executed.' };
}

async function toolDbTables({ connectionId }) {
  const conn = touchConnection(connectionId);
  if (!conn) throw new Error('Unknown connectionId: ' + connectionId);
  let tables;
  if (conn.type === 'sqlite') {
    const rows = await conn.db.raw("SELECT name, type FROM sqlite_master WHERE type IN ('table','view') ORDER BY name");
    tables = rows.map(r => ({ name: r.name, type: r.type }));
  } else if (conn.type === 'mysql') {
    const [rows] = await conn.db.raw('SHOW FULL TABLES');
    tables = rows.map(r => {
      const keys = Object.keys(r);
      return { name: r[keys[0]], type: r[keys[1]] === 'VIEW' ? 'view' : 'table' };
    });
  } else {
    const result = await conn.db.raw("SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name");
    tables = result.rows.map(r => ({ name: r.table_name, type: r.table_type === 'VIEW' ? 'view' : 'table' }));
  }
  return { tables };
}

async function toolDbSchema({ connectionId, tableName }) {
  const conn = touchConnection(connectionId);
  if (!conn) throw new Error('Unknown connectionId: ' + connectionId);
  let columns;
  if (conn.type === 'sqlite') {
    const rows = await conn.db.raw('PRAGMA table_info(' + conn.db.ref(tableName).toString() + ')');
    columns = rows.map(r => ({ name: r.name, type: r.type, nullable: !r.notnull, default: r.dflt_value, pk: !!r.pk }));
  } else if (conn.type === 'mysql') {
    const [rows] = await conn.db.raw('DESCRIBE ??', [tableName]);
    columns = rows.map(r => ({ name: r.Field, type: r.Type, nullable: r.Null === 'YES', default: r.Default, key: r.Key }));
  } else {
    const result = await conn.db.raw(
      'SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = ? ORDER BY ordinal_position',
      [tableName]
    );
    columns = result.rows.map(r => ({ name: r.column_name, type: r.data_type, nullable: r.is_nullable === 'YES', default: r.column_default }));
  }
  return { table: tableName, columns };
}

function toolListConnections() {
  const list = [...connections.entries()].map(([id, { type, label }]) => ({ id, type, label }));
  return { connections: list };
}

async function toolDbDisconnect({ connectionId }) {
  const conn = touchConnection(connectionId);
  if (!conn) throw new Error('Unknown connectionId: ' + connectionId);
  await conn.db.destroy();
  connections.delete(connectionId);
  return { message: 'Disconnected.', connectionId };
}

// ── Dispatch ─────────────────────────────────────────────────────────────────

function handleToolCall(id, name, args) {
  let p;
  switch (name) {
    case 'db_connect':        p = toolDbConnect(args); break;
    case 'db_query':          p = toolDbQuery(args); break;
    case 'db_execute':        p = toolDbExecute(args); break;
    case 'db_tables':         p = toolDbTables(args); break;
    case 'db_schema':         p = toolDbSchema(args); break;
    case 'list_connections':  p = Promise.resolve(toolListConnections()); break;
    case 'db_disconnect':     p = toolDbDisconnect(args); break;
    default:
      sendMessage({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Unknown tool: ' + name } });
      return;
  }

  p.then(result => {
    const capped = _capResultText(JSON.stringify(result, null, 2));
    sendMessage({
      jsonrpc: '2.0', id,
      result: {
        content: [{ type: 'text', text: capped.text }],
        ...(capped.truncated ? { _truncated: true } : {}),
      }
    });
  }).catch(err => {
    sendMessage({
      jsonrpc: '2.0', id,
      result: { content: [{ type: 'text', text: 'Error: ' + err.message }], isError: true }
    });
  });
}
