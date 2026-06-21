// ── context-rag file ingest ───────────────────────────────────────────────────
// Per-file half of the file producer. The walker (./file-walker.ts) decides
// WHICH paths to process; this module does the work for ONE path: read from
// disk → chunk → per-DB sensitivity gate → embed → atomic upsert.
//
// Mirrors `sessions.ts` structurally so the runner can dispatch on
// `item.kind` without learning a new shape. Key differences vs sessions:
//
//   - sourceId IS the absolute file path (paths are stable in a way session
//     ids aren't, and the file-walker emits them already-normalized).
//   - chunking uses `chunkText()` (char-window) — files have no turn structure.
//   - the "already ingested" short-circuit additionally checks the file's
//     mtime against the most recently ingested chunk's `ts`. A file that
//     hasn't changed since last ingest is skipped per-DB; a file that grew
//     gets a full delete-then-reinsert.
//   - binary files are detected by sniffing the first 4KiB for NUL bytes and
//     dropped before they reach the embed adapter. Saves a wasted round-trip
//     and avoids polluting `rag_chunks.text` with garbage.
'use strict';

const fs     = require('fs');
const path   = require('path');
const logger = require('../../../../core/logger');

import * as queue from './queue';
import { matchFile, anyDbWantsFiles } from '../registry/matcher';
import { chunkText } from './chunker';
import { classifyAndGate } from './sensitivity-gate';
import { clientForDB } from '../embed/client-for-db';
import {
  getHandle,
  upsertChunks,
  deleteSource,
} from '../vector-store/db-instance';
import type { VectorDB } from '../registry/types';
import type { ChunkUpsert } from '../vector-store/db-instance';

const MAX_BATCH_EMBED = 16;
/** Files larger than this are skipped — embedding cost balloons fast and any
 *  real corpus has a handful of generated/data files that would dominate a
 *  ingest run otherwise. Configurable per-DB later if needed. */
const MAX_FILE_BYTES = 1_000_000;
/** Bytes inspected for the binary sniff. */
const SNIFF_BYTES = 4_096;

// ── Helpers ───────────────────────────────────────────────────────────────────

