// ── Active stream registry, broadcast/finalize, zombie GC ─────────────────────
'use strict';

const { activeStreams, config } = require('../core/state');
const logger = require('../core/logger');
const { getModuleApi } = require('../core/modules');

// Cost / token recording is owned by the `observability-plus` module.
// Re-resolve via getModuleApi on every call so disabling the module
// silent-skips bookkeeping instead of crashing the streaming hot path.
function _recordCost(...args: any[]) {
  const obs = getModuleApi<any>('observability-plus');
  obs?.recordCost?.(...args);
}
function _recordTokens(...args: any[]) {
  const obs = getModuleApi<any>('observability-plus');
  obs?.recordTokens?.(...args);
}

// Process-wide counters used by the #debug monitoring panel. Incremented on
// every broadcastChunk call. Cheap (one JSON.stringify per chunk; we compute
// the size once and reuse the result for the per-stream counter).
const _globalMetrics = {
  totalBytesBroadcast: 0,
  totalChunksBroadcast: 0,
  totalListenerCalls: 0,
  silentDisconnects: 0,    // res closed during status=streaming with no _end fired
  reconnectsObserved: 0,    // listener attached to a stream that already had chunks
  gcEvictions: 0,
  peakActiveStreams: 0,
  peakListenersPerStream: 0,
  startedAt: Date.now(),
};

function getGlobalStreamMetrics() {
  return { ..._globalMetrics };
}

// Ring buffer for finalized streams — survives the 60s post-finalize cleanup
// so the monitoring "History" tab can show recent stream forensics. Live
// references not kept (listeners cleared, chunks stripped to last 5 for
// peek/replay-style debugging only).
const _historicalStreams: any[] = [];
const HISTORICAL_CAP = 50;

function _archiveStream(sessionId: string, stream: any): void {
  const snapshot = {
    id: sessionId,
    status: stream.status,
    error: stream.error || null,
    model: stream.model || null,
    provider: stream.provider || null,
    startedAt: stream._startedAt || null,
    doneAt: stream.doneAt || null,
    durationMs: (stream._startedAt && stream.doneAt) ? stream.doneAt - stream._startedAt : null,
    chunkCount: stream._chunkCount || 0,
    bytesOut: stream._bytesOut || 0,
    inputTokens: stream.inputTokens || 0,
    outputTokens: stream.outputTokens || 0,
    cacheCreationTokens: stream.cacheCreationTokens || 0,
    cacheReadTokens: stream.cacheReadTokens || 0,
    toolUseCount: stream._toolUseCount || 0,
    cost: stream.cost || 0,
    listenerHistory: stream._listenerHistory ? stream._listenerHistory.slice(-30) : [],
    chunkRateBuckets: stream._chunkRateBuckets || [],
    idleGapsMs: stream._idleGapsMs || [],
    silentClose: !!stream._silentClose,
    reconnectsHere: stream._reconnectsHere || 0,
  };
  _historicalStreams.push(snapshot);
  if (_historicalStreams.length > HISTORICAL_CAP) _historicalStreams.shift();
}

function getHistoricalStreams() {
  return _historicalStreams.slice();
}

// Marks the next SSE close for this session as a deliberate FE detach (e.g.
// the user clicked the session switcher) so recordSseClose() can suppress
// the "Connection lost" interrupt block + the matching "Stream resumed" on
// reattach. One-shot with a short TTL: if the close doesn't follow within
// the window the flag silently expires so subsequent real network drops
// surface normally. Set via POST /v1/sessions/:id/stream/detach from the FE
// right before it aborts the EventSource.
const INTENTIONAL_DETACH_WINDOW_MS = 2000;
function markIntentionalDetach(sessionId: string, ttlMs?: number): boolean {
  const stream = activeStreams.get(sessionId);
  if (!stream) return false;
  const ttl = Math.max(250, Math.min(Number(ttlMs) || INTENTIONAL_DETACH_WINDOW_MS, 10_000));
  stream._intentionalDetachUntil = Date.now() + ttl;
  return true;
}

