package stream

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/yha/core/internal/tools"
)

func newRouteServer(t *testing.T, deps RouteDeps) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	RegisterRoute(mux, deps)
	return httptest.NewServer(mux)
}

func TestRouteRejectsGet(t *testing.T) {
	srv := newRouteServer(t, RouteDeps{})
	defer srv.Close()
	resp, err := http.Get(srv.URL + "/v1/stream-direct/")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405", resp.StatusCode)
	}
}

func TestRouteRejectsBadJSON(t *testing.T) {
	srv := newRouteServer(t, RouteDeps{})
	defer srv.Close()
	resp, err := http.Post(srv.URL+"/v1/stream-direct/", "application/json", strings.NewReader("nope"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", resp.StatusCode)
	}
}

func TestRouteRequiresModel(t *testing.T) {
	srv := newRouteServer(t, RouteDeps{})
	defer srv.Close()
	resp, err := http.Post(srv.URL+"/v1/stream-direct/", "application/json", strings.NewReader(`{"input":"hi"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", resp.StatusCode)
	}
}

func TestRouteRequiresInputOrMessages(t *testing.T) {
	srv := newRouteServer(t, RouteDeps{})
	defer srv.Close()
	resp, err := http.Post(srv.URL+"/v1/stream-direct/", "application/json",
		strings.NewReader(`{"model":"claude-opus-4-7"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", resp.StatusCode)
	}
}

func TestRouteUnsupportedModel(t *testing.T) {
	srv := newRouteServer(t, RouteDeps{})
	defer srv.Close()
	resp, err := http.Post(srv.URL+"/v1/stream-direct/", "application/json",
		strings.NewReader(`{"model":"random-model","input":"hi"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", resp.StatusCode)
	}
}

func TestRouteMissingAPIKey(t *testing.T) {
	// Phase 7: "no api key" used to land on the direct path's 503
	// branch via deps.NodeURL == "". Now the classifier maps it onto
	// the non-direct path (subscription / harness adapter is expected
	// to claim it); with no adapter registered the route surfaces the
	// canonical Phase 7 502 "no harness adapter available" body.
	srv := newRouteServer(t, RouteDeps{
		APIKeyFor: func(string) string { return "" },
	})
	defer srv.Close()
	resp, err := http.Post(srv.URL+"/v1/stream-direct/", "application/json",
		strings.NewReader(`{"model":"claude-opus-4-7","input":"hi"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway {
		t.Errorf("status = %d, want 502", resp.StatusCode)
	}
}

// ── Happy path with scripted provider ──────────────────────────────────────

// scriptedRouteProvider is a Provider that ignores the upstream HTTP
// call entirely — it serves canned chunks directly to emit. The route
// still runs an HTTP roundtrip, so we need an inert mock-upstream too.
// The hack: BuildRequest returns "{}" for an inert body; we point the
// loop's HTTPClient at a server returning empty 200; Stream then ignores
// body and replays the script.
type scriptedRouteProvider struct {
	endpoint  string
	responses []scriptedResponse
	idx       int32
	requests  []string
}

func (p *scriptedRouteProvider) Name() string     { return "scripted" }
func (p *scriptedRouteProvider) Endpoint() string { return p.endpoint }
func (p *scriptedRouteProvider) Headers(_ string) http.Header {
	return http.Header{"Content-Type": {"application/json"}}
}
func (p *scriptedRouteProvider) BuildRequest(messages []Message, _ []Tool, opts RequestOpts) ([]byte, error) {
	b, _ := json.Marshal(map[string]any{
		"messages": messages, "system": opts.System, "max_tokens": opts.MaxTokens, "model": opts.Model,
	})
	p.requests = append(p.requests, string(b))
	return []byte("{}"), nil
}
func (p *scriptedRouteProvider) Stream(_ context.Context, _ io.Reader, emit EmitFn) ([]ToolUseChunk, bool, error) {
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

func TestRouteHappyPathSingleTurn(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(200)
	}))
	defer upstream.Close()

	scripted := &scriptedRouteProvider{
		endpoint: upstream.URL,
		responses: []scriptedResponse{
			{
				emit: []Chunk{
					{Type: ChunkTypeDelta, Delta: "Hello "},
					{Type: ChunkTypeDelta, Delta: "world."},
				},
				done: true,
			},
		},
	}
	srv := newRouteServer(t, RouteDeps{
		APIKeyFor: func(p string) string { return "test-key" },
		Runner:    &mockRunner{},
		PickProvider: func(model string) (Provider, string, error) {
			return scripted, "scripted", nil
		},
	})
	defer srv.Close()

	body := `{"model":"claude-opus-4-7","input":"hi","system":"be brief","max_tokens":100}`
	resp, err := http.Post(srv.URL+"/v1/stream-direct/", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if ct := resp.Header.Get("Content-Type"); ct != "text/event-stream" {
		t.Errorf("Content-Type = %q, want text/event-stream", ct)
	}

	chunks := readSSEChunks(t, resp.Body)
	// Expect: 2 deltas + 1 loop-level done + 1 route-level _end terminator.
	// The _end chunk is what the FE listens for to flip "running" → "done".
	if len(chunks) != 4 {
		t.Fatalf("got %d chunks, want 4: %+v", len(chunks), chunks)
	}
	if chunks[0].Delta != "Hello " || chunks[1].Delta != "world." {
		t.Errorf("delta sequence wrong: %+v", chunks[:2])
	}
	if chunks[2].Type != ChunkTypeDone || chunks[2].End {
		t.Errorf("loop done chunk = %+v, want done (no _end)", chunks[2])
	}
	if chunks[3].Type != ChunkTypeDone || !chunks[3].End {
		t.Errorf("terminator chunk = %+v, want done with _end", chunks[3])
	}
	// System extracted; max_tokens forwarded.
	if !strings.Contains(scripted.requests[0], `"system":"be brief"`) {
		t.Errorf("system not forwarded: %q", scripted.requests[0])
	}
	if !strings.Contains(scripted.requests[0], `"max_tokens":100`) {
		t.Errorf("max_tokens not forwarded: %q", scripted.requests[0])
	}
}

// Regression: the FE sends the preset NAME (e.g. "Internal Tools"), not
// the body. Before ResolvePreset was wired into RouteDeps the route used
// the raw req.Preset string verbatim as the system prompt, so a turn
// arriving with Preset="Internal Tools" got the literal string "Internal
// Tools" appended to the system — useless. This test pins the resolved
// behaviour: a known name expands to its body, an unknown string is
// passed through, and the default system prompt sits in front.
func TestRoutePresetNameResolves(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(200)
	}))
	defer upstream.Close()

	presets := map[string]string{
		"Internal Tools": "USE THE INTERNAL TOOLS LIST PROACTIVELY.",
		"Repo Rules":     "FOLLOW THE REPOSITORY AGENTS FILE.",
	}
	resolve := func(s string) string {
		if v, ok := presets[s]; ok {
			return v
		}
		return s
	}

	cases := []struct {
		name     string
		body     string
		mustHave []string
		mustMiss []string
	}{
		{
			name: "known name expands to body, default prefixed",
			body: `{"model":"claude-opus-4-7","input":"hi","Preset":"Internal Tools"}`,
			mustHave: []string{
				"DEFAULT-SYS",
				"USE THE INTERNAL TOOLS LIST PROACTIVELY.",
			},
			mustMiss: []string{`"system":"Internal Tools"`},
		},
		{
			name:     "unknown string passes through verbatim (inline preset text)",
			body:     `{"model":"claude-opus-4-7","input":"hi","Preset":"inline literal preset"}`,
			mustHave: []string{"inline literal preset"},
		},
		{
			name:     "replace mode drops the default and keeps only the resolved preset",
			body:     `{"model":"claude-opus-4-7","input":"hi","Preset":"Internal Tools","systemMode":"replace"}`,
			mustHave: []string{"USE THE INTERNAL TOOLS LIST PROACTIVELY."},
			mustMiss: []string{"DEFAULT-SYS"},
		},
		{
			name: "multiple preset names expand and compose",
			body: `{"model":"claude-opus-4-7","input":"hi","Preset":"Internal Tools","Presets":["Internal Tools","Repo Rules"]}`,
			mustHave: []string{
				"USE THE INTERNAL TOOLS LIST PROACTIVELY.",
				"FOLLOW THE REPOSITORY AGENTS FILE.",
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			scripted := &scriptedRouteProvider{
				endpoint: upstream.URL,
				responses: []scriptedResponse{
					{emit: []Chunk{{Type: ChunkTypeDelta, Delta: "ok"}}, done: true},
				},
			}
			srv := newRouteServer(t, RouteDeps{
				APIKeyFor:           func(string) string { return "test-key" },
				Runner:              &mockRunner{},
				PickProvider:        func(string) (Provider, string, error) { return scripted, "scripted", nil },
				DefaultSystemPrompt: func() string { return "DEFAULT-SYS" },
				ResolvePreset:       resolve,
			})
			defer srv.Close()

			resp, err := http.Post(srv.URL+"/v1/stream-direct/", "application/json", strings.NewReader(tc.body))
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				t.Fatalf("status = %d", resp.StatusCode)
			}
			_ = readSSEChunks(t, resp.Body)

			if len(scripted.requests) == 0 {
				t.Fatal("provider never received a request")
			}
			req := scripted.requests[0]
			for _, want := range tc.mustHave {
				if !strings.Contains(req, want) {
					t.Errorf("system missing %q in: %s", want, req)
				}
			}
			for _, bad := range tc.mustMiss {
				if strings.Contains(req, bad) {
					t.Errorf("system unexpectedly contains %q in: %s", bad, req)
				}
			}
		})
	}
}

// fakeParticipants returns a fixed ParticipantRouteContext on Resolve.
type fakeParticipants struct {
	ctx ParticipantRouteContext
}

func (f *fakeParticipants) Resolve(_, _ string) (ParticipantRouteContext, error) {
	return f.ctx, nil
}

// Regression for the ordering bug: an employee's `systemPromptPreset`
// frontmatter is applied at the employee-gate block, but the system-mode
// resolver previously ran *before* that — so the employee's preset name
// was assigned to req.Preset only after req.System had already been
// locked in, and the name never reached the wire. This test pins the
// fixed order: no FE preset, employee carries SystemPromptPreset="CEOdave",
// ResolvePreset expands "CEOdave" → its body, and the body lands in the
// outgoing system prompt.
func TestRouteEmployeeSystemPromptPresetResolves(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(200)
	}))
	defer upstream.Close()

	const empPresetBody = "YOU ARE CEO DAVE. SPEAK WITH AUTHORITY."
	presets := map[string]string{"CEOdave": empPresetBody}
	resolve := func(s string) string {
		if v, ok := presets[s]; ok {
			return v
		}
		return s
	}
	// HasParticipants=false keeps the request on the direct/scripted
	// path; Target+ParticipantIDs still cause the employee-gate block
	// to fire, which is what we need to exercise here.
	participants := &fakeParticipants{
		ctx: ParticipantRouteContext{
			ParticipantIDs: []string{"emp-1"},
			Target: &ParticipantTarget{
				ID:                 "emp-1",
				Name:               "CEOdave",
				SystemPromptPreset: "CEOdave",
			},
		},
	}
	scripted := &scriptedRouteProvider{
		endpoint: upstream.URL,
		responses: []scriptedResponse{
			{emit: []Chunk{{Type: ChunkTypeDelta, Delta: "ok"}}, done: true},
		},
	}
	srv := newRouteServer(t, RouteDeps{
		APIKeyFor:           func(string) string { return "k" },
		Runner:              &mockRunner{},
		PickProvider:        func(string) (Provider, string, error) { return scripted, "scripted", nil },
		DefaultSystemPrompt: func() string { return "DEFAULT-SYS" },
		ResolvePreset:       resolve,
		Participants:        participants,
	})
	defer srv.Close()

	// No Preset on the body — the employee's frontmatter is the only
	// source. SessionId triggers the Participants.Resolve hop.
	body := `{"model":"claude-opus-4-7","input":"hi","sessionId":"sid-emp"}`
	resp, err := http.Post(srv.URL+"/v1/stream-direct/", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	_ = readSSEChunks(t, resp.Body)

	if len(scripted.requests) == 0 {
		t.Fatal("provider never received a request")
	}
	got := scripted.requests[0]
	if !strings.Contains(got, empPresetBody) {
		t.Errorf("employee preset body missing from system prompt:\n%s", got)
	}
	if strings.Contains(got, `"system":"CEOdave"`) {
		t.Errorf("system prompt is the raw preset NAME, not body:\n%s", got)
	}
}

