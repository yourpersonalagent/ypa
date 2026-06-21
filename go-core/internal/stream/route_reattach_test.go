package stream

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// newReattachServer wires just the reattach handler onto a fresh mux so
// tests don't depend on the full RegisterRoute (which needs a provider).
func newReattachServer(t *testing.T, buffer *SessionBuffer) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	deps := RouteDeps{Buffer: buffer}
	handler := reattachHandler(deps)
	mux.HandleFunc("GET /v1/sessions/{id}/stream-direct", handler)
	mux.HandleFunc("GET /v1/sessions/{id}/stream", handler)
	return httptest.NewServer(mux)
}

func TestMergeLiveMetaFramesCarriesTurnModel(t *testing.T) {
	const sid = "reattach-live-model"
	RegisterLiveMeta(sid, "grok/started-model", 1234)
	t.Cleanup(func() { UnregisterLiveMeta(sid) })

	ctx, cancel := context.WithCancel(context.Background())
	t.Cleanup(cancel)
	in := make(chan Chunk)
	out := mergeLiveMetaFrames(ctx, sid, in)

	select {
	case got := <-out:
		if !got.Live {
			t.Fatal("first synthesized frame is not live")
		}
		if got.Model != "grok/started-model" {
			t.Fatalf("model = %q, want turn-start model", got.Model)
		}
	case <-time.After(time.Second):
		t.Fatal("timed out waiting for synthesized live-meta frame")
	}
}

func TestReattach404WhenBufferDisabled(t *testing.T) {
	mux := http.NewServeMux()
	deps := RouteDeps{} // no buffer
	handler := reattachHandler(deps)
	mux.HandleFunc("GET /v1/sessions/{id}/stream-direct", handler)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/v1/sessions/s1/stream-direct")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d, want 404", resp.StatusCode)
	}
}

func TestReattach404WhenSessionUnknown(t *testing.T) {
	buf := NewSessionBuffer()
	srv := newReattachServer(t, buf)
	defer srv.Close()

	resp, err := http.Get(srv.URL + "/v1/sessions/nope/stream-direct")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d, want 404", resp.StatusCode)
	}
}

