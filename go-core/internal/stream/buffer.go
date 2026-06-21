package stream

import (
	"container/list"
	"encoding/json"
	"sync"
	"sync/atomic"
	"time"
)

// MaxBufferedChunks is the per-session ring-buffer cap. The Node bridge
// uses STREAMING_CHUNK_CAP=5000 for the live phase; Go runs leaner.
// 500 chunks gives a comfortable reconnect window even for tool-heavy
// turns (per-tool-call we emit toolUse + toolResult + surrounding text
// deltas, which adds up to 30-50 chunks per call; a 10-tool turn fits
// comfortably). The previous 200-chunk cap evicted early chunks on
// long turns, which manifested as a cold reconnect (post-reload) seeing
// only the tail of the reply because the persisted-snapshot path the FE
// shows during typing got swapped for the partial ring replay on
// `_replay_end`. With 500 the eviction window is roughly an order of
// magnitude rarer; rarer-still cases are covered by the FE's snapshot
// reconciliation at finalize.
//
// Memory footprint: 500 chunks × ~500 B/chunk × 500 active sessions ≈
// 125 MB worst case. In practice steady state is a fraction of that
// because most sessions hold <50 chunks.
const MaxBufferedChunks = 500

// MaxActiveSessions is the LRU cap on the number of sessions held in
// the buffer at once. Matches Node's MAX_ACTIVE_STREAMS (streams.ts:394).
// On overflow the least-recently-touched session is evicted; its
// subscribers see an EOF on the chunk channel.
const MaxActiveSessions = 500

// PostFinishReplayGrace is how long a finalised session stays in the
// buffer so a late reconnect can replay the end chunk. Matches Node's
// POST_FINISH_REPLAY_GRACE_MS (60 s).
const PostFinishReplayGrace = 60 * time.Second

// StaleStreamThreshold is how long an entry can sit with zero listeners
// and no fresh Append before the stale-stream watchdog promotes it to
// "done" via ScheduleFinalize. Covers the failure mode where an
// adapter goroutine hangs or dies without calling _end — without this
// the entry stays Active forever and the FE picker keeps flashing
// "busy" on that session. 10 min comfortably covers any legitimate
// quiet tool-call window (real tool calls still emit toolUse +
// toolResult chunks which keep lastAppendAt fresh) while keeping the
// stuck-session window short enough that users don't see a half-hour
// of phantom-busy state.
const StaleStreamThreshold = 10 * time.Minute

// StaleSweepInterval is how often the watchdog scans for stale
// entries. 1 min is frequent enough that stuck sessions clear within
// ~11 min in the worst case while staying well below the threshold.
const StaleSweepInterval = 1 * time.Minute

// SessionBuffer is a per-session ring buffer of stream chunks indexed
// by session ID. Each session gets:
//   - A monotonic Seq counter stamped on every Append
//   - A bounded chunk slice (last MaxBufferedChunks chunks)
//   - A listener fan-out so live reattach can stream new chunks AFTER
//     replaying the recent tail
//
// LRU bound: the buffer holds at most MaxActiveSessions sessions; on
// overflow the least-recently-touched is dropped (chan closed, slot
// reclaimed). Touch happens on Append + Subscribe + Replay.
//
// Concurrency: a top-level RWMutex guards the session map; each
// session has its own mutex guarding its chunks + listeners. Read
// paths (Replay) hold the map RLock plus the session lock; writers
// (Append/Drop/Subscribe) acquire whichever they need.
type SessionBuffer struct {
	mu       sync.RWMutex
	sessions map[string]*bufferEntry
	// lru orders sessions by recency; entries.elem points back here for
	// O(1) MoveToFront on touch.
	lru *list.List
	// maxSessions bounds lru.Len. Defaults to MaxActiveSessions; tests
	// can override via NewSessionBufferWithCaps.
	maxSessions int
	maxChunks   int
	grace       time.Duration
	// stopWatchdog is closed by StopStaleStreamWatchdog to signal the
	// sweep goroutine to exit. nil when the watchdog is not running.
	// Guarded by watchdogMu so multiple Enable/Stop calls are safe.
	watchdogMu    sync.Mutex
	stopWatchdog  chan struct{}
	watchdogStale time.Duration // 0 → use StaleStreamThreshold
}

