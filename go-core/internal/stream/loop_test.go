package stream

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/yha/core/internal/tools"
)

// ── Mock provider ──────────────────────────────────────────────────────────

// scriptedProvider replays a fixed sequence of "responses". Each call
// to BuildRequest is logged; each Stream call returns the next scripted
// response. Tool calls in the response are surfaced; the loop then
// runs them via the mock runner and asks for the next response.
type scriptedProvider struct {
	endpoint  string
	responses []scriptedResponse
	idx       int32 // atomic counter; one per Stream call
	requests  []string
}

type scriptedResponse struct {
	emit      []Chunk
	toolCalls []ToolUseChunk
	done      bool
	err       error
}

func (p *scriptedProvider) Name() string                                { return "scripted" }
func (p *scriptedProvider) Endpoint() string                            { return p.endpoint }
func (p *scriptedProvider) Headers(_ string) http.Header                { return http.Header{"Content-Type": {"application/json"}} }
func (p *scriptedProvider) BuildRequest(m []Message, _ []Tool, _ RequestOpts) ([]byte, error) {
	b, _ := json.Marshal(m)
	p.requests = append(p.requests, string(b))
	return []byte(`{}`), nil
}
func (p *scriptedProvider) Stream(_ context.Context, _ io.Reader, emit EmitFn) ([]ToolUseChunk, bool, error) {
	i := atomic.AddInt32(&p.idx, 1) - 1
	if int(i) >= len(p.responses) {
		return nil, true, nil
	}
	r := p.responses[i]
	for _, c := range r.emit {
		emit(c)
	}
	return r.toolCalls, r.done, r.err
}

// ── Mock tool runner ───────────────────────────────────────────────────────

type mockRunner struct {
	calls   int32
	results map[string]*tools.Result
	tools   []tools.Tool
}

func (m *mockRunner) Run(_ context.Context, name string, _ map[string]any) (*tools.Result, error) {
	atomic.AddInt32(&m.calls, 1)
	if r, ok := m.results[name]; ok {
		return r, nil
	}
	return &tools.Result{OK: true, Content: "default-result-for-" + name}, nil
}

func (m *mockRunner) Catalog() []tools.Tool { return m.tools }

// ── Helpers ────────────────────────────────────────────────────────────────

// httpEcho hosts a tiny no-op handler that returns 200 with empty body.
// scriptedProvider doesn't actually parse the response body so the
// content doesn't matter — but Run() still does an HTTP round-trip,
// so we need a server.
func httpEcho(t *testing.T) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(200)
	})
	return httptest.NewServer(mux)
}

// ── Tests ──────────────────────────────────────────────────────────────────

func TestRunSingleTurnNoTools(t *testing.T) {
	srv := httpEcho(t)
	defer srv.Close()

	p := &scriptedProvider{
		endpoint: srv.URL,
		responses: []scriptedResponse{
			{
				emit: []Chunk{
					{Type: ChunkTypeDelta, Delta: "Hello"},
					{Type: ChunkTypeDelta, Delta: " world"},
				},
				done: true,
			},
		},
	}
	var got []Chunk
	emit := func(c Chunk) { got = append(got, c) }

	err := Run(context.Background(), p, &mockRunner{}, []Message{{Role: "user", Content: "hi"}}, nil, Opts{}, emit)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}

	// Expected: 2 deltas + 1 done.
	if len(got) != 3 {
		t.Fatalf("emit count = %d, want 3 (got: %+v)", len(got), got)
	}
	if got[0].Delta != "Hello" || got[1].Delta != " world" {
		t.Errorf("delta sequence wrong: %+v", got[:2])
	}
	if got[2].Type != ChunkTypeDone || got[2].DoneReason != "stop" {
		t.Errorf("final chunk = %+v, want done/stop", got[2])
	}
	if len(p.requests) != 1 {
		t.Errorf("BuildRequest called %d times, want 1", len(p.requests))
	}
}

func TestRunToolUseAppendsResultMessage(t *testing.T) {
	srv := httpEcho(t)
	defer srv.Close()

	p := &scriptedProvider{
		endpoint: srv.URL,
		responses: []scriptedResponse{
			// Turn 1: model wants to call Bash.
			{
				toolCalls: []ToolUseChunk{
					{ID: "call_1", Name: "Bash", Input: map[string]any{"command": "ls"}},
				},
			},
			// Turn 2: model produces final answer using the tool result.
			{
				emit: []Chunk{{Type: ChunkTypeDelta, Delta: "I see the files."}},
				done: true,
			},
		},
	}
	runner := &mockRunner{
		results: map[string]*tools.Result{
			"Bash": {OK: true, Content: "file1.txt\nfile2.txt\n"},
		},
	}
	var got []Chunk
	emit := func(c Chunk) { got = append(got, c) }

	err := Run(context.Background(), p, runner, nil, nil, Opts{}, emit)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if c := atomic.LoadInt32(&runner.calls); c != 1 {
		t.Errorf("runner.Run called %d times, want 1", c)
	}
	// Expect: tool_result, delta, done.
	if len(got) != 3 {
		t.Fatalf("emit count = %d, want 3, got %+v", len(got), got)
	}
	if got[0].Type != ChunkTypeToolResult {
		t.Errorf("first chunk = %+v, want tool_result", got[0])
	}
	if got[0].ToolResult == nil || !got[0].ToolResult.OK || got[0].ToolResult.Content != "file1.txt\nfile2.txt\n" {
		t.Errorf("tool result = %+v", got[0].ToolResult)
	}
	if got[1].Delta != "I see the files." {
		t.Errorf("turn-2 delta = %+v", got[1])
	}
	if got[2].Type != ChunkTypeDone {
		t.Errorf("final chunk = %+v, want done", got[2])
	}

	// Turn 2's request should include the tool result message in its history.
	if len(p.requests) != 2 {
		t.Fatalf("BuildRequest called %d times, want 2", len(p.requests))
	}
	if !strings.Contains(p.requests[1], "file1.txt") {
		t.Errorf("turn-2 request missing tool result content: %q", p.requests[1])
	}
}

