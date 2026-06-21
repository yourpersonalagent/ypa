package codex

import (
	"strings"
	"testing"
)

// parseLine tests cover the JSON-Lines wire format codex emits. Each
// case feeds one line through the parser and asserts on the parsed
// kind + payload — the loop tests in codex_test.go then check the
// end-to-end emit sequence.

func TestParseLineTextDelta(t *testing.T) {
	state := newParseState()
	p := parseLine(`{"type":"response.text.delta","delta":"hello"}`, state)
	if p.kind != lineDelta {
		t.Fatalf("expected lineDelta, got %v", p.kind)
	}
	if p.delta != "hello" {
		t.Errorf("expected delta=hello, got %q", p.delta)
	}
}

func TestParseLineSkipBlankAndComments(t *testing.T) {
	state := newParseState()
	if p := parseLine("", state); p.kind != lineSkip {
		t.Errorf("blank should skip")
	}
	if p := parseLine("   \t", state); p.kind != lineSkip {
		t.Errorf("whitespace-only should skip")
	}
	if p := parseLine(`{"type":"response.text.delta","delta":""}`, state); p.kind != lineSkip {
		t.Errorf("empty delta should skip")
	}
}

func TestParseLineRawTextPassthrough(t *testing.T) {
	// Non-JSON lines are echoed as deltas — mirrors codex.ts:413-418.
	state := newParseState()
	p := parseLine("warning: deprecated flag", state)
	if p.kind != lineDelta {
		t.Fatalf("non-JSON should be delta, got %v", p.kind)
	}
	if !strings.HasSuffix(p.delta, "\n") {
		t.Errorf("raw passthrough should append \\n, got %q", p.delta)
	}
}

func TestParseLineAgentMessageItem(t *testing.T) {
	state := newParseState()
	p := parseLine(`{"type":"item.completed","item":{"type":"agent_message","text":"hi there"}}`, state)
	if p.kind != lineDelta {
		t.Fatalf("agent_message should be delta, got %v", p.kind)
	}
	if p.delta != "hi there" {
		t.Errorf("expected delta=hi there, got %q", p.delta)
	}
}

func TestParseLineAgentMessageContent(t *testing.T) {
	state := newParseState()
	p := parseLine(`{"type":"item.completed","item":{"type":"agent_message","content":[{"text":"a"},{"text":"b"}]}}`, state)
	if p.kind != lineDelta {
		t.Fatalf("agent_message content[] should be delta, got %v", p.kind)
	}
	if p.delta != "ab" {
		t.Errorf("expected concatenated 'ab', got %q", p.delta)
	}
}

func TestParseLineCommandExecution(t *testing.T) {
	state := newParseState()

	// item.started — emits tool_use with command input.
	p := parseLine(`{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"ls -la"}}`, state)
	if p.kind != lineToolUse {
		t.Fatalf("command_execution start should emit toolUse, got %v", p.kind)
	}
	if p.toolUse.Name != "functions.exec_command" {
		t.Errorf("expected name=functions.exec_command, got %q", p.toolUse.Name)
	}
	if got, _ := p.toolUse.Input["command"].(string); got != "ls -la" {
		t.Errorf("expected command=ls -la, got %v", p.toolUse.Input["command"])
	}

	// item.completed — should suppress duplicate toolUse, emit toolResult.
	exit := 0
	rawCompleted := `{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"ls -la","aggregated_output":"total 0","exit_code":0}}`
	p = parseLine(rawCompleted, state)
	if p.toolUse != nil {
		t.Errorf("expected toolUse dedup, got %+v", p.toolUse)
	}
	if p.toolRes == nil || !strings.Contains(p.toolRes.Content, "total 0") {
		t.Errorf("expected toolResult with output, got %+v", p.toolRes)
	}
	if !strings.Contains(p.toolRes.Content, "exit_code=0") {
		t.Errorf("expected exit_code marker, got %q", p.toolRes.Content)
	}
	_ = exit
}

