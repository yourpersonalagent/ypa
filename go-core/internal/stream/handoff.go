package stream

// Buffer handoff over a Unix socket on SIGUSR2 (§8.7 of GoCoreReport.md).
//
// Today's 30s drain on SIGUSR2 lets in-flight streams finish on the
// old binary; anything still mid-emit when the drain window closes is
// dropped. The FE reconnects after the new binary is up and
// `?fromSeq=N` recovers only what Node persisted via the live-message
// checkpoint. The handoff closes the seam for chunks that haven't been
// checkpointed yet: on SIGUSR2 the old binary streams the per-session
// tail of its SessionBuffer to the new binary via a Unix socket; the
// new binary applies each chunk to its own buffer so the FE's reattach
// `?fromSeq=N` lands on a complete state.
//
// Wire format — length-prefixed JSON frames. Each frame is a 4-byte
// big-endian length followed by a JSON payload of one of three shapes:
//
//	{"kind":"init","version":1,"fromPID":<int>,"drainTimeoutMs":<int>}
//	{"kind":"session_chunk","sessionId":"...","seq":<int64>,"chunk":<Chunk>}
//	{"kind":"complete","sessionsFlushed":<int>,"chunksTotal":<int>}
//
// Idempotency: chunks are immutable by (sessionID, seq). SessionBuffer
// dedupes on Append via seq comparison so a retried handoff (or a
// partial reconnect mid-handoff) is safe.

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"time"
)

// HandoffFrameKind identifies which payload shape a frame carries.
const (
	HandoffKindInit         = "init"
	HandoffKindSessionChunk = "session_chunk"
	HandoffKindComplete     = "complete"
)

// HandoffEnvVar is the env-var the new binary reads to learn where to
// listen and the old binary reads to learn where to dial. Format:
// /tmp/yha-handoff-<old-pid>.sock. Empty / unset disables the handoff.
const HandoffEnvVar = "YHA_HANDOFF_SOCKET"

// HandoffFrame is the wire payload — exactly one of Init / Chunk /
// Complete is populated, identified by Kind.
type HandoffFrame struct {
	Kind string `json:"kind"`

	Version        int   `json:"version,omitempty"`
	FromPID        int   `json:"fromPID,omitempty"`
	DrainTimeoutMs int64 `json:"drainTimeoutMs,omitempty"`

	SessionID string `json:"sessionId,omitempty"`
	Seq       int64  `json:"seq,omitempty"`
	Chunk     *Chunk `json:"chunk,omitempty"`

	SessionsFlushed int `json:"sessionsFlushed,omitempty"`
	ChunksTotal     int `json:"chunksTotal,omitempty"`
}

// SessionSnapshot is one session's tail returned by SessionBuffer.Snapshot.
// Chunks are in Seq-ascending order; FromSeq is the lowest Seq present so
// callers know how much of the session's history they hold.
type SessionSnapshot struct {
	SessionID string
	FromSeq   int64
	Chunks    []Chunk
}

// Snapshot returns a copy of every active session's buffered tail so the
// old binary can stream them to the new one on SIGUSR2. Sessions whose
// chunk slice is empty are omitted — there's nothing to hand over.
// The returned chunks are deep-copied (slice header + chunk-by-chunk)
// so the caller can mutate without racing the live buffer.
func (b *SessionBuffer) Snapshot() []SessionSnapshot {
	if b == nil {
		return nil
	}
	b.mu.RLock()
	ids := make([]string, 0, len(b.sessions))
	entries := make([]*bufferEntry, 0, len(b.sessions))
	for sid, e := range b.sessions {
		ids = append(ids, sid)
		entries = append(entries, e)
	}
	b.mu.RUnlock()

	out := make([]SessionSnapshot, 0, len(ids))
	for i, e := range entries {
		e.mu.Lock()
		if len(e.chunks) == 0 {
			e.mu.Unlock()
			continue
		}
		snap := SessionSnapshot{
			SessionID: ids[i],
			FromSeq:   e.chunks[0].Seq,
			Chunks:    make([]Chunk, len(e.chunks)),
		}
		copy(snap.Chunks, e.chunks)
		e.mu.Unlock()
		out = append(out, snap)
	}
	return out
}

// SendHandoff dials the configured Unix socket and streams every
// session's buffered tail across in a single connection. Returns the
// number of (sessions, chunks) flushed and any error. Caller is the
// old binary on SIGUSR2 — typically called just before
// srv.Shutdown(shutdownCtx) so chunks emitted during drain are
// captured too.
//
// socketPath is read from $YHA_HANDOFF_SOCKET when empty; an empty
// resolved path returns (0, 0, nil) without error so the handoff stays
// a no-op when not configured.
func SendHandoff(buf *SessionBuffer, socketPath string, drainTimeout time.Duration) (sessions, chunks int, err error) {
	if buf == nil {
		return 0, 0, nil
	}
	if socketPath == "" {
		socketPath = os.Getenv(HandoffEnvVar)
	}
	if socketPath == "" {
		return 0, 0, nil
	}
	conn, err := net.DialTimeout("unix", socketPath, 2*time.Second)
	if err != nil {
		return 0, 0, fmt.Errorf("handoff: dial %q: %w", socketPath, err)
	}
	defer conn.Close()

	deadline := time.Now().Add(drainTimeout + 5*time.Second)
	_ = conn.SetDeadline(deadline)

	if err := writeFrame(conn, HandoffFrame{
		Kind:           HandoffKindInit,
		Version:        1,
		FromPID:        os.Getpid(),
		DrainTimeoutMs: drainTimeout.Milliseconds(),
	}); err != nil {
		return 0, 0, fmt.Errorf("handoff: write init: %w", err)
	}

	snapshots := buf.Snapshot()
	for _, snap := range snapshots {
		for _, c := range snap.Chunks {
			cc := c
			if err := writeFrame(conn, HandoffFrame{
				Kind:      HandoffKindSessionChunk,
				SessionID: snap.SessionID,
				Seq:       c.Seq,
				Chunk:     &cc,
			}); err != nil {
				return sessions, chunks, fmt.Errorf("handoff: write session %q chunk %d: %w", snap.SessionID, c.Seq, err)
			}
			chunks++
		}
		sessions++
	}

	if err := writeFrame(conn, HandoffFrame{
		Kind:            HandoffKindComplete,
		SessionsFlushed: sessions,
		ChunksTotal:     chunks,
	}); err != nil {
		return sessions, chunks, fmt.Errorf("handoff: write complete: %w", err)
	}
	return sessions, chunks, nil
}

