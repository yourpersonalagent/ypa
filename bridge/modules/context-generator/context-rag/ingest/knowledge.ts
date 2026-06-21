// ── context-rag knowledge ingest ──────────────────────────────────────────────
// Per-note half of the knowledge producer. Knowledge = user-curated markdown
// notes in `docs/keep-notes/*.md` (the same corpus the file-categorizer
// frontmatters and the QuickPicker surfaces as `cat=keep-notes`). The writers
// — vault-import, link sync, file-categorizer, admin-frontmatter — call
// `enqueueKnowledgeForRag()` after persisting; the boot scan walks the dir
// on cold start.
//
// Why a separate `knowledge` kind rather than treating notes as files:
//
//   1. Different routing rule. The registry's `KnowledgeSource = {mode:'all'|'off'}`
//      is binary — a DB either wants all notes or none — whereas files use
//      cwd/roots scoping. Keep-notes are global by design; the user keeps
//      them in one place and expects them to be searchable from everywhere.
//   2. Frontmatter is semantic, not noise. The file-categorizer writes a
//      YAML preamble (category/tags/keywords/sensitivity); the chunker would
//      otherwise embed it as text. We strip it from the body and lift its
//      sensitivity field into the gate.
//   3. Search surface is distinguishable. Hits come back with
//      `sourceKind:'knowledge'` so the picker can filter to notes-only
//      and the MCP `rag_search` tool surfaces a typed result.
//
// Mirrors `files.ts` structurally:
//   - sourceId IS the absolute path (stable across edits; the writer always
//     emits the full path).
//   - idempotency uses the same mtime short-circuit as files.
//   - chunking uses `chunkText()` (char-window) — notes have no turn structure.
//   - deletion path: missing file → `deleteSource` on every matching DB.
'use strict';

const fs     = require('fs');
const path   = require('path');
const logger = require('../../../../core/logger');

import * as queue from './queue';
import { matchKnowledge, anyDbWantsKnowledge } from '../registry/matcher';
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
/** Notes larger than this are skipped — same cap as files; protects against a
 *  user pasting a giant transcript into a single .md by mistake. */
const MAX_NOTE_BYTES = 1_000_000;

// Per-user (Q16 A.4) — keep-notes live under the user's docs folder.
// Legacy fallback: `<repo>/docs/keep-notes/`.
// Post-migration: `bridge/users/<email>/docs/keep-notes/`.
// YHA_CONTEXT_RAG_KEEP_NOTES_DIR overrides for tests (resolved once at module
// load — flipping it at runtime won't work).
const KEEP_NOTES_DIR = process.env.YHA_CONTEXT_RAG_KEEP_NOTES_DIR
  || path.join(require('../../../../core/paths').userDocsDir, 'keep-notes');

// ── Frontmatter parsing ───────────────────────────────────────────────────────

interface FrontmatterFields {
  category:    string | null;
  topics:      string[];
  tags:        string[];
  keywords:    string[];
  /** One of 'public' | 'private' | 'system', or null if absent / unrecognized. */
  sensitivity: 'public' | 'private' | 'system' | null;
}

/** Parse the leading `---\n…\n---` block. Tolerant single-line YAML extractor
 *  matching the writer side (routes-items + file-categorizer). Returns empty
 *  fields when no frontmatter is present. The second return value is the
 *  byte offset where the body starts — callers use it to strip the preamble. */