func TestParseLineMcpToolCall(t *testing.T) {
	state := newParseState()
	// Started — produces tool_use with mcp__ prefix.
	p := parseLine(`{"type":"item.started","item":{"id":"m1","type":"mcp_tool_call","server":"my-server","tool":"do-thing","arguments":{"x":1}}}`, state)
	if p.kind != lineToolUse {
		t.Fatalf("mcp_tool_call should emit toolUse, got %v", p.kind)
	}
	if p.toolUse.Name != "mcp__my_server__.do_thing" {
		t.Errorf("expected mcp__my_server__.do_thing, got %q", p.toolUse.Name)
	}
	if got, _ := p.toolUse.Input["x"].(float64); got != 1 {
		t.Errorf("expected x=1 in input, got %v", p.toolUse.Input)
	}

	// Completed with error → toolResult content carries the error.
	p = parseLine(`{"type":"item.completed","item":{"id":"m1","type":"mcp_tool_call","server":"my-server","tool":"do-thing","arguments":{"x":1},"error":"boom"}}`, state)
	if p.toolRes == nil {
		t.Fatalf("expected toolResult on completed mcp_tool_call")
	}
	if p.toolRes.Content != "boom" {
		t.Errorf("expected content=boom, got %q", p.toolRes.Content)
	}
}

func TestParseLineFunctionCallSequence(t *testing.T) {
	state := newParseState()

	// 1. Stream-style function_call start.
	p := parseLine(`{"type":"response.output_item.added","item":{"type":"function_call","call_id":"c1","name":"do_search"}}`, state)
	if p.kind != lineToolUse {
		t.Fatalf("expected placeholder toolUse, got %v", p.kind)
	}
	if p.toolUse.Name != "do_search" {
		t.Errorf("expected name=do_search, got %q", p.toolUse.Name)
	}

	// 2. Arg deltas accumulate; no chunk.
	p = parseLine(`{"type":"response.function_call_arguments.delta","call_id":"c1","delta":"{\"q\":"}`, state)
	if p.kind != lineSkip {
		t.Errorf("delta should not emit a chunk")
	}
	p = parseLine(`{"type":"response.function_call_arguments.delta","call_id":"c1","delta":"\"hi\"}"}`, state)
	if p.kind != lineSkip {
		t.Errorf("delta should not emit a chunk")
	}

	// 3. Done — emits final toolUse with parsed args.
	p = parseLine(`{"type":"response.function_call_arguments.done","call_id":"c1","arguments":"{\"q\":\"hi\"}"}`, state)
	if p.kind != lineToolUse {
		t.Fatalf("done should emit toolUse, got %v", p.kind)
	}
	if got, _ := p.toolUse.Input["q"].(string); got != "hi" {
		t.Errorf("expected q=hi, got %v", p.toolUse.Input)
	}

	// 4. function_call_output → toolResult with output text.
	p = parseLine(`{"type":"response.output_item.done","item":{"type":"function_call_output","call_id":"c1","output":"42"}}`, state)
	if p.kind != lineToolResult {
		t.Fatalf("expected toolResult, got %v", p.kind)
	}
	if p.toolRes.ID != "c1" || p.toolRes.Content != "42" {
		t.Errorf("expected (c1,42), got (%q,%q)", p.toolRes.ID, p.toolRes.Content)
	}
}

func TestParseLineErrorAndTurnFailed(t *testing.T) {
	state := newParseState()
	p := parseLine(`{"type":"error","message":"rate limit"}`, state)
	if p.kind != lineErr || p.errMsg != "rate limit" {
		t.Errorf("error should produce errMsg, got %+v", p)
	}
	p = parseLine(`{"type":"turn.failed","error":{"message":"sandbox"}}`, state)
	if p.kind != lineErr || p.errMsg != "sandbox" {
		t.Errorf("turn.failed should produce errMsg, got %+v", p)
	}
	// empty error message → skip
	p = parseLine(`{"type":"error"}`, state)
	if p.kind != lineSkip {
		t.Errorf("empty error should skip")
	}
}

func TestParseLineUsageNet(t *testing.T) {
	state := newParseState()
	p := parseLine(`{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":50,"input_tokens_details":{"cached_tokens":30}}}`, state)
	if p.kind != lineUsage {
		t.Fatalf("turn.completed with usage should produce lineUsage, got %v", p.kind)
	}
	if p.usage.InputTokens != 70 {
		t.Errorf("expected NET inputTokens=70 (100-30), got %d", p.usage.InputTokens)
	}
	if p.usage.OutputTokens != 50 {
		t.Errorf("expected outputTokens=50, got %d", p.usage.OutputTokens)
	}
	if p.usage.CacheReadTokens != 30 {
		t.Errorf("expected cacheRead=30, got %d", p.usage.CacheReadTokens)
	}
	// no details → cache=0, net=gross
	p = parseLine(`{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":50}}`, state)
	if p.kind != lineUsage || p.usage.InputTokens != 100 || p.usage.CacheReadTokens != 0 {
		t.Errorf("expected (input=100,cache=0), got %+v", p.usage)
	}
}