// ListenHandoff binds a Unix socket at socketPath and accepts a single
// handoff connection from the old binary, applying every SESSION_CHUNK
// to buf via buf.Append. Append preserves a non-zero Seq verbatim and
// reuses it as the high-water mark for any later NextSeq calls, so
// downstream live chunks remain monotonic on the new binary. Frames
// drain until HANDOFF_KIND_COMPLETE or EOF.
//
// The listener auto-cleans the socket file on close. socketPath
// resolves from $YHA_HANDOFF_SOCKET when empty; an empty resolved path
// is a no-op (no listener, no error).
//
// Returns the listener and a stop function. The caller (new binary on
// startup) typically:
//
//	stop, err := ListenHandoff(buf, "", logHandler)
//	defer stop()
//
// The actual accept happens in a goroutine — callers don't block.
func ListenHandoff(buf *SessionBuffer, socketPath string, onComplete func(sessions, chunks int)) (func(), error) {
	if buf == nil {
		return func() {}, nil
	}
	if socketPath == "" {
		socketPath = os.Getenv(HandoffEnvVar)
	}
	if socketPath == "" {
		return func() {}, nil
	}
	// Best-effort cleanup of a stale socket from a previous crash.
	_ = os.Remove(socketPath)
	l, err := net.Listen("unix", socketPath)
	if err != nil {
		return func() {}, fmt.Errorf("handoff: listen %q: %w", socketPath, err)
	}
	stop := func() {
		_ = l.Close()
		_ = os.Remove(socketPath)
	}
	go func() {
		conn, aerr := l.Accept()
		if aerr != nil {
			return
		}
		defer conn.Close()
		_ = conn.SetDeadline(time.Now().Add(2 * time.Minute))
		sessions, chunks := drainHandoff(conn, buf)
		if onComplete != nil {
			onComplete(sessions, chunks)
		}
	}()
	return stop, nil
}

// drainHandoff reads frames off conn until HANDOFF_KIND_COMPLETE or
// EOF. Returns the counts the COMPLETE frame reported (or what was
// observed locally on EOF).
func drainHandoff(r io.Reader, buf *SessionBuffer) (int, int) {
	sessions, chunks := 0, 0
	seenSessions := map[string]struct{}{}
	for {
		f, err := readFrame(r)
		if err != nil {
			return sessions, chunks
		}
		switch f.Kind {
		case HandoffKindInit:
			// Acknowledge implicitly — nothing to do until the chunks arrive.
		case HandoffKindSessionChunk:
			if f.Chunk != nil && f.SessionID != "" {
				buf.Append(f.SessionID, *f.Chunk)
				chunks++
				if _, ok := seenSessions[f.SessionID]; !ok {
					seenSessions[f.SessionID] = struct{}{}
					sessions++
				}
			}
		case HandoffKindComplete:
			if f.SessionsFlushed > 0 {
				sessions = f.SessionsFlushed
			}
			if f.ChunksTotal > 0 {
				chunks = f.ChunksTotal
			}
			return sessions, chunks
		}
	}
}

// writeFrame writes one length-prefixed JSON frame to w. 4-byte
// big-endian length followed by the payload. Errors propagate the
// caller's connection-level failure as-is.
func writeFrame(w io.Writer, f HandoffFrame) error {
	payload, err := json.Marshal(f)
	if err != nil {
		return err
	}
	var hdr [4]byte
	binary.BigEndian.PutUint32(hdr[:], uint32(len(payload)))
	if _, err := w.Write(hdr[:]); err != nil {
		return err
	}
	if _, err := w.Write(payload); err != nil {
		return err
	}
	return nil
}

// readFrame reads one length-prefixed JSON frame from r. Returns
// io.EOF when the stream is cleanly exhausted.
func readFrame(r io.Reader) (HandoffFrame, error) {
	var hdr [4]byte
	if _, err := io.ReadFull(r, hdr[:]); err != nil {
		if errors.Is(err, io.ErrUnexpectedEOF) {
			return HandoffFrame{}, io.EOF
		}
		return HandoffFrame{}, err
	}
	n := binary.BigEndian.Uint32(hdr[:])
	if n == 0 {
		return HandoffFrame{}, errors.New("handoff: zero-length frame")
	}
	const maxFrame = 4 * 1024 * 1024
	if n > maxFrame {
		return HandoffFrame{}, fmt.Errorf("handoff: frame too large (%d > %d)", n, maxFrame)
	}
	buf := make([]byte, n)
	if _, err := io.ReadFull(r, buf); err != nil {
		return HandoffFrame{}, err
	}
	var f HandoffFrame
	if err := json.Unmarshal(buf, &f); err != nil {
		return HandoffFrame{}, err
	}
	return f, nil
}
