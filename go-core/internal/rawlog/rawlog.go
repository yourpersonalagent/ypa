// Package rawlog writes provider request/response audit entries to
// bridge/api-inout-log/session-NNNN.log. Mirrors Node's
// bridge/observability/raw-logs.ts:logRaw — same directory, same YAML-
// ish line format, same per-process session file with rotate-after-5.
//
// Used by the stream route to capture every direct-API request body
// and final assistant text so forensic analysis of a botched turn
// has the same evidence trail it did pre-Phase-7.
package rawlog

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

// MaxSessionFiles caps how many old session-NNNN.log files we keep.
// Mirrors Node's MAX_SESSION_FILES = 5.
const MaxSessionFiles = 5

// Logger is the per-process audit appender. One per daemon; safe for
// concurrent use. Initial file selection (next available index +1)
// happens on first Write.
type Logger struct {
	dir     string
	enabled bool

	once sync.Once
	mu   sync.Mutex
	f    *os.File
	path string
}

// New constructs a Logger writing to dir. Empty dir disables all
// writes (helpful in tests).
func New(dir string) *Logger {
	return &Logger{dir: dir, enabled: dir != ""}
}

// SetEnabled toggles logging on or off without recycling the
// underlying file. Mirrors Node's setLoggingEnabled.
func (l *Logger) SetEnabled(v bool) {
	if l == nil {
		return
	}
	l.mu.Lock()
	l.enabled = v && l.dir != ""
	l.mu.Unlock()
}

// Path returns the resolved log file path for the current session,
// initialising it on first call. Empty string when disabled or the
// file couldn't be opened.
func (l *Logger) Path() string {
	if l == nil {
		return ""
	}
	l.ensureFile()
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.path
}

// Write appends one entry. kind/phase are short opaque tags (e.g.
// "model"/"in", "model"/"out", "tool"/"out"); payload is anything
// JSON-encodable. Strings are written verbatim, everything else is
// pretty-printed. Mirrors Node's logRaw format exactly so a downstream
// grep / parser keeps working.
func (l *Logger) Write(kind, phase string, payload any, meta map[string]any) {
	if l == nil {
		return
	}
	l.mu.Lock()
	if !l.enabled {
		l.mu.Unlock()
		return
	}
	l.mu.Unlock()
	l.ensureFile()
	line := buildLine(kind, phase, payload, meta)
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.f == nil {
		return
	}
	_, _ = l.f.WriteString(line)
}

// Close flushes and closes the underlying file. Safe to call multiple
// times; the Logger refuses subsequent writes after Close.
func (l *Logger) Close() {
	if l == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	l.enabled = false
	if l.f != nil {
		_ = l.f.Close()
		l.f = nil
	}
}

func (l *Logger) ensureFile() {
	l.once.Do(func() {
		if l.dir == "" {
			return
		}
		if err := os.MkdirAll(l.dir, 0o755); err != nil {
			return
		}
		idx := nextSessionIndex(l.dir)
		path := filepath.Join(l.dir, sessionFileName(idx))
		f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
		if err != nil {
			return
		}
		l.mu.Lock()
		l.f = f
		l.path = path
		l.mu.Unlock()
		pruneOldFiles(l.dir)
	})
}

func sessionFileName(idx int) string {
	return fmt.Sprintf("session-%04d.log", idx)
}

var sessionFileRe = regexp.MustCompile(`^session-(\d+)\.log$`)

func nextSessionIndex(dir string) int {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return 1
	}
	max := 0
	for _, e := range entries {
		m := sessionFileRe.FindStringSubmatch(e.Name())
		if m == nil {
			continue
		}
		if n, err := strconv.Atoi(m[1]); err == nil && n > max {
			max = n
		}
	}
	return max + 1
}

func pruneOldFiles(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	type indexed struct {
		idx  int
		name string
	}
	var keep []indexed
	for _, e := range entries {
		m := sessionFileRe.FindStringSubmatch(e.Name())
		if m == nil {
			continue
		}
		if n, err := strconv.Atoi(m[1]); err == nil {
			keep = append(keep, indexed{idx: n, name: e.Name()})
		}
	}
	sort.Slice(keep, func(i, j int) bool { return keep[i].idx > keep[j].idx })
	for i, k := range keep {
		if i < MaxSessionFiles {
			continue
		}
		_ = os.Remove(filepath.Join(dir, k.name))
	}
}

func buildLine(kind, phase string, payload any, meta map[string]any) string {
	var b strings.Builder
	b.WriteString("---\n")
	b.WriteString("ts: ")
	b.WriteString(time.Now().UTC().Format(time.RFC3339Nano))
	b.WriteByte('\n')
	b.WriteString("kind: ")
	b.WriteString(kind)
	b.WriteByte('\n')
	b.WriteString("phase: ")
	b.WriteString(phase)
	b.WriteByte('\n')
	b.WriteString("meta: ")
	b.WriteString(safeSerialize(meta))
	b.WriteByte('\n')
	b.WriteString("payload:\n")
	b.WriteString(safeSerialize(payload))
	b.WriteByte('\n')
	return b.String()
}

func safeSerialize(v any) string {
	if v == nil {
		return "null"
	}
	if s, ok := v.(string); ok {
		return s
	}
	out, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return fmt.Sprintf("%q", fmt.Sprint(v))
	}
	return string(out)
}
