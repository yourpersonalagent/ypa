package harness

import (
	"context"
	"sync"
	"testing"

	"github.com/yha/core/internal/stream"
)

// stubHarness is a minimal Harness implementation used by registry
// tests. Records the ID and (optionally) the last seen Request so
// tests can assert on what was dispatched.
type stubHarness struct {
	id     string
	mu     sync.Mutex
	lastIn *Request
}

func (s *stubHarness) ID() string { return s.id }
func (s *stubHarness) Stream(_ context.Context, req Request, _ Emit) (Result, error) {
	s.mu.Lock()
	r := req
	s.lastIn = &r
	s.mu.Unlock()
	return Result{}, nil
}

func TestRegistryRegisterLookup(t *testing.T) {
	r := NewRegistry()
	if r.Len() != 0 {
		t.Fatalf("fresh registry should be empty, got %d", r.Len())
	}
	h := &stubHarness{id: "claude-binary"}
	r.Register(h)
	if got := r.Lookup("claude-binary"); got != h {
		t.Errorf("Lookup(claude-binary) = %v, want %v", got, h)
	}
	if got := r.Lookup("missing"); got != nil {
		t.Errorf("Lookup(missing) = %v, want nil", got)
	}
}

func TestRegistryNilSafe(t *testing.T) {
	var r *Registry
	// Each of these must not panic on a nil receiver.
	r.Register(&stubHarness{id: "x"})
	if got := r.Lookup("x"); got != nil {
		t.Errorf("nil registry Lookup should be nil, got %v", got)
	}
	if got := r.Len(); got != 0 {
		t.Errorf("nil registry Len = %d, want 0", got)
	}
	if got := r.Pick(&RequestView{Model: "claude-x"}, nil); got != nil {
		t.Errorf("nil registry Pick should be nil, got %v", got)
	}
}

func TestRegistryRegisterIgnoresEmptyID(t *testing.T) {
	r := NewRegistry()
	r.Register(&stubHarness{id: ""})
	if r.Len() != 0 {
		t.Errorf("empty-id register should be ignored, got len %d", r.Len())
	}
	r.Register(nil)
	if r.Len() != 0 {
		t.Errorf("nil register should be ignored, got len %d", r.Len())
	}
}

func TestRegistryRegisterOverwrites(t *testing.T) {
	r := NewRegistry()
	first := &stubHarness{id: "claude-binary"}
	second := &stubHarness{id: "claude-binary"}
	r.Register(first)
	r.Register(second)
	if got := r.Lookup("claude-binary"); got != second {
		t.Errorf("expected second registration to win, got %v", got)
	}
}

func TestRegistryPickClaudeBinary(t *testing.T) {
	r := NewRegistry()
	h := &stubHarness{id: "claude-binary"}
	r.Register(h)
	view := &RequestView{Model: "claude-opus-4-7"}
	if got := r.Pick(view, nil); got != h {
		t.Errorf("Pick(claude-opus-4-7) = %v, want %v", got, h)
	}
}

func TestRegistryPickClaudeAliasPrefixes(t *testing.T) {
	r := NewRegistry()
	h := &stubHarness{id: "claude-binary"}
	r.Register(h)
	// All these claude-prefix variants should resolve.
	for _, m := range []string{"claude-opus-4-7", "claude-haiku-4-5", "claude/opus", "Claude-Sonnet-4-5"} {
		if got := r.Pick(&RequestView{Model: m}, nil); got != h {
			t.Errorf("Pick(%q) = %v, want claude-binary", m, got)
		}
	}
}

func TestRegistryPickRejectsCodexInstance(t *testing.T) {
	r := NewRegistry()
	r.Register(&stubHarness{id: "claude-binary"})
	view := &RequestView{Model: "claude-opus-4-7", CodexInstance: "cdx-1"}
	if got := r.Pick(view, nil); got != nil {
		t.Errorf("CodexInstance pinned should defeat claude-binary pick, got %v", got)
	}
}

