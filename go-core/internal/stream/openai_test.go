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

// ── Test helpers ────────────────────────────────────────────────────────────

// sseServer returns an httptest.Server that streams the given frames
// as SSE. Each frame becomes one event terminated by a blank line. If
// the frame contains internal newlines (multi-line JSON for readability
// in the test source), each line is prefixed with `data:` so the SSE
// spec is honoured — otherwise only the first line would carry data.
// A trailing `data: [DONE]` event is appended automatically.
func sseServer(t *testing.T, frames []string) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/v1/chat/completions", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)
		for _, f := range frames {
			for _, line := range strings.Split(f, "\n") {
				_, _ = io.WriteString(w, "data: "+line+"\n")
			}
			_, _ = io.WriteString(w, "\n")
			if flusher != nil {
				flusher.Flush()
			}
		}
		_, _ = io.WriteString(w, "data: [DONE]\n\n")
		if flusher != nil {
			flusher.Flush()
		}
	})
	return httptest.NewServer(mux)
}

// runStream is the per-turn driver: POST to provider.Endpoint() and
// hand the response to provider.Stream. Mirrors what loop.Run does.
func runStream(t *testing.T, p *OpenAIProvider, apiKey string, body []byte, emit EmitFn) ([]ToolUseChunk, bool, error) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, p.Endpoint(), strings.NewReader(string(body)))
	if err != nil {
		t.Fatalf("new request: %v", err)
	}
	for k, vv := range p.Headers(apiKey) {
		req.Header[k] = vv
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("http: %v", err)
	}
	defer resp.Body.Close()
	return p.Stream(context.Background(), resp.Body, emit)
}

// ── Tests ───────────────────────────────────────────────────────────────────

func TestOpenAIHeaders(t *testing.T) {
	p := &OpenAIProvider{}
	h := p.Headers("sk-test-123")
	if got := h.Get("Authorization"); got != "Bearer sk-test-123" {
		t.Errorf("Authorization = %q, want %q", got, "Bearer sk-test-123")
	}
	if got := h.Get("Content-Type"); got != "application/json" {
		t.Errorf("Content-Type = %q", got)
	}
	if got := h.Get("Accept"); got != "text/event-stream" {
		t.Errorf("Accept = %q", got)
	}

	// Empty key should omit Authorization entirely.
	h2 := p.Headers("")
	if got := h2.Get("Authorization"); got != "" {
		t.Errorf("empty key produced Authorization=%q", got)
	}
}

func TestOpenAIEndpointDefault(t *testing.T) {
	p := &OpenAIProvider{}
	if got := p.Endpoint(); got != "https://api.openai.com/v1/chat/completions" {
		t.Errorf("default Endpoint = %q", got)
	}

	p2 := &OpenAIProvider{BaseURL: "https://openrouter.ai/api/"}
	if got := p2.Endpoint(); got != "https://openrouter.ai/api/v1/chat/completions" {
		t.Errorf("custom Endpoint with trailing slash = %q", got)
	}
}