func TestRunRespectsMaxIter(t *testing.T) {
	srv := httpEcho(t)
	defer srv.Close()
	// Provider always asks for another tool — should hit cap.
	p := &scriptedProvider{
		endpoint: srv.URL,
	}
	for i := 0; i < 5; i++ {
		p.responses = append(p.responses, scriptedResponse{
			toolCalls: []ToolUseChunk{{ID: "x", Name: "Loop"}},
		})
	}
	var got []Chunk
	err := Run(context.Background(), p, &mockRunner{}, nil, nil, Opts{MaxIter: 3}, func(c Chunk) { got = append(got, c) })
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	last := got[len(got)-1]
	if last.Type != ChunkTypeDone || last.DoneReason != "max_iter" {
		t.Errorf("expected done/max_iter, got %+v", last)
	}
}

func TestRunPropagatesProviderError(t *testing.T) {
	srv := httpEcho(t)
	defer srv.Close()
	p := &scriptedProvider{
		endpoint: srv.URL,
		responses: []scriptedResponse{
			{err: errFromTest("boom")},
		},
	}
	var got []Chunk
	err := Run(context.Background(), p, &mockRunner{}, nil, nil, Opts{}, func(c Chunk) { got = append(got, c) })
	if err == nil {
		t.Fatal("expected error")
	}
	// First (and only) emitted chunk should be ChunkTypeError.
	if len(got) == 0 || got[0].Type != ChunkTypeError {
		t.Errorf("expected error chunk, got %+v", got)
	}
}

func TestRunHandlesHTTPError(t *testing.T) {
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "rate limited", http.StatusTooManyRequests)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()

	p := &scriptedProvider{endpoint: srv.URL, responses: []scriptedResponse{{done: true}}}
	var got []Chunk
	err := Run(context.Background(), p, &mockRunner{}, nil, nil, Opts{}, func(c Chunk) { got = append(got, c) })
	if err == nil {
		t.Fatal("expected error from 429 response")
	}
	if !strings.Contains(err.Error(), "429") {
		t.Errorf("err = %v, want it to mention 429", err)
	}
}

func TestRunCancelledContext(t *testing.T) {
	srv := httpEcho(t)
	defer srv.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel() // cancel immediately
	p := &scriptedProvider{endpoint: srv.URL, responses: []scriptedResponse{{done: true}}}
	err := Run(ctx, p, &mockRunner{}, nil, nil, Opts{}, nil)
	if err == nil {
		t.Error("expected error on cancelled ctx")
	}
}

func TestSSEReaderBasicFrames(t *testing.T) {
	wire := "data: hello\n\ndata: world\n\n"
	r := NewEventStreamReader(strings.NewReader(wire))
	got := []string{}
	for {
		ev, err := r.Next()
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		got = append(got, ev.Data)
	}
	if len(got) != 2 || got[0] != "hello" || got[1] != "world" {
		t.Errorf("got %+v, want [hello world]", got)
	}
}

func TestSSEReaderMultilineData(t *testing.T) {
	wire := "data: line1\ndata: line2\n\n"
	r := NewEventStreamReader(strings.NewReader(wire))
	ev, err := r.Next()
	if err != nil {
		t.Fatal(err)
	}
	if ev.Data != "line1\nline2" {
		t.Errorf("data = %q, want \"line1\\nline2\"", ev.Data)
	}
}

func TestSSEReaderIgnoresComments(t *testing.T) {
	wire := ":heartbeat\n\ndata: real\n\n"
	r := NewEventStreamReader(strings.NewReader(wire))
	ev, err := r.Next()
	if err != nil {
		t.Fatal(err)
	}
	if ev.Data != "real" {
		t.Errorf("data = %q, want \"real\"", ev.Data)
	}
}

func TestSSEReaderEventName(t *testing.T) {
	wire := "event: tool_use\ndata: {\"id\":\"x\"}\n\n"
	r := NewEventStreamReader(strings.NewReader(wire))
	ev, err := r.Next()
	if err != nil {
		t.Fatal(err)
	}
	if ev.Name != "tool_use" {
		t.Errorf("event = %q, want tool_use", ev.Name)
	}
	if ev.Data != `{"id":"x"}` {
		t.Errorf("data = %q", ev.Data)
	}
}

// ── tiny helpers ───────────────────────────────────────────────────────────

func errFromTest(msg string) error { return &testErr{msg: msg} }

type testErr struct{ msg string }

func (e *testErr) Error() string { return e.msg }

// (silences unused-import noise if a helper is removed during edits)
var _ = bytes.NewBuffer