// Called by chat-lifecycle.ts when an SSE response closes. The route handler
// already removes the listener from the set; this just classifies whether the
// close was the natural _end (drained, chunk._end fired) or premature
// (browser closed mid-stream / network drop). For the latter we bump
// silentDisconnects so the monitoring panel can flag connection quality.
//
// Intentional FE detaches (session switch, session delete) are flagged via
// markIntentionalDetach() — those still record the listener-detach event in
// history (with `intentional: true` for the monitoring panel) but skip the
// silentDisconnects bump and the user-visible "Connection lost" block. We
// also leave _silentClose / _lastDisconnectAt untouched so the matching
// "Stream resumed" injection in recordSseAttach() is suppressed too.
function recordSseClose(sessionId: string, hadEnd: boolean): void {
  const stream = activeStreams.get(sessionId);
  if (!stream) return;
  if (!stream._listenerHistory) stream._listenerHistory = [];
  const intentional = !!(stream._intentionalDetachUntil && Date.now() < stream._intentionalDetachUntil);
  if (intentional) stream._intentionalDetachUntil = 0; // one-shot
  stream._listenerHistory.push({
    at: Date.now(),
    action: 'detach',
    listenersAfter: stream.listeners?.size || 0,
    hadEnd,
    intentional: intentional || undefined,
  });
  if (stream._listenerHistory.length > 50) stream._listenerHistory.shift();
  if (!hadEnd && !intentional && stream.status === 'streaming') {
    stream._silentClose = true;
    stream._lastDisconnectAt = Date.now();
    _globalMetrics.silentDisconnects += 1;
    try {
      const { injectInlineBlock } = require('../chat/btw-queue');
      const block = {
        type: 'interrupt',
        kind: 'disconnect',
        text: 'Stream connection dropped. YHA can replay the buffered tail if this session reconnects in time.',
        ts: stream._lastDisconnectAt,
        bufferedChunks: stream.chunks?.length || 0,
        chunkCap: _streamingChunkCap(),
        approxTailMs: _estimateTailMs(stream),
        postFinishGraceMs: POST_FINISH_REPLAY_GRACE_MS,
      };
      injectInlineBlock(sessionId, block, broadcastChunk, { interruptBlock: block });
    } catch (_) {}
  }
}

// Called by chat-lifecycle.ts when an SSE listener is attached. Tracks
// reconnects (attach to a stream that already had chunks) so monitoring
// can spot sessions that the FE keeps re-attaching to (= flaky network).
function recordSseAttach(sessionId: string, info: { replayed?: number; fromSeq?: number } = {}): void {
  const stream = activeStreams.get(sessionId);
  if (!stream) return;
  if (!stream._listenerHistory) stream._listenerHistory = [];
  const isReconnect = (stream._chunkCount || 0) > 0 || (stream._listenerHistory.length > 0);
  stream._listenerHistory.push({
    at: Date.now(),
    action: 'attach',
    listenersAfter: stream.listeners?.size || 0,
    isReconnect,
  });
  if (stream._listenerHistory.length > 50) stream._listenerHistory.shift();
  if (isReconnect) {
    stream._reconnectsHere = (stream._reconnectsHere || 0) + 1;
    _globalMetrics.reconnectsObserved += 1;
    if (stream._silentClose || stream._lastDisconnectAt) {
      const resumedAt = Date.now();
      try {
        const { injectInlineBlock } = require('../chat/btw-queue');
        const block = {
          type: 'interrupt',
          kind: 'reconnect',
          text: 'Stream reattached to the same in-flight reply.',
          ts: resumedAt,
          replayedCount: Number(info.replayed) || 0,
          fromSeq: Number(info.fromSeq) || 0,
          gapMs: stream._lastDisconnectAt ? Math.max(0, resumedAt - stream._lastDisconnectAt) : null,
          postFinishGraceMs: POST_FINISH_REPLAY_GRACE_MS,
        };
        injectInlineBlock(sessionId, block, broadcastChunk, { interruptBlock: block });
      } catch (_) {}
      stream._silentClose = false;
      stream._lastDisconnectAt = 0;
    }
  }
  if ((stream.listeners?.size || 0) > _globalMetrics.peakListenersPerStream) {
    _globalMetrics.peakListenersPerStream = stream.listeners.size;
  }
}

const IDLE_GAP_THRESHOLD_MS = 5000;
const CHUNK_BUCKET_WINDOW_MS = 60_000;
const CHUNK_BUCKET_CAP = 60;
const POST_FINISH_REPLAY_GRACE_MS = 60_000;

