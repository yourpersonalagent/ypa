// ── Admin / inspector / manual-trigger surface ───────────────────────────────
// User-facing helpers exposed by /v1/config/categorizer/* routes. Reads runner
// state via the accessors in ./runner; never mutates queue internals directly.
'use strict';

const logger = require('../../../core/logger');
const {
  VALID_CATEGORIES,
  CATEGORY_SET,
} = require('./constants');
const {
  _extractWorkingDir,
  _deriveTags,
} = require('./extract');
const runner = require('./runner');

import type { CategorizerDebugRow } from './constants';

function getCategorizerStatus(): {
  isRunning:               boolean;
  watchdogActive:          boolean;
  pendingCount:            number;
  /** Phase 5.1 — sessions promoted to `_categorySource = 'auto-skipped' |
   *  'user-skipped'` after MAX_CATEGORIZE_ATTEMPTS failures. They no longer
   *  block the gate but appear in the Inspector so the user can decide to
   *  retry, manually classify, or accept the fallback. */
  abandonedCount:          number;
  lastRunAt:               number | null;
  lastRunCategorizedCount: number;
  lifetimeCategorized:     number;
  validCategories:         ReadonlyArray<string>;
  enabled:                 boolean;
  /** When non-null, the worker is idle but blocked behind an upstream
   *  stage. The frontend renders "● waiting for {gatedBy}" instead of
   *  "● idle" so the user can see the serial-pipeline order at a glance. */
  gatedBy:                 string | null;
} {
  const { config } = require('../../../core/state');
  const cfg = config.defaults?.contextCategorizer ?? config.defaults?.autoTitle;
  const enabled = !!cfg?.enabled;
  // Compute the upstream-gate reason for the UI. Only relevant when we're
  // not currently running.
  let gatedBy: string | null = null;
  if (enabled && !runner._isRunningGet()) {
    try {
      const at = require('../auto-title');
      if (!at.isClear()) gatedBy = 'titler';
    } catch (_) { /* auto-title not loaded — treat as clear */ }
  }
  const stuck = _countStuckSessions();
  return {
    isRunning:               runner._isRunningGet(),
    watchdogActive:          runner._watchdogActive(),
    pendingCount:            enabled ? stuck.pending : 0,
    abandonedCount:          stuck.abandoned,
    lastRunAt:               runner._getLastRunAt(),
    lastRunCategorizedCount: runner._getLastRunCategorizedCount(),
    lifetimeCategorized:     runner._getLifetimeCategorized(),
    validCategories:         VALID_CATEGORIES,
    enabled,
    gatedBy,
  };
}

// ── Manual triggers (Run-now / Force-rebuild) ────────────────────────────────
// User-facing escape hatches surfaced by /v1/config/categorizer/run-now and
// /v1/config/categorizer/force-rebuild. The latter clears every session's
// `category` so the worker re-classifies the entire history (use-case:
// the user changed the category list, or wants to re-run with a new model).

function runNow(): { kicked: boolean; reason?: string } {
  const { config } = require('../../../core/state');
  const cfg = config.defaults?.contextCategorizer ?? config.defaults?.autoTitle;
  if (!cfg?.enabled) return { kicked: false, reason: 'disabled' };
  if (runner._isRunningGet()) return { kicked: false, reason: 'already-running' };
  // Honour the upstream gate so we don't race the title worker.
  try {
    const at = require('../auto-title');
    if (!at.isClear()) return { kicked: false, reason: 'gated-by-titler' };
  } catch (_) { /* upstream unavailable — proceed */ }
  if (runner._getNextBatch(1).length === 0) return { kicked: false, reason: 'nothing-to-do' };
  void runner._startProcess();
  return { kicked: true };
}

function forceRebuild(): { reset: number; kicked: boolean } {
  const { displaySessions } = require('../../../core/state');
  const { saveSessionToDisk } = require('../../../sessions-internal/persistence');
  let reset = 0;
  for (const [sid, s] of displaySessions as Map<string, any>) {
    if (!s || s._inMemoryOnly) continue;
    if (!s.category) continue;
    delete s.category;
    delete s.tags;
    delete s.keywords;
    delete s.categorizedAt;
    // Phase 5.1 — also wipe stuck-state breadcrumbs so a force-rebuild
    // genuinely starts everything over (auto-skipped sessions get a
    // second chance with the new model/prompt configuration).
    delete s._categorySource;
    delete s._categoryAttempts;
    delete s._categorySkippedAt;
    delete s._categorySkipReason;
    // The wiki page's fingerprint includes category + tags, so the sorter
    // will pick this up next time.
    saveSessionToDisk(sid);
    reset++;
  }
  logger.info('context-categorizer.force-rebuild', { reset });
  let kicked = false;
  if (reset > 0) {
    try {
      const at = require('../auto-title');
      if (at.isClear() && !runner._isRunningGet()) { void runner._startProcess(); kicked = true; }
    } catch (_) {
      if (!runner._isRunningGet()) { void runner._startProcess(); kicked = true; }
    }
  }
  return { reset, kicked };
}