func TestRouteHappyPathToolUse(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(200)
	}))
	defer upstream.Close()

	scripted := &scriptedRouteProvider{
		endpoint: upstream.URL,
		responses: []scriptedResponse{
			{toolCalls: []ToolUseChunk{{ID: "c1", Name: "Bash", Input: map[string]any{"command": "ls"}}}},
			{emit: []Chunk{{Type: ChunkTypeDelta, Delta: "ok"}}, done: true},
		},
	}
	runner := &mockRunner{
		results: map[string]*tools.Result{
			"Bash": {OK: true, Content: "file.txt"},
		},
	}
	srv := newRouteServer(t, RouteDeps{
		APIKeyFor:    func(string) string { return "k" },
		Runner:       runner,
		PickProvider: func(string) (Provider, string, error) { return scripted, "scripted", nil },
	})
	defer srv.Close()

	body := `{"model":"claude-opus-4-7","input":"do it"}`
	resp, err := http.Post(srv.URL+"/v1/stream-direct/", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	chunks := readSSEChunks(t, resp.Body)
	// Expect: tool_result + delta + loop done + route _end terminator.
	if len(chunks) != 4 {
		t.Fatalf("got %d chunks: %+v", len(chunks), chunks)
	}
	if chunks[0].Type != ChunkTypeToolResult || chunks[0].ToolResult == nil {
		t.Errorf("first chunk = %+v, want tool_result", chunks[0])
	}
	if chunks[len(chunks)-1].Type != ChunkTypeDone || !chunks[len(chunks)-1].End {
		t.Errorf("terminator chunk = %+v, want done with _end", chunks[len(chunks)-1])
	}
	if chunks[0].ToolResult.Content != "file.txt" {
		t.Errorf("tool result content = %q", chunks[0].ToolResult.Content)
	}
	if atomic.LoadInt32(&runner.calls) != 1 {
		t.Errorf("runner calls = %d, want 1", runner.calls)
	}
}

