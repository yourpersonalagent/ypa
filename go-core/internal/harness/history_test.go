package harness

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"testing"
)

func TestHistoryEmpty(t *testing.T) {
	dir := t.TempDir()
	h, err := NewHistory(filepath.Join(dir, "harness-history.json"))
	if err != nil {
		t.Fatalf("NewHistory: %v", err)
	}
	if _, ok := h.Get("claude-binary", "abc"); ok {
		t.Errorf("expected miss on empty history")
	}
}

func TestHistorySetGet(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "harness-history.json")
	h, err := NewHistory(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := h.Set("claude-binary", "yha-1", "sess-AAA"); err != nil {
		t.Fatalf("Set: %v", err)
	}
	v, ok := h.Get("claude-binary", "yha-1")
	if !ok || v != "sess-AAA" {
		t.Errorf("Get = (%q, %v), want (sess-AAA, true)", v, ok)
	}
	// File written.
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("file read: %v", err)
	}
	var decoded map[string]map[string]string
	if err := json.Unmarshal(raw, &decoded); err != nil {
		t.Fatalf("file parse: %v", err)
	}
	if decoded["claude-binary"]["yha-1"] != "sess-AAA" {
		t.Errorf("on-disk content wrong: %v", decoded)
	}
}

func TestHistoryReload(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "harness-history.json")
	h1, _ := NewHistory(path)
	_ = h1.Set("claude-binary", "yha-1", "sess-1")
	_ = h1.Set("codex", "yha-2", "sess-2")

	h2, err := NewHistory(path)
	if err != nil {
		t.Fatalf("re-open: %v", err)
	}
	if v, _ := h2.Get("claude-binary", "yha-1"); v != "sess-1" {
		t.Errorf("after reload claude-binary/yha-1 = %q", v)
	}
	if v, _ := h2.Get("codex", "yha-2"); v != "sess-2" {
		t.Errorf("after reload codex/yha-2 = %q", v)
	}
}

func TestHistoryDelete(t *testing.T) {
	dir := t.TempDir()
	h, _ := NewHistory(filepath.Join(dir, "harness-history.json"))
	_ = h.Set("claude-binary", "yha-1", "sess-1")
	_ = h.Delete("claude-binary", "yha-1")
	if _, ok := h.Get("claude-binary", "yha-1"); ok {
		t.Errorf("expected miss after delete")
	}
	// Idempotent.
	if err := h.Delete("claude-binary", "yha-1"); err != nil {
		t.Errorf("Delete idempotency: %v", err)
	}
	if err := h.Delete("missing", "missing"); err != nil {
		t.Errorf("Delete unknown: %v", err)
	}
}

func TestHistorySetEmptyValueDeletes(t *testing.T) {
	dir := t.TempDir()
	h, _ := NewHistory(filepath.Join(dir, "harness-history.json"))
	_ = h.Set("claude-binary", "yha-1", "sess-1")
	_ = h.Set("claude-binary", "yha-1", "")
	if _, ok := h.Get("claude-binary", "yha-1"); ok {
		t.Errorf("empty value should drop the entry")
	}
}

func TestHistoryNilSafe(t *testing.T) {
	var h *History
	if v, ok := h.Get("x", "y"); ok || v != "" {
		t.Errorf("nil Get = (%q, %v)", v, ok)
	}
	if err := h.Set("x", "y", "z"); err != nil {
		t.Errorf("nil Set: %v", err)
	}
	if err := h.Delete("x", "y"); err != nil {
		t.Errorf("nil Delete: %v", err)
	}
	if h.Path() != "" {
		t.Errorf("nil Path should be empty")
	}
}

func TestHistoryMissingFileTreatedAsEmpty(t *testing.T) {
	dir := t.TempDir()
	h, err := NewHistory(filepath.Join(dir, "definitely-not-there.json"))
	if err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	if _, ok := h.Get("claude-binary", "x"); ok {
		t.Errorf("expected miss")
	}
}

func TestHistoryCorruptFileReturnsErrorButUsable(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "corrupt.json")
	if err := os.WriteFile(path, []byte("not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	h, err := NewHistory(path)
	if err == nil {
		t.Errorf("expected error reading corrupt file")
	}
	if h == nil {
		t.Fatal("history should still be usable")
	}
	// Should still accept writes (overwriting the corrupt file).
	if err := h.Set("claude-binary", "y", "s"); err != nil {
		t.Errorf("Set on corrupt-recovery: %v", err)
	}
	if v, _ := h.Get("claude-binary", "y"); v != "s" {
		t.Errorf("after corrupt-recovery write Get = %q", v)
	}
}

func TestHistoryConcurrentWrites(t *testing.T) {
	dir := t.TempDir()
	h, err := NewHistory(filepath.Join(dir, "harness-history.json"))
	if err != nil {
		t.Fatal(err)
	}
	const workers = 16
	const writes = 50
	var wg sync.WaitGroup
	var failures atomic.Int32
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func(w int) {
			defer wg.Done()
			for i := 0; i < writes; i++ {
				yhaSID := keyName(w, i)
				if err := h.Set("claude-binary", yhaSID, "sess-"+yhaSID); err != nil {
					failures.Add(1)
				}
			}
		}(w)
	}
	wg.Wait()
	if failures.Load() != 0 {
		t.Errorf("had %d write failures", failures.Load())
	}
	// Verify every entry persisted (in memory + on disk).
	for w := 0; w < workers; w++ {
		for i := 0; i < writes; i++ {
			yhaSID := keyName(w, i)
			v, ok := h.Get("claude-binary", yhaSID)
			if !ok || v != "sess-"+yhaSID {
				t.Errorf("missing key %s: ok=%v v=%q", yhaSID, ok, v)
			}
		}
	}
	// Reload from disk and verify the last write made it.
	h2, err := NewHistory(h.Path())
	if err != nil {
		t.Fatalf("reload: %v", err)
	}
	if v, _ := h2.Get("claude-binary", keyName(0, 0)); v != "sess-"+keyName(0, 0) {
		t.Errorf("reload lost data: got %q", v)
	}
}

func TestHistoryNewHistoryInDirUsesConst(t *testing.T) {
	dir := t.TempDir()
	h, err := NewHistoryInDir(dir)
	if err != nil {
		t.Fatal(err)
	}
	want := filepath.Join(dir, HistoryFileName)
	if h.Path() != want {
		t.Errorf("Path = %q, want %q", h.Path(), want)
	}
}

func keyName(w, i int) string {
	// Tiny helper keeps the concurrent test compact.
	return "yha-" + itoa(w) + "-" + itoa(i)
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}
