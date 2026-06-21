package tools

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

func TestGrepRunContent(t *testing.T) {
	cwd := t.TempDir()
	_ = os.WriteFile(filepath.Join(cwd, "a.go"), []byte("hello world\nfoo bar\nhello again\n"), 0o644)
	_ = os.WriteFile(filepath.Join(cwd, "b.go"), []byte("nothing here\n"), 0o644)

	e := New(cwd, nil, nil)
	res, _ := e.Run(context.Background(), "Grep", map[string]any{
		"pattern": "hello",
		"-n":      true,
	})
	if !res.OK {
		t.Fatal("expected OK")
	}
	if !strings.Contains(res.Content, "a.go:1:hello world") {
		t.Errorf("missing line-numbered match: %q", res.Content)
	}
	if strings.Contains(res.Content, "b.go") {
		t.Errorf("non-matching file should not appear: %q", res.Content)
	}
}

func TestGrepRunFilesWithMatches(t *testing.T) {
	cwd := t.TempDir()
	_ = os.WriteFile(filepath.Join(cwd, "a.txt"), []byte("alpha"), 0o644)
	_ = os.WriteFile(filepath.Join(cwd, "b.txt"), []byte("beta"), 0o644)

	e := New(cwd, nil, nil)
	res, _ := e.Run(context.Background(), "Grep", map[string]any{
		"pattern":     "alpha",
		"output_mode": "files_with_matches",
	})
	if !res.OK {
		t.Fatal("expected OK")
	}
	if !strings.Contains(res.Content, "a.txt") {
		t.Errorf("missing matching file: %q", res.Content)
	}
	if strings.Contains(res.Content, "b.txt") {
		t.Errorf("b.txt should not appear: %q", res.Content)
	}
}

func TestGrepRunCount(t *testing.T) {
	cwd := t.TempDir()
	_ = os.WriteFile(filepath.Join(cwd, "f.txt"), []byte("x\nx\nx\ny\n"), 0o644)

	e := New(cwd, nil, nil)
	res, _ := e.Run(context.Background(), "Grep", map[string]any{
		"pattern":     "x",
		"output_mode": "count",
	})
	if !res.OK {
		t.Fatal("expected OK")
	}
	if !strings.Contains(res.Content, ":3") {
		t.Errorf("expected count :3, got %q", res.Content)
	}
}

func TestGrepRunCaseInsensitive(t *testing.T) {
	cwd := t.TempDir()
	_ = os.WriteFile(filepath.Join(cwd, "f.txt"), []byte("Hello\nworld\n"), 0o644)

	e := New(cwd, nil, nil)
	res, _ := e.Run(context.Background(), "Grep", map[string]any{
		"pattern": "hello",
		"-i":      true,
	})
	if !res.OK {
		t.Fatal("expected OK")
	}
	if !strings.Contains(res.Content, "Hello") {
		t.Errorf("case-insensitive should match: %q", res.Content)
	}
}

func TestGrepRunGlobFilter(t *testing.T) {
	cwd := t.TempDir()
	_ = os.WriteFile(filepath.Join(cwd, "a.go"), []byte("match"), 0o644)
	_ = os.WriteFile(filepath.Join(cwd, "a.md"), []byte("match"), 0o644)

	e := New(cwd, nil, nil)
	res, _ := e.Run(context.Background(), "Grep", map[string]any{
		"pattern": "match",
		"glob":    "*.go",
	})
	if !res.OK {
		t.Fatal("expected OK")
	}
	if !strings.Contains(res.Content, "a.go") {
		t.Errorf("missing .go file: %q", res.Content)
	}
	if strings.Contains(res.Content, "a.md") {
		t.Errorf("glob filter not applied: %q", res.Content)
	}
}

func TestGrepRunBadRegex(t *testing.T) {
	e := newTestExec(t)
	res, _ := e.Run(context.Background(), "Grep", map[string]any{
		"pattern": "[unclosed",
	})
	if res.OK {
		t.Error("expected OK=false on bad regex")
	}
}

func TestGrepRunRejectsTraversal(t *testing.T) {
	e := New(t.TempDir(), nil, nil)
	res, _ := e.Run(context.Background(), "Grep", map[string]any{
		"pattern": "x",
		"path":    "../../etc",
	})
	if res.OK {
		t.Error("expected OK=false on traversal")
	}
}

// withRgPath temporarily overrides the package-level rgPath var. Used
// to force the pure-Go fallback path in tests even when the dev host
// has ripgrep installed. Restores the original value via t.Cleanup.
func withRgPath(t *testing.T, p string) {
	t.Helper()
	orig := rgPath
	rgPath = p
	t.Cleanup(func() { rgPath = orig })
}