// ── Provider routing ───────────────────────────────────────────────────────

func TestPickProviderClaude(t *testing.T) {
	p, name, err := pickProvider("claude-opus-4-7")
	if err != nil {
		t.Fatal(err)
	}
	if name != "anthropic" {
		t.Errorf("name = %q, want anthropic", name)
	}
	if _, ok := p.(*AnthropicProvider); !ok {
		t.Errorf("type = %T, want *AnthropicProvider", p)
	}
}

func TestPickProviderGPT(t *testing.T) {
	for _, m := range []string{"gpt-4o", "gpt-4o-mini", "openai/gpt-4o", "o1-preview", "o3-mini"} {
		p, name, err := pickProvider(m)
		if err != nil {
			t.Errorf("%q: %v", m, err)
			continue
		}
		if name != "openai" {
			t.Errorf("%q name = %q, want openai", m, name)
		}
		if _, ok := p.(*OpenAIProvider); !ok {
			t.Errorf("%q type = %T", m, p)
		}
	}
}

func TestPickProviderGemini(t *testing.T) {
	p, name, _ := pickProvider("gemini-2-pro")
	if name != "gemini" {
		t.Errorf("name = %q", name)
	}
	if _, ok := p.(*GeminiProvider); !ok {
		t.Errorf("type = %T", p)
	}
}

