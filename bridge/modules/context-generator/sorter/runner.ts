// ── Context Sorter — runtime / process loop / queue state ───────────────────
// Owns the singleton state (`_isRunning`, `_lastRunAt`, lifetime counters,
// watchdog timer) and drives `_runLoop` + `_startProcess`. Admin operations
// (skipStuck, runNow, …) live in `admin.ts` and reach back into this module
// via `require('./runner')` getters — one-way dependency.
'use strict';

const path   = require('path');
const logger = require('../../../core/logger');

const {
  BATCH_SIZE,
  POLL_INTERVAL_MS,
  MAX_SORT_ATTEMPTS,
  DOCS_GENERATED_ROOT,
  SUBDIR_BY_CATEGORY,
  SUBDIR_BY_TYPE,
  SUBDIR_BY_DATE,
} = require('./constants');

const {
  _slugify,
  _sessionTypePrefix,
  _quarterFromTs,
  _fingerprint,
} = require('./util');

const {
  _renderSessionPage,
  _renderCategoryIndex,
  _renderTypeIndex,
  _renderDateIndex,
  _renderMasterIndex,
  _renderStats,
  _renderSynthesisPage,
} = require('./render-pages');

const {
  _ensureDirs,
  _writeFileAtomic,
  _collectFileMembers,
} = require('./file-io');

const {
  _computeBatchMaps,
  _getNextBatch,
  _collectAllForIndex,
} = require('./batch');

const { _buildContextGraph } = require('./slug-graph');

// ── Runtime stats ─────────────────────────────────────────────────────────────

let _lastRunAt:            number | null = null;
let _lastRunFilesWritten:  number        = 0;
let _lifetimeFilesWritten: number        = 0;

// ── Process guard + watchdog ──────────────────────────────────────────────────

let _isRunning = false;
let _watchdogTimer: ReturnType<typeof setInterval> | null = null;

interface _Member { sid: string; s: any; slug: string; }

interface _FileMember {
  abs:         string;
  basename:    string;
  title:       string;
  category:    string;
  topics:      string[];
  tags:        string[];
  keywords:    string[];
  sensitivity: string;
  mtime:       number;
}

async function _rebuildIndexes(runStats: {
  lastRunAt: number | null;
  lastRunFilesWritten: number;
  lifetimeFilesWritten: number;
}): Promise<number> {
  const all = _collectAllForIndex();

  // Group memberships in single passes.
  const byCat:  Map<string, _Member[]> = new Map();
  const byType: Map<string, _Member[]> = new Map();
  const byDate: Map<string, _Member[]> = new Map();
  for (const m of all) {
    const cat = m.s.category || 'general';
    if (!byCat.has(cat))  byCat.set(cat, []);
    byCat.get(cat)!.push(m);

    const tp = _sessionTypePrefix(m.sid);
    if (!byType.has(tp))  byType.set(tp, []);
    byType.get(tp)!.push(m);

    const q = _quarterFromTs(m.s.createdAt ?? m.s.updatedAt ?? Date.now());
    if (!byDate.has(q))   byDate.set(q, []);
    byDate.get(q)!.push(m);
  }

  let written = 0;

  // ── `_category.md` is deprecated as of 2026-05-07. The legacy renderer
  //    duplicated ~50 % of `<cat>-synthesis.md`'s content (sessions-only
  //    listing, no files), doubled the I/O per pass, and produced twice
  //    the conflict candidates under Syncthing. The synthesis page is now
  //    the single source of truth per category.
  //
  //    The write path is intentionally retained but gated off so the
  //    renderer code (`_renderCategoryIndex`) and the cleanup-on-startup
  //    sweep below stay reachable; flip the env var if you need to
  //    compare outputs during a migration.
  if (process.env.SORTER_LEGACY_CATEGORY === '1') {
    for (const [cat, members] of byCat) {
      const target = path.join(SUBDIR_BY_CATEGORY, cat, '_category.md');
      await _writeFileAtomic(target, _renderCategoryIndex(cat, members));
      written++;
    }
  }

  // Phase 4.2 — synthesis pages. One per known category slug (so even
  // categories with zero session-members still get a synthesis page when
  // file-categorizer assigned them as topics). Built from the same `byCat`
  // map plus the fresh keep-notes scan.
  const fileMembers = _collectFileMembers();
  // Index files-by-topic-or-category so the per-cat lookup stays O(1).
  const filesByCat: Map<string, _FileMember[]> = new Map();
  for (const f of fileMembers) {
    const cats = new Set<string>([f.category, ...f.topics]);
    for (const c of cats) {
      if (!c) continue;
      if (!filesByCat.has(c)) filesByCat.set(c, []);
      filesByCat.get(c)!.push(f);
    }
  }
  // Union of slugs that need a synthesis page: every session category +
  // every file-cat-or-topic. Avoids creating empty `<cat>-synthesis.md`
  // pages for slugs nobody touches.
  const synthSlugs = new Set<string>();
  for (const c of byCat.keys())     synthSlugs.add(c);
  for (const c of filesByCat.keys()) synthSlugs.add(c);
  for (const cat of synthSlugs) {
    const sessions = byCat.get(cat) || [];
    const files    = filesByCat.get(cat) || [];
    if (sessions.length === 0 && files.length === 0) continue;
    const target = path.join(SUBDIR_BY_CATEGORY, cat, `${cat}-synthesis.md`);
    await _writeFileAtomic(target, _renderSynthesisPage(cat, sessions, files));
    written++;
  }

  for (const [tp, members] of byType) {
    const target = path.join(SUBDIR_BY_TYPE, tp + '.md');
    await _writeFileAtomic(target, _renderTypeIndex(tp, members));
    written++;
  }
  for (const [q, members] of byDate) {
    const target = path.join(SUBDIR_BY_DATE, q + '.md');
    await _writeFileAtomic(target, _renderDateIndex(q, members));
    written++;
  }
  await _writeFileAtomic(path.join(DOCS_GENERATED_ROOT, '_index.md'), _renderMasterIndex(all));
  written++;
  await _writeFileAtomic(path.join(DOCS_GENERATED_ROOT, '_stats.md'), _renderStats(all, runStats));
  written++;

  // ── Build the cross-link context graph (new primary product as of
  //    2026-05-06). Cheap; we already iterated displaySessions above.
  try {
    written += await _buildContextGraph();
  } catch (e) {
    logger.warn('context-sorter.graph-build-failed', {
      error: e instanceof Error ? e.message : String(e),
    });
  }

  return written;
}

