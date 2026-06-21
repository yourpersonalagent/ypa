package grokbuild

import (
	"strings"
	"testing"
)

// parseLine tests for the grok streaming-json wire (legacy "thought"/"text"/"end"
// + current 2026 shapes: session.*, model.thinking, tool.call/result, model.message,
// session.end with sid + usage). These ensure rich events (thinking + tool cards)
// flow to ChunkType* and blocks.go exactly like claude-binary/codex, and that
// resume sid + usage are captured when present.

func TestParseLineEmptyAndWhitespace(t *testing.T) {
	if p := parseLine(""); p.kind != lineSkip {
		t.Errorf("empty -> skip")
	}
	if p := parseLine("   \t\n"); p.kind != lineSkip {
		t.Errorf("ws -> skip")
	}
}

func TestParseLineRawTextPassthrough(t *testing.T) {
	p := parseLine("some plain stderr-like line")
	if p.kind != lineDelta {
		t.Fatalf("raw non-json -> delta, got %v", p.kind)
	}
	if !strings.HasSuffix(p.delta, "\n") {
		t.Errorf("raw should end with \\n")
	}
}

func TestParseLineLegacyThought(t *testing.T) {
	p := parseLine(`{"type":"thought","data":"thinking step 1"}`)
	if p.kind != lineReasoning {
		t.Fatalf("legacy thought -> reasoning, got %v", p.kind)
	}
	if p.delta != "thinking step 1" {
		t.Errorf("delta mismatch: %q", p.delta)
	}
}

func TestParseLineModelThinking(t *testing.T) {
	p := parseLine(`{"type":"model.thinking","data":"grok is planning the edit"}`)
	if p.kind != lineReasoning {
		t.Fatalf("model.thinking -> reasoning, got %v", p.kind)
	}
	if !strings.Contains(p.delta, "planning") {
		t.Errorf("expected content in reasoning delta")
	}
}

func TestParseLineTextAndModelMessage(t *testing.T) {
	for _, typ := range []string{"text", "model.message", "message"} {
		p := parseLine(`{"type":"` + typ + `","data":"hello from grok"}`)
		if p.kind != lineDelta {
			t.Errorf("%s -> delta, got %v", typ, p.kind)
		}
		if p.delta != "hello from grok" {
			t.Errorf("%s delta: %q", typ, p.delta)
		}
	}
}

func TestParseLineToolCallTopLevelAndDataFallback(t *testing.T) {
	// Top-level fields (preferred recent shape)
	p := parseLine(`{"type":"tool.call","id":"call_123","tool":"Edit","args":{"path":"main.go","content":"package main"}}`)
	if p.kind != lineToolUse {
		t.Fatalf("tool.call top -> lineToolUse, got %v", p.kind)
	}
	if p.toolName != "Edit" || p.toolID != "call_123" {
		t.Errorf("tool name/id: %s/%s", p.toolName, p.toolID)
	}

	// Data fallback (some builds)
	p2 := parseLine(`{"type":"tool.call","data":{"id":"c2","tool":"Bash","args":{"cmd":"go build"}}} `)
	if p2.kind != lineToolUse || p2.toolName != "Bash" {
		t.Errorf("data fallback tool.call failed: %+v", p2)
	}
}

func TestParseLineToolResult(t *testing.T) {
	p := parseLine(`{"type":"tool.result","id":"call_123","content":"diff --git ..."}`)
	if p.kind != lineToolResult {
		t.Fatalf("tool.result -> lineToolResult, got %v", p.kind)
	}
	if p.resultID != "call_123" || !strings.Contains(p.resultContent, "diff") {
		t.Errorf("result id/content: %s / %s", p.resultID, p.resultContent)
	}

	// Data + tool_use_id fallback
	p2 := parseLine(`{"type":"tool_result","data":{"tool_use_id":"c9","content":"ok"}}`)
	if p2.kind != lineToolResult || p2.resultID != "c9" {
		t.Errorf("data/tool_use_id fallback: %+v", p2)
	}
}

func TestParseLineSessionEndWithSidAndUsage(t *testing.T) {
	p := parseLine(`{"type":"session.end","sessionId":"grok_sess_abc","stopReason":"end_turn","input_tokens":1234,"output_tokens":567}`)
	if p.kind != lineEnd {
		t.Fatalf("session.end -> lineEnd, got %v", p.kind)
	}
	if p.sessionID != "grok_sess_abc" || p.stopReason != "end_turn" {
		t.Errorf("sid/stop: %s / %s", p.sessionID, p.stopReason)
	}
	if p.inputTokens != 1234 || p.outputTokens != 567 {
		t.Errorf("usage: %d/%d", p.inputTokens, p.outputTokens)
	}
}

func TestParseLineSessionStartUsageCapture(t *testing.T) {
	p := parseLine(`{"type":"session.start","sessionId":"s1","inputTokens":10,"outputTokens":2}`)
	if p.kind != lineEnd || p.sessionID != "s1" {
		t.Errorf("start as end for sid: %+v", p)
	}
}

func TestParseLineError(t *testing.T) {
	p := parseLine(`{"type":"error","message":"login required"}`)
	if p.kind != lineErr || !strings.Contains(p.errMsg, "login") {
		t.Errorf("error: %+v", p)
	}
}

func TestParseLineUnknownSkipped(t *testing.T) {
	p := parseLine(`{"type":"future.new.event","foo":"bar"}`)
	if p.kind != lineSkip {
		t.Errorf("unknown must skip (safe default): %v", p.kind)
	}
}

func TestParseLineBadJsonObjectSkips(t *testing.T) {
	// Valid JSON but not our event shape and starts with { → skip (safe).
	// (Array case falls to raw-delta path because !HasPrefix "{", which is
	// the "plain text passthrough" for non-event output.)
	p := parseLine(`{"unexpected":"shape","no":"type field"}`)
	if p.kind != lineSkip {
		t.Errorf("bad { json object with no matching type -> skip, got %v", p.kind)
	}
}