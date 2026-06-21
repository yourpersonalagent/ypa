// Package-local SQLite finalize writer — Step 6 of docs/SQL-migration-plan.md.
//
// The bridge owns the durable session store (bridge/data/sessions.db, schema
// defined in bridge/sessions-internal/db.ts). Until Step 6 the bridge was
// also the only writer: Go shipped `phase:"final"` over HTTP and the bridge
// translated to SQL. That left a tiny window where bridge restart between
// the FE seeing _end and the bridge persisting final dropped the
// `streaming:true` flag, surfacing as the "Bridge restarted before this
// reply could finish" interrupt to users.
//
// This file makes Go write finalize directly to SQLite. The HTTP POST is
// still issued afterwards so the bridge's in-memory displaySessions Map
// stays in sync, but the HTTP call is no longer on the critical path for
// durability — even if the bridge is dead at the moment finalize fires,
// the message lands cleanly in the DB and next-boot loads it as a
// completed turn.
//
// Driver: modernc.org/sqlite (pure-Go, no CGo) — picked for the same
// reason bun:sqlite was picked on the bridge side: aarch64 + no native
// build dance on the Pi.

package stream

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	_ "modernc.org/sqlite"
)

// Must track bridge/sessions-internal/db.ts:SCHEMA_VERSION. A boot-time
// check compares this against the meta.schema_version row and refuses to
// open otherwise — schema bumps require a coordinated Go release.
const sqliteFinalizeSchemaVersion = 1

// SQLiteFinalizer owns the long-lived *sql.DB handle Go uses to write
// finalize directly. nil-tolerant — every method checks for nil receiver
// or nil db so callers can wire it conditionally without nil-guarding
// every call-site.
type SQLiteFinalizer struct {
	db           *sql.DB
	updateMsg    *sql.Stmt
	touchSession *sql.Stmt
}

// OpenSQLiteFinalizer opens the bridge's sessions.db in WAL mode, verifies
// the schema version matches what FinalizeMessage's SQL expects, and
// prepares the two statements we issue per finalize. Returns a closed
// nil-safe value (nil, nil) when dbPath is empty so RouteDeps can be
// initialised even on test setups that don't have a DB.
func OpenSQLiteFinalizer(dbPath string) (*SQLiteFinalizer, error) {
	if dbPath == "" {
		return nil, nil
	}
	// Pragmas are passed via the DSN — modernc.org/sqlite accepts them as
	// query params. journal_mode=WAL is required for multi-process safe
	// access (the bridge holds the same file open simultaneously). The
	// 5 s busy timeout matches the bridge's own setting.
	dsn := dbPath + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)&_pragma=foreign_keys(ON)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	// SQLite is a single-writer-at-a-time store; restricting Go's pool to
	// one connection avoids surprising contention with itself.
	db.SetMaxOpenConns(1)

	var version string
	if err := db.QueryRow("SELECT value FROM meta WHERE key='schema_version'").Scan(&version); err != nil {
		db.Close()
		if errors.Is(err, sql.ErrNoRows) {
			return nil, fmt.Errorf("schema_version row missing — run tools/migrate-sessions-to-sqlite.mjs")
		}
		return nil, fmt.Errorf("schema_version query: %w", err)
	}
	if version != fmt.Sprintf("%d", sqliteFinalizeSchemaVersion) {
		db.Close()
		return nil, fmt.Errorf("schema_version mismatch: db=%s, go-core expects=%d (coordinate releases)", version, sqliteFinalizeSchemaVersion)
	}

	f := &SQLiteFinalizer{db: db}
	if err := f.prepare(); err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}

func (f *SQLiteFinalizer) prepare() error {
	var err error
	// The UPDATE targets the row by (session_id, live_token). The bridge
	// allocated live_token in the phase="start" call; we use it as a
	// stable handle without needing to know the message's seq number.
	// json_set merges blocks + meta into the existing data column so any
	// non-promoted fields the bridge wrote at start-time are preserved.
	f.updateMsg, err = f.db.Prepare(`
		UPDATE messages
		SET streaming = 0,
		    live_token = NULL,
		    live_deadline = NULL,
		    text = ?,
		    data = json_set(
		      coalesce(data, '{}'),
		      '$.blocks', json(?),
		      '$.meta',   json(?)
		    )
		WHERE session_id = ? AND live_token = ?
	`)
	if err != nil {
		return fmt.Errorf("prepare update: %w", err)
	}
	f.touchSession, err = f.db.Prepare(`
		UPDATE sessions SET last_used = ?, updated_at = ? WHERE id = ?
	`)
	if err != nil {
		return fmt.Errorf("prepare touch: %w", err)
	}
	return nil
}

// Close releases prepared statements and the DB handle. nil-safe.
func (f *SQLiteFinalizer) Close() error {
	if f == nil || f.db == nil {
		return nil
	}
	if f.updateMsg != nil {
		_ = f.updateMsg.Close()
	}
	if f.touchSession != nil {
		_ = f.touchSession.Close()
	}
	return f.db.Close()
}

