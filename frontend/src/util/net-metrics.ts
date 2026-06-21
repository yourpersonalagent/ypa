// net-metrics — process-wide counter for frontend network I/O.
// Wraps window.fetch on first import and accumulates request body / response
// body byte counts plus per-endpoint hit counts. Read by the #debug
// monitoring panel via getNetMetrics().
//
// EventSource (used by reconnectStream) is also wrapped so SSE traffic, which
// is the bulk of the bytes during a long stream, gets counted too.

interface NetCounters {
  totalRequests: number;
  totalBytesIn: number;
  totalBytesOut: number;
  byEndpoint: Record<string, {
    hits: number;
    bytesIn: number;
    bytesOut: number;
    statusBuckets: { '2xx': number; '4xx': number; '5xx': number; netErr: number };
    latencyMs: { count: number; totalMs: number; maxMs: number };
  }>;
  eventSourceOpen: number;
  eventSourceClosed: number;
  eventSourceErrors: number;
  eventSourceBytesIn: number;
  startedAt: number;
}

interface ReconnectAttempt {
  at: number;
  sid: string;
  outcome: 'pending' | 'done' | 'error' | 'detached' | 'noop' | 'skipped';
  reason?: string;
  latencyToFirstChunkMs?: number;
  replayChunkCount?: number;
  liveChunkCount?: number;
  durationMs?: number;
  bytesIn?: number;
}

interface ReconnectMetrics {
  attempts: number;
  successes: number;
  errors: number;
  detached: number;
  noops: number;
  skipped: number;
  recent: ReconnectAttempt[];   // ring, capped 30
}

const _counters: NetCounters = {
  totalRequests: 0,
  totalBytesIn: 0,
  totalBytesOut: 0,
  byEndpoint: {},
  eventSourceOpen: 0,
  eventSourceClosed: 0,
  eventSourceErrors: 0,
  eventSourceBytesIn: 0,
  startedAt: Date.now(),
};

const _reconnectMetrics: ReconnectMetrics = {
  attempts: 0,
  successes: 0,
  errors: 0,
  detached: 0,
  noops: 0,
  skipped: 0,
  recent: [],
};
const RECONNECT_CAP = 30;

function _normalizeEndpoint(url: string): string {
  try {
    const u = new URL(url, location.href);
    let p = u.pathname;
    // Collapse session ids in /v1/sessions/<sid>/... and /v1/debug/<type>/<sid>
    p = p.replace(/(\/v1\/sessions\/)[^/]+/, '$1:id');
    p = p.replace(/(\/v1\/debug\/[^/]+\/)[^/]+/, '$1:id');
    p = p.replace(/(\/v1\/stop\/)[^/]+/, '$1:id');
    return p;
  } catch (_) {
    return url;
  }
}

function _bumpEndpoint(
  endpoint: string,
  bytesIn: number,
  bytesOut: number,
  opts?: { status?: number; latencyMs?: number; netErr?: boolean },
): void {
  const slot = _counters.byEndpoint[endpoint] || {
    hits: 0, bytesIn: 0, bytesOut: 0,
    statusBuckets: { '2xx': 0, '4xx': 0, '5xx': 0, netErr: 0 },
    latencyMs: { count: 0, totalMs: 0, maxMs: 0 },
  };
  slot.hits += 1;
  slot.bytesIn += bytesIn;
  slot.bytesOut += bytesOut;
  if (opts?.netErr) {
    slot.statusBuckets.netErr += 1;
  } else if (opts?.status != null) {
    if (opts.status >= 500) slot.statusBuckets['5xx'] += 1;
    else if (opts.status >= 400) slot.statusBuckets['4xx'] += 1;
    else if (opts.status >= 200) slot.statusBuckets['2xx'] += 1;
  }
  if (opts?.latencyMs != null) {
    slot.latencyMs.count += 1;
    slot.latencyMs.totalMs += opts.latencyMs;
    if (opts.latencyMs > slot.latencyMs.maxMs) slot.latencyMs.maxMs = opts.latencyMs;
  }
  _counters.byEndpoint[endpoint] = slot;
}

