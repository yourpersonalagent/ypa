// ── context-rag session ingest ────────────────────────────────────────────────
// Responsibility for the `session` source kind: queue producers + the
// per-session ingest worker called by `runner.ts`.
//
// Producers:
//   - enqueueForRag(sid)          → chain hand-off from auto-title
//   - scanAndEnqueueOnStartup()   → boot scan over `displaySessions`
//
// Consumer:
//   - ingestSession(sid)          → extract turns → chunk → per-DB:
//                                     skip if already ingested in that DB,
//                                     gate each chunk by sensitivity,
//                                     embed surviving chunks,
//                                     upsert via vector-store/db-instance.
//
// "Already ingested" is checked by counting rows in `rag_chunks` keyed by
// (source_kind='session', source_id=sid). A future `lastIngestedAt` check
// will let us re-ingest sessions that grew after their first pass, but v1
// keeps it simple: once ingested, the session is skipped in that DB unless
// a manual force-rebuild runs.
'use strict';

const logger = require('../../../../core/logger');

import * as queue        from './queue';
import { matchSession, anyDbWantsSessions } from '../registry/matcher';
import { chunkSession }  from './chunker';
import { classifyAndGate } from './sensitivity-gate';
import { clientForDB }   from '../embed/client-for-db';
import {
  getHandle,
  upsertChunks,
  deleteSource,
} from '../vector-store/db-instance';
import type { VectorDB }     from '../registry/types';
import type { ChunkUpsert }  from '../vector-store/db-instance';

const MAX_BATCH_EMBED = 16; // upper bound on chunks per /v1/embeddings call

function _sessionCwd(s: any): string | null {
  if (!s) return null;
  const cwd = s.workingDir || s.cwd || s._cwd || null;
  return typeof cwd === 'string' && cwd.startsWith('/') ? cwd : null;
}

function _alreadyIngestedInDB(db: VectorDB, sid: string): boolean {
  try {
    const handle = getHandle(db.id);
    const row = handle
      .prepare(`SELECT 1 AS hit FROM rag_chunks WHERE source_kind = 'session' AND source_id = ? LIMIT 1`)
      .get(sid) as { hit: number } | undefined;
    return !!row;
  } catch (e) {
    logger.warn('context-rag.session.check-failed', {
      dbId: db.id, sid, error: e instanceof Error ? e.message : String(e),
    });
    return false;
  }
}

// ── Public producers ─────────────────────────────────────────────────────────

/** Chain hand-off from auto-title. Cheap: just enqueues. The runner picks
 *  it up on the next watchdog tick or via an immediate `kickContextRag()`. */
function enqueueForRag(sid: string, reason: 'finalize' | 'manual' = 'finalize'): boolean {
  if (!sid) return false;
  if (!anyDbWantsSessions()) return false;
  return queue.enqueue('session', sid, reason);
}

/** Boot scan. Walks displaySessions and enqueues every session that is
 *  matched by at least one DB. The per-DB "already ingested" check during
 *  processing throws out the no-op cases so the queue does some redundant
 *  work but never duplicate embedding. */
