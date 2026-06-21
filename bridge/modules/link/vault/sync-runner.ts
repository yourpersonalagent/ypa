// ── LINK Sync Engine — Worker State & Public API ─────────────────────────────
// Owns the watchdog timer, single-process guard, lifetime counters and the
// last-adapter-ping cache. Exposes the public surface (startLinkWorker /
// kickLink / runNow / isClear / getLinkStatus / pingAdapterNow) consumed by
// the route layer, plus a few `_`-prefixed accessors used by sync-import.ts
// to drive a one-shot sync after vault folder import.
'use strict';

const logger = require('../../../core/logger');

const {
  POLL_INTERVAL_MS_DEFAULT,
  PUSH_RATE_LIMIT_MS,
} = require('./sync-constants');

// Hard cap on a single sync cycle. Node's http.request `timeout` only fires
// after the socket sees idle bytes, so a TCP-level stall against an
// unreachable Obsidian REST endpoint can pin `_isRunning=true` for the system
// retry window (often 60–120 s on Linux). Capping the runner itself means
// the visible state recovers within this window regardless of the adapter
// path — the orphaned `_runOnce` finishes in the background (we can't abort
// mid-write without risking a half-written link-state.json) and the next
// watchdog tick retries cleanly.
const PROCESS_HARD_CAP_MS = 60_000;
const { _getAdapter, maskedLinkSecret } = require('./sync-secrets');
const { _readState, _writeStateAtomic } = require('./sync-state');
const {
  _resolveSyncDirs,
  _serverDirToVaultPrefix,
  _policyFor,
} = require('./sync-policy');
const { _syncOneFolder } = require('./sync-folder');

type ConflictPolicy = 'server-wins' | 'desktop-wins' | 'newest-wins' | 'preserve-both';

interface SyncRunStats {
  pushed:    number;
  pulled:    number;
  conflicts: number;
  errors:    Array<{ path: string; error: string }>;
  filesScanned: number;
}

// ── Run state ────────────────────────────────────────────────────────────────

let _isRunning            = false;
let _lastRunAt: number | null = null;
let _lastRunStats: SyncRunStats = { pushed: 0, pulled: 0, conflicts: 0, errors: [], filesScanned: 0 };
let _lifetimePushed       = 0;
let _lifetimePulled       = 0;
let _lifetimeConflicts    = 0;
let _lastPushAt: number   = 0;
let _watchdogTimer: ReturnType<typeof setInterval> | null = null;
let _lastAdapterPing: { ok: boolean; version?: string; error?: string; at: number } = { ok: false, at: 0 };

// ── Process loop ─────────────────────────────────────────────────────────────

async function _runOnce(): Promise<SyncRunStats> {
  const { config } = require('../../../core/state');
  const cfg = config.defaults?.contextLink || {};
  const adapter = _getAdapter();
  const stats: SyncRunStats = { pushed: 0, pulled: 0, conflicts: 0, errors: [], filesScanned: 0 };

  if (!adapter) {
    stats.errors.push({ path: '_adapter', error: 'no-adapter-configured' });
    return stats;
  }

  // Health-probe the adapter before we touch state — failures past this are
  // per-file rather than catastrophic.
  try {
    _lastAdapterPing = { ...(await adapter.ping()), at: Date.now() };
    if (!_lastAdapterPing.ok) {
      stats.errors.push({ path: '_adapter', error: _lastAdapterPing.error || 'ping-failed' });
      return stats;
    }
  } catch (e) {
    _lastAdapterPing = { ok: false, error: (e as Error).message, at: Date.now() };
    stats.errors.push({ path: '_adapter', error: (e as Error).message });
    return stats;
  }

  const state    = _readState();
  const syncDirs = _resolveSyncDirs(cfg);

  for (const [serverDir, _vaultPrefixRaw] of Object.entries(syncDirs)) {
    const vaultPrefix = _serverDirToVaultPrefix(serverDir, syncDirs);
    const policy      = _policyFor(serverDir, cfg);
    await _syncOneFolder(serverDir, vaultPrefix, policy, cfg, adapter, state, stats);
  }

  _writeStateAtomic(state);
  return stats;
}