function _estimateTailMs(stream: any): number | null {
  const buckets = Array.isArray(stream?._chunkRateBuckets) ? stream._chunkRateBuckets.slice(-3) : [];
  if (!buckets.length) return null;
  const totalChunks = buckets.reduce((sum, b) => sum + (Number(b?.chunks) || 0), 0);
  const seconds = buckets.length * (CHUNK_BUCKET_WINDOW_MS / 1000);
  if (!totalChunks || !seconds) return null;
  const chunksPerSec = totalChunks / seconds;
  if (chunksPerSec <= 0) return null;
  const remainingChunks = Math.max(0, _streamingChunkCap() - (stream?.chunks?.length || 0));
  return Math.round((remainingChunks / chunksPerSec) * 1000);
}

function getOrCreateStream(sessionId) {
  if (!activeStreams.has(sessionId)) {
    activeStreams.set(sessionId, {
      status: 'streaming',
      chunks: [],
      blocks: [],
      text: '',
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      model: null,
      provider: null,
      error: null,
      listeners: new Set(),
      doneAt: null,
      _startedAt: Date.now(),
      _bytesOut: 0,
      _chunkCount: 0,
      _toolUseCount: 0,        // count of toolUse chunks — fuels tokens panel "tools/call"
      _lastChunkAt: 0,
      _nextSeq: 0,             // monotonic chunk seq for resume-from-N replay
      _idleGapsMs: [],         // gaps > IDLE_GAP_THRESHOLD_MS, capped 20
      _chunkRateBuckets: [],   // per-minute bucket {atMin, chunks, bytes}, capped 60
      _listenerHistory: [],    // {at, action, listenersAfter, ...}, capped 50
      _silentClose: false,
      _reconnectsHere: 0,
    });
    if (activeStreams.size > _globalMetrics.peakActiveStreams) {
      _globalMetrics.peakActiveStreams = activeStreams.size;
    }
  }
  return activeStreams.get(sessionId);
}

function _bumpRateBucket(stream: any, bytes: number): void {
  const nowMin = Math.floor(Date.now() / CHUNK_BUCKET_WINDOW_MS);
  const buckets = stream._chunkRateBuckets;
  const last = buckets.length ? buckets[buckets.length - 1] : null;
  if (last && last.atMin === nowMin) {
    last.chunks += 1;
    last.bytes += bytes;
  } else {
    buckets.push({ atMin: nowMin, chunks: 1, bytes });
    if (buckets.length > CHUNK_BUCKET_CAP) buckets.shift();
  }
}

// Buffer cap while stream is actively producing chunks. Generous so that a
// silent disconnect + delayed reconnect (e.g. tab backgrounded for several
// minutes) can still resume from the seq the FE last saw without losing
// chunks. Memory: ~5MB worst case per stream at 1KB/chunk; finalizeStream
// prunes back to the finalized cap for the post-done grace window. Both
// caps are config.defaults overridable so deployments that need bigger
// buffers (high-volume agents, slow consumers) can tune without editing
// code. Read through accessors so a hot config-reload takes effect on the
// next chunk push rather than the next process boot.
const DEFAULT_STREAMING_CHUNK_CAP = 5000;
const DEFAULT_FINALIZED_CHUNK_CAP = 500;
function _streamingChunkCap(): number {
  const v = Number(config.defaults?.streaming_chunk_cap);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_STREAMING_CHUNK_CAP;
}
function _finalizedChunkCap(): number {
  const v = Number(config.defaults?.finalized_chunk_cap);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_FINALIZED_CHUNK_CAP;
}

// Cheap byte estimate for the monitoring sparkline / _bytesOut counter. A
// chunk's serialized size is dominated by its string fields (text/delta/
// reasoning/tool args); summing their lengths + a small structural constant
// tracks the real size closely enough for a sparkline at O(keys) cost and no
// string allocation — versus JSON.stringify(chunk), which was a *second* full
// serialization of every delta (raw-logs does the first) purely for this
// counter. Approximate by design (string .length, not UTF-8 byte length).
function _estimateChunkBytes(chunk: any): number {
  if (chunk == null || typeof chunk !== 'object') return 0;
  let n = 2; // {}
  for (const k in chunk) {
    if (!Object.prototype.hasOwnProperty.call(chunk, k)) continue;
    n += k.length + 4; // "k": and a separator
    const v = chunk[k];
    const t = typeof v;
    if (t === 'string') n += v.length;
    else if (t === 'number' || t === 'boolean') n += 8;
    else if (v && t === 'object') { try { n += JSON.stringify(v).length; } catch (_) {} }
  }
  return n;
}