func TestOpenAIBuildRequestShape(t *testing.T) {
	p := &OpenAIProvider{Model: "gpt-4o-mini"}
	msgs := []Message{
		{Role: "user", Content: "what's the weather?"},
	}
	tools := []Tool{
		{
			Name:        "get_weather",
			Description: "Look up weather for a city",
			InputSchema: map[string]any{
				"type": "object",
				"properties": map[string]any{
					"city": map[string]any{"type": "string"},
				},
			},
		},
	}
	body, err := p.BuildRequest(msgs, tools, RequestOpts{System: "You are helpful.", MaxTokens: 256, Stream: true})
	if err != nil {
		t.Fatalf("BuildRequest: %v", err)
	}

	var got map[string]any
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v\nbody=%s", err, body)
	}

	if got["model"] != "gpt-4o-mini" {
		t.Errorf("model = %v", got["model"])
	}
	if got["stream"] != true {
		t.Errorf("stream = %v, want true", got["stream"])
	}
	if got["max_tokens"].(float64) != 256 {
		t.Errorf("max_tokens = %v", got["max_tokens"])
	}

	gotMsgs := got["messages"].([]any)
	if len(gotMsgs) != 2 {
		t.Fatalf("messages len = %d, want 2 (system + user)", len(gotMsgs))
	}
	sys := gotMsgs[0].(map[string]any)
	if sys["role"] != "system" || sys["content"] != "You are helpful." {
		t.Errorf("system msg = %+v", sys)
	}
	usr := gotMsgs[1].(map[string]any)
	if usr["role"] != "user" || usr["content"] != "what's the weather?" {
		t.Errorf("user msg = %+v", usr)
	}

	gotTools := got["tools"].([]any)
	if len(gotTools) != 1 {
		t.Fatalf("tools len = %d, want 1", len(gotTools))
	}
	tool := gotTools[0].(map[string]any)
	if tool["type"] != "function" {
		t.Errorf("tool.type = %v", tool["type"])
	}
	fn := tool["function"].(map[string]any)
	if fn["name"] != "get_weather" || fn["description"] != "Look up weather for a city" {
		t.Errorf("function = %+v", fn)
	}
	if _, ok := fn["parameters"]; !ok {
		t.Errorf("function.parameters missing: %+v", fn)
	}
}

func TestOpenAIBuildRequestModelOverride(t *testing.T) {
	p := &OpenAIProvider{Model: "default-model"}
	body, err := p.BuildRequest(nil, nil, RequestOpts{Model: "override-model"})
	if err != nil {
		t.Fatalf("BuildRequest: %v", err)
	}
	var got map[string]any
	_ = json.Unmarshal(body, &got)
	if got["model"] != "override-model" {
		t.Errorf("opts.Model should override; got %v", got["model"])
	}
}

func TestOpenAIBuildRequestNoModel(t *testing.T) {
	p := &OpenAIProvider{}
	if _, err := p.BuildRequest(nil, nil, RequestOpts{}); err == nil {
		t.Error("expected error when no model configured")
	}
}

func TestOpenAIBuildRequestAssistantToolCall(t *testing.T) {
	// Verify that an assistant message that called tools gets serialised
	// with the right tool_calls array, and that tool messages carry
	// tool_call_id as required by the OpenAI spec.
	p := &OpenAIProvider{Model: "gpt-4o"}
	msgs := []Message{
		{Role: "user", Content: "ls"},
		{
			Role: "assistant",
			ToolCalls: []ToolUseChunk{
				{ID: "call_abc", Name: "Bash", Input: map[string]any{"command": "ls"}},
			},
		},
		{Role: "tool", Content: "file1.txt", ToolCallID: "call_abc"},
	}
	body, err := p.BuildRequest(msgs, nil, RequestOpts{})
	if err != nil {
		t.Fatalf("BuildRequest: %v", err)
	}
	var got map[string]any
	_ = json.Unmarshal(body, &got)
	gotMsgs := got["messages"].([]any)
	if len(gotMsgs) != 3 {
		t.Fatalf("messages len = %d", len(gotMsgs))
	}

	asst := gotMsgs[1].(map[string]any)
	tcs := asst["tool_calls"].([]any)
	if len(tcs) != 1 {
		t.Fatalf("assistant tool_calls len = %d", len(tcs))
	}
	tc := tcs[0].(map[string]any)
	if tc["id"] != "call_abc" || tc["type"] != "function" {
		t.Errorf("tool_call = %+v", tc)
	}
	fn := tc["function"].(map[string]any)
	if fn["name"] != "Bash" {
		t.Errorf("function.name = %v", fn["name"])
	}
	// arguments must be a JSON-encoded STRING, not a nested object.
	argsStr, ok := fn["arguments"].(string)
	if !ok {
		t.Fatalf("function.arguments must be string; got %T = %v", fn["arguments"], fn["arguments"])
	}
	var argsParsed map[string]any
	if err := json.Unmarshal([]byte(argsStr), &argsParsed); err != nil {
		t.Errorf("function.arguments not valid JSON: %v (got %q)", err, argsStr)
	}
	if argsParsed["command"] != "ls" {
		t.Errorf("argsParsed = %+v", argsParsed)
	}

	toolMsg := gotMsgs[2].(map[string]any)
	if toolMsg["role"] != "tool" || toolMsg["tool_call_id"] != "call_abc" {
		t.Errorf("tool message = %+v", toolMsg)
	}
}

