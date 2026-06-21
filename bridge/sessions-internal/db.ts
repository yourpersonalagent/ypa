// ── SQLite session store (canonical; Steps 1–6 of docs/SQL-migration-plan.md) ─
//
// This is THE durable session store. As of Step 4 it is canonical: server.ts
// opens it unconditionally at boot and loadSessionsFromDisk reads from it, not
// from bridge/sessions/*.json. There is no "JSON-only" / prep mode and the old
// YHA_SQLITE_PREP flag is gone. As of Step 6 go-core also writes finalize
// directly to this same file (go-core/internal/stream/sqlite_finalize.go), so
// the bridge is no longer the sole writer — both processes open it in WAL mode
// with busy_timeout(5000). Treat this module as load-bearing: a self-editing
// chat that "disables" it because a comment once called it optional would lose
// chat durability.
//
// Driver choice: bun:sqlite, not better-sqlite3. The latter is in package.json
// but its native binding isn't reliably prebuilt for this runtime (Bun's npm
// install skips node-gyp prebuilds without a setup step). bun:sqlite is built
// into the Bun runtime, supports JSON1 + WAL, and the API is close enough that
// swapping drivers later only touches this file.
'use strict';

const path = require('path');
const fs = require('fs');
const { Database } = require('bun:sqlite');
const logger = require('../core/logger');

const SCHEMA_VERSION = 1;
const DEFAULT_DB_PATH = path.join(__dirname, '..', 'data', 'sessions.db');

let _db: any = null;
let _dbPath: string | null = null;

function getDB(): any {
  if (!_db) throw new Error('sqlite db not opened; call openDB() first');
  return _db;
}

function isOpen(): boolean {
  return _db !== null;
}

function openDB(filePath: string = DEFAULT_DB_PATH): any {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  _applyPragmas(db);
  _applySchema(db);
  _db = db;
  _dbPath = filePath;
  logger.info('sqlite.opened', { path: filePath, schemaVersion: SCHEMA_VERSION });
  return db;
}

function closeDB(): void {
  if (!_db) return;
  try {
    // Best-effort WAL checkpoint so the -wal file doesn't grow unboundedly
    // across restarts. TRUNCATE shrinks the file to zero after merging.
    _db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (e) {
    logger.warn('sqlite.checkpoint-failed', { error: e instanceof Error ? e.message : String(e) });
  }
  try {
    _db.close();
  } catch (e) {
    logger.warn('sqlite.close-failed', { error: e instanceof Error ? e.message : String(e) });
  }
  _db = null;
  _dbPath = null;
  logger.info('sqlite.closed');
}

function _applyPragmas(db: any): void {
  // WAL: concurrent readers + one writer, crash-safe. With synchronous=NORMAL
  // we get the standard durability/perf tradeoff (fsync at checkpoint, not at
  // every commit). foreign_keys is OFF by default in SQLite; we want the
  // ON DELETE CASCADE on messages/claude_sessions to actually fire.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA temp_store = MEMORY');
  db.exec('PRAGMA mmap_size = 268435456');
}

// IF NOT EXISTS everywhere — applySchema runs on every open and must be a
// no-op when the schema is already current. Future schema bumps will read
// meta.schema_version and dispatch to migration steps from there.
const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  id              TEXT PRIMARY KEY,
  name            TEXT,
  created_at      INTEGER NOT NULL,
  last_used       INTEGER NOT NULL,
  viewed_at       INTEGER NOT NULL DEFAULT 0,
  working_dir     TEXT,
  participants    TEXT,
  name_source     TEXT,
  category        TEXT,
  sensitivity     TEXT,
  in_memory_only  INTEGER NOT NULL DEFAULT 0,
  data            TEXT NOT NULL DEFAULT '{}',
  updated_at      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sessions_last_used    ON sessions(last_used DESC);
CREATE INDEX IF NOT EXISTS ix_sessions_viewed_at    ON sessions(viewed_at DESC);
CREATE INDEX IF NOT EXISTS ix_sessions_working_dir  ON sessions(working_dir);
CREATE INDEX IF NOT EXISTS ix_sessions_category     ON sessions(category)    WHERE category    IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_sessions_sensitivity  ON sessions(sensitivity) WHERE sensitivity IS NOT NULL;

CREATE TABLE IF NOT EXISTS messages (
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  role            TEXT NOT NULL,
  ts              INTEGER NOT NULL,
  text            TEXT,
  streaming       INTEGER NOT NULL DEFAULT 0,
  live_token      INTEGER,
  live_deadline   INTEGER,
  data            TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX IF NOT EXISTS ix_messages_streaming  ON messages(streaming) WHERE streaming = 1;
CREATE INDEX IF NOT EXISTS ix_messages_session_ts ON messages(session_id, ts);

CREATE TABLE IF NOT EXISTS claude_sessions (
  session_id      TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  claude_id       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key             TEXT PRIMARY KEY,
  value           TEXT NOT NULL
);
`;

function _applySchema(db: any): void {
  db.exec(SCHEMA_DDL);
  // Stamp the schema version on first creation; preserve whatever's there on
  // subsequent opens. Mismatch is logged, not fixed automatically — the
  // intent is "next port adds a real migration runner here."
  db.prepare(`INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', ?)`).run(
    String(SCHEMA_VERSION),
  );
  const current = db.prepare(`SELECT value FROM meta WHERE key = 'schema_version'`).get();
  if (current && Number(current.value) !== SCHEMA_VERSION) {
    logger.warn('sqlite.schema-version-mismatch', {
      onDisk: current.value,
      code: SCHEMA_VERSION,
    });
  }
}

