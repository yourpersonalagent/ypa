// harness_test.go — unit tests for the Harness contract adapter.

package hermes

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/yha/core/internal/harness"
	"github.com/yha/core/internal/stream"
)

func TestHarnessStreamEmitsDeltasAndDone(t *testing.T) {
	s := newServer(t)
	s.drive(func(req map[string]any) map[string]any {
		switch req["method"] {
		case "session.create":
			return map[string]any{"result": map[string]any{"session_id": "h-99"}}
		default:
			return map[string]any{"result": map[string]any{}}
		}
	})

	h := New(s.gw, nil)

	var (
		mu     sync.Mutex
		chunks []stream.Chunk
	)
	emit := func(c stream.Chunk) {
		mu.Lock()
		defer mu.Unlock()
		cp := c
		chunks = append(chunks, cp)
	}

	type result struct {
		res harness.Result
		err error
	}
	out := make(chan result, 1)
	go func() {
		res, err := h.Stream(context.Background(), harness.Request{
			SessionID: "yha-X",
			Model:     "hermes-3",
			Input:     "hi",
			BroadcastEmp: &harness.EmployeeMeta{
				ID:          "hermes",
				PartnerType: "hermes",
				PartnerID:   "p-1",
			},
		}, emit)
		out <- result{res, err}
	}()

	// Allow subscribe before emitting.
	time.Sleep(50 * time.Millisecond)
	ps := &promptScript{t: t, server: s, sessionID: "h-99"}
	ps.emit(map[string]any{"type": "message.delta", "payload": map[string]any{"text": "Hi "}})
	ps.emit(map[string]any{"type": "message.delta", "payload": map[string]any{"text": "there"}})
	ps.emit(map[string]any{"type": "message.complete", "payload": map[string]any{"text": "Hi there", "status": "complete"}})

	select {
	case got := <-out:
		if got.err != nil {
			t.Fatalf("Stream err: %v", got.err)
		}
		if got.res.Text != "Hi there" {
			t.Errorf("Result.Text: got %q", got.res.Text)
		}
		if got.res.StopReason != "complete" {
			t.Errorf("StopReason: got %q", got.res.StopReason)
		}
		if got.res.Usage.Model != "hermes-3" {
			t.Errorf("Usage.Model: got %q", got.res.Usage.Model)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("Stream did not return")
	}

	mu.Lock()
	defer mu.Unlock()
	var deltaCount, doneCount int
	var lastDone stream.Chunk
	for _, c := range chunks {
		switch c.Type {
		case stream.ChunkTypeDelta:
			deltaCount++
		case stream.ChunkTypeDone:
			doneCount++
			lastDone = c
		}
	}
	if deltaCount != 2 {
		t.Errorf("delta chunk count: got %d, want 2", deltaCount)
	}
	if doneCount != 1 {
		t.Errorf("done chunk count: got %d, want 1", doneCount)
	}
	if lastDone.Provider != "hermes" {
		t.Errorf("done.Provider: got %q, want hermes", lastDone.Provider)
	}
	if lastDone.Text != "Hi there" {
		t.Errorf("done.Text: got %q", lastDone.Text)
	}
}

func TestHarnessStreamRequiresPartnerID(t *testing.T) {
	gw := NewGateway(nil) // unstarted; we never reach the gateway.
	h := New(gw, nil)
	_, err := h.Stream(context.Background(), harness.Request{
		SessionID: "yha",
		Input:     "hi",
		// BroadcastEmp omitted — should be rejected at the contract boundary.
	}, func(stream.Chunk) {})
	if err == nil || !strings.Contains(err.Error(), "PartnerID") {
		t.Fatalf("want PartnerID error, got %v", err)
	}
}

func TestHarnessStreamFallsBackToBroadcastEmpID(t *testing.T) {
	s := newServer(t)
	s.drive(func(req map[string]any) map[string]any {
		switch req["method"] {
		case "session.create":
			return map[string]any{"result": map[string]any{"session_id": "h-id-fallback"}}
		default:
			return map[string]any{"result": map[string]any{}}
		}
	})
	h := New(s.gw, nil)

	type result struct {
		res harness.Result
		err error
	}
	out := make(chan result, 1)
	go func() {
		res, err := h.Stream(context.Background(), harness.Request{
			SessionID: "yha",
			Model:     "hermes-3",
			Input:     "hi",
			BroadcastEmp: &harness.EmployeeMeta{
				ID: "hermes-emp",
				// PartnerID intentionally empty — resolvePartnerID falls back to ID.
			},
		}, func(stream.Chunk) {})
		out <- result{res, err}
	}()
	time.Sleep(50 * time.Millisecond)
	ps := &promptScript{t: t, server: s, sessionID: "h-id-fallback"}
	ps.emit(map[string]any{"type": "message.complete", "payload": map[string]any{"text": "ok"}})

	select {
	case got := <-out:
		if got.err != nil {
			t.Fatalf("Stream err: %v", got.err)
		}
		if got.res.Text != "ok" {
			t.Errorf("Text: got %q", got.res.Text)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Stream did not return")
	}
}

func TestHarnessStreamSurfacesErrorEventAsChunk(t *testing.T) {
	s := newServer(t)
	s.drive(func(req map[string]any) map[string]any {
		switch req["method"] {
		case "session.create":
			return map[string]any{"result": map[string]any{"session_id": "h-bad"}}
		default:
			return map[string]any{"result": map[string]any{}}
		}
	})
	h := New(s.gw, nil)

	var (
		mu        sync.Mutex
		errChunks []string
	)
	emit := func(c stream.Chunk) {
		if c.Type == stream.ChunkTypeError {
			mu.Lock()
			errChunks = append(errChunks, c.Error)
			mu.Unlock()
		}
	}

	out := make(chan error, 1)
	go func() {
		_, err := h.Stream(context.Background(), harness.Request{
			SessionID:    "yha",
			Input:        "hi",
			BroadcastEmp: &harness.EmployeeMeta{PartnerID: "p"},
		}, emit)
		out <- err
	}()
	time.Sleep(50 * time.Millisecond)
	ps := &promptScript{t: t, server: s, sessionID: "h-bad"}
	ps.emit(map[string]any{"type": "error", "payload": map[string]any{"message": "kaboom"}})

	select {
	case err := <-out:
		if err == nil || !strings.Contains(err.Error(), "kaboom") {
			t.Fatalf("want kaboom error, got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Stream did not return after error")
	}
	mu.Lock()
	defer mu.Unlock()
	if len(errChunks) != 1 || !strings.Contains(errChunks[0], "kaboom") {
		t.Errorf("want one error chunk, got %v", errChunks)
	}
}

func TestHarnessStreamRequiresEmit(t *testing.T) {
	gw := NewGateway(nil)
	h := New(gw, nil)
	_, err := h.Stream(context.Background(), harness.Request{
		Input:        "hi",
		BroadcastEmp: &harness.EmployeeMeta{PartnerID: "p"},
	}, nil)
	if err == nil || !strings.Contains(err.Error(), "emit") {
		t.Fatalf("want emit error, got %v", err)
	}
}

func TestHarnessIDIsHermes(t *testing.T) {
	h := New(NewGateway(nil), nil)
	if h.ID() != HarnessID || h.ID() != "hermes" {
		t.Errorf("ID: got %q", h.ID())
	}
}

// Compile-time check that the New() return value can be used at the
// same boundary the wiring agent will use it on.
func TestHarnessSatisfiesContract(t *testing.T) {
	var _ harness.Harness = New(NewGateway(nil), nil)
}

// Sanity check on Gateway() / Sessions() accessor wiring.
func TestHarnessExposesGatewayAndSessions(t *testing.T) {
	gw := NewGateway(nil)
	h := New(gw, nil)
	if h.Gateway() != gw {
		t.Errorf("Gateway() accessor mismatch")
	}
	if h.Sessions() == nil {
		t.Errorf("Sessions() should return a manager")
	}
}

// Defensive: ensure NewDefault works with a nil logger.
func TestNewDefaultBuildsGateway(t *testing.T) {
	gw := NewDefault("/tmp/bridge", nil)
	if gw == nil {
		t.Fatal("NewDefault returned nil")
	}
	if gw.IsRunning() {
		t.Errorf("NewDefault should not auto-start the gateway")
	}
}

// Sanity: errors package is referenced (avoid unused import).
var _ = errors.New
