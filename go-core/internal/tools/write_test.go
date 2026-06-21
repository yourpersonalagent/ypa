package tools

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestWriteRunHappy(t *testing.T) {
	cwd := t.TempDir()
	e := New(cwd, nil, nil)

	res, err := e.Run(context.Background(), "Write", map[string]any{
		"file_path": "sub/hello.txt",
		"content":   "world",
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !res.OK {
		t.Fatalf("expected OK, got %+v", res)
	}
	got, err := os.ReadFile(filepath.Join(cwd, "sub", "hello.txt"))
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if string(got) != "world" {
		t.Errorf("got %q, want %q", got, "world")
	}
	if !strings.Contains(res.Content, "wrote 5 bytes") {
		t.Errorf("expected confirmation, got %q", res.Content)
	}
}

func TestWriteRunCreatesParents(t *testing.T) {
	cwd := t.TempDir()
	e := New(cwd, nil, nil)
	_, _ = e.Run(context.Background(), "Write", map[string]any{
		"file_path": "a/b/c/d.txt",
		"content":   "x",
	})
	if _, err := os.Stat(filepath.Join(cwd, "a/b/c/d.txt")); err != nil {
		t.Errorf("parents not created: %v", err)
	}
}

func TestWriteRunRejectsTraversal(t *testing.T) {
	e := New(t.TempDir(), nil, nil)
	res, _ := e.Run(context.Background(), "Write", map[string]any{
		"file_path": "../../../tmp/escape",
		"content":   "x",
	})
	if res.OK {
		t.Error("expected OK=false on traversal")
	}
}

func TestWriteRunMissingPath(t *testing.T) {
	e := newTestExec(t)
	res, _ := e.Run(context.Background(), "Write", map[string]any{
		"content": "x",
	})
	if res.OK {
		t.Error("expected OK=false on missing file_path")
	}
}

func TestWriteRunOverwrites(t *testing.T) {
	cwd := t.TempDir()
	e := New(cwd, nil, nil)
	_, _ = e.Run(context.Background(), "Write", map[string]any{
		"file_path": "f.txt",
		"content":   "first",
	})
	_, _ = e.Run(context.Background(), "Write", map[string]any{
		"file_path": "f.txt",
		"content":   "second",
	})
	got, _ := os.ReadFile(filepath.Join(cwd, "f.txt"))
	if string(got) != "second" {
		t.Errorf("expected overwrite, got %q", got)
	}
}