// ── Promoted-column / data-blob mapping ───────────────────────────────────────
// Single source of truth for "which keys are columns vs which go into the JSON
// blob." The migration script and the dual-write path both import these so
// they can't drift apart.
const SESSION_PROMOTED_KEYS = new Set([
  'id',
  'name',
  'messages',
  'createdAt',
  'lastUsed',
  'viewedAt',
  'workingDir',
  'participants',
  '_nameSource',
  'category',
  'sensitivity',
  '_inMemoryOnly',
]);

const MESSAGE_PROMOTED_KEYS = new Set([
  'role',
  'ts',
  'text',
  'streaming',
  '_liveToken',
  '_liveDeadline',
  // Listed here purely to *exclude* it from the JSON data blob — the value is
  // a process-local monotonic clock reading from performance.now() and is
  // meaningless across restarts (see persistence.ts sweepExpiredLiveMsgs).
  // There is no matching DB column; reads naturally drop the field.
  '_liveStartedPerfMs',
]);

function buildSessionDataBlob(s: any): Record<string, any> {
  const blob: Record<string, any> = {};
  for (const [k, v] of Object.entries(s || {})) {
    if (!SESSION_PROMOTED_KEYS.has(k)) blob[k] = v;
  }
  return blob;
}

function buildMessageDataBlob(m: any): Record<string, any> {
  const blob: Record<string, any> = {};
  for (const [k, v] of Object.entries(m || {})) {
    if (!MESSAGE_PROMOTED_KEYS.has(k)) blob[k] = v;
  }
  return blob;
}

// ── Write helpers (Step 3 dual-write) ─────────────────────────────────────────
// All write helpers are tolerant of a closed DB: they short-circuit when no
// handle is open, so callers in persistence.ts can wrap them in try/catch and
// the dual-write hook is a true no-op when the SQLite flag is off.