func TestRegistryPickNonClaudeModel(t *testing.T) {
	r := NewRegistry()
	r.Register(&stubHarness{id: "claude-binary"})
	for _, m := range []string{"gpt-4o", "codex/gpt-5", "gemini-2-pro", "random-thing"} {
		if got := r.Pick(&RequestView{Model: m}, nil); got != nil {
			t.Errorf("Pick(%q) = %v, want nil", m, got)
		}
	}
}

func TestRegistryPickNilView(t *testing.T) {
	r := NewRegistry()
	r.Register(&stubHarness{id: "claude-binary"})
	if got := r.Pick(nil, nil); got != nil {
		t.Errorf("Pick(nil) = %v, want nil", got)
	}
}

func TestRegistryConcurrentAccess(t *testing.T) {
	r := NewRegistry()
	r.Register(&stubHarness{id: "claude-binary"})

	var wg sync.WaitGroup
	for i := 0; i < 32; i++ {
		wg.Add(2)
		go func() {
			defer wg.Done()
			_ = r.Lookup("claude-binary")
		}()
		go func() {
			defer wg.Done()
			_ = r.Pick(&RequestView{Model: "claude-opus-4-7"}, nil)
		}()
	}
	wg.Wait()
}

func TestAdaptEmitWithNilBuffer(t *testing.T) {
	var captured []stream.Chunk
	emit := AdaptEmit(nil, "sid-1", func(c stream.Chunk) {
		captured = append(captured, c)
	})
	emit(stream.Chunk{Type: stream.ChunkTypeDelta, Delta: "hi"})
	if len(captured) != 1 || captured[0].Delta != "hi" {
		t.Errorf("captured = %+v, want one delta 'hi'", captured)
	}
}

func TestAdaptEmitStampsSeqViaBuffer(t *testing.T) {
	buf := stream.NewSessionBuffer()
	var captured []stream.Chunk
	emit := AdaptEmit(buf, "sid-x", func(c stream.Chunk) {
		captured = append(captured, c)
	})
	emit(stream.Chunk{Type: stream.ChunkTypeDelta, Delta: "one"})
	emit(stream.Chunk{Type: stream.ChunkTypeDelta, Delta: "two"})
	if len(captured) != 2 {
		t.Fatalf("captured len = %d, want 2", len(captured))
	}
	if captured[0].Seq == 0 || captured[1].Seq == 0 {
		t.Errorf("expected non-zero seq, got %+v", captured)
	}
	if captured[1].Seq <= captured[0].Seq {
		t.Errorf("seq should be monotonic, got %d → %d", captured[0].Seq, captured[1].Seq)
	}
	// Replay confirms the buffer remembered the same chunks.
	replayed, ok := buf.Replay("sid-x", 0)
	if !ok || len(replayed) != 2 {
		t.Errorf("replay miss or wrong len: ok=%v len=%d", ok, len(replayed))
	}
}

func TestAdaptEmitEmptySessionSkipsBuffer(t *testing.T) {
	buf := stream.NewSessionBuffer()
	var captured []stream.Chunk
	emit := AdaptEmit(buf, "", func(c stream.Chunk) {
		captured = append(captured, c)
	})
	emit(stream.Chunk{Type: stream.ChunkTypeDelta, Delta: "x"})
	if len(captured) != 1 {
		t.Fatalf("captured len = %d, want 1", len(captured))
	}
	if captured[0].Seq != 0 {
		t.Errorf("empty sid should not stamp seq, got %d", captured[0].Seq)
	}
	// Buffer shouldn't have any session.
	if buf.Len() != 0 {
		t.Errorf("buffer len = %d, want 0", buf.Len())
	}
}

func TestAdaptEmitNilWriteIsSafe(t *testing.T) {
	emit := AdaptEmit(nil, "", nil)
	// Should not panic.
	emit(stream.Chunk{Type: stream.ChunkTypeDone})
}