func TestParseLineUnknownTypeIgnored(t *testing.T) {
	state := newParseState()
	if p := parseLine(`{"type":"some.future.event","data":42}`, state); p.kind != lineSkip {
		t.Errorf("unknown type should skip, got %v", p.kind)
	}
}

func TestParseLineEmptyTypeWithDelta(t *testing.T) {
	state := newParseState()
	if p := parseLine(`{"delta":"raw text"}`, state); p.kind != lineDelta || p.delta != "raw text" {
		t.Errorf("delta-only frame should produce delta, got %+v", p)
	}
	if p := parseLine(`{"text":"raw text"}`, state); p.kind != lineDelta || p.delta != "raw text" {
		t.Errorf("text-only frame should produce delta, got %+v", p)
	}
}

func TestFormatMcpToolName(t *testing.T) {
	cases := []struct {
		server, tool, fallback, want string
	}{
		{"my-server", "do-thing", "x", "mcp__my_server__.do_thing"},
		{"weird.server!", "ok", "x", "mcp__weird_server__.ok"},
		{"", "do-thing", "x", "do_thing"},
		{"only-server", "", "x", "only_server"},
		{"", "", "fallback", "fallback"},
	}
	for _, c := range cases {
		got := formatMcpToolName(c.server, c.tool, c.fallback)
		if got != c.want {
			t.Errorf("formatMcpToolName(%q,%q,%q)=%q want %q", c.server, c.tool, c.fallback, got, c.want)
		}
	}
}

func TestFormatNativeToolName(t *testing.T) {
	for in, want := range map[string]string{
		"web_search":  "codex.WebSearch",
		"todo_list":   "codex.TodoList",
		"file_change": "codex.FileChange",
		"unknown":     "codex.unknown",
	} {
		if got := formatNativeToolName(in); got != want {
			t.Errorf("formatNativeToolName(%q)=%q want %q", in, got, want)
		}
	}
}

func TestResultToTextFromContentArray(t *testing.T) {
	in := map[string]any{
		"content": []any{
			map[string]any{"text": "first"},
			map[string]any{"data": 42},
			map[string]any{"text": "third"},
		},
	}
	got := resultToText(in)
	if !strings.Contains(got, "first") || !strings.Contains(got, "42") || !strings.Contains(got, "third") {
		t.Errorf("expected content concat, got %q", got)
	}
}

func TestExtractNativeToolInputWebSearch(t *testing.T) {
	it := &codexItem{
		Type:   "web_search",
		Status: "completed",
		Action: map[string]any{
			"type":  "query",
			"query": "golang",
			"url":   "https://x",
			"junk":  "",
		},
	}
	got := extractNativeToolInput(it)
	if got["status"] != "completed" {
		t.Errorf("expected status=completed, got %v", got)
	}
	action, ok := got["action"].(map[string]any)
	if !ok {
		t.Fatalf("action missing or wrong type: %v", got)
	}
	if action["query"] != "golang" {
		t.Errorf("expected query=golang, got %v", action)
	}
	if _, hasJunk := action["junk"]; hasJunk {
		t.Errorf("empty fields should be dropped, got %v", action)
	}
}

func TestParseLineWrappedCodexEvents(t *testing.T) {
	state := newParseState()

	p := parseLine(`{"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{\"cmd\":\"pwd\"}","call_id":"call_1"}}`, state)
	if p.kind != lineToolUse || p.toolUse == nil {
		t.Fatalf("wrapped function_call should emit toolUse, got %+v", p)
	}
	if p.toolUse.Name != "exec_command" || p.toolUse.ID != "call_1" {
		t.Fatalf("unexpected tool use: %+v", p.toolUse)
	}
	if got, _ := p.toolUse.Input["cmd"].(string); got != "pwd" {
		t.Fatalf("expected parsed cmd arg, got %+v", p.toolUse.Input)
	}

	p = parseLine(`{"type":"response_item","payload":{"type":"function_call_output","call_id":"call_1","output":"ok"}}`, state)
	if p.kind != lineToolResult || p.toolRes == nil || p.toolRes.ID != "call_1" || p.toolRes.Content != "ok" {
		t.Fatalf("wrapped function_call_output should emit toolResult, got %+v", p)
	}

	p = parseLine(`{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"done"}]}}`, state)
	if p.kind != lineDelta || p.delta != "done" {
		t.Fatalf("wrapped assistant message should emit delta, got %+v", p)
	}

	p = parseLine(`{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"done"}}`, state)
	if p.kind != lineUsage {
		t.Fatalf("wrapped task_complete should terminate the parser, got %+v", p)
	}
}
