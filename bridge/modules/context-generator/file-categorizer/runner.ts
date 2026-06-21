// ── File-Categorizer process loop, watchdog, queue state ─────────────────────
'use strict';

const fs     = require('fs');
const path   = require('path');
const logger = require('../../../core/logger');

const {
  BATCH_SIZE,
  POLL_INTERVAL_MS,
  MAX_FILE_CATEGORIZE_ATTEMPTS,
  KEEP_NOTES_ROOT,
} = require('./constants');
const {
  _isUncategorised,
  _extractBodyForLlm,
  _readCategorizerAttempts,
  _writeAttemptCounter,
  _writeAutoSkippedFrontmatter,
  _writeCategorizerFrontmatter,
} = require('./frontmatter');
const { _classify } = require('./llm');
const { _getNextBatch } = require('./walk');

// ── Runtime stats ─────────────────────────────────────────────────────────────

let _lastRunAt:                number | null = null;
let _lastRunCategorizedCount:  number        = 0;
let _lifetimeCategorized:      number        = 0;

// ── Process guard ─────────────────────────────────────────────────────────────

let _isRunning = false;
let _watchdogTimer: ReturnType<typeof setInterval> | null = null;

// ── Process loop ──────────────────────────────────────────────────────────────

async function _runLoop(): Promise<void> {
  const { config }  = require('../../../core/state');
  const sensitivity = require('../sensitivity');

  const skipThisRun  = new Set<string>();
  let totalProcessed = 0;
  let batchesRun     = 0;

  while (true) {
    const cfg = config.defaults?.fileCategorizer ?? config.defaults?.contextCategorizer ?? config.defaults?.autoTitle;
    if (!cfg?.enabled) {
      logger.info('file-categorizer.loop-stopped', { reason: 'disabled', totalProcessed });
      break;
    }

    const model: string        = cfg.model    || 'meta/llama-3.1-8b-instruct';
    const providerName: string = cfg.provider || 'NVIDIA';
    const provider             = (config.providers || []).find((p: any) => p.name === providerName);
    if (!provider) {
      logger.warn('file-categorizer.loop-stopped', { reason: 'provider-not-found', providerName });
      break;
    }
    if (!provider.api_key) {
      logger.warn('file-categorizer.loop-stopped', { reason: 'provider-no-key', providerName });
      break;
    }

    const batch = _getNextBatch(BATCH_SIZE, skipThisRun);
    if (batch.length === 0) {
      _lastRunAt              = Date.now();
      _lastRunCategorizedCount = totalProcessed;
      logger.info('file-categorizer.run-complete', { totalProcessed, batchesRun });
      if (totalProcessed > 0) {
        try {
          const { broadcastEvent } = require('../../workflows-and-triggers/triggers');
          broadcastEvent('context:file-categorized-batch', { count: totalProcessed });
        } catch (_) { /* triggers not initialised yet */ }
      }
      break;
    }

    batchesRun++;
    logger.info('file-categorizer.batch-start', { batch: batchesRun, count: batch.length });

    for (const cand of batch) {
      try {
        let content: string;
        try { content = fs.readFileSync(cand.abs, 'utf8'); }
        catch (e) {
          skipThisRun.add(cand.abs);
          logger.warn('file-categorizer.read-failed', { path: cand.abs, error: (e as Error).message });
          continue;
        }
        // Re-check eligibility — file might have been categorised between
        // the scan and the per-file processing (concurrent LINK pull).
        if (!_isUncategorised(content)) {
          skipThisRun.add(cand.abs);
          continue;
        }

        const body = _extractBodyForLlm(content);
        // Pre-flight content guard. Files like `"e"` or `"8048#_21asdjp978…"`
        // (5 cases in the past 44 abandonments) waste 3 LLM calls each
        // before the model legitimately returns empty arrays. Mirror the
        // session-side `_classifyJunk` length floor: under ~15 chars there
        // is nothing for a topic/tag classifier to grip on.
        if (!body || body.trim().length < 15) {
          skipThisRun.add(cand.abs);
          // Persist an auto-skipped marker straight away so the file stops
          // re-entering the queue every watchdog tick.
          const next = _writeAutoSkippedFrontmatter(content, {
            attempts:          0,
            reason:            !body ? 'empty-body' : 'content-too-short',
            sensitivity:       'public',
            sensitivitySource: 'auto',
          });
          try {
            fs.writeFileSync(cand.abs, next, 'utf8');
            logger.info('file-categorizer.junk-skipped', {
              path:   path.relative(path.resolve(__dirname, '..', '..', '..', '..'), cand.abs),
              reason: !body ? 'empty-body' : 'content-too-short',
            });
          } catch (e) {
            logger.warn('file-categorizer.write-junk-marker-failed', {
              path:  cand.abs,
              error: (e as Error).message,
            });
          }
          continue;
        }

        // ── Sensitivity proposal (regex-only, runs BEFORE the LLM call so a
        //    `private` tier still propagates even if the LLM call fails) ────
        const proposal = sensitivity.proposeSensitivity({
          title:   path.basename(cand.abs, '.md'),
          content: body,
          path:    cand.abs,
        });
        const tier   = proposal.confidence >= 0.8 ? proposal.tier : 'public';
        const source = proposal.source;

        // ── Classify ───────────────────────────────────────────────────────
        const outcome = await _classify(cand.abs, body, model, provider);
        if (!outcome.ok) {
          // Phase 5.2 — persistent retry counter mirroring the session
          // categorizer. Re-read the current attempts from disk (frontmatter
          // is the state-of-truth so a server restart preserves the counter).
          skipThisRun.add(cand.abs);
          // Don't burn the attempt budget on transient upstream failures —
          // they say nothing about the *file*, just the provider's mood.
          // See bucket analysis 2026-05-10.
          const transient = new Set([
            'rate-limited', 'request-timeout', 'request-error',
            'http-500', 'http-502', 'http-503', 'http-504',
          ]);
          if (transient.has(outcome.reason)) {
            logger.info('file-categorizer.transient-skip', {
              path:   path.relative(path.resolve(__dirname, '..', '..', '..', '..'), cand.abs),
              reason: outcome.reason,
            });
            continue;
          }
          const prevAttempts = _readCategorizerAttempts(content);
          const attempts     = prevAttempts + 1;
          if (attempts >= MAX_FILE_CATEGORIZE_ATTEMPTS) {
            // Auto-promote: write empty topics/tags/keywords + auto-skipped
            // marker so the file stops being eligible. User can manually
            // classify later via /v1/config/file-categorizer/manual.
            const next = _writeAutoSkippedFrontmatter(content, {
              attempts,
              reason:            outcome.reason,
              sensitivity:       tier,
              sensitivitySource: source,
            });
            try {
              fs.writeFileSync(cand.abs, next, 'utf8');
              logger.info('file-categorizer.abandoned', {
                path:     path.relative(path.resolve(__dirname, '..', '..', '..', '..'), cand.abs),
                attempts,
                reason:   outcome.reason,
              });
            } catch (e) {
              logger.warn('file-categorizer.write-skip-marker-failed', {
                path:  cand.abs,
                error: (e as Error).message,
              });
            }
          } else {
            // Persist the counter without writing topics so the file remains
            // in the queue but the next attempt knows it's attempt N+1.
            const next = _writeAttemptCounter(content, { attempts, reason: outcome.reason });
            try {
              fs.writeFileSync(cand.abs, next, 'utf8');
              logger.info('file-categorizer.skip', {
                path:     path.relative(path.resolve(__dirname, '..', '..', '..', '..'), cand.abs),
                attempts,
                reason:   outcome.reason,
              });
            } catch (e) {
              logger.warn('file-categorizer.write-counter-failed', {
                path:  cand.abs,
                error: (e as Error).message,
              });
            }
          }
          continue;
        }
        const result = outcome.result;

        // ── Write back ─────────────────────────────────────────────────────
        const next = _writeCategorizerFrontmatter(content, {
          sensitivity:       tier,
          sensitivitySource: source,
          category:          'keep-notes',
          topics:            result.topics,
          tags:              result.tags,
          keywords:          result.keywords,
        });
        try {
          fs.writeFileSync(cand.abs, next, 'utf8');
        } catch (e) {
          skipThisRun.add(cand.abs);
          logger.warn('file-categorizer.write-failed', { path: cand.abs, error: (e as Error).message });
          continue;
        }

        totalProcessed++;
        _lifetimeCategorized++;
        logger.info('file-categorizer.classified', {
          path:        path.relative(path.resolve(__dirname, '..', '..', '..', '..'), cand.abs),
          topics:      result.topics,
          tags:        result.tags,
          keywords:    result.keywords,
          sensitivity: tier,
        });
        try {
          const { broadcastEvent } = require('../../workflows-and-triggers/triggers');
          broadcastEvent('context:file-categorized', {
            path:        cand.abs,
            topics:      result.topics,
            tags:        result.tags,
            keywords:    result.keywords,
            sensitivity: tier,
          });
        } catch (_) { /* non-fatal */ }
        // Knowledge ingest: a newly categorized keep-note gets its frontmatter
        // sensitivity locked in here, so this is the earliest point at which
        // the RAG pipeline should see the final shape. The watcher will fire
        // on the write too, but the direct hook gets us a synchronous enqueue
        // with no debounce delay.
        try {
          const cg: any = require('../../../core/modules').getModuleApi('context-generator');
          cg?.contextRag?.enqueueKnowledgeForRag?.(cand.abs, 'write');
        } catch (_) { /* context-rag absent — fine */ }
      } catch (e) {
        skipThisRun.add(cand.abs);
        logger.warn('file-categorizer.error', {
          path:  cand.abs,
          error: e instanceof Error ? e.message : String(e),
        });
      }
    }
  }
}

