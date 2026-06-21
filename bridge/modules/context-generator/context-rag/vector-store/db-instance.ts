// ── context-rag db-instance ───────────────────────────────────────────────────
// Handle-cache + CRUD wrapper over the sqlite-vec adapter. One open handle per
// VectorDB id, lazily created on first access. The ingest runner and the
// retrieve layer talk only to this module — they never touch bun:sqlite or
// sqlite-vec directly.
//
// Concurrency model: WAL mode means many readers + one writer per DB file.
// Upsert/delete inside a single dbId are serialized by sqlite's own write
// lock; ingest never opens the same DB twice in parallel because it goes
// through this cache. Retrieve is read-only and can happen anywhere.
'use strict';

const logger = require('../../../../core/logger');

import { openVecDB, closeVecDB, readMeta as readMetaRaw } from './sqlite-vec';
import type { RagMeta } from './sqlite-vec';
import { getDb as getRegistryEntry, getDbFilePath } from '../registry/store';
import type { VectorDB, SensitivityTier } from '../registry/types';

type SourceKind = 'session' | 'file' | 'knowledge' | 'synthesis';

interface ChunkUpsert {
  sourceKind: SourceKind;
  /** Stable id for the source: session id, file abs-path, or knowledge entry id. */
  sourceId: string;
  /** Optional human-readable origin path. For files this equals sourceId.
   *  For sessions and knowledge entries it's a UI breadcrumb. */
  sourcePath?: string | null;
  chunkIndex: number;
  text: string;
  embedding: Float32Array;
  sensitivityTier?: SensitivityTier | null;
  sensitivityConf?: number | null;
  metadata?: Record<string, unknown>;
  /** ms since epoch; defaults to Date.now() when omitted. */
  ts?: number;
}

interface SearchHit {
  id: number;
  sourceKind: SourceKind;
  sourceId: string;
  sourcePath: string | null;
  chunkIndex: number;
  text: string;
  sensitivityTier: SensitivityTier | null;
  sensitivityConf: number | null;
  metadata: Record<string, unknown>;
  ts: number;
  /** L2 distance from sqlite-vec — lower is closer. */
  distance: number;
}

interface SearchOptions {
  k: number;
  /** Optional sensitivity allow-list. When omitted, no tier filter is applied
   *  (the per-DB sensitivity.exclude is enforced at ingest time, so the file
   *  should already be clean; this is a defensive second pass). */
  allowTiers?: readonly SensitivityTier[];
  /** Restrict to a single source kind. Used by callers that only want files
   *  or only want sessions. */
  sourceKind?: SourceKind;
  /** Over-fetch multiplier for post-filtering — default 3. Higher = safer
   *  recall after filtering, more work in sqlite-vec. */
  overFetch?: number;
}

interface KeywordHit extends SearchHit {
  /** FTS5 bm25() score — lower = more relevant. SQLite's bm25() is negated
   *  internally so closer-to-zero (e.g. -8.2) beats more-negative (-1.1).
   *  We pass it through unchanged; the merge layer ranks by it. */
  bm25: number;
}

// dbId → open bun:sqlite handle
const _handles = new Map<string, any>();

function _resolveExpectedMeta(entry: VectorDB): RagMeta {
  return {
    embedProvider: entry.embedProvider,
    embedModel: entry.embedModel,
    embedDim: entry.embedDim,
    createdAt: entry.createdAt,
    sourceSpec: JSON.stringify(entry.source),
    sensitivitySpec: JSON.stringify(entry.sensitivity),
  };
}

/** Returns an open handle for `dbId`. Opens-on-first-access. Throws if the
 *  registry has no entry for that id. */
function getHandle(dbId: string): any {
  const cached = _handles.get(dbId);
  if (cached) return cached;
  const entry = getRegistryEntry(dbId);
  if (!entry) throw new Error(`db-instance: no registry entry for db id "${dbId}"`);
  const handle = openVecDB(getDbFilePath(dbId), { expected: _resolveExpectedMeta(entry) }, dbId);
  _handles.set(dbId, handle);
  return handle;
}

function close(dbId: string): void {
  const handle = _handles.get(dbId);
  if (!handle) return;
  closeVecDB(handle, dbId);
  _handles.delete(dbId);
}

function closeAll(): void {
  for (const dbId of Array.from(_handles.keys())) close(dbId);
}

function readMeta(dbId: string): RagMeta | null {
  return readMetaRaw(getHandle(dbId));
}

// ── Writes ────────────────────────────────────────────────────────────────────

/** Insert or replace chunks. The (sourceKind, sourceId, chunkIndex) tuple is
 *  the natural key; conflicts replace the row and re-insert the vector. All
 *  rows go through a single transaction — partial failures roll back so the
 *  rag_vec/rag_chunks tables can't drift. */
