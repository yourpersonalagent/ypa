package stream

import (
	"context"
	"net/http"
	"strconv"
	"time"
)

// reattachHandler serves SSE reconnects for the two paths
//
//	GET /v1/sessions/{id}/stream-direct[?fromSeq=N]
//	GET /v1/sessions/{id}/stream[?fromSeq=N]
//
// Both share this handler because the wire shape matches Node's
// /v1/sessions/:id/stream — same frame format (id:/data: pairs),
// same resume semantics. The `?fromSeq=N` is "last seq the client
// saw"; we replay strictly-greater. The handler is registered on the
// mux with Go 1.22+ method+path patterns, so {id} is read off via
// r.PathValue.
//
// Wire format mirrors the original /v1/stream-direct/ live stream:
// each SSE frame is `id: <seq>\ndata: <json-chunk>\n\n`. Browser-native
// EventSource auto-reconnect uses the `id:` line to populate the
// Last-Event-ID header on retry; FE-controlled reconnect uses the
// `?fromSeq=N` query string. Both are parsed.
func reattachHandler(deps RouteDeps) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		sessionID := r.PathValue("id")
		if sessionID == "" {
			http.NotFound(w, r)
			return
		}
		if deps.Buffer == nil {
			http.NotFound(w, r)
			return
		}

		// Parse the resume point. Last-Event-ID wins over ?fromSeq=N
		// because the browser-native EventSource sends it on every
		// retry without user-space involvement. Both numbers are
		// "last seen seq"; we replay strictly-greater (Seq > lastSeq).
		var lastSeq int64
		if h := r.Header.Get("Last-Event-ID"); h != "" {
			if n, err := strconv.ParseInt(h, 10, 64); err == nil {
				lastSeq = n
			}
		}
		if q := r.URL.Query().Get("fromSeq"); q != "" {
			if n, err := strconv.ParseInt(q, 10, 64); err == nil && n > lastSeq {
				lastSeq = n
			}
		}

		// Subscribe FIRST so any chunk arriving while we snapshot
		// the replay tail lands in our channel (it'll be deduped
		// against the replay by streamChunksToClient's maxSeq
		// tracking). Subscribing first also implicitly probes
		// "does this session exist" — Subscribe creates an entry
		// for unknown ids, so we use buffer.Has below to gate the
		// 404 instead.
		if !deps.Buffer.Has(sessionID) {
			http.Error(w, `{"error":"no stream"}`, http.StatusNotFound)
			return
		}
		ch, unsub := deps.Buffer.Subscribe(sessionID)
		defer unsub()

		// The Replay contract is Seq >= fromSeq, so to get
		// "strictly greater than lastSeq" we ask for lastSeq+1.
		chunks, _ := deps.Buffer.Replay(sessionID, lastSeq+1)

		// Open the SSE response.
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache, no-transform")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no")
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)
		if flusher != nil {
			flusher.Flush() // unblock client's header read
		}

		// Fan synthesized `_live` frames into the reattached stream so its
		// busy meta bar paints + keeps updating, then drain the merged
		// channel. No-op (returns ch unchanged) when the turn isn't live.
		live := mergeLiveMetaFrames(r.Context(), sessionID, ch)
		streamChunksToClient(r.Context(), w, flusher, live, chunks)
	}
}

// mergeLiveMetaFrames fans synthesized `_live` frames into a reattached
// stream. The originating POST handler pushes its per-turn `_live` frames —
// the model + tokens + tool/api counts the busy meta bar paints from —
// straight to its OWN pump channel, deliberately bypassing the replayable
// ring buffer so the ring doesn't bloat with per-second telemetry. The
// consequence: a reattached client (session switch or page reload) replays
// the buffered content but never sees a `_live` frame, so its meta bar goes
// dark until the terminal `_end`. That is the user-visible "the live message
// meta takes forever to reappear after switching chats" bug — worst on long
// harness turns (grok/codex/claude-binary) where `_end` is far away, but the
// same defect on the native direct-API route (both register the turn in the
// live registry and pump `_live` only to their own POST writer).
//
// The process-global live registry (livemeta.go) already carries every
// in-flight session's counters, refreshed each second by the same route
// tickers regardless of who is attached. So we synthesize `_live` frames for
// THIS reattached client straight from SnapshotLiveMeta: one immediately (so
// the bar repaints the instant replay ends, not a tick later) plus one per
// second until the turn finalizes (snapshot returns ok=false) or the client
// disconnects (ctx). Frames are Seq=0 so they bypass the pump's dedupe gate,
// exactly like the live POST's `_live` frames and the heartbeat. The FE
// reattach `_live` handler (chat-streaming.ts) folds them into the bar via the
// same lightweight, bar-only DOM patch it uses on the live path — no full
// bubble re-render on counter ticks.
//
// Returns the input channel untouched when the session isn't currently in the
// registry, so a finished-turn reattach keeps its plain replay-only path with
// zero added goroutines.
func mergeLiveMetaFrames(ctx context.Context, sessionID string, in <-chan Chunk) <-chan Chunk {
	if sessionID == "" {
		return in
	}
	if _, live := SnapshotLiveMeta(sessionID); !live {
		return in
	}
	// Buffered to match the live pump's pumpCh: a synthesized frame must
	// never block the content forwarder below on a momentarily slow client.
	out := make(chan Chunk, 1024)
	go func() {
		defer close(out)
		ticker := time.NewTicker(1 * time.Second)
		defer ticker.Stop()
		// snapshotFrame returns the current registry snapshot as a `_live`
		// chunk. The registry's InputTokens is already cache-folded and it
		// carries no separate cache fields, which is exactly what the FE
		// reattach handler expects (it folds input + cacheRead + cacheCreation,
		// the latter two zero here). ok=false means the turn finalized — stop
		// synthesizing; the terminal `_end` still flows through `in`.
		snapshotFrame := func() (Chunk, bool) {
			snap, ok := SnapshotLiveMeta(sessionID)
			if !ok {
				return Chunk{}, false
			}
			return Chunk{
				Live:          true,
				Model:         snap.Model,
				InputTokens:   snap.InputTokens,
				OutputTokens:  snap.OutputTokens,
				ToolCallCount: snap.ToolCallCount,
				APICallCount:  snap.APICallCount,
			}, true
		}
		if c, ok := snapshotFrame(); ok {
			select {
			case out <- c:
			case <-ctx.Done():
				return
			}
		}
		for {
			select {
			case <-ctx.Done():
				return
			case c, ok := <-in:
				if !ok {
					return
				}
				select {
				case out <- c:
				case <-ctx.Done():
					return
				}
			case <-ticker.C:
				if c, ok := snapshotFrame(); ok {
					select {
					case out <- c:
					case <-ctx.Done():
						return
					}
				}
			}
		}
	}()
	return out
}
