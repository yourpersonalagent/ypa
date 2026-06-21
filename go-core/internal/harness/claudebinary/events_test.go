package claudebinary

import (
	"context"
	"strings"
	"testing"

	"github.com/yha/core/internal/stream"
)

// TestProcessStreamHappyPath drives processStream with a fixture that
// emits one assistant text block followed by a clean result event.
// Verifies the parser emits the expected delta + done chunks, sums
// tokens correctly, and surfaces the session id.
func TestProcessStreamHappyPath(t *testing.T) {
	fixture := strings.Join([]string{
		`{"type":"assistant","message":{"content":[{"type":"text","text":"Hello, world!"}]}}`,
		`{"type":"result","session_id":"sess-abc","result":"Hello, world!","total_cost_usd":0.0042,"usage":{"input_tokens":12,"output_tokens":7,"cache_creation_input_tokens":1,"cache_read_input_tokens":2},"stop_reason":"end_turn"}`,
		``,
	}, "\n")
	stdout := strings.NewReader(fixture)
	stderr := strings.NewReader("")

	var got []stream.Chunk
	emit := EventEmit(func(c stream.Chunk) { got = append(got, c) })
	result, stats, err := processStream(context.Background(), stdout, stderr, emit, nil, nil)
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
	// Expect one delta chunk; no done — that's emitted by the streamer
	// caller after processStream returns.
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
// flow surfaces the expected chunks and the tool-name → id map is
// usable for permission-denial detection.
func TestProcessStreamToolUseAndResult(t *testing.T) {
	fixture := strings.Join([]string{
		`{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu-1","name":"Bash","input":{"command":"ls"}}]}}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu-1","content":"file1\nfile2"}]}}`,
		`{"type":"result","session_id":"sess-1","result":"done","stop_reason":"end_turn","usage":{"input_tokens":5,"output_tokens":3}}`,
	}, "\n")
	var got []stream.Chunk
	emit := EventEmit(func(c stream.Chunk) { got = append(got, c) })
	_, _, err := processStream(context.Background(), strings.NewReader(fixture), strings.NewReader(""), emit, nil, nil)
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

// TestProcessStreamThinking verifies thinking blocks emit reasoning
// chunks (used by subscription/OAuth tier with --thinking-display).
func TestProcessStreamThinking(t *testing.T) {
	fixture := `{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"considering options..."}]}}` + "\n" +
		`{"type":"result","session_id":"s","result":"done","stop_reason":"end_turn"}`
	var got []stream.Chunk
	emit := EventEmit(func(c stream.Chunk) { got = append(got, c) })
	_, _, err := processStream(context.Background(), strings.NewReader(fixture), strings.NewReader(""), emit, nil, nil)
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

// TestProcessStreamPermissionDenials drives the perm-denied pattern
// detection: tool_result content containing a known pattern adds the
// tool to the dedup map and fires the onPerm callback.
func TestProcessStreamPermissionDenials(t *testing.T) {
	fixture := strings.Join([]string{
		`{"type":"assistant","message":{"content":[{"type":"tool_use","id":"tu-1","name":"Bash","input":{"command":"rm /etc/passwd"}}]}}`,
		`{"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"tu-1","content":"Claude requested permissions to use Bash but the user hasn't granted it yet"}]}}`,
		`{"type":"result","session_id":"s","result":"","stop_reason":"end_turn"}`,
	}, "\n")
	var permSnapshots []map[string]any
	emit := EventEmit(func(c stream.Chunk) {})
	onPerm := PermDenialEmit(func(m map[string]any) { permSnapshots = append(permSnapshots, m) })
	result, _, err := processStream(context.Background(), strings.NewReader(fixture), strings.NewReader(""), emit, onPerm, nil)
	if err != nil {
		t.Fatalf("processStream: %v", err)
	}
	if len(permSnapshots) == 0 {
		t.Fatal("expected onPerm callback to fire at least once")
	}
	if _, ok := result.PermDenials["Bash"]; !ok {
		t.Errorf("expected Bash in PermDenials, got %+v", result.PermDenials)
	}
}

// TestProcessStreamIsError flips the result event's is_error flag and
// verifies the parser emits an error chunk + sets Result.IsError.
func TestProcessStreamIsError(t *testing.T) {
	fixture := `{"type":"result","session_id":"s","result":"oh no","is_error":true,"stop_reason":"error"}`
	var got []stream.Chunk
	emit := EventEmit(func(c stream.Chunk) { got = append(got, c) })
	result, _, err := processStream(context.Background(), strings.NewReader(fixture), strings.NewReader(""), emit, nil, nil)
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

// TestProcessStreamMultipleTurns ensures the parser handles multi-turn
// /btw splices — multiple result events in one spawn, each summing
// per-turn tokens and the latest cost.
func TestProcessStreamMultipleTurns(t *testing.T) {
	fixture := strings.Join([]string{
		`{"type":"assistant","message":{"content":[{"type":"text","text":"first "}]}}`,
		`{"type":"result","session_id":"s","result":"first ","total_cost_usd":0.01,"usage":{"input_tokens":5,"output_tokens":2},"stop_reason":"end_turn"}`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"second"}]}}`,
		`{"type":"result","session_id":"s","result":"second","total_cost_usd":0.03,"usage":{"input_tokens":4,"output_tokens":3},"stop_reason":"end_turn"}`,
	}, "\n")
	emit := EventEmit(func(stream.Chunk) {})
	turnsHit := 0
	onTurn := PendingTurnHook(func(ev ResultEvent) bool {
		turnsHit++
		return false
	})
	result, stats, err := processStream(context.Background(), strings.NewReader(fixture), strings.NewReader(""), emit, nil, onTurn)
	if err != nil {
		t.Fatalf("processStream: %v", err)
	}
	if stats.ResultEvents != 2 {
		t.Errorf("ResultEvents: want 2, got %d", stats.ResultEvents)
	}
	if turnsHit != 2 {
		t.Errorf("onTurn calls: want 2, got %d", turnsHit)
	}
	// Cost is the LATEST total_cost_usd (cumulative semantic).
	if result.Cost != 0.03 {
		t.Errorf("Cost: want 0.03 (latest cumulative), got %v", result.Cost)
	}
	// Tokens are summed across turns.
	if result.InputTokens != 9 || result.OutputTokens != 5 {
		t.Errorf("tokens: want 9/5, got %d/%d", result.InputTokens, result.OutputTokens)
	}
	// Text should be the latest result (overwrites per turn).
	if result.Text != "second" {
		t.Errorf("Text: want %q, got %q", "second", result.Text)
	}
}

// TestProcessStreamBadJSONIgnored verifies non-JSON lines are silently
// dropped (matches TS continue on parse error).
func TestProcessStreamBadJSONIgnored(t *testing.T) {
	fixture := strings.Join([]string{
		`this is not JSON`,
		`{"type":"assistant","message":{"content":[{"type":"text","text":"after garbage"}]}}`,
		`{"type":"result","session_id":"s","result":"after garbage","stop_reason":"end_turn"}`,
	}, "\n")
	var got []stream.Chunk
	emit := EventEmit(func(c stream.Chunk) { got = append(got, c) })
	result, stats, err := processStream(context.Background(), strings.NewReader(fixture), strings.NewReader(""), emit, nil, nil)
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

// TestProcessStreamAssistantUsageFallback verifies the per-turn usage
// fallback: when a "result" event lands WITHOUT a usage block, the
// parser falls back to the latest preceding assistant event's
// `message.usage` so the per-turn token counts and downstream cost
// recording stay non-zero.
func TestProcessStreamAssistantUsageFallback(t *testing.T) {
	fixture := strings.Join([]string{
		`{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":42,"output_tokens":11,"cache_creation_input_tokens":7,"cache_read_input_tokens":5}}}`,
		`{"type":"result","session_id":"s","result":"hi","stop_reason":"end_turn"}`,
	}, "\n")
	emit := EventEmit(func(stream.Chunk) {})
	result, _, err := processStream(context.Background(), strings.NewReader(fixture), strings.NewReader(""), emit, nil, nil)
	if err != nil {
		t.Fatalf("processStream: %v", err)
	}
	if result.InputTokens != 42 || result.OutputTokens != 11 {
		t.Errorf("tokens fell through to result: want 42/11, got %d/%d", result.InputTokens, result.OutputTokens)
	}
	if result.CacheCreationTokens != 7 || result.CacheReadTokens != 5 {
		t.Errorf("cache tokens fell through to result: want 7/5, got %d/%d", result.CacheCreationTokens, result.CacheReadTokens)
	}
}

// TestProcessStreamResultUsageWinsOverAssistant verifies the
// authoritative-result preference: when both the assistant event and
// the result event carry usage, the result event's numbers win
// (assistant is only a fallback). Mirrors the binary's invariant that
// per-turn `result.usage` is the canonical aggregate.
func TestProcessStreamResultUsageWinsOverAssistant(t *testing.T) {
	fixture := strings.Join([]string{
		`{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":999,"output_tokens":999}}}`,
		`{"type":"result","session_id":"s","result":"hi","stop_reason":"end_turn","usage":{"input_tokens":12,"output_tokens":7}}`,
	}, "\n")
	emit := EventEmit(func(stream.Chunk) {})
	result, _, err := processStream(context.Background(), strings.NewReader(fixture), strings.NewReader(""), emit, nil, nil)
	if err != nil {
		t.Fatalf("processStream: %v", err)
	}
	if result.InputTokens != 12 || result.OutputTokens != 7 {
		t.Errorf("result.usage should win: want 12/7, got %d/%d", result.InputTokens, result.OutputTokens)
	}
}

// TestProcessStreamNoResultEventUsageSurfaces verifies the EOF
// fallback: when the binary exits without ever emitting a "result"
// event (kill watchdog, broken pipe), the latest assistant usage is
// promoted into the final Result so the caller still records non-zero
// tokens.
func TestProcessStreamNoResultEventUsageSurfaces(t *testing.T) {
	fixture := `{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}],"usage":{"input_tokens":8,"output_tokens":3,"cache_read_input_tokens":2}}}`
	emit := EventEmit(func(stream.Chunk) {})
	result, stats, err := processStream(context.Background(), strings.NewReader(fixture), strings.NewReader(""), emit, nil, nil)
	if err != nil {
		t.Fatalf("processStream: %v", err)
	}
	if stats.ResultEvents != 0 {
		t.Fatalf("expected zero result events, got %d", stats.ResultEvents)
	}
	if result.InputTokens != 8 || result.OutputTokens != 3 {
		t.Errorf("EOF fallback: want 8/3, got %d/%d", result.InputTokens, result.OutputTokens)
	}
	if result.CacheReadTokens != 2 {
		t.Errorf("EOF fallback cache_read: want 2, got %d", result.CacheReadTokens)
	}
}

// TestProcessStreamStderrCapture ensures stderr drains into the stats
// blob — the retry-on-stale-resume path depends on this.
func TestProcessStreamStderrCapture(t *testing.T) {
	stderrLines := "No conversation found with session ID abc\nsome other line\n"
	fixture := `{"type":"result","session_id":"s","result":"done","stop_reason":"end_turn"}`
	emit := EventEmit(func(stream.Chunk) {})
	_, stats, err := processStream(context.Background(), strings.NewReader(fixture), strings.NewReader(stderrLines), emit, nil, nil)
	if err != nil {
		t.Fatalf("processStream: %v", err)
	}
	if !strings.Contains(stats.StderrText, "No conversation found") {
		t.Errorf("StderrText didn't capture stderr: got %q", stats.StderrText)
	}
}
