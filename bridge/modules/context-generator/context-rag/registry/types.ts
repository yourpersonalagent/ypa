// ── context-rag registry types ────────────────────────────────────────────────
// Source of truth for the on-disk `dbs.json` schema. The store layer reads and
// writes JSON shaped like `Registry`; consumers (ingest, retrieve, UI tab,
// MCP server) import `VectorDB` from here.
//
// embedModel is recorded per-DB and locked at create time. Reads + writes
// against a DB must use that exact model — there is no aliasing, no family
// match, no auto-migration. The physical file separation (one .db per
// VectorDB at `data/{id}.db`) makes the lock concrete: an opened DB carries
// its model in `rag_meta` and an in-process check rejects any call that
// doesn't match.
'use strict';

type SensitivityTier = 'public' | 'private' | 'system';

type EmbedProvider = 'nvidia' | 'lmstudio';

type SessionsSourceMode  = 'all' | 'cwd' | 'off';
type FilesSourceMode     = 'cwd' | 'roots' | 'off';
type KnowledgeSourceMode = 'all' | 'off';
// Synthesis = curated per-cwd markdown distilled by the cwd-synthesize skill
// (bridge/knowledge/dirs/<slug>/synthesis/). 'all' = every bucket the bridge
// has on disk; 'cwd' = exactly one bucket. Empirically, synthesis pages
// rerank above raw session chunks for concept→jargon queries, so any DB that
// wants conceptual recall opts in via this field.
type SynthesisSourceMode = 'all' | 'cwd' | 'off';

interface SessionsSource {
  mode: SessionsSourceMode;
  /** Absolute path; required when mode==='cwd'. */
  cwd?: string;
}

interface FilesSource {
  mode: FilesSourceMode;
  /** Absolute path; required when mode==='cwd'. */
  cwd?: string;
  /** Absolute paths; required when mode==='roots'. */
  roots?: string[];
  /** Enable fs.watch on the configured root. The runner only honours this
   *  when the DB's cwd matches the active session's working_dir — Q-A=c in
   *  the design Q&A: auto-watch on the active CWD DB, manual elsewhere. */
  watch?: boolean;
  /** Path fragments to skip during ingest. `.gitignore` is honoured separately
   *  by the walker; this list catches things git tracks but we still don't
   *  want indexed (build outputs, vendored binaries, etc.). */
  ignore?: string[];
}

interface KnowledgeSource {
  mode: KnowledgeSourceMode;
}

interface SynthesisSource {
  mode: SynthesisSourceMode;
  /** Absolute path; required when mode==='cwd'. Resolves to the bucket at
   *  bridge/knowledge/dirs/<slug>/synthesis/ where slug = cwd with leading
   *  '/' stripped and remaining '/' replaced by '___'. */
  cwd?: string;
}

interface SourceFilter {
  sessions:  SessionsSource;
  files:     FilesSource;
  knowledge: KnowledgeSource;
  /** Optional — DBs created before the synthesis source landed don't have
   *  this field. Absent is treated as `{ mode: 'off' }` everywhere. */
  synthesis?: SynthesisSource;
}

interface SensitivityFilter {
  /** Tiers eligible for ingest. Default ['public']. */
  include: SensitivityTier[];
  /** Tiers that must NOT be ingested even if `include` lists them; wins
   *  over include. Default ['private', 'system']. */
  exclude: SensitivityTier[];
}

interface VectorDBStats {
  /** Total chunks indexed across all sources. */
  chunks: number;
  /** ms since epoch of the last successful ingest pass; null until the
   *  first pass completes. */
  lastIngestAt: number | null;
  /** Last ingest error message; cleared on next successful pass. */
  lastError: string | null;
}

interface VectorDB {
  /** Stable kebab-case id; also used as the on-disk file name
   *  (`data/{id}.db`). Validated against `/^[a-z0-9][a-z0-9-]{0,62}$/`. */
  id: string;
  displayName: string;
  embedProvider: EmbedProvider;
  /** EXACT model id; locked at create time. */
  embedModel: string;
  /** Vector dimension; probed once at create time from a /v1/embeddings call.
   *  Stored here so retrieve() can size buffers without re-probing. */
  embedDim: number;
  source: SourceFilter;
  sensitivity: SensitivityFilter;
  createdAt: number;
  stats: VectorDBStats;
  /** When this DB was created as the migration target of another DB, this
   *  is the source DB's id. Set by POST /v1/context-rag/dbs/:id/migrate.
   *  The original DB stays live for retrieval until the operator archives it. */
  migratedFrom?: string;
  /** When this DB has been superseded by a migration target, the new DB's
   *  id. Both directions of the link are persisted so the UI can render the
   *  pair without walking the whole registry. */
  migratedTo?: string;
}

interface Registry {
  version: 1;
  dbs: VectorDB[];
}

const REGISTRY_VERSION = 1 as const;

function makeEmptyRegistry(): Registry {
  return { version: REGISTRY_VERSION, dbs: [] };
}

function makeDefaultSensitivity(): SensitivityFilter {
  return { include: ['public'], exclude: ['private', 'system'] };
}

function makeDefaultStats(): VectorDBStats {
  return { chunks: 0, lastIngestAt: null, lastError: null };
}

export {
  REGISTRY_VERSION,
  makeEmptyRegistry,
  makeDefaultSensitivity,
  makeDefaultStats,
};
export type {
  SensitivityTier,
  EmbedProvider,
  SessionsSourceMode,
  FilesSourceMode,
  KnowledgeSourceMode,
  SynthesisSourceMode,
  SessionsSource,
  FilesSource,
  KnowledgeSource,
  SynthesisSource,
  SourceFilter,
  SensitivityFilter,
  VectorDBStats,
  VectorDB,
  Registry,
};
