package stream

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
)

// mockRecorder captures Recorder calls for assertion. Concurrency-safe
// — tests share one across the loop's per-iteration emissions.
type mockRecorder struct {
	mu       sync.Mutex
	counters []mrCounter
	observes []mrObserve
}

type mrCounter struct {
	name   string
	labels map[string]string
}

type mrObserve struct {
	name   string
	labels map[string]string
	value  float64
}

func (m *mockRecorder) IncCounter(name string, labels map[string]string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.counters = append(m.counters, mrCounter{name: name, labels: dupLabels(labels)})
}

func (m *mockRecorder) Observe(name string, labels map[string]string, value float64) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.observes = append(m.observes, mrObserve{name: name, labels: dupLabels(labels), value: value})
}

func (m *mockRecorder) countByName(name string) int {
	m.mu.Lock()
	defer m.mu.Unlock()
	n := 0
	for _, c := range m.counters {
		if c.name == name {
			n++
		}
	}
	return n
}

func (m *mockRecorder) firstWithStatus(name string) string {
	m.mu.Lock()
	defer m.mu.Unlock()
	for _, c := range m.counters {
		if c.name == name {
			return c.labels["status"]
		}
	}
	return ""
}

func dupLabels(in map[string]string) map[string]string {
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

// TestRunEmitsDoneMetrics checks the happy path: one done iteration
// produces stream_iteration_count + stream_request_count{status=done}
// + stream_request_duration_ms.
func TestRunEmitsDoneMetrics(t *testing.T) {
	srv := httpEcho(t)
	defer srv.Close()

	p := &scriptedProvider{
		endpoint: srv.URL,
		responses: []scriptedResponse{
			{
				emit: []Chunk{{Type: ChunkTypeDelta, Delta: "ok"}},
				done: true,
			},
		},
	}
	rec := &mockRecorder{}
	err := Run(context.Background(), p, &mockRunner{}, nil, nil, Opts{Recorder: rec}, func(Chunk) {})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}

	// One iteration counter, one request_count, one duration observation.
	if got := rec.countByName("stream_iteration_count"); got != 1 {
		t.Errorf("iteration_count = %d, want 1", got)
	}
	if got := rec.countByName("stream_request_count"); got != 1 {
		t.Errorf("request_count = %d, want 1", got)
	}
	if status := rec.firstWithStatus("stream_request_count"); status != "done" {
		t.Errorf("request_count status = %q, want done", status)
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if len(rec.observes) != 1 || rec.observes[0].name != "stream_request_duration_ms" {
		t.Errorf("observes = %+v, want one stream_request_duration_ms", rec.observes)
	}
	if rec.observes[0].labels["provider"] != "scripted" {
		t.Errorf("provider label = %q, want scripted", rec.observes[0].labels["provider"])
	}
}

// TestRunEmitsErrorMetrics covers the provider-error path.
// stream_request_count must be tagged status=error and the duration
// observation must still fire (always-on regardless of exit path).
func TestRunEmitsErrorMetrics(t *testing.T) {
	srv := httpEcho(t)
	defer srv.Close()

	p := &scriptedProvider{
		endpoint: srv.URL,
		responses: []scriptedResponse{
			{err: errFromTest("boom")},
		},
	}
	rec := &mockRecorder{}
	err := Run(context.Background(), p, &mockRunner{}, nil, nil, Opts{Recorder: rec}, func(Chunk) {})
	if err == nil {
		t.Fatal("expected error")
	}
	if got := rec.firstWithStatus("stream_request_count"); got != "error" {
		t.Errorf("status = %q, want error", got)
	}
	if got := rec.countByName("stream_iteration_count"); got != 1 {
		// One iteration counter (the loop entered iter 0 before failing).
		t.Errorf("iteration_count = %d, want 1", got)
	}
	rec.mu.Lock()
	defer rec.mu.Unlock()
	if len(rec.observes) != 1 {
		t.Errorf("expected one duration observation, got %d", len(rec.observes))
	}
}

// TestRunEmitsMaxIterMetrics ensures the cap-hit exit produces
// status=max_iter and that we record one stream_iteration_count per
// loop iteration the runner actually executed.
func TestRunEmitsMaxIterMetrics(t *testing.T) {
	srv := httpEcho(t)
	defer srv.Close()
	p := &scriptedProvider{endpoint: srv.URL}
	for i := 0; i < 5; i++ {
		p.responses = append(p.responses, scriptedResponse{
			toolCalls: []ToolUseChunk{{ID: "x", Name: "Loop"}},
		})
	}

	rec := &mockRecorder{}
	if err := Run(context.Background(), p, &mockRunner{}, nil, nil, Opts{MaxIter: 3, Recorder: rec}, func(Chunk) {}); err != nil {
		t.Fatalf("Run: %v", err)
	}

	if got := rec.countByName("stream_iteration_count"); got != 3 {
		t.Errorf("iteration_count = %d, want 3 (MaxIter)", got)
	}
	if status := rec.firstWithStatus("stream_request_count"); status != "max_iter" {
		t.Errorf("request_count status = %q, want max_iter", status)
	}
}

// TestRunNilRecorderSafe verifies the loop still works when no
// Recorder is attached — existing callers must not break.
func TestRunNilRecorderSafe(t *testing.T) {
	srv := httpEcho(t)
	defer srv.Close()
	p := &scriptedProvider{
		endpoint:  srv.URL,
		responses: []scriptedResponse{{done: true}},
	}
	if err := Run(context.Background(), p, &mockRunner{}, nil, nil, Opts{}, func(Chunk) {}); err != nil {
		t.Fatalf("Run: %v", err)
	}
}

// TestRouteDepsRecorderThreaded mirrors the wiring style used in
// cmd/yha-core/main.go — Recorder lives on RouteDeps and lands in
// Opts.Recorder. We exercise the route handler end-to-end so any
// future wiring drift trips this test.
func TestRouteDepsRecorderThreaded(t *testing.T) {
	srv := httpEcho(t)
	defer srv.Close()

	// Tiny scripted provider that immediately signals done.
	scripted := &scriptedProvider{
		endpoint:  srv.URL,
		responses: []scriptedResponse{{done: true}},
	}
	pickFn := func(string) (Provider, string, error) { return scripted, "scripted", nil }

	rec := &mockRecorder{}
	mux := http.NewServeMux()
	RegisterRoute(mux, RouteDeps{
		APIKeyFor:    func(string) string { return "stub" },
		Runner:       &mockRunner{},
		PickProvider: pickFn,
		Recorder:     rec,
	})

	httpsrv := httptest.NewServer(mux)
	defer httpsrv.Close()

	body := `{"model":"scripted-1","input":"hi"}`
	resp, err := http.Post(httpsrv.URL+"/v1/stream-direct/", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	// Drain the body so we wait for server-side Run to actually return
	// (the http.Post client returns after WriteHeader, but Run's defer
	// fires after the handler finishes writing all SSE chunks).
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()

	if rec.countByName("stream_request_count") == 0 {
		t.Errorf("expected stream_request_count to be recorded via RouteDeps.Recorder, got %+v", rec.counters)
	}
}
