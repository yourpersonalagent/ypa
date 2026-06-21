// ── LINK Sync Engine — Constants & Types ─────────────────────────────────────
// Shared constants, paths, defaults and type definitions used across the
// sync-* submodules. Extracted from the original `sync.ts` (Phase 3.1c) so
// the per-concern files stay small.
'use strict';

const path = require('path');

// ── Constants ─────────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS_DEFAULT = 5 * 60 * 1_000;
const PUSH_RATE_LIMIT_MS       = 60 * 1_000;     // min interval between push-ticks

// Single-file size ceiling for the local walk + per-path sync. Mirrors
// adapter.ts VAULT_FILE_SIZE_CAP (5 MB): the adapter already refuses to
// read/write anything past this, so pulling such a file into memory in the
// walk just to hash it is wasted work — and on a memory-constrained host a
// folder full of multi-MB binaries (e.g. an exploded keep-notes/Assets tree of
// .png conflict copies) OOMs the bun bridge mid-read, which blocks the event
// loop and stalls every other route. Files over the cap are skipped entirely.
const MAX_SYNC_FILE_BYTES = 5 * 1024 * 1024;

// Per-user (Q16) — routed via bridge/core/paths.ts.
// DOCS_ROOT resolves to `bridge/users/<email>/docs/` when ALLOWED_EMAILS is
// set; repo-root `docs/` only without auth. Callers
// that resolve `path.resolve(DOCS_ROOT, '..', serverDir)` continue to work
// because `serverDir` is still 'docs/keep-notes' etc. — the `..` strips the
// trailing 'docs' segment regardless of which root is in play.
// SECRETS_DIR is derived as the parent of SECRETS_FILE so callers that
// mkdir-p before write still hit the per-user folder.
const _paths         = require('../../../core/paths');
const DOCS_ROOT      = _paths.userDocsDir;
const STATE_PATH     = _paths.linkState;
const SECRETS_FILE   = _paths.linkSecrets;
const SECRETS_DIR    = path.dirname(SECRETS_FILE);

// Default folder mapping (server-side relative path → vault-side prefix).
// Order matters: traversal happens in this order, status is reported
// per-folder.
//
// Phase 3.4d (2026-05-07) — `docs/keep-notes/` added as a first-class
// bidirectional sync target. Default vault-side prefix is `keep-notes/`
// but the user typically remaps it to `Google Keep/` (or wherever the
// Obsidian Google-Keep-Importer plugin dropped the notes) via a one-shot
// `importVaultFolder()` call which then writes the override into
// config.defaults.contextLink.syncDirs and starts the watchdog cycle.
const DEFAULT_SYNC_DIRS: Readonly<Record<string, string>> = Object.freeze({
  'docs/generated':  'generated/',
  'docs/notes':      'notes/',
  'docs/keep-notes': 'keep-notes/',
  'docs/calendar':   'calendar/',
  'docs/mail':       'mail/',
});

// Default policy per folder — see .ContextGenerator.MD §5.5.
// `docs/keep-notes/` defaults to preserve-both because Keep notes
// frequently get edited on the phone (→ Obsidian via Google-Keep-Importer
// → vault) and the user might also annotate them on the server side; we
// never want to silently lose either edit, so a `.conflict-<ts>.md`
// sidecar is the safest fallback if both drift in the same tick.
const DEFAULT_CONFLICT_POLICY: Readonly<Record<string, ConflictPolicy>> = Object.freeze({
  'docs/generated':  'server-wins',
  'docs/notes':      'preserve-both',
  'docs/keep-notes': 'preserve-both',
  'docs/calendar':   'newest-wins',
  'docs/mail':       'desktop-wins',
});

// `docs/generated/` is fully owned by the Sorter — pulling from desktop into
// it would corrupt the regen target. We enforce that here regardless of the
// user's conflict policy: this folder is push-only.
const PUSH_ONLY_DIRS = new Set(['docs/generated']);

// ── Types ─────────────────────────────────────────────────────────────────────

type ConflictPolicy = 'server-wins' | 'desktop-wins' | 'newest-wins' | 'preserve-both';

interface SyncFileState {
  serverSha:   string | null;
  serverMtime: number;
  desktopSha?: string | null;
  desktopMtime: number;
  lastSyncAt:  number;
}

interface LinkState {
  version: 1;
  files:   Record<string, SyncFileState>;
}

interface SyncRunStats {
  pushed:    number;
  pulled:    number;
  conflicts: number;
  errors:    Array<{ path: string; error: string }>;
  filesScanned: number;
}

module.exports = {
  POLL_INTERVAL_MS_DEFAULT,
  PUSH_RATE_LIMIT_MS,
  MAX_SYNC_FILE_BYTES,
  DOCS_ROOT,
  STATE_PATH,
  SECRETS_DIR,
  SECRETS_FILE,
  DEFAULT_SYNC_DIRS,
  DEFAULT_CONFLICT_POLICY,
  PUSH_ONLY_DIRS,
};
