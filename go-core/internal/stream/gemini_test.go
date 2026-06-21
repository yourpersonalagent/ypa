package stream

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// ── helpers ────────────────────────────────────────────────────────────────

// newGeminiSSEServer hosts a single endpoint that returns the supplied
// SSE wire payload with the right content type.
func newGeminiSSEServer(t *testing.T, payload string) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		_, _ = io.WriteString(w, payload)
	})
	return httptest.NewServer(mux)
}

// drainStream calls p.Stream against an SSE payload and returns the
// emitted chunks plus the (toolCalls, done, err) tuple.
func drainStream(t *testing.T, p *GeminiProvider, payload string) ([]Chunk, []ToolUseChunk, bool, error) {
	t.Helper()
	srv := newGeminiSSEServer(t, payload)
	defer srv.Close()
	resp, err := http.Get(srv.URL)
	if err != nil {
		t.Fatalf("http get: %v", err)
	}
	defer resp.Body.Close()
	var got []Chunk
	tc, done, err := p.Stream(context.Background(), resp.Body, func(c Chunk) { got = append(got, c) })
	return got, tc, done, err
}

// ── tests ──────────────────────────────────────────────────────────────────

func TestGeminiName(t *testing.T) {
	p := &GeminiProvider{}
	if got := p.Name(); got != "gemini" {
		t.Errorf("Name() = %q, want %q", got, "gemini")
	}
}

func TestGeminiHeaders(t *testing.T) {
	p := &GeminiProvider{}
	h := p.Headers("test-key-123")
	if got := h.Get("x-goog-api-key"); got != "test-key-123" {
		t.Errorf("x-goog-api-key = %q, want %q", got, "test-key-123")
	}
	if got := h.Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q", got)
	}
	if got := h.Get("Accept"); got != "text/event-stream" {
		t.Errorf("Accept = %q, want text/event-stream", got)
	}
	// No api key → header omitted (don't send empty creds).
	h2 := p.Headers("")
	if got := h2.Get("x-goog-api-key"); got != "" {
		t.Errorf("empty api key should omit header, got %q", got)
	}
}

func TestGeminiEndpoint(t *testing.T) {
	p := &GeminiProvider{Model: "gemini-2.5-flash"}
	want := "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse"
	if got := p.Endpoint(); got != want {
		t.Errorf("Endpoint = %q\nwant       %q", got, want)
	}

	// Custom base URL with trailing slash should be normalised.
	p2 := &GeminiProvider{BaseURL: "https://example.test/", Model: "m1"}
	want2 := "https://example.test/v1beta/models/m1:streamGenerateContent?alt=sse"
	if got := p2.Endpoint(); got != want2 {
		t.Errorf("Endpoint trailing-slash = %q\nwant            %q", got, want2)
	}
}

func TestGeminiBuildRequestSystemInstruction(t *testing.T) {
	p := &GeminiProvider{Model: "gemini-2.5-flash"}
	msgs := []Message{
		{Role: "system", Content: "You are a helpful assistant."},
		{Role: "user", Content: "Hi"},
	}
	body, err := p.BuildRequest(msgs, nil, RequestOpts{})
	if err != nil {
		t.Fatalf("BuildRequest: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v\nbody: %s", err, body)
	}
	si, ok := got["systemInstruction"].(map[string]any)
	if !ok {
		t.Fatalf("systemInstruction missing or wrong type: %v", got["systemInstruction"])
	}
	parts, _ := si["parts"].([]any)
	if len(parts) != 1 {
		t.Fatalf("parts len = %d, want 1", len(parts))
	}
	if text, _ := parts[0].(map[string]any)["text"].(string); text != "You are a helpful assistant." {
		t.Errorf("system text = %q", text)
	}
	// system message must NOT appear in contents.
	contents, _ := got["contents"].([]any)
	if len(contents) != 1 {
		t.Fatalf("contents len = %d, want 1 (system filtered out)", len(contents))
	}
	first, _ := contents[0].(map[string]any)
	if role, _ := first["role"].(string); role != "user" {
		t.Errorf("first contents role = %q, want user", role)
	}
}