function broadcastChunk(sessionId, chunk) {
  const stream = activeStreams.get(sessionId);
  if (!stream) return;
  // Count toolUse chunks even though we also receive an aggregate count from
  // the streaming path's return value — this catches paths (claude binary,
  // SDK) where individual toolUse chunks are the only signal.
  if (chunk.toolUse) stream._toolUseCount = (stream._toolUseCount || 0) + 1;
  // Tag chunk with monotonic seq so reconnects can resume from a specific
  // point. Mutate before push/listeners so replay buffer + live listeners see
  // the same seq. Heartbeat-only chunks (`{_hb:ts}`) are not pushed through
  // here — they're written directly by chat-lifecycle.ts and have no seq.
  stream._nextSeq = (stream._nextSeq || 0) + 1;
  chunk._seq = stream._nextSeq;
  stream.chunks.push(chunk);
  // Amortized trim: overshoot `cap` by a slack window, then bulk-drop the
  // overflow from the front in one splice. Slicing on every push once over cap
  // re-copied the whole cap-sized array per chunk (O(cap) + steady GC churn on
  // long streams); this is amortized O(1) and allocation-free. The overshoot is
  // safe — `chunks` is the live fan-out/metrics buffer (consumers only read
  // .length/.slice; seq-resume replay lives in go-core), so a wider tail never
  // drops a resumable chunk.
  const cap = _streamingChunkCap();
  if (stream.chunks.length > cap + Math.max(256, cap >> 3)) {
    stream.chunks.splice(0, stream.chunks.length - cap);
  }
  // Best-effort byte accounting for the monitoring sparkline / _bytesOut.
  const bytes = _estimateChunkBytes(chunk);
  stream._bytesOut = (stream._bytesOut || 0) + bytes;
  stream._chunkCount = (stream._chunkCount || 0) + 1;
  _globalMetrics.totalBytesBroadcast += bytes;
  _globalMetrics.totalChunksBroadcast += 1;

  // Per-minute rate bucket — fuels sparkline.
  _bumpRateBucket(stream, bytes);

  // Idle-gap tracking — measures intervals between chunks. Tool calls that
  // hang the LLM for >5 s show up here; many big gaps in one stream typically
  // means the model spent most of its time waiting for tool results, not
  // generating.
  const now = Date.now();
  if (stream._lastChunkAt) {
    const gap = now - stream._lastChunkAt;
    if (gap > IDLE_GAP_THRESHOLD_MS) {
      stream._idleGapsMs.push(gap);
      if (stream._idleGapsMs.length > 20) stream._idleGapsMs.shift();
    }
  }
  stream._lastChunkAt = now;

  for (const fn of stream.listeners) {
    _globalMetrics.totalListenerCalls += 1;
    try {
      fn(chunk);
    } catch (e) {
      logger.debug('stream.listener.error', { sessionId, error: e instanceof Error ? e.message : String(e) });
    }
  }
}

