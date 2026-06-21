// ── context-rag retrieve query layer ──────────────────────────────────────────
// Read path. Takes a natural-language query plus a route (explicit dbIds, or
// auto-routed from cwd), and returns the top-K most-similar chunks across
// every matching DB. Optionally NIM-reranks the merged candidate set so the
// final ordering is comparable across embed models (raw L2 distances from
// different models are NOT directly comparable; rerank scores are).
//
// Pipeline
//   1. Resolve route → list of VectorDBs to query
//   2. For each DB in parallel:
//        a. Get the cached embed client (clientForDB)
//        b. embedBatch([query]) → 1 vector of dim db.embedDim
//        c. similarity(dbId, vec, { k: k * overFetch }) → SearchHit[]
//        d. Tag each hit with dbId / dbDisplayName
//   3. Merge:
//        a. If any client has rerank() AND opts.rerank !== false →
//           collect candidate texts, run rerank against the first NIM-class
//           client we find, sort merged hits by rerank score desc
//        b. Else → sort merged hits by raw distance asc (best-effort; works
//           OK when all DBs share the same embed model, lossy when not)
//        c. Take top-K
//   4. Return { hits, debug } so the UI can show route-reasons + per-DB
//      counts + timings.
//
// Failure mode: one DB throwing (auth error, model mismatch, sqlite locked)
// must NOT poison the whole search. We catch per-DB, log, and keep the rest.
// The debug payload records the error per-dbId so the UI can flag a broken
// DB without burying the successful hits.
'use strict';

const logger = require('../../../../core/logger');

import type { VectorDB, SensitivityTier } from '../registry/types';
import type { SearchHit, SourceKind }      from '../vector-store/db-instance';
import type { EmbeddingClient }            from '../embed/types';

import { similarity, keywordSearch } from '../vector-store/db-instance';
import { clientForDB }    from '../embed/client-for-db';
import { routeByIds, routeAll, routeFromCwd } from './auto-route';
import { expandQuery }    from './glossary';
import type { ExpandResult } from './glossary';

interface RagHit extends SearchHit {
  /** The DB this hit came from — needed because the UI groups results by
   *  corpus and the rerank-vs-distance ordering is opaque without it. */
  dbId:          string;
  dbDisplayName: string;
  /** Populated only when rerank ran; higher = more relevant. `null` falls
   *  back to `-distance` ordering. */
  rerankScore: number | null;
  /** Which lane(s) surfaced this hit — vector, keyword, or both. UI uses
   *  this to badge results so users can see when BM25 caught something the
   *  embedder missed (and vice versa). */
  lanes: Array<'vector' | 'keyword'>;
  /** BM25 score when the keyword lane fired for this hit; null otherwise. */
  bm25: number | null;
  /** Reciprocal-rank-fusion score across vector + keyword lanes (per-DB,
   *  pre-rerank). Higher = better. The pre-rerank ordering when no
   *  reranker is present. */
  rrfScore: number;
  /** Best-effort, agent-friendly pointer to the original source.
   *  • file / knowledge  → `file://<abs-path>`  (directly Read-able)
   *  • session           → `yha://session/<id>` (documentary — not a real
   *                          protocol, but lets partner agents recognise it
   *                          and ask the host for the transcript)
   *  Null only when sourceId is missing/empty. */
  sourceUrl: string | null;
}

function _buildSourceUrl(kind: SourceKind, sourceId: string, sourcePath: string | null): string | null {
  const sid = String(sourceId || '').trim();
  if (!sid) return null;
  if (kind === 'session') {
    return `yha://session/${encodeURIComponent(sid)}`;
  }
  // file + knowledge → both store an absolute path as sourceId; sourcePath
  // is a UI breadcrumb that, when present, may be the cleaner display form.
  const abs = String(sourcePath || sid).trim();
  if (!abs.startsWith('/')) return null;
  return 'file://' + abs;
}

interface SearchInput {
  query: string;
  /** Explicit DB id list. Takes priority over `cwd`. */
  dbIds?: readonly string[];
  /** Auto-route source: active session's working_dir, or null for a bare
   *  chat. Ignored when `dbIds` is supplied. */
  cwd?: string | null;
  /** When true (the default when `dbIds` and `cwd` are both omitted), every
   *  registered DB is queried. Use sparingly — N embed calls. */
  all?: boolean;
  /** Final hit count after merge. Default 8. */
  k?: number;
  /** Over-fetch multiplier per-DB before merging. Default 3. */
  overFetch?: number;
  /** When true and at least one routed DB has a reranker, NIM-rerank the
   *  merged candidate set. Default true. */
  rerank?: boolean;
  /** Restrict to a single source kind (e.g. only files, only sessions).
   *  Passed through to the vector-store filter. */
  sourceKind?: SourceKind;
  /** Sensitivity allow-list passed through to the vector-store filter.
   *  Defaults to no filter — the per-DB exclude rule is enforced at ingest. */
  allowTiers?: readonly SensitivityTier[];
}

