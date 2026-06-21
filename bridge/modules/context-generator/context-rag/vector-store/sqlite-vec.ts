// ── context-rag sqlite-vec adapter ────────────────────────────────────────────
// Opens one sqlite-vec-enabled DB per VectorDB registry entry. Each registry
// entry owns its own physical file at `bridge/modules/context-generator/
// context-rag/data/{id}.db`, so the embedModel lock is concrete: rag_meta
// records the model on first open, and `assertMetaMatch` refuses any handle
// whose meta disagrees with the registry view of the same DB.
//
// Schema is fixed for v1. The embedding dimension is baked into the
// `vec0(embedding float[N])` DDL — sqlite-vec virtual tables don't accept
// runtime-bound dimensions. Dim is validated at the registry layer
// (1..8192 integer) so interpolating it into the CREATE statement is safe.
'use strict';

const path = require('path');
const fs   = require('fs');
const { Database } = require('bun:sqlite');
const sqliteVec = require('sqlite-vec');

const logger = require('../../../../core/logger');

import type { EmbedProvider } from '../registry/types';

interface RagMeta {
  embedProvider: EmbedProvider;
  embedModel: string;
  embedDim: number;
  createdAt: number;
  sourceSpec: string;       // raw JSON; the registry is source-of-truth for parsed form
  sensitivitySpec: string;  // raw JSON
}

interface OpenOptions {
  /** Used only when the DB file does not yet exist — these values get stamped
   *  into rag_meta on first creation. After that, the file's own meta wins
   *  and we assertMatch against these. */
  expected: RagMeta;
}

function _applyPragmas(db: any): void {
  // Same convention as bridge/sessions-internal/db.ts. WAL gives us crash-safe
  // single-writer/many-readers semantics on each per-DB file. foreign_keys is
  // unused here today (no FKs in the schema) but we turn it on so a later
  // schema bump can add CASCADE rules without surprises.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA temp_store = MEMORY');
}

function _bootstrapSchema(db: any, embedDim: number): void {
  if (!Number.isInteger(embedDim) || embedDim <= 0 || embedDim > 8192) {
    throw new Error(`sqlite-vec: refusing to bootstrap, embedDim ${embedDim} out of range`);
  }
  db.exec(`
    CREATE TABLE IF NOT EXISTS rag_meta (
      embed_provider     TEXT    NOT NULL,
      embed_model        TEXT    NOT NULL,
      embed_dim          INTEGER NOT NULL,
      created_at         INTEGER NOT NULL,
      source_spec        TEXT    NOT NULL,
      sensitivity_spec   TEXT    NOT NULL
    );
    CREATE TABLE IF NOT EXISTS rag_chunks (
      id                 INTEGER PRIMARY KEY,
      source_kind        TEXT    NOT NULL,
      source_id          TEXT    NOT NULL,
      source_path        TEXT,
      chunk_index        INTEGER NOT NULL,
      text               TEXT    NOT NULL,
      sensitivity_tier   TEXT,
      sensitivity_conf   REAL,
      metadata           TEXT    NOT NULL DEFAULT '{}',
      ts                 INTEGER NOT NULL,
      UNIQUE (source_kind, source_id, chunk_index)
    );
    CREATE INDEX IF NOT EXISTS ix_rag_chunks_source
      ON rag_chunks(source_kind, source_id);
    CREATE INDEX IF NOT EXISTS ix_rag_chunks_path
      ON rag_chunks(source_path) WHERE source_path IS NOT NULL;
    CREATE INDEX IF NOT EXISTS ix_rag_chunks_tier
      ON rag_chunks(sensitivity_tier) WHERE sensitivity_tier IS NOT NULL;
  `);
  // vec0 dimension is baked at create time — interpolated, not bound.
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS rag_vec USING vec0(embedding float[${embedDim}])`);

  // BM25 lane (hybrid retrieval). FTS5 is built-in to bun:sqlite. We use the
  // "external content" pattern: rag_fts stores only the inverted index and
  // points back at rag_chunks via content_rowid=id. We deliberately do NOT
  // override the default unicode61 tokenizer — it already splits on every
  // non-L/non-N unicode codepoint, so `yha-private`, `YHA_PROFILE`, and
  // `docs/yha.md` decompose cleanly into their constituent tokens. Earlier
  // attempts to pass an explicit `separators '...'` option through SQLite's
  // FTS5 option parser silently produced an unindexable corpus.
  //
  // Defensive migration: if a previous version of this bootstrap stamped
  // rag_fts with a `tokenize=` override, drop the table so the IF NOT EXISTS
  // below recreates it with the default tokenizer. The triggers below will
  // also be replaced. The rebuild step at the end of bootstrap repopulates
  // the index from rag_chunks. We do NOT drop a default-tokenizer rag_fts —
  // only the broken-override case.
  {
    const existing = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='rag_fts'",
    ).get() as { sql: string } | undefined;
    if (existing && /tokenize\s*=/i.test(existing.sql)) {
      logger.warn('context-rag.sqlite-vec.fts-tokenizer-migration', {
        prevSql: existing.sql.replace(/\s+/g, ' ').slice(0, 200),
      });
      db.exec(`DROP TABLE rag_fts`);
      db.exec(`DROP TRIGGER IF EXISTS rag_chunks_ai`);
      db.exec(`DROP TRIGGER IF EXISTS rag_chunks_ad`);
      db.exec(`DROP TRIGGER IF EXISTS rag_chunks_au`);
    }
  }
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS rag_fts USING fts5(
      text,
      content='rag_chunks',
      content_rowid='id'
    );
    CREATE TRIGGER IF NOT EXISTS rag_chunks_ai AFTER INSERT ON rag_chunks BEGIN
      INSERT INTO rag_fts(rowid, text) VALUES (new.id, new.text);
    END;
    CREATE TRIGGER IF NOT EXISTS rag_chunks_ad AFTER DELETE ON rag_chunks BEGIN
      INSERT INTO rag_fts(rag_fts, rowid, text) VALUES('delete', old.id, old.text);
    END;
    CREATE TRIGGER IF NOT EXISTS rag_chunks_au AFTER UPDATE ON rag_chunks BEGIN
      INSERT INTO rag_fts(rag_fts, rowid, text) VALUES('delete', old.id, old.text);
      INSERT INTO rag_fts(rowid, text) VALUES (new.id, new.text);
    END;
  `);

  // One-time backfill for DBs created before the FTS lane existed: if there
  // are chunks but the FTS index is empty (or behind), trigger a rebuild
  // from the content table. Subsequent opens find counts in sync and skip.
  //
  // NB: `SELECT COUNT(*) FROM rag_fts` is NOT the right signal — in
  // external-content mode FTS5 proxies row counts to the content table, so
  // it always equals rag_chunks.count(). The shadow rag_fts_docsize table
  // has exactly one row per indexed document and is the authoritative
  // "is the index populated" check.
  const chunkCount = (db.prepare('SELECT COUNT(*) AS n FROM rag_chunks').get() as { n: number }).n;
  const ftsDocSize = (db.prepare('SELECT COUNT(*) AS n FROM rag_fts_docsize').get() as { n: number }).n;
  if (chunkCount > 0 && ftsDocSize < chunkCount) {
    db.exec(`INSERT INTO rag_fts(rag_fts) VALUES('rebuild')`);
    logger.info('context-rag.sqlite-vec.fts-rebuilt', {
      chunks: chunkCount,
      ftsDocsizeBefore: ftsDocSize,
    });
  }
}

