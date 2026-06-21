package mcp

import (
	"context"
	"sync"
	"testing"
	"time"
)

// mockRecorder is a slice-based capture struct for verifying the
// metrics emitted by Connection.Call. Concurrency-safe so tests can
// share one across the read-loop goroutine.
type mockRecorder struct {
	mu       sync.Mutex
	counters []counterEvent
	observes []observeEvent
}

type counterEvent struct {
	name   string
	labels map[string]string
}

type observeEvent struct {
	name   string
	labels map[string]string
	value  float64
}

func (m *mockRecorder) IncCounter(name string, labels map[string]string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.counters = append(m.counters, counterEvent{name: name, labels: copyLabels(labels)})
}

func (m *mockRecorder) Observe(name string, labels map[string]string, value float64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.observes = append(m.observes, observeEvent{name: name, labels: copyLabels(labels), value: value})
}

func (m *mockRecorder) snapshot() ([]counterEvent, []observeEvent) {
	m.mu.Lock()
	defer m.mu.Unlock()
	c := append([]counterEvent(nil), m.counters...)
	o := append([]observeEvent(nil), m.observes...)
	return c, o
}

func copyLabels(in map[string]string) map[string]string {
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

// TestCallEmitsOKMetrics checks the happy path: a successful tools/call
// produces one mcp_call_count{server,tool,status=ok} and one
// mcp_call_latency_ms{server,tool}, where `tool` is taken from
// params.name (not the literal "tools/call" method name).
func TestCallEmitsOKMetrics(t *testing.T) {
	fs := newFakeServer(t)
	defer fs.close()

	rec := &mockRecorder{}
	fs.conn.recorder = rec

	go func() {
		req := fs.expectRequest(t)
		fs.reply(req.ID, map[string]any{"content": []any{}})
	}()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, err := fs.conn.Call(ctx, "tools/call", map[string]any{
		"name":      "echo",
		"arguments": map[string]any{"text": "hi"},
	})
	if err != nil {
		t.Fatalf("call: %v", err)
	}

	counters, observes := rec.snapshot()
	if len(counters) != 1 {
		t.Fatalf("counters = %d, want 1: %+v", len(counters), counters)
	}
	c := counters[0]
	if c.name != "mcp_call_count" {
		t.Errorf("counter name = %q, want mcp_call_count", c.name)
	}
	if c.labels["server"] != "test" || c.labels["tool"] != "echo" || c.labels["status"] != "ok" {
		t.Errorf("counter labels = %+v, want server=test tool=echo status=ok", c.labels)
	}
	if len(observes) != 1 || observes[0].name != "mcp_call_latency_ms" {
		t.Fatalf("observes = %+v, want 1 mcp_call_latency_ms", observes)
	}
	if observes[0].labels["server"] != "test" || observes[0].labels["tool"] != "echo" {
		t.Errorf("observe labels = %+v", observes[0].labels)
	}
	if observes[0].value < 0 {
		t.Errorf("latency = %v, want >=0", observes[0].value)
	}
}

// TestCallEmitsErrorMetrics covers the RPC-error path. Status should be
// "error" and the latency observation must still fire (we record on
// every return regardless of outcome).
func TestCallEmitsErrorMetrics(t *testing.T) {
	fs := newFakeServer(t)
	defer fs.close()

	rec := &mockRecorder{}
	fs.conn.recorder = rec

	go func() {
		req := fs.expectRequest(t)
		fs.replyError(req.ID, -32601, "method not found")
	}()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, err := fs.conn.Call(ctx, "tools/list", nil)
	if err == nil {
		t.Fatal("expected error")
	}

	counters, observes := rec.snapshot()
	if len(counters) != 1 || counters[0].labels["status"] != "error" {
		t.Errorf("counters = %+v, want one with status=error", counters)
	}
	// For non-tools/call methods, the tool label is the verbatim method.
	if counters[0].labels["tool"] != "tools/list" {
		t.Errorf("tool label = %q, want tools/list", counters[0].labels["tool"])
	}
	if len(observes) != 1 {
		t.Errorf("observes len = %d, want 1", len(observes))
	}
}

// TestCallEmitsTimeoutMetrics verifies the ctx-deadline path produces
// status=timeout (distinct from generic error).
func TestCallEmitsTimeoutMetrics(t *testing.T) {
	fs := newFakeServer(t)
	defer fs.close()
	go discardAll(fs)

	rec := &mockRecorder{}
	fs.conn.recorder = rec

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	_, err := fs.conn.Call(ctx, "initialize", nil)
	if err == nil {
		t.Fatal("expected ctx-deadline error")
	}

	counters, _ := rec.snapshot()
	if len(counters) != 1 || counters[0].labels["status"] != "timeout" {
		t.Errorf("counters = %+v, want one with status=timeout", counters)
	}
}

// TestPoolSetRecorderPropagates ensures SetRecorder updates existing
// connections so a Pool used by autostart, then later given a recorder,
// still gauges every subsequent Call.
func TestPoolSetRecorderPropagates(t *testing.T) {
	p := NewPool(nil)
	conn := &Connection{Name: "x", pending: map[int]chan response{}}
	p.connections["x"] = conn

	rec := &mockRecorder{}
	p.SetRecorder(rec)

	if conn.recorder == nil {
		t.Error("SetRecorder did not propagate to existing connection")
	}
	if p.recorder == nil {
		t.Error("SetRecorder did not store recorder on Pool")
	}
}

// discardAll reads everything from the fake server's child-stdin so
// the synchronous io.Pipe doesn't block Send.
func discardAll(fs *fakeServer) {
	r := NewReader(fs.childIn)
	for {
		if _, err := r.ReadFrame(); err != nil {
			return
		}
	}
}