function upsertChunks(dbId: string, chunks: ChunkUpsert[]): { written: number } {
  if (chunks.length === 0) return { written: 0 };
  const db = getHandle(dbId);
  const entry = getRegistryEntry(dbId)!;
  const expectedDim = entry.embedDim;

  for (const c of chunks) {
    if (c.embedding.length !== expectedDim) {
      throw new Error(
        `db-instance[${dbId}]: chunk embedding length ${c.embedding.length} != registry dim ${expectedDim}`,
      );
    }
  }

  const tx = db.transaction((items: ChunkUpsert[]) => {
    const findExisting = db.prepare(
      `SELECT id FROM rag_chunks WHERE source_kind = ? AND source_id = ? AND chunk_index = ?`,
    );
    const deleteVec    = db.prepare(`DELETE FROM rag_vec    WHERE rowid = ?`);
    const deleteChunk  = db.prepare(`DELETE FROM rag_chunks WHERE id    = ?`);
    const insertChunk  = db.prepare(`
      INSERT INTO rag_chunks
        (source_kind, source_id, source_path, chunk_index, text,
         sensitivity_tier, sensitivity_conf, metadata, ts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const insertVec    = db.prepare(`INSERT INTO rag_vec(rowid, embedding) VALUES (?, ?)`);

    let written = 0;
    for (const c of items) {
      const existing = findExisting.get(c.sourceKind, c.sourceId, c.chunkIndex) as { id: number } | undefined;
      if (existing) {
        deleteVec.run(existing.id);
        deleteChunk.run(existing.id);
      }
      const info = insertChunk.run(
        c.sourceKind,
        c.sourceId,
        c.sourcePath ?? null,
        c.chunkIndex,
        c.text,
        c.sensitivityTier ?? null,
        c.sensitivityConf ?? null,
        JSON.stringify(c.metadata ?? {}),
        c.ts ?? Date.now(),
      );
      const rowid = Number(info.lastInsertRowid);
      // sqlite-vec expects either a JSON-style string '[1,2,...]' or a raw
      // Float32Array buffer. The buffer form is faster and avoids precision
      // loss in JSON serialization.
      insertVec.run(rowid, c.embedding);
      written++;
    }
    return written;
  });

  const written = tx(chunks);
  return { written };
}

/** Remove every chunk whose (sourceKind, sourceId) matches. Used when a file
 *  is deleted, a session is rebuilt, or a knowledge entry is removed. The
 *  rag_vec rows for the same primary-key are deleted in the same transaction. */
function deleteSource(dbId: string, sourceKind: SourceKind, sourceId: string): { deleted: number } {
  const db = getHandle(dbId);
  const tx = db.transaction(() => {
    const rows = db.prepare(
      `SELECT id FROM rag_chunks WHERE source_kind = ? AND source_id = ?`,
    ).all(sourceKind, sourceId) as { id: number }[];
    if (rows.length === 0) return 0;
    const delVec   = db.prepare(`DELETE FROM rag_vec    WHERE rowid = ?`);
    const delChunk = db.prepare(`DELETE FROM rag_chunks WHERE id    = ?`);
    for (const r of rows) { delVec.run(r.id); delChunk.run(r.id); }
    return rows.length;
  });
  return { deleted: tx() };
}

/** Hard wipe — every chunk + every vector. Used by "force re-ingest". */
function clearAll(dbId: string): void {
  const db = getHandle(dbId);
  db.transaction(() => {
    db.exec('DELETE FROM rag_vec');
    db.exec('DELETE FROM rag_chunks');
  })();
}

// ── Reads ─────────────────────────────────────────────────────────────────────

function countChunks(dbId: string): number {
  const db = getHandle(dbId);
  const row = db.prepare('SELECT COUNT(*) AS n FROM rag_chunks').get() as { n: number };
  return row.n;
}

/** K-nearest similarity search. Over-fetches by `overFetch * k` to leave room
 *  for the sensitivity / source-kind post-filter to throw out matches without
 *  starving the caller of results. v1 keeps this simple and predictable — a
 *  later pass can push filters into the rag_vec MATCH clause via auxiliary
 *  columns once we've decided the schema. */
function similarity(dbId: string, query: Float32Array, opts: SearchOptions): SearchHit[] {
  const db = getHandle(dbId);
  const entry = getRegistryEntry(dbId);
  if (!entry) throw new Error(`db-instance: no registry entry for db id "${dbId}"`);
  if (query.length !== entry.embedDim) {
    throw new Error(
      `db-instance[${dbId}]: query embedding length ${query.length} != registry dim ${entry.embedDim}`,
    );
  }
  const k = Math.max(1, Math.floor(opts.k));
  const overFetch = Math.max(1, Math.floor(opts.overFetch ?? 3));
  const fetchN = k * overFetch;

  const rows = db.prepare(`
    SELECT
      c.id, c.source_kind, c.source_id, c.source_path, c.chunk_index,
      c.text, c.sensitivity_tier, c.sensitivity_conf, c.metadata, c.ts,
      v.distance
    FROM rag_vec v
    JOIN rag_chunks c ON c.id = v.rowid
    WHERE v.embedding MATCH ? AND k = ?
    ORDER BY v.distance
  `).all(query, fetchN) as Array<{
    id: number; source_kind: SourceKind; source_id: string; source_path: string | null;
    chunk_index: number; text: string;
    sensitivity_tier: SensitivityTier | null; sensitivity_conf: number | null;
    metadata: string; ts: number; distance: number;
  }>;

  const allowSet = opts.allowTiers && opts.allowTiers.length > 0
    ? new Set<SensitivityTier>(opts.allowTiers)
    : null;
  const out: SearchHit[] = [];
  for (const r of rows) {
    if (opts.sourceKind && r.source_kind !== opts.sourceKind) continue;
    if (allowSet && r.sensitivity_tier && !allowSet.has(r.sensitivity_tier)) continue;
    let metadata: Record<string, unknown>;
    try { metadata = JSON.parse(r.metadata || '{}'); }
    catch {
      logger.warn('context-rag.db-instance.metadata-corrupt', { dbId, chunkId: r.id });
      metadata = {};
    }
    out.push({
      id: r.id,
      sourceKind: r.source_kind,
      sourceId: r.source_id,
      sourcePath: r.source_path,
      chunkIndex: r.chunk_index,
      text: r.text,
      sensitivityTier: r.sensitivity_tier,
      sensitivityConf: r.sensitivity_conf,
      metadata,
      ts: r.ts,
      distance: r.distance,
    });
    if (out.length >= k) break;
  }
  return out;
}

// ── Keyword (BM25 / FTS5) search ──────────────────────────────────────────────

/** Turn an arbitrary user query into an FTS5-safe MATCH expression. FTS5 has
 *  its own little query grammar (AND/OR/NOT, quotes, `*`, `:`, column
 *  filters); anything not anticipated raises a "fts5: syntax error" at query
 *  time. We don't want callers to know any of that, so we:
 *    1. Extract alphanumeric/underscore runs of length >= 2 as tokens (the
 *       FTS5 tokenizer's punctuation-separator setting will split jargon
 *       like `yha-private` at ingest time, so query-side splits match).
 *    2. Wrap each token in double quotes (defangs reserved words like AND/OR/
 *       NOT and escapes anything weird the user pasted).
 *    3. Join with OR — we want recall here; the merger downstream decides
 *       what wins.
 *  Returns null when the query is empty after tokenization — caller treats
 *  null as "skip the keyword lane for this query". */
function _buildFtsMatch(query: string): string | null {
  const tokens = String(query || '').toLowerCase().match(/[a-z0-9_]{2,}/g);
  if (!tokens || tokens.length === 0) return null;
  // Dedupe to keep the query short.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(`"${t}"`);
    if (out.length >= 32) break; // FTS5 query length sanity guard.
  }
  return out.join(' OR ');
}

/** BM25 keyword search over rag_chunks via the rag_fts virtual table. Returns
 *  up to `k` hits ranked by FTS5's bm25() score. Used in parallel with the
 *  vector lane in retrieve/query.ts; the merge layer fuses both rankings.
 *  Returns [] when the query has no extractable tokens. */
function keywordSearch(dbId: string, query: string, opts: SearchOptions): KeywordHit[] {
  const match = _buildFtsMatch(query);
  if (!match) return [];
  const db = getHandle(dbId);
  const k = Math.max(1, Math.floor(opts.k));
  const overFetch = Math.max(1, Math.floor(opts.overFetch ?? 3));
  const fetchN = k * overFetch;

  let rows: Array<{
    id: number; source_kind: SourceKind; source_id: string; source_path: string | null;
    chunk_index: number; text: string;
    sensitivity_tier: SensitivityTier | null; sensitivity_conf: number | null;
    metadata: string; ts: number; bm25: number;
  }>;
  try {
    rows = db.prepare(`
      SELECT
        c.id, c.source_kind, c.source_id, c.source_path, c.chunk_index,
        c.text, c.sensitivity_tier, c.sensitivity_conf, c.metadata, c.ts,
        bm25(rag_fts) AS bm25
      FROM rag_fts f
      JOIN rag_chunks c ON c.id = f.rowid
      WHERE rag_fts MATCH ?
      ORDER BY bm25
      LIMIT ?
    `).all(match, fetchN) as typeof rows;
  } catch (e: any) {
    // FTS5 can still surface syntax errors for queries we didn't anticipate
    // (e.g. all-stopword input). Log and degrade silently — the vector lane
    // covers this query.
    logger.warn('context-rag.db-instance.fts-query-failed', {
      dbId, match, err: String(e && e.message || e),
    });
    return [];
  }

  const allowSet = opts.allowTiers && opts.allowTiers.length > 0
    ? new Set<SensitivityTier>(opts.allowTiers)
    : null;
  const out: KeywordHit[] = [];
  for (const r of rows) {
    if (opts.sourceKind && r.source_kind !== opts.sourceKind) continue;
    if (allowSet && r.sensitivity_tier && !allowSet.has(r.sensitivity_tier)) continue;
    let metadata: Record<string, unknown>;
    try { metadata = JSON.parse(r.metadata || '{}'); }
    catch {
      logger.warn('context-rag.db-instance.metadata-corrupt', { dbId, chunkId: r.id });
      metadata = {};
    }
    out.push({
      id: r.id,
      sourceKind: r.source_kind,
      sourceId: r.source_id,
      sourcePath: r.source_path,
      chunkIndex: r.chunk_index,
      text: r.text,
      sensitivityTier: r.sensitivity_tier,
      sensitivityConf: r.sensitivity_conf,
      metadata,
      ts: r.ts,
      // No L2 distance for keyword hits — but downstream code expects a
      // `distance` field on SearchHit. Use +Infinity so vector-only sort
      // paths put keyword hits last; the merge layer ranks by bm25/RRF
      // before that ever matters.
      distance: Number.POSITIVE_INFINITY,
      bm25: r.bm25,
    });
    if (out.length >= k) break;
  }
  return out;
}

// ── Integrity ─────────────────────────────────────────────────────────────────

interface IntegrityReport {
  dbId:           string;
  chunkCount:     number;
  vecCount:       number;
  /** rowids present in rag_chunks but missing in rag_vec — represent rows that
   *  the embedding insert silently skipped (should be zero given the upsert
   *  transaction; counts >0 indicate prior corruption). */
  orphanChunks:   number;
  /** rowids present in rag_vec but missing in rag_chunks. Should be zero. */
  orphanVecs:     number;
  /** Number of distinct (source_kind, source_id) groups whose source no longer
   *  exists on disk. Only file + knowledge are checked; session sourceIds are
   *  opaque (no fs path to stat). */
  missingSources: number;
  /** Whether rag_meta matches the registry expectation. Mismatch is a hard
   *  bug — handle.assertMetaMatch would have thrown on open; if this somehow
   *  reports false the DB needs a re-ingest. */
  metaOk:         boolean;
  meta:           RagMeta | null;
}

const _fs = require('fs');

function verifyIntegrity(dbId: string): IntegrityReport {
  const entry = getRegistryEntry(dbId);
  if (!entry) throw new Error(`db-instance: no registry entry for db id "${dbId}"`);
  const db = getHandle(dbId);
  const meta = readMeta(dbId);
  const expected = _resolveExpectedMeta(entry);
  const metaOk = !!meta
    && meta.embedProvider === expected.embedProvider
    && meta.embedModel    === expected.embedModel
    && meta.embedDim      === expected.embedDim;

  const chunkCount = (db.prepare('SELECT COUNT(*) AS n FROM rag_chunks').get() as { n: number }).n;
  const vecCount   = (db.prepare('SELECT COUNT(*) AS n FROM rag_vec').get()    as { n: number }).n;
  const orphanChunks = (db.prepare(
    `SELECT COUNT(*) AS n FROM rag_chunks c WHERE NOT EXISTS (SELECT 1 FROM rag_vec v WHERE v.rowid = c.id)`,
  ).get() as { n: number }).n;
  const orphanVecs   = (db.prepare(
    `SELECT COUNT(*) AS n FROM rag_vec v WHERE NOT EXISTS (SELECT 1 FROM rag_chunks c WHERE c.id = v.rowid)`,
  ).get() as { n: number }).n;

  // missing-source check: only for fs-backed kinds.
  let missingSources = 0;
  const groups = db.prepare(
    `SELECT DISTINCT source_kind, source_id FROM rag_chunks WHERE source_kind IN ('file','knowledge')`,
  ).all() as Array<{ source_kind: SourceKind; source_id: string }>;
  for (const g of groups) {
    const p = String(g.source_id || '');
    if (!p.startsWith('/')) continue;
    try {
      _fs.statSync(p);
    } catch {
      missingSources++;
    }
  }

  return { dbId, chunkCount, vecCount, orphanChunks, orphanVecs, missingSources, metaOk, meta };
}

export {
  getHandle,
  close,
  closeAll,
  readMeta,
  upsertChunks,
  deleteSource,
  clearAll,
  countChunks,
  similarity,
  keywordSearch,
  verifyIntegrity,
};
export type { SourceKind, ChunkUpsert, SearchHit, KeywordHit, SearchOptions, IntegrityReport };