func TestReattach405OnPost(t *testing.T) {
	buf := NewSessionBuffer()
	srv := newReattachServer(t, buf)
	defer srv.Close()

	resp, err := http.Post(srv.URL+"/v1/sessions/s1/stream-direct", "application/json", strings.NewReader("{}"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	// Go 1.22+ mux returns 405 for method-mismatch on a path pattern with method.
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405", resp.StatusCode)
	}
}

func TestReattachReplaysBufferedChunks(t *testing.T) {
	buf := NewSessionBuffer()
	for i := 1; i <= 5; i++ {
		buf.Append("s1", Chunk{Type: ChunkTypeDelta, Delta: fmt.Sprintf("d%d", i)})
	}
	srv := newReattachServer(t, buf)
	defer srv.Close()

	// fromSeq=2 → want seq 3, 4, 5 (strictly greater).
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL+"/v1/sessions/s1/stream-direct?fromSeq=2", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	got := readSomeSSEChunks(t, resp.Body, 3, cancel)
	if len(got) != 3 {
		t.Fatalf("got %d chunks, want 3: %+v", len(got), got)
	}
	if got[0].Seq != 3 || got[1].Seq != 4 || got[2].Seq != 5 {
		t.Errorf("seqs = %d %d %d", got[0].Seq, got[1].Seq, got[2].Seq)
	}
}

func TestReattachReplayThenLive(t *testing.T) {
	buf := NewSessionBuffer()
	for i := 1; i <= 10; i++ {
		buf.Append("s1", Chunk{Type: ChunkTypeDelta, Delta: fmt.Sprintf("d%d", i)})
	}
	srv := newReattachServer(t, buf)
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL+"/v1/sessions/s1/stream-direct?fromSeq=4", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	// Start consuming in a goroutine so the request body buffers in
	// time for live chunks. Replay phase yields chunks 5-10 (6 chunks).
	// Then we Append three more live chunks (11, 12, 13).
	chunkCh := make(chan Chunk, 32)
	go func() {
		defer close(chunkCh)
		br := bufio.NewReader(resp.Body)
		var data strings.Builder
		for {
			line, err := br.ReadString('\n')
			if err != nil {
				return
			}
			line = strings.TrimRight(line, "\r\n")
			if line == "" {
				if data.Len() > 0 {
					var c Chunk
					if json.Unmarshal([]byte(data.String()), &c) == nil {
						chunkCh <- c
					}
					data.Reset()
				}
				continue
			}
			if strings.HasPrefix(line, "data:") {
				if data.Len() > 0 {
					data.WriteByte('\n')
				}
				data.WriteString(strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
			}
		}
	}()

	// Drain replay (chunks 5-10) PLUS the synthetic _replay_end
	// marker the handler emits between replay and live. The marker
	// is what tells the FE to flip inReplay=false and render
	// accumulated blocks eagerly — without it a watchdog reconnect
	// leaves the bubble visibly empty.
	replayed := drainChunks(t, chunkCh, 7, 2*time.Second)
	if len(replayed) != 7 {
		t.Fatalf("replay phase: got %d chunks, want 7 (6 buffered + 1 replay-end marker)", len(replayed))
	}
	if replayed[0].Seq != 5 || replayed[5].Seq != 10 {
		t.Errorf("replay seqs span = %d..%d; want 5..10", replayed[0].Seq, replayed[5].Seq)
	}
	if !replayed[6].ReplayEnd {
		t.Errorf("expected replay-end marker after buffered chunks, got %+v", replayed[6])
	}

	// Now Append three more chunks LIVE — the subscriber should
	// pick them up.
	for i := 11; i <= 13; i++ {
		buf.Append("s1", Chunk{Type: ChunkTypeDelta, Delta: fmt.Sprintf("d%d", i)})
	}
	live := drainChunks(t, chunkCh, 3, 2*time.Second)
	if len(live) != 3 {
		t.Fatalf("live phase: got %d chunks, want 3", len(live))
	}
	if live[0].Seq != 11 || live[2].Seq != 13 {
		t.Errorf("live seqs span = %d..%d; want 11..13", live[0].Seq, live[2].Seq)
	}
}

func TestReattachAcceptsLastEventIDHeader(t *testing.T) {
	buf := NewSessionBuffer()
	for i := 1; i <= 4; i++ {
		buf.Append("s1", Chunk{Type: ChunkTypeDelta})
	}
	srv := newReattachServer(t, buf)
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL+"/v1/sessions/s1/stream-direct", nil)
	req.Header.Set("Last-Event-ID", "2")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	got := readSomeSSEChunks(t, resp.Body, 2, cancel)
	// Last-Event-ID=2 → strictly greater = seqs 3, 4.
	if len(got) != 2 || got[0].Seq != 3 || got[1].Seq != 4 {
		t.Errorf("got %+v", got)
	}
}

// TestReattachStreamPath verifies the legacy /stream tail (no -direct
// suffix) hits the same handler — this is the URL the FE currently
// uses against Node, kept working so Phase 5 cutover needs no frontend
// changes.
func TestReattachStreamPath(t *testing.T) {
	buf := NewSessionBuffer()
	buf.Append("s1", Chunk{Type: ChunkTypeDelta, Delta: "x"})
	srv := newReattachServer(t, buf)
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL+"/v1/sessions/s1/stream?fromSeq=0", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	got := readSomeSSEChunks(t, resp.Body, 1, cancel)
	if len(got) != 1 || got[0].Delta != "x" {
		t.Errorf("got %+v", got)
	}
}

func TestReattachSetsSSEHeaders(t *testing.T) {
	buf := NewSessionBuffer()
	buf.Append("s1", Chunk{Type: ChunkTypeDelta})
	srv := newReattachServer(t, buf)
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL+"/v1/sessions/s1/stream-direct", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Errorf("Content-Type = %q", ct)
	}
	if resp.Header.Get("Cache-Control") == "" {
		t.Error("missing Cache-Control")
	}
}

// TestReattachWritesEventID asserts each frame carries an `id:` line
// matching the chunk's Seq, so browser-native EventSource auto-reconnect
// can resume via Last-Event-ID.
func TestReattachWritesEventID(t *testing.T) {
	buf := NewSessionBuffer()
	buf.Append("s1", Chunk{Type: ChunkTypeDelta})
	buf.Append("s1", Chunk{Type: ChunkTypeDelta})
	srv := newReattachServer(t, buf)
	defer srv.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL+"/v1/sessions/s1/stream-direct", nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	// Read the raw bytes (not parsed) so we can assert on the `id:` lines.
	br := bufio.NewReader(resp.Body)
	idLines := []string{}
	for len(idLines) < 2 {
		line, err := br.ReadString('\n')
		if err != nil {
			break
		}
		line = strings.TrimRight(line, "\r\n")
		if strings.HasPrefix(line, "id:") {
			idLines = append(idLines, line)
		}
	}
	cancel()
	if len(idLines) != 2 || !strings.Contains(idLines[0], "1") || !strings.Contains(idLines[1], "2") {
		t.Errorf("id lines = %+v; want [id: 1, id: 2]", idLines)
	}
}