func TestGrepUsesRipgrepWhenAvailable(t *testing.T) {
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("rg not installed; skipping ripgrep-path test")
	}
	// Force-use whatever rg is on PATH (in case a previous test pinned
	// the package var to "").
	withRgPath(t, mustRgPath(t))

	cwd := t.TempDir()
	_ = os.WriteFile(filepath.Join(cwd, "a.go"), []byte("hello world\nfoo bar\nhello again\n"), 0o644)
	_ = os.WriteFile(filepath.Join(cwd, "b.go"), []byte("nothing here\n"), 0o644)

	e := New(cwd, nil, nil)
	res, _ := e.Run(context.Background(), "Grep", map[string]any{
		"pattern": "hello",
		"-n":      true,
	})
	if !res.OK {
		t.Fatalf("expected OK, got Error=%q", res.Error)
	}
	if !strings.Contains(res.Content, "a.go:1:hello world") {
		t.Errorf("missing line-numbered match: %q", res.Content)
	}
	if !strings.Contains(res.Content, "a.go:3:hello again") {
		t.Errorf("missing second match: %q", res.Content)
	}
	if strings.Contains(res.Content, "b.go") {
		t.Errorf("non-matching file should not appear: %q", res.Content)
	}
}

func TestGrepFallsBackWhenRipgrepMissing(t *testing.T) {
	withRgPath(t, "") // force pure-Go path

	cwd := t.TempDir()
	_ = os.WriteFile(filepath.Join(cwd, "a.go"), []byte("hello world\nfoo bar\nhello again\n"), 0o644)
	_ = os.WriteFile(filepath.Join(cwd, "b.go"), []byte("nothing here\n"), 0o644)

	e := New(cwd, nil, nil)
	res, _ := e.Run(context.Background(), "Grep", map[string]any{
		"pattern": "hello",
		"-n":      true,
	})
	if !res.OK {
		t.Fatalf("expected OK, got Error=%q", res.Error)
	}
	if !strings.Contains(res.Content, "a.go:1:hello world") {
		t.Errorf("missing line-numbered match: %q", res.Content)
	}
	if strings.Contains(res.Content, "b.go") {
		t.Errorf("non-matching file should not appear: %q", res.Content)
	}
}

func TestGrepSkipsDefaultNoiseDirs(t *testing.T) {
	// Exercise the pure-Go fallback so the assertion holds regardless
	// of whether rg is on the dev host.
	withRgPath(t, "")

	cwd := t.TempDir()
	// Place a match inside each default-skip dir AND a control file at
	// the top level. The skip dirs must NOT contribute hits.
	for _, dir := range []string{".git", "node_modules", ".venv", "dist", "build"} {
		if err := os.MkdirAll(filepath.Join(cwd, dir), 0o755); err != nil {
			t.Fatal(err)
		}
		_ = os.WriteFile(filepath.Join(cwd, dir, "f.txt"), []byte("needle\n"), 0o644)
	}
	_ = os.WriteFile(filepath.Join(cwd, "top.txt"), []byte("needle\n"), 0o644)

	e := New(cwd, nil, nil)
	res, _ := e.Run(context.Background(), "Grep", map[string]any{
		"pattern":     "needle",
		"output_mode": "files_with_matches",
	})
	if !res.OK {
		t.Fatalf("expected OK, got Error=%q", res.Error)
	}
	if !strings.Contains(res.Content, "top.txt") {
		t.Errorf("top-level file should match: %q", res.Content)
	}
	for _, dir := range []string{".git", "node_modules", ".venv", "dist", "build"} {
		if strings.Contains(res.Content, string(filepath.Separator)+dir+string(filepath.Separator)) {
			t.Errorf("default-skip dir %q should not appear: %q", dir, res.Content)
		}
	}
}

func TestGrepRipgrepSkipsDefaultNoiseDirs(t *testing.T) {
	if _, err := exec.LookPath("rg"); err != nil {
		t.Skip("rg not installed; skipping ripgrep-path test")
	}
	withRgPath(t, mustRgPath(t))

	cwd := t.TempDir()
	for _, dir := range []string{".git", "node_modules", "dist"} {
		if err := os.MkdirAll(filepath.Join(cwd, dir), 0o755); err != nil {
			t.Fatal(err)
		}
		_ = os.WriteFile(filepath.Join(cwd, dir, "f.txt"), []byte("needle\n"), 0o644)
	}
	_ = os.WriteFile(filepath.Join(cwd, "top.txt"), []byte("needle\n"), 0o644)

	e := New(cwd, nil, nil)
	res, _ := e.Run(context.Background(), "Grep", map[string]any{
		"pattern":     "needle",
		"output_mode": "files_with_matches",
	})
	if !res.OK {
		t.Fatalf("expected OK, got Error=%q", res.Error)
	}
	if !strings.Contains(res.Content, "top.txt") {
		t.Errorf("top-level file should match: %q", res.Content)
	}
	for _, dir := range []string{".git", "node_modules", "dist"} {
		if strings.Contains(res.Content, string(filepath.Separator)+dir+string(filepath.Separator)) {
			t.Errorf("default-skip dir %q should not appear: %q", dir, res.Content)
		}
	}
}

func mustRgPath(t *testing.T) string {
	t.Helper()
	p, err := exec.LookPath("rg")
	if err != nil {
		t.Fatalf("rg not on PATH: %v", err)
	}
	return p
}
