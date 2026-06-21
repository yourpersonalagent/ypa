// ── File-Categorizer constants ────────────────────────────────────────────────
// Phase 4.1 (2026-05-07) of the ContextGenerator pipeline.
'use strict';

const path = require('path');

// ── Constants ─────────────────────────────────────────────────────────────────

const BATCH_SIZE          = 20;
const POLL_INTERVAL_MS    = 5 * 60 * 1_000;   // watchdog cadence: 5 min
// Per-request abort threshold. Bumped from 10 s to 25 s after the
// default categorizer model became Llama-3.3-70B — file inputs can be
// up to 6 KB so 70B prompts stretch 5–15 s; 25 s gives enough headroom
// to avoid spurious aborts that would mark files as `auto-skipped`.
const FILE_CAT_TIMEOUT_MS = 25_000;
const MAX_BODY_CHARS      = 6_000;             // input cap for the LLM call

// ── Stuck-file escape hatch (Phase 5.2, mirrors auto-title.ts) ────────────────
// Without a retry cap a corpus of 60k+ files where a few hundred consistently
// fail the classifier (e.g. all-emoji notes, binary-blob garbage in a .md
// extension, model-prompt edge cases) would block forever. After
// MAX_FILE_CATEGORIZE_ATTEMPTS we promote the file to "auto-skipped":
//   • write empty `topics: []`, `tags: []`, `keywords: []` so
//     `_isUncategorised` returns false — the worker stops re-trying.
//   • record `categorizerStatus: auto-skipped` + `categorizerSkipReason:
//     <last-error>` + `categorizerAttempts: N` so the Inspector panel can
//     show the user *which* files got auto-skipped and *why*.
// The user can manually classify or force-retry via /v1/config/file-
// categorizer/{manual,force-retry}.
const MAX_FILE_CATEGORIZE_ATTEMPTS = 3;

// Per-user (Q16 A.4) — routed via bridge/core/paths.ts.
// Legacy fallback: `<repo>/docs/keep-notes/`.
// Post-migration: `bridge/users/<email>/docs/keep-notes/`.
const KEEP_NOTES_ROOT = path.join(require('../../../core/paths').userDocsDir, 'keep-notes');

// Mirror VALID_CATEGORIES from the session categorizer. The LLM is allowed to
// pick zero, one, or up to three of these as `topics`. Excludes `keep-notes`
// itself (because that's the locked primary `category` for these files —
// listing it as a topic would be redundant) and `notes` (reserved for inline
// `#note` chat content per user spec).
const TOPIC_SLUGS: ReadonlyArray<string> = Object.freeze([
  'architecture',
  'frontend',
  'backend',
  'ai-models',
  'debugging',
  'integrations',
  'workflows',
  'data',
  'devops',
  'documentation',
  'experiments',
  'general',
  // Phase 4.1: free-form themes that surface as soft-categories in the
  // synthesis pages even though they don't exist in the session categorizer's
  // 12-slug list. The frontend renders these the same way as topic-overlap
  // hits — they just won't have a corresponding `by-category/<slug>/` index
  // page until the user (or a future iteration) decides to promote them.
  'psychology',
  'religion',
  'erotic',
  'family',
  'health',
  'finance',
  'travel',
  'cooking',
  'shopping',
  'media',
]);
const TOPIC_SET = new Set(TOPIC_SLUGS);

module.exports = {
  BATCH_SIZE,
  POLL_INTERVAL_MS,
  FILE_CAT_TIMEOUT_MS,
  MAX_BODY_CHARS,
  MAX_FILE_CATEGORIZE_ATTEMPTS,
  KEEP_NOTES_ROOT,
  TOPIC_SLUGS,
  TOPIC_SET,
};