// ── Process guard + watchdog ──────────────────────────────────────────────────

async function _startProcess(): Promise<void> {
  if (_isRunning) return;
  // ── Pipeline gate ─────────────────────────────────────────────────────────
  // The session-categorizer has priority on the LLM rate-budget. We only
  // run when the upstream stage is fully drained — otherwise we'd starve
  // freshly-arrived sessions waiting in the title→categorize pipeline.
  try {
    const cc = require('../categorizer');
    if (typeof cc.isClear === 'function' && !cc.isClear()) {
      logger.info('file-categorizer.deferred', { reason: 'session-categorizer-not-clear' });
      return;
    }
  } catch (_) { /* upstream unavailable — proceed */ }

  _isRunning = true;
  logger.info('file-categorizer.process-started');
  try {
    await _runLoop();
  } catch (e) {
    logger.warn('file-categorizer.process-crashed', {
      error: e instanceof Error ? e.message : String(e),
    });
  } finally {
    _isRunning = false;
    logger.info('file-categorizer.process-ended');
    // Chain into the sorter — newly-categorized files mean the synthesis
    // pages need a refresh. The sorter has its own gate so this is safe.
    try {
      const { kickSorter } = require('../sorter');
      if (typeof kickSorter === 'function') kickSorter();
    } catch (_) { /* sorter not loaded */ }
  }
}

