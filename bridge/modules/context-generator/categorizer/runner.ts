// ── Worker runtime: queue state, run loop, watchdog ──────────────────────────
// The only file in the categorizer subtree that holds mutable state. admin.ts
// imports the read-only accessors below; never the other way around (one-way
// dependency, no cycles).
'use strict';

const logger = require('../../../core/logger');
const {
  BATCH_SIZE,
  POLL_INTERVAL_MS,
  MAX_CATEGORIZE_ATTEMPTS,
  SENSITIVITY_CONF_THRESHOLD,
} = require('./constants');
const {
  _extractWorkingDir,
  _extractFullForSensitivity,
  _classifyNotesShortcut,
  _deriveTags,
} = require('./extract');
const { _classify } = require('./llm');

// ── Candidate scanning ────────────────────────────────────────────────────────
// Returns sessions that have a title (any source) and no category yet,
// sorted most-recently-updated-first so live work is categorized soonest.

function _getNextBatch(
  size: number,
  skip: ReadonlySet<string> = new Set(),
): Array<{ sid: string; s: any }> {
  const { displaySessions } = require('../../../core/state');

  const candidates: Array<{ sid: string; s: any; ts: number }> = [];

  for (const [sid, s] of displaySessions as Map<string, any>) {
    if (!s || s._inMemoryOnly)         continue;
    // Categorizer runs *after* title; skip sessions that have no name source
    // yet — auto-title will get to them first, then chain into us.
    if (!s._nameSource)                continue;
    if (s.category)                    continue;
    if (skip.has(sid))                 continue;
    // Phase 5.1 — sessions promoted to auto-skipped / user-skipped /
    // user-set are excluded from the queue even if their `category` field
    // happens to be empty (defensive — `auto-skipped` sets `category`, but
    // a future code path might not). Same gate as auto-title's `_nameSource
    // === 'fallback'` check.
    if (s._categorySource === 'auto-skipped') continue;
    if (s._categorySource === 'user-skipped') continue;
    if (s._categorySource === 'user')         continue;
    // At least one assistant reply means there's real content to classify.
    if (!(s.messages || []).some((m: any) => m.role === 'assistant')) continue;
    candidates.push({ sid, s, ts: s.updatedAt ?? s.createdAt ?? 0 });
  }

  candidates.sort((a, b) => b.ts - a.ts);
  return candidates.slice(0, size).map(({ sid, s }) => ({ sid, s }));
}

// ── Process loop ──────────────────────────────────────────────────────────────