// SessionWorkingDir reads the persisted workingDir for sid from the
// sessions table. Returns ("", false) when the session doesn't exist or
// has no pinned dir; the caller should fall back to the JSON path /
// request-supplied CWD in that case. nil-safe.
//
// Replaces the JSON-file read in LoadSessionWorkingDir for the
// post-Step-5 world (bridge/sessions/ may not exist anymore; new
// sessions only exist in the DB anyway).
func (f *SQLiteFinalizer) SessionWorkingDir(sid string) (string, bool) {
	if f == nil || f.db == nil || sid == "" {
		return "", false
	}
	var wd sql.NullString
	err := f.db.QueryRow(`SELECT working_dir FROM sessions WHERE id = ?`, sid).Scan(&wd)
	if err != nil {
		return "", false
	}
	if !wd.Valid {
		return "", true // row exists; just no pinned dir
	}
	return wd.String, true
}

// SessionParticipants reads the participants[] array (from the column)
// and the groupMode (from the data JSON blob) for sid. Returns
// (nil, "", false) when the session doesn't exist; (nil, "", true) when
// the session exists but has no participants. nil-safe.
//
// Mirrors the JSON read FileParticipantResolver.loadSession used to do.
func (f *SQLiteFinalizer) SessionParticipants(sid string) ([]string, string, bool) {
	if f == nil || f.db == nil || sid == "" {
		return nil, "", false
	}
	var partsRaw sql.NullString
	var groupMode sql.NullString
	err := f.db.QueryRow(
		`SELECT participants, json_extract(data, '$.groupMode') FROM sessions WHERE id = ?`,
		sid,
	).Scan(&partsRaw, &groupMode)
	if err != nil {
		return nil, "", false
	}
	var parts []string
	if partsRaw.Valid && partsRaw.String != "" {
		if err := json.Unmarshal([]byte(partsRaw.String), &parts); err != nil {
			// Malformed array — treat as no participants but session exists.
			parts = nil
		}
	}
	gm := ""
	if groupMode.Valid {
		gm = groupMode.String
	}
	return parts, gm, true
}

// FinalizeMessage updates the streaming row matched by (session_id,
// live_token), clearing streaming + tokens and writing blocks/meta into
// the data column. Returns true if a row was matched and updated, false
// otherwise. False is not an error — it just means the caller should fall
// through to the existing HTTP path (which handles user prompts, missing
// placeholders from a no-start dispatch, etc.).
//
// Non-final phases pass through as no-ops so the caller can invoke this
// unconditionally inside persistFinal without special-casing.
func (f *SQLiteFinalizer) FinalizeMessage(ctx context.Context, p PersistMessagePayload) (bool, error) {
	if f == nil || f.db == nil {
		return false, nil
	}
	if p.Phase != "final" {
		return false, nil
	}
	if p.SessionID == "" || p.LiveToken <= 0 {
		return false, nil
	}

	blocksJSON, err := json.Marshal(p.Blocks)
	if err != nil || len(blocksJSON) == 0 {
		blocksJSON = []byte("[]")
	}
	meta := map[string]any{
		"model":        p.Model,
		"provider":     p.Provider,
		"inputTokens":  p.InputTokens,
		"outputTokens": p.OutputTokens,
		"durationMs":   p.DurationMs,
		"stopReason":   p.StopReason,
	}
	metaJSON, err := json.Marshal(meta)
	if err != nil {
		metaJSON = []byte("{}")
	}

	// Match the bridge's own finalize semantics (sessions-internal/index.ts:
	// finalizeLiveMsg): when blocks are present, text becomes NULL; when
	// only text is provided, blocks stays an empty array.
	var textArg any
	if len(p.Blocks) > 0 {
		textArg = nil
	} else if p.Text != "" {
		textArg = p.Text
	} else {
		textArg = nil
	}

	tx, err := f.db.BeginTx(ctx, nil)
	if err != nil {
		return false, fmt.Errorf("begin: %w", err)
	}
	// Always Rollback after Commit succeeds is a no-op; on early return
	// before commit it rolls back. Standard idiom.
	defer func() { _ = tx.Rollback() }()

	res, err := tx.StmtContext(ctx, f.updateMsg).ExecContext(
		ctx,
		textArg,
		string(blocksJSON),
		string(metaJSON),
		p.SessionID,
		p.LiveToken,
	)
	if err != nil {
		return false, fmt.Errorf("update messages: %w", err)
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		// No matching row. The bridge POST will create-from-scratch; bail
		// out without committing the touch_session update either.
		return false, nil
	}

	now := time.Now().UnixMilli()
	if _, err := tx.StmtContext(ctx, f.touchSession).ExecContext(ctx, now, now, p.SessionID); err != nil {
		return false, fmt.Errorf("touch session: %w", err)
	}
	if err := tx.Commit(); err != nil {
		return false, fmt.Errorf("commit: %w", err)
	}
	return true, nil
}