// ── Phase 5.1 — stuck-session machinery ──────────────────────────────────────
// Generalised from the auto-title pattern (auto-title.ts:626–717) so users
// have the same Inspector + Skip-all-stuck + Force-retry + Manual-edit
// affordances for the categorizer that they already have for the title
// worker. See the user-feedback note dated 2026-05-07 ("the categorizer
// hangs with 4 elements … even retrying does not get them processed").

// Returns the count of currently-pending and currently-auto-skipped sessions.
// Used by the dashboard's warning banner so the user sees "5 sessions
// auto-skipped after 3 retries — Inspect to see why".
function _countStuckSessions(): { pending: number; abandoned: number } {
  const { displaySessions } = require('../../../core/state');
  let pending = 0, abandoned = 0;
  for (const [, s] of displaySessions as Map<string, any>) {
    if (!s || s._inMemoryOnly) continue;
    if (!s._nameSource) continue;     // not yet titled — categorizer hasn't seen it
    if (s._categorySource === 'auto-skipped') { abandoned++; continue; }
    if (s._categorySource === 'user-skipped') { abandoned++; continue; }
    if (s.category)                                          continue;
    if (!(s.messages || []).some((m: any) => m.role === 'assistant')) continue;
    pending++;
  }
  return { pending, abandoned };
}

// Mark every currently-pending session as auto-skipped, picking `general`
// as the fallback category. Mirrors auto-title.ts:626–654. Optional `sids`
// targets specific sessions only.
function skipStuck(sids?: ReadonlyArray<string>): { skipped: number; details: Array<{ sid: string; category: string }> } {
  const { displaySessions } = require('../../../core/state');
  const { saveSessionToDisk } = require('../../../sessions-internal/persistence');
  const targetSet = sids && sids.length > 0 ? new Set(sids) : null;
  const details: Array<{ sid: string; category: string }> = [];
  for (const [sid, s] of displaySessions as Map<string, any>) {
    if (!s || s._inMemoryOnly) continue;
    if (targetSet && !targetSet.has(sid)) continue;
    if (s._categorySource === 'user') continue;          // never overwrite user
    // With a filter the user can also re-skip an already auto-skipped session
    // (e.g. as a manual reset before applying a manual category). Without a
    // filter we skip only sessions that haven't been categorised yet.
    if (!targetSet && s.category && s._categorySource !== 'auto-skipped') continue;
    s.category           = s.category || 'general';
    s.tags               = s.tags || _deriveTags((s.name || '').trim(), _extractWorkingDir(s));
    s.categorizedAt      = s.categorizedAt || Date.now();
    s._categorySource    = 'user-skipped';
    s._categorySkipReason = (s._categorySkipReason && s._categorySkipReason.startsWith('junk:'))
      ? s._categorySkipReason
      : 'user-skipped';
    s._categorySkippedAt = Date.now();
    saveSessionToDisk(sid);
    details.push({ sid, category: s.category });
  }
  logger.info('context-categorizer.skip-stuck', { skipped: details.length, targeted: !!targetSet });
  return { skipped: details.length, details };
}

// Resets the stuck-state breadcrumbs on every previously auto-skipped or
// user-skipped session so they re-enter the queue. Mirrors auto-title's
// `forceRetryAbandoned`.
function forceRetryAbandoned(): { reset: number; kicked: boolean } {
  const { displaySessions } = require('../../../core/state');
  const { saveSessionToDisk } = require('../../../sessions-internal/persistence');
  let reset = 0;
  for (const [sid, s] of displaySessions as Map<string, any>) {
    if (!s || s._inMemoryOnly) continue;
    if (s._categorySource !== 'auto-skipped' && s._categorySource !== 'user-skipped') continue;
    delete s.category;
    delete s.tags;
    delete s.keywords;
    delete s.categorizedAt;
    delete s._categorySource;
    delete s._categoryAttempts;
    delete s._categorySkippedAt;
    delete s._categorySkipReason;
    saveSessionToDisk(sid);
    reset++;
  }
  logger.info('context-categorizer.force-retry-abandoned', { reset });
  let kicked = false;
  if (reset > 0 && !runner._isRunningGet()) {
    try {
      const at = require('../auto-title');
      if (at.isClear()) { void runner._startProcess(); kicked = true; }
    } catch (_) { void runner._startProcess(); kicked = true; }
  }
  return { reset, kicked };
}