func TestPickProviderUnsupported(t *testing.T) {
	if _, _, err := pickProvider("llama-3-70b"); err == nil {
		t.Error("expected error for unsupported model")
	}
}

// TestRouteFiltersCatalogByName verifies that req.Tools restricts which
// catalog entries the model sees. The mockRunner advertises 3 tools;
// the body's "tools":["A","C"] should narrow to those two.
func TestRouteFiltersCatalogByName(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(200)
	}))
	defer upstream.Close()

	var sawTools []Tool
	scripted := &scriptedRouteProvider{endpoint: upstream.URL, responses: []scriptedResponse{{done: true}}}
	captureProvider := &captureToolsProvider{inner: scripted, capture: &sawTools}

	mock := &mockRunner{
		tools: []tools.Tool{
			{Name: "A", Description: "alpha"},
			{Name: "B", Description: "beta"},
			{Name: "C", Description: "gamma"},
		},
	}
	srv := newRouteServer(t, RouteDeps{
		APIKeyFor:    func(string) string { return "k" },
		Runner:       mock,
		PickProvider: func(string) (Provider, string, error) { return captureProvider, "scripted", nil },
	})
	defer srv.Close()

	body := `{"model":"claude-opus-4-7","input":"hi","tools":["A","C"]}`
	resp, err := http.Post(srv.URL+"/v1/stream-direct/", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	// Drain the SSE body so the loop on the other side finishes before
	// we assert. Closing without reading triggers a ctx cancel that
	// races with the catalog capture.
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	names := map[string]bool{}
	for _, t := range sawTools {
		names[t.Name] = true
	}
	if names["B"] {
		t.Errorf("B should have been filtered out: %+v", sawTools)
	}
	if !names["A"] || !names["C"] {
		t.Errorf("A and C should have made it through: %+v", sawTools)
	}
}

