// ── Context Sorter — admin / status / manual triggers ───────────────────────
// User-facing escape hatches surfaced by /v1/config/sorter/* routes:
//   - getSorterStatus     → live dashboard card payload
//   - runNow              → force a one-shot batch (gate-respecting)
//   - forceRebuild        → wipe every wikiContentHash so all pages re-render
//   - skipStuck           → mark stuck sessions as user-skipped
//   - forceRetryAbandoned → re-enter auto-skipped sessions into the queue
//   - getDebugInfo        → up to 50 stuck-row Inspector rows
//
// Admin reaches into runner state via `require('./runner')` getters; runner
// never depends on admin. One-way dependency by design.
'use strict';

const logger = require('../../../core/logger');

const { DOCS_GENERATED_ROOT } = require('./constants');
const { _fingerprint, _relatedKey } = require('./util');
const { _computeBatchMaps, _countStuckSessions } = require('./batch');

interface SorterDebugRow {
  sid:           string;
  name:          string;
  category:      string | null;
  attempts:      number;
  skipReason:    string | null;
  skippedAt:     number | null;
  wikiPath:      string | null;
  state:         'pending' | 'abandoned';
}

function getSorterStatus(): {
  isRunning:            boolean;
  watchdogActive:       boolean;
  pendingCount:         number;
  /** Phase 5.3 — sessions auto-skipped after MAX_SORT_ATTEMPTS write
   *  failures (e.g. EACCES, path-too-long, full disk). They no longer
   *  block `isClear()` but appear in the Inspector for review. */
  abandonedCount:       number;
  lastRunAt:            number | null;
  lastRunFilesWritten:  number;
  lifetimeFilesWritten: number;
  docsRoot:             string;
  enabled:              boolean;
  /** When non-null, the worker is idle but blocked behind an upstream
   *  stage. The frontend renders "● waiting for {gatedBy}" instead of
   *  "● idle". One of: `'titler'` | `'categorizer'`. */
  gatedBy:              string | null;
} {
  const { config } = require('../../../core/state');
  const runner = require('./runner');
  const cfg = config.defaults?.contextSorter;
  const enabled = !(cfg && cfg.enabled === false);
  // Compute upstream-gate reason for the UI.
  let gatedBy: string | null = null;
  if (enabled && !runner._getIsRunning()) {
    try {
      const at  = require('../auto-title');
      const cat = require('../categorizer');
      if (!at.isClear())  gatedBy = 'titler';
      else if (!cat.isClear()) gatedBy = 'categorizer';
    } catch (_) { /* upstream unavailable — treat as clear */ }
  }
  const stuck = _countStuckSessions();
  return {
    isRunning:            runner._getIsRunning(),
    watchdogActive:       runner._getWatchdogActive(),
    pendingCount:         enabled ? stuck.pending : 0,
    abandonedCount:       stuck.abandoned,
    lastRunAt:            runner._getLastRunAt(),
    lastRunFilesWritten:  runner._getLastRunFilesWritten(),
    lifetimeFilesWritten: runner._getLifetimeFilesWritten(),
    docsRoot:             DOCS_GENERATED_ROOT,
    enabled,
    gatedBy,
  };
}

// ── Manual triggers (Run-now / Force-rebuild) ────────────────────────────────
// User-facing escape hatches surfaced by /v1/config/sorter/run-now and
// /v1/config/sorter/force-rebuild. Force-rebuild clears the per-session
// `wikiContentHash` so EVERY page is re-rendered from scratch — useful
// after a layout change to the Markdown templates or a category-list edit.

function runNow(): { kicked: boolean; reason?: string } {
  const { config } = require('../../../core/state');
  const runner = require('./runner');
  const { _getNextBatch } = require('./batch');
  const cfg = config.defaults?.contextSorter;
  if (cfg && cfg.enabled === false) return { kicked: false, reason: 'disabled' };
  if (runner._getIsRunning()) return { kicked: false, reason: 'already-running' };
  try {
    const at  = require('../auto-title');
    const cat = require('../categorizer');
    if (!at.isClear())  return { kicked: false, reason: 'gated-by-titler' };
    if (!cat.isClear()) return { kicked: false, reason: 'gated-by-categorizer' };
  } catch (_) { /* upstream unavailable — proceed */ }
  if (_getNextBatch(1).length === 0) return { kicked: false, reason: 'nothing-to-do' };
  void runner._startProcess();
  return { kicked: true };
}

function forceRebuild(): { reset: number; kicked: boolean } {
  const { displaySessions } = require('../../../core/state');
  const { saveSessionToDisk } = require('../../../sessions-internal/persistence');
  const runner = require('./runner');
  let reset = 0;
  for (const [sid, s] of displaySessions as Map<string, any>) {
    if (!s || s._inMemoryOnly) continue;
    if (!s.category) continue; // nothing to write for this session anyway
    if (s.wikiContentHash || s.wikiGenerated) {
      delete s.wikiContentHash;
      // Keep wikiPath / wikiGeneratedAt so existing files are overwritten,
      // but clear the dirty flag so _getNextBatch picks them up.
      s.wikiGenerated = false;
      // Phase 5.3 — wipe stuck breadcrumbs so previously auto-skipped
      // sessions get a second chance to write.
      delete s._sortSkipped;
      delete s._sortAttempts;
      delete s._sortSkipReason;
      delete s._sortSkippedAt;
      saveSessionToDisk(sid);
      reset++;
    } else {
      reset++; // counts toward "to-be-generated"; no save needed
    }
  }
  logger.info('context-sorter.force-rebuild', { reset });
  let kicked = false;
  if (reset > 0) {
    try {
      const at  = require('../auto-title');
      const cat = require('../categorizer');
      if (at.isClear() && cat.isClear() && !runner._getIsRunning()) { void runner._startProcess(); kicked = true; }
    } catch (_) {
      if (!runner._getIsRunning()) { void runner._startProcess(); kicked = true; }
    }
  }
  return { reset, kicked };
}

