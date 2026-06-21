// ── context-rag synthesis ingest ──────────────────────────────────────────────
// Per-page half of the synthesis producer. Synthesis pages = curated markdown
// the cwd-synthesize skill distills under
// `bridge/knowledge/dirs/<slug>/synthesis/*.md`. Empirically these rerank
// above raw session chunks for concept→jargon queries (the federation-grill
// doc landed #1 with the only positive rerank score in our test), so they get
// their own source kind and routing rules instead of being lumped in with
// keep-notes.
//
// Why a separate kind rather than reusing `knowledge`:
//
//   1. Different scoping. Keep-notes are global by design (one folder, one
//      "all" mode). Synthesis is per-cwd by construction — each cwd has its
//      own bucket. The matcher needs to know which bucket the page came from
//      to route to `mode==='cwd'` DBs correctly.
//   2. Frontmatter shape is different. Synthesis pages carry source_sha /
//      source_paths / status / superseded_by — fields the keep-note parser
//      doesn't understand. We strip them and lift a few into metadata.
//   3. Search surface is distinguishable. `sourceKind:'synthesis'` lets the
//      MCP picker / UI filter to distilled docs only, separately from raw
//      notes.
//
// sourceId IS the absolute path to the .md file (same idempotency story as
// files/knowledge). The bucket cwd is derived from the file path so the
// matcher can scope cwd-mode DBs without an extra producer argument.
'use strict';

const fs     = require('fs');
const path   = require('path');
const logger = require('../../../../core/logger');

import * as queue from './queue';
import {
  matchSynthesis,
  anyDbWantsSynthesis,
  synthesisCwdsForScan,
} from '../registry/matcher';
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
/** Synthesis pages above this cap are skipped — a single page that big is
 *  almost certainly a generation accident, not a curated doc. */
const MAX_PAGE_BYTES = 1_000_000;

const PATHS              = require('../../../../core/paths');
const SYNTHESIS_ROOT_DIR = process.env.YHA_CONTEXT_RAG_SYNTHESIS_DIR
  || path.join(PATHS.knowledgeRoot, 'dirs');

// ── Path helpers ──────────────────────────────────────────────────────────────

