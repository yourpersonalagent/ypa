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

// ── Helpers ────────────────────────────────────────────────────────────────

// anthropicSSE builds a fake SSE response body from a slice of
// (event, data) pairs. Tests pipe this through httptest so the
// AnthropicProvider runs against the same Reader plumbing as
// production. Frames are formatted exactly as the Anthropic API does:
// `event: <name>\ndata: <json>\n\n`.
func anthropicSSE(events ...[2]string) string {
	var sb strings.Builder
	for _, ev := range events {
		if ev[0] != "" {
			sb.WriteString("event: ")
			sb.WriteString(ev[0])
			sb.WriteString("\n")
		}
		sb.WriteString("data: ")
		sb.WriteString(ev[1])
		sb.WriteString("\n\n")
	}
	return sb.String()
}

// runAnthropicStream is a one-shot helper: stand up a server returning `body`,
// run AnthropicProvider.Stream on the response body, return the
// emitted chunks plus the tool calls / done flag from the parser.
func runAnthropicStream(t *testing.T, body string) ([]Chunk, []ToolUseChunk, bool, error) {
	t.Helper()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)

	resp, err := http.Get(srv.URL)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()

	var got []Chunk
	emit := func(c Chunk) { got = append(got, c) }
	p := &AnthropicProvider{Model: "claude-test"}
	tcs, done, err := p.Stream(context.Background(), resp.Body, emit)
	return got, tcs, done, err
}

// ── Streaming tests ────────────────────────────────────────────────────────