// TestReattachConcurrentSubscribersAllSeeLive checks that two clients
// reattached to the same session both receive new live chunks.
func TestReattachConcurrentSubscribersAllSeeLive(t *testing.T) {
	buf := NewSessionBuffer()
	buf.Append("s1", Chunk{Type: ChunkTypeDelta})
	srv := newReattachServer(t, buf)
	defer srv.Close()

	openClient := func() (chan Chunk, context.CancelFunc) {
		ctx, cancel := context.WithCancel(context.Background())
		req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL+"/v1/sessions/s1/stream-direct?fromSeq=1", nil)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		ch := make(chan Chunk, 32)
		go func() {
			defer close(ch)
			defer resp.Body.Close()
			br := bufio.NewReader(resp.Body)
			var data strings.Builder
			for {
				line, err := br.ReadString('\n')
				if err != nil {
					return
				}
				line = strings.TrimRight(line, "\r\n")
				if line == "" {
					if data.Len() > 0 {
						var c Chunk
						if json.Unmarshal([]byte(data.String()), &c) == nil {
							ch <- c
						}
						data.Reset()
					}
					continue
				}
				if strings.HasPrefix(line, "data:") {
					if data.Len() > 0 {
						data.WriteByte('\n')
					}
					data.WriteString(strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
				}
			}
		}()
		return ch, cancel
	}

	ch1, c1 := openClient()
	ch2, c2 := openClient()
	defer c1()
	defer c2()

	// Give the subscribers a moment to subscribe.
	time.Sleep(50 * time.Millisecond)
	for i := 0; i < 3; i++ {
		buf.Append("s1", Chunk{Type: ChunkTypeDelta})
	}

	count1 := drainChunks(t, ch1, 3, 2*time.Second)
	count2 := drainChunks(t, ch2, 3, 2*time.Second)
	if len(count1) != 3 || len(count2) != 3 {
		t.Errorf("client1=%d client2=%d; want 3 each", len(count1), len(count2))
	}
}

// readSomeSSEChunks reads exactly n SSE data frames and returns them.
// Cancels the request context once it has them so the connection
// teardown can race with the response body close.
func readSomeSSEChunks(t *testing.T, body io.Reader, n int, cancel context.CancelFunc) []Chunk {
	t.Helper()
	out := []Chunk{}
	br := bufio.NewReader(body)
	var data strings.Builder
	for len(out) < n {
		line, err := br.ReadString('\n')
		if err == io.EOF {
			break
		}
		if err != nil {
			break
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			if data.Len() > 0 {
				var c Chunk
				if json.Unmarshal([]byte(data.String()), &c) == nil {
					out = append(out, c)
				}
				data.Reset()
			}
			continue
		}
		if strings.HasPrefix(line, "data:") {
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.WriteString(strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	if cancel != nil {
		cancel()
	}
	return out
}

func drainChunks(t *testing.T, ch <-chan Chunk, want int, timeout time.Duration) []Chunk {
	t.Helper()
	got := []Chunk{}
	deadline := time.NewTimer(timeout)
	defer deadline.Stop()
	for len(got) < want {
		select {
		case c, ok := <-ch:
			if !ok {
				return got
			}
			got = append(got, c)
		case <-deadline.C:
			return got
		}
	}
	return got
}

// TestRouteEndToEndReattach is the integration test the task asks for:
// fire a streaming POST that emits N chunks, then GET the reattach
// endpoint with ?fromSeq=M and confirm chunks M+1..N come back plus any
// new live chunks delivered after.
//
// The scripted provider drives N=10 deltas + a done; we send fromSeq=5
// (the FE's "I saw seq 5 last") and expect chunks 6..end-of-stream back.
func TestRouteEndToEndReattach(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(200)
	}))
	defer upstream.Close()

	// Build a scripted provider that emits 10 deltas + signals done.
	deltas := make([]Chunk, 10)
	for i := 0; i < 10; i++ {
		deltas[i] = Chunk{Type: ChunkTypeDelta, Delta: fmt.Sprintf("d%d", i+1)}
	}
	scripted := &scriptedRouteProvider{
		endpoint:  upstream.URL,
		responses: []scriptedResponse{{emit: deltas, done: true}},
	}

	buf := NewSessionBuffer()
	mux := http.NewServeMux()
	RegisterRoute(mux, RouteDeps{
		APIKeyFor:    func(string) string { return "k" },
		Runner:       &mockRunner{},
		PickProvider: func(string) (Provider, string, error) { return scripted, "scripted", nil },
		Buffer:       buf,
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	// Fire the live POST and drain it to completion. The buffer should
	// hold all 11 chunks (10 deltas + 1 done) tagged with seqs 1..11.
	body := `{"model":"claude-opus-4-7","input":"hi","sessionId":"sid-1"}`
	resp, err := http.Post(srv.URL+"/v1/stream-direct/", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	// Verify the buffer is alive (ScheduleFinalize armed but the grace
	// window hasn't fired yet — default 60 s).
	if !buf.Has("sid-1") {
		t.Fatal("buffer dropped session before grace expired")
	}

	// Now reattach with fromSeq=5 — should replay seqs 6..11.
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", srv.URL+"/v1/sessions/sid-1/stream-direct?fromSeq=5", nil)
	resp2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()

	got := readSomeSSEChunks(t, resp2.Body, 6, cancel)
	if len(got) != 6 {
		t.Fatalf("got %d chunks, want 6 (seqs 6..11)", len(got))
	}
	if got[0].Seq != 6 || got[5].Seq != 11 {
		t.Errorf("seqs span = %d..%d; want 6..11", got[0].Seq, got[5].Seq)
	}
	if got[5].Type != ChunkTypeDone {
		t.Errorf("last chunk type = %q; want done", got[5].Type)
	}
}
