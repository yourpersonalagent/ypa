package stream

import (
	"context"
	"database/sql"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	_ "modernc.org/sqlite"
)

// Bootstraps a temp DB with the same schema bridge/sessions-internal/db.ts
// produces, plus one streaming-placeholder row for FinalizeMessage to hit.
// Keep schema in sync with the bridge's DDL — duplicating here so the test
// doesn't depend on the bridge being present.
const testSchema = `
CREATE TABLE sessions (
  id              TEXT PRIMARY KEY,
  name            TEXT,
  created_at      INTEGER NOT NULL,
  last_used       INTEGER NOT NULL,
  viewed_at       INTEGER NOT NULL DEFAULT 0,
  working_dir     TEXT,
  participants    TEXT,
  name_source     TEXT,
  category        TEXT,
  sensitivity     TEXT,
  in_memory_only  INTEGER NOT NULL DEFAULT 0,
  data            TEXT NOT NULL DEFAULT '{}',
  updated_at      INTEGER NOT NULL
);
CREATE TABLE messages (
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  seq             INTEGER NOT NULL,
  role            TEXT NOT NULL,
  ts              INTEGER NOT NULL,
  text            TEXT,
  streaming       INTEGER NOT NULL DEFAULT 0,
  live_token      INTEGER,
  live_deadline   INTEGER,
  data            TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (session_id, seq)
);
CREATE TABLE claude_sessions (
  session_id      TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  claude_id       TEXT NOT NULL
);
CREATE TABLE meta (
  key             TEXT PRIMARY KEY,
  value           TEXT NOT NULL
);
INSERT INTO meta(key, value) VALUES ('schema_version', '1');
`

