package broadcast

import (
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/yha/core/internal/harness"
	"github.com/yha/core/internal/stream"
)

func TestClampForwardLimit(t *testing.T) {
	cases := []struct{ in, want int }{
		{-5, DefaultForwardLimit},
		{0, DefaultForwardLimit},
		{1, 1},
		{25, 25},
		{200, 200},
		{500, ForwardLimitMax},
	}
	for _, tc := range cases {
		if got := ClampForwardLimit(tc.in); got != tc.want {
			t.Errorf("ClampForwardLimit(%d) = %d, want %d", tc.in, got, tc.want)
		}
	}
}

func TestForwardChain_HopDispatchesMentionedTarget(t *testing.T) {
	var mu sync.Mutex
	var dispatches []dispatchRow

	// Bob's adapter records what input it received so we can verify
	// the leading @bob was stripped.
	adapter := Adapter(func(ctx context.Context, req harness.Request, emit harness.Emit) (*harness.Result, error) {
		mu.Lock()
		dispatches = append(dispatches, dispatchRow{empID: req.BroadcastEmp.ID, input: req.Input})
		mu.Unlock()
		emit(stream.Chunk{Type: stream.ChunkTypeDelta, Delta: "thanks"})
		return &harness.Result{Text: "thanks"}, nil
	})

	runner := &Runner{
		Adapters: map[string]Adapter{AdapterDirectAPI: adapter},
		Employees: mapLoader{
			"alice": {ID: "alice", Name: "Alice"},
			"bob":   {ID: "bob", Name: "Bob"},
		},
		Now: func() time.Time { return time.Unix(1700000000, 0) },
	}

	var chunks []stream.Chunk
	emit := ChunkEmitter(func(c stream.Chunk) {
		chunks = append(chunks, c)
	})

	res, err := runner.ForwardChain(
		context.Background(),
		[]string{"alice", "bob"},
		"@bob hello there",
		Request{SessionID: "sid-fwd"},
		emit,
		3,
	)
	if err != nil {
		t.Fatalf("ForwardChain: %v", err)
	}
	if res.Hops != 1 {
		t.Errorf("Hops = %d, want 1", res.Hops)
	}
	if len(res.PerHop) != 1 || res.PerHop[0].EmployeeID != "bob" {
		t.Errorf("PerHop = %+v, want one bob row", res.PerHop)
	}

	mu.Lock()
	defer mu.Unlock()
	if len(dispatches) != 1 || dispatches[0].empID != "bob" {
		t.Fatalf("dispatches = %+v, want one bob call", dispatches)
	}
	if dispatches[0].input != "hello there" {
		t.Errorf("bob.Input = %q, want %q", dispatches[0].input, "hello there")
	}

	// Hop-info reasoning chunk emitted with target metadata.
	sawHopInfo := false
	for _, c := range chunks {
		if strings.HasPrefix(c.Reasoning, "mention-forward\t1\t3\tbob\tBob") {
			sawHopInfo = true
			break
		}
	}
	if !sawHopInfo {
		t.Errorf("expected mention-forward info chunk; chunks = %+v", chunks)
	}
}

func TestForwardChain_NoLeadingMentionStopsImmediately(t *testing.T) {
	runner := &Runner{
		Adapters:  map[string]Adapter{},
		Employees: mapLoader{"alice": {ID: "alice"}},
		Now:       func() time.Time { return time.Unix(1700000000, 0) },
	}
	res, err := runner.ForwardChain(
		context.Background(),
		[]string{"alice"},
		"just a regular reply",
		Request{},
		nil,
		10,
	)
	if err != nil {
		t.Fatalf("ForwardChain: %v", err)
	}
	if res.Hops != 0 || len(res.PerHop) != 0 {
		t.Errorf("expected no hops, got %+v", res)
	}
}