function startFileCategorizerWorker(): void {
  if (_watchdogTimer) return;

  _watchdogTimer = setInterval(() => {
    if (_isRunning) {
      logger.info('file-categorizer.watchdog-skip', { reason: 'process-still-running' });
      return;
    }
    const { config } = require('../../../core/state');
    const cfg = config.defaults?.fileCategorizer ?? config.defaults?.contextCategorizer ?? config.defaults?.autoTitle;
    if (!cfg?.enabled) return;
    // Pipeline gate.
    try {
      const cc = require('../categorizer');
      if (typeof cc.isClear === 'function' && !cc.isClear()) {
        logger.info('file-categorizer.watchdog-skip', { reason: 'gated-by-session-categorizer' });
        return;
      }
    } catch (_) { /* upstream unavailable — ignore */ }
    if (_getNextBatch(1).length > 0) {
      logger.info('file-categorizer.watchdog-trigger');
      void _startProcess();
    }
  }, POLL_INTERVAL_MS);

  logger.info('file-categorizer.worker-started', {
    pollIntervalMs: POLL_INTERVAL_MS,
    batchSize:      BATCH_SIZE,
    root:           KEEP_NOTES_ROOT,
  });
}

// ── Lifecycle stop ────────────────────────────────────────────────────────────
// Phase-2 batch F. Same pattern as the auto-title / categorizer / sorter
// siblings.
function stopFileCategorizerWorker(): void {
  if (_watchdogTimer) {
    clearInterval(_watchdogTimer);
    _watchdogTimer = null;
    logger.info('file-categorizer.worker-stopped');
  }
}

function scanAndEnqueueOnStartup(): void {
  const { config } = require('../../../core/state');
  const cfg = config.defaults?.fileCategorizer ?? config.defaults?.contextCategorizer ?? config.defaults?.autoTitle;
  if (!cfg?.enabled) return;
  if (_getNextBatch(1).length === 0) return;
  // Don't compete with the session-categorizer at boot.
  try {
    const cc = require('../categorizer');
    if (typeof cc.isClear === 'function' && !cc.isClear()) {
      logger.info('file-categorizer.startup-deferred', { reason: 'session-categorizer-not-clear' });
      return;
    }
  } catch (_) { /* upstream unavailable */ }
  logger.info('file-categorizer.startup-trigger');
  void _startProcess();
}

function isClear(): boolean {
  const { config } = require('../../../core/state');
  const cfg = config.defaults?.fileCategorizer ?? config.defaults?.contextCategorizer ?? config.defaults?.autoTitle;
  if (!cfg?.enabled) return true;
  if (_isRunning) return false;
  return _getNextBatch(1).length === 0;
}

function kickFileCategorizer(): void {
  if (_isRunning) return;
  if (_getNextBatch(1).length === 0) return;
  void _startProcess();
}

// ── State accessors for admin module ──────────────────────────────────────────
// admin.ts reads the queue/lifetime state via these getters so we keep the
// module-local `let` bindings authoritative without exporting raw mutables.

function _getIsRunning():               boolean       { return _isRunning; }
function _getWatchdogActive():          boolean       { return _watchdogTimer !== null; }
function _getLastRunAt():               number | null { return _lastRunAt; }
function _getLastRunCategorizedCount(): number        { return _lastRunCategorizedCount; }
function _getLifetimeCategorized():     number        { return _lifetimeCategorized; }

module.exports = {
  startFileCategorizerWorker,
  stopFileCategorizerWorker,
  scanAndEnqueueOnStartup,
  isClear,
  kickFileCategorizer,
  _startProcess,
  _getIsRunning,
  _getWatchdogActive,
  _getLastRunAt,
  _getLastRunCategorizedCount,
  _getLifetimeCategorized,
};
