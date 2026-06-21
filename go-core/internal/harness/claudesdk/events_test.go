package claudesdk

import (
	"context"
	"strings"
	"testing"

	"github.com/yha/core/internal/stream"
)

// TestProcessStreamHappyPath drives processStream with a fixture that
// emits one assistant text block followed by a clean result event.
// Verifies the parser emits the expected delta chunks, sums tokens
// correctly, and surfaces the session id.
func TestProcessStreamHappyPath(t *testing.T) {
	fixture := strings.Join([]string{
		`{"type":"assistant","message":{"content":[{"type":"text","text":"Hello, world!"}]}}`,
		`{"type":"result","session_id":"sess-abc","result":"Hello, world!","total_cost_usd":0.0042,"usage":{"input_tokens":12,"output_tokens":7,"cache_creation_input_tokens":1,"cache_read_input_tokens":2},"stop_reason":"end_turn"}`,
		``,
	}, "\n")

	var got []stream.Chunk
	emit := EventEmit(func(c stream.Chunk) { got = append(got, c) })
	result, stats, err := processStream(context.Background(), strings.NewReader(fixture), strings.NewReader(""), emit)
	if err != nil {
		t.Fatalf("processStream: %v", err)
	}
	if stats.JSONLines != 2 {
		t.Errorf("JSONLines: want 2, got %d", stats.JSONLines)
	}
	if stats.ResultEvents != 1 {
		t.Errorf("ResultEvents: want 1, got %d", stats.ResultEvents)
	}
	if result.Text != "Hello, world!" {
		t.Errorf("Text: want %q, got %q", "Hello, world!", result.Text)
	}
	if result.Cost != 0.0042 {
		t.Errorf("Cost: want 0.0042, got %v", result.Cost)
	}
	if result.InputTokens != 12 || result.OutputTokens != 7 {
		t.Errorf("tokens: want 12/7, got %d/%d", result.InputTokens, result.OutputTokens)
	}
	if result.CacheCreationTokens != 1 || result.CacheReadTokens != 2 {
		t.Errorf("cache tokens: want 1/2, got %d/%d", result.CacheCreationTokens, result.CacheReadTokens)
	}
	if result.StopReason != "end_turn" {
		t.Errorf("StopReason: want end_turn, got %q", result.StopReason)
	}
	if result.ClaudeSessionID != "sess-abc" {
		t.Errorf("ClaudeSessionID: want sess-abc, got %q", result.ClaudeSessionID)
	}
	if len(got) < 1 {
		t.Fatalf("emit count: want >=1, got %d", len(got))
	}
	if got[0].Type != stream.ChunkTypeDelta {
		t.Errorf("first chunk type: want delta, got %q", got[0].Type)
	}
	if got[0].Text != "Hello, world!" {
		t.Errorf("first chunk text: want %q, got %q", "Hello, world!", got[0].Text)
	}
}

// TestProcessStreamToolUseAndResult verifies tool_use → tool_result
// flow surfaces the expected chunks.
func TestProcessStreamToolUseAndResult(t *testing.T) {
	fixture := strings.Join([]string{
		`{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu-1","name":"Bash","input":{"command":"ls"}}]}}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu-1","content":"file1\nfile2"}]}}`,
		`{"type":"result","session_id":"sess-1","result":"done","stop_reason":"end_turn","usage":{"input_tokens":5,"output_tokens":3}}`,
	}, "\n")
	var got []stream.Chunk
	emit := EventEmit(func(c stream.Chunk) { got = append(got, c) })
	_, _, err := processStream(context.Background(), strings.NewReader(fixture), strings.NewReader(""), emit)
	if err != nil {
		t.Fatalf("processStream: %v", err)
	}
	var sawToolUse, sawToolResult bool
	for _, c := range got {
		if c.Type == stream.ChunkTypeToolUse {
			sawToolUse = true
			if c.ToolUse == nil || c.ToolUse.Name != "Bash" || c.ToolUse.ID != "tu-1" {
				t.Errorf("tool_use chunk shape: %+v", c.ToolUse)
			}
		}
		if c.Type == stream.ChunkTypeToolResult {
			sawToolResult = true
			if c.ToolResult == nil || c.ToolResult.ID != "tu-1" {
				t.Errorf("tool_result chunk shape: %+v", c.ToolResult)
			}
		}
	}
	if !sawToolUse {
		t.Error("expected tool_use chunk")
	}
	if !sawToolResult {
		t.Error("expected tool_result chunk")
	}
}

// TestProcessStreamThinking — thinking blocks emit reasoning chunks.
func TestProcessStreamThinking(t *testing.T) {
	fixture := `{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"considering options..."}]}}` + "\n" +
		`{"type":"result","session_id":"s","result":"done","stop_reason":"end_turn"}`
	var got []stream.Chunk
	emit := EventEmit(func(c stream.Chunk) { got = append(got, c) })
	_, _, err := processStream(context.Background(), strings.NewReader(fixture), strings.NewReader(""), emit)
	if err != nil {
		t.Fatalf("processStream: %v", err)
	}
	var sawReasoning bool
	for _, c := range got {
		if c.Type == stream.ChunkTypeReasoning && c.Reasoning == "considering options..." {
			sawReasoning = true
		}
	}
	if !sawReasoning {
		t.Errorf("expected reasoning chunk, got %+v", got)
	}
}