func TestStreamSimpleText(t *testing.T) {
	body := anthropicSSE(
		[2]string{"message_start", `{"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":10}}}`},
		[2]string{"content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`},
		[2]string{"content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}`},
		[2]string{"content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}`},
		[2]string{"content_block_stop", `{"type":"content_block_stop","index":0}`},
		[2]string{"message_delta", `{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}`},
		[2]string{"message_stop", `{"type":"message_stop"}`},
	)
	got, tcs, done, err := runAnthropicStream(t, body)
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if !done {
		t.Error("done = false, want true")
	}
	if len(tcs) != 0 {
		t.Errorf("toolCalls = %d, want 0", len(tcs))
	}
	// Expect exactly two delta chunks, both with provider tag.
	deltas := []string{}
	for _, c := range got {
		if c.Type == ChunkTypeDelta {
			deltas = append(deltas, c.Delta)
			if c.Provider != "anthropic" {
				t.Errorf("delta chunk has provider=%q, want anthropic", c.Provider)
			}
		}
	}
	if len(deltas) != 2 || deltas[0] != "Hello" || deltas[1] != " world" {
		t.Errorf("deltas = %+v, want [Hello, world]", deltas)
	}
}

func TestStreamWithToolUse(t *testing.T) {
	// tool_use input is split across multiple input_json_delta frames —
	// the provider must concatenate and JSON-parse at content_block_stop.
	body := anthropicSSE(
		[2]string{"message_start", `{"type":"message_start","message":{}}`},
		[2]string{"content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"Bash","input":{}}}`},
		[2]string{"content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"command\":"}}`},
		[2]string{"content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\"ls -la\"}"}}`},
		[2]string{"content_block_stop", `{"type":"content_block_stop","index":0}`},
		[2]string{"message_delta", `{"type":"message_delta","delta":{"stop_reason":"tool_use"}}`},
		[2]string{"message_stop", `{"type":"message_stop"}`},
	)
	got, tcs, done, err := runAnthropicStream(t, body)
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if !done {
		t.Error("done = false, want true")
	}
	if len(tcs) != 1 {
		t.Fatalf("toolCalls = %d, want 1 (got %+v)", len(tcs), tcs)
	}
	if tcs[0].ID != "toolu_1" || tcs[0].Name != "Bash" {
		t.Errorf("tool call meta = %+v", tcs[0])
	}
	cmd, _ := tcs[0].Input["command"].(string)
	if cmd != "ls -la" {
		t.Errorf("input.command = %q, want \"ls -la\"", cmd)
	}
	// A ChunkTypeToolUse should have been emitted alongside.
	var toolUseChunks int
	for _, c := range got {
		if c.Type == ChunkTypeToolUse {
			toolUseChunks++
			if c.ToolUse == nil || c.ToolUse.Name != "Bash" {
				t.Errorf("emitted tool_use chunk = %+v", c)
			}
		}
	}
	if toolUseChunks != 1 {
		t.Errorf("emitted %d ChunkTypeToolUse, want 1", toolUseChunks)
	}
}

func TestStreamWithThinking(t *testing.T) {
	// A thinking block, then a text block in the same turn.
	body := anthropicSSE(
		[2]string{"message_start", `{"type":"message_start","message":{}}`},
		[2]string{"content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}`},
		[2]string{"content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me think"}}`},
		[2]string{"content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":" carefully."}}`},
		[2]string{"content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig_xyz"}}`},
		[2]string{"content_block_stop", `{"type":"content_block_stop","index":0}`},
		[2]string{"content_block_start", `{"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}`},
		[2]string{"content_block_delta", `{"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"OK."}}`},
		[2]string{"content_block_stop", `{"type":"content_block_stop","index":1}`},
		[2]string{"message_delta", `{"type":"message_delta","delta":{"stop_reason":"end_turn"}}`},
		[2]string{"message_stop", `{"type":"message_stop"}`},
	)
	got, tcs, done, err := runAnthropicStream(t, body)
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if !done {
		t.Error("done = false, want true")
	}
	if len(tcs) != 0 {
		t.Errorf("toolCalls = %d, want 0", len(tcs))
	}
	var reasoning, deltas []string
	for _, c := range got {
		switch c.Type {
		case ChunkTypeReasoning:
			reasoning = append(reasoning, c.Reasoning)
		case ChunkTypeDelta:
			deltas = append(deltas, c.Delta)
		}
	}
	if len(reasoning) != 2 || reasoning[0] != "Let me think" || reasoning[1] != " carefully." {
		t.Errorf("reasoning chunks = %+v, want [Let me think,  carefully.]", reasoning)
	}
	if len(deltas) != 1 || deltas[0] != "OK." {
		t.Errorf("delta chunks = %+v, want [OK.]", deltas)
	}
}

func TestStreamSurfacesError(t *testing.T) {
	// Anthropic can inject an `error` event mid-stream; we should bail.
	body := anthropicSSE(
		[2]string{"message_start", `{"type":"message_start","message":{}}`},
		[2]string{"error", `{"type":"error","error":{"type":"overloaded_error","message":"server busy"}}`},
	)
	_, _, _, err := runAnthropicStream(t, body)
	if err == nil {
		t.Fatal("expected error from in-stream error event")
	}
	if !strings.Contains(err.Error(), "server busy") {
		t.Errorf("err = %v, want it to contain \"server busy\"", err)
	}
}

// ── BuildRequest tests ─────────────────────────────────────────────────────

func TestBuildRequestSystemMessage(t *testing.T) {
	p := &AnthropicProvider{Model: "claude-test"}
	msgs := []Message{
		{Role: "system", Content: "You are a helpful assistant."},
		{Role: "user", Content: "Hi"},
	}
	body, err := p.BuildRequest(msgs, nil, RequestOpts{})
	if err != nil {
		t.Fatalf("BuildRequest: %v", err)
	}
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	sys, _ := out["system"].(string)
	if sys != "You are a helpful assistant." {
		t.Errorf("system = %q, want top-level system field", sys)
	}
	// messages array must contain only the user turn — no role=system.
	msgsOut, _ := out["messages"].([]any)
	if len(msgsOut) != 1 {
		t.Fatalf("messages count = %d, want 1 (system should not appear in array)", len(msgsOut))
	}
	if r := msgsOut[0].(map[string]any)["role"]; r != "user" {
		t.Errorf("messages[0].role = %v, want user", r)
	}
	// max_tokens default = 4096.
	if mt := intFromJSON(out["max_tokens"]); mt != 4096 {
		t.Errorf("max_tokens = %d, want default 4096", mt)
	}
	// stream must be true.
	if s, _ := out["stream"].(bool); !s {
		t.Error("stream != true")
	}
}

func TestBuildRequestToolResult(t *testing.T) {
	p := &AnthropicProvider{Model: "claude-test"}
	msgs := []Message{
		{Role: "user", Content: "List files"},
		{Role: "assistant", ToolCalls: []ToolUseChunk{{ID: "toolu_1", Name: "Bash", Input: map[string]any{"command": "ls"}}}},
		{Role: "tool", ToolCallID: "toolu_1", Content: "file1.txt\nfile2.txt"},
	}
	body, err := p.BuildRequest(msgs, nil, RequestOpts{System: "Be brief."})
	if err != nil {
		t.Fatalf("BuildRequest: %v", err)
	}
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if s, _ := out["system"].(string); s != "Be brief." {
		t.Errorf("system = %q, want \"Be brief.\"", s)
	}
	msgsOut, _ := out["messages"].([]any)
	if len(msgsOut) != 3 {
		t.Fatalf("messages = %d, want 3", len(msgsOut))
	}

	// Last message: role=user, content=[tool_result block].
	last := msgsOut[2].(map[string]any)
	if last["role"] != "user" {
		t.Errorf("tool message role = %v, want user (Anthropic translates tool→user)", last["role"])
	}
	contentArr, ok := last["content"].([]any)
	if !ok || len(contentArr) != 1 {
		t.Fatalf("tool message content = %+v, want []block of length 1", last["content"])
	}
	block := contentArr[0].(map[string]any)
	if block["type"] != "tool_result" {
		t.Errorf("block type = %v, want tool_result", block["type"])
	}
	if block["tool_use_id"] != "toolu_1" {
		t.Errorf("tool_use_id = %v, want toolu_1", block["tool_use_id"])
	}
	if !strings.Contains(block["content"].(string), "file1.txt") {
		t.Errorf("tool_result content = %v, want it to include file1.txt", block["content"])
	}

	// Middle message: role=assistant, content=[tool_use block].
	mid := msgsOut[1].(map[string]any)
	midContent, ok := mid["content"].([]any)
	if !ok || len(midContent) != 1 {
		t.Fatalf("assistant message content = %+v, want []block of length 1", mid["content"])
	}
	tuBlock := midContent[0].(map[string]any)
	if tuBlock["type"] != "tool_use" {
		t.Errorf("assistant block type = %v, want tool_use", tuBlock["type"])
	}
	if tuBlock["id"] != "toolu_1" || tuBlock["name"] != "Bash" {
		t.Errorf("assistant tool_use block = %+v", tuBlock)
	}
}

func TestBuildRequestToolsAndThinking(t *testing.T) {
	p := &AnthropicProvider{Model: "claude-opus-4-7"}
	tools := []Tool{
		{Name: "Bash", Description: "Run a command", InputSchema: map[string]any{"type": "object"}},
	}
	body, err := p.BuildRequest(
		[]Message{{Role: "user", Content: "Hi"}},
		tools,
		RequestOpts{Effort: "high", MaxTokens: 8192},
	)
	if err != nil {
		t.Fatalf("BuildRequest: %v", err)
	}
	var out map[string]any
	if err := json.Unmarshal(body, &out); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	// Tools: must use "input_schema" (NOT "parameters").
	toolsOut, _ := out["tools"].([]any)
	if len(toolsOut) != 1 {
		t.Fatalf("tools = %d, want 1", len(toolsOut))
	}
	tool0 := toolsOut[0].(map[string]any)
	if _, ok := tool0["input_schema"]; !ok {
		t.Errorf("tool missing input_schema field; got %+v", tool0)
	}
	if _, ok := tool0["parameters"]; ok {
		t.Errorf("tool has \"parameters\" field; Anthropic uses input_schema only")
	}

	// thinking block present when effort is set.
	think, _ := out["thinking"].(map[string]any)
	if think == nil {
		t.Fatal("thinking block missing — should appear when Effort is non-empty")
	}
	if think["type"] != "enabled" {
		t.Errorf("thinking.type = %v, want enabled", think["type"])
	}
	if intFromJSON(think["budget_tokens"]) != 10000 {
		t.Errorf("thinking.budget_tokens = %v, want 10000 (effort=high)", think["budget_tokens"])
	}
	if intFromJSON(out["max_tokens"]) != 8192 {
		t.Errorf("max_tokens = %v, want 8192 (caller-supplied)", out["max_tokens"])
	}
}

// ── Headers + Endpoint tests ───────────────────────────────────────────────

func TestHeaders(t *testing.T) {
	p := &AnthropicProvider{}
	h := p.Headers("sk-test-key")
	if h.Get("x-api-key") != "sk-test-key" {
		t.Errorf("x-api-key = %q, want sk-test-key", h.Get("x-api-key"))
	}
	if h.Get("anthropic-version") != "2023-06-01" {
		t.Errorf("anthropic-version = %q, want 2023-06-01", h.Get("anthropic-version"))
	}
	if h.Get("Content-Type") != "application/json" {
		t.Errorf("Content-Type = %q, want application/json", h.Get("Content-Type"))
	}
	if h.Get("Authorization") != "" {
		t.Error("Authorization header set; Anthropic uses x-api-key only")
	}
}

func TestEndpointDefaultAndOverride(t *testing.T) {
	if got := (&AnthropicProvider{}).Endpoint(); got != "https://api.anthropic.com/v1/messages" {
		t.Errorf("default endpoint = %q", got)
	}
	if got := (&AnthropicProvider{BaseURL: "http://localhost:1234"}).Endpoint(); got != "http://localhost:1234/v1/messages" {
		t.Errorf("override endpoint = %q", got)
	}
	// Trailing /v1 on BaseURL should be stripped (TS bridge does the same).
	if got := (&AnthropicProvider{BaseURL: "http://localhost:1234/v1/"}).Endpoint(); got != "http://localhost:1234/v1/messages" {
		t.Errorf("trailing /v1/ endpoint = %q", got)
	}
}

// ── Misc helpers ───────────────────────────────────────────────────────────

// intFromJSON converts a value decoded from json.Unmarshal (where
// numbers come back as float64) to an int.
func intFromJSON(v any) int {
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	default:
		return 0
	}
}