interface PerDbDebug {
  dbId:          string;
  displayName:   string;
  reason:        string;
  /** Final hit count for this DB after RRF merge. */
  hits:          number;
  /** Per-lane hit counts before merge. `vectorHits + keywordHits` is the
   *  pre-merge candidate pool; overlap means the same chunk fired in both
   *  lanes (good signal — RRF rewards it). */
  vectorHits:    number;
  keywordHits:   number;
  embedMs:       number;
  searchMs:      number;
  keywordMs:     number;
  error?:        string;
}

interface SearchDebug {
  /** Whether the route came from explicit ids, auto-cwd, or all. */
  routeMode: 'explicit' | 'auto-cwd' | 'all';
  cwd:       string | null;
  totalMs:   number;
  /** How the final ordering was produced.
   *  • 'rerank'   — NIM reranker scored the merged candidate set.
   *  • 'rrf'      — fell back to per-DB reciprocal-rank-fusion scores
   *                 (vector + keyword), sorted across DBs.
   *  • 'distance' — last-resort raw L2 distance (vector-only path; not
   *                 comparable across DBs with different embedders, kept
   *                 only as the floor when nothing else applies). */
  ordering:  'rerank' | 'rrf' | 'distance';
  rerankMs:  number;
  perDb:     PerDbDebug[];
  /** Glossary expansion summary. `expanded === original` when no concepts
   *  hit; `hits[]` lists which entries fired. */
  glossary?: ExpandResult;
}

interface SearchResult {
  hits:  RagHit[];
  debug: SearchDebug;
}

function _resolveRoute(input: SearchInput): { dbs: VectorDB[]; reasons: Record<string, string>; mode: SearchDebug['routeMode'] } {
  if (input.dbIds && input.dbIds.length > 0) {
    const r = routeByIds(input.dbIds);
    return { dbs: r.dbs, reasons: r.reasons, mode: 'explicit' };
  }
  if (input.all) {
    const r = routeAll();
    return { dbs: r.dbs, reasons: r.reasons, mode: 'all' };
  }
  const r = routeFromCwd({ cwd: input.cwd ?? null });
  return { dbs: r.dbs, reasons: r.reasons, mode: 'auto-cwd' };
}

/** Reciprocal Rank Fusion constant. 60 is the value from the original RRF
 *  paper (Cormack et al., 2009) and is the de-facto default in IR work.
 *  Higher k dampens the contribution of top-ranked hits — at k=60 a rank-1
 *  hit contributes 1/61 ≈ 0.0164, rank-10 contributes 1/70 ≈ 0.0143. The
 *  exact value isn't critical; what matters is that any-lane-good >
 *  no-lane-good and both-lanes-good > one-lane-good. */
const RRF_K = 60;