// TestProcessStreamIsError flips the result event's is_error flag.
func TestProcessStreamIsError(t *testing.T) {
	fixture := `{"type":"result","session_id":"s","result":"oh no","is_error":true,"stop_reason":"error"}`
	var got []stream.Chunk
	emit := EventEmit(func(c stream.Chunk) { got = append(got, c) })
	result, _, err := processStream(context.Background(), strings.NewReader(fixture), strings.NewReader(""), emit)
	if err != nil {
		t.Fatalf("processStream: %v", err)
	}
	if !result.IsError {
		t.Errorf("expected IsError=true")
	}
	if result.ErrorMessage != "oh no" {
		t.Errorf("ErrorMessage: want %q, got %q", "oh no", result.ErrorMessage)
	}
	var sawErr bool
	for _, c := range got {
		if c.Type == stream.ChunkTypeError && c.Error == "oh no" {
			sawErr = true
		}
	}
	if !sawErr {
		t.Errorf("expected error chunk, got %+v", got)
	}
}

// TestProcessStreamSystemEventsIgnored — system events are
// informational and produce no chunks.
func TestProcessStreamSystemEventsIgnored(t *testing.T) {
	fixture := strings.Join([]string{
		`{"type":"system","subtype":"init","mcp_servers":[]}`,
		`{"type":"system","subtype":"mcp_server","status":"ready"}`,
		`{"type":"result","session_id":"s","result":"ok","stop_reason":"end_turn"}`,
	}, "\n")
	var got []stream.Chunk
	emit := EventEmit(func(c stream.Chunk) { got = append(got, c) })
	_, stats, err := processStream(context.Background(), strings.NewReader(fixture), strings.NewReader(""), emit)
	if err != nil {
		t.Fatalf("processStream: %v", err)
	}
	if stats.JSONLines != 3 {
		t.Errorf("JSONLines: want 3, got %d", stats.JSONLines)
	}
	// Only the result event should produce no chunk by itself; no
	// system-derived chunks expected.
	for _, c := range got {
		if c.Type != stream.ChunkTypeDelta &&
			c.Type != stream.ChunkTypeReasoning &&
			c.Type != stream.ChunkTypeToolUse &&
			c.Type != stream.ChunkTypeToolResult &&
			c.Type != stream.ChunkTypeError {
			t.Errorf("unexpected chunk type from system event: %q", c.Type)
		}
	}
}

// TestProcessStreamBadJSONIgnored — non-JSON lines silently skipped.
func TestProcessStreamBadJSONIgnored(t *testing.T) {
	fixture := strings.Join([]string{
		`this is not JSON`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"after garbage"}]}}`,
		`{"type":"result","session_id":"s","result":"after garbage","stop_reason":"end_turn"}`,
	}, "\n")
	var got []stream.Chunk
	emit := EventEmit(func(c stream.Chunk) { got = append(got, c) })
	result, stats, err := processStream(context.Background(), strings.NewReader(fixture), strings.NewReader(""), emit)
	if err != nil {
		t.Fatalf("processStream: %v", err)
	}
	if stats.Lines != 3 {
		t.Errorf("Lines: want 3, got %d", stats.Lines)
	}
	if stats.JSONLines != 2 {
		t.Errorf("JSONLines: want 2 (one is garbage), got %d", stats.JSONLines)
	}
	if result.Text != "after garbage" {
		t.Errorf("Text: want %q, got %q", "after garbage", result.Text)
	}
}

// TestProcessStreamStderrCapture — stderr drains into the stats blob.
func TestProcessStreamStderrCapture(t *testing.T) {
	stderrLines := "some non-fatal warning\n"
	fixture := `{"type":"result","session_id":"s","result":"done","stop_reason":"end_turn"}`
	emit := EventEmit(func(stream.Chunk) {})
	_, stats, err := processStream(context.Background(), strings.NewReader(fixture), strings.NewReader(stderrLines), emit)
	if err != nil {
		t.Fatalf("processStream: %v", err)
	}
	if !strings.Contains(stats.StderrText, "non-fatal warning") {
		t.Errorf("StderrText didn't capture: %q", stats.StderrText)
	}
}

// TestStringifyToolResultContentTextArray — the SDK path emits
// tool_result.content as an array of {type:text,text}; the helper
// joins their text rather than JSON-encoding.
func TestStringifyToolResultContentTextArray(t *testing.T) {
	in := []any{
		map[string]any{"type": "text", "text": "hello "},
		map[string]any{"type": "text", "text": "world"},
	}
	got := stringifyToolResultContent(in)
	if got != "hello world" {
		t.Errorf("text-array join: want %q, got %q", "hello world", got)
	}
}

// TestStringifyToolResultContentString — plain string passthrough.
func TestStringifyToolResultContentString(t *testing.T) {
	got := stringifyToolResultContent("just a string")
	if got != "just a string" {
		t.Errorf("string passthrough: %q", got)
	}
}