function _bodyBytes(body: BodyInit | null | undefined): number {
  if (!body) return 0;
  if (typeof body === 'string') return new Blob([body]).size;
  if (body instanceof Blob) return body.size;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (ArrayBuffer.isView(body)) return body.byteLength;
  return 0;
}

let _wrapped = false;

// In-flight GET coalescing: when multiple components poll the same URL
// concurrently (e.g. /v1/mcp/ from BashConsole + KnowledgeButtons + prefs),
// share a single request instead of hammering the limiter. Map keyed by
// "GET <url>", value is the in-flight Response promise — cleared once the
// header arrives so callers each get their own clone() for body access.
const _inflightGets = new Map<string, Promise<Response>>();
function _coalesceKey(input: RequestInfo | URL, init?: RequestInit): string | null {
  const method = (init?.method || (typeof input !== 'string' && !(input instanceof URL) ? input.method : 'GET') || 'GET').toUpperCase();
  if (method !== 'GET') return null;
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  // Don't coalesce SSE / event-stream requests or anything with a body.
  if (init?.body) return null;
  const accept = init?.headers ? new Headers(init.headers).get('accept') || '' : '';
  if (accept.includes('text/event-stream')) return null;
  return `GET ${url}`;
}

export function installNetMetrics(): void {
  if (_wrapped) return;
  _wrapped = true;
  const origFetch = window.fetch.bind(window);
  window.fetch = async function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
        ? input.toString()
        : input.url;
    const endpoint = _normalizeEndpoint(url);
    const bytesOut = _bodyBytes(init?.body) ||
      (input instanceof Request ? _bodyBytes(await input.clone().text().catch(() => '')) : 0);

    // Coalesce duplicate concurrent GETs to the same URL.
    const ck = _coalesceKey(input, init);
    if (ck && _inflightGets.has(ck)) {
      _counters.totalRequests += 1; // count the "logical" request
      _bumpEndpoint(endpoint, 0, bytesOut);
      const shared = _inflightGets.get(ck)!;
      const res = await shared;
      // Each caller needs its own body — clone the shared response.
      return res.clone();
    }

    _counters.totalRequests += 1;
    _counters.totalBytesOut += bytesOut;
    let res: Response;
    const t0 = Date.now();
    try {
      const p = origFetch(input, init);
      if (ck) {
        _inflightGets.set(ck, p);
        // Clear the entry as soon as the response is available so a
        // *new* poll a moment later goes over the wire (fresh data).
        p.finally(() => { _inflightGets.delete(ck); }).catch(() => {});
      }
      res = await p;
    } catch (e) {
      _bumpEndpoint(endpoint, 0, bytesOut, { netErr: true, latencyMs: Date.now() - t0 });
      throw e;
    }
    // Best-effort response size: use Content-Length if present (cheap), else
    // skip — counting via body clone would force buffering of streaming bodies.
    const cl = res.headers.get('content-length');
    const bytesIn = cl ? parseInt(cl, 10) || 0 : 0;
    _counters.totalBytesIn += bytesIn;
    _bumpEndpoint(endpoint, bytesIn, bytesOut, { status: res.status, latencyMs: Date.now() - t0 });
    return res;
  };

  // Wrap EventSource so SSE byte traffic + open/close/error counts surface
  // in the monitoring panel. The previous "function + return inst" trick
  // didn't reliably track close() because in some engines property
  // shadowing on the instance is delicate — switched to a Proxy on the
  // constructor which Reflect.constructs the real EventSource (preserving
  // the prototype chain) and decorates the instance after construction.
  const OrigEventSource = window.EventSource;
  if (OrigEventSource) {
    const Patched = new Proxy(OrigEventSource, {
      construct(target, args: any[]) {
        const inst = Reflect.construct(target, args) as EventSource;
        _counters.eventSourceOpen += 1;
        const url = String(args[0] ?? '');
        const endpoint = _normalizeEndpoint(url);
        const onMessage = (ev: MessageEvent) => {
          const sz = typeof ev.data === 'string' ? ev.data.length : 0;
          _counters.eventSourceBytesIn += sz;
          _counters.totalBytesIn += sz;
          _bumpEndpoint(endpoint, sz, 0);
        };
        const onError = () => { _counters.eventSourceErrors += 1; };
        inst.addEventListener('message', onMessage);
        inst.addEventListener('error', onError);
        const origClose = inst.close.bind(inst);
        let _closed = false;
        Object.defineProperty(inst, 'close', {
          configurable: true,
          writable: true,
          value: () => {
            if (!_closed) {
              _closed = true;
              _counters.eventSourceClosed += 1;
              try { inst.removeEventListener('message', onMessage); } catch (_) {}
              try { inst.removeEventListener('error', onError); } catch (_) {}
            }
            origClose();
          },
        });
        return inst;
      },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any).EventSource = Patched;
  }
}