func TestGeminiBuildRequestRoleMapping(t *testing.T) {
	p := &GeminiProvider{Model: "m"}
	msgs := []Message{
		{Role: "user", Content: "What's 2+2?"},
		{Role: "assistant", Content: "Four."},
		{Role: "user", Content: "Thanks."},
	}
	body, err := p.BuildRequest(msgs, nil, RequestOpts{})
	if err != nil {
		t.Fatalf("BuildRequest: %v", err)
	}
	var got geminiRequest
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got.Contents) != 3 {
		t.Fatalf("contents len = %d, want 3", len(got.Contents))
	}
	wantRoles := []string{"user", "model", "user"}
	for i, c := range got.Contents {
		if c.Role != wantRoles[i] {
			t.Errorf("contents[%d].role = %q, want %q", i, c.Role, wantRoles[i])
		}
	}
	if got.Contents[1].Parts[0].Text != "Four." {
		t.Errorf("assistant text mapping wrong: %+v", got.Contents[1])
	}
}

func TestGeminiBuildRequestToolResponse(t *testing.T) {
	p := &GeminiProvider{Model: "m"}
	msgs := []Message{
		{Role: "user", Content: "List files"},
		{Role: "assistant", ToolCalls: []ToolUseChunk{
			{ID: "Bash#0.0", Name: "Bash", Input: map[string]any{"cmd": "ls"}},
		}},
		{Role: "tool", ToolCallID: "Bash#0.0", Content: "file1.txt\nfile2.txt"},
	}
	body, err := p.BuildRequest(msgs, nil, RequestOpts{})
	if err != nil {
		t.Fatalf("BuildRequest: %v", err)
	}
	var got geminiRequest
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got.Contents) != 3 {
		t.Fatalf("contents len = %d, want 3 (got %+v)", len(got.Contents), got.Contents)
	}
	// The tool-result entry should be role=user with a functionResponse part.
	tr := got.Contents[2]
	if tr.Role != "user" {
		t.Errorf("tool-result role = %q, want user", tr.Role)
	}
	if len(tr.Parts) != 1 || tr.Parts[0].FunctionResponse == nil {
		t.Fatalf("expected functionResponse part, got %+v", tr.Parts)
	}
	fr := tr.Parts[0].FunctionResponse
	if fr.Name != "Bash" {
		t.Errorf("fnResponse.name = %q, want Bash (synth-id prefix stripped)", fr.Name)
	}
	if fr.Response["result"] != "file1.txt\nfile2.txt" {
		t.Errorf("fnResponse.response.result = %v", fr.Response["result"])
	}
	// And the assistant turn should be role=model with a functionCall part.
	asst := got.Contents[1]
	if asst.Role != "model" {
		t.Errorf("assistant role = %q, want model", asst.Role)
	}
	if len(asst.Parts) != 1 || asst.Parts[0].FunctionCall == nil {
		t.Fatalf("expected functionCall part, got %+v", asst.Parts)
	}
	if asst.Parts[0].FunctionCall.Name != "Bash" {
		t.Errorf("fnCall.name = %q", asst.Parts[0].FunctionCall.Name)
	}
}

func TestGeminiBuildRequestToolDeclarations(t *testing.T) {
	p := &GeminiProvider{Model: "m"}
	tools := []Tool{
		{Name: "Bash", Description: "run a shell command", InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"cmd": map[string]any{"type": "string"},
			},
		}},
	}
	body, err := p.BuildRequest([]Message{{Role: "user", Content: "hi"}}, tools, RequestOpts{})
	if err != nil {
		t.Fatalf("BuildRequest: %v", err)
	}
	var got geminiRequest
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(got.Tools) != 1 || len(got.Tools[0].FunctionDeclarations) != 1 {
		t.Fatalf("tools shape wrong: %+v", got.Tools)
	}
	d := got.Tools[0].FunctionDeclarations[0]
	if d.Name != "Bash" || d.Description != "run a shell command" {
		t.Errorf("declaration mismatch: %+v", d)
	}
	if d.Parameters["type"] != "object" {
		t.Errorf("parameters not propagated: %+v", d.Parameters)
	}
}