function _readFrontmatter(buf: string): { fm: FrontmatterFields; bodyStart: number } {
  const empty: FrontmatterFields = {
    category: null, topics: [], tags: [], keywords: [], sensitivity: null,
  };
  if (!buf.startsWith('---\n')) return { fm: empty, bodyStart: 0 };
  const end = buf.indexOf('\n---', 4);
  if (end < 0) return { fm: empty, bodyStart: 0 };
  const fmText = buf.slice(4, end);
  const bodyStart = end + '\n---'.length;

  function get(key: string): string {
    const m = new RegExp(`^${key}\\s*:\\s*(.*)$`, 'm').exec(fmText);
    return m ? m[1].trim() : '';
  }
  function getList(key: string): string[] {
    const raw = get(key);
    if (!raw) return [];
    if (raw.startsWith('[') && raw.endsWith(']')) {
      return raw.slice(1, -1).split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    }
    return [raw];
  }
  const rawSens = get('sensitivity').replace(/^["']|["']$/g, '');
  const sensitivity = /^(public|private|system)$/.test(rawSens) ? rawSens as FrontmatterFields['sensitivity'] : null;

  return {
    fm: {
      category:    get('category').replace(/^["']|["']$/g, '') || null,
      topics:      getList('topics'),
      tags:        getList('tags'),
      keywords:    getList('keywords'),
      sensitivity,
    },
    bodyStart,
  };
}

/** Returns the max `ts` over chunks the DB already has for this note, or
 *  null when the note isn't represented. Mirrors files.ts. */
function _maxIngestedTs(db: VectorDB, absPath: string): number | null {
  try {
    const handle = getHandle(db.id);
    const row = handle
      .prepare(`SELECT MAX(ts) AS maxTs FROM rag_chunks WHERE source_kind = 'knowledge' AND source_id = ?`)
      .get(absPath) as { maxTs: number | null } | undefined;
    if (!row || row.maxTs == null) return null;
    return Number(row.maxTs);
  } catch (e) {
    logger.warn('context-rag.knowledge.check-failed', {
      dbId: db.id, path: absPath, error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

// ── Public producers ──────────────────────────────────────────────────────────

/** Chain-style enqueue from any keep-note writer (vault import, LINK sync,
 *  file-categorizer, admin frontmatter). Cheap: short-circuits when no DB
 *  wants knowledge at all. Accepts absolute paths only — relative paths
 *  silently no-op so a misuse never poisons the queue. */
function enqueueKnowledgeForRag(
  absPath: string,
  reason: 'write' | 'manual' | 'startup' | 'fs-change' = 'write',
): boolean {
  if (!absPath || typeof absPath !== 'string') return false;
  if (!absPath.startsWith('/')) return false;
  // Only paths under the keep-notes dir are valid knowledge sources today.
  // The categorizer fires for files in `docs/notes`, `docs/mail`, etc. too;
  // those aren't curated knowledge and have their own ingest path (files).
  if (!absPath.startsWith(KEEP_NOTES_DIR + path.sep) && absPath !== KEEP_NOTES_DIR) {
    return false;
  }
  if (!anyDbWantsKnowledge()) return false;
  return queue.enqueue('knowledge', absPath, reason);
}

/** Boot scan: walk `docs/keep-notes/*.md` and enqueue each. The per-DB
 *  mtime short-circuit in `ingestKnowledge` keeps re-runs cheap. */
function scanAndEnqueueAllKnowledgeDbs(): { enqueued: number; scanned: number; skipped: number } {
  if (!anyDbWantsKnowledge()) return { enqueued: 0, scanned: 0, skipped: 0 };
  let enqueued = 0;
  let scanned  = 0;
  let skipped  = 0;
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(KEEP_NOTES_DIR);
  } catch (e: any) {
    if (e && e.code === 'ENOENT') {
      // Keep-notes dir doesn't exist yet — first vault import will create it.
      return { enqueued: 0, scanned: 0, skipped: 0 };
    }
    logger.warn('context-rag.knowledge.startup-scan-failed', {
      error: e instanceof Error ? e.message : String(e),
    });
    return { enqueued: 0, scanned: 0, skipped: 0 };
  }
  for (const f of entries) {
    // Skip non-md and hidden files (the QuickPicker mirrors this — see
    // `_scanFileCategory` in routes-items.ts).
    if (!f.endsWith('.md')) { skipped++; continue; }
    if (f.startsWith('_') || f.startsWith('.')) { skipped++; continue; }
    const full = path.join(KEEP_NOTES_DIR, f);
    let stat;
    try { stat = fs.statSync(full); } catch (_) { skipped++; continue; }
    if (!stat.isFile()) { skipped++; continue; }
    scanned++;
    if (queue.enqueue('knowledge', full, 'startup')) enqueued++;
    else skipped++;
  }
  if (enqueued > 0) {
    logger.info('context-rag.knowledge.startup-enqueued', { enqueued, scanned, skipped });
  }
  return { enqueued, scanned, skipped };
}

// ── Consumer ──────────────────────────────────────────────────────────────────

interface KnowledgeIngestResult {
  path: string;
  dbResults: Array<{
    dbId: string;
    written: number;
    skippedFiltered: number;
    skippedUnchanged?: boolean;
    skippedTooLarge?: boolean;
    skippedMissing?: boolean;
    skippedFrontmatterSensitivity?: boolean;
    error?: string;
  }>;
}

/** Ingest one keep-note into every matching DB. Idempotent per-DB via mtime
 *  comparison. A deleted note triggers `deleteSource` on every matching DB. */
async function ingestKnowledge(absPath: string): Promise<KnowledgeIngestResult> {
  const out: KnowledgeIngestResult = { path: absPath, dbResults: [] };

  const targets = matchKnowledge();
  if (targets.length === 0) return out;

  // Deletion path: note no longer exists → wipe it from every DB.
  let stat: any;
  try {
    stat = fs.statSync(absPath);
  } catch (e: any) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
      for (const db of targets) {
        try {
          const { deleted } = deleteSource(db.id, 'knowledge', absPath);
          out.dbResults.push({ dbId: db.id, written: 0, skippedFiltered: 0, skippedMissing: true });
          if (deleted > 0) {
            logger.info('context-rag.knowledge.deleted-from-index', { dbId: db.id, path: absPath, deleted });
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
    logger.warn('context-rag.knowledge.stat-failed', {
      path: absPath, error: e instanceof Error ? e.message : String(e),
    });
    return out;
  }

  if (!stat.isFile()) return out;

  if (stat.size > MAX_NOTE_BYTES) {
    for (const db of targets) {
      out.dbResults.push({ dbId: db.id, written: 0, skippedFiltered: 0, skippedTooLarge: true });
    }
    return out;
  }

  const noteMtime = Math.floor(stat.mtimeMs);
  const title = path.basename(absPath).replace(/\.md$/i, '');

  let buf: string;
  try {
    buf = fs.readFileSync(absPath, 'utf8');
  } catch (e) {
    logger.warn('context-rag.knowledge.read-failed', {
      path: absPath, error: e instanceof Error ? e.message : String(e),
    });
    return out;
  }

  const { fm, bodyStart } = _readFrontmatter(buf);
  const body = buf.slice(bodyStart).replace(/^\s+/, '');
  if (!body.trim()) {
    // Empty note (frontmatter only or whitespace) — wipe any prior chunks
    // and treat as a successful no-op so the queue doesn't loop on it.
    for (const db of targets) {
      try { deleteSource(db.id, 'knowledge', absPath); } catch (_) { /* ignore */ }
      out.dbResults.push({ dbId: db.id, written: 0, skippedFiltered: 0 });
    }
    return out;
  }

  const chunks = chunkText(body, {
    filePath: absPath,
    fileName: title,
    fileMtime: noteMtime,
  });
  if (chunks.length === 0) return out;

  for (const db of targets) {
    // Frontmatter-level sensitivity check FIRST — wins over the per-chunk
    // classifier. A note tagged `sensitivity: private` in a DB that
    // excludes private is rejected wholesale; we don't waste a classifier
    // pass on something the user already marked.
    if (fm.sensitivity) {
      const includes = db.sensitivity.include.includes(fm.sensitivity);
      const excludes = db.sensitivity.exclude.includes(fm.sensitivity);
      if (!includes || excludes) {
        // Wipe any prior chunks — the note may have flipped from public to
        // private since last ingest.
        try { deleteSource(db.id, 'knowledge', absPath); } catch (_) { /* ignore */ }
        out.dbResults.push({
          dbId: db.id, written: 0, skippedFiltered: 0,
          skippedFrontmatterSensitivity: true,
        });
        continue;
      }
    }

    // mtime short-circuit (same shape as files.ts).
    const lastTs = _maxIngestedTs(db, absPath);
    if (lastTs !== null && lastTs >= noteMtime) {
      out.dbResults.push({ dbId: db.id, written: 0, skippedFiltered: 0, skippedUnchanged: true });
      continue;
    }

    // Per-chunk sensitivity gate. If frontmatter declared a tier the gate
    // uses it as the floor (via the classifier's title/path hints); without
    // frontmatter the classifier runs its full detector chain.
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
      // If frontmatter pinned the tier, prefer it over the classifier's guess.
      const tier = fm.sensitivity || verdict.tier;
      survivors.push(chunk);
      tiers.push(tier);
      confs.push(fm.sensitivity ? 1.0 : verdict.confidence);
    }
    if (survivors.length === 0) {
      try { deleteSource(db.id, 'knowledge', absPath); } catch (_) { /* ignore */ }
      out.dbResults.push({ dbId: db.id, written: 0, skippedFiltered: dropped });
      continue;
    }

    let client;
    try {
      client = clientForDB(db);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn('context-rag.knowledge.client-failed', { dbId: db.id, path: absPath, error: msg });
      out.dbResults.push({ dbId: db.id, written: 0, skippedFiltered: dropped, error: msg });
      continue;
    }

    try {
      // Replace-on-update: clean slate per DB before re-inserting.
      try { deleteSource(db.id, 'knowledge', absPath); } catch (_) { /* ignore */ }

      let totalWritten = 0;
      for (let i = 0; i < survivors.length; i += MAX_BATCH_EMBED) {
        const slice   = survivors.slice(i, i + MAX_BATCH_EMBED);
        const texts   = slice.map((c) => c.text);
        const vectors = await client.embedBatch(texts);
        const rows: ChunkUpsert[] = slice.map((c, j) => ({
          sourceKind:      'knowledge',
          sourceId:        absPath,
          sourcePath:      absPath,
          chunkIndex:      c.index,
          text:            c.text,
          embedding:       vectors[j],
          sensitivityTier: tiers[i + j] as any,
          sensitivityConf: confs[i + j],
          metadata: {
            ...c.metadata,
            noteTitle: title,
            category:  fm.category || 'keep-notes',
            tags:      fm.tags,
            keywords:  fm.keywords,
            topics:    fm.topics,
          },
          ts: noteMtime,
        }));
        const { written } = upsertChunks(db.id, rows);
        totalWritten += written;
      }
      out.dbResults.push({ dbId: db.id, written: totalWritten, skippedFiltered: dropped });
      logger.info('context-rag.knowledge.ingested', {
        dbId: db.id, path: absPath, written: totalWritten, droppedBySensitivity: dropped,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn('context-rag.knowledge.embed-failed', {
        dbId: db.id, path: absPath, error: msg,
      });
      try { deleteSource(db.id, 'knowledge', absPath); } catch (_) { /* ignore */ }
      out.dbResults.push({ dbId: db.id, written: 0, skippedFiltered: dropped, error: msg });
    }
  }
  return out;
}

export {
  enqueueKnowledgeForRag,
  scanAndEnqueueAllKnowledgeDbs,
  ingestKnowledge,
  KEEP_NOTES_DIR,
  MAX_BATCH_EMBED,
  MAX_NOTE_BYTES,
};
export type { KnowledgeIngestResult };