func TestForwardChain_HopLimitHonored(t *testing.T) {
	// Bob always replies with "@bob ..." → forward chain would
	// run forever if the limit weren't honored.
	adapter := Adapter(func(ctx context.Context, req harness.Request, emit harness.Emit) (*harness.Result, error) {
		return &harness.Result{Text: "@bob keep going"}, nil
	})
	runner := &Runner{
		Adapters:  map[string]Adapter{AdapterDirectAPI: adapter},
		Employees: mapLoader{"bob": {ID: "bob", Name: "Bob"}},
		Now:       func() time.Time { return time.Unix(1700000000, 0) },
	}
	res, err := runner.ForwardChain(
		context.Background(),
		[]string{"bob"},
		"@bob start",
		Request{SessionID: "sid-loop"},
		nil,
		3, // hard limit
	)
	if err != nil {
		t.Fatalf("ForwardChain: %v", err)
	}
	if res.Hops != 3 {
		t.Errorf("Hops = %d, want 3 (the clamp)", res.Hops)
	}
}

func TestForwardChain_MentionOfNonParticipantStops(t *testing.T) {
	called := false
	adapter := Adapter(func(ctx context.Context, req harness.Request, emit harness.Emit) (*harness.Result, error) {
		called = true
		return &harness.Result{Text: "hi"}, nil
	})
	runner := &Runner{
		Adapters:  map[string]Adapter{AdapterDirectAPI: adapter},
		Employees: mapLoader{"alice": {ID: "alice"}},
		Now:       func() time.Time { return time.Unix(1700000000, 0) },
	}
	res, err := runner.ForwardChain(
		context.Background(),
		[]string{"alice"}, // session only knows alice
		"@bob hello",      // mention targets bob — not a participant
		Request{},
		nil,
		10,
	)
	if err != nil {
		t.Fatalf("ForwardChain: %v", err)
	}
	if called {
		t.Errorf("adapter should not be called when target is not a participant")
	}
	if res.Hops != 0 {
		t.Errorf("Hops = %d, want 0", res.Hops)
	}
}

func TestForwardChain_EmptyReplyStopsChain(t *testing.T) {
	calls := 0
	adapter := Adapter(func(ctx context.Context, req harness.Request, emit harness.Emit) (*harness.Result, error) {
		calls++
		return &harness.Result{Text: ""}, nil
	})
	runner := &Runner{
		Adapters:  map[string]Adapter{AdapterDirectAPI: adapter},
		Employees: mapLoader{"bob": {ID: "bob"}},
		Now:       func() time.Time { return time.Unix(1700000000, 0) },
	}
	res, err := runner.ForwardChain(
		context.Background(),
		[]string{"bob"},
		"@bob start",
		Request{},
		nil,
		5,
	)
	if err != nil {
		t.Fatalf("ForwardChain: %v", err)
	}
	if calls != 1 {
		t.Errorf("adapter called %d times, want 1 (chain should stop on empty reply)", calls)
	}
	if res.Hops != 1 {
		t.Errorf("Hops = %d, want 1", res.Hops)
	}
}

func TestParseLeadingMention(t *testing.T) {
	set := map[string]struct{}{"alice": {}, "bob": {}}
	target, clean := parseLeadingMention("@alice ping", set)
	if target != "alice" || clean != "ping" {
		t.Errorf("got (%q, %q), want (alice, ping)", target, clean)
	}
	// Match by name uppercased.
	target, clean = parseLeadingMention("@BOB hello", set)
	if target != "bob" || clean != "hello" {
		t.Errorf("uppercase mention: got (%q, %q)", target, clean)
	}
	// Missing target.
	target, _ = parseLeadingMention("@carol hi", set)
	if target != "" {
		t.Errorf("non-participant should yield empty target, got %q", target)
	}
	// Mention with no remainder.
	target, clean = parseLeadingMention("@alice", set)
	if target != "alice" || clean != "@alice" {
		t.Errorf("empty-remainder mention: got (%q, %q)", target, clean)
	}
	// Plain text — no mention.
	target, _ = parseLeadingMention("hello @alice mid-sentence", set)
	if target != "" {
		t.Errorf("mid-sentence mention should not match, got %q", target)
	}
}

type dispatchRow struct {
	empID string
	input string
}