function scanAndEnqueueOnStartup(): { enqueued: number; skipped: number } {
  if (!anyDbWantsSessions()) return { enqueued: 0, skipped: 0 };
  let enqueued = 0;
  let skipped  = 0;
  try {
    const { displaySessions } = require('../../../../core/state');
    for (const [sid, s] of displaySessions as Map<string, any>) {
      if (!s || s._inMemoryOnly) { skipped++; continue; }
      // Only sessions that actually have content
      if (!Array.isArray(s.messages) || s.messages.length === 0) { skipped++; continue; }
      const matches = matchSession({ cwd: _sessionCwd(s) });
      if (matches.length === 0) { skipped++; continue; }
      if (queue.enqueue('session', sid, 'startup')) enqueued++;
      else skipped++;
    }
  } catch (e) {
    logger.warn('context-rag.session.startup-scan-failed', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  if (enqueued > 0) {
    logger.info('context-rag.session.startup-enqueued', { enqueued, skipped });
  }
  return { enqueued, skipped };
}

// ── Consumer ─────────────────────────────────────────────────────────────────

interface IngestResult {
  sid: string;
  dbResults: Array<{
    dbId: string;
    written: number;
    skippedFiltered: number;
    skippedAlreadyIngested?: boolean;
    error?: string;
  }>;
}

/** Ingest one session into every matching DB. Idempotent per-DB: a DB that
 *  already has chunks for `sid` is skipped. Errors are scoped to a single DB
 *  so one bad provider doesn't block ingest into siblings. */
async function ingestSession(sid: string): Promise<IngestResult> {
  const out: IngestResult = { sid, dbResults: [] };
  const { displaySessions } = require('../../../../core/state');
  const session = (displaySessions as Map<string, any>).get(sid);
  if (!session) {
    logger.warn('context-rag.session.missing', { sid });
    return out;
  }

  const sessionCwd = _sessionCwd(session);
  const targets = matchSession({ cwd: sessionCwd });
  if (targets.length === 0) return out;

  const chunks = chunkSession(session);
  if (chunks.length === 0) {
    // Empty / scaffold-only sessions land here; treat as a no-op success so
    // a finalize chain handoff doesn't keep reappearing in the queue.
    return out;
  }

  for (const db of targets) {
    if (_alreadyIngestedInDB(db, sid)) {
      out.dbResults.push({ dbId: db.id, written: 0, skippedFiltered: 0, skippedAlreadyIngested: true });
      continue;
    }

    // Per-chunk sensitivity gate. The session title rides along as a
    // detector hint; path is the working_dir (path rules fire on that).
    const title = (session.name || '').toString();
    const survivors: typeof chunks = [];
    const tiers: string[] = [];
    const confs: number[] = [];
    let dropped = 0;
    for (const chunk of chunks) {
      const verdict = classifyAndGate(db.sensitivity, {
        text:  chunk.text,
        title,
        path:  sessionCwd,
      });
      if (!verdict.pass) { dropped++; continue; }
      survivors.push(chunk);
      tiers.push(verdict.tier);
      confs.push(verdict.confidence);
    }
    if (survivors.length === 0) {
      out.dbResults.push({ dbId: db.id, written: 0, skippedFiltered: dropped });
      continue;
    }

    // Embed in batches (max MAX_BATCH_EMBED chunks per call) to stay friendly
    // with provider request-size caps. Order is preserved by the adapter.
    let client;
    try {
      client = clientForDB(db);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn('context-rag.session.client-failed', { dbId: db.id, sid, error: msg });
      out.dbResults.push({ dbId: db.id, written: 0, skippedFiltered: dropped, error: msg });
      continue;
    }

    try {
      let totalWritten = 0;
      for (let i = 0; i < survivors.length; i += MAX_BATCH_EMBED) {
        const slice  = survivors.slice(i, i + MAX_BATCH_EMBED);
        const texts  = slice.map((c) => c.text);
        const vectors = await client.embedBatch(texts);
        const rows: ChunkUpsert[] = slice.map((c, j) => ({
          sourceKind:      'session',
          sourceId:        sid,
          sourcePath:      sessionCwd,
          chunkIndex:      c.index,
          text:            c.text,
          embedding:       vectors[j],
          sensitivityTier: tiers[i + j] as any,
          sensitivityConf: confs[i + j],
          metadata: {
            ...c.metadata,
            sessionName: title,
            sessionId:   sid,
          },
          ts: typeof session.updatedAt === 'number' ? session.updatedAt : Date.now(),
        }));
        const { written } = upsertChunks(db.id, rows);
        totalWritten += written;
      }
      out.dbResults.push({ dbId: db.id, written: totalWritten, skippedFiltered: dropped });
      logger.info('context-rag.session.ingested', {
        dbId: db.id, sid, written: totalWritten, droppedBySensitivity: dropped,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn('context-rag.session.embed-failed', {
        dbId: db.id, sid, error: msg,
      });
      // Best-effort: don't leave a half-ingested session in this DB. The
      // upsert layer is transactional per-batch but a multi-batch session
      // can partially commit if batch-2 fails. Wipe so the next pass can
      // re-ingest cleanly.
      try { deleteSource(db.id, 'session', sid); } catch (_) { /* ignore */ }
      out.dbResults.push({ dbId: db.id, written: 0, skippedFiltered: dropped, error: msg });
    }
  }
  return out;
}

export {
  enqueueForRag,
  scanAndEnqueueOnStartup,
  ingestSession,
  MAX_BATCH_EMBED,
};
export type { IngestResult };