func setupTestDB(t *testing.T) (string, func()) {
	t.Helper()
	dir, err := os.MkdirTemp("", "yha-sqlite-fin-")
	if err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	dbPath := filepath.Join(dir, "sessions.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	if _, err := db.Exec(testSchema); err != nil {
		t.Fatalf("schema: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO sessions (id, name, created_at, last_used, viewed_at, working_dir, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, '{}', ?)`,
		"sess-1", "test", 1000, 1000, 0, "/tmp", 1000); err != nil {
		t.Fatalf("seed session: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO messages (session_id, seq, role, ts, text, streaming, live_token, live_deadline, data) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}')`,
		"sess-1", 0, "assistant", 1100, nil, 1, 12345, 9999999); err != nil {
		t.Fatalf("seed msg: %v", err)
	}
	db.Close()
	return dbPath, func() { os.RemoveAll(dir) }
}

func TestSQLiteFinalizer_FinalizeMessage(t *testing.T) {
	dbPath, cleanup := setupTestDB(t)
	defer cleanup()

	f, err := OpenSQLiteFinalizer(dbPath)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer f.Close()

	payload := PersistMessagePayload{
		SessionID:    "sess-1",
		Role:         "assistant",
		Blocks:       []PersistBlock{{Type: "text", Content: "hello world"}},
		Model:        "claude-opus-4-7",
		Provider:     "anthropic",
		InputTokens:  100,
		OutputTokens: 50,
		StopReason:   "end_turn",
		Phase:        "final",
		LiveToken:    12345,
	}

	ok, err := f.FinalizeMessage(context.Background(), payload)
	if err != nil {
		t.Fatalf("finalize: %v", err)
	}
	if !ok {
		t.Fatalf("expected ok=true, got false")
	}

	// Verify the row was updated.
	db, _ := sql.Open("sqlite", dbPath)
	defer db.Close()

	var streaming int
	var liveToken sql.NullInt64
	var liveDeadline sql.NullInt64
	var text sql.NullString
	var data string
	err = db.QueryRow(`SELECT streaming, live_token, live_deadline, text, data FROM messages WHERE session_id=? AND seq=?`, "sess-1", 0).
		Scan(&streaming, &liveToken, &liveDeadline, &text, &data)
	if err != nil {
		t.Fatalf("readback: %v", err)
	}
	if streaming != 0 {
		t.Errorf("streaming: want 0, got %d", streaming)
	}
	if liveToken.Valid {
		t.Errorf("live_token: want NULL, got %d", liveToken.Int64)
	}
	if liveDeadline.Valid {
		t.Errorf("live_deadline: want NULL, got %d", liveDeadline.Int64)
	}
	if text.Valid {
		t.Errorf("text: want NULL (blocks present), got %q", text.String)
	}
	var parsed map[string]any
	if err := json.Unmarshal([]byte(data), &parsed); err != nil {
		t.Fatalf("data json: %v", err)
	}
	if blocks, ok := parsed["blocks"].([]any); !ok || len(blocks) != 1 {
		t.Errorf("blocks: want 1, got %#v", parsed["blocks"])
	}
	meta, ok := parsed["meta"].(map[string]any)
	if !ok {
		t.Fatalf("meta missing")
	}
	if meta["model"] != "claude-opus-4-7" {
		t.Errorf("meta.model: got %v", meta["model"])
	}

	// last_used should have advanced.
	var lastUsed int64
	if err := db.QueryRow("SELECT last_used FROM sessions WHERE id=?", "sess-1").Scan(&lastUsed); err != nil {
		t.Fatalf("session readback: %v", err)
	}
	if lastUsed <= 1000 {
		t.Errorf("last_used: want > 1000 (touched), got %d", lastUsed)
	}
}

func TestSQLiteFinalizer_NoMatchingToken(t *testing.T) {
	dbPath, cleanup := setupTestDB(t)
	defer cleanup()

	f, err := OpenSQLiteFinalizer(dbPath)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer f.Close()

	ok, err := f.FinalizeMessage(context.Background(), PersistMessagePayload{
		SessionID: "sess-1",
		Role:      "assistant",
		Phase:     "final",
		LiveToken: 99999, // not the seeded 12345
		Text:      "hi",
	})
	if err != nil {
		t.Fatalf("finalize: %v", err)
	}
	if ok {
		t.Errorf("expected ok=false (no matching token), got true")
	}
}

func TestSQLiteFinalizer_SkipsNonFinalPhase(t *testing.T) {
	dbPath, cleanup := setupTestDB(t)
	defer cleanup()

	f, err := OpenSQLiteFinalizer(dbPath)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer f.Close()

	for _, phase := range []string{"", "start", "update"} {
		ok, err := f.FinalizeMessage(context.Background(), PersistMessagePayload{
			SessionID: "sess-1",
			Role:      "assistant",
			Phase:     phase,
			LiveToken: 12345,
		})
		if err != nil {
			t.Fatalf("phase=%q: %v", phase, err)
		}
		if ok {
			t.Errorf("phase=%q: expected ok=false, got true", phase)
		}
	}
}

func TestSQLiteFinalizer_SchemaVersionMismatch(t *testing.T) {
	dir, err := os.MkdirTemp("", "yha-sqlite-fin-bad-")
	if err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	defer os.RemoveAll(dir)
	dbPath := filepath.Join(dir, "sessions.db")

	db, _ := sql.Open("sqlite", dbPath)
	if _, err := db.Exec(testSchema); err != nil {
		t.Fatalf("schema: %v", err)
	}
	// Force a version we don't support.
	if _, err := db.Exec(`UPDATE meta SET value='9999' WHERE key='schema_version'`); err != nil {
		t.Fatalf("bump: %v", err)
	}
	db.Close()

	f, err := OpenSQLiteFinalizer(dbPath)
	if err == nil {
		f.Close()
		t.Fatalf("expected schema mismatch error, got nil")
	}
}

func TestSQLiteFinalizer_NilSafe(t *testing.T) {
	var f *SQLiteFinalizer // nil
	ok, err := f.FinalizeMessage(context.Background(), PersistMessagePayload{Phase: "final", SessionID: "x", LiveToken: 1})
	if err != nil {
		t.Errorf("nil receiver finalize: %v", err)
	}
	if ok {
		t.Errorf("nil receiver finalize: want false, got true")
	}
	// SessionWorkingDir / SessionParticipants must also be nil-safe.
	if wd, ok := f.SessionWorkingDir("x"); ok || wd != "" {
		t.Errorf("nil SessionWorkingDir: want (\"\", false), got (%q, %v)", wd, ok)
	}
	if parts, gm, ok := f.SessionParticipants("x"); ok || parts != nil || gm != "" {
		t.Errorf("nil SessionParticipants: want (nil, \"\", false), got (%v, %q, %v)", parts, gm, ok)
	}
	if err := f.Close(); err != nil {
		t.Errorf("nil close: %v", err)
	}
}

func TestSQLiteFinalizer_SessionWorkingDir(t *testing.T) {
	dbPath, cleanup := setupTestDB(t)
	defer cleanup()

	// Seed two extra sessions: one with a pinned workingDir, one without.
	db, _ := sql.Open("sqlite", dbPath)
	if _, err := db.Exec(`INSERT INTO sessions (id, name, created_at, last_used, working_dir, data, updated_at) VALUES (?,?,?,?,?,?,?)`,
		"with-wd", "A", 1, 1, "/home/me/project", "{}", 1); err != nil {
		t.Fatalf("seed with-wd: %v", err)
	}
	if _, err := db.Exec(`INSERT INTO sessions (id, name, created_at, last_used, working_dir, data, updated_at) VALUES (?,?,?,?,?,?,?)`,
		"no-wd", "B", 1, 1, nil, "{}", 1); err != nil {
		t.Fatalf("seed no-wd: %v", err)
	}
	db.Close()

	f, err := OpenSQLiteFinalizer(dbPath)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer f.Close()

	if wd, ok := f.SessionWorkingDir("with-wd"); !ok || wd != "/home/me/project" {
		t.Errorf("with-wd: got (%q, %v); want (\"/home/me/project\", true)", wd, ok)
	}
	if wd, ok := f.SessionWorkingDir("no-wd"); !ok || wd != "" {
		t.Errorf("no-wd: got (%q, %v); want (\"\", true)", wd, ok)
	}
	if wd, ok := f.SessionWorkingDir("nonexistent"); ok || wd != "" {
		t.Errorf("nonexistent: got (%q, %v); want (\"\", false)", wd, ok)
	}
}

func TestSQLiteFinalizer_SessionParticipants(t *testing.T) {
	dbPath, cleanup := setupTestDB(t)
	defer cleanup()

	db, _ := sql.Open("sqlite", dbPath)
	// Group session: participants array + groupMode in data blob.
	if _, err := db.Exec(`INSERT INTO sessions (id, name, created_at, last_used, participants, data, updated_at) VALUES (?,?,?,?,?,?,?)`,
		"grp-1", "G", 1, 1, `["ceo","sandy"]`, `{"groupMode":"sequential","tags":["x"]}`, 1); err != nil {
		t.Fatalf("seed grp: %v", err)
	}
	// Solo session: no participants.
	if _, err := db.Exec(`INSERT INTO sessions (id, name, created_at, last_used, participants, data, updated_at) VALUES (?,?,?,?,?,?,?)`,
		"solo-1", "S", 1, 1, nil, "{}", 1); err != nil {
		t.Fatalf("seed solo: %v", err)
	}
	db.Close()

	f, err := OpenSQLiteFinalizer(dbPath)
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	defer f.Close()

	parts, gm, ok := f.SessionParticipants("grp-1")
	if !ok {
		t.Fatalf("grp-1 not found")
	}
	if len(parts) != 2 || parts[0] != "ceo" || parts[1] != "sandy" {
		t.Errorf("grp-1 participants: got %v", parts)
	}
	if gm != "sequential" {
		t.Errorf("grp-1 groupMode: got %q", gm)
	}

	parts, gm, ok = f.SessionParticipants("solo-1")
	if !ok {
		t.Fatalf("solo-1 not found")
	}
	if parts != nil || gm != "" {
		t.Errorf("solo-1: want (nil, \"\"), got (%v, %q)", parts, gm)
	}

	if parts, gm, ok := f.SessionParticipants("nonexistent"); ok || parts != nil || gm != "" {
		t.Errorf("nonexistent: want (nil, \"\", false), got (%v, %q, %v)", parts, gm, ok)
	}
}
