// Shared 500ms-TTL cache of Go's active-stream set. Both /v1/sessions/
// and /v1/sessions/:id/status read isRunning from here so they agree on
// whether a Go-owned turn is live — without a single shared cache the
// two endpoints could return inconsistent answers across the TTL boundary,
// which made the FE flicker between "running" and "idle" while it polled
// (list reconcile re-seeded serverActive=true, then reconnectStream's
// status check came back with active=false → state cleared → next poll
// re-seeded again).
//
// Per-session hysteresis layered on top: every fetch records the
// timestamp at which each returned session was last seen active. The
// helper `wasActiveRecently(id)` then returns true for ACTIVE_HYSTERESIS_MS
// after the last positive sighting, so a brief drop in Go's set (Go GC
// pause, the /internal/active-streams fetch timing out at the 750ms
// abort, a momentary buffer gap between turn boundaries, etc.) doesn't
// make the bridge report `isRunning=false` mid-stream. Without this the
// FE picker dot visibly bounces every few seconds during long replies
// (observed: 10–15 s "not running" windows mid-response in
// s1778993442046). Real stops still propagate, just delayed by up to
// ACTIVE_HYSTERESIS_MS.
'use strict';

const { BRIDGE_INTERNAL_KEY } = require('./state');

const _goCoreUrl = process.env.YHA_GO_CORE_URL || 'http://127.0.0.1:8443';
let _goActiveCache: { set: Set<string>; at: number; authoritative: boolean } | null = null;

// Per-session "last seen active in Go" timestamps. Bumped on every
// successful fetch where the session appeared in the returned set.
// Entries older than 2× the hysteresis window are pruned on each fetch
// so the map can't grow unbounded across long-lived bridges.
const _lastSeenActiveAt: Map<string, number> = new Map();
const ACTIVE_HYSTERESIS_MS = 10_000;

async function fetchGoActiveSet(): Promise<Set<string>> {
  const now = Date.now();
  if (_goActiveCache && now - _goActiveCache.at < 500) return _goActiveCache.set;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 750);
    const r = await fetch(`${_goCoreUrl}/internal/active-streams`, {
      headers: { 'x-bridge-key': BRIDGE_INTERNAL_KEY },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!r.ok) {
      // Don't clobber _lastSeenActiveAt on transient errors — the whole
      // point of hysteresis is that an unreachable Go-core shouldn't
      // immediately flip every session to "not running".
      _goActiveCache = { set: new Set(), at: now, authoritative: false };
      return _goActiveCache.set;
    }
    const body = (await r.json()) as { sessions?: string[] };
    const ids: string[] = Array.isArray(body?.sessions) ? body.sessions : [];
    const set = new Set(ids);
    for (const sid of ids) _lastSeenActiveAt.set(sid, now);
    _goActiveCache = { set, at: now, authoritative: true };
    pruneLastSeen(now);
    return _goActiveCache.set;
  } catch (_) {
    _goActiveCache = { set: new Set(), at: now, authoritative: false };
    return _goActiveCache.set;
  }
}

// True only when the current cache came from a successful Go response. An
// empty Set caused by timeout/unreachability must never be used to finalize
// durable live placeholders.
function goActiveSnapshotIsAuthoritative(): boolean {
  return _goActiveCache?.authoritative === true;
}

// True if `sessionId` was in a returned active-set within
// ACTIVE_HYSTERESIS_MS. Combined with `fetchGoActiveSet().has(id)` at
// the call site to express "running OR was running very recently".
function wasActiveRecently(sessionId: string): boolean {
  const t = _lastSeenActiveAt.get(sessionId);
  if (t == null) return false;
  return Date.now() - t < ACTIVE_HYSTERESIS_MS;
}

function pruneLastSeen(now: number): void {
  const cutoff = now - 2 * ACTIVE_HYSTERESIS_MS;
  for (const [sid, t] of _lastSeenActiveAt) {
    if (t < cutoff) _lastSeenActiveAt.delete(sid);
  }
}

module.exports = { fetchGoActiveSet, wasActiveRecently, goActiveSnapshotIsAuthoritative };