// TestRouteCompositeRunnerWithSession verifies the route threads the
// body's cwd/sessionId fields through to a CompositeRunner via the
// WithSession() hop. The fakeNode captures what cwd/sessionId arrived.
func TestRouteCompositeRunnerWithSession(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(200)
	}))
	defer upstream.Close()

	// Build a CompositeRunner with only a Node backend; the catalog
	// has one tool ("AskUser") served by node. The scripted provider
	// asks the model to call AskUser on turn 1.
	cat := &capturingCatalog{
		tools: []tools.Tool{{Name: "AskUser", Source: "node:bridge"}},
	}
	node := &capturingNode{}
	composite := tools.NewCompositeRunner(nil, nil, cat, node)
	_ = composite.Catalog() // pre-populate dispatch

	scripted := &scriptedRouteProvider{
		endpoint: upstream.URL,
		responses: []scriptedResponse{
			{toolCalls: []ToolUseChunk{{ID: "c1", Name: "AskUser", Input: map[string]any{"q": "?"}}}},
			{emit: []Chunk{{Type: ChunkTypeDelta, Delta: "done"}}, done: true},
		},
	}
	srv := newRouteServer(t, RouteDeps{
		APIKeyFor:    func(string) string { return "k" },
		Runner:       composite,
		PickProvider: func(string) (Provider, string, error) { return scripted, "scripted", nil },
	})
	defer srv.Close()

	// Use a real directory: route.go stat-checks the FE-supplied cwd and
	// clears it when the path doesn't exist (the stale-cwd guard at
	// route.go:800), so a bogus "/work/dir" would be wiped before it
	// could thread through to the node runner.
	cwd := t.TempDir()
	cwdJSON, _ := json.Marshal(cwd)
	body := fmt.Sprintf(`{"model":"claude-opus-4-7","input":"hi","sessionId":"sid-9","cwd":%s}`, cwdJSON)
	resp, err := http.Post(srv.URL+"/v1/stream-direct/", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	// Drain so the loop on the other side finishes before we assert.
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	if node.lastSID != "sid-9" {
		t.Errorf("sessionId not threaded: got %q", node.lastSID)
	}
	if node.lastCwd != cwd {
		t.Errorf("cwd not threaded: got %q want %q", node.lastCwd, cwd)
	}
}

// captureToolsProvider records the catalog seen by BuildRequest so the
// filter test can assert on it.
type captureToolsProvider struct {
	inner   *scriptedRouteProvider
	capture *[]Tool
}

func (p *captureToolsProvider) Name() string                 { return p.inner.Name() }
func (p *captureToolsProvider) Endpoint() string             { return p.inner.Endpoint() }
func (p *captureToolsProvider) Headers(k string) http.Header { return p.inner.Headers(k) }
func (p *captureToolsProvider) BuildRequest(m []Message, t []Tool, opts RequestOpts) ([]byte, error) {
	*p.capture = append(*p.capture, t...)
	return p.inner.BuildRequest(m, t, opts)
}
func (p *captureToolsProvider) Stream(ctx context.Context, r io.Reader, emit EmitFn) ([]ToolUseChunk, bool, error) {
	return p.inner.Stream(ctx, r, emit)
}

// capturingCatalog satisfies tools.NodeCatalogClient.
type capturingCatalog struct {
	tools []tools.Tool
}

func (c *capturingCatalog) Get(_ context.Context) ([]tools.Tool, error) { return c.tools, nil }
func (c *capturingCatalog) Invalidate()                                 {}

// capturingNode satisfies tools.NodeRunner; records what cwd/sessionId
// the runner threaded through.
type capturingNode struct {
	lastCwd string
	lastSID string
}