// bufferEntry is one session's buffered state. Guarded by `mu`.
type bufferEntry struct {
	mu        sync.Mutex
	seq       int64 // atomic; monotonic per session
	chunks    []Chunk
	listeners map[uint64]chan Chunk // ID → channel; ID is monotonic per entry
	nextLnID  uint64
	elem      *list.Element // pointer back into SessionBuffer.lru
	// finalizeTimer fires PostFinishReplayGrace after Finalize() so the
	// entry is automatically Drop()'d unless a reattach extends its
	// life. nil while the stream is still live.
	finalizeTimer *time.Timer
	dropped       atomic.Bool
	// silentClose flips true when the last listener detaches while the
	// stream is still active and the detach wasn't flagged intentional.
	// The next Subscribe() reads this to decide whether to emit the
	// disconnect+reattach interrupt pair. Mirrors Node
	// streams.ts:_silentClose.
	silentClose bool
	// lastUnsubAt is the unix-nanos time of the last non-intentional
	// listener unsubscribe. The Subscribe path consults it to debounce
	// disconnect/reattach interrupt pairs: a reconnect that happens
	// within reconnectInterruptGrace of the previous unsub is treated
	// as a transient FE silence-watchdog blip, not a user-visible
	// disconnect, so we don't emit either interrupt. Without this the
	// FE's 25s silence-watchdog (chat-streaming.ts:1579) fired every
	// time a long tool call kept the reattach channel quiet, and the
	// resulting reconnect emitted a fresh "Connection lost" + "Stream
	// resumed" pair on every cycle — visible as the spammy log the
	// user reported at 02:40-02:43.
	lastUnsubAt int64
	// intentionalUntil is the deadline (unix ns) up to which the next
	// listener detach should NOT be treated as a silent close. Set by
	// POST /v1/sessions/:id/stream/detach right before the FE aborts
	// the EventSource on a deliberate session switch.
	intentionalUntil int64
	// lastEndChunk holds the most recent terminal `_end` chunk seen on
	// this session. Replay always returns it (in addition to the
	// regular ring slice) when its Seq >= fromSeq, so the FE's
	// "finalize" trigger reaches it even if the chunk has been evicted
	// from the 200-entry ring by a long post-`_end` tail or many
	// reconnect cycles. Without this a session whose `_end` got pushed
	// out of the ring would leave the FE stuck in "running" state
	// forever.
	lastEndChunk *Chunk
	// lastAppendAt is the unix-nanos time of the most recent Append
	// (or entry creation). The stale-stream watchdog reads this to
	// decide whether the adapter has gone silent and the entry should
	// be promoted to "done" so the FE picker stops flashing busy.
	lastAppendAt int64
}

// reconnectInterruptGrace is the window inside which a fresh
// Subscribe is treated as a transient reconnect (silence-watchdog,
// EventSource auto-retry) instead of a real disconnect+reattach event
// — so we don't emit the interrupt-block pair the user sees as spam.
// 5 s is generous for any normal browser-side reconnect (typical
// EventSource retry is <1 s) but short enough that a genuine multi-
// second drop still surfaces.
const reconnectInterruptGrace = 5 * time.Second

// NewSessionBuffer returns a SessionBuffer with the default caps
// (MaxActiveSessions, MaxBufferedChunks, PostFinishReplayGrace).
func NewSessionBuffer() *SessionBuffer {
	return NewSessionBufferWithCaps(MaxActiveSessions, MaxBufferedChunks, PostFinishReplayGrace)
}

