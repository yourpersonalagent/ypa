// ── Context Sorter constants ──────────────────────────────────────────────────
// Pure constants + types, shared by util / slug-graph / render-pages / file-io
// / batch / runner / admin. No state, no imports of internal modules — keeps
// the dependency tree acyclic.
'use strict';

const path = require('path');

// ── Constants ─────────────────────────────────────────────────────────────────

const BATCH_SIZE       = 25;
const POLL_INTERVAL_MS = 5 * 60 * 1_000;   // watchdog cadence: 5 minutes

// ── Stuck-session escape hatch (Phase 5.3, mirrors auto-title.ts) ─────────────
// Disk write failures (full disk, EACCES on a renamed-while-running file,
// path-too-long on Windows-mounted vaults) re-attempt on every 5-min tick
// without persistent state. After MAX_SORT_ATTEMPTS we mark `_sortSkipped =
// true` so the session no longer blocks the gate. User can re-attempt via
// /v1/config/sorter/force-retry once they've fixed the underlying issue.
const MAX_SORT_ATTEMPTS = 3;

// Per-user (Q16 A.4) — routed via bridge/core/paths.ts →
// `bridge/users/<email>/docs/generated/` (repo-root `docs/` only when
// ALLOWED_EMAILS is unset).
const _userDocsDir = require('../../../core/paths').userDocsDir;
const DOCS_GENERATED_ROOT = path.join(_userDocsDir, 'generated');

// `docs/keep-notes/` — Phase 4.2 reads frontmatter from these files
// (category + topics + tags + keywords) so the synthesis pages can
// cross-link them into the relevant per-category indexes alongside the
// regular session pages. Walked at the end of each sorter run; cheap because
// only frontmatter is parsed (we never load full bodies into memory).
const DOCS_KEEP_NOTES_ROOT = path.join(_userDocsDir, 'keep-notes');

// `<bridge>/context-graph.json` — the cross-link graph that powers the new
// "By context" view of the Context-Hub picker. Materialised once per sorter
// run, cheap because we already hold all sessions in memory. Keeping it in
// `bridge/` (not `docs/generated/`) means it's NOT shipped to Obsidian and
// can hold app-internal fields the Markdown vault doesn't need.
//
// Shape (kept stable so the frontend can rely on it):
//   {
//     generatedAt: <epoch ms>,
//     totalSessions: number,
//     categories: {
//       [slug]: { count: number, sessions: SessionStub[] }
//     },
//     tags: { [tag]: SessionStub[] },
//     sessions: { [sid]: { related: string[] } }   // top-N related sids
//   }
// Per-user (Q16) — routed via bridge/core/paths.ts.
// Falls back to bridge/context-graph.json pre-migration.
const CONTEXT_GRAPH_PATH = require('../../../core/paths').contextGraph;

// Subdirs we always create on first write.
const SUBDIR_SESSIONS    = path.join(DOCS_GENERATED_ROOT, 'sessions');
const SUBDIR_BY_CATEGORY = path.join(DOCS_GENERATED_ROOT, 'by-category');
const SUBDIR_BY_TYPE     = path.join(DOCS_GENERATED_ROOT, 'by-type');
const SUBDIR_BY_DATE     = path.join(DOCS_GENERATED_ROOT, 'by-date');

// Session-prefix → human label mapping for `by-type/`.
const TYPE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  cc:       'Claude Code',
  branch:   'Branch sessions',
  copilot:  'GitHub Copilot',
  codex:    'Codex',
  other:    'Other',
});

// Emoji map mirrors the doc — purely cosmetic in Markdown previews.
const CATEGORY_EMOJI: Readonly<Record<string, string>> = Object.freeze({
  architecture:   '🏗️',
  frontend:       '🖥️',
  backend:        '⚙️',
  'ai-models':    '🤖',
  debugging:      '🔧',
  integrations:   '🔌',
  workflows:      '📋',
  data:           '📁',
  devops:         '🚀',
  documentation:  '📝',
  experiments:    '🧪',
  general:        '💬',
  'keep-notes':   '🗒️',  // Phase 3.4d — Google Keep notes mirrored from the vault
});

const RELATED_TOP_N = 8;

const SYNTHESIS_SESSION_CAP = 100;
const SYNTHESIS_FILE_CAP    = 200;

module.exports = {
  BATCH_SIZE,
  POLL_INTERVAL_MS,
  MAX_SORT_ATTEMPTS,
  DOCS_GENERATED_ROOT,
  DOCS_KEEP_NOTES_ROOT,
  CONTEXT_GRAPH_PATH,
  SUBDIR_SESSIONS,
  SUBDIR_BY_CATEGORY,
  SUBDIR_BY_TYPE,
  SUBDIR_BY_DATE,
  TYPE_LABELS,
  CATEGORY_EMOJI,
  RELATED_TOP_N,
  SYNTHESIS_SESSION_CAP,
  SYNTHESIS_FILE_CAP,
};