function finalizeStream(sessionId, status, extra = {}) {
  const stream = activeStreams.get(sessionId);
  if (!stream) return;
  stream.status = status; // 'done' or 'error'
  Object.assign(stream, extra);
  stream.doneAt = Date.now();
  const durationMs   = stream._startedAt ? stream.doneAt - stream._startedAt : 0;
  const outputTokens = stream.outputTokens || 0;
  const tokensPerSec = (durationMs > 500 && outputTokens > 0)
    ? Math.round(outputTokens / (durationMs / 1000))
    : 0;
  const endChunk =
    status === 'done'
      ? {
          _end: true,
          cost: stream.cost,
          stopReason: stream.stopReason || 'end_turn',
          inputTokens: stream.inputTokens || 0,
          outputTokens,
          cacheCreationTokens: stream.cacheCreationTokens || 0,
          cacheReadTokens: stream.cacheReadTokens || 0,
          durationMs,
          tokensPerSec,
        }
      : { _end: true, error: stream.error };
  if (status === 'done') {
    _recordCost(stream.cost, stream.model, stream.provider);
    _recordTokens({
      inputTokens: stream.inputTokens || 0,
      outputTokens,
      cacheCreationTokens: stream.cacheCreationTokens || 0,
      cacheReadTokens: stream.cacheReadTokens || 0,
      model: stream.model,
      provider: stream.provider,
      durationMs,
      // Prefer the route-reported tool count (extra.toolCallCount) over the
      // chunk-counted value — direct paths report exact counts; the chunk
      // counter is the fallback for paths that don't.
      toolCallCount: (extra as any).toolCallCount ?? stream._toolUseCount ?? 0,
      textLength: (stream.text || '').length,
    });
  }
  // End chunk also gets a seq so late reconnects know where the stream
  // terminated and can ignore stale Last-Event-IDs >= this value.
  stream._nextSeq = (stream._nextSeq || 0) + 1;
  endChunk._seq = stream._nextSeq;
  stream.chunks.push(endChunk);
  for (const fn of stream.listeners) {
    try {
      fn(endChunk);
    } catch (e) {
      logger.debug('stream.finalize.listener.error', { sessionId, error: e instanceof Error ? e.message : String(e) });
    }
  }
  stream.listeners.clear();
  // Prune buffer to a generous tail for late reconnects within the 60s grace
  // window — the full streaming-time buffer (up to 5000 chunks) is no longer
  // needed once the stream has terminated.
  const finalCap = _finalizedChunkCap();
  if (stream.chunks.length > finalCap) {
    stream.chunks = stream.chunks.slice(-finalCap);
  }
  if (stream._listenerHistory) {
    stream._listenerHistory.push({ at: Date.now(), action: 'finalize', listenersAfter: 0, status });
    if (stream._listenerHistory.length > 50) stream._listenerHistory.shift();
  }
  // Archive a snapshot before the live stream gets cleaned up — keeps recent
  // forensics available in the monitoring "History" tab.
  _archiveStream(sessionId, stream);
  try {
    const { unregisterLiveStream } = require('../chat/btw-queue');
    unregisterLiveStream(sessionId);
  } catch (_) {}
  // Clean up after grace period (60s for late reconnects).
  // Capture the stream *reference* not just the sessionId string so a new
  // stream on the same session before the timer fires is not wiped.
  const capturedStream = stream;
  setTimeout(() => {
    if (activeStreams.get(sessionId) === capturedStream) activeStreams.delete(sessionId);
  }, POST_FINISH_REPLAY_GRACE_MS);
}

// GC stale/zombie streams that were never finalized or outlived their grace period.
// Called periodically from startSessionCleanupInterval.
const MAX_STREAM_ZOMBIE_AGE_MS = 60 * 60 * 1000;  // 1 hour — must be stuck if still streaming
const MAX_STREAM_DONE_AGE_MS   = 5 * 60 * 1000;   // 5 min — generous replay window
const MAX_ACTIVE_STREAMS       = 500;              // hard cap — evict oldest done streams first

function _gcStaleStreams() {
  const now = Date.now();
  for (const [sid, stream] of activeStreams) {
    if (stream.status === 'streaming') {
      // Zombie: streaming for > 1hr means something went very wrong
      if (stream._startedAt && (now - stream._startedAt) > MAX_STREAM_ZOMBIE_AGE_MS) {
        logger.warn('streams.gc-zombie', { sid, ageMin: Math.round((now - stream._startedAt) / 60000) });
        stream.listeners.clear();
        // Archive the zombie too so we can see what happened.
        stream.status = 'zombie';
        stream.doneAt = now;
        _archiveStream(sid, stream);
        _globalMetrics.gcEvictions += 1;
        activeStreams.delete(sid);
      }
    } else {
      // Completed stream whose grace period has long expired
      if (stream.doneAt && (now - stream.doneAt) > MAX_STREAM_DONE_AGE_MS) {
        activeStreams.delete(sid);
      }
    }
  }
  // Hard cap: if still too many, evict oldest completed streams
  if (activeStreams.size > MAX_ACTIVE_STREAMS) {
    const done = [...activeStreams.entries()]
      .filter(([, s]) => s.status !== 'streaming')
      .sort(([, a], [, b]) => (a.doneAt || 0) - (b.doneAt || 0));
    for (const [sid] of done.slice(0, activeStreams.size - MAX_ACTIVE_STREAMS)) {
      _globalMetrics.gcEvictions += 1;
      activeStreams.delete(sid);
    }
  }
}

module.exports = {
  getOrCreateStream,
  broadcastChunk,
  finalizeStream,
  getGlobalStreamMetrics,
  getHistoricalStreams,
  recordSseClose,
  recordSseAttach,
  markIntentionalDetach,
  _gcStaleStreams,
};