func TestOpenAIStreamSimpleText(t *testing.T) {
	frames := []string{
		`{"choices":[{"delta":{"content":"Hello"}}]}`,
		`{"choices":[{"delta":{"content":" world"}}]}`,
		`{"choices":[{"delta":{},"finish_reason":"stop"}]}`,
	}
	srv := sseServer(t, frames)
	defer srv.Close()

	p := &OpenAIProvider{BaseURL: srv.URL, Model: "test-model"}
	body, err := p.BuildRequest([]Message{{Role: "user", Content: "hi"}}, nil, RequestOpts{})
	if err != nil {
		t.Fatalf("BuildRequest: %v", err)
	}
	var emitted []Chunk
	calls, done, err := runStream(t, p, "key", body, func(c Chunk) { emitted = append(emitted, c) })
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if !done {
		t.Error("done = false, want true")
	}
	if len(calls) != 0 {
		t.Errorf("toolCalls = %+v, want empty", calls)
	}
	if len(emitted) != 2 {
		t.Fatalf("emit count = %d (got %+v)", len(emitted), emitted)
	}
	if emitted[0].Type != ChunkTypeDelta || emitted[0].Delta != "Hello" {
		t.Errorf("emit[0] = %+v", emitted[0])
	}
	if emitted[1].Delta != " world" {
		t.Errorf("emit[1] = %+v", emitted[1])
	}
	if emitted[0].Provider != "openai" {
		t.Errorf("provider tag = %q", emitted[0].Provider)
	}
}

