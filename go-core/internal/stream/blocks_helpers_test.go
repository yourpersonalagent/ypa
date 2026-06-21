package stream

import "testing"

func TestBlocksHaveStructure(t *testing.T) {
	cases := []struct {
		name   string
		blocks []PersistBlock
		want   bool
	}{
		{"nil", nil, false},
		{"only text", []PersistBlock{{Type: "text", Content: "hi"}}, false},
		{"empty type treated as text", []PersistBlock{{Content: "hi"}}, false},
		{"has tool-call", []PersistBlock{{Type: "text", Content: "x"}, {Type: "tool-call", Name: "Read"}}, true},
		{"has thinking", []PersistBlock{{Type: "thinking", Content: "hmm"}}, true},
		{"has tool-result", []PersistBlock{{Type: "tool-result", ToolID: "1"}}, true},
		{"has interrupt", []PersistBlock{{Type: "interrupt", Kind: "timeout"}}, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := blocksHaveStructure(c.blocks); got != c.want {
				t.Fatalf("blocksHaveStructure=%v want %v", got, c.want)
			}
		})
	}
}

// A turn that produces a tool call must be classified as structural so the
// live checkpoint ships blocks — this is the regression guard for the
// "long codex/grok reply disappears after the 60-min sweep" bug, where a
// text-only checkpoint left the placeholder with no tool transcript.
func TestBlocksHaveStructure_AccumulatedToolTurn(t *testing.T) {
	a := NewBlockAccumulator()
	a.Observe(Chunk{Type: ChunkTypeDelta, Text: "working on it"})
	a.Observe(Chunk{Type: ChunkTypeToolUse, ToolUse: &ToolUseChunk{ID: "t1", Name: "Bash", Input: map[string]any{"cmd": "ls"}}})
	a.Observe(Chunk{Type: ChunkTypeToolResult, ToolResult: &ToolResultChunk{ID: "t1", OK: true, Content: "file.txt"}})
	if !blocksHaveStructure(a.Blocks()) {
		t.Fatal("a turn with a tool call+result must be structural")
	}
}

func TestBlocksApproxLen(t *testing.T) {
	if n := blocksApproxLen(nil); n != 0 {
		t.Fatalf("nil approxLen=%d want 0", n)
	}
	blocks := []PersistBlock{
		{Type: "text", Content: "hello"},                // 4 + 5
		{Type: "tool-call", Name: "Read", Detail: "/x"}, // 9 + 4 + 2 (string detail)
	}
	got := blocksApproxLen(blocks)
	want := (4 + 5) + (9 + 4 + 2)
	if got != want {
		t.Fatalf("approxLen=%d want %d", got, want)
	}
	// A structured (non-string) detail adds the rough constant rather than 0.
	structured := []PersistBlock{{Type: "tool-call", Name: "Read", Detail: map[string]any{"path": "/x"}}}
	if n := blocksApproxLen(structured); n != len("tool-call")+len("Read")+64 {
		t.Fatalf("structured detail approxLen=%d want %d", n, len("tool-call")+len("Read")+64)
	}
}
