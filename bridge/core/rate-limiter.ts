// ── Rate limiter — per-provider token bucket + 429-aware retry ────────────────
// Phase 1.10 (added 2026-05-06 per user request).
//
// Why this exists
// ───────────────
// The pipeline workers (auto-title, context-categorizer) and the foreground
// pet-console all call the SAME cheap-model lane (NVIDIA llama-3.1-8b by
// default). Each worker is internally serial, but they can race each other
// across stages plus a clicking user, so the system can briefly hit the
// provider with several back-to-back requests. Without throttling:
//   1. Some providers reactive-cap at < 60 RPM and return 429 → the title
//      worker counts the 429 against its 3-attempt budget and abandons the
//      session.
//   2. Concurrent pet-console + auto-title bursts can blow even a generous
//      RPM budget.
//   3. There is no exponential-backoff retry, so even a transient 429 can
//      promote a session to "fallback" wrongly.
//
// What this provides
// ──────────────────
//   • `acquire(provider, opts)` — async, blocks until a slot is available
//     under the per-provider token bucket. The bucket refills `rpm/60` tokens
//     per second up to capacity `rpm`. With concurrency 1 (default) the
//     callers serialize naturally; concurrency >1 lets several requests fly
//     in parallel for providers that allow it.
//   • `withRateLimit(provider, fn, opts)` — wraps a `fetch`-returning callback
//     with acquire + 429-aware retry (Retry-After honoured). Callers don't
//     touch the bucket directly.
//   • `getStatus()` — snapshot of every bucket plus retry counters, surfaced
//     by /v1/config/rate-limit/status for the UI.
//
// Configuration source
// ────────────────────
//   • Per-provider override: `config.defaults.rateLimit.<providerName>.{rpm,concurrency}`
//   • Global default:        `config.defaults.rateLimit.default.{rpm,concurrency}`
//   • Hard-coded fallback:   60 rpm, concurrency 1
//
// Notes
// ─────
//   • In-memory only. There is no cross-process coordination — the bridge is
//     a single Node process.
//   • Aborts ARE honoured: if the caller passes a signal that fires while
//     waiting for a token, we throw `RateLimitAborted`.
//   • 429s are caught at fetch-level by the wrapper. Other status codes pass
//     through unchanged so callers keep their existing error handling.
'use strict';

const logger = require('./logger');

// ── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_RPM         = 60;       // 1 request/second on a fresh bucket
const DEFAULT_CONCURRENCY = 1;        // serialise unless explicitly raised
const MAX_RETRIES         = 3;        // 429-aware exponential backoff
const BASE_BACKOFF_MS     = 1_000;    // 1s, 2s, 4s on retry; honour Retry-After when present
const MAX_BACKOFF_MS      = 30_000;   // hard cap

// ── Internal types ───────────────────────────────────────────────────────────

interface BucketCfg {
  rpm:         number;
  concurrency: number;
}

interface Bucket {
  cfg:           BucketCfg;
  tokens:        number;             // current available tokens (float)
  lastRefillMs:  number;             // epoch ms of last refill
  inFlight:      number;             // active concurrent acquisitions
  // Lifetime counters (since process boot)
  totalAcquired: number;
  totalWaited:   number;             // ms spent waiting for a slot
  total429:      number;
  totalRetries:  number;
  // FIFO of waiters — resolved when a token + concurrency slot opens up.
  // Each waiter holds a resolve() that, when called, lets the caller proceed.
  waiters:       Array<{ resolve: () => void; reject: (err: any) => void; abortListener?: () => void; signal?: AbortSignal }>;
}

const buckets = new Map<string, Bucket>();

