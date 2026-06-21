package tools

import (
	"context"
	"sync"
	"testing"
)

// mockRecorder is a slice-based capture struct that satisfies the
// Recorder interface. Concurrency-safe; intentionally tiny so it
// doesn't compete with metrics.Collector for behaviour.
type mockRecorder struct {
	mu       sync.Mutex
	counters []recCounter
	observes []recObserve
}

type recCounter struct {
	name   string
	labels map[string]string
}

type recObserve struct {
	name   string
	labels map[string]string
	value  float64
}

func (m *mockRecorder) IncCounter(name string, labels map[string]string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.counters = append(m.counters, recCounter{name: name, labels: cloneMap(labels)})
}

func (m *mockRecorder) Observe(name string, labels map[string]string, value float64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.observes = append(m.observes, recObserve{name: name, labels: cloneMap(labels), value: value})
}

func cloneMap(in map[string]string) map[string]string {
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

// TestRunEmitsOKMetrics checks the happy path: a successful Bash call
// produces tool_run_count{name=Bash,status=ok} + tool_run_latency_ms{name=Bash}.
func TestRunEmitsOKMetrics(t *testing.T) {
	cwd := t.TempDir()
	e := New(cwd, nil, nil)
	rec := &mockRecorder{}
	e.SetRecorder(rec)

	res, err := e.Run(context.Background(), "Bash", map[string]any{"command": "true"})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !res.OK {
		t.Fatalf("expected OK=true, got %+v", res)
	}

	if len(rec.counters) != 1 {
		t.Fatalf("counters = %d, want 1", len(rec.counters))
	}
	c := rec.counters[0]
	if c.name != "tool_run_count" {
		t.Errorf("counter name = %q, want tool_run_count", c.name)
	}
	if c.labels["name"] != "Bash" || c.labels["status"] != "ok" {
		t.Errorf("counter labels = %+v, want name=Bash status=ok", c.labels)
	}
	if len(rec.observes) != 1 || rec.observes[0].name != "tool_run_latency_ms" {
		t.Errorf("observes = %+v, want tool_run_latency_ms", rec.observes)
	}
	if rec.observes[0].labels["name"] != "Bash" {
		t.Errorf("observe labels = %+v", rec.observes[0].labels)
	}
}

// TestRunEmitsErrorMetrics covers the path where the tool itself
// reports OK=false (here Bash with no command). Status should be
// "error" — distinct from "unknown" — and latency still recorded.
func TestRunEmitsErrorMetrics(t *testing.T) {
	e := New(t.TempDir(), nil, nil)
	rec := &mockRecorder{}
	e.SetRecorder(rec)

	res, err := e.Run(context.Background(), "Bash", map[string]any{}) // missing command
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.OK {
		t.Fatalf("expected OK=false")
	}

	if len(rec.counters) != 1 || rec.counters[0].labels["status"] != "error" {
		t.Errorf("counters = %+v, want status=error", rec.counters)
	}
	if len(rec.observes) != 1 {
		t.Errorf("observes len = %d, want 1", len(rec.observes))
	}
}

// TestRunEmitsUnknownMetrics covers the unknown-tool branch. We need
// the "unknown" status separately from "error" so dashboards can
// surface model-side typos / catalog drift.
func TestRunEmitsUnknownMetrics(t *testing.T) {
	e := New(t.TempDir(), nil, nil)
	rec := &mockRecorder{}
	e.SetRecorder(rec)

	_, err := e.Run(context.Background(), "Frobnicate", nil)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if len(rec.counters) != 1 || rec.counters[0].labels["status"] != "unknown" {
		t.Errorf("counters = %+v, want status=unknown", rec.counters)
	}
}

// TestRunNilRecorderSafe ensures the existing path (no metrics) still
// works — the field defaults to nil and the hot path must guard.
func TestRunNilRecorderSafe(t *testing.T) {
	e := New(t.TempDir(), nil, nil)
	if e.Recorder != nil {
		t.Errorf("default Recorder = %v, want nil", e.Recorder)
	}
	// Should not panic when recorder is nil.
	if _, err := e.Run(context.Background(), "Bash", map[string]any{"command": "true"}); err != nil {
		t.Fatalf("Run: %v", err)
	}
}
