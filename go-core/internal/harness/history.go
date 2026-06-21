// History — JSON-file-backed map of (harnessID, yhaSessionID) →
// harness-side session id.
//
// Why this exists: every subprocess-driven harness (claude-binary,
// claude-sdk, codex) has its own opaque session token the upstream
// CLI gives us on the first turn. To continue the conversation on
// the next user message we need to feed that token back via --resume.
// The Node bridge kept this in process memory (claudeSessions Map +
// saveIndexToDisk) and the YHA chat history lived alongside it; the
// Go port keeps the same on-disk shape for inter-process visibility
// (so a `./yha.sh go-reload` doesn't lose conversation continuity).
//
// File format: a top-level JSON object keyed by harnessID; each value
// is { yhaSessionID: harnessSessionID }.
//
//	{
//	  "claude-binary": {
//	    "abc123": "sess_5f...",
//	    "def456": "sess_aa..."
//	  },
//	  "codex": { ... }
//	}
//
// Writes are atomic: write-temp + rename. This protects against
// torn reads if a reader (e.g. another daemon during go-reload) is
// loading the file while a writer is updating it.
package harness

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

// HistoryFileName is the basename appended to BridgeRoot for the
// on-disk store. Exported so tests + tooling can locate it.
const HistoryFileName = "harness-history.json"

// History is the thread-safe, file-backed session-resume index.
// One per daemon; safe for concurrent Get/Set/Delete from multiple
// goroutines. Disk writes are debounced by the simple "write on every
// mutation" policy — the data is tiny (a few hundred bytes per session)
// and writes are infrequent (once per turn, on the first result event).
type History struct {
	path string

	mu   sync.RWMutex
	data map[string]map[string]string
}

// NewHistory returns a History rooted at path. On construction it
// best-effort loads the existing file; a missing file is fine
// (returns an empty store). Corrupt files are reset to empty + an
// error is returned so the caller can log; the store is still usable.
func NewHistory(path string) (*History, error) {
	h := &History{
		path: path,
		data: map[string]map[string]string{},
	}
	if err := h.load(); err != nil {
		return h, err
	}
	return h, nil
}

// NewHistoryInDir is a convenience wrapper — constructs the path from
// bridgeRoot + HistoryFileName. Most callers (cmd/yha-core) want this.
func NewHistoryInDir(bridgeRoot string) (*History, error) {
	return NewHistory(filepath.Join(bridgeRoot, HistoryFileName))
}

// load reads the file once during construction. Missing file is fine;
// returns nil and leaves data empty.
func (h *History) load() error {
	raw, err := os.ReadFile(h.path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		return err
	}
	if len(raw) == 0 {
		return nil
	}
	var decoded map[string]map[string]string
	if err := json.Unmarshal(raw, &decoded); err != nil {
		// Corrupt file — log and start fresh. Returning the error
		// lets the caller surface it on boot.
		return err
	}
	h.mu.Lock()
	h.data = decoded
	if h.data == nil {
		h.data = map[string]map[string]string{}
	}
	h.mu.Unlock()
	return nil
}