// NewSessionBufferWithCaps is the test-friendly constructor — pick
// small caps so eviction / grace behaviour can be asserted without
// flooding fixtures with thousands of chunks. Zero or negative values
// fall back to defaults.
func NewSessionBufferWithCaps(maxSessions, maxChunks int, grace time.Duration) *SessionBuffer {
	if maxSessions <= 0 {
		maxSessions = MaxActiveSessions
	}
	if maxChunks <= 0 {
		maxChunks = MaxBufferedChunks
	}
	if grace <= 0 {
		grace = PostFinishReplayGrace
	}
	return &SessionBuffer{
		sessions:    make(map[string]*bufferEntry),
		lru:         list.New(),
		maxSessions: maxSessions,
		maxChunks:   maxChunks,
		grace:       grace,
	}
}

// Ensure creates the per-session buffer entry up-front so a reattach
// EventSource opened before the first Append finds the session via
// buffer.Has. The live POST handler calls this at handler entry —
// otherwise a user who switches sessions in the gap between "model
// starts" and "model emits first chunk" gets a 404 from the reattach
// endpoint and the FE gives up reconnecting. Idempotent; touches the
// LRU position so the entry doesn't get evicted while we're racing
// the first emit.
func (b *SessionBuffer) Ensure(sessionId string) {
	if b == nil || sessionId == "" {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.ensureLocked(sessionId)
	b.enforceLRULocked()
}

// NextSeq stamps and returns the next sequence number for sessionId,
// allocating an entry if needed. Used by callers that want to assign
// the seq just before they finalise the Chunk struct (e.g. the
// stream loop, so error / done chunks get a seq too).
func (b *SessionBuffer) NextSeq(sessionId string) int64 {
	if sessionId == "" {
		return 0
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	e := b.ensureLocked(sessionId)
	return atomic.AddInt64(&e.seq, 1)
}

// Append stamps the chunk with a new seq (if Seq is zero) and adds it
// to the session's ring buffer + fans out to any subscribers. The
// supplied Chunk is COPIED; the caller's struct is mutated in-place to
// carry the assigned Seq back out, so the same value can be written
// to the live SSE stream.
//
// A zero sessionId is a no-op (returns the chunk unchanged) so the
// route handler can disable buffering by passing an empty session ID.
func (b *SessionBuffer) Append(sessionId string, c Chunk) Chunk {
	if sessionId == "" {
		return c
	}
	b.mu.Lock()
	e := b.ensureLocked(sessionId)
	// Evict if we just exceeded the cap.
	b.enforceLRULocked()
	b.mu.Unlock()

	if c.Seq == 0 {
		c.Seq = atomic.AddInt64(&e.seq, 1)
	} else {
		// Keep the seq monotonic even if the caller pre-assigned: take
		// max(internal, supplied) so future NextSeq calls don't collide.
		for {
			cur := atomic.LoadInt64(&e.seq)
			if c.Seq <= cur {
				break
			}
			if atomic.CompareAndSwapInt64(&e.seq, cur, c.Seq) {
				break
			}
		}
	}

	// Marshal the SSE wire payload once, here at the single fan-out point,
	// so the ring + every listener (live POST pump and each reattach pump)
	// reuse these bytes. Previously each listener re-ran json.Marshal on the
	// same chunk (C7: redundant work + GC pressure on reattach / multi-tab).
	// Done after Seq stamping so the embedded `_seq` is final; `payload` is
	// `json:"-"`, so this does not recurse or change the wire shape.
	if payload, err := json.Marshal(c); err == nil {
		c.payload = payload
	}

	e.mu.Lock()
	if e.dropped.Load() {
		e.mu.Unlock()
		return c
	}
	e.lastAppendAt = time.Now().UnixNano()
	e.chunks = append(e.chunks, c)
	if len(e.chunks) > b.maxChunks {
		// Drop oldest. Re-slice to keep the underlying array small.
		drop := len(e.chunks) - b.maxChunks
		e.chunks = append(e.chunks[:0], e.chunks[drop:]...)
	}
	// Stash the latest terminal `_end` chunk so Replay can return it
	// even after eviction. Without this, a session that produces
	// >MaxBufferedChunks chunks after `_end` (e.g. post-end subprocess
	// cleanup chunks, or many silence-watchdog reconnect cycles) loses
	// the `_end` from the ring — and an FE that reconnects later
	// finds no terminal chunk to drive finish('done'), so it stays in
	// the "running" state forever.
	if c.End {
		clone := c
		e.lastEndChunk = &clone
	}
	// Non-blocking sends under the entry lock so closeEntry can't
	// close a channel between snapshot and send. Subscribers consume
	// in their own goroutine; the send is bounded by the channel cap
	// (default 64) so a slow consumer just drops chunks (replay will
	// catch them up on reconnect).
	for _, ch := range e.listeners {
		select {
		case ch <- c:
		default:
			// Subscriber is full / not reading. Drop the chunk on the
			// floor for this subscriber — the replay path will catch
			// them up on their next reconnect.
		}
	}
	e.mu.Unlock()
	return c
}

// Replay returns every buffered chunk with Seq >= fromSeq for the
// given session. Returns (nil, false) if the session has no entry.
// The slice is a fresh copy; callers may mutate it freely.
func (b *SessionBuffer) Replay(sessionId string, fromSeq int64) ([]Chunk, bool) {
	if sessionId == "" {
		return nil, false
	}
	b.mu.RLock()
	e, ok := b.sessions[sessionId]
	b.mu.RUnlock()
	if !ok {
		return nil, false
	}
	// Touch the LRU position so a reattaching reader keeps the entry
	// alive even if no further Append happens.
	b.mu.Lock()
	if e.elem != nil {
		b.lru.MoveToFront(e.elem)
	}
	b.mu.Unlock()

	e.mu.Lock()
	defer e.mu.Unlock()
	out := make([]Chunk, 0, len(e.chunks))
	sawEnd := false
	for _, c := range e.chunks {
		if c.Seq >= fromSeq {
			out = append(out, c)
			if c.End {
				sawEnd = true
			}
		}
	}
	// Sticky-end fallback: if we have a stashed terminal `_end`, its
	// Seq is within the FE's resume window, and the ring no longer
	// carries it (evicted by a long post-end tail), append it now so
	// the FE's finish('done') trigger fires. Without this fallback an
	// FE that reconnects after the ring rolled past `_end` stays in
	// "running" state forever even though the stream is over.
	if !sawEnd && e.lastEndChunk != nil && e.lastEndChunk.Seq >= fromSeq {
		out = append(out, *e.lastEndChunk)
	}
	return out, true
}

// Subscribe registers a listener channel for live chunks on sessionId
// and returns the channel + an unsubscribe function. The channel is
// buffered (cap 64) so the producer doesn't block on a slow consumer
// for short bursts; a full channel silently drops chunks (the
// consumer will catch them on their next reconnect's replay).
//
// The returned channel is closed by Drop(sessionId) (or LRU eviction);
// listeners should range over it.
func (b *SessionBuffer) Subscribe(sessionId string) (<-chan Chunk, func()) {
	if sessionId == "" {
		ch := make(chan Chunk)
		close(ch)
		return ch, func() {}
	}
	b.mu.Lock()
	e := b.ensureLocked(sessionId)
	b.enforceLRULocked()
	b.mu.Unlock()

	e.mu.Lock()
	id := e.nextLnID
	e.nextLnID++
	// Channel cap balances "tolerate a slow consumer for a beat or
	// two" against memory pressure when many subscribers attach to a
	// chatty session. 64 was too tight: a tunneled FE doing per-chunk
	// renderBlocks would fill the channel during a brief burst,
	// Buffer.Append's non-blocking send would drop chunks, and the
	// FE saw holes in the assistant reply (the seq-gap is recoverable
	// via reattach but only as long as the missing chunks are still in
	// the ring). 1024 buys ~1 s of slack at 1000 chunks/s.
	ch := make(chan Chunk, 1024)
	if e.listeners == nil {
		e.listeners = make(map[uint64]chan Chunk)
	}
	e.listeners[id] = ch
	dropped := e.dropped.Load()
	// Detect a reconnect-after-silent-close to emit the disconnect +
	// reattach interrupt pair. silentClose flipped true on a
	// non-intentional detach that left the listener count at zero
	// while the stream was still active. We debounce here: if the
	// previous unsub was within reconnectInterruptGrace, this is a
	// transient FE retry (EventSource auto-reconnect, silence-watchdog
	// blip), NOT a user-visible disconnect — skip both interrupts.
	// Resetting silentClose regardless so subsequent attaches don't
	// repeat.
	emitResume := e.silentClose
	gapNs := time.Now().UnixNano() - e.lastUnsubAt
	rapidReconnect := emitResume && e.lastUnsubAt != 0 && gapNs < int64(reconnectInterruptGrace)
	if rapidReconnect {
		emitResume = false
	}
	e.silentClose = false
	chunkCount := len(e.chunks)
	e.mu.Unlock()

	if emitResume {
		// Emit BOTH interrupts now (the disconnect was deferred from
		// unsub time so a rapid reconnect could cancel it). Order is
		// disconnect → reattach so the FE renders the pair in the
		// correct chronological order. Wire shape is the FE's
		// `chunk.interruptBlock = {kind, text, ts}` envelope — not a
		// bare {type:"interrupt", text:"..."} chunk, which the FE's
		// generic text-delta handler would fold into the assistant's
		// visible reply.
		b.Append(sessionId, Chunk{
			InterruptBlock: &InterruptBlockChunk{
				Kind: "disconnect",
				Text: "Stream connection dropped. YHA can replay the buffered tail if this session reconnects in time.",
				Ts:   time.Now().UnixMilli(),
			},
		})
		b.Append(sessionId, Chunk{
			InterruptBlock: &InterruptBlockChunk{
				Kind: "reconnect",
				Text: "Stream reattached to the same in-flight reply.",
				Ts:   time.Now().UnixMilli(),
			},
		})
	}
	_ = chunkCount // available for future "x chunks buffered" hint

	if dropped {
		// Race: another goroutine dropped this entry between the map
		// lookup and the listener insertion. Close the channel so the
		// caller sees EOF immediately.
		e.mu.Lock()
		delete(e.listeners, id)
		e.mu.Unlock()
		close(ch)
		return ch, func() {}
	}

	unsub := func() {
		e.mu.Lock()
		if existing, ok := e.listeners[id]; ok {
			delete(e.listeners, id)
			close(existing)
		}
		// Last listener gone while the stream is still live? Flag a
		// silent close (consumed by the next Subscribe to decide
		// whether to emit the disconnect+reattach interrupt pair).
		// Intentional detaches (FE flagged the switch as deliberate
		// via POST /v1/sessions/:id/stream/detach) skip the flag.
		// We do NOT emit "Stream connection dropped" here anymore —
		// it's deferred to the next Subscribe so a rapid reconnect
		// (silence-watchdog, EventSource auto-retry) can cancel it
		// and the user doesn't see the disconnect+reattach pair
		// spamming on every transient retry. Mirrors Node
		// streams.ts:recordSseClose but with debounce.
		stillStreaming := e.finalizeTimer == nil
		isIntentional := e.intentionalUntil != 0 && time.Now().UnixNano() < e.intentionalUntil
		flagSilent := stillStreaming && len(e.listeners) == 0 && !isIntentional
		if isIntentional {
			// Intentional detach is one-shot — consume the flag so a
			// later unintentional detach still surfaces.
			e.intentionalUntil = 0
		}
		if flagSilent {
			e.silentClose = true
			e.lastUnsubAt = time.Now().UnixNano()
		}
		e.mu.Unlock()
	}
	return ch, unsub
}

// MarkIntentionalDetach flags the session's next listener-detach as
// deliberate so Subscribe/unsubscribe doesn't emit the
// "Connection lost" interrupt block. Window is 2 s (matches Node's
// INTENTIONAL_DETACH_WINDOW_MS); a longer ttlMs caps to 10 s.
// Returns true when a buffer entry exists for the session, false on
// unknown sids. Mirrors bridge/sessions-internal/streams.ts.
func (b *SessionBuffer) MarkIntentionalDetach(sessionId string, ttl time.Duration) bool {
	if b == nil || sessionId == "" {
		return false
	}
	if ttl <= 0 {
		ttl = 2 * time.Second
	}
	if ttl > 10*time.Second {
		ttl = 10 * time.Second
	}
	b.mu.RLock()
	e, ok := b.sessions[sessionId]
	b.mu.RUnlock()
	if !ok {
		return false
	}
	e.mu.Lock()
	e.intentionalUntil = time.Now().Add(ttl).UnixNano()
	e.mu.Unlock()
	return true
}

// Drop removes the session's entry and closes every listener channel.
// Called by the route handler when a stream finalises cleanly (after
// the grace period, via ScheduleFinalize) or when LRU eviction kicks
// in.
func (b *SessionBuffer) Drop(sessionId string) {
	if sessionId == "" {
		return
	}
	b.mu.Lock()
	e, ok := b.sessions[sessionId]
	if !ok {
		b.mu.Unlock()
		return
	}
	delete(b.sessions, sessionId)
	if e.elem != nil {
		b.lru.Remove(e.elem)
		e.elem = nil
	}
	b.mu.Unlock()
	b.closeEntry(e)
}

// ScheduleFinalize arms a timer to Drop(sessionId) after the buffer's
// grace period. Idempotent: a second call resets the timer. Used by
// the stream loop on clean completion — keeps the buffer alive long
// enough for a slow reattach to replay the done chunk.
func (b *SessionBuffer) ScheduleFinalize(sessionId string) {
	if sessionId == "" {
		return
	}
	b.mu.Lock()
	e, ok := b.sessions[sessionId]
	if !ok {
		b.mu.Unlock()
		return
	}
	b.mu.Unlock()
	e.mu.Lock()
	if e.finalizeTimer != nil {
		e.finalizeTimer.Stop()
	}
	e.finalizeTimer = time.AfterFunc(b.grace, func() {
		b.Drop(sessionId)
	})
	e.mu.Unlock()
}

// CancelFinalize undoes a pending ScheduleFinalize so a fresh stream
// on the same sessionId (immediate reattach + new turn) keeps its
// buffer warm.
func (b *SessionBuffer) CancelFinalize(sessionId string) {
	if sessionId == "" {
		return
	}
	b.mu.RLock()
	e, ok := b.sessions[sessionId]
	b.mu.RUnlock()
	if !ok {
		return
	}
	e.mu.Lock()
	if e.finalizeTimer != nil {
		e.finalizeTimer.Stop()
		e.finalizeTimer = nil
	}
	e.mu.Unlock()
}

// EnableStaleStreamWatchdog starts a background goroutine that
// periodically scans the buffer for entries with zero listeners that
// haven't received an Append in `threshold` and promotes them to
// "done" via ScheduleFinalize. Covers the case where an adapter
// goroutine hangs/crashes without ever emitting `_end` — without the
// watchdog the entry's finalizeTimer stays nil forever, ActiveSessions
// keeps returning it, and the FE picker keeps flashing busy on that
// row indefinitely (the bug seen at https://.../ypa#s/s1779397613528).
// Idempotent: a second call stops the previous goroutine and starts a
// fresh one with the new parameters. Zero/negative threshold or sweep
// fall back to the package defaults. Production wires this in main.go;
// tests can call it directly to assert the timing.
func (b *SessionBuffer) EnableStaleStreamWatchdog(threshold, sweep time.Duration) {
	if b == nil {
		return
	}
	if threshold <= 0 {
		threshold = StaleStreamThreshold
	}
	if sweep <= 0 {
		sweep = StaleSweepInterval
	}
	b.watchdogMu.Lock()
	if b.stopWatchdog != nil {
		close(b.stopWatchdog)
	}
	stop := make(chan struct{})
	b.stopWatchdog = stop
	b.watchdogStale = threshold
	b.watchdogMu.Unlock()
	go b.runStaleStreamWatchdog(threshold, sweep, stop)
}

// StopStaleStreamWatchdog halts the background sweep started by
// EnableStaleStreamWatchdog. No-op if the watchdog is not running.
// Tests call this in cleanup to avoid leaking goroutines past the test
// boundary.
func (b *SessionBuffer) StopStaleStreamWatchdog() {
	if b == nil {
		return
	}
	b.watchdogMu.Lock()
	if b.stopWatchdog != nil {
		close(b.stopWatchdog)
		b.stopWatchdog = nil
	}
	b.watchdogMu.Unlock()
}

func (b *SessionBuffer) runStaleStreamWatchdog(threshold, sweep time.Duration, stop <-chan struct{}) {
	t := time.NewTicker(sweep)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			b.sweepStaleStreams(threshold)
		}
	}
}