func (n *capturingNode) Run(_ context.Context, name string, _ map[string]any, cwd, sessionID string) (*tools.Result, error) {
	n.lastCwd = cwd
	n.lastSID = sessionID
	return &tools.Result{OK: true, Content: "ok:" + name}, nil
}

func TestExtractSystemFromMessages(t *testing.T) {
	msgs := []Message{
		{Role: "system", Content: "be helpful"},
		{Role: "user", Content: "hi"},
		{Role: "system", Content: "and brief"}, // additional system messages get joined
	}
	got := extractSystemFromMessages(&msgs)
	want := "be helpful\n\nand brief"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
	if len(msgs) != 1 || msgs[0].Role != "user" {
		t.Errorf("messages after extract = %+v", msgs)
	}
}

// ── helpers ────────────────────────────────────────────────────────────────

// readSSEChunks consumes an SSE response body and decodes each `data:`
// payload as a Chunk. Used by the happy-path tests.
func readSSEChunks(t *testing.T, body io.Reader) []Chunk {
	t.Helper()
	out := []Chunk{}
	br := bufio.NewReader(body)
	var data bytes.Buffer
	for {
		line, err := br.ReadString('\n')
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			if data.Len() > 0 {
				var c Chunk
				if err := json.Unmarshal(data.Bytes(), &c); err == nil {
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
	return out
}

// silence unused imports during edits
var _ = fmt.Sprintf

// ── Cost-event / usage plumbing ─────────────────────────────────────────────

// usageProviderWrap wraps a scriptedRouteProvider with a UsageProvider
// surface. The captured Usage is what route.go should fold into the
// CostEventPayload after Run returns.
type usageProviderWrap struct {
	*scriptedRouteProvider
	usage    Usage
	resetHit bool
}

func (u *usageProviderWrap) Usage() Usage { return u.usage }
func (u *usageProviderWrap) ResetUsage()  { u.resetHit = true }

// recordingCostSink captures the payload route.go fires through to
// the cost-event endpoint. Auto-title calls land here too but the
// usage-plumbing tests only care about Record.
type recordingCostSink struct {
	gotPayload CostEventPayload
	gotPosted  bool
}

func (r *recordingCostSink) Record(_ context.Context, payload CostEventPayload) error {
	r.gotPayload = payload
	r.gotPosted = true
	return nil
}
func (r *recordingCostSink) EnqueueAutoTitle(_ context.Context, _ string) error { return nil }

// FireAndForget runs synchronously in the test so assertions don't
// race with the goroutine. Mirrors *nodecallback.CostEventClient's
// signature but skips the bounded-timeout goroutine.
func (r *recordingCostSink) FireAndForget(_ string, fn func(context.Context) error) {
	_ = fn(context.Background())
}

func TestRouteFeedsUsageIntoCostEventPayload(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(200)
	}))
	defer upstream.Close()

	scripted := &scriptedRouteProvider{
		endpoint: upstream.URL,
		responses: []scriptedResponse{
			{emit: []Chunk{{Type: ChunkTypeDelta, Delta: "ok"}}, done: true},
		},
	}
	wrap := &usageProviderWrap{
		scriptedRouteProvider: scripted,
		usage: Usage{
			InputTokens:         150,
			OutputTokens:        42,
			CacheReadTokens:     50,
			CacheCreationTokens: 10,
		},
	}
	sink := &recordingCostSink{}
	srv := newRouteServer(t, RouteDeps{
		APIKeyFor:    func(string) string { return "k" },
		Runner:       &mockRunner{},
		PickProvider: func(string) (Provider, string, error) { return wrap, "scripted", nil },
		CostEvents:   sink,
	})
	defer srv.Close()

	body := `{"model":"claude-opus-4-7","input":"hi","sessionId":"sid-x"}`
	resp, err := http.Post(srv.URL+"/v1/stream-direct/", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	if !sink.gotPosted {
		t.Fatal("Record never called; expected fire-and-forget to land")
	}
	got := sink.gotPayload
	if got.InputTokens != 150 || got.OutputTokens != 42 ||
		got.CacheReadTokens != 50 || got.CacheCreationTokens != 10 {
		t.Errorf("token counts not plumbed: %+v", got)
	}
	if got.Cost != 0 {
		t.Errorf("Cost = %v, want 0 (Node computes from rate table)", got.Cost)
	}
	if got.SessionID != "sid-x" || got.Provider != "scripted" {
		t.Errorf("metadata wrong: %+v", got)
	}
	if !wrap.resetHit {
		t.Error("ResetUsage was not called before Run")
	}
}

// TestRouteCostEventWithZeroUsageStillFires verifies that when the
// upstream surfaces no usage, the cost-event payload still posts
// (with zero tokens). Node-side guards skip empty payloads, so this
// is benign on the wire — but the Go side must not refuse to post.
func TestRouteCostEventWithZeroUsageStillFires(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(200)
	}))
	defer upstream.Close()

	scripted := &scriptedRouteProvider{
		endpoint:  upstream.URL,
		responses: []scriptedResponse{{done: true}},
	}
	// No UsageProvider implementation → route reads zero usage.
	sink := &recordingCostSink{}
	srv := newRouteServer(t, RouteDeps{
		APIKeyFor:    func(string) string { return "k" },
		Runner:       &mockRunner{},
		PickProvider: func(string) (Provider, string, error) { return scripted, "scripted", nil },
		CostEvents:   sink,
	})
	defer srv.Close()

	body := `{"model":"claude-opus-4-7","input":"hi","sessionId":"sid-y"}`
	resp, _ := http.Post(srv.URL+"/v1/stream-direct/", "application/json", strings.NewReader(body))
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	if !sink.gotPosted {
		t.Fatal("expected cost-event to fire even with zero usage")
	}
	if !(Usage{
		InputTokens:         sink.gotPayload.InputTokens,
		OutputTokens:        sink.gotPayload.OutputTokens,
		CacheReadTokens:     sink.gotPayload.CacheReadTokens,
		CacheCreationTokens: sink.gotPayload.CacheCreationTokens,
	}).IsZero() {
		t.Errorf("expected zero token fields, got %+v", sink.gotPayload)
	}
}

