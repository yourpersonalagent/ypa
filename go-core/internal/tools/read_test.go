package tools

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReadRunHappy(t *testing.T) {
	cwd := t.TempDir()
	p := filepath.Join(cwd, "hi.txt")
	_ = os.WriteFile(p, []byte("alpha\nbeta\ngamma\n"), 0o644)

	e := New(cwd, nil, nil)
	res, err := e.Run(context.Background(), "Read", map[string]any{
		"file_path": "hi.txt",
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if !res.OK {
		t.Fatalf("expected OK, got %+v", res)
	}
	// Expect cat -n style output.
	if !strings.Contains(res.Content, "1\talpha") {
		t.Errorf("missing line numbering: %q", res.Content)
	}
	if !strings.Contains(res.Content, "3\tgamma") {
		t.Errorf("missing line 3: %q", res.Content)
	}
	if tot, _ := res.Meta["total_lines"].(int); tot != 3 {
		t.Errorf("expected total_lines=3, got %v", res.Meta["total_lines"])
	}
}

func TestReadRunOffsetLimit(t *testing.T) {
	cwd := t.TempDir()
	p := filepath.Join(cwd, "many.txt")
	var b strings.Builder
	for i := 1; i <= 50; i++ {
		b.WriteString("line\n")
	}
	_ = os.WriteFile(p, []byte(b.String()), 0o644)

	e := New(cwd, nil, nil)
	res, _ := e.Run(context.Background(), "Read", map[string]any{
		"file_path": "many.txt",
		"offset":    float64(10),
		"limit":     float64(5),
	})
	if !res.OK {
		t.Fatal("expected OK")
	}
	// Should include lines 10..14 and not 9 / 15.
	if !strings.Contains(res.Content, "10\tline") {
		t.Errorf("missing offset 10: %q", res.Content)
	}
	if strings.Contains(res.Content, "    9\tline") {
		t.Errorf("offset not honoured: %q", res.Content)
	}
}

func TestReadRunBinaryFile(t *testing.T) {
	cwd := t.TempDir()
	p := filepath.Join(cwd, "bin.dat")
	_ = os.WriteFile(p, []byte{0x00, 0x01, 0x02, 0x03, 0xff, 0x00}, 0o644)

	e := New(cwd, nil, nil)
	res, _ := e.Run(context.Background(), "Read", map[string]any{
		"file_path": "bin.dat",
	})
	if !res.OK {
		t.Fatal("expected OK on binary file")
	}
	if !strings.Contains(res.Content, "binary file") {
		t.Errorf("expected binary marker, got %q", res.Content)
	}
}

func TestReadRunRejectsTraversal(t *testing.T) {
	e := New(t.TempDir(), nil, nil)
	res, _ := e.Run(context.Background(), "Read", map[string]any{
		"file_path": "../../../etc/passwd",
	})
	if res.OK {
		t.Error("expected OK=false on traversal")
	}
}

func TestReadRunMissingPath(t *testing.T) {
	e := newTestExec(t)
	res, _ := e.Run(context.Background(), "Read", map[string]any{})
	if res.OK {
		t.Error("expected OK=false on missing file_path")
	}
}
