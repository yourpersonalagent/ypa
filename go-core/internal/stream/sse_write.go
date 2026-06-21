package stream

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"
)

// sseWriteDeadline caps how long a single SSE frame write may block.
// Background: when the FE / browser / intermediate proxy stops
// reading, the kernel TCP buffer fills and http.ResponseWriter.Write
// blocks indefinitely. The emit closure holds emitMu while writing,
// so a stuck write would also stall the heartbeat goroutine + every
// subsequent emit — net effect: the FE stops seeing chunks for
// minutes even though the model is still producing them. With a
// deadline we treat the slow client as gone, flip responseDone, and
// let chunks keep flowing into the reattach buffer. The FE can then
// recover via GET /v1/sessions/:id/stream-direct?fromSeq=N.
//
// 30 s is generous enough to absorb tailscale/tunnel buffering + the
// FE's per-chunk render path without false-positive tripping (the
// previous 5 s ceiling fired any time a backgrounded browser tab or
// tunneled connection paused TCP reads briefly, which froze the
// stream until the FE's 15 s silence-watchdog eventually triggered
// a reconnect — user-visible as "live updates stop after the first
// few chunks"). The FE's own watchdog still fires before this if
// the client genuinely vanishes; this deadline only protects against
// a truly stuck consumer.
const sseWriteDeadline = 30 * time.Second

// writeSSEFrame writes one SSE frame (id + data lines + flush) under
// a write deadline. Returns true on success, false on timeout / write
// error — callers should mark the response as done and stop touching
// the writer. Holding emitMu across this call is the caller's
// responsibility (we never write from concurrent goroutines).
func writeSSEFrame(w http.ResponseWriter, flusher http.Flusher, seq int64, payload []byte) bool {
	rc := http.NewResponseController(w)
	// Best-effort deadline. Errors are non-fatal — some test/mocks
	// don't support SetWriteDeadline, fall through unsuppressed.
	_ = rc.SetWriteDeadline(time.Now().Add(sseWriteDeadline))
	defer rc.SetWriteDeadline(time.Time{})

	if seq > 0 {
		if _, err := fmt.Fprintf(w, "id: %d\n", seq); err != nil {
			return false
		}
	}
	if _, err := fmt.Fprintf(w, "data: %s\n\n", payload); err != nil {
		return false
	}
	if flusher != nil {
		flusher.Flush()
	}
	return true
}

// writeSSERaw writes a fully-formed SSE frame (caller-supplied bytes,
// must end with "\n\n") under the same deadline as writeSSEFrame. Used
// by the heartbeat path which pre-formats its own `data: {"_hb":...}`
// frame to keep it a single-key payload the FE recognises.
func writeSSERaw(w http.ResponseWriter, flusher http.Flusher, frame []byte) bool {
	rc := http.NewResponseController(w)
	_ = rc.SetWriteDeadline(time.Now().Add(sseWriteDeadline))
	defer rc.SetWriteDeadline(time.Time{})
	if _, err := w.Write(frame); err != nil {
		return false
	}
	if flusher != nil {
		flusher.Flush()
	}
	return true
}

// writeChunkFrame serialises one Chunk and writes the SSE frame. Skips
// stamping the `id:` line for unstamped (Seq=0) chunks like heartbeats
// and the replay-end marker. Returns false on JSON-marshal or write
// failure — caller should stop streaming on false.
func writeChunkFrame(w http.ResponseWriter, flusher http.Flusher, c Chunk) bool {
	// Reuse the bytes the buffer marshalled once at fan-out (C7). Only
	// chunks built outside SessionBuffer.Append (the replay-end marker,
	// any direct-emit path) arrive without a cached payload and marshal here.
	payload := c.payload
	if payload == nil {
		var err error
		payload, err = json.Marshal(c)
		if err != nil {
			return true // skip the bad chunk, keep streaming
		}
	}
	return writeSSEFrame(w, flusher, c.Seq, payload)
}

