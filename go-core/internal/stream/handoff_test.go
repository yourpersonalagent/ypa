package stream

import (
	"path/filepath"
	"testing"
	"time"
)

// TestHandoffRoundTrip verifies the SendHandoff / ListenHandoff
// roundtrip: a sender-side SessionBuffer with two sessions hands its
// tail to a receiver-side empty buffer, and the receiver ends up
// with the same per-session chunk slices keyed by seq.
func TestHandoffRoundTrip(t *testing.T) {
	socket := filepath.Join(t.TempDir(), "handoff.sock")

	src := NewSessionBuffer()
	dst := NewSessionBuffer()

	src.Append("alpha", Chunk{Type: ChunkTypeText, Text: "hello", Seq: 1})
	src.Append("alpha", Chunk{Type: ChunkTypeText, Text: "world", Seq: 2})
	src.Append("beta", Chunk{Type: ChunkTypeText, Text: "lonely", Seq: 1})

	completeCh := make(chan struct {
		sessions, chunks int
	}, 1)
	stop, err := ListenHandoff(dst, socket, func(sessions, chunks int) {
		completeCh <- struct{ sessions, chunks int }{sessions, chunks}
	})
	if err != nil {
		t.Fatalf("ListenHandoff: %v", err)
	}
	defer stop()

	// Give the listener a tick to bind. Net.Listen is synchronous so
	// this is paranoia, not necessity.
	time.Sleep(20 * time.Millisecond)

	sessions, chunks, sendErr := SendHandoff(src, socket, 2*time.Second)
	if sendErr != nil {
		t.Fatalf("SendHandoff: %v", sendErr)
	}
	if sessions != 2 || chunks != 3 {
		t.Fatalf("send counts: sessions=%d chunks=%d, want 2,3", sessions, chunks)
	}

	select {
	case result := <-completeCh:
		if result.sessions != 2 || result.chunks != 3 {
			t.Errorf("receive counts: sessions=%d chunks=%d, want 2,3", result.sessions, result.chunks)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("listener did not complete within 2s")
	}

	gotA, _ := dst.Replay("alpha", 0)
	if len(gotA) != 2 || gotA[0].Text != "hello" || gotA[1].Text != "world" {
		t.Errorf("alpha replay = %+v", gotA)
	}
	gotB, _ := dst.Replay("beta", 0)
	if len(gotB) != 1 || gotB[0].Text != "lonely" {
		t.Errorf("beta replay = %+v", gotB)
	}
}

// TestHandoffNilBufferIsNoop verifies SendHandoff returns gracefully
// when the buffer is nil — the caller should never crash on a
// pre-config / test path.
func TestHandoffNilBufferIsNoop(t *testing.T) {
	sessions, chunks, err := SendHandoff(nil, "/tmp/does-not-matter", time.Second)
	if err != nil || sessions != 0 || chunks != 0 {
		t.Errorf("nil buffer: got (%d,%d,%v), want (0,0,nil)", sessions, chunks, err)
	}
	stop, err := ListenHandoff(nil, "/tmp/does-not-matter", nil)
	if err != nil {
		t.Errorf("nil listen: %v", err)
	}
	if stop == nil {
		t.Error("nil listen returned nil stop func")
	}
	stop()
}

// TestHandoffEmptySocketIsNoop verifies an empty resolved socket path
// skips the operation entirely (no error, no work). This is the
// default operator experience — YHA_HANDOFF_SOCKET unset.
func TestHandoffEmptySocketIsNoop(t *testing.T) {
	buf := NewSessionBuffer()
	buf.Append("x", Chunk{Text: "y", Seq: 1})
	sessions, chunks, err := SendHandoff(buf, "", time.Second)
	if err != nil || sessions != 0 || chunks != 0 {
		t.Errorf("empty socket: got (%d,%d,%v), want (0,0,nil)", sessions, chunks, err)
	}
}