async function _searchOneDb(
  db:    VectorDB,
  query: string,
  opts:  { k: number; overFetch: number; sourceKind?: SourceKind; allowTiers?: readonly SensitivityTier[] },
): Promise<{
  hits: RagHit[]; embedMs: number; searchMs: number; keywordMs: number;
  vectorHits: number; keywordHits: number; client: EmbeddingClient;
}> {
  const client = clientForDB(db);

  // Vector lane — embed + similarity. Failure here is fatal for this DB
  // (the caller's Promise.allSettled treats it as a per-DB error).
  const t0 = Date.now();
  // 'query' tells NIM-class adapters (e5/nv-embedqa/nv-embedcode) to use the
  // query-side projection. Ingest paths leave the default 'passage'.
  const vecs = await client.embedBatch([query], { kind: 'query' });
  const embedMs = Date.now() - t0;
  if (vecs.length !== 1) {
    throw new Error(`context-rag.retrieve: embedBatch returned ${vecs.length} vectors for 1 query`);
  }
  const vec = vecs[0];
  const t1 = Date.now();
  const vectorRaw = similarity(db.id, vec, {
    k:          opts.k,
    overFetch:  opts.overFetch,
    sourceKind: opts.sourceKind,
    allowTiers: opts.allowTiers,
  });
  const searchMs = Date.now() - t1;

  // Keyword (BM25) lane — runs against rag_fts, no network call. Failures
  // here are non-fatal: a DB with no FTS index, or a query that doesn't
  // tokenize cleanly, just returns an empty list and the vector lane carries
  // the result. We try/catch defensively even though keywordSearch already
  // swallows FTS5 syntax errors internally.
  const t2 = Date.now();
  let keywordRaw: ReturnType<typeof keywordSearch> = [];
  try {
    keywordRaw = keywordSearch(db.id, query, {
      k:          opts.k,
      overFetch:  opts.overFetch,
      sourceKind: opts.sourceKind,
      allowTiers: opts.allowTiers,
    });
  } catch (e) {
    const err = e instanceof Error ? e.message : String(e);
    logger.warn('context-rag.retrieve.keyword-failed', { dbId: db.id, error: err });
  }
  const keywordMs = Date.now() - t2;

  // RRF merge. Identity is (sourceKind, sourceId, chunkIndex) — the same
  // tuple the chunk store uses as its natural key, so the same chunk
  // surfaced by both lanes collapses to one entry with both ranks.
  const _key = (h: { sourceKind: string; sourceId: string; chunkIndex: number }) =>
    `${h.sourceKind}\x1f${h.sourceId}\x1f${h.chunkIndex}`;

  type Acc = {
    hit:        RagHit;
    vectorRank: number | null;
    keywordRank: number | null;
  };
  const merged = new Map<string, Acc>();

  vectorRaw.forEach((h, i) => {
    const k = _key(h);
    merged.set(k, {
      hit: {
        ...h,
        dbId:          db.id,
        dbDisplayName: db.displayName,
        rerankScore:   null,
        lanes:         ['vector'],
        bm25:          null,
        rrfScore:      0,
        sourceUrl:     _buildSourceUrl(h.sourceKind, h.sourceId, h.sourcePath),
      },
      vectorRank: i + 1,
      keywordRank: null,
    });
  });
  keywordRaw.forEach((h, i) => {
    const k = _key(h);
    const existing = merged.get(k);
    if (existing) {
      existing.keywordRank = i + 1;
      existing.hit.bm25 = h.bm25;
      existing.hit.lanes.push('keyword');
    } else {
      merged.set(k, {
        hit: {
          ...h,
          dbId:          db.id,
          dbDisplayName: db.displayName,
          rerankScore:   null,
          lanes:         ['keyword'],
          bm25:          h.bm25,
          rrfScore:      0,
          sourceUrl:     _buildSourceUrl(h.sourceKind, h.sourceId, h.sourcePath),
        },
        vectorRank: null,
        keywordRank: i + 1,
      });
    }
  });

  // RRF: sum 1 / (k + rank) across lanes a hit appeared in. A hit that lands
  // in BOTH lanes gets two contributions, naturally promoting it above
  // single-lane hits even if neither was rank-1.
  for (const acc of merged.values()) {
    let s = 0;
    if (acc.vectorRank  !== null) s += 1 / (RRF_K + acc.vectorRank);
    if (acc.keywordRank !== null) s += 1 / (RRF_K + acc.keywordRank);
    acc.hit.rrfScore = s;
  }

  const hits = Array.from(merged.values())
    .map((a) => a.hit)
    .sort((a, b) => b.rrfScore - a.rrfScore)
    .slice(0, opts.k);

  return {
    hits,
    embedMs,
    searchMs,
    keywordMs,
    vectorHits:  vectorRaw.length,
    keywordHits: keywordRaw.length,
    client,
  };
}

