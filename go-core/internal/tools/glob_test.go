package tools

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeTree(t *testing.T, root string, files []string) {
	t.Helper()
	for _, f := range files {
		full := filepath.Join(root, f)
		_ = os.MkdirAll(filepath.Dir(full), 0o755)
		if err := os.WriteFile(full, []byte("x"), 0o644); err != nil {
			t.Fatalf("write %s: %v", full, err)
		}
	}
}

func TestGlobRunBasic(t *testing.T) {
	cwd := t.TempDir()
	writeTree(t, cwd, []string{"a.go", "b.go", "sub/c.go", "README.md"})

	e := New(cwd, nil, nil)
	res, _ := e.Run(context.Background(), "Glob", map[string]any{
		"pattern": "**/*.go",
	})
	if !res.OK {
		t.Fatalf("expected OK, got %+v", res)
	}
	for _, want := range []string{"a.go", "b.go", "c.go"} {
		if !strings.Contains(res.Content, want) {
			t.Errorf("missing %s in %q", want, res.Content)
		}
	}
	if strings.Contains(res.Content, "README.md") {
		t.Errorf("md file should not match: %q", res.Content)
	}
}

func TestGlobRunBareNamePattern(t *testing.T) {
	cwd := t.TempDir()
	writeTree(t, cwd, []string{"deep/very/nested/foo.go"})
	e := New(cwd, nil, nil)
	res, _ := e.Run(context.Background(), "Glob", map[string]any{
		"pattern": "*.go",
	})
	if !res.OK {
		t.Fatal("expected OK")
	}
	if !strings.Contains(res.Content, "foo.go") {
		t.Errorf("bare *.go should match nested files: %q", res.Content)
	}
}

func TestGlobRunNoMatches(t *testing.T) {
	cwd := t.TempDir()
	e := New(cwd, nil, nil)
	res, _ := e.Run(context.Background(), "Glob", map[string]any{
		"pattern": "*.nonexistent",
	})
	if !res.OK {
		t.Fatal("expected OK")
	}
	if !strings.Contains(res.Content, "no files") {
		t.Errorf("expected no-match message, got %q", res.Content)
	}
}

func TestGlobRunRejectsTraversal(t *testing.T) {
	e := New(t.TempDir(), nil, nil)
	res, _ := e.Run(context.Background(), "Glob", map[string]any{
		"pattern": "*",
		"path":    "../../etc",
	})
	if res.OK {
		t.Error("expected OK=false on traversal path")
	}
}

func TestGlobMatchUnit(t *testing.T) {
	cases := []struct {
		pat, name string
		want      bool
	}{
		{"*.go", "foo.go", true},
		{"*.go", "foo.txt", false},
		{"**/*.go", "a/b/c.go", true},
		{"src/**/*.ts", "src/a/b/c.ts", true},
		{"src/**/*.ts", "lib/a/b/c.ts", false},
		{"**", "anything/at/all", true},
	}
	for _, c := range cases {
		if got := globMatch(c.pat, c.name); got != c.want {
			t.Errorf("globMatch(%q, %q) = %v, want %v", c.pat, c.name, got, c.want)
		}
	}
}
