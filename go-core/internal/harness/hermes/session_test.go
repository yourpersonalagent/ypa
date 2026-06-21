// session_test.go — unit tests for SessionManager.

package hermes

import (
	"context"
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"
)

// fakeServer drives a gateway's stdin/stdout pipes against a small
// scripted RPC handler. Each test sets a handler closure that is
// called once per client request.
type fakeServer struct {
	t  *testing.T
	gw *Gateway
	ft *fakeTransport

	createCount atomic.Int64
}

// drive launches the server-side request handler. The handler runs in
// a goroutine and exits when the transport is killed.
func (s *fakeServer) drive(handler func(req map[string]any) map[string]any) {
	go func() {
		for {
			req, err := s.ft.readClientFrame()
			if err != nil {
				return
			}
			resp := handler(req)
			if resp == nil {
				continue
			}
			id := req["id"]
			resp["id"] = id
			resp["jsonrpc"] = "2.0"
			if err := s.ft.writeServerFrame(resp); err != nil {
				return
			}
		}
	}()
}

func newServer(t *testing.T) *fakeServer {
	gw, ft := startGatewayWithFake(t)
	t.Cleanup(func() { _ = gw.Stop() })
	return &fakeServer{t: t, gw: gw, ft: ft}
}

func TestSessionGetOrCreateCachesResult(t *testing.T) {
	s := newServer(t)
	s.drive(func(req map[string]any) map[string]any {
		switch req["method"] {
		case "session.create":
			s.createCount.Add(1)
			return map[string]any{"result": map[string]any{"session_id": "h-1"}}
		default:
			return map[string]any{"result": map[string]any{}}
		}
	})

	mgr := NewSessionManager(s.gw)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()

	id1, err := mgr.GetOrCreate(ctx, "yha-1", "p-A", Presets{})
	if err != nil {
		t.Fatalf("first GetOrCreate: %v", err)
	}
	if id1 != "h-1" {
		t.Fatalf("want h-1, got %q", id1)
	}

	id2, err := mgr.GetOrCreate(ctx, "yha-1", "p-A", Presets{})
	if err != nil {
		t.Fatalf("second GetOrCreate: %v", err)
	}
	if id2 != "h-1" {
		t.Errorf("cache miss: want h-1, got %q", id2)
	}
	if got := s.createCount.Load(); got != 1 {
		t.Errorf("session.create should fire once; fired %d times", got)
	}
}

func TestSessionGetOrCreateIndependentPartners(t *testing.T) {
	s := newServer(t)
	var next atomic.Int64
	s.drive(func(req map[string]any) map[string]any {
		if req["method"] == "session.create" {
			n := next.Add(1)
			return map[string]any{"result": map[string]any{"session_id": "h-" + strFromFloat(float64(n))}}
		}
		return map[string]any{"result": map[string]any{}}
	})

	mgr := NewSessionManager(s.gw)
	ctx := context.Background()

	a, err := mgr.GetOrCreate(ctx, "yha-1", "p-A", Presets{})
	if err != nil {
		t.Fatalf("A: %v", err)
	}
	b, err := mgr.GetOrCreate(ctx, "yha-1", "p-B", Presets{})
	if err != nil {
		t.Fatalf("B: %v", err)
	}
	if a == b {
		t.Errorf("expected distinct hermes ids for distinct partner slots: %q == %q", a, b)
	}
}

func TestSessionGetOrCreateQueuesSystemPrompt(t *testing.T) {
	s := newServer(t)
	s.drive(func(req map[string]any) map[string]any {
		switch req["method"] {
		case "session.create":
			return map[string]any{"result": map[string]any{"session_id": "h-9"}}
		default:
			return map[string]any{"result": map[string]any{}}
		}
	})

	mgr := NewSessionManager(s.gw)
	_, err := mgr.GetOrCreate(context.Background(), "yha", "p", Presets{SystemPrompt: "be terse"})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	prompt, ok := mgr.TakePendingSysPrompt("h-9")
	if !ok || prompt != "be terse" {
		t.Errorf("expected queued persona, got (%q, %v)", prompt, ok)
	}
	// Second take should be empty.
	if _, ok := mgr.TakePendingSysPrompt("h-9"); ok {
		t.Errorf("queued persona should drain on first take")
	}
}

func TestSessionDropRemovesEntry(t *testing.T) {
	s := newServer(t)
	closed := make(chan map[string]any, 1)
	s.drive(func(req map[string]any) map[string]any {
		switch req["method"] {
		case "session.create":
			return map[string]any{"result": map[string]any{"session_id": "h-x"}}
		case "session.close":
			closed <- req
			return map[string]any{"result": map[string]any{}}
		}
		return map[string]any{"result": map[string]any{}}
	})

	mgr := NewSessionManager(s.gw)
	if _, err := mgr.GetOrCreate(context.Background(), "yha", "p", Presets{}); err != nil {
		t.Fatalf("create: %v", err)
	}
	if mgr.Count() != 1 {
		t.Fatalf("count: want 1, got %d", mgr.Count())
	}

	mgr.Drop("yha", "p")
	if mgr.Count() != 0 {
		t.Errorf("count after Drop: want 0, got %d", mgr.Count())
	}

	select {
	case req := <-closed:
		params, _ := req["params"].(map[string]any)
		if params["session_id"] != "h-x" {
			t.Errorf("close session id: got %v", params["session_id"])
		}
	case <-time.After(time.Second):
		t.Fatal("session.close not invoked after Drop")
	}
}

func TestSessionGetOrCreateAppliesModelBestEffort(t *testing.T) {
	s := newServer(t)
	slashCalled := make(chan map[string]any, 1)
	s.drive(func(req map[string]any) map[string]any {
		switch req["method"] {
		case "session.create":
			return map[string]any{"result": map[string]any{"session_id": "h-m"}}
		case "slash.exec":
			slashCalled <- req
			return map[string]any{"result": map[string]any{}}
		}
		return map[string]any{"result": map[string]any{}}
	})

	mgr := NewSessionManager(s.gw)
	if _, err := mgr.GetOrCreate(context.Background(), "yha", "p", Presets{Model: "hermes-3"}); err != nil {
		t.Fatalf("create: %v", err)
	}
	select {
	case req := <-slashCalled:
		params, _ := req["params"].(map[string]any)
		cmd, _ := params["command"].(string)
		if cmd != "/model hermes-3" {
			t.Errorf("slash command: got %q", cmd)
		}
	case <-time.After(time.Second):
		t.Fatal("slash.exec not invoked for model preset")
	}
}

// Round-trip helper: makes sure json package is used (avoid unused
// import) and asserts a tiny shape contract.
func TestSessionDropIgnoresMissingKey(t *testing.T) {
	s := newServer(t)
	s.drive(func(req map[string]any) map[string]any {
		return map[string]any{"result": map[string]any{}}
	})
	mgr := NewSessionManager(s.gw)
	// Drop without any prior create — should be a no-op, no panic.
	mgr.Drop("nope", "")
	// Light sanity check that nothing slipped through.
	raw, _ := json.Marshal(struct {
		N int
	}{N: mgr.Count()})
	if string(raw) != `{"N":0}` {
		t.Errorf("post-drop count: %s", raw)
	}
}