func TestGeminiStreamSimpleText(t *testing.T) {
	// Two text chunks, then a STOP frame.
	wire := strings.Join([]string{
		`data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]}}]}`,
		"",
		`data: {"candidates":[{"content":{"parts":[{"text":" world"}]}}]}`,
		"",
		`data: {"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}]}`,
		"",
		"",
	}, "\n")

	p := &GeminiProvider{Model: "m"}
	// Bump turn counter once (Stream reads p.turn-1).
	_, _ = p.BuildRequest(nil, nil, RequestOpts{})
	got, toolCalls, done, err := drainStream(t, p, wire)
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if len(toolCalls) != 0 {
		t.Errorf("toolCalls = %+v, want none", toolCalls)
	}
	if !done {
		t.Errorf("done = false, want true")
	}
	// Expect 2 delta chunks.
	deltas := 0
	combined := ""
	for _, c := range got {
		if c.Type == ChunkTypeDelta {
			deltas++
			combined += c.Delta
		}
	}
	if deltas != 2 {
		t.Errorf("delta count = %d, want 2 (got %+v)", deltas, got)
	}
	if combined != "Hello world" {
		t.Errorf("combined deltas = %q, want %q", combined, "Hello world")
	}
}

func TestGeminiStreamWithFunctionCall(t *testing.T) {
	wire := strings.Join([]string{
		`data: {"candidates":[{"content":{"parts":[{"text":"calling tool now"}]}}]}`,
		"",
		`data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"WebSearch","args":{"q":"hello"}}}]}}]}`,
		"",
		`data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"WebSearch","args":{"q":"world"}}}]},"finishReason":"TOOL_USE"}]}`,
		"",
		"",
	}, "\n")

	p := &GeminiProvider{Model: "m"}
	_, _ = p.BuildRequest(nil, nil, RequestOpts{})
	got, toolCalls, done, err := drainStream(t, p, wire)
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if !done {
		t.Errorf("done = false, want true (TOOL_USE finishReason)")
	}
	if len(toolCalls) != 2 {
		t.Fatalf("toolCalls = %d, want 2 (%+v)", len(toolCalls), toolCalls)
	}
	// Both should have the same name but DIFFERENT synth ids.
	if toolCalls[0].ID == toolCalls[1].ID {
		t.Errorf("synth ids collide: %q == %q", toolCalls[0].ID, toolCalls[1].ID)
	}
	if !strings.HasPrefix(toolCalls[0].ID, "WebSearch#") {
		t.Errorf("synth id format wrong: %q", toolCalls[0].ID)
	}
	if toolCalls[0].Input["q"] != "hello" || toolCalls[1].Input["q"] != "world" {
		t.Errorf("args not propagated: %+v / %+v", toolCalls[0].Input, toolCalls[1].Input)
	}
	// Verify ChunkTypeToolUse was also emitted alongside the delta.
	sawToolUse := 0
	sawDelta := 0
	for _, c := range got {
		switch c.Type {
		case ChunkTypeToolUse:
			sawToolUse++
		case ChunkTypeDelta:
			sawDelta++
		}
	}
	if sawToolUse != 2 {
		t.Errorf("tool_use chunks = %d, want 2", sawToolUse)
	}
	if sawDelta != 1 {
		t.Errorf("delta chunks = %d, want 1", sawDelta)
	}
}