// ── Process loop ──────────────────────────────────────────────────────────────

async function _runLoop(): Promise<void> {
  const { config }            = require('../../../core/state');
  const { saveSessionToDisk } = require('../../../sessions-internal/persistence');

  const skipThisRun  = new Set<string>();
  let totalProcessed = 0;
  let filesThisRun   = 0;
  let batchesRun     = 0;

  await _ensureDirs();

  while (true) {
    const cfg = config.defaults?.contextSorter;
    if (cfg && cfg.enabled === false) {
      logger.info('context-sorter.loop-stopped', { reason: 'disabled', totalProcessed });
      break;
    }

    // Phase 2.5: snapshot slugs + related-map once per batch so the
    // wikilink-resolver and the eligibility check agree on the same data,
    // and so we never recompute the O(n) maps mid-batch.
    const maps  = _computeBatchMaps();
    const batch = _getNextBatch(BATCH_SIZE, skipThisRun, maps);
    if (batch.length === 0) {
      _lastRunAt           = Date.now();
      _lastRunFilesWritten = filesThisRun;

      // Rebuild indexes once even on a no-op run if some other change might have
      // happened (rename, deletion). Cheap.
      try {
        const indexFiles = await _rebuildIndexes({
          lastRunAt:           _lastRunAt,
          lastRunFilesWritten: _lastRunFilesWritten,
          lifetimeFilesWritten: _lifetimeFilesWritten,
        });
        _lifetimeFilesWritten += indexFiles;
        _lastRunFilesWritten  += indexFiles;
        filesThisRun          += indexFiles;
      } catch (e) {
        logger.warn('context-sorter.index-rebuild-failed', {
          error: e instanceof Error ? e.message : String(e),
        });
      }
      logger.info('context-sorter.run-complete', {
        totalProcessed, filesWritten: filesThisRun, batchesRun,
      });
      try {
        const { broadcastEvent } = require('../../workflows-and-triggers/triggers');
        broadcastEvent('context:wiki-updated', {
          filesWritten:  filesThisRun,
          totalSessions: totalProcessed,
        });
      } catch (_) { /* triggers not initialised yet */ }
      break;
    }

    batchesRun++;
    logger.info('context-sorter.batch-start', { batch: batchesRun, count: batch.length });

    for (const { sid, s, related, relatedKey } of batch) {
      try {
        const slug = _slugify(s.name || '', sid);
        const targetRel = path.join('sessions', `${slug}.md`);
        const targetAbs = path.join(DOCS_GENERATED_ROOT, targetRel);
        await _writeFileAtomic(targetAbs, _renderSessionPage(s, slug, related));

        s.wikiPath        = targetRel;
        s.wikiGenerated   = true;
        s.wikiContentHash = _fingerprint(s, relatedKey);
        s.wikiGeneratedAt = Date.now();
        // Phase 5.3 — successful write supersedes any prior failure
        // breadcrumbs. Clear the counter so a future content-change can
        // start fresh without inheriting old attempt history.
        delete s._sortAttempts;
        delete s._sortSkipReason;
        delete s._sortSkippedAt;

        saveSessionToDisk(sid);
        totalProcessed++;
        filesThisRun++;
        _lifetimeFilesWritten++;
        logger.info('context-sorter.wrote', { sid, wikiPath: targetRel });
      } catch (e) {
        skipThisRun.add(sid);
        const errMsg = e instanceof Error ? e.message : String(e);
        // Phase 5.3 — persistent retry counter so a deterministic write
        // failure (path-too-long, EACCES, full disk) doesn't loop forever.
        s._sortAttempts = (typeof s._sortAttempts === 'number' ? s._sortAttempts : 0) + 1;
        s._sortSkipReason = errMsg.length > 120 ? errMsg.slice(0, 120) + '…' : errMsg;
        if (s._sortAttempts >= MAX_SORT_ATTEMPTS) {
          s._sortSkipped   = true;
          s._sortSkippedAt = Date.now();
          logger.info('context-sorter.abandoned', {
            sid, attempts: s._sortAttempts, reason: errMsg,
          });
        } else {
          logger.warn('context-sorter.error', {
            sid, attempts: s._sortAttempts, error: errMsg,
          });
        }
        try { saveSessionToDisk(sid); } catch (_) { /* persistence-failure is the underlying cause; logged */ }
      }
    }
    // No artificial delay — index rebuild happens once at end-of-run.
  }
}