// Apply a user-supplied category + tags + keywords directly. Used by the
// "Edit & commit" form in the Inspector panel for sessions where the model
// keeps failing or the user simply wants a specific value. Does NOT touch
// sensitivity (that's a separate confirm-gated path).
function applyManualCategory(
  sid:      string,
  payload:  { category: string; tags?: string[]; keywords?: string[] },
): { applied: boolean; reason?: string } {
  const { displaySessions } = require('../../../core/state');
  const { saveSessionToDisk } = require('../../../sessions-internal/persistence');
  const s = displaySessions.get(sid);
  if (!s) return { applied: false, reason: 'unknown-session' };
  const cat = String(payload.category || '').trim().toLowerCase();
  if (!CATEGORY_SET.has(cat)) return { applied: false, reason: 'invalid-category' };
  // Use the same boundary-aware truncation as the LLM path — see
  // _sanitiseSlugList in categorizer/llm.ts.
  const _truncAtDash = (s: string, max: number): string => {
    if (s.length <= max) return s;
    const cut = s.lastIndexOf('-', max);
    return cut > Math.floor(max / 2) ? s.slice(0, cut) : s.slice(0, max);
  };
  const tags = Array.isArray(payload.tags)
    ? payload.tags
        .map((t) => String(t).trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, ''))
        .filter((t) => t.length > 0)
        .map((t) => _truncAtDash(t, 20))
        .slice(0, 5)
    : [];
  const keywords = Array.isArray(payload.keywords)
    ? payload.keywords
        .map((k) => String(k).trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, ''))
        .filter((k) => k.length > 0)
        .map((k) => _truncAtDash(k, 25))
        .slice(0, 8)
    : [];
  s.category        = cat;
  s.tags            = tags.length > 0 ? tags : (s.tags || []);
  s.keywords        = keywords.length > 0 ? keywords : (s.keywords || []);
  s.categorizedAt   = Date.now();
  s._categorySource = 'user';
  delete s._categoryAttempts;
  delete s._categorySkippedAt;
  delete s._categorySkipReason;
  saveSessionToDisk(sid);
  logger.info('context-categorizer.manual-applied', { sid, category: cat });
  return { applied: true };
}

// Returns up to 50 most-stuck rows so the Inspector panel can show "what's
// stuck and why". Auto-skipped first (oldest skippedAt last), then pending
// by highest-attempts, then by most-recently-updated.
function getDebugInfo(): { rows: CategorizerDebugRow[]; pending: number; abandoned: number } {
  const { displaySessions } = require('../../../core/state');
  const rows: CategorizerDebugRow[] = [];
  let pending = 0, abandoned = 0;

  const _msgText = (m: any): string => {
    let t: string = m.text || '';
    if (!t && Array.isArray(m.blocks)) {
      t = m.blocks.filter((b: any) => b.type === 'text').map((b: any) => b.content || '').join(' ');
    }
    return t.trim();
  };

  for (const [sid, s] of displaySessions as Map<string, any>) {
    if (!s || s._inMemoryOnly) continue;
    if (!s._nameSource) continue;
    const isAbandoned = s._categorySource === 'auto-skipped' || s._categorySource === 'user-skipped';
    const isPending   = !isAbandoned && !s.category;
    if (!isAbandoned && !isPending) continue;
    if (isPending) {
      if (!(s.messages || []).some((m: any) => m.role === 'assistant')) continue;
    }
    const userMsg = (s.messages || []).find((m: any) => m.role === 'user');
    const lastAss = [...(s.messages || [])].reverse().find((m: any) => m.role === 'assistant');
    rows.push({
      sid,
      name:             s.name || '',
      category:         s.category || null,
      categorySource:   s._categorySource ?? null,
      attempts:         typeof s._categoryAttempts === 'number' ? s._categoryAttempts : 0,
      skipReason:       s._categorySkipReason || null,
      skippedAt:        s._categorySkippedAt || null,
      messageCount:     (s.messages || []).length,
      userPreview:      userMsg ? _msgText(userMsg).slice(0, 160) : '',
      assistantPreview: lastAss ? _msgText(lastAss).slice(0, 160) : '',
      state:            isAbandoned ? 'abandoned' : 'pending',
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
  getCategorizerStatus,
  runNow,
  forceRebuild,
  skipStuck,
  forceRetryAbandoned,
  applyManualCategory,
  getDebugInfo,
  _countStuckSessions,
};