function _stampMetaIfEmpty(db: any, expected: RagMeta): void {
  const row = db.prepare('SELECT COUNT(*) AS n FROM rag_meta').get() as { n: number };
  if (row.n > 0) return;
  db.prepare(`
    INSERT INTO rag_meta (embed_provider, embed_model, embed_dim, created_at, source_spec, sensitivity_spec)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    expected.embedProvider,
    expected.embedModel,
    expected.embedDim,
    expected.createdAt,
    expected.sourceSpec,
    expected.sensitivitySpec,
  );
}

function readMeta(db: any): RagMeta | null {
  const row = db.prepare(`
    SELECT embed_provider, embed_model, embed_dim, created_at, source_spec, sensitivity_spec
    FROM rag_meta LIMIT 1
  `).get() as
    | { embed_provider: string; embed_model: string; embed_dim: number; created_at: number;
        source_spec: string; sensitivity_spec: string }
    | undefined;
  if (!row) return null;
  return {
    embedProvider: row.embed_provider as EmbedProvider,
    embedModel: row.embed_model,
    embedDim: row.embed_dim,
    createdAt: row.created_at,
    sourceSpec: row.source_spec,
    sensitivitySpec: row.sensitivity_spec,
  };
}

/** Throws if the DB file's stamped meta disagrees with what the registry
 *  thinks this DB is. This is the embedModel lock at runtime. */
function assertMetaMatch(db: any, expected: RagMeta, dbId: string): void {
  const meta = readMeta(db);
  if (!meta) throw new Error(`sqlite-vec[${dbId}]: rag_meta is empty after bootstrap`);
  if (meta.embedProvider !== expected.embedProvider
   || meta.embedModel    !== expected.embedModel
   || meta.embedDim      !== expected.embedDim) {
    throw new Error(
      `sqlite-vec[${dbId}]: meta mismatch — file has ${meta.embedProvider}/${meta.embedModel}/dim${meta.embedDim}, ` +
      `registry expects ${expected.embedProvider}/${expected.embedModel}/dim${expected.embedDim}. ` +
      `Re-ingest is required after a model change; v1 does not migrate in place.`,
    );
  }
}

/** Open (or create) the per-DB sqlite-vec file at `filePath`. Loads the vec0
 *  extension, applies pragmas, bootstraps schema, stamps meta on first open,
 *  and asserts meta matches on every subsequent open. */
function openVecDB(filePath: string, opts: OpenOptions, dbId: string): any {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const db = new Database(filePath);
  try {
    sqliteVec.load(db);
  } catch (e: any) {
    try { db.close(); } catch { /* best-effort */ }
    throw new Error(
      `sqlite-vec[${dbId}]: failed to load vec0 extension — ${e && e.message || String(e)}`,
    );
  }
  _applyPragmas(db);
  _bootstrapSchema(db, opts.expected.embedDim);
  _stampMetaIfEmpty(db, opts.expected);
  assertMetaMatch(db, opts.expected, dbId);
  logger.info('context-rag.sqlite-vec.opened', {
    dbId,
    path: filePath,
    provider: opts.expected.embedProvider,
    model: opts.expected.embedModel,
    dim: opts.expected.embedDim,
  });
  return db;
}

function closeVecDB(db: any, dbId: string): void {
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (e: any) {
    logger.warn('context-rag.sqlite-vec.checkpoint-failed', { dbId, err: String(e && e.message || e) });
  }
  try {
    db.close();
  } catch (e: any) {
    logger.warn('context-rag.sqlite-vec.close-failed', { dbId, err: String(e && e.message || e) });
  }
  logger.info('context-rag.sqlite-vec.closed', { dbId });
}

export {
  openVecDB,
  closeVecDB,
  readMeta,
  assertMetaMatch,
};
export type { RagMeta, OpenOptions };