func TestOpenAIStreamWithToolCall(t *testing.T) {
	// Tool calls come in across three SSE frames:
	//   1. id + name + first slice of args ("{\"command\":")
	//   2. more args ("\"ls -la\"}")
	//   3. finish_reason=tool_calls
	frames := []string{
		`{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_xyz","function":{"name":"Bash","arguments":"{\"command\":"}}]}}]}`,
		`{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"ls -la\"}"}}]}}]}`,
		`{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
	}
	srv := sseServer(t, frames)
	defer srv.Close()

	p := &OpenAIProvider{BaseURL: srv.URL, Model: "test-model"}
	body, _ := p.BuildRequest([]Message{{Role: "user", Content: "list files"}}, nil, RequestOpts{})
	var emitted []Chunk
	calls, done, err := runStream(t, p, "key", body, func(c Chunk) { emitted = append(emitted, c) })
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if !done {
		t.Error("done should be true even when tool_calls fired (loop.go decides whether to continue)")
	}
	if len(calls) != 1 {
		t.Fatalf("toolCalls len = %d, want 1 (got %+v)", len(calls), calls)
	}
	tc := calls[0]
	if tc.ID != "call_xyz" {
		t.Errorf("id = %q", tc.ID)
	}
	if tc.Name != "Bash" {
		t.Errorf("name = %q", tc.Name)
	}
	if tc.Input["command"] != "ls -la" {
		t.Errorf("input.command = %v (full input: %+v)", tc.Input["command"], tc.Input)
	}
	// No text deltas emitted on a pure-tool-call response.
	for _, c := range emitted {
		if c.Type == ChunkTypeDelta {
			t.Errorf("unexpected delta on tool-call response: %+v", c)
		}
	}
}

func TestOpenAIStreamMultipleToolCalls(t *testing.T) {
	// Two tool calls in parallel — one at index=0, one at index=1.
	// Verify the accumulator buffers them independently and the
	// returned slice is ordered by index.
	frames := []string{
		`{"choices":[{"delta":{"tool_calls":[
			{"index":0,"id":"a","function":{"name":"X","arguments":"{}"}},
			{"index":1,"id":"b","function":{"name":"Y","arguments":"{\"k\":1}"}}
		]}}]}`,
		`{"choices":[{"delta":{},"finish_reason":"tool_calls"}]}`,
	}
	srv := sseServer(t, frames)
	defer srv.Close()

	p := &OpenAIProvider{BaseURL: srv.URL, Model: "test-model"}
	body, _ := p.BuildRequest(nil, nil, RequestOpts{Model: "test-model"})
	calls, _, err := runStream(t, p, "k", body, func(Chunk) {})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if len(calls) != 2 {
		t.Fatalf("got %d calls, want 2: %+v", len(calls), calls)
	}
	if calls[0].ID != "a" || calls[0].Name != "X" {
		t.Errorf("call 0 = %+v", calls[0])
	}
	if calls[1].ID != "b" || calls[1].Name != "Y" || calls[1].Input["k"].(float64) != 1 {
		t.Errorf("call 1 = %+v", calls[1])
	}
}

func TestOpenAIStreamReasoningContent(t *testing.T) {
	// DeepSeek-style reasoning_content in delta should surface as a
	// reasoning chunk, not a regular delta.
	frames := []string{
		`{"choices":[{"delta":{"reasoning_content":"thinking..."}}]}`,
		`{"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}`,
	}
	srv := sseServer(t, frames)
	defer srv.Close()

	p := &OpenAIProvider{BaseURL: srv.URL, Model: "test-model"}
	body, _ := p.BuildRequest(nil, nil, RequestOpts{Model: "test-model"})
	var emitted []Chunk
	_, _, err := runStream(t, p, "k", body, func(c Chunk) { emitted = append(emitted, c) })
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if len(emitted) != 2 {
		t.Fatalf("emit count = %d (%+v)", len(emitted), emitted)
	}
	if emitted[0].Type != ChunkTypeReasoning || emitted[0].Reasoning != "thinking..." {
		t.Errorf("first chunk should be reasoning: %+v", emitted[0])
	}
	if emitted[1].Type != ChunkTypeDelta || emitted[1].Delta != "answer" {
		t.Errorf("second chunk should be delta: %+v", emitted[1])
	}
}

func TestOpenAIStreamSkipsMalformedFrames(t *testing.T) {
	frames := []string{
		`not-json`,
		`{"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}`,
	}
	srv := sseServer(t, frames)
	defer srv.Close()

	p := &OpenAIProvider{BaseURL: srv.URL, Model: "m"}
	body, _ := p.BuildRequest(nil, nil, RequestOpts{Model: "m"})
	var emitted []Chunk
	_, done, err := runStream(t, p, "k", body, func(c Chunk) { emitted = append(emitted, c) })
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if !done {
		t.Error("done = false")
	}
	if len(emitted) != 1 || emitted[0].Delta != "ok" {
		t.Errorf("emitted = %+v", emitted)
	}
}

func TestOpenAIStreamProviderError(t *testing.T) {
	// OpenRouter-style error embedded in the SSE body.
	frames := []string{
		`{"error":{"message":"rate limited","code":429}}`,
	}
	srv := sseServer(t, frames)
	defer srv.Close()

	p := &OpenAIProvider{BaseURL: srv.URL, Model: "m"}
	body, _ := p.BuildRequest(nil, nil, RequestOpts{Model: "m"})
	_, _, err := runStream(t, p, "k", body, func(Chunk) {})
	if err == nil {
		t.Fatal("expected error from embedded SSE error")
	}
	if !strings.Contains(err.Error(), "rate limited") {
		t.Errorf("err = %v, want it to mention 'rate limited'", err)
	}
}

// ── Usage parsing tests ────────────────────────────────────────────────────

// TestOpenAIBuildRequestIncludesStreamOptions confirms the request
// body opts into the final usage frame so the parser has something
// to read.
func TestOpenAIBuildRequestIncludesStreamOptions(t *testing.T) {
	p := &OpenAIProvider{Model: "gpt-4o"}
	body, err := p.BuildRequest(nil, nil, RequestOpts{Model: "gpt-4o"})
	if err != nil {
		t.Fatalf("BuildRequest: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(body, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	so, ok := got["stream_options"].(map[string]any)
	if !ok {
		t.Fatalf("stream_options missing; body = %s", body)
	}
	if iu, _ := so["include_usage"].(bool); !iu {
		t.Errorf("stream_options.include_usage = %v, want true", so["include_usage"])
	}
}

// TestOpenAIUsageHappyPath verifies the final usage frame is parsed
// and folded into provider.Usage() with the NET-input convention
// (prompt minus cached).
func TestOpenAIUsageHappyPath(t *testing.T) {
	frames := []string{
		`{"choices":[{"delta":{"content":"hi"}}]}`,
		`{"choices":[{"delta":{},"finish_reason":"stop"}]}`,
		// Final usage frame — empty choices, populated usage.
		`{"choices":[],"usage":{"prompt_tokens":200,"completion_tokens":80,"total_tokens":280,"prompt_tokens_details":{"cached_tokens":50}}}`,
	}
	srv := sseServer(t, frames)
	defer srv.Close()

	p := &OpenAIProvider{BaseURL: srv.URL, Model: "m"}
	body, _ := p.BuildRequest(nil, nil, RequestOpts{Model: "m"})
	if _, _, err := runStream(t, p, "k", body, func(Chunk) {}); err != nil {
		t.Fatalf("Stream: %v", err)
	}
	got := p.Usage()
	// NET input = 200 - 50 = 150 (matches the JS bridge convention).
	want := Usage{InputTokens: 150, OutputTokens: 80, CacheReadTokens: 50}
	if got != want {
		t.Errorf("Usage = %+v, want %+v", got, want)
	}
}

// TestOpenAIUsageAbsent confirms a stream without a usage frame
// produces zero Usage and doesn't panic.
func TestOpenAIUsageAbsent(t *testing.T) {
	frames := []string{
		`{"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}`,
	}
	srv := sseServer(t, frames)
	defer srv.Close()
	p := &OpenAIProvider{BaseURL: srv.URL, Model: "m"}
	body, _ := p.BuildRequest(nil, nil, RequestOpts{Model: "m"})
	if _, _, err := runStream(t, p, "k", body, func(Chunk) {}); err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if !p.Usage().IsZero() {
		t.Errorf("Usage = %+v, want zero", p.Usage())
	}
}

// TestOpenAIUsageWithoutCacheBreakdown confirms a usage frame missing
// prompt_tokens_details still produces sane numbers (all of
// prompt_tokens lands in InputTokens, CacheRead stays zero).
func TestOpenAIUsageWithoutCacheBreakdown(t *testing.T) {
	frames := []string{
		`{"choices":[{"delta":{"content":"x"},"finish_reason":"stop"}]}`,
		`{"choices":[],"usage":{"prompt_tokens":300,"completion_tokens":60,"total_tokens":360}}`,
	}
	srv := sseServer(t, frames)
	defer srv.Close()
	p := &OpenAIProvider{BaseURL: srv.URL, Model: "m"}
	body, _ := p.BuildRequest(nil, nil, RequestOpts{Model: "m"})
	if _, _, err := runStream(t, p, "k", body, func(Chunk) {}); err != nil {
		t.Fatalf("Stream: %v", err)
	}
	got := p.Usage()
	want := Usage{InputTokens: 300, OutputTokens: 60}
	if got != want {
		t.Errorf("Usage = %+v, want %+v", got, want)
	}
}

// TestOpenAIResetUsage verifies that ResetUsage clears prior state.
func TestOpenAIResetUsage(t *testing.T) {
	p := &OpenAIProvider{Model: "m"}
	p.addOpenAIUsage(&oaStreamUsage{PromptTokens: 100, CompletionTokens: 50})
	if p.Usage().IsZero() {
		t.Fatal("setup failed; expected non-zero")
	}
	p.ResetUsage()
	if !p.Usage().IsZero() {
		t.Errorf("after ResetUsage, Usage = %+v, want zero", p.Usage())
	}
}