// sweepStaleStreams is the single tick of the watchdog. Exported as a
// method (lowercase, package-internal) so tests can trigger a sweep
// synchronously instead of waiting for a real ticker.
func (b *SessionBuffer) sweepStaleStreams(threshold time.Duration) {
	if b == nil {
		return
	}
	cutoff := time.Now().UnixNano() - int64(threshold)
	var stale []string
	b.mu.RLock()
	for sid, e := range b.sessions {
		e.mu.Lock()
		// Only promote streams that look genuinely abandoned:
		//   - no finalize timer yet (still "streaming" from Status's POV)
		//   - zero listeners (FE has disconnected — nobody's waiting)
		//   - not already dropped (race vs LRU eviction)
		//   - lastAppendAt older than the threshold (adapter silent)
		idle := e.finalizeTimer == nil &&
			len(e.listeners) == 0 &&
			!e.dropped.Load() &&
			e.lastAppendAt > 0 &&
			e.lastAppendAt < cutoff
		e.mu.Unlock()
		if idle {
			stale = append(stale, sid)
		}
	}
	b.mu.RUnlock()
	for _, sid := range stale {
		b.ScheduleFinalize(sid)
	}
}

// SessionStatus is what GET /v1/sessions/:id/status returns. Mirrors
// the legacy Node bridge/routes/chat-lifecycle.ts shape so the FE
// session picker / reconnect path keeps reading the same fields.
type SessionStatus struct {
	Active      bool   `json:"active"`      // true while the stream is still emitting
	Status      string `json:"status"`      // "streaming" | "done" | "unknown"
	ChunksCount int    `json:"chunksCount"` // length of the in-memory replay buffer
	Listeners   int    `json:"listeners"`   // currently-attached reattach EventSources
}

