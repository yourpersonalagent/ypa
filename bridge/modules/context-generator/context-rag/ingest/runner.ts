// ── context-rag ingest runner ─────────────────────────────────────────────────
// Slot-2 leg of the context-generator chain. Drains the unified queue
// (session | file | knowledge) one item at a time, dispatching to the right
// per-kind ingest function.
//
// State machine
// ─────────────
//   idle     no work pending, watchdog dormant-but-armed
//   waiting  queue has items but a gate keeps us from starting
//            (upstream auto-title not clear, config disabled, no DBs care)
//   running  actively draining the queue
//
// Pattern mirrors the categorizer:
//   - 3-minute watchdog as the fallback trigger
//   - end-of-loop chain handoff to the next leg (kickCategorizer)
//   - immediate kick from upstream short-circuits the watchdog wait
//
// IMPORTANT: this leg does NOT gate the categorizer. The categorizer's gate
// remains `auto-title.isClear()` — RAG ingest is a parallel pipeline that
// happens to live in the same chain index. The runner only chains
// downstream to kick the categorizer; it never blocks it.
'use strict';

const logger = require('../../../../core/logger');

import * as queue from './queue';
import { ingestSession } from './sessions';
import { ingestFile } from './files';
import { ingestKnowledge } from './knowledge';
import { ingestSynthesis } from './synthesis';
import { listDbs, getDb, updateDb } from '../registry/store';

const POLL_INTERVAL_MS = 3 * 60 * 1_000; // watchdog cadence: 3 minutes

// ── Runtime stats (read-only accessors below) ────────────────────────────────

let _isRunning            = false;
let _watchdogTimer: ReturnType<typeof setInterval> | null = null;
let _lastRunAt: number | null      = null;
let _lastRunIngestedCount: number  = 0;
let _lifetimeIngested: number      = 0;
let _lastError: string | null      = null;

// ── Config + gate ────────────────────────────────────────────────────────────

interface RagConfig {
  enabled: boolean;
}

function _readConfig(): RagConfig {
  try {
    const { config } = require('../../../../core/state');
    // contextRag inherits the auto-title enable flag when its own toggle
    // isn't present — same pattern as the categorizer / sorter. Operators
    // who want every background AI off flip the parent (autoTitle.enabled)
    // and this leg goes dormant too.
    const own = config?.defaults?.contextRag;
    const parent = config?.defaults?.autoTitle;
    if (own && typeof own.enabled === 'boolean') return { enabled: own.enabled };
    if (parent && typeof parent.enabled === 'boolean') return { enabled: parent.enabled };
    return { enabled: true };
  } catch (_) {
    return { enabled: true };
  }
}

function _registryHasDBs(): boolean {
  try { return listDbs().length > 0; } catch (_) { return false; }
}

function _upstreamClear(): boolean {
  // Defensive: if the upstream module isn't loaded yet (cold boot order),
  // proceed — the watchdog will catch any contention on the next tick.
  try {
    const at = require('../../auto-title');
    if (typeof at.isClear === 'function') return at.isClear();
  } catch (_) { /* upstream not loaded */ }
  return true;
}

// ── Boot-time entitlement probe ──────────────────────────────────────────────
// Runs once per worker start if the cache is stale (>24h) or missing. The
// probe is async + fire-and-forget — operators get accurate `embedModelStatus`
// after a few seconds without paying the latency on every boot. Errors are
// logged but never thrown; the UI handles `unknown` status gracefully.