// ── Phase 5.3 — stuck-session machinery ───────────────────────────────────────
// Mirrors auto-title.ts and context-categorizer.ts. The sorter has no
// "manual edit" path — its output is deterministic from session data — so
// we only expose Skip-all-stuck, Force-retry-abandoned, and an Inspector.

function skipStuck(sids?: ReadonlyArray<string>): { skipped: number; details: Array<{ sid: string }> } {
  const { displaySessions } = require('../../../core/state');
  const { saveSessionToDisk } = require('../../../sessions-internal/persistence');
  const targetSet = sids && sids.length > 0 ? new Set(sids) : null;
  const details: Array<{ sid: string }> = [];
  for (const [sid, s] of displaySessions as Map<string, any>) {
    if (!s || s._inMemoryOnly) continue;
    if (!s.category) continue;
    if (targetSet && !targetSet.has(sid)) continue;
    if (s._sortSkipped === true) {
      // Already skipped; only re-touch when a filter explicitly targets it
      // (e.g. user wants to update the skip reason).
      if (!targetSet) continue;
    }
    s._sortSkipped   = true;
    s._sortSkippedAt = Date.now();
    if (!s._sortSkipReason) s._sortSkipReason = 'user-skipped';
    saveSessionToDisk(sid);
    details.push({ sid });
  }
  logger.info('context-sorter.skip-stuck', { skipped: details.length, targeted: !!targetSet });
  return { skipped: details.length, details };
}

function forceRetryAbandoned(): { reset: number; kicked: boolean } {
  const { displaySessions } = require('../../../core/state');
  const { saveSessionToDisk } = require('../../../sessions-internal/persistence');
  const runner = require('./runner');
  let reset = 0;
  for (const [sid, s] of displaySessions as Map<string, any>) {
    if (!s || s._inMemoryOnly) continue;
    if (s._sortSkipped !== true) continue;
    delete s._sortSkipped;
    delete s._sortAttempts;
    delete s._sortSkipReason;
    delete s._sortSkippedAt;
    // Force a re-render — the previous wiki-page (if any) might be stale.
    delete s.wikiContentHash;
    s.wikiGenerated = false;
    saveSessionToDisk(sid);
    reset++;
  }
  logger.info('context-sorter.force-retry-abandoned', { reset });
  let kicked = false;
  if (reset > 0 && !runner._getIsRunning()) {
    try {
      const at  = require('../auto-title');
      const cat = require('../categorizer');
      if (at.isClear() && cat.isClear()) { void runner._startProcess(); kicked = true; }
    } catch (_) { void runner._startProcess(); kicked = true; }
  }
  return { reset, kicked };
}

function getDebugInfo(): { rows: SorterDebugRow[]; pending: number; abandoned: number } {
  const { displaySessions } = require('../../../core/state');
  const rows: SorterDebugRow[] = [];
  let pending = 0, abandoned = 0;
  const m = _computeBatchMaps();
  for (const [sid, s] of displaySessions as Map<string, any>) {
    if (!s || s._inMemoryOnly) continue;
    if (!s.category) continue;
    const isAbandoned = s._sortSkipped === true;
    let isPending = false;
    if (!isAbandoned) {
      const related = m.related.get(sid) || [];
      const fp = _fingerprint(s, _relatedKey(related));
      isPending = !(s.wikiGenerated && s.wikiContentHash === fp);
      // Only show pending sessions that have actually been attempted at
      // least once — never-attempted sessions aren't "stuck", they're just
      // queued. (Keeps the panel signal-to-noise high.)
      if (isPending && (typeof s._sortAttempts !== 'number' || s._sortAttempts === 0)) continue;
    }
    if (!isAbandoned && !isPending) continue;
    rows.push({
      sid,
      name:        s.name || '',
      category:    s.category || null,
      attempts:    typeof s._sortAttempts === 'number' ? s._sortAttempts : 0,
      skipReason:  s._sortSkipReason || null,
      skippedAt:   s._sortSkippedAt || null,
      wikiPath:    s.wikiPath || null,
      state:       isAbandoned ? 'abandoned' : 'pending',
    });
    if (isAbandoned) abandoned++; else pending++;
  }
  rows.sort((a, b) => {
    if (a.state !== b.state) return a.state === 'abandoned' ? -1 : 1;
    if (a.attempts !== b.attempts) return b.attempts - a.attempts;
    return (b.skippedAt || 0) - (a.skippedAt || 0);
  });
  return { rows: rows.slice(0, 50), pending, abandoned };
}

module.exports = {
  getSorterStatus,
  runNow,
  forceRebuild,
  skipStuck,
  forceRetryAbandoned,
  getDebugInfo,
};