async function _startProcess(): Promise<void> {
  if (_isRunning) return;
  // ── Pipeline gate ──────────────────────────────────────────────────────
  // Per user request 2026-05-06 the sorter only runs when ALL upstream
  // stages have fully drained. The user explicitly does not want the
  // sorter rebuilding the wiki while titles or categories are still
  // landing — that produces stale links and immediately re-dirty pages.
  try {
    const at  = require('../auto-title');
    const cat = require('../categorizer');
    if (!at.isClear()) {
      logger.info('context-sorter.deferred', { reason: 'titler-not-clear' });
      return;
    }
    if (!cat.isClear()) {
      logger.info('context-sorter.deferred', { reason: 'categorizer-not-clear' });
      return;
    }
  } catch (_) { /* upstream module unavailable — proceed; downstream of safety */ }
  _isRunning = true;
  logger.info('context-sorter.process-started');
  try {
    await _runLoop();
  } catch (e) {
    logger.warn('context-sorter.process-crashed', {
      error: e instanceof Error ? e.message : String(e),
    });
  } finally {
    _isRunning = false;
    logger.info('context-sorter.process-ended');
    // ── Chain into LINK ──────────────────────────────────────────────────
    // Phase 3.1 wiring (2026-05-07). LINK no-ops when disabled or when its
    // own rate-limit bites; otherwise it pushes the freshly-rebuilt vault
    // to the configured adapter (mock / obsidian-rest / …) and pulls any
    // desktop-side edits into `docs/notes`/`calendar`/`mail`.
    //
    // Edge-triggered through the module registry so a disabled or
    // restructured `link` module degrades gracefully (`getModuleApi`
    // returns undefined) and the absence is observable in the registry's
    // module-state diagnostics instead of swallowed by a require-cache
    // throw.
    try {
      const { getModuleApi } = require('../../../core/modules/api');
      getModuleApi('link')?.kickLink();
    } catch (e) {
      logger.warn('context-sorter.link-kick-failed', {
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

function startContextSorterWorker(): void {
  if (_watchdogTimer) return;

  _watchdogTimer = setInterval(() => {
    if (_isRunning) {
      logger.info('context-sorter.watchdog-skip', { reason: 'process-still-running' });
      return;
    }
    const { config } = require('../../../core/state');
    const cfg = config.defaults?.contextSorter;
    if (cfg && cfg.enabled === false) return;
    // Pipeline gate — wait for both upstream stages to drain.
    try {
      const at  = require('../auto-title');
      const cat = require('../categorizer');
      if (!at.isClear()) {
        logger.info('context-sorter.watchdog-skip', { reason: 'gated-by-titler' });
        return;
      }
      if (!cat.isClear()) {
        logger.info('context-sorter.watchdog-skip', { reason: 'gated-by-categorizer' });
        return;
      }
    } catch (_) { /* upstream unavailable — ignore gate */ }
    if (_getNextBatch(1).length > 0) {
      logger.info('context-sorter.watchdog-trigger');
      void _startProcess();
    }
  }, POLL_INTERVAL_MS);

  logger.info('context-sorter.worker-started', {
    pollIntervalMs: POLL_INTERVAL_MS,
    batchSize:      BATCH_SIZE,
    docsRoot:       DOCS_GENERATED_ROOT,
  });
}

// ── Lifecycle stop ────────────────────────────────────────────────────────────
// Phase-2 batch F. Same pattern as the auto-title / categorizer siblings.
function stopContextSorterWorker(): void {
  if (_watchdogTimer) {
    clearInterval(_watchdogTimer);
    _watchdogTimer = null;
    logger.info('context-sorter.worker-stopped');
  }
}

// ── Public API ────────────────────────────────────────────────────────────────
// Called by context-categorizer.ts after a successful classification — same
// chaining pattern as auto-title → categorizer. Skips the up-to-5-minute
// watchdog wait for freshly-categorised sessions.

function enqueueForSort(sid: string): void {
  const { config, displaySessions } = require('../../../core/state');
  const cfg = config.defaults?.contextSorter;
  if (cfg && cfg.enabled === false) return;
  const s = displaySessions.get(sid);
  if (!s) return;
  if (!s.category) return;
  // Skip if already up-to-date — re-compute fingerprint *with* the current
  // related-key so a sibling's rename invalidates this session's hash.
  const { _computeAllSlugs, _computeRelatedMap } = require('./slug-graph');
  const { _relatedKey }                          = require('./util');
  const slugs   = _computeAllSlugs();
  const related = _computeRelatedMap(slugs).get(sid) || [];
  const rk      = _relatedKey(related);
  if (s.wikiGenerated && s.wikiContentHash === _fingerprint(s, rk)) return;
  // Gate is also enforced inside `_startProcess`.
  try {
    const at  = require('../auto-title');
    const cat = require('../categorizer');
    if (!at.isClear() || !cat.isClear()) return;
  } catch (_) { /* upstream unavailable — proceed */ }
  if (!_isRunning) void _startProcess();
}

function scanAndEnqueueOnStartup(): void {
  const { config } = require('../../../core/state');
  const cfg = config.defaults?.contextSorter;
  if (cfg && cfg.enabled === false) return;
  if (_getNextBatch(1).length === 0) return;
  // Don't run the wiki-rebuild at boot if either upstream still has work
  // — the categorizer's end-of-loop kickSorter() will pick us up.
  try {
    const at  = require('../auto-title');
    const cat = require('../categorizer');
    if (!at.isClear()) {
      logger.info('context-sorter.startup-deferred', { reason: 'titler-not-clear' });
      return;
    }
    if (!cat.isClear()) {
      logger.info('context-sorter.startup-deferred', { reason: 'categorizer-not-clear' });
      return;
    }
  } catch (_) { /* upstream unavailable — proceed */ }
  logger.info('context-sorter.startup-trigger');
  void _startProcess();
}

// ── Pipeline gate + kick ──────────────────────────────────────────────────────
function isClear(): boolean {
  const { config } = require('../../../core/state');
  const cfg = config.defaults?.contextSorter;
  if (cfg && cfg.enabled === false) return true;
  if (_isRunning) return false;
  return _getNextBatch(1).length === 0;
}

function kickSorter(): void {
  if (_isRunning) return;
  if (_getNextBatch(1).length === 0) return;
  void _startProcess();
}

// ── State accessors for admin.ts ─────────────────────────────────────────────
// Admin requires the runner module and reaches into these getters; runner
// never imports admin → one-way dependency, no cycle.

function _getIsRunning(): boolean { return _isRunning; }
function _getWatchdogActive(): boolean { return _watchdogTimer !== null; }
function _getLastRunAt(): number | null { return _lastRunAt; }
function _getLastRunFilesWritten(): number { return _lastRunFilesWritten; }
function _getLifetimeFilesWritten(): number { return _lifetimeFilesWritten; }

module.exports = {
  startContextSorterWorker,
  stopContextSorterWorker,
  scanAndEnqueueOnStartup,
  enqueueForSort,
  isClear,
  kickSorter,
  _startProcess,
  _getIsRunning,
  _getWatchdogActive,
  _getLastRunAt,
  _getLastRunFilesWritten,
  _getLifetimeFilesWritten,
};