// streamChunksToClient is the shared "pump" that backs both the live
// POST handler and the GET reattach handler. Both flows are equivalent
// from the SSE wire's perspective: subscribe to the buffer, write each
// chunk to the response, inject heartbeats so the FE silence-watchdog
// stays quiet, exit on _end / write fail / ctx done.
//
// The unified pump is the architectural fix the user asked for: the
// POST handler is no longer a "primary" writer that owns emitMu and
// poisons the stream on a single failed write. Both POST and reattach
// are equal listeners; the adapter just calls Buffer.Append and trusts
// the pump to deliver. A slow tunneled FE filling the kernel TCP
// buffer no longer stops the adapter — it only slows down this one
// listener; other listeners (reattach) keep flowing, and when the
// FE silence-watchdog finally fires, it reconnects against the ring
// buffer and replays the missed tail.
//
// initialReplay is non-nil for the reattach path — the buffer's tail
// snapshot at the moment of subscription. Live POST passes nil. After
// drainage we emit a `{_replay_end:true}` marker so the FE flips
// inReplay=false and renders accumulated state eagerly even when no
// terminal `_end` has been seen yet.
//
// Exits when:
//   - ctx fires (client disconnected, handler returning)
//   - a write fails (kernel returned EPIPE / TCP reset / timeout)
//   - the subscriber channel closes (Drop / LRU eviction)
//   - a chunk with End:true is observed (terminal — caller should
//     close the response and unwind)
//
// Heartbeat cadence (10 s) matches the FE silence-watchdog (15 s) so a
// healthy connection never trips the watchdog. Heartbeats are written
// raw with no Seq so the FE's `Object.keys(parsed).length === 1`
// heartbeat-detection check passes.
func streamChunksToClient(
	ctx context.Context,
	w http.ResponseWriter,
	flusher http.Flusher,
	ch <-chan Chunk,
	initialReplay []Chunk,
) {
	// maxSeq tracks the highest Seq we've delivered so a chunk
	// arriving on the live channel that was already in the replay
	// snapshot (race window: Append fires between Subscribe and
	// Replay) doesn't get written twice.
	var maxSeq int64

	// Replay buffered tail first (reattach path). Stops on any
	// write failure — the client is presumed gone.
	for _, c := range initialReplay {
		if !writeChunkFrame(w, flusher, c) {
			return
		}
		if c.Seq > maxSeq {
			maxSeq = c.Seq
		}
	}
	if initialReplay != nil {
		// Replay-end marker so the FE can flush its accumulated
		// blocks before live chunks start arriving. See
		// chat-streaming.ts:1671 — inReplay=true gates per-chunk
		// scheduleRender during catch-up, this flips it false.
		if !writeChunkFrame(w, flusher, Chunk{ReplayEnd: true}) {
			return
		}
	}

	hbTicker := time.NewTicker(10 * time.Second)
	defer hbTicker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-hbTicker.C:
			frame := fmt.Appendf(nil, "data: {\"_hb\":%d}\n\n", time.Now().UnixMilli())
			if !writeSSERaw(w, flusher, frame) {
				return
			}
		case c, ok := <-ch:
			if !ok {
				return
			}
			// Dedupe against the replay tail + any prior live
			// delivery. Stamped chunks have monotonic Seq; an
			// unstamped chunk (Seq == 0, e.g. heartbeat sourced
			// through the buffer or replay-end marker) bypasses
			// the gate.
			if c.Seq != 0 && c.Seq <= maxSeq {
				continue
			}
			if !writeChunkFrame(w, flusher, c) {
				return
			}
			if c.Seq > maxSeq {
				maxSeq = c.Seq
			}
			if c.End {
				// Terminal chunk delivered. Returning closes the
				// response so the FE's reader.read() sees EOF and
				// finalizeSegment fires.
				return
			}
		}
	}
}
