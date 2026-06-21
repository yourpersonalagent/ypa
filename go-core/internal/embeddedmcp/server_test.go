package embeddedmcp

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yha/core/internal/tools"
)

func newServer(t *testing.T) (*Server, string) {
	t.Helper()
	dir := t.TempDir()
	exec := tools.New(dir, nil, nil)
	return New(exec), dir
}

func TestListToolsReturnsSixBuiltins(t *testing.T) {
	srv, _ := newServer(t)
	defs := srv.ListTools()
	if len(defs) != 6 {
		t.Fatalf("ListTools = %d, want 6", len(defs))
	}
	want := map[string]bool{
		"Bash": true, "Read": true, "Write": true,
		"Glob": true, "Grep": true, "WebFetch": true,
	}
	for _, d := range defs {
		if !want[d.Name] {
			t.Errorf("unexpected tool: %q", d.Name)
		}
		if d.Description == "" {
			t.Errorf("tool %q has empty description", d.Name)
		}
		if d.InputSchema == nil {
			t.Errorf("tool %q has nil InputSchema", d.Name)
		}
	}
}

func TestCallToolWriteThenRead(t *testing.T) {
	srv, dir := newServer(t)
	path := filepath.Join(dir, "hello.txt")
	body := "embedded mcp says hello"

	// Round-trip Write through the MCP surface.
	res, err := srv.CallTool(context.Background(), "Write", map[string]any{
		"file_path": path,
		"content":   body,
	})
	if err != nil {
		t.Fatalf("Write: %v", err)
	}
	if res.IsError {
		t.Fatalf("Write returned IsError: %+v", res)
	}
	if len(res.Content) == 0 || res.Content[0].Type != "text" {
		t.Errorf("Write content shape wrong: %+v", res.Content)
	}

	// Cross-check the file landed on disk.
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read after Write: %v", err)
	}
	if string(got) != body {
		t.Errorf("file content = %q, want %q", got, body)
	}

	// And read it back through the MCP surface.
	res, err = srv.CallTool(context.Background(), "Read", map[string]any{
		"file_path": path,
	})
	if err != nil {
		t.Fatalf("Read: %v", err)
	}
	if res.IsError {
		t.Fatalf("Read returned IsError: %+v", res)
	}
	if !strings.Contains(res.Content[0].Text, body) {
		t.Errorf("Read text missing body: %q", res.Content[0].Text)
	}
}

func TestCallToolRoundTripEqualsExecutor(t *testing.T) {
	dir := t.TempDir()
	exec := tools.New(dir, nil, nil)
	srv := New(exec)

	// Each built-in tool round-trips through the MCP surface to the
	// same answer the Executor produces directly. We use Bash with a
	// trivial echo so the content is deterministic across hosts.
	args := map[string]any{"command": "printf hi"}
	ctx := context.Background()

	direct, err := exec.Run(ctx, "Bash", args)
	if err != nil {
		t.Fatalf("direct Run: %v", err)
	}
	mcpRes, err := srv.CallTool(ctx, "Bash", args)
	if err != nil {
		t.Fatalf("MCP CallTool: %v", err)
	}
	got := mcpRes.ToRunnerResult()
	if got.OK != direct.OK {
		t.Errorf("OK mismatch: direct=%v mcp=%v", direct.OK, got.OK)
	}
	if got.Content != direct.Content {
		t.Errorf("Content mismatch:\n direct=%q\n mcp=%q", direct.Content, got.Content)
	}
}

func TestCallToolUnknownName(t *testing.T) {
	srv, _ := newServer(t)
	res, err := srv.CallTool(context.Background(), "Frobnicate", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Error("expected IsError=true for unknown tool")
	}
	if !strings.Contains(res.Content[0].Text, "unknown tool") {
		t.Errorf("text = %q, want it to mention 'unknown tool'", res.Content[0].Text)
	}
}

func TestCallToolNilArgsNormalised(t *testing.T) {
	srv, _ := newServer(t)
	// Read with nil args should fail cleanly (missing file_path),
	// not panic on nil-map indexing inside the tool handler.
	res, err := srv.CallTool(context.Background(), "Read", nil)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !res.IsError {
		t.Error("expected IsError=true when file_path missing")
	}
}

func TestToRunnerResultHandlesNil(t *testing.T) {
	var r *CallResult
	got := r.ToRunnerResult()
	if got == nil || got.OK {
		t.Errorf("nil receiver should produce OK=false result, got %+v", got)
	}
}