async function _runLoop(): Promise<void> {
  const { config }              = require('../../../core/state');
  const { saveSessionToDisk }   = require('../../../sessions-internal/persistence');
  const sensitivity              = require('../sensitivity');

  const skipThisRun  = new Set<string>();
  let totalProcessed = 0;
  let batchesRun     = 0;

  while (true) {
    // Reuse the same toggle as auto-title — operators that don't want any
    // background AI calls can flip the parent off.
    const cfg = config.defaults?.contextCategorizer ?? config.defaults?.autoTitle;
    if (!cfg?.enabled) {
      logger.info('context-categorizer.loop-stopped', { reason: 'disabled', totalProcessed });
      break;
    }

    const model: string        = cfg.model    || 'meta/llama-3.1-8b-instruct';
    const providerName: string = cfg.provider || 'NVIDIA';
    const provider             = (config.providers || []).find((p: any) => p.name === providerName);

    if (!provider) {
      logger.warn('context-categorizer.loop-stopped', { reason: 'provider-not-found', providerName });
      break;
    }
    if (!provider.api_key) {
      logger.warn('context-categorizer.loop-stopped', { reason: 'provider-no-key', providerName });
      break;
    }

    const batch = _getNextBatch(BATCH_SIZE, skipThisRun);
    if (batch.length === 0) {
      _lastRunAt              = Date.now();
      _lastRunCategorizedCount = totalProcessed;
      logger.info('context-categorizer.run-complete', { totalProcessed, batchesRun });
      // ── Per-batch summary SSE ────────────────────────────────────────────
      // The per-session `context:categorized` event is still emitted (kept
      // for any future consumers that need live category info). Surface a
      // SINGLE summary event for the toast layer — one "Categorized: 17
      // sessions" instead of N silent per-session events. Per user request
      // 2026-05-06.
      if (totalProcessed > 0) {
        try {
          const { broadcastEvent } = require('../../workflows-and-triggers/triggers');
          broadcastEvent('context:categorized-batch', { count: totalProcessed });
        } catch (_) { /* triggers not initialised yet */ }
      }
      break;
    }

    batchesRun++;
    logger.info('context-categorizer.batch-start', { batch: batchesRun, count: batch.length });

    for (const { sid, s } of batch) {
      try {
        // ── Deterministic shortcut — `notes` category ──────────────────────
        // Sessions containing a `role === 'note'` message or any user
        // message with a `#note` hashtag are categorised without an LLM
        // round-trip. Keeps the rate-budget free for sessions that actually
        // need a model.
        const wasShortcut = !!_classifyNotesShortcut(s);
        let result: { category: string; tags: string[]; keywords?: string[] } | null = _classifyNotesShortcut(s);
        if (!result) {
          result = await _classify(s, model, provider);
        }
        if (!result) {
          // Phase 5.1 — persistent retry counter. Track lifetime attempts so
          // sessions that keep failing (e.g. malformed model output for an
          // edge-case content shape) get auto-promoted to `general` after
          // MAX_CATEGORIZE_ATTEMPTS, unblocking the pipeline gate.
          skipThisRun.add(sid);
          // Don't burn the attempt budget on transient upstream failures.
          // 67% of past abandonments were rate-limit storms in a 24-min
          // window — three watchdog ticks during one outage permanently
          // sidelined clean sessions. See bucket analysis 2026-05-10.
          const transient = new Set([
            'rate-limited', 'request-timeout', 'request-error',
            'http-500', 'http-502', 'http-503', 'http-504',
          ]);
          if (transient.has((s as any)._categorySkipReason)) {
            logger.info('context-categorizer.transient-skip', {
              sid,
              reason: (s as any)._categorySkipReason,
            });
            continue;
          }
          s._categoryAttempts = (typeof s._categoryAttempts === 'number' ? s._categoryAttempts : 0) + 1;
          if (s._categoryAttempts >= MAX_CATEGORIZE_ATTEMPTS) {
            // Promote to fallback. Pick `general` as the category so the
            // session still appears in the picker (just under a generic
            // bucket); a `_categorySource = 'auto-skipped'` marker stops the
            // worker from re-trying. User can manually re-classify later.
            s.category         = 'general';
            s.tags             = _deriveTags((s.name || '').trim(), _extractWorkingDir(s));
            s._categorySource  = 'auto-skipped';
            s._categorySkippedAt = Date.now();
            s.categorizedAt    = Date.now();
            saveSessionToDisk(sid);
            logger.info('context-categorizer.abandoned', {
              sid,
              attempts:   s._categoryAttempts,
              reason:     s._categorySkipReason || 'max-attempts-reached',
            });
          } else {
            // Persist counter so a restart doesn't reset the failure budget.
            saveSessionToDisk(sid);
            logger.info('context-categorizer.skip', {
              sid,
              attempts:  s._categoryAttempts,
              reason:    s._categorySkipReason || 'no-valid-category',
            });
          }
          continue;
        }
        s.category      = result.category;
        s.tags          = result.tags;
        // Phase 4.3 — keywords[] from LLM. The notes-shortcut doesn't
        // produce keywords (it's deterministic), so we leave `s.keywords`
        // unset when the shortcut path runs — `/v1/context/items?q=…`
        // and the search-index treat absent as empty.
        if (Array.isArray(result.keywords) && result.keywords.length > 0) {
          s.keywords = result.keywords;
        }
        s.categorizedAt = Date.now();
        // Phase 5.1 — record source so the Inspector can distinguish ai-vs-
        // notes-shortcut-vs-user-vs-auto-skipped categorisations, and clear
        // any leftover failure breadcrumbs from previous attempts.
        s._categorySource = wasShortcut ? 'notes-shortcut' : 'ai';
        delete s._categoryAttempts;
        delete s._categorySkippedAt;
        delete s._categorySkipReason;

        // ── Sensitivity proposal ────────────────────────────────────────────
        // Path-based suggestion is deterministic; content-based requires
        // confidence > 0.8 to surface. Manual user overrides are never
        // touched here (`s.sensitivitySource === 'user'`).
        if (s.sensitivitySource !== 'user') {
          const proposal = sensitivity.proposeSensitivity({
            title:   s.name,
            content: _extractFullForSensitivity(s),
            path:    _extractWorkingDir(s),
          });
          if (proposal.tier !== 'public' && proposal.confidence >= SENSITIVITY_CONF_THRESHOLD) {
            s.sensitivity       = proposal.tier;
            s.sensitivitySource = proposal.source;
            s.sensitivityAt     = Date.now();
          } else if (!s.sensitivity) {
            // Explicit baseline — easier for downstream filters than `undefined`.
            s.sensitivity       = 'public';
            s.sensitivitySource = proposal.source;
            s.sensitivityAt     = Date.now();
          }
        }

        saveSessionToDisk(sid);
        totalProcessed++;
        _lifetimeCategorized++;
        logger.info('context-categorizer.classified', {
          sid,
          category:    result.category,
          tags:        result.tags,
          sensitivity: s.sensitivity,
        });
        try {
          const { broadcastEvent } = require('../../workflows-and-triggers/triggers');
          broadcastEvent('context:categorized', {
            sid,
            category:    result.category,
            tags:        result.tags,
            sensitivity: s.sensitivity,
          });
        } catch (_) { /* non-fatal if triggers not initialised */ }
        // NOTE — chain into sorter DEFERRED to end-of-loop. Per user request
        // 2026-05-06 the pipeline is strictly serial: the sorter must not
        // start while ANY uncategorised session remains, otherwise it
        // races with batch N+1 of this worker. Sorter gate consults
        // `isClear()` (defined below) before starting.
      } catch (e) {
        skipThisRun.add(sid);
        logger.warn('context-categorizer.error', {
          sid,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
    // No artificial delay — chain immediately into the next batch.
  }
}

// ── Runtime stats ─────────────────────────────────────────────────────────────

let _lastRunAt:                number | null = null;
let _lastRunCategorizedCount:  number        = 0;
let _lifetimeCategorized:      number        = 0;

// ── Process guard + watchdog ──────────────────────────────────────────────────

let _isRunning = false;

async function _startProcess(): Promise<void> {
  if (_isRunning) return;
  // ── Pipeline gate ──────────────────────────────────────────────────────
  // Per user request 2026-05-06 the categorizer must wait until every
  // session that can be auto-titled has been auto-titled. We re-check the
  // upstream gate here (cheap; same `_getNextBatch(1)` call) to handle
  // races between the watchdog firing and the title-worker enqueueing
  // a new candidate.
  try {
    const at = require('../auto-title');
    if (!at.isClear()) {
      logger.info('context-categorizer.deferred', { reason: 'titler-not-clear' });
      return;
    }
  } catch (_) { /* auto-title module unavailable — proceed; downstream of safety */ }
  _isRunning = true;
  logger.info('context-categorizer.process-started');
  try {
    await _runLoop();
  } catch (e) {
    logger.warn('context-categorizer.process-crashed', {
      error: e instanceof Error ? e.message : String(e),
    });
  } finally {
    _isRunning = false;
    logger.info('context-categorizer.process-ended');
    // ── Chain into the sorter (end-of-loop, gated) ───────────────────────
    // Now that the categorizer has fully drained, hand off to the sorter.
    // The sorter's own gate also re-checks isClear() — defence in depth in
    // case a user manually re-categorises something while the sorter is
    // about to start.
    try {
      if (isClear()) {
        const { kickSorter } = require('../sorter');
        kickSorter();
      }
    } catch (_) { /* sorter not yet loaded — picked up by its own watchdog */ }
  }
}

let _watchdogTimer: ReturnType<typeof setInterval> | null = null;

function startContextCategorizerWorker(): void {
  if (_watchdogTimer) return;

  _watchdogTimer = setInterval(() => {
    if (_isRunning) {
      logger.info('context-categorizer.watchdog-skip', { reason: 'process-still-running' });
      return;
    }
    const { config } = require('../../../core/state');
    const cfg = config.defaults?.contextCategorizer ?? config.defaults?.autoTitle;
    if (!cfg?.enabled) return;
    // Pipeline gate — wait for the title worker to drain.
    try {
      const at = require('../auto-title');
      if (!at.isClear()) {
        logger.info('context-categorizer.watchdog-skip', { reason: 'gated-by-titler' });
        return;
      }
    } catch (_) { /* auto-title unavailable — ignore gate */ }
    if (_getNextBatch(1).length > 0) {
      logger.info('context-categorizer.watchdog-trigger');
      void _startProcess();
    }
  }, POLL_INTERVAL_MS);

  logger.info('context-categorizer.worker-started', {
    pollIntervalMs: POLL_INTERVAL_MS,
    batchSize:      BATCH_SIZE,
  });
}

// ── Lifecycle stop ────────────────────────────────────────────────────────────
// Phase-2 batch F. Called by the context-generator module's deactivate path.
// Same pattern as the auto-title sibling: clear the watchdog interval; the
// in-flight loop (if any) drains naturally on the next iteration via the
// config.enabled re-read.
function stopContextCategorizerWorker(): void {
  if (_watchdogTimer) {
    clearInterval(_watchdogTimer);
    _watchdogTimer = null;
    logger.info('context-categorizer.worker-stopped');
  }
}

// ── Public API ────────────────────────────────────────────────────────────────
// Called by auto-title.ts after a successful title — chains the two workers
// so a freshly-titled session immediately becomes a categorize candidate
// without waiting up to 3 minutes for the next watchdog tick.
function enqueueForCategorization(sid: string): void {
  const { config, displaySessions } = require('../../../core/state');
  const cfg = config.defaults?.contextCategorizer ?? config.defaults?.autoTitle;
  if (!cfg?.enabled) return;
  const s = displaySessions.get(sid);
  if (!s) return;
  if (!s._nameSource) return;
  if (s.category) return;
  // Gate is also enforced inside `_startProcess`; this short-circuits an
  // attempted start while the title worker is still mid-batch.
  try {
    const at = require('../auto-title');
    if (!at.isClear()) return;
  } catch (_) { /* upstream unavailable — proceed */ }
  if (!_isRunning) void _startProcess();
}

function scanAndEnqueueOnStartup(): void {
  const { config } = require('../../../core/state');
  const cfg = config.defaults?.contextCategorizer ?? config.defaults?.autoTitle;
  if (!cfg?.enabled) return;
  if (_getNextBatch(1).length === 0) return;
  // Don't start at boot if the title worker still has work — its own
  // startup-trigger will kick us at end-of-loop via kickCategorizer().
  try {
    const at = require('../auto-title');
    if (!at.isClear()) {
      logger.info('context-categorizer.startup-deferred', { reason: 'titler-not-clear' });
      return;
    }
  } catch (_) { /* upstream unavailable — proceed */ }
  logger.info('context-categorizer.startup-trigger');
  void _startProcess();
}

// ── Pipeline gate + kick ──────────────────────────────────────────────────────
// `isClear()` reports whether the categorizer has fully drained — used by
// the sorter to gate its own start. `kickCategorizer()` is the end-of-loop
// hand-off from the title worker; it short-circuits the up-to-3-min watchdog
// wait when the upstream stage signals it's clear.
function isClear(): boolean {
  const { config } = require('../../../core/state');
  const cfg = config.defaults?.contextCategorizer ?? config.defaults?.autoTitle;
  if (!cfg?.enabled) return true;
  if (_isRunning) return false;
  return _getNextBatch(1).length === 0;
}

function kickCategorizer(): void {
  if (_isRunning) return;
  if (_getNextBatch(1).length === 0) {
    // Nothing to do at this stage — bubble the kick straight to the sorter
    // so an empty categorizer queue doesn't strand a clean upstream from
    // the sorter's pending work.
    try {
      const { kickSorter } = require('../sorter');
      if (typeof kickSorter === 'function') kickSorter();
    } catch (_) { /* sorter not loaded — its watchdog will pick up later */ }
    return;
  }
  void _startProcess();
}

// ── State accessors for admin.ts ─────────────────────────────────────────────
// Read-only views of the runner state so admin can compose status replies and
// trigger fresh runs without touching mutable internals directly.
function _isRunningGet():            boolean       { return _isRunning; }
function _watchdogActive():          boolean       { return _watchdogTimer !== null; }
function _getLastRunAt():            number | null { return _lastRunAt; }
function _getLastRunCategorizedCount(): number     { return _lastRunCategorizedCount; }
function _getLifetimeCategorized():  number        { return _lifetimeCategorized; }

module.exports = {
  startContextCategorizerWorker,
  stopContextCategorizerWorker,
  scanAndEnqueueOnStartup,
  enqueueForCategorization,
  kickCategorizer,
  isClear,
  // Internal accessors consumed by admin.ts only.
  _startProcess,
  _getNextBatch,
  _isRunningGet,
  _watchdogActive,
  _getLastRunAt,
  _getLastRunCategorizedCount,
  _getLifetimeCategorized,
};