async function _startProcess(): Promise<void> {
  if (_isRunning) return;
  // Push-side rate limit. Pull-side is already gated by the watchdog interval.
  if (Date.now() - _lastPushAt < PUSH_RATE_LIMIT_MS) {
    logger.info('link.rate-limited', { since: Date.now() - _lastPushAt });
    return;
  }
  _isRunning = true;
  _lastPushAt = Date.now();
  logger.info('link.process-started');

  // Hard-cap watchdog — see PROCESS_HARD_CAP_MS doc above. When it fires we
  // flip `_isRunning=false` so the UI returns to idle and the next watchdog
  // tick can retry. The flag below stops the post-await finally from racing
  // with us if `_runOnce` eventually resolves.
  let timedOut = false;
  const capHandle = setTimeout(() => {
    timedOut = true;
    _isRunning = false;
    _lastAdapterPing = {
      ok: false,
      error: `sync-timeout after ${PROCESS_HARD_CAP_MS}ms (adapter unreachable?)`,
      at: Date.now(),
    };
    logger.warn('link.process-timed-out', { capMs: PROCESS_HARD_CAP_MS });
  }, PROCESS_HARD_CAP_MS);

  try {
    const stats = await _runOnce();
    if (timedOut) {
      // The cap already flipped state and a subsequent kick may be in flight.
      // Don't overwrite anyone else's counters — just log and bail.
      logger.warn('link.run-complete-after-cap', {
        pushed: stats.pushed, pulled: stats.pulled,
        conflicts: stats.conflicts, errors: stats.errors.length,
      });
      return;
    }
    _lastRunAt        = Date.now();
    _lastRunStats     = stats;
    _lifetimePushed   += stats.pushed;
    _lifetimePulled   += stats.pulled;
    _lifetimeConflicts += stats.conflicts;
    logger.info('link.run-complete', {
      pushed: stats.pushed, pulled: stats.pulled,
      conflicts: stats.conflicts, errors: stats.errors.length,
      filesScanned: stats.filesScanned,
    });
    try {
      const { broadcastEvent } = require('../../workflows-and-triggers/triggers');
      broadcastEvent('link:synced', {
        pushed: stats.pushed,
        pulled: stats.pulled,
        conflicts: stats.conflicts,
        errors: stats.errors.length,
      });
    } catch { /* triggers not yet initialised */ }
  } catch (e) {
    logger.warn('link.process-crashed', { error: (e as Error).message });
  } finally {
    clearTimeout(capHandle);
    if (!timedOut) _isRunning = false;
    logger.info(timedOut ? 'link.process-ended-orphaned' : 'link.process-ended');
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

function startLinkWorker(): void {
  if (_watchdogTimer) return;
  const { config } = require('../../../core/state');
  const cfg = config.defaults?.contextLink || {};
  const interval = Number.isFinite(cfg.syncIntervalMs) && cfg.syncIntervalMs > 30_000
    ? cfg.syncIntervalMs
    : POLL_INTERVAL_MS_DEFAULT;
  _watchdogTimer = setInterval(() => {
    if (_isRunning) {
      logger.info('link.watchdog-skip', { reason: 'process-still-running' });
      return;
    }
    const c = require('../../../core/state').config?.defaults?.contextLink;
    if (c?.enabled !== true) return;
    void _startProcess();
  }, interval);
  logger.info('link.worker-started', { intervalMs: interval });
}

// ── Lifecycle stop ────────────────────────────────────────────────────────────
// Phase-2 batch F (LINK worker brought into the link module). Called by the
// loader's ctx.workers.add() teardown when the link module is disabled or
// hot-reloaded. The 5-min watchdog clears immediately; any in-flight push/pull
// `_runOnce` finishes its current cycle (fire-and-forget) — we don't abort
// the adapter request to avoid leaving the link-state.json half-updated.
function stopLinkWorker(): void {
  if (_watchdogTimer) {
    clearInterval(_watchdogTimer);
    _watchdogTimer = null;
    logger.info('link.worker-stopped');
  }
}

function kickLink(): void {
  // Called by the Sorter at the end of its run. No-ops if disabled, rate-limited,
  // or already running.
  const { config } = require('../../../core/state');
  const cfg = config.defaults?.contextLink;
  if (cfg?.enabled !== true) return;
  if (_isRunning) return;
  void _startProcess();
}

function runNow(): { kicked: boolean; reason?: string } {
  const { config } = require('../../../core/state');
  const cfg = config.defaults?.contextLink;
  if (cfg?.enabled !== true) return { kicked: false, reason: 'disabled' };
  if (_isRunning) return { kicked: false, reason: 'already-running' };
  // runNow bypasses the push-side rate limit — it's a manual user action.
  _lastPushAt = 0;
  void _startProcess();
  return { kicked: true };
}

function isClear(): boolean {
  // LINK is the last stage of the pipeline — it doesn't gate anything. The
  // function exists for symmetry with other stages and so that future
  // dependent modules (e.g. a "publish" step) can wait for LINK to drain.
  return !_isRunning;
}

function getLinkStatus(): {
  enabled:          boolean;
  isRunning:        boolean;
  watchdogActive:   boolean;
  adapterKind:      string;
  adapterReachable: boolean;
  adapterError:     string | null;
  adapterCheckedAt: number;
  lastRunAt:        number | null;
  lastRunStats:     SyncRunStats;
  lifetimePushed:   number;
  lifetimePulled:   number;
  lifetimeConflicts: number;
  syncDirs:         Record<string, string>;
  conflictPolicies: Record<string, ConflictPolicy>;
  apiKeyMasked:     string;
  vaultRoot:        string;
  obsidianHost:     string;
  syncIntervalMs:   number;
  syncSensitivity:  { public: boolean; private: boolean; system: false };
} {
  const { config } = require('../../../core/state');
  const cfg = config.defaults?.contextLink || {};
  const adapter = _getAdapter();
  const syncDirs = _resolveSyncDirs(cfg);
  const conflictPolicies: Record<string, ConflictPolicy> = {};
  for (const dir of Object.keys(syncDirs)) {
    conflictPolicies[dir] = _policyFor(dir, cfg);
  }
  return {
    enabled:           cfg.enabled === true,
    isRunning:         _isRunning,
    watchdogActive:    _watchdogTimer !== null,
    adapterKind:       adapter ? adapter.kind : (cfg.adapter || 'mock'),
    adapterReachable:  _lastAdapterPing.ok,
    adapterError:      _lastAdapterPing.ok ? null : (_lastAdapterPing.error || null),
    adapterCheckedAt:  _lastAdapterPing.at,
    lastRunAt:         _lastRunAt,
    lastRunStats:      _lastRunStats,
    lifetimePushed:    _lifetimePushed,
    lifetimePulled:    _lifetimePulled,
    lifetimeConflicts: _lifetimeConflicts,
    syncDirs,
    conflictPolicies,
    apiKeyMasked:      maskedLinkSecret('obsidianApiKey'),
    vaultRoot:         cfg.vaultRoot || '',
    // The effective host the adapter will dial. Surfaced in the UI so the
    // user can see at a glance whether the bridge is pointed at localhost
    // (SSH-tunnel topology) or directly at a hostname (`<your-host>:27123`-style).
    obsidianHost:      cfg.obsidianHost || 'http://127.0.0.1:27123',
    syncIntervalMs:    Number.isFinite(cfg.syncIntervalMs) && cfg.syncIntervalMs > 30_000
                         ? cfg.syncIntervalMs : POLL_INTERVAL_MS_DEFAULT,
    syncSensitivity: {
      public:  true,
      private: cfg.syncSensitivity?.private === true,
      system:  false,                          // hard-coded — never propagate
    },
  };
}

// ── Live ping ────────────────────────────────────────────────────────────────
// Used by `POST /v1/config/link/test-ping`. Selects the adapter fresh (so
// config changes apply immediately, before the next watchdog tick), runs the
// adapter's ping(), and updates `_lastAdapterPing` so the cached status
// reflects reality without waiting up to 5 minutes for the next watchdog.

async function pingAdapterNow(): Promise<{ ok: boolean; error?: string; at: number; kind: string }> {
  const { config } = require('../../../core/state');
  const cfg = config.defaults?.contextLink || {};
  const kind = cfg.enabled === true ? (cfg.adapter || 'mock') : 'disabled';
  if (cfg.enabled !== true) {
    const r = { ok: false, error: 'link-disabled', at: Date.now(), kind };
    _lastAdapterPing = { ...r };
    return r;
  }
  const adapter = _getAdapter();
  if (!adapter) {
    const r = { ok: false, error: 'no-adapter-configured (api key missing?)', at: Date.now(), kind };
    _lastAdapterPing = { ...r };
    return r;
  }
  try {
    const probe = await adapter.ping();
    _lastAdapterPing = { ok: !!probe.ok, error: probe.error, at: Date.now() };
    return { ok: !!probe.ok, error: probe.error, at: Date.now(), kind: adapter.kind };
  } catch (e) {
    const msg = (e as Error).message;
    _lastAdapterPing = { ok: false, error: msg, at: Date.now() };
    return { ok: false, error: msg, at: Date.now(), kind: adapter.kind };
  }
}

// ── Internal hooks for sync-import ────────────────────────────────────────────
// `importVaultFolder` needs to (a) read `_isRunning` to decide whether to
// kick a follow-up sync, (b) zero `_lastPushAt` to bypass the push rate
// limit, (c) write `_lastAdapterPing` after its own health probe, and (d)
// invoke `_startProcess`. We expose narrow accessors rather than the raw
// state so module-internal invariants stay enforceable.

function _isWorkerRunning(): boolean { return _isRunning; }
function _setLastPushAt(v: number): void { _lastPushAt = v; }
function _setLastAdapterPing(v: { ok: boolean; version?: string; error?: string; at: number }): void {
  _lastAdapterPing = v;
}

module.exports = {
  startLinkWorker,
  stopLinkWorker,
  kickLink,
  runNow,
  isClear,
  getLinkStatus,
  pingAdapterNow,
  _runOnce,
  _startProcess,
  _isWorkerRunning,
  _setLastPushAt,
  _setLastAdapterPing,
};