func TestGeminiStreamSynthIdStableAcrossTurns(t *testing.T) {
	// Two consecutive stream invocations should produce different
	// synth-id prefixes because turn increments.
	p := &GeminiProvider{Model: "m"}
	wire := `data: {"candidates":[{"content":{"parts":[{"functionCall":{"name":"X","args":{}}}]},"finishReason":"TOOL_USE"}]}` + "\n\n"

	_, _ = p.BuildRequest(nil, nil, RequestOpts{})
	_, tc1, _, _ := drainStream(t, p, wire)
	_, _ = p.BuildRequest(nil, nil, RequestOpts{})
	_, tc2, _, _ := drainStream(t, p, wire)

	if len(tc1) != 1 || len(tc2) != 1 {
		t.Fatalf("expected 1 tool call per turn, got %d / %d", len(tc1), len(tc2))
	}
	if tc1[0].ID == tc2[0].ID {
		t.Errorf("synth ids should differ across turns: both %q", tc1[0].ID)
	}
}

func TestGeminiBuildRequestStashesModel(t *testing.T) {
	// If the caller forgets to set p.Model but passes opts.Model,
	// BuildRequest should stash it so Endpoint() works.
	p := &GeminiProvider{}
	_, err := p.BuildRequest(nil, nil, RequestOpts{Model: "gemini-2.5-pro"})
	if err != nil {
		t.Fatalf("BuildRequest: %v", err)
	}
	if !strings.Contains(p.Endpoint(), "gemini-2.5-pro") {
		t.Errorf("Endpoint did not pick up stashed model: %q", p.Endpoint())
	}
}

// ── Usage parsing tests ────────────────────────────────────────────────────

// TestGeminiUsageHappyPath verifies usageMetadata is parsed and
// the final reading lands in provider.Usage(). Gemini reports
// cumulative-context totals on every chunk, so the LAST seen
// values win.
func TestGeminiUsageHappyPath(t *testing.T) {
	wire := strings.Join([]string{
		`data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}],"usageMetadata":{"promptTokenCount":100,"candidatesTokenCount":5,"cachedContentTokenCount":20}}`,
		"",
		// Final chunk's usageMetadata has the FULL totals — it wins.
		`data: {"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}],"usageMetadata":{"promptTokenCount":120,"candidatesTokenCount":42,"cachedContentTokenCount":25}}`,
		"",
		"",
	}, "\n")

	p := &GeminiProvider{Model: "m"}
	_, _ = p.BuildRequest(nil, nil, RequestOpts{})
	_, _, _, err := drainStream(t, p, wire)
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	got := p.Usage()
	want := Usage{InputTokens: 120, OutputTokens: 42, CacheReadTokens: 25}
	if got != want {
		t.Errorf("Usage = %+v, want %+v", got, want)
	}
}

// TestGeminiUsageAbsent confirms a usage-less stream produces zero
// Usage and doesn't panic.
func TestGeminiUsageAbsent(t *testing.T) {
	wire := strings.Join([]string{
		`data: {"candidates":[{"content":{"parts":[{"text":"hi"}]}}]}`,
		"",
		`data: {"candidates":[{"content":{"parts":[]},"finishReason":"STOP"}]}`,
		"",
		"",
	}, "\n")
	p := &GeminiProvider{Model: "m"}
	_, _ = p.BuildRequest(nil, nil, RequestOpts{})
	_, _, _, err := drainStream(t, p, wire)
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if !p.Usage().IsZero() {
		t.Errorf("Usage = %+v, want zero (no usageMetadata)", p.Usage())
	}
}

// TestGeminiResetUsage verifies that ResetUsage clears prior state.
func TestGeminiResetUsage(t *testing.T) {
	p := &GeminiProvider{Model: "m"}
	p.setGeminiUsage(&geminiUsageMetadata{
		PromptTokenCount:        50,
		CandidatesTokenCount:    25,
		CachedContentTokenCount: 10,
	})
	if p.Usage().IsZero() {
		t.Fatal("setup failed")
	}
	p.ResetUsage()
	if !p.Usage().IsZero() {
		t.Errorf("after ResetUsage, Usage = %+v, want zero", p.Usage())
	}
}