/** Top-level search. See file header for the pipeline. */
async function searchRag(input: SearchInput): Promise<SearchResult> {
  const t0    = Date.now();
  const k     = Math.max(1, Math.floor(input.k ?? 8));
  const over  = Math.max(1, Math.floor(input.overFetch ?? 3));
  const wantRerank = input.rerank !== false;
  const route = _resolveRoute(input);

  // Glossary expansion: concept→jargon aliases for the active cwd. Cheap and
  // additive; no-op when no glossary exists for the cwd or no concepts match.
  // Skipped for explicit-id routes where the caller is pinning specific DBs
  // and the cwd may not be meaningful.
  const glossaryHit = route.mode === 'explicit'
    ? { original: input.query, expanded: input.query, hits: [], glossaryPath: null }
    : expandQuery(input.query, input.cwd ?? null);
  const effectiveQuery = glossaryHit.expanded;

  if (route.dbs.length === 0) {
    return {
      hits: [],
      debug: {
        routeMode: route.mode,
        cwd:       input.cwd ?? null,
        totalMs:   Date.now() - t0,
        ordering:  'distance',
        rerankMs:  0,
        perDb:     [],
        glossary:  glossaryHit,
      },
    };
  }

  const perDb: PerDbDebug[] = [];
  const merged: RagHit[]    = [];
  const clients: Array<{ db: VectorDB; client: EmbeddingClient }> = [];

  // Fan out in parallel. Per-DB failures are caught so one bad DB doesn't
  // sink the whole query. The expanded query (original + glossary aliases)
  // is what we embed; the original is preserved only for the rerank text and
  // the debug payload.
  const settled = await Promise.allSettled(route.dbs.map(async (db) => {
    const r = await _searchOneDb(db, effectiveQuery, {
      k:          k * over,
      overFetch:  1,
      sourceKind: input.sourceKind,
      allowTiers: input.allowTiers,
    });
    return { db, ...r };
  }));

  for (let i = 0; i < settled.length; i++) {
    const db = route.dbs[i];
    const s  = settled[i];
    if (s.status === 'fulfilled') {
      const { hits, embedMs, searchMs, keywordMs, vectorHits, keywordHits, client } = s.value;
      merged.push(...hits);
      clients.push({ db, client });
      perDb.push({
        dbId:        db.id,
        displayName: db.displayName,
        reason:      route.reasons[db.id] ?? '?',
        hits:        hits.length,
        vectorHits,
        keywordHits,
        embedMs,
        searchMs,
        keywordMs,
      });
    } else {
      const err = s.reason instanceof Error ? s.reason.message : String(s.reason);
      logger.warn('context-rag.retrieve.db-failed', { dbId: db.id, error: err });
      perDb.push({
        dbId:        db.id,
        displayName: db.displayName,
        reason:      route.reasons[db.id] ?? '?',
        hits:        0,
        vectorHits:  0,
        keywordHits: 0,
        embedMs:     0,
        searchMs:    0,
        keywordMs:   0,
        error:       err,
      });
    }
  }

  // Order the merged set. Prefer rerank when available — distance from
  // different embed models isn't comparable, so a multi-DB query without
  // rerank is best-effort.
  let ordering: SearchDebug['ordering'] = 'distance';
  let rerankMs = 0;
  if (wantRerank && merged.length > 1) {
    const reranker = clients.find((c) => typeof c.client.rerank === 'function');
    if (reranker) {
      const rT0 = Date.now();
      try {
        const scores = await reranker.client.rerank!(input.query, merged.map((h) => h.text));
        for (let i = 0; i < merged.length; i++) {
          merged[i].rerankScore = typeof scores[i] === 'number' ? scores[i] : null;
        }
        merged.sort((a, b) => {
          const sa = a.rerankScore ?? -Infinity;
          const sb = b.rerankScore ?? -Infinity;
          return sb - sa;
        });
        ordering = 'rerank';
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        logger.warn('context-rag.retrieve.rerank-failed', { error: err, dbId: reranker.db.id });
        // Fall through to distance ordering.
      }
      rerankMs = Date.now() - rT0;
    }
  }
  if (ordering === 'distance') {
    // No rerank → prefer the RRF score we already computed per-DB. It's
    // rank-based so it's roughly comparable across DBs (max ≈ 2/(RRF_K+1)
    // for both-lanes-rank-1, falling off to ≈ 0 for tail hits), unlike raw
    // L2 distance from heterogeneous embedders. Only fall through to raw
    // distance if no hit has an RRF score at all (shouldn't happen with
    // the dual-lane path, but cheap insurance).
    if (merged.some((h) => h.rrfScore > 0)) {
      merged.sort((a, b) => b.rrfScore - a.rrfScore);
      ordering = 'rrf';
    } else {
      merged.sort((a, b) => a.distance - b.distance);
    }
  }

  const hits = merged.slice(0, k);
  return {
    hits,
    debug: {
      routeMode: route.mode,
      cwd:       input.cwd ?? null,
      totalMs:   Date.now() - t0,
      ordering,
      rerankMs,
      perDb,
      glossary:  glossaryHit,
    },
  };
}

export { searchRag };
export type { SearchInput, SearchResult, SearchDebug, PerDbDebug, RagHit };