// Status returns the per-session liveness snapshot the FE consults to
// know whether to reattach. An empty/unknown session ID returns
// {active:false, status:"unknown"} so the FE picker / reconnect logic
// can fall back gracefully. Mirrors Node's
// bridge/routes/chat-lifecycle.ts:23-35 shape so the consumer code
// (frontend chat-streaming reconnect path) keeps working unchanged.
func (b *SessionBuffer) Status(sessionId string) SessionStatus {
	if b == nil || sessionId == "" {
		return SessionStatus{Status: "unknown"}
	}
	b.mu.RLock()
	entry, ok := b.sessions[sessionId]
	b.mu.RUnlock()
	if !ok {
		return SessionStatus{Status: "unknown"}
	}
	entry.mu.Lock()
	defer entry.mu.Unlock()
	// finalizeTimer != nil → ScheduleFinalize() fired → the stream
	// is in its post-finish grace window. Anything still in the map
	// without that timer is mid-stream.
	status := "streaming"
	active := true
	if entry.finalizeTimer != nil {
		status = "done"
		active = false
	}
	return SessionStatus{
		Active:      active,
		Status:      status,
		ChunksCount: len(entry.chunks),
		Listeners:   len(entry.listeners),
	}
}

// ActiveSessions returns the IDs of every session currently in a
// "streaming" state — buffer entry exists AND no ScheduleFinalize has
// fired yet. Used by Node's `/v1/sessions/` list handler to populate
// `isRunning` for Go-owned turns (its own activeStreams map is empty
// for those). Returns the IDs in unspecified order.
func (b *SessionBuffer) ActiveSessions() []string {
	if b == nil {
		return nil
	}
	b.mu.RLock()
	defer b.mu.RUnlock()
	out := make([]string, 0, len(b.sessions))
	for sid, e := range b.sessions {
		e.mu.Lock()
		streaming := e.finalizeTimer == nil && !e.dropped.Load()
		e.mu.Unlock()
		if streaming {
			out = append(out, sid)
		}
	}
	return out
}