async function _kickBootProbeIfStale(): Promise<void> {
  let ent: any;
  let probe: any;
  let providerResolver: any;
  try {
    ent              = require('../registry/entitlements');
    probe            = require('../embed/probe-entitlements');
    providerResolver = require('../embed/client-for-db');
  } catch (e) {
    logger.warn('context-rag.entitlement-probe.modules-missing', {
      error: e instanceof Error ? e.message : String(e),
    });
    return;
  }
  // NVIDIA-curated short-list (matches the route's NVIDIA_CURATED_EMBED_MODELS).
  // Duplicating here avoids importing from routes/* into modules/* (the
  // dependency arrow points modules → routes, never the reverse).
  const NVIDIA_CURATED = [
    'nvidia/nv-embedqa-e5-v5',
    'nvidia/llama-3.2-nv-embedqa-1b-v2',
    'nvidia/llama-3.2-nemoretriever-300m-embed-v1',
    'nvidia/llama-nemotron-embed-1b-v2',
    'nvidia/llama-nemotron-embed-vl-1b-v2',
    'nvidia/nv-embed-v1',
    'nvidia/nv-embedcode-7b-v1',
  ];
  const inUse: Record<'nvidia' | 'lmstudio', Set<string>> = {
    nvidia: new Set(), lmstudio: new Set(),
  };
  try {
    for (const db of listDbs()) {
      if (db.embedProvider === 'nvidia' || db.embedProvider === 'lmstudio') {
        inUse[db.embedProvider].add(db.embedModel);
      }
    }
  } catch (_) { /* no DBs / registry empty */ }

  for (const provider of ['nvidia', 'lmstudio'] as const) {
    if (!ent.isStale(provider)) continue;
    const record = providerResolver.findProviderForEmbed(provider);
    if (!record) continue; // skip provider that isn't configured at all
    // NVIDIA only probes the curated subset on boot; LM Studio is local and
    // cheap so we'd probe everything via the route's POST. The boot path
    // keeps it minimal to avoid burning a wide network probe on cold start.
    const models = provider === 'nvidia'
      ? Array.from(new Set([...NVIDIA_CURATED, ...inUse.nvidia]))
      : Array.from(inUse.lmstudio); // boot-only: just verify currently-used ids
    if (models.length === 0) continue;
    try {
      const entry = await probe.probeEntitlements(provider, record, models);
      ent.setProviderEntitlement(provider, entry);
      logger.info('context-rag.entitlement-probe.boot', {
        provider,
        probed: models.length,
        available: entry.available.length,
        unavailable: entry.unavailable.length,
      });
    } catch (e) {
      logger.warn('context-rag.entitlement-probe.boot-failed', {
        provider,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

// ── Process loop ─────────────────────────────────────────────────────────────

interface KindStats {
  seen: number;
  /** Items where any DB wrote >0 chunks. */
  written: number;
  /** Items where every DB skipped (already-ingested / mtime-unchanged). */
  unchanged: number;
  /** Items that threw. */
  errored: number;
  /** Total chunks written summed across DBs across items of this kind. */
  chunks: number;
}

function _emptyKindStats(): KindStats {
  return { seen: 0, written: 0, unchanged: 0, errored: 0, chunks: 0 };
}

interface PerDbDelta {
  /** Chunks written this pass — added on top of the persisted dbs.json count. */
  chunks: number;
  /** Last error seen this pass for this DB; null if every item succeeded. */
  lastError: string | null;
  /** Whether at least one item touched this DB (success or failure). Determines
   *  if we update lastIngestAt. */
  touched: boolean;
}

async function _runLoop(): Promise<{
  processed: number;
  perKind: Record<string, KindStats>;
  perDb: Map<string, PerDbDelta>;
  durationMs: number;
}> {
  const t0 = Date.now();
  let processed = 0;
  const perKind: Record<string, KindStats> = {
    session:   _emptyKindStats(),
    file:      _emptyKindStats(),
    knowledge: _emptyKindStats(),
    synthesis: _emptyKindStats(),
  };
  // dbId → running deltas. Populated from each item's `dbResults` so the
  // persisted dbs.json stays accurate without paying N disk writes per pass.
  const perDb: Map<string, PerDbDelta> = new Map();
  function _accumDbResults(dbResults: Array<{ dbId: string; written: number; error?: string }>): void {
    for (const r of dbResults) {
      const cur = perDb.get(r.dbId) ?? { chunks: 0, lastError: null, touched: false };
      cur.chunks += r.written || 0;
      cur.touched = true;
      if (r.error) cur.lastError = r.error;
      perDb.set(r.dbId, cur);
    }
  }
  while (true) {
    const cfg = _readConfig();
    if (!cfg.enabled) {
      logger.info('context-rag.loop-stopped', { reason: 'disabled', processed });
      break;
    }
    if (!_registryHasDBs()) {
      logger.info('context-rag.loop-stopped', { reason: 'no-dbs', processed });
      break;
    }
    const item = queue.dequeue();
    if (!item) {
      logger.info('context-rag.run-complete', { processed });
      break;
    }
    const stats = perKind[item.kind] ?? _emptyKindStats();
    stats.seen++;
    try {
      let written = 0;
      if (item.kind === 'session') {
        const res = await ingestSession(item.sourceId);
        written = res.dbResults.reduce((acc, r) => acc + r.written, 0);
        _accumDbResults(res.dbResults);
      } else if (item.kind === 'file') {
        const res = await ingestFile(item.sourceId);
        written = res.dbResults.reduce((acc, r) => acc + r.written, 0);
        _accumDbResults(res.dbResults);
      } else if (item.kind === 'knowledge') {
        const res = await ingestKnowledge(item.sourceId);
        written = res.dbResults.reduce((acc, r) => acc + r.written, 0);
        _accumDbResults(res.dbResults);
      } else if (item.kind === 'synthesis') {
        const res = await ingestSynthesis(item.sourceId);
        written = res.dbResults.reduce((acc, r) => acc + r.written, 0);
        _accumDbResults(res.dbResults);
      }
      stats.chunks += written;
      if (written > 0) { stats.written++; processed++; }
      else { stats.unchanged++; }
      _lastError = null;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      _lastError = msg;
      stats.errored++;
      logger.warn('context-rag.item-failed', {
        kind: item.kind, sourceId: item.sourceId, error: msg,
      });
      // Failure for ONE item doesn't poison the queue — we move on. The
      // per-DB delete-then-insert transaction guarantees the vector store
      // is in a clean state for the next pass.
    }
    perKind[item.kind] = stats;
  }
  return { processed, perKind, perDb, durationMs: Date.now() - t0 };
}

/** Persist per-pass deltas back into each DB's `stats` block in dbs.json.
 *  Called once per pass (not per item) so a long ingest run produces a single
 *  registry write. Failures are logged but never thrown — stats writeback is
 *  best-effort accounting, not pipeline-critical. */
function _persistPerDbDeltas(perDb: Map<string, PerDbDelta>): void {
  const now = Date.now();
  for (const [dbId, delta] of perDb) {
    if (!delta.touched) continue;
    try {
      const cur = getDb(dbId);
      if (!cur) continue; // removed between pass start and end
      const nextStats = {
        chunks: (cur.stats?.chunks ?? 0) + delta.chunks,
        lastIngestAt: now,
        lastError: delta.lastError, // explicit: null clears the previous error
      };
      updateDb(dbId, { stats: nextStats });
    } catch (e) {
      logger.warn('context-rag.stats-writeback-failed', {
        dbId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

async function _startProcess(): Promise<void> {
  if (_isRunning) return;
  const cfg = _readConfig();
  if (!cfg.enabled) {
    logger.info('context-rag.deferred', { reason: 'disabled' });
    return;
  }
  if (!_registryHasDBs()) {
    logger.info('context-rag.deferred', { reason: 'no-dbs' });
    return;
  }
  if (queue.size() === 0) {
    return;
  }
  _isRunning = true;
  const queueDepthAtStart = queue.size();
  logger.info('context-rag.process-started', { queueDepth: queueDepthAtStart });
  let processed = 0;
  let perKind: Record<string, KindStats> = {};
  let durationMs = 0;
  let perDb: Map<string, PerDbDelta> = new Map();
  try {
    const r = await _runLoop();
    processed  = r.processed;
    perKind    = r.perKind;
    perDb      = r.perDb;
    durationMs = r.durationMs;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    _lastError = msg;
    logger.warn('context-rag.process-crashed', { error: msg });
  } finally {
    _isRunning = false;
    _lastRunAt = Date.now();
    _lastRunIngestedCount = processed;
    _lifetimeIngested += processed;
    // Persist accumulated per-DB chunk counts back to dbs.json. The UI tab
    // and rag_list_dbs both read from this registry; without this writeback
    // every DB looks empty even after ingesting GBs.
    _persistPerDbDeltas(perDb);
    // Single chain-pass summary line: one log entry that captures everything
    // an operator needs to read the pass at a glance — duration, per-kind
    // seen/written/unchanged/errored, total chunks. The pre-existing
    // `process-ended` line stays for back-compat with any log greps; the
    // new `chain-pass` line is the structured one tooling should grep.
    logger.info('context-rag.chain-pass', {
      durationMs,
      queueDepthAtStart,
      processed,
      session:   perKind.session   ?? _emptyKindStats(),
      file:      perKind.file      ?? _emptyKindStats(),
      knowledge: perKind.knowledge ?? _emptyKindStats(),
      synthesis: perKind.synthesis ?? _emptyKindStats(),
      remainingQueue: queue.size(),
    });
    logger.info('context-rag.process-ended', { processed });
    // Chain into the categorizer. The categorizer has its own gate
    // (auto-title.isClear()) so this kick is a no-op if the title worker
    // is still mid-batch; otherwise it gives the categorizer the earliest
    // possible start.
    try {
      const { kickCategorizer } = require('../../categorizer');
      if (typeof kickCategorizer === 'function') kickCategorizer();
    } catch (_) { /* categorizer not loaded — watchdog picks it up */ }
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

function startContextRagWorker(): void {
  if (_watchdogTimer) return;
  // Spin up fs-watchers for every DB that opted in (source.files.watch).
  try {
    const { reconcileWatchers } = require('./file-watcher');
    reconcileWatchers();
  } catch (e) {
    logger.warn('context-rag.file-watcher.reconcile-failed', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  // Always-on knowledge watcher (single dir, shared across all knowledge-mode-all DBs).
  try {
    const { reconcileKnowledgeWatcher } = require('./knowledge-watcher');
    reconcileKnowledgeWatcher();
  } catch (e) {
    logger.warn('context-rag.knowledge-watcher.reconcile-failed', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  // Fire-and-forget entitlement probe when the cache is stale or missing.
  // Networked, so we never block boot — UI shows `unknown` status until
  // the probe completes. Hidden behind a timeout in case the provider
  // endpoint is slow on startup.
  setTimeout(() => { void _kickBootProbeIfStale(); }, 5_000);

  _watchdogTimer = setInterval(() => {
    if (_isRunning) {
      logger.info('context-rag.watchdog-skip', { reason: 'process-still-running' });
      return;
    }
    const cfg = _readConfig();
    if (!cfg.enabled) return;
    if (queue.size() === 0) return;
    // Don't fight the upstream titler for rate budget — wait for it to drain.
    if (!_upstreamClear()) {
      logger.info('context-rag.watchdog-skip', { reason: 'gated-by-titler' });
      return;
    }
    logger.info('context-rag.watchdog-trigger', { queueDepth: queue.size() });
    void _startProcess();
  }, POLL_INTERVAL_MS);
  logger.info('context-rag.worker-started', { pollIntervalMs: POLL_INTERVAL_MS });
}

function stopContextRagWorker(): void {
  if (_watchdogTimer) {
    clearInterval(_watchdogTimer);
    _watchdogTimer = null;
    logger.info('context-rag.worker-stopped');
  }
  try {
    const { stopAllWatchers } = require('./file-watcher');
    stopAllWatchers();
  } catch (_) { /* watcher not loaded — nothing to stop */ }
  try {
    const { stopKnowledgeWatcher } = require('./knowledge-watcher');
    stopKnowledgeWatcher();
  } catch (_) { /* watcher not loaded — nothing to stop */ }
}

/** Boot scan: walk every corpus that has at least one matching DB and
 *  enqueue everything that isn't ingested yet. Cheap walk; the per-DB
 *  "already ingested" check happens during processing, not here. */
function scanAndEnqueueOnStartup(): void {
  const cfg = _readConfig();
  if (!cfg.enabled) return;
  if (!_registryHasDBs()) return;
  try {
    const { scanAndEnqueueOnStartup: scanSessions } = require('./sessions');
    const stats = scanSessions();
    if (stats.enqueued > 0) {
      logger.info('context-rag.startup-scan', { sessions: stats.enqueued });
    }
  } catch (e) {
    logger.warn('context-rag.startup-scan-failed', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  try {
    const { scanAndEnqueueAllFileDbs } = require('./file-walker');
    const stats = scanAndEnqueueAllFileDbs();
    if (stats.enqueued > 0) {
      logger.info('context-rag.startup-scan', {
        files: stats.enqueued, scanned: stats.scanned, skipped: stats.skipped,
      });
    }
  } catch (e) {
    logger.warn('context-rag.startup-scan-files-failed', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  try {
    const { scanAndEnqueueAllKnowledgeDbs } = require('./knowledge');
    const stats = scanAndEnqueueAllKnowledgeDbs();
    if (stats.enqueued > 0) {
      logger.info('context-rag.startup-scan', {
        knowledge: stats.enqueued, scanned: stats.scanned, skipped: stats.skipped,
      });
    }
  } catch (e) {
    logger.warn('context-rag.startup-scan-knowledge-failed', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  try {
    const { scanAndEnqueueAllSynthesisDbs } = require('./synthesis');
    const stats = scanAndEnqueueAllSynthesisDbs();
    if (stats.enqueued > 0) {
      logger.info('context-rag.startup-scan', {
        synthesis: stats.enqueued, scanned: stats.scanned, skipped: stats.skipped,
      });
    }
  } catch (e) {
    logger.warn('context-rag.startup-scan-synthesis-failed', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  if (queue.size() > 0 && _upstreamClear()) {
    logger.info('context-rag.startup-trigger', { queueDepth: queue.size() });
    void _startProcess();
  }
}

/** End-of-loop kick from upstream (auto-title). Also called from any
 *  producer that just enqueued. Bubbles a no-op kick straight to the
 *  categorizer when nothing here can run — so a clean upstream doesn't
 *  strand the categorizer behind a context-rag that has no DBs configured. */
function kickContextRag(): void {
  // Always bubble — categorizer doesn't gate on us, but we owe it a heads-up
  // because the auto-title chain handoff lands here, not there.
  try {
    const { kickCategorizer } = require('../../categorizer');
    if (typeof kickCategorizer === 'function') kickCategorizer();
  } catch (_) { /* categorizer not loaded yet — its watchdog handles it */ }

  if (_isRunning) return;
  const cfg = _readConfig();
  if (!cfg.enabled) return;
  if (!_registryHasDBs()) return;
  if (queue.size() === 0) return;
  void _startProcess();
}

/** True iff the queue is empty AND no process is in flight. Surfaced for
 *  potential downstream legs that might want to wait on us, plus the status
 *  endpoint. */
function isClear(): boolean {
  if (_isRunning) return false;
  return queue.size() === 0;
}

function getStatus(): {
  enabled:   boolean;
  hasDbs:    boolean;
  running:   boolean;
  watchdog:  boolean;
  queue:     { total: number; byKind: Record<string, number> };
  lastRunAt: number | null;
  lastRunIngestedCount: number;
  lifetimeIngested: number;
  lastError: string | null;
} {
  return {
    enabled:    _readConfig().enabled,
    hasDbs:     _registryHasDBs(),
    running:    _isRunning,
    watchdog:   _watchdogTimer !== null,
    queue:      { total: queue.size(), byKind: queue.depthByKind() },
    lastRunAt:  _lastRunAt,
    lastRunIngestedCount: _lastRunIngestedCount,
    lifetimeIngested:     _lifetimeIngested,
    lastError:  _lastError,
  };
}

/** Run a process pass now, regardless of the watchdog cadence. Returns
 *  describing whether a run was kicked off and the reason if not. */
function runNow(): { kicked: boolean; reason?: string } {
  if (_isRunning)                 return { kicked: false, reason: 'already-running' };
  if (!_readConfig().enabled)     return { kicked: false, reason: 'disabled' };
  if (!_registryHasDBs())         return { kicked: false, reason: 'no-dbs' };
  if (queue.size() === 0)         return { kicked: false, reason: 'queue-empty' };
  void _startProcess();
  return { kicked: true };
}

// Internal accessors used by tests and the status endpoint (step 7).
function _isRunningGet(): boolean { return _isRunning; }
function _watchdogActive(): boolean { return _watchdogTimer !== null; }

export {
  startContextRagWorker,
  stopContextRagWorker,
  scanAndEnqueueOnStartup,
  kickContextRag,
  isClear,
  getStatus,
  runNow,
  _isRunningGet,
  _watchdogActive,
  // Re-exported so the module barrel below has a single import surface.
  _startProcess,
};