// (silences unused-import noise during edits)
var _ = io.Discard

// ── Usage parsing tests ────────────────────────────────────────────────────

// TestAnthropicUsageHappyPath confirms a single-turn stream with both
// message_start (input + cache breakdown) and message_delta (output)
// produces the expected accumulated totals on the provider's Usage()
// surface.
func TestAnthropicUsageHappyPath(t *testing.T) {
	body := anthropicSSE(
		[2]string{"message_start", `{"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":120,"cache_read_input_tokens":50,"cache_creation_input_tokens":10,"output_tokens":1}}}`},
		[2]string{"content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`},
		[2]string{"content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}`},
		[2]string{"content_block_stop", `{"type":"content_block_stop","index":0}`},
		[2]string{"message_delta", `{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}`},
		[2]string{"message_stop", `{"type":"message_stop"}`},
	)
	// Use a single-turn helper but capture the provider too so we can read Usage afterwards.
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()
	resp, err := http.Get(srv.URL)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()

	p := &AnthropicProvider{Model: "claude-test"}
	if _, _, err := p.Stream(context.Background(), resp.Body, func(Chunk) {}); err != nil {
		t.Fatalf("Stream: %v", err)
	}

	got := p.Usage()
	want := Usage{InputTokens: 120, OutputTokens: 42, CacheReadTokens: 50, CacheCreationTokens: 10}
	if got != want {
		t.Errorf("Usage = %+v, want %+v", got, want)
	}
}

// TestAnthropicUsageMultipleDeltas verifies that several message_delta
// frames in the same turn use last-write semantics for output_tokens
// (not addition) — Anthropic re-emits the running total on each
// delta, so summing would double-count.
func TestAnthropicUsageMultipleDeltas(t *testing.T) {
	body := anthropicSSE(
		[2]string{"message_start", `{"type":"message_start","message":{"usage":{"input_tokens":10}}}`},
		[2]string{"content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`},
		[2]string{"content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"A"}}`},
		[2]string{"content_block_stop", `{"type":"content_block_stop","index":0}`},
		// Two message_delta frames — the second's output_tokens is the
		// final true count, NOT something to add to the first.
		[2]string{"message_delta", `{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":5}}`},
		[2]string{"message_delta", `{"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":17}}`},
		[2]string{"message_stop", `{"type":"message_stop"}`},
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()
	resp, err := http.Get(srv.URL)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()

	p := &AnthropicProvider{Model: "claude-test"}
	if _, _, err := p.Stream(context.Background(), resp.Body, func(Chunk) {}); err != nil {
		t.Fatalf("Stream: %v", err)
	}
	got := p.Usage()
	// OutputTokens should equal the LATER value (17), not 5+17=22.
	if got.OutputTokens != 17 {
		t.Errorf("OutputTokens = %d, want 17 (last-write within turn, not summed)", got.OutputTokens)
	}
	if got.InputTokens != 10 {
		t.Errorf("InputTokens = %d, want 10", got.InputTokens)
	}
}

// TestAnthropicUsageAbsent confirms that a stream lacking any usage
// frames produces a zero Usage and doesn't panic.
func TestAnthropicUsageAbsent(t *testing.T) {
	body := anthropicSSE(
		[2]string{"content_block_start", `{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}`},
		[2]string{"content_block_delta", `{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}`},
		[2]string{"content_block_stop", `{"type":"content_block_stop","index":0}`},
		[2]string{"message_stop", `{"type":"message_stop"}`},
	)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(body))
	}))
	defer srv.Close()
	resp, err := http.Get(srv.URL)
	if err != nil {
		t.Fatalf("get: %v", err)
	}
	defer resp.Body.Close()

	p := &AnthropicProvider{Model: "claude-test"}
	if _, _, err := p.Stream(context.Background(), resp.Body, func(Chunk) {}); err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if !p.Usage().IsZero() {
		t.Errorf("Usage = %+v, want zero (no usage frames)", p.Usage())
	}
}

// TestAnthropicResetUsage verifies that ResetUsage clears prior state.
func TestAnthropicResetUsage(t *testing.T) {
	p := &AnthropicProvider{Model: "claude-test"}
	p.addAnthropicUsage(map[string]any{"input_tokens": float64(100), "cache_read_input_tokens": float64(20)}, false)
	if p.Usage().InputTokens != 100 {
		t.Fatalf("setup failed: %+v", p.Usage())
	}
	p.ResetUsage()
	if !p.Usage().IsZero() {
		t.Errorf("after ResetUsage, Usage = %+v, want zero", p.Usage())
	}
}