function _looksBinary(buf: Buffer): boolean {
  const end = Math.min(buf.length, SNIFF_BYTES);
  for (let i = 0; i < end; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}

/** Returns the max `ts` over chunks the DB already has for this file, or
 *  null when the file isn't represented. The runner uses this to skip
 *  re-ingest when on-disk mtime <= max stored ts. */
function _maxIngestedTs(db: VectorDB, absPath: string): number | null {
  try {
    const handle = getHandle(db.id);
    const row = handle
      .prepare(`SELECT MAX(ts) AS maxTs FROM rag_chunks WHERE source_kind = 'file' AND source_id = ?`)
      .get(absPath) as { maxTs: number | null } | undefined;
    if (!row || row.maxTs == null) return null;
    return Number(row.maxTs);
  } catch (e) {
    logger.warn('context-rag.file.check-failed', {
      dbId: db.id, path: absPath, error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

// ── Public producers ──────────────────────────────────────────────────────────

/** Chain-style enqueue from the file watcher (debounced upstream). Cheap:
 *  short-circuits when no DB cares about files at all. */
function enqueueFileForRag(absPath: string, reason: 'fs-change' | 'manual' | 'startup' = 'fs-change'): boolean {
  if (!absPath || typeof absPath !== 'string') return false;
  if (!anyDbWantsFiles()) return false;
  return queue.enqueue('file', absPath, reason);
}

// ── Consumer ──────────────────────────────────────────────────────────────────

interface FileIngestResult {
  path: string;
  dbResults: Array<{
    dbId: string;
    written: number;
    skippedFiltered: number;
    skippedUnchanged?: boolean;
    skippedBinary?: boolean;
    skippedTooLarge?: boolean;
    skippedMissing?: boolean;
    error?: string;
  }>;
}

/** Ingest one file into every matching DB. Idempotent per-DB via mtime
 *  comparison. A deleted file triggers `deleteSource` on every matching DB
 *  (so the index doesn't dangle). */
async function ingestFile(absPath: string): Promise<FileIngestResult> {
  const out: FileIngestResult = { path: absPath, dbResults: [] };

  const targets = matchFile({ path: absPath });
  if (targets.length === 0) return out;

  // Deletion path: file no longer exists → wipe it from every matching DB.
  let stat: any;
  try {
    stat = fs.statSync(absPath);
  } catch (e: any) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
      for (const db of targets) {
        try {
          const { deleted } = deleteSource(db.id, 'file', absPath);
          out.dbResults.push({ dbId: db.id, written: 0, skippedFiltered: 0, skippedMissing: true });
          if (deleted > 0) {
            logger.info('context-rag.file.deleted-from-index', { dbId: db.id, path: absPath, deleted });
          }
        } catch (err) {
          out.dbResults.push({
            dbId: db.id, written: 0, skippedFiltered: 0, skippedMissing: true,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return out;
    }
    logger.warn('context-rag.file.stat-failed', {
      path: absPath, error: e instanceof Error ? e.message : String(e),
    });
    return out;
  }

  if (!stat.isFile()) {
    return out;
  }

  if (stat.size > MAX_FILE_BYTES) {
    for (const db of targets) {
      out.dbResults.push({ dbId: db.id, written: 0, skippedFiltered: 0, skippedTooLarge: true });
    }
    return out;
  }

  const fileMtime = Math.floor(stat.mtimeMs);

  // Read once; reuse for binary sniff + content.
  let buf: Buffer;
  try {
    buf = fs.readFileSync(absPath);
  } catch (e) {
    logger.warn('context-rag.file.read-failed', {
      path: absPath, error: e instanceof Error ? e.message : String(e),
    });
    return out;
  }

  if (_looksBinary(buf)) {
    for (const db of targets) {
      out.dbResults.push({ dbId: db.id, written: 0, skippedFiltered: 0, skippedBinary: true });
    }
    return out;
  }

  const text = buf.toString('utf8');
  const chunks = chunkText(text, {
    filePath: absPath,
    fileName: path.basename(absPath),
    fileMtime,
  });
  if (chunks.length === 0) return out;

  for (const db of targets) {
    // Skip if the DB already has this file's most-recent mtime. The
    // walker can re-enqueue freely and we still won't waste an embed call.
    const lastTs = _maxIngestedTs(db, absPath);
    if (lastTs !== null && lastTs >= fileMtime) {
      out.dbResults.push({ dbId: db.id, written: 0, skippedFiltered: 0, skippedUnchanged: true });
      continue;
    }

    // Per-chunk sensitivity gate. The file basename rides along as a hint;
    // the path is the absolute file path (so path-rule detectors like
    // ".env" / "secrets/" fire correctly).
    const title = path.basename(absPath);
    const survivors: typeof chunks = [];
    const tiers: string[] = [];
    const confs: number[] = [];
    let dropped = 0;
    for (const chunk of chunks) {
      const verdict = classifyAndGate(db.sensitivity, {
        text: chunk.text,
        title,
        path: absPath,
      });
      if (!verdict.pass) { dropped++; continue; }
      survivors.push(chunk);
      tiers.push(verdict.tier);
      confs.push(verdict.confidence);
    }
    if (survivors.length === 0) {
      // Wipe any prior chunks for this file in this DB — its content has
      // shifted to something the filter rejects.
      try { deleteSource(db.id, 'file', absPath); } catch (_) { /* ignore */ }
      out.dbResults.push({ dbId: db.id, written: 0, skippedFiltered: dropped });
      continue;
    }

    let client;
    try {
      client = clientForDB(db);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn('context-rag.file.client-failed', { dbId: db.id, path: absPath, error: msg });
      out.dbResults.push({ dbId: db.id, written: 0, skippedFiltered: dropped, error: msg });
      continue;
    }

    try {
      // Replace-on-update: delete prior chunks for this file in this DB
      // before inserting fresh ones. Otherwise a file that shrunk would
      // leave stale chunk_index rows around. deleteSource is a no-op when
      // there's nothing to remove (first-time ingest).
      try { deleteSource(db.id, 'file', absPath); } catch (_) { /* ignore */ }

      let totalWritten = 0;
      for (let i = 0; i < survivors.length; i += MAX_BATCH_EMBED) {
        const slice  = survivors.slice(i, i + MAX_BATCH_EMBED);
        const texts  = slice.map((c) => c.text);
        const vectors = await client.embedBatch(texts);
        const rows: ChunkUpsert[] = slice.map((c, j) => ({
          sourceKind:      'file',
          sourceId:        absPath,
          sourcePath:      absPath,
          chunkIndex:      c.index,
          text:            c.text,
          embedding:       vectors[j],
          sensitivityTier: tiers[i + j] as any,
          sensitivityConf: confs[i + j],
          metadata: {
            ...c.metadata,
            fileName: title,
          },
          ts: fileMtime,
        }));
        const { written } = upsertChunks(db.id, rows);
        totalWritten += written;
      }
      out.dbResults.push({ dbId: db.id, written: totalWritten, skippedFiltered: dropped });
      logger.info('context-rag.file.ingested', {
        dbId: db.id, path: absPath, written: totalWritten, droppedBySensitivity: dropped,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn('context-rag.file.embed-failed', {
        dbId: db.id, path: absPath, error: msg,
      });
      try { deleteSource(db.id, 'file', absPath); } catch (_) { /* ignore */ }
      out.dbResults.push({ dbId: db.id, written: 0, skippedFiltered: dropped, error: msg });
    }
  }
  return out;
}

export {
  enqueueFileForRag,
  ingestFile,
  MAX_BATCH_EMBED,
  MAX_FILE_BYTES,
};
export type { FileIngestResult };