// TestRouteStampsUsageOnDoneChunk verifies that the SSE terminal done
// chunk carries the running usage (so frontends that read off the
// stream get the same numbers as the cost-event recorder).
func TestRouteStampsUsageOnDoneChunk(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(200)
	}))
	defer upstream.Close()

	wrap := &usageProviderWrap{
		scriptedRouteProvider: &scriptedRouteProvider{
			endpoint: upstream.URL,
			responses: []scriptedResponse{
				{emit: []Chunk{{Type: ChunkTypeDelta, Delta: "hi"}}, done: true},
			},
		},
		usage: Usage{InputTokens: 7, OutputTokens: 3},
	}
	srv := newRouteServer(t, RouteDeps{
		APIKeyFor:    func(string) string { return "k" },
		Runner:       &mockRunner{},
		PickProvider: func(string) (Provider, string, error) { return wrap, "scripted", nil },
	})
	defer srv.Close()

	body := `{"model":"claude-opus-4-7","input":"hi"}`
	resp, err := http.Post(srv.URL+"/v1/stream-direct/", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	chunks := readSSEChunks(t, resp.Body)

	// Two done chunks now: (a) the loop-level done from the provider
	// carries the nested *Usage; (b) the route-level _end terminator
	// carries flat InputTokens / OutputTokens for the FE wire shape.
	// Verify both surfaces see the same numbers.
	var loopDone, endChunk *Chunk
	for i := range chunks {
		if chunks[i].Type != ChunkTypeDone {
			continue
		}
		if chunks[i].End {
			endChunk = &chunks[i]
		} else {
			loopDone = &chunks[i]
		}
	}
	if loopDone == nil {
		t.Fatal("no loop-level done chunk emitted")
	}
	if loopDone.Usage == nil {
		t.Fatalf("loop done chunk missing usage: %+v", loopDone)
	}
	if loopDone.Usage.InputTokens != 7 || loopDone.Usage.OutputTokens != 3 {
		t.Errorf("usage on loop done chunk = %+v", loopDone.Usage)
	}
	if endChunk == nil {
		t.Fatal("no _end terminator chunk emitted")
	}
	if endChunk.InputTokens != 7 || endChunk.OutputTokens != 3 {
		t.Errorf("flat usage on _end chunk = in=%d out=%d, want in=7 out=3", endChunk.InputTokens, endChunk.OutputTokens)
	}
}