export function getNetMetrics(): NetCounters & { sinceMs: number } {
  // Snapshot the per-endpoint slots so consumers can't mutate the live
  // counters. Two-level copy is enough — the value shape inside each slot
  // is plain numbers/objects-of-numbers; no further depth to clone.
  const byEndpoint: NetCounters['byEndpoint'] = {};
  for (const [k, v] of Object.entries(_counters.byEndpoint)) {
    byEndpoint[k] = {
      hits: v.hits,
      bytesIn: v.bytesIn,
      bytesOut: v.bytesOut,
      statusBuckets: { ...v.statusBuckets },
      latencyMs: { ...v.latencyMs },
    };
  }
  return {
    totalRequests: _counters.totalRequests,
    totalBytesIn: _counters.totalBytesIn,
    totalBytesOut: _counters.totalBytesOut,
    byEndpoint,
    eventSourceOpen: _counters.eventSourceOpen,
    eventSourceClosed: _counters.eventSourceClosed,
    eventSourceErrors: _counters.eventSourceErrors,
    eventSourceBytesIn: _counters.eventSourceBytesIn,
    startedAt: _counters.startedAt,
    sinceMs: Date.now() - _counters.startedAt,
  };
}

// ── Reconnect metrics (called by chat-streaming.reconnectStream) ─────────────

export function recordReconnectStart(sid: string): ReconnectAttempt {
  const attempt: ReconnectAttempt = { at: Date.now(), sid, outcome: 'pending' };
  _reconnectMetrics.attempts += 1;
  _reconnectMetrics.recent.push(attempt);
  if (_reconnectMetrics.recent.length > RECONNECT_CAP) _reconnectMetrics.recent.shift();
  return attempt;
}

export function recordReconnectSkipped(sid: string, reason: string): void {
  _reconnectMetrics.skipped += 1;
  _reconnectMetrics.recent.push({ at: Date.now(), sid, outcome: 'skipped', reason });
  if (_reconnectMetrics.recent.length > RECONNECT_CAP) _reconnectMetrics.recent.shift();
}

export interface ReconnectFinishMeta {
  replayChunkCount?: number;
  liveChunkCount?: number;
  latencyToFirstChunkMs?: number;
  bytesIn?: number;
  reason?: string;
}

export type ReconnectFinishOutcome = 'done' | 'error' | 'detached' | 'noop';
export type ReconnectFinishCallback = (
  attempt: ReconnectAttempt,
  outcome: ReconnectFinishOutcome,
  meta: ReconnectFinishMeta,
) => void;

const _reconnectFinishCbs: ReconnectFinishCallback[] = [];