class RateLimitAbortedError extends Error {
  constructor(reason: string) {
    super(`rate-limit aborted: ${reason}`);
    this.name = 'RateLimitAborted';
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _readCfg(providerName: string): BucketCfg {
  let rpm = DEFAULT_RPM;
  let concurrency = DEFAULT_CONCURRENCY;
  try {
    const { config } = require('./state');
    const root = (config?.defaults?.rateLimit ?? {}) as Record<string, any>;
    // Per-provider wins over default; both are merged onto the hard-coded baseline.
    const def = root.default ?? {};
    const own = root[providerName] ?? {};
    if (typeof def.rpm === 'number' && def.rpm > 0)               rpm = def.rpm;
    if (typeof def.concurrency === 'number' && def.concurrency > 0) concurrency = def.concurrency;
    if (typeof own.rpm === 'number' && own.rpm > 0)               rpm = own.rpm;
    if (typeof own.concurrency === 'number' && own.concurrency > 0) concurrency = own.concurrency;
  } catch (_) { /* state not initialised — use defaults */ }
  return { rpm, concurrency };
}

function _bucketFor(providerName: string): Bucket {
  let b = buckets.get(providerName);
  const cfg = _readCfg(providerName);
  if (!b) {
    b = {
      cfg,
      tokens:        cfg.rpm,
      lastRefillMs:  Date.now(),
      inFlight:      0,
      totalAcquired: 0,
      totalWaited:   0,
      total429:      0,
      totalRetries:  0,
      waiters:       [],
    };
    buckets.set(providerName, b);
  } else if (b.cfg.rpm !== cfg.rpm || b.cfg.concurrency !== cfg.concurrency) {
    // Hot-reload the cap: the next refill will use the new rate. Don't truncate
    // existing tokens — let them drain naturally.
    b.cfg = cfg;
  }
  return b;
}

function _refill(b: Bucket): void {
  const now = Date.now();
  const elapsedSec = (now - b.lastRefillMs) / 1000;
  if (elapsedSec <= 0) return;
  const add = (b.cfg.rpm / 60) * elapsedSec;
  if (add <= 0) return;
  b.tokens = Math.min(b.cfg.rpm, b.tokens + add);
  b.lastRefillMs = now;
}

function _hasSlot(b: Bucket): boolean {
  return b.tokens >= 1 && b.inFlight < b.cfg.concurrency;
}

// Try to immediately satisfy waiters at the head of the queue.
function _drainWaiters(b: Bucket): void {
  _refill(b);
  while (b.waiters.length > 0 && _hasSlot(b)) {
    const w = b.waiters.shift()!;
    if (w.abortListener && w.signal) {
      w.signal.removeEventListener('abort', w.abortListener);
    }
    b.tokens   -= 1;
    b.inFlight += 1;
    b.totalAcquired += 1;
    w.resolve();
  }
}

// Compute how many ms until the next token would arrive — used to schedule
// a wake-up timer that drains waiters even when no fresh `acquire`/`release`
// happens externally.
function _msUntilNextToken(b: Bucket): number {
  if (b.tokens >= 1) return 0;
  const need = 1 - b.tokens;
  const perMs = b.cfg.rpm / 60_000;
  if (perMs <= 0) return MAX_BACKOFF_MS;
  return Math.max(10, Math.ceil(need / perMs));
}

let _scheduled: ReturnType<typeof setTimeout> | null = null;
function _scheduleDrain(): void {
  if (_scheduled) return;
  // Look across all buckets for the soonest deadline.
  let next = MAX_BACKOFF_MS;
  for (const b of buckets.values()) {
    if (b.waiters.length === 0) continue;
    next = Math.min(next, _msUntilNextToken(b));
  }
  _scheduled = setTimeout(() => {
    _scheduled = null;
    for (const b of buckets.values()) _drainWaiters(b);
    // If there are still waiters, schedule again.
    let pending = false;
    for (const b of buckets.values()) {
      if (b.waiters.length > 0) { pending = true; break; }
    }
    if (pending) _scheduleDrain();
  }, next);
  // Don't keep the process alive solely for this timer.
  if (_scheduled && typeof (_scheduled as any).unref === 'function') (_scheduled as any).unref();
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Acquire one request slot from the named bucket. Returns a `release()` thunk
 * that the caller MUST invoke when its work is done — typically in a `finally`.
 *
 * Honours `signal.aborted`: if the signal fires while waiting, the returned
 * promise rejects with `RateLimitAbortedError` and no slot is consumed.
 */
async function acquire(providerName: string, opts: { signal?: AbortSignal } = {}): Promise<() => void> {
  const b = _bucketFor(providerName);
  const { signal } = opts;
  if (signal?.aborted) {
    throw new RateLimitAbortedError('signal already aborted');
  }
  _refill(b);
  if (_hasSlot(b) && b.waiters.length === 0) {
    b.tokens   -= 1;
    b.inFlight += 1;
    b.totalAcquired += 1;
    return _makeRelease(providerName);
  }
  const startWait = Date.now();
  await new Promise<void>((resolve, reject) => {
    const waiter: any = { resolve, reject, signal };
    if (signal) {
      waiter.abortListener = () => {
        // Remove from queue, reject with abort.
        const idx = b.waiters.indexOf(waiter);
        if (idx >= 0) b.waiters.splice(idx, 1);
        reject(new RateLimitAbortedError('signal aborted while waiting'));
      };
      signal.addEventListener('abort', waiter.abortListener, { once: true });
    }
    b.waiters.push(waiter);
    _scheduleDrain();
  });
  b.totalWaited += Date.now() - startWait;
  return _makeRelease(providerName);
}

function _makeRelease(providerName: string): () => void {
  let released = false;
  return function release() {
    if (released) return;
    released = true;
    const b = buckets.get(providerName);
    if (!b) return;
    b.inFlight = Math.max(0, b.inFlight - 1);
    _drainWaiters(b);
  };
}

/**
 * Wrap a fetch-returning callback with rate-limit acquisition + 429-aware
 * exponential backoff retry. The callback receives the AbortSignal we'll use
 * for our own retry timer (so a long backoff doesn't dangle past the
 * caller's deadline).
 *
 * Behaviour:
 *   • Acquires the bucket BEFORE each attempt (every retry is throttled too).
 *   • On 429: reads Retry-After (seconds or HTTP-date), sleeps that long, retries.
 *   • On any other status: returns the response unchanged. The caller still
 *     decides whether the body is acceptable.
 *   • Network/abort errors propagate.
 *
 * Returns the final `Response`, plus the number of retries it took (0 = first try).
 */
async function withRateLimit<T extends Response>(
  providerName: string,
  fn: () => Promise<T>,
  opts: { maxRetries?: number; signal?: AbortSignal } = {},
): Promise<{ response: T; retries: number }> {
  const maxRetries = Math.max(0, opts.maxRetries ?? MAX_RETRIES);
  let attempt = 0;
  while (true) {
    const release = await acquire(providerName, { signal: opts.signal });
    try {
      const response = await fn();
      if (response.status !== 429) {
        return { response, retries: attempt };
      }
      // 429 — record + decide whether to retry.
      const b = buckets.get(providerName);
      if (b) b.total429 += 1;
      if (attempt >= maxRetries) {
        return { response, retries: attempt };
      }
      const retryAfterMs = _parseRetryAfter(response.headers.get('Retry-After'));
      const backoffMs = Math.min(
        MAX_BACKOFF_MS,
        retryAfterMs != null ? retryAfterMs : BASE_BACKOFF_MS * (2 ** attempt),
      );
      logger.warn('rate-limiter.429-retry', {
        provider:    providerName,
        attempt:     attempt + 1,
        backoffMs,
        retryAfter:  retryAfterMs,
      });
      attempt += 1;
      if (b) b.totalRetries += 1;
      // Release the slot for the duration of the backoff so other callers
      // can use the bucket while we wait.
      release();
      try { await _sleep(backoffMs, opts.signal); }
      catch (e) { throw e; }
      continue;
    } finally {
      // If we returned successfully or threw, release. The 429-retry branch
      // above already released early, so this only fires on the success path
      // and on non-429 responses.
      try { release(); } catch (_) {}
    }
  }
}

function _parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  // Numeric (seconds) — most common in RPM-style limits.
  if (/^\d+(\.\d+)?$/.test(trimmed)) {
    return Math.max(0, Math.floor(parseFloat(trimmed) * 1000));
  }
  // HTTP-date — convert to delay.
  const ts = Date.parse(trimmed);
  if (!Number.isNaN(ts)) {
    return Math.max(0, ts - Date.now());
  }
  return null;
}

function _sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new RateLimitAbortedError('signal aborted before sleep'));
    const t = setTimeout(() => {
      if (signal && abortListener) signal.removeEventListener('abort', abortListener);
      resolve();
    }, ms);
    let abortListener: (() => void) | null = null;
    if (signal) {
      abortListener = () => {
        clearTimeout(t);
        reject(new RateLimitAbortedError('signal aborted during sleep'));
      };
      signal.addEventListener('abort', abortListener, { once: true });
    }
  });
}

// ── Status snapshot ──────────────────────────────────────────────────────────

interface BucketStatus {
  provider:      string;
  rpm:           number;
  concurrency:   number;
  tokens:        number;
  inFlight:      number;
  waiting:       number;
  totalAcquired: number;
  totalWaitedMs: number;
  total429:      number;
  totalRetries:  number;
}

function getStatus(): { buckets: BucketStatus[] } {
  const out: BucketStatus[] = [];
  for (const [provider, b] of buckets.entries()) {
    _refill(b);
    out.push({
      provider,
      rpm:           b.cfg.rpm,
      concurrency:   b.cfg.concurrency,
      tokens:        Math.round(b.tokens * 100) / 100,
      inFlight:      b.inFlight,
      waiting:       b.waiters.length,
      totalAcquired: b.totalAcquired,
      totalWaitedMs: b.totalWaited,
      total429:      b.total429,
      totalRetries:  b.totalRetries,
    });
  }
  return { buckets: out };
}

module.exports = {
  acquire,
  withRateLimit,
  getStatus,
  RateLimitAbortedError,
};