/** Slug for a cwd, mirroring synth-status.mjs and the knowledge MCP. */
function _slugForCwd(cwd: string): string {
  return cwd.replace(/^\//, '').replace(/\//g, '___');
}

/** Bucket directory for a cwd. The synthesizer writes here. */
function bucketDirForCwd(cwd: string): string {
  return path.join(SYNTHESIS_ROOT_DIR, _slugForCwd(cwd), 'synthesis');
}

/** Given the absolute path of a synthesis page, recover the cwd whose bucket
 *  it lives in. Returns null when the path doesn't look like a synthesis page
 *  under SYNTHESIS_ROOT_DIR. */
function _bucketCwdForPath(absPath: string): string | null {
  if (!absPath.startsWith(SYNTHESIS_ROOT_DIR + path.sep)) return null;
  // Path shape: <root>/<slug>/synthesis/<sub.../>file.md
  const tail = absPath.slice(SYNTHESIS_ROOT_DIR.length + 1);
  const parts = tail.split(path.sep);
  if (parts.length < 3) return null;
  if (parts[1] !== 'synthesis') return null;
  const slug = parts[0];
  // Unslug: slug "home___user___foo" → "/home/user/foo".
  return '/' + slug.replace(/___/g, '/');
}

// ── Frontmatter parsing ───────────────────────────────────────────────────────

interface FrontmatterFields {
  status:        string | null;
  superseded_by: string | null;
  module:        string | null;
  page:          string | null;
  topics:        string[];
  tags:          string[];
  source_paths:  string[];
  /** One of 'public' | 'private' | 'system', or null if absent. */
  sensitivity:   'public' | 'private' | 'system' | null;
}

function _readFrontmatter(buf: string): { fm: FrontmatterFields; bodyStart: number } {
  const empty: FrontmatterFields = {
    status: null, superseded_by: null, module: null, page: null,
    topics: [], tags: [], source_paths: [], sensitivity: null,
  };
  if (!buf.startsWith('---\n')) return { fm: empty, bodyStart: 0 };
  const end = buf.indexOf('\n---', 4);
  if (end < 0) return { fm: empty, bodyStart: 0 };
  const fmText = buf.slice(4, end);
  const bodyStart = end + '\n---'.length;

  // Tolerant single-line YAML extractor matching the synth-status tool.
  const out: Record<string, any> = {};
  let listKey: string | null = null;
  for (const line of fmText.split('\n')) {
    if (/^\s*#/.test(line) || !line.trim()) continue;
    const indented = /^\s+/.test(line);
    const trimmed = line.trim();
    if (!indented) {
      listKey = null;
      const m = /^([a-zA-Z_][\w-]*):\s*(.*)$/.exec(trimmed);
      if (!m) continue;
      const key = m[1];
      const val = m[2];
      if (val === '' || val === '|' || val === '>') {
        out[key] = [];
        listKey = key;
      } else {
        out[key] = val.replace(/^["']|["']$/g, '');
      }
    } else if (listKey && trimmed.startsWith('- ')) {
      (out[listKey] as string[]).push(trimmed.slice(2).trim().replace(/^["']|["']$/g, ''));
    }
  }

  const rawSens = (out.sensitivity ?? '').replace(/^["']|["']$/g, '');
  const sensitivity = /^(public|private|system)$/.test(rawSens) ? rawSens as FrontmatterFields['sensitivity'] : null;

  return {
    fm: {
      status:        (out.status ?? null) || null,
      superseded_by: (out.superseded_by ?? null) || null,
      module:        (out.module ?? null) || null,
      page:          (out.page ?? null) || null,
      topics:        Array.isArray(out.topics) ? out.topics : [],
      tags:          Array.isArray(out.tags) ? out.tags : [],
      source_paths:  Array.isArray(out.source_paths) ? out.source_paths : [],
      sensitivity,
    },
    bodyStart,
  };
}

/** Max `ts` over chunks the DB already has for this synthesis page. */
function _maxIngestedTs(db: VectorDB, absPath: string): number | null {
  try {
    const handle = getHandle(db.id);
    const row = handle
      .prepare(`SELECT MAX(ts) AS maxTs FROM rag_chunks WHERE source_kind = 'synthesis' AND source_id = ?`)
      .get(absPath) as { maxTs: number | null } | undefined;
    if (!row || row.maxTs == null) return null;
    return Number(row.maxTs);
  } catch (e) {
    logger.warn('context-rag.synthesis.check-failed', {
      dbId: db.id, path: absPath, error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }
}

// ── Public producers ──────────────────────────────────────────────────────────

/** Chain-style enqueue from the synthesizer skill or fs-watcher. Cheap:
 *  short-circuits when no DB wants synthesis. Absolute paths only. */
function enqueueSynthesisForRag(
  absPath: string,
  reason: 'write' | 'manual' | 'startup' | 'fs-change' = 'write',
): boolean {
  if (!absPath || typeof absPath !== 'string') return false;
  if (!absPath.startsWith('/')) return false;
  if (!absPath.endsWith('.md')) return false;
  if (!absPath.startsWith(SYNTHESIS_ROOT_DIR + path.sep)) return false;
  if (!anyDbWantsSynthesis()) return false;
  // Verify the path resolves to a real bucket cwd and a DB actually accepts it.
  const bucketCwd = _bucketCwdForPath(absPath);
  if (!bucketCwd) return false;
  if (matchSynthesis({ bucketCwd }).length === 0) return false;
  return queue.enqueue('synthesis', absPath, reason);
}

/** Walk one bucket and enqueue every .md page. Skips index.md / log.md the
 *  same way synth-status.mjs does (they're navigation, not content). */
function _scanBucket(bucketDir: string): { enqueued: number; scanned: number; skipped: number } {
  let enqueued = 0;
  let scanned  = 0;
  let skipped  = 0;
  function _walk(dir: string): void {
    let entries: any[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (_) { return; }
    for (const entry of entries) {
      if (entry.name.startsWith('.')) { skipped++; continue; }
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { _walk(full); continue; }
      if (!entry.isFile() || !entry.name.endsWith('.md')) { skipped++; continue; }
      // Navigation files — match synth-status.mjs.
      if (entry.name === 'index.md' || entry.name === 'log.md') { skipped++; continue; }
      // Same hidden/underscore prefix rule as knowledge.ts: leading _ files
      // are stubs or scratch.
      if (entry.name.startsWith('_')) { skipped++; continue; }
      scanned++;
      if (queue.enqueue('synthesis', full, 'startup')) enqueued++;
      else skipped++;
    }
  }
  _walk(bucketDir);
  return { enqueued, scanned, skipped };
}

/** Boot scan: walk every bucket at least one DB wants. */
function scanAndEnqueueAllSynthesisDbs(): { enqueued: number; scanned: number; skipped: number } {
  if (!anyDbWantsSynthesis()) return { enqueued: 0, scanned: 0, skipped: 0 };
  const { allBuckets, cwds } = synthesisCwdsForScan();

  let enqueued = 0;
  let scanned  = 0;
  let skipped  = 0;

  const buckets = new Set<string>();
  if (allBuckets) {
    // Walk every <slug>/synthesis/ under the root dir.
    let slugs: string[];
    try { slugs = fs.readdirSync(SYNTHESIS_ROOT_DIR); }
    catch (e: any) {
      if (e && e.code === 'ENOENT') return { enqueued: 0, scanned: 0, skipped: 0 };
      logger.warn('context-rag.synthesis.startup-scan-failed', {
        error: e instanceof Error ? e.message : String(e),
      });
      return { enqueued: 0, scanned: 0, skipped: 0 };
    }
    for (const slug of slugs) {
      const bucket = path.join(SYNTHESIS_ROOT_DIR, slug, 'synthesis');
      try {
        const st = fs.statSync(bucket);
        if (!st.isDirectory()) continue;
      } catch (_) { continue; }
      buckets.add(bucket);
    }
  }
  for (const cwd of cwds) buckets.add(bucketDirForCwd(cwd));

  for (const bucket of buckets) {
    const r = _scanBucket(bucket);
    enqueued += r.enqueued;
    scanned  += r.scanned;
    skipped  += r.skipped;
  }

  if (enqueued > 0) {
    logger.info('context-rag.synthesis.startup-enqueued', {
      enqueued, scanned, skipped, buckets: buckets.size,
    });
  }
  return { enqueued, scanned, skipped };
}

// ── Consumer ──────────────────────────────────────────────────────────────────

interface SynthesisIngestResult {
  path: string;
  dbResults: Array<{
    dbId: string;
    written: number;
    skippedFiltered: number;
    skippedUnchanged?: boolean;
    skippedTooLarge?: boolean;
    skippedMissing?: boolean;
    skippedSuperseded?: boolean;
    skippedFrontmatterSensitivity?: boolean;
    error?: string;
  }>;
}

/** Ingest one synthesis page into every matching DB. */
async function ingestSynthesis(absPath: string): Promise<SynthesisIngestResult> {
  const out: SynthesisIngestResult = { path: absPath, dbResults: [] };

  const bucketCwd = _bucketCwdForPath(absPath);
  if (!bucketCwd) {
    // Path doesn't look like a synthesis page — silently no-op so a misfired
    // enqueue doesn't poison the queue.
    return out;
  }
  const targets = matchSynthesis({ bucketCwd });
  if (targets.length === 0) return out;

  // Deletion path: page no longer exists → wipe it from every matching DB.
  let stat: any;
  try {
    stat = fs.statSync(absPath);
  } catch (e: any) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) {
      for (const db of targets) {
        try {
          const { deleted } = deleteSource(db.id, 'synthesis', absPath);
          out.dbResults.push({ dbId: db.id, written: 0, skippedFiltered: 0, skippedMissing: true });
          if (deleted > 0) {
            logger.info('context-rag.synthesis.deleted-from-index', { dbId: db.id, path: absPath, deleted });
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
    logger.warn('context-rag.synthesis.stat-failed', {
      path: absPath, error: e instanceof Error ? e.message : String(e),
    });
    return out;
  }

  if (!stat.isFile()) return out;

  if (stat.size > MAX_PAGE_BYTES) {
    for (const db of targets) {
      out.dbResults.push({ dbId: db.id, written: 0, skippedFiltered: 0, skippedTooLarge: true });
    }
    return out;
  }

  const pageMtime = Math.floor(stat.mtimeMs);
  const title = path.basename(absPath).replace(/\.md$/i, '');

  let buf: string;
  try {
    buf = fs.readFileSync(absPath, 'utf8');
  } catch (e) {
    logger.warn('context-rag.synthesis.read-failed', {
      path: absPath, error: e instanceof Error ? e.message : String(e),
    });
    return out;
  }

  const { fm, bodyStart } = _readFrontmatter(buf);

  // Superseded pages are link-preservation stubs — they don't carry current
  // information and should not be indexed. Wipe prior chunks so a flip from
  // 'current' → 'superseded' actually evicts the doc.
  if (fm.status === 'superseded') {
    for (const db of targets) {
      try { deleteSource(db.id, 'synthesis', absPath); } catch (_) { /* ignore */ }
      out.dbResults.push({ dbId: db.id, written: 0, skippedFiltered: 0, skippedSuperseded: true });
    }
    return out;
  }

  const body = buf.slice(bodyStart).replace(/^\s+/, '');
  if (!body.trim()) {
    for (const db of targets) {
      try { deleteSource(db.id, 'synthesis', absPath); } catch (_) { /* ignore */ }
      out.dbResults.push({ dbId: db.id, written: 0, skippedFiltered: 0 });
    }
    return out;
  }

  const chunks = chunkText(body, {
    filePath: absPath,
    fileName: title,
    fileMtime: pageMtime,
  });
  if (chunks.length === 0) return out;

  for (const db of targets) {
    // Frontmatter-level sensitivity check FIRST — same shape as knowledge.ts.
    if (fm.sensitivity) {
      const includes = db.sensitivity.include.includes(fm.sensitivity);
      const excludes = db.sensitivity.exclude.includes(fm.sensitivity);
      if (!includes || excludes) {
        try { deleteSource(db.id, 'synthesis', absPath); } catch (_) { /* ignore */ }
        out.dbResults.push({
          dbId: db.id, written: 0, skippedFiltered: 0,
          skippedFrontmatterSensitivity: true,
        });
        continue;
      }
    }

    // mtime short-circuit.
    const lastTs = _maxIngestedTs(db, absPath);
    if (lastTs !== null && lastTs >= pageMtime) {
      out.dbResults.push({ dbId: db.id, written: 0, skippedFiltered: 0, skippedUnchanged: true });
      continue;
    }

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
      const tier = fm.sensitivity || verdict.tier;
      survivors.push(chunk);
      tiers.push(tier);
      confs.push(fm.sensitivity ? 1.0 : verdict.confidence);
    }
    if (survivors.length === 0) {
      try { deleteSource(db.id, 'synthesis', absPath); } catch (_) { /* ignore */ }
      out.dbResults.push({ dbId: db.id, written: 0, skippedFiltered: dropped });
      continue;
    }

    let client;
    try {
      client = clientForDB(db);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn('context-rag.synthesis.client-failed', { dbId: db.id, path: absPath, error: msg });
      out.dbResults.push({ dbId: db.id, written: 0, skippedFiltered: dropped, error: msg });
      continue;
    }

    try {
      try { deleteSource(db.id, 'synthesis', absPath); } catch (_) { /* ignore */ }

      let totalWritten = 0;
      for (let i = 0; i < survivors.length; i += MAX_BATCH_EMBED) {
        const slice   = survivors.slice(i, i + MAX_BATCH_EMBED);
        const texts   = slice.map((c) => c.text);
        const vectors = await client.embedBatch(texts);
        const rows: ChunkUpsert[] = slice.map((c, j) => ({
          sourceKind:      'synthesis',
          sourceId:        absPath,
          sourcePath:      absPath,
          chunkIndex:      c.index,
          text:            c.text,
          embedding:       vectors[j],
          sensitivityTier: tiers[i + j] as any,
          sensitivityConf: confs[i + j],
          metadata: {
            ...c.metadata,
            pageTitle:     title,
            bucketCwd,
            module:        fm.module,
            page:          fm.page,
            tags:          fm.tags,
            topics:        fm.topics,
            sourcePaths:   fm.source_paths,
            status:        fm.status,
          },
          ts: pageMtime,
        }));
        const { written } = upsertChunks(db.id, rows);
        totalWritten += written;
      }
      out.dbResults.push({ dbId: db.id, written: totalWritten, skippedFiltered: dropped });
      logger.info('context-rag.synthesis.ingested', {
        dbId: db.id, path: absPath, written: totalWritten, droppedBySensitivity: dropped,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.warn('context-rag.synthesis.embed-failed', {
        dbId: db.id, path: absPath, error: msg,
      });
      try { deleteSource(db.id, 'synthesis', absPath); } catch (_) { /* ignore */ }
      out.dbResults.push({ dbId: db.id, written: 0, skippedFiltered: dropped, error: msg });
    }
  }
  return out;
}

export {
  enqueueSynthesisForRag,
  scanAndEnqueueAllSynthesisDbs,
  ingestSynthesis,
  bucketDirForCwd,
  SYNTHESIS_ROOT_DIR,
  MAX_BATCH_EMBED,
  MAX_PAGE_BYTES,
};
export type { SynthesisIngestResult };