function writeSessionFull(s: any): void {
  if (!_db) return;
  if (!s || typeof s !== 'object') return;
  const sid = String(s.id || '');
  if (!sid) return;
  if (s._inMemoryOnly) return; // ghosts never hit disk; mirror that on the DB side

  const createdAt = Number(s.createdAt) || 0;
  const lastUsed = Number(s.lastUsed) || createdAt;
  const viewedAt = Number(s.viewedAt) || 0;
  const participants = Array.isArray(s.participants)
    ? JSON.stringify(s.participants)
    : null;
  const dataBlob = JSON.stringify(buildSessionDataBlob(s));
  const messages: any[] = Array.isArray(s.messages) ? s.messages : [];

  // One transaction so a session-row UPSERT and the messages replace are
  // atomic — readers always see a self-consistent session.
  const txn = _db.transaction(() => {
    _db
      .prepare(
        `
        INSERT INTO sessions (
          id, name, created_at, last_used, viewed_at, working_dir,
          participants, name_source, category, sensitivity,
          in_memory_only, data, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, json(?), ?)
        ON CONFLICT(id) DO UPDATE SET
          name           = excluded.name,
          created_at     = excluded.created_at,
          last_used      = excluded.last_used,
          viewed_at      = excluded.viewed_at,
          working_dir    = excluded.working_dir,
          participants   = excluded.participants,
          name_source    = excluded.name_source,
          category       = excluded.category,
          sensitivity    = excluded.sensitivity,
          in_memory_only = excluded.in_memory_only,
          data           = excluded.data,
          updated_at     = excluded.updated_at
      `,
      )
      .run(
        sid,
        s.name ?? null,
        createdAt,
        lastUsed,
        viewedAt,
        s.workingDir ?? null,
        participants,
        s._nameSource ?? null,
        s.category ?? null,
        s.sensitivity ?? null,
        dataBlob,
        Date.now(),
      );

    // Replace-all is wasteful per-write but unambiguously correct against an
    // in-memory representation that mutates blocks/text/order. At 500 ms
    // debounce + typical 10–50 messages per session, this is sub-ms.
    _db.prepare('DELETE FROM messages WHERE session_id = ?').run(sid);
    const insMsg = _db.prepare(`
      INSERT INTO messages (session_id, seq, role, ts, text, streaming,
                            live_token, live_deadline, data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, json(?))
    `);
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i];
      if (!m || typeof m !== 'object') continue;
      const role = String(m.role || 'user');
      const ts = Number(m.ts) || lastUsed || createdAt || Date.now();
      const text = typeof m.text === 'string' ? m.text : null;
      const streaming = m.streaming ? 1 : 0;
      const liveToken = Number.isFinite(m._liveToken) ? Number(m._liveToken) : null;
      const liveDeadline = Number.isFinite(m._liveDeadline) ? Number(m._liveDeadline) : null;
      const mBlob = JSON.stringify(buildMessageDataBlob(m));
      insMsg.run(sid, i, role, ts, text, streaming, liveToken, liveDeadline, mBlob);
    }
  });

  try {
    txn();
  } catch (e) {
    logger.warn('sqlite.write-session-failed', {
      sid,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// Single-row update for the live-streaming placeholder. The full
// writeSessionFull above is O(messages) — it DELETEs and re-INSERTs every
// row — which is fine at a 500 ms-debounced once-per-structural-change
// cadence but ruinous on the mid-stream checkpoint path: go-core fires a
// phase="update" every 2 s for the whole duration of a turn, and a long
// agent turn on a big session would otherwise rewrite hundreds of rows
// every 2 s, synchronously, holding the WAL write lock long enough to
// starve the event loop and block go-core's own finalizer (which shares
// this DB file). During a live stream only the one streaming row changes,
// so update just that row, matched by the stable (session_id, live_token)
// handle — the same key go-core's SQLiteFinalizer uses (sqlite_finalize.go).
//
// Returns true when a row was updated. False (no matching row — placeholder
// not yet flushed, or no live_token) tells the caller to fall back to a
// full session write so nothing is silently dropped.
function updateLiveMessageRow(sid: string, msg: any): boolean {
  if (!_db) return false;
  if (!sid || !msg || typeof msg !== 'object') return false;
  const token = Number.isFinite(msg._liveToken) ? Number(msg._liveToken) : null;
  if (token == null) return false;
  try {
    const role = String(msg.role || 'assistant');
    const ts = Number(msg.ts) || Date.now();
    const text = typeof msg.text === 'string' ? msg.text : null;
    const streaming = msg.streaming ? 1 : 0;
    const liveDeadline = Number.isFinite(msg._liveDeadline) ? Number(msg._liveDeadline) : null;
    const mBlob = JSON.stringify(buildMessageDataBlob(msg));
    const res = _db
      .prepare(
        `UPDATE messages
            SET role = ?, ts = ?, text = ?, streaming = ?, live_deadline = ?, data = json(?)
          WHERE session_id = ? AND live_token = ?`,
      )
      .run(role, ts, text, streaming, liveDeadline, mBlob, sid, token);
    return !!(res && res.changes > 0);
  } catch (e) {
    logger.warn('sqlite.update-live-row-failed', {
      sid,
      error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

function deleteSession(sid: string): void {
  if (!_db) return;
  if (!sid) return;
  try {
    // ON DELETE CASCADE cleans messages + claude_sessions rows.
    _db.prepare('DELETE FROM sessions WHERE id = ?').run(String(sid));
  } catch (e) {
    logger.warn('sqlite.delete-session-failed', {
      sid,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// Replace the entire claude_sessions table from the in-memory Map. Called
// from saveIndexToDisk so the table stays in lockstep with the index.json
// representation. 71 entries today; running DELETE+INSERT in one txn is
// trivial overhead.
function replaceClaudeSessions(map: Map<string, string> | Iterable<[string, string]>): void {
  if (!_db) return;
  const entries = Array.isArray(map) ? map : Array.from(map as any);
  try {
    const txn = _db.transaction(() => {
      _db.exec('DELETE FROM claude_sessions');
      const ins = _db.prepare(
        'INSERT INTO claude_sessions (session_id, claude_id) VALUES (?, ?)',
      );
      for (const e of entries) {
        if (!Array.isArray(e) || e.length < 2) continue;
        const [sid, cid] = e;
        if (!sid || !cid) continue;
        // Only insert claude_sessions rows whose parent session exists; the
        // FK would reject otherwise. Skip silently — same semantics as the
        // index.json behaviour (orphan claude entries are inert).
        const exists = _db
          .prepare('SELECT 1 FROM sessions WHERE id = ?')
          .get(String(sid));
        if (!exists) continue;
        ins.run(String(sid), String(cid));
      }
    });
    txn();
  } catch (e) {
    logger.warn('sqlite.replace-claude-sessions-failed', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// Diagnostics — surfaced at boot to detect "did you forget to run the
// migration?" scenarios where the bridge has JSON sessions but the DB is
// empty/sparse.
function countSessions(): number {
  if (!_db) return 0;
  try {
    return Number(_db.query('SELECT COUNT(*) AS n FROM sessions').get().n) || 0;
  } catch {
    return 0;
  }
}

// Latest updated_at across all sessions; used by the boot safety check to
// compare against bridge/sessions/ mtimes and warn on staleness.
function latestSessionUpdatedAt(): number {
  if (!_db) return 0;
  try {
    const r = _db.query('SELECT COALESCE(MAX(updated_at), 0) AS m FROM sessions').get();
    return Number(r?.m) || 0;
  } catch {
    return 0;
  }
}

// ── Read helpers (Step 4 canonicity flip) ─────────────────────────────────────
// Rebuild the in-memory Session shape from a sessions row + its messages rows.
// Mirrors the JSON-on-disk schema so the rest of the bridge (which reads
// session.messages[], session.workingDir, etc.) doesn't need to change.
function _rowToSession(row: any, messageRows: any[]): any {
  const data = (() => {
    try {
      return row?.data ? JSON.parse(row.data) : {};
    } catch {
      return {};
    }
  })();
  const participants = (() => {
    if (!row?.participants) return undefined;
    try {
      const arr = JSON.parse(row.participants);
      return Array.isArray(arr) ? arr : undefined;
    } catch {
      return undefined;
    }
  })();

  const messages: any[] = [];
  for (const m of messageRows) {
    let mData: any = {};
    try {
      mData = m?.data ? JSON.parse(m.data) : {};
    } catch {
      mData = {};
    }
    const msg: any = { role: m.role, ts: Number(m.ts) || 0, ...mData };
    if (m.text != null) msg.text = m.text;
    if (m.streaming) msg.streaming = true;
    if (m.live_token != null) msg._liveToken = Number(m.live_token);
    if (m.live_deadline != null) msg._liveDeadline = Number(m.live_deadline);
    messages.push(msg);
  }

  // Reconstruct the session object — promoted columns first, then merge
  // anything from the data blob. Keep the field order close to what the
  // legacy JSON shape produces so any downstream JSON.stringify diff lines
  // up reasonably.
  const session: any = {
    id: row.id,
    name: row.name ?? null,
    messages,
    createdAt: Number(row.created_at) || 0,
    lastUsed: Number(row.last_used) || 0,
    viewedAt: Number(row.viewed_at) || 0,
    workingDir: row.working_dir ?? null,
    ...(participants !== undefined ? { participants } : {}),
    _nameSource: row.name_source ?? null,
    ...(row.category != null ? { category: row.category } : {}),
    ...(row.sensitivity != null ? { sensitivity: row.sensitivity } : {}),
    ...data,
  };
  return session;
}

// Load every session into a Map<sid, Session>. Two queries total (sessions
// table + messages table), then partition messages into their sessions by
// session_id. Avoids the N+1 query pattern that the per-session JSON read
// path effectively had.
function loadAllSessions(): Map<string, any> {
  if (!_db) throw new Error('sqlite db not opened; call openDB() first');
  const sessionsByid = new Map<string, any>();
  const msgsBySid = new Map<string, any[]>();
  const allMsgs = _db
    .query(
      `SELECT session_id, seq, role, ts, text, streaming, live_token, live_deadline, data
       FROM messages
       ORDER BY session_id, seq`,
    )
    .all() as any[];
  for (const m of allMsgs) {
    let bucket = msgsBySid.get(m.session_id);
    if (!bucket) {
      bucket = [];
      msgsBySid.set(m.session_id, bucket);
    }
    bucket.push(m);
  }
  const allSessions = _db
    .query(
      `SELECT id, name, created_at, last_used, viewed_at, working_dir, participants,
              name_source, category, sensitivity, in_memory_only, data, updated_at
       FROM sessions`,
    )
    .all() as any[];
  for (const row of allSessions) {
    const sid = String(row.id);
    const messages = msgsBySid.get(sid) || [];
    const session = _rowToSession(row, messages);
    sessionsByid.set(sid, session);
  }
  return sessionsByid;
}

// Read the claude-session mapping into a Map<sid, claudeId>. Replacement for
// reading index.json's claudeSessions array.
function loadClaudeSessions(): Map<string, string> {
  const out = new Map<string, string>();
  if (!_db) return out;
  const rows = _db
    .query('SELECT session_id, claude_id FROM claude_sessions')
    .all() as any[];
  for (const r of rows) {
    if (!r?.session_id || !r?.claude_id) continue;
    out.set(String(r.session_id), String(r.claude_id));
  }
  return out;
}

// Load one session by id (used for lazy/missing path). Returns null if not found.
function loadSession(sid: string): any | null {
  if (!_db) throw new Error('sqlite db not opened; call openDB() first');
  const row = _db
    .query(
      `SELECT id, name, created_at, last_used, viewed_at, working_dir, participants,
              name_source, category, sensitivity, in_memory_only, data, updated_at
       FROM sessions WHERE id = ?`,
    )
    .get(String(sid));
  if (!row) return null;
  const messages = _db
    .query(
      `SELECT session_id, seq, role, ts, text, streaming, live_token, live_deadline, data
       FROM messages WHERE session_id = ? ORDER BY seq`,
    )
    .all(String(sid));
  return _rowToSession(row, messages);
}

module.exports = {
  openDB,
  closeDB,
  getDB,
  isOpen,
  SCHEMA_VERSION,
  DEFAULT_DB_PATH,
  // Schema-shape helpers (shared with tools/migrate-sessions-to-sqlite.mjs)
  SESSION_PROMOTED_KEYS,
  MESSAGE_PROMOTED_KEYS,
  buildSessionDataBlob,
  buildMessageDataBlob,
  // Write helpers (Step 3 dual-write)
  writeSessionFull,
  updateLiveMessageRow,
  deleteSession,
  replaceClaudeSessions,
  countSessions,
  latestSessionUpdatedAt,
  // Read helpers (Step 4 canonicity)
  loadAllSessions,
  loadClaudeSessions,
  loadSession,
};
