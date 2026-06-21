package stream

import (
	"strings"
	"sync"
)

// LiveStdinSink injects one #btw item into a running harness
// subprocess's stdin at the next turn boundary. Returns true when the
// write succeeded (and the harness will see it), false when the sink
// is gone (broken pipe, subprocess exited, etc) — in which case the
// caller falls back to BtwQueue.Enqueue so the next history rebuild
// picks the item up. Mirrors LiveStdinSink in
// bridge/chat/btw-queue.ts:65-88.
type LiveStdinSink func(text string) bool

// EmitSink hands a single Chunk to the running stream's emit closure
// so it lands in (a) the live pumpCh feeding the initial-POST SSE
// writer, (b) blockAccum.Observe for persistence, and (c)
// Buffer.Append for reattach subscribers — all in one shot. Returns
// true when a sink is registered for the session. The btw POST handler
// uses this so its injected `btwBlock` chunk follows the exact same
// path as model-produced chunks; without it, the chunk only reached
// Buffer.Append and skipped the live writer + persistence.
type EmitSink func(c Chunk)

var (
	liveStdinMu    sync.RWMutex
	liveStdinSinks = map[string]LiveStdinSink{}

	emitSinkMu  sync.RWMutex
	emitSinks   = map[string]EmitSink{}
	emitSinkTypes = map[string]string{} // "direct-api" or "harness"
)

// RegisterLiveStdin binds a sink for sessionID. The claude-binary
// harness calls this immediately after spawning a child process so the
// /v1/sessions/:id/btw POST can write straight into the live subprocess
// stdin between turns. Overwrites any previous sink for the session
// (multiple concurrent harness runs for the same session would race —
// last-writer-wins matches Node's semantics).
func RegisterLiveStdin(sessionID string, sink LiveStdinSink) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" || sink == nil {
		return
	}
	liveStdinMu.Lock()
	defer liveStdinMu.Unlock()
	liveStdinSinks[sessionID] = sink
}

// UnregisterLiveStdin clears the sink for sessionID. Called by the
// harness on stream end / error / explicit /v1/stop. Safe to call
// when no sink is registered.
func UnregisterLiveStdin(sessionID string) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return
	}
	liveStdinMu.Lock()
	defer liveStdinMu.Unlock()
	delete(liveStdinSinks, sessionID)
}

// RegisterEmitSink binds the running stream's emit() function for
// sessionID. routeType must be "direct-api" (Go's loop.go tool-loop
// path) or "harness" (claude-binary, codex, etc.) so the /btw POST
// handler can compute the correct livePath badge. Both the direct-API
// path (route.go) and the harness path (route_harness.go) call this
// immediately after building emit(). Last-writer-wins matches
// LiveStdinSink semantics.
func RegisterEmitSink(sessionID string, sink EmitSink, routeType ...string) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" || sink == nil {
		return
	}
	rt := ""
	if len(routeType) > 0 {
		rt = routeType[0]
	}
	emitSinkMu.Lock()
	defer emitSinkMu.Unlock()
	emitSinks[sessionID] = sink
	emitSinkTypes[sessionID] = rt
}

// UnregisterEmitSink clears the emit sink for sessionID. Called when
// the stream's writer pump finishes (end / error / disconnect) so
// stale closures don't keep firing into a finalized stream.
func UnregisterEmitSink(sessionID string) {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return
	}
	emitSinkMu.Lock()
	defer emitSinkMu.Unlock()
	delete(emitSinks, sessionID)
	delete(emitSinkTypes, sessionID)
}

// GetEmitRouteType returns the routeType registered alongside the
// emit sink for sessionID ("direct-api", "harness", or "" when no
// sink is registered). Used by the /btw POST handler to decide
// whether the queued item will be drained this turn (direct-api tool
// loop) or only on the next history rebuild (harness).
func GetEmitRouteType(sessionID string) string {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return ""
	}
	emitSinkMu.RLock()
	defer emitSinkMu.RUnlock()
	return emitSinkTypes[sessionID]
}

