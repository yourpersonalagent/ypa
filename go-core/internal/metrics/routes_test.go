package metrics

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func newTestServer(t *testing.T, c *Collector) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	RegisterRoutes(mux, c, nil)
	return httptest.NewServer(mux)
}

func TestSnapshotEndpoint(t *testing.T) {
	c := NewCollector()
	c.IncCounter("e2e_counter", map[string]string{"k": "v"})
	c.Observe("e2e_hist", map[string]string{"k": "v"}, 0.123)
	c.SetGauge("e2e_gauge", map[string]string{"k": "v"}, 42)

	srv := newTestServer(t, c)
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/internal/metrics")
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "application/json") {
		t.Errorf("Content-Type: want application/json..., got %q", ct)
	}

	var snap Snapshot
	if err := json.NewDecoder(resp.Body).Decode(&snap); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if snap.GeneratedAt.IsZero() {
		t.Errorf("generatedAt zero")
	}
	foundCounter, foundHist, foundGauge := false, false, false
	for _, c := range snap.Counters {
		if c.Name == "e2e_counter" {
			foundCounter = true
		}
	}
	for _, h := range snap.Histograms {
		if h.Name == "e2e_hist" {
			foundHist = true
		}
	}
	for _, g := range snap.Gauges {
		if g.Name == "e2e_gauge" {
			foundGauge = true
		}
	}
	if !foundCounter {
		t.Errorf("counter missing from snapshot")
	}
	if !foundHist {
		t.Errorf("histogram missing from snapshot")
	}
	if !foundGauge {
		t.Errorf("gauge missing from snapshot")
	}
	if snap.Process.GoVersion == "" {
		t.Errorf("process.goVersion empty")
	}
}

func TestSnapshotEndpointMethodNotAllowed(t *testing.T) {
	srv := newTestServer(t, NewCollector())
	defer srv.Close()

	req, _ := http.NewRequest(http.MethodPost, srv.URL+"/internal/metrics", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("post: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Fatalf("want 405, got %d", resp.StatusCode)
	}
}

func TestStreamEndpointEmitsFrames(t *testing.T) {
	c := NewCollector()
	c.IncCounter("frame_counter", nil)
	srv := newTestServer(t, c)
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	req, _ := http.NewRequestWithContext(ctx, http.MethodGet,
		srv.URL+"/internal/metrics/stream?interval=250ms", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Errorf("Content-Type: want text/event-stream, got %q", ct)
	}

	frames := readSSEFrames(t, resp.Body, 2, 5*time.Second)
	if len(frames) < 2 {
		t.Fatalf("expected >=2 frames, got %d", len(frames))
	}
	for i, f := range frames {
		var snap Snapshot
		if err := json.Unmarshal([]byte(f.data), &snap); err != nil {
			t.Errorf("frame %d not valid JSON: %v", i, err)
			continue
		}
		if snap.GeneratedAt.IsZero() {
			t.Errorf("frame %d: generatedAt zero", i)
		}
		if f.event != "snapshot" {
			t.Errorf("frame %d: event=%q (want \"snapshot\")", i, f.event)
		}
	}
}

func TestStreamEndpointHonoursCtx(t *testing.T) {
	// Use a long interval so the handler is parked in the select
	// waiting on ctx.Done(), not on a ticker tick. That isolates
	// what we're testing: context cancellation propagation.
	c := NewCollector()
	srv := newTestServer(t, c)
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())

	req, _ := http.NewRequestWithContext(ctx, http.MethodGet,
		srv.URL+"/internal/metrics/stream?interval=30s", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("get: %v", err)
	}

	// Drain the first frame from the response body in the background
	// so the server-side flush succeeds and the handler enters the
	// select-wait state.
	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = io.Copy(io.Discard, resp.Body)
	}()

	// Tiny sleep so the handler reaches the select. 50ms is plenty.
	time.Sleep(50 * time.Millisecond)

	start := time.Now()
	cancel()
	select {
	case <-done:
		if elapsed := time.Since(start); elapsed > 500*time.Millisecond {
			t.Fatalf("handler took %v to honour ctx cancel (want <500ms)", elapsed)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("handler did not return within 2s after ctx cancel")
	}
	resp.Body.Close()
}

func TestStreamIntervalClamping(t *testing.T) {
	cases := []struct {
		raw  string
		want time.Duration
	}{
		{"", defaultStreamInterval},
		{"1ms", minStreamInterval},
		{"60s", maxStreamInterval},
		{"500", 500 * time.Millisecond},
		{"500ms", 500 * time.Millisecond},
		{"garbage", defaultStreamInterval},
	}
	for _, tc := range cases {
		req := httptest.NewRequest(http.MethodGet,
			"/internal/metrics/stream?interval="+tc.raw, nil)
		got := streamInterval(req)
		if got != tc.want {
			t.Errorf("interval=%q: want %v, got %v", tc.raw, tc.want, got)
		}
	}
}

// --- SSE helper ---------------------------------------------------------

type sseFrame struct {
	event string
	data  string
}

// readSSEFrames reads up to want frames from r, stopping when either
// want frames have been received or the deadline elapses.
func readSSEFrames(t *testing.T, r io.Reader, want int, timeout time.Duration) []sseFrame {
	t.Helper()
	type chunk struct {
		f   sseFrame
		err error
	}
	out := make(chan chunk, want+1)
	go func() {
		scanner := bufio.NewScanner(r)
		scanner.Buffer(make([]byte, 64*1024), 1024*1024)
		var ev, data string
		for scanner.Scan() {
			line := scanner.Text()
			switch {
			case line == "":
				if ev != "" || data != "" {
					out <- chunk{f: sseFrame{event: ev, data: data}}
					ev, data = "", ""
				}
			case strings.HasPrefix(line, "event: "):
				ev = strings.TrimPrefix(line, "event: ")
			case strings.HasPrefix(line, "data: "):
				if data != "" {
					data += "\n"
				}
				data += strings.TrimPrefix(line, "data: ")
			}
		}
		if err := scanner.Err(); err != nil {
			out <- chunk{err: err}
		}
		close(out)
	}()

	deadline := time.After(timeout)
	var frames []sseFrame
	for len(frames) < want {
		select {
		case c, ok := <-out:
			if !ok {
				return frames
			}
			if c.err != nil {
				return frames
			}
			frames = append(frames, c.f)
		case <-deadline:
			return frames
		}
	}
	return frames
}