// Get returns the harness-side session id for (harnessID, yhaSID), or
// "" + false if no entry exists. Read-locked; cheap on the hot path.
func (h *History) Get(harnessID, yhaSID string) (string, bool) {
	if h == nil || harnessID == "" || yhaSID == "" {
		return "", false
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	bucket, ok := h.data[harnessID]
	if !ok {
		return "", false
	}
	v, ok := bucket[yhaSID]
	return v, ok && v != ""
}

// Set records harnessSID under (harnessID, yhaSID) and persists to
// disk. Writes are atomic via write-temp + rename so a crashed write
// doesn't leave the file half-written. Logs and continues on disk
// failure — the in-memory map stays consistent.
//
// Empty harnessSID is treated as a Delete (matches the Node bridge's
// behaviour where claudeSessions.set(yhaSID, "") effectively dropped
// the resume hint).
func (h *History) Set(harnessID, yhaSID, harnessSID string) error {
	if h == nil || harnessID == "" || yhaSID == "" {
		return nil
	}
	if harnessSID == "" {
		return h.Delete(harnessID, yhaSID)
	}
	// Hold the write lock across persist: concurrent os.Rename onto the
	// same path collide on Windows (ERROR_ACCESS_DENIED / sharing
	// violation), which dropped ~40% of writes under load. Serialising
	// snapshot+persist also keeps the on-disk state monotonic.
	h.mu.Lock()
	defer h.mu.Unlock()
	bucket, ok := h.data[harnessID]
	if !ok {
		bucket = map[string]string{}
		h.data[harnessID] = bucket
	}
	bucket[yhaSID] = harnessSID
	snapshot := h.snapshotLocked()
	return h.persist(snapshot)
}

// Delete drops the entry for (harnessID, yhaSID), if any, and
// persists. Idempotent — deleting an unknown key is a no-op.
func (h *History) Delete(harnessID, yhaSID string) error {
	if h == nil || harnessID == "" || yhaSID == "" {
		return nil
	}
	h.mu.Lock()
	defer h.mu.Unlock()
	bucket, ok := h.data[harnessID]
	if !ok {
		return nil
	}
	if _, present := bucket[yhaSID]; !present {
		return nil
	}
	delete(bucket, yhaSID)
	if len(bucket) == 0 {
		delete(h.data, harnessID)
	}
	snapshot := h.snapshotLocked()
	return h.persist(snapshot)
}

// snapshotLocked returns a deep copy of the data map. Caller must
// hold h.mu (any mode). Set/Delete hand this copy to persist while
// still holding the write lock so concurrent os.Rename calls can't
// interleave (they collide on Windows).
func (h *History) snapshotLocked() map[string]map[string]string {
	out := make(map[string]map[string]string, len(h.data))
	for k, v := range h.data {
		bucket := make(map[string]string, len(v))
		for kk, vv := range v {
			bucket[kk] = vv
		}
		out[k] = bucket
	}
	return out
}

// persist serialises snapshot to disk atomically. Write happens to a
// sibling temp file then os.Rename swaps it in. Returns nil on
// success; surfaces the underlying error otherwise. The in-memory
// state is already mutated by the time persist runs, so a disk error
// here means the caller's next Set/Delete tries to re-persist the
// full state (and may succeed if the disk recovered).
func (h *History) persist(snapshot map[string]map[string]string) error {
	if h.path == "" {
		return nil
	}
	dir := filepath.Dir(h.path)
	if dir != "" {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return err
		}
	}
	buf, err := json.MarshalIndent(snapshot, "", "  ")
	if err != nil {
		return err
	}
	tmp, err := os.CreateTemp(dir, "harness-history-*.json.tmp")
	if err != nil {
		return err
	}
	tmpPath := tmp.Name()
	cleanup := func() {
		_ = tmp.Close()
		_ = os.Remove(tmpPath)
	}
	if _, err := tmp.Write(buf); err != nil {
		cleanup()
		return err
	}
	if err := tmp.Sync(); err != nil {
		cleanup()
		return err
	}
	if err := tmp.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	if err := os.Rename(tmpPath, h.path); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	return nil
}

// Path returns the resolved on-disk path. Exposed for tests + log
// lines.
func (h *History) Path() string {
	if h == nil {
		return ""
	}
	return h.path
}

// FoldMessage is the minimal shape for prior-turn context used by
// CLI harness adapters (claude-binary, codex, grok) when doing a
// manual text fold fallback (no native --resume / session id).
// Adapters map their PriorHistory (stream.Message or equivalent)
// into this before calling the helper.
type FoldMessage struct {
	Role    string
	Content string
}

// FoldPriorHistoryForCLI produces the "[Previous conversation context...]"
// preamble used as cold-start fallback by the subscription harnesses.
// It is the single source of the 16-turn / 32 KiB cap + exact wording
// so the three sites (claude/codex/grok in main) and any future ones
// stay in sync. When resumeID is available the caller should pass the
// bare new Input instead and let --resume do the work.
//
// maxTurns=16, maxChars=32*1024, and the exact preamble string are
// preserved from the prior duplicated implementations for behavioral
// continuity.
func FoldPriorHistoryForCLI(prior []FoldMessage, maxTurns, maxChars int) string {
	if len(prior) == 0 {
		return ""
	}
	hist := prior
	if len(hist) > maxTurns {
		hist = hist[len(hist)-maxTurns:]
	}
	var buf strings.Builder
	for _, m := range hist {
		role := "User"
		if strings.EqualFold(m.Role, "assistant") {
			role = "Assistant"
		}
		body := strings.TrimSpace(m.Content)
		if body == "" {
			continue
		}
		buf.WriteString(role)
		buf.WriteString(": ")
		buf.WriteString(body)
		buf.WriteString("\n\n")
	}
	text := buf.String()
	if len(text) > maxChars {
		text = text[len(text)-maxChars:]
	}
	if strings.TrimSpace(text) == "" {
		return ""
	}
	return "[Previous conversation context — the user has been working with YHA (Your Home Agent) and these turns happened before this one. Continue the same conversation, do not restart from scratch.\n\n" +
		text + "]\n\n"
}