// TryEmitInject hands chunk c to the registered emit sink for
// sessionID. Returns true when a sink exists (and was invoked); false
// when no stream is live. Caller falls back to Buffer.Append on false
// so reattach subscribers still see the chunk even when the original
// POST writer has gone away.
func TryEmitInject(sessionID string, c Chunk) bool {
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return false
	}
	emitSinkMu.RLock()
	sink := emitSinks[sessionID]
	emitSinkMu.RUnlock()
	if sink == nil {
		return false
	}
	sink(c)
	return true
}

// TryLiveStdinInject attempts to write text into the registered sink
// for sessionID. Returns true when a sink exists AND its write
// succeeded; false when no sink is registered OR the sink reported a
// closed pipe. The route layer should fall back to BtwQueue.Enqueue on
// false so the user's mid-stream injection isn't dropped.
func TryLiveStdinInject(sessionID, text string) bool {
	sessionID = strings.TrimSpace(sessionID)
	text = strings.TrimSpace(text)
	if sessionID == "" || text == "" {
		return false
	}
	liveStdinMu.RLock()
	sink := liveStdinSinks[sessionID]
	liveStdinMu.RUnlock()
	if sink == nil {
		return false
	}
	return sink(text)
}

// BtwQueue holds per-session #btw items the user dropped into a
// session while a stream was already running. The direct-API tool
// loop drains it at each tool-call boundary and folds the items into
// a synthetic user message before the next provider call. Harness
// adapters either pick it up via the same drain (claude-binary live
// stdin sink — TODO) or it sits in the queue until the next turn's
// history rebuild reflects it. Mirrors Node's bridge/chat/btw-queue.ts.
type BtwQueue struct {
	mu sync.Mutex
	m  map[string][]string
}

// NewBtwQueue returns an empty queue. Safe for concurrent use.
func NewBtwQueue() *BtwQueue {
	return &BtwQueue{m: map[string][]string{}}
}

// Enqueue appends one #btw item for sessionID. Trims whitespace; an
// empty string is a no-op. The /v1/sessions/:id/btw endpoint calls
// this; the FE chat input also fires the request when the user types
// `#btw <text>` mid-stream.
func (b *BtwQueue) Enqueue(sessionID, text string) {
	if b == nil {
		return
	}
	sessionID = strings.TrimSpace(sessionID)
	text = strings.TrimSpace(text)
	if sessionID == "" || text == "" {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.m[sessionID] = append(b.m[sessionID], text)
}

// Drain returns every pending #btw item for sessionID and clears the
// queue. Returns nil for empty / unknown sessions.
func (b *BtwQueue) Drain(sessionID string) []string {
	if b == nil {
		return nil
	}
	sessionID = strings.TrimSpace(sessionID)
	if sessionID == "" {
		return nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	items := b.m[sessionID]
	if len(items) == 0 {
		return nil
	}
	delete(b.m, sessionID)
	return items
}

// Peek returns a copy of the pending items without clearing. Used by
// /v1/sessions/:id/btw GET so the FE can show "you have N pending".
func (b *BtwQueue) Peek(sessionID string) []string {
	if b == nil {
		return nil
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	src := b.m[sessionID]
	if len(src) == 0 {
		return nil
	}
	out := make([]string, len(src))
	copy(out, src)
	return out
}

// FormatBtwInjectionText wraps one #btw text in the standard
// "[User added mid-response: …]" envelope. Used both by the
// claude-binary live-stdin sink (one JSONL line per /btw POST) and as
// the per-item formatter inside FormatBtwInjection (multi-item drain
// at tool-call boundaries on the direct-API path). Trims whitespace
// — empty input returns "" so callers can suppress the write.
func FormatBtwInjectionText(text string) string {
	text = strings.TrimSpace(text)
	if text == "" {
		return ""
	}
	return "[User added mid-response: " + text + "]"
}

// FormatBtwInjection composes the drained items into a single user-
// message body. Mirrors Node's formatBtwInjection in btw-queue.ts so
// the model sees the same wrapper text whether the turn ran on Node
// or Go.
func FormatBtwInjection(items []string) string {
	if len(items) == 0 {
		return ""
	}
	if len(items) == 1 {
		return "[User added mid-response: " + items[0] + "]"
	}
	var b strings.Builder
	for i, item := range items {
		if i > 0 {
			b.WriteByte('\n')
		}
		b.WriteString("[User added mid-response: ")
		b.WriteString(item)
		b.WriteByte(']')
	}
	return b.String()
}