// Has reports whether the buffer currently has an entry for sessionId.
// Cheap; used by the reattach handler to decide 404 vs 200.
func (b *SessionBuffer) Has(sessionId string) bool {
	if sessionId == "" {
		return false
	}
	b.mu.RLock()
	_, ok := b.sessions[sessionId]
	b.mu.RUnlock()
	return ok
}

// Len returns the number of sessions currently held. Exposed for tests.
func (b *SessionBuffer) Len() int {
	b.mu.RLock()
	defer b.mu.RUnlock()
	return len(b.sessions)
}

// ensureLocked finds or creates the entry for sessionId. Caller must
// hold b.mu (write lock).
func (b *SessionBuffer) ensureLocked(sessionId string) *bufferEntry {
	if e, ok := b.sessions[sessionId]; ok {
		if e.elem != nil {
			b.lru.MoveToFront(e.elem)
		}
		return e
	}
	e := &bufferEntry{
		listeners:    make(map[uint64]chan Chunk),
		lastAppendAt: time.Now().UnixNano(),
	}
	b.sessions[sessionId] = e
	e.elem = b.lru.PushFront(sessionId)
	return e
}

// enforceLRULocked drops the oldest entries until the session count is
// at or below the configured cap. Caller must hold b.mu (write lock).
func (b *SessionBuffer) enforceLRULocked() {
	for len(b.sessions) > b.maxSessions {
		back := b.lru.Back()
		if back == nil {
			return
		}
		sid := back.Value.(string)
		e := b.sessions[sid]
		delete(b.sessions, sid)
		b.lru.Remove(back)
		if e != nil {
			e.elem = nil
		}
		// Closing listeners while holding the map lock would block on
		// slow consumers; do it in a goroutine. The entry is already
		// detached so no new state can be added to it.
		if e != nil {
			go b.closeEntry(e)
		}
	}
}

// closeEntry tears down a detached entry: stops the finalize timer,
// closes every listener channel, marks the entry as dropped so any
// concurrent Append / Subscribe on the same struct can early-out.
func (b *SessionBuffer) closeEntry(e *bufferEntry) {
	if e == nil {
		return
	}
	e.dropped.Store(true)
	e.mu.Lock()
	if e.finalizeTimer != nil {
		e.finalizeTimer.Stop()
		e.finalizeTimer = nil
	}
	for id, ch := range e.listeners {
		close(ch)
		delete(e.listeners, id)
	}
	e.chunks = nil
	e.mu.Unlock()
}