// Subscribe to reconnect completions. Returns an unsubscribe function.
// Used by petStore to trigger the He-Man powermove on successful reconnects;
// kept generic so future debug/telemetry can attach without touching this
// module again. Callbacks fire after the metrics counters have been updated.
export function onReconnectFinish(cb: ReconnectFinishCallback): () => void {
  _reconnectFinishCbs.push(cb);
  return () => {
    const i = _reconnectFinishCbs.indexOf(cb);
    if (i > -1) _reconnectFinishCbs.splice(i, 1);
  };
}

export function recordReconnectFinish(
  attempt: ReconnectAttempt | null,
  outcome: ReconnectFinishOutcome,
  meta: ReconnectFinishMeta = {},
): void {
  if (!attempt) return;
  attempt.outcome = outcome;
  attempt.durationMs = Date.now() - attempt.at;
  if (meta.replayChunkCount != null) attempt.replayChunkCount = meta.replayChunkCount;
  if (meta.liveChunkCount != null) attempt.liveChunkCount = meta.liveChunkCount;
  if (meta.latencyToFirstChunkMs != null) attempt.latencyToFirstChunkMs = meta.latencyToFirstChunkMs;
  if (meta.bytesIn != null) attempt.bytesIn = meta.bytesIn;
  if (meta.reason) attempt.reason = meta.reason;
  if (outcome === 'done') _reconnectMetrics.successes += 1;
  else if (outcome === 'error') _reconnectMetrics.errors += 1;
  else if (outcome === 'detached') _reconnectMetrics.detached += 1;
  else if (outcome === 'noop') _reconnectMetrics.noops += 1;

  // Fire subscribers *after* metrics are updated. Each callback is sandboxed
  // so a buggy listener can't break the metrics path.
  for (const cb of _reconnectFinishCbs) {
    try { cb(attempt, outcome, meta); } catch (_) { /* ignore */ }
  }
}

export function getReconnectMetrics(): ReconnectMetrics {
  // Spread each attempt so consumers see a frozen-in-time snapshot but we
  // don't pay the JSON.stringify round-trip on every #debug refresh.
  return {
    attempts: _reconnectMetrics.attempts,
    successes: _reconnectMetrics.successes,
    errors: _reconnectMetrics.errors,
    detached: _reconnectMetrics.detached,
    noops: _reconnectMetrics.noops,
    skipped: _reconnectMetrics.skipped,
    recent: _reconnectMetrics.recent.map((a) => ({ ...a })),
  };
}

// ── FE → BE periodic snapshot push ──────────────────────────────────────────
// Mirrors the BE-side monitoring snapshotter so a Claude Code chat helping
// debug streaming issues can grep a single ndjson file (FE+BE interleaved by
// ts) instead of asking the user to paste live snapshots each iteration.
const FE_SNAPSHOT_INTERVAL_MS = 60_000;
let _feSnapshotTimer: number | null = null;

function _pushFeSnapshot(): void {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    // Tab in background: setInterval is throttled or paused anyway, and a
    // hidden-tab snapshot adds little signal. Skip — we'll resume on next tick.
    return;
  }
  const payload = {
    ts: new Date().toISOString(),
    ua: typeof navigator !== 'undefined' ? navigator.userAgent : '',
    url: typeof window !== 'undefined' ? window.location.href : '',
    netMetrics: getNetMetrics(),
    reconnectMetrics: getReconnectMetrics(),
  };
  try {
    fetch('/v1/debug/snapshot/fe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      keepalive: true,
    }).catch(() => {});
  } catch (_) {}
}

export function startFeSnapshotPusher(): void {
  if (_feSnapshotTimer != null) return;
  _feSnapshotTimer = (typeof window !== 'undefined' ? window.setInterval : setInterval)(
    _pushFeSnapshot,
    FE_SNAPSHOT_INTERVAL_MS,
  ) as unknown as number;
  // Push one immediately so the log captures the FE side from boot, not
  // 60 s later.
  _pushFeSnapshot();
}
