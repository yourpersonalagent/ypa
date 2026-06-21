// Scheduled SQLite backups of bridge/data/sessions.db.
//
// Why here, in yha-rewind: this is the long-lived daemon that survives
// bridge restarts. The bridge itself runs for 3–5 days between restarts,
// so a bridge-boot-trigger would miss days. yha-rewind already owns the
// "persistent file safety net" role for rewind blobs (see gc.go); SQLite
// snapshots are the same shape of work — periodic, off the user-facing
// critical path, must survive whatever broke the bridge.
//
// Mechanism: VACUUM INTO writes a fully compacted point-in-time snapshot
// to a new file without blocking writers (WAL keeps the live DB
// available the whole time). Source-side: read-only connection through
// modernc.org/sqlite (the same pure-Go driver used by
// internal/stream/sqlite_finalize.go, no CGo).
//
// Schedule: a goroutine ticks every YHA_SESSIONS_BACKUP_INTERVAL (default
// 24h) and writes bridge/data/backups/sessions-YYYY-MM-DD.db if today's
// file is missing. Same first-fire-2-minutes-after-boot pattern as the
// GC scheduler so a long-up daemon picks up a missed day after a
// restart, and so multiple restarts in one day don't spam backups.
//
// Rotation: keeps 7 most-recent daily snapshots + 4 weekly (the most
// recent in each of the prior 4 ISO weeks), matching the plan in
// docs/SQL-migration-plan.md §"Backup / disaster recovery".
package main

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

const (
	defaultSessionsBackupInterval = 24 * time.Hour
	defaultSessionsBackupKeepDaily = 7
	defaultSessionsBackupKeepWeekly = 4
)

// sessionsBackupNamePattern matches files this code produces. Anything
// else in backupsDir is left alone — operator-placed files, ad-hoc
// dumps, etc.
var sessionsBackupNamePattern = regexp.MustCompile(`^sessions-(\d{4})-(\d{2})-(\d{2})\.db$`)

type backupStats struct {
	Apply        bool   `json:"apply"`
	DBPath       string `json:"db_path"`
	BackupsDir   string `json:"backups_dir"`
	Target       string `json:"target,omitempty"`
	SkippedToday bool   `json:"skipped_today"`
	SourceBytes  int64  `json:"source_bytes"`
	TargetBytes  int64  `json:"target_bytes"`
	Pruned       int    `json:"pruned"`
	PrunedBytes  int64  `json:"pruned_bytes"`
	DurationMs   int64  `json:"duration_ms"`
	Error        string `json:"error,omitempty"`
}

// runBackup snapshots the sessions DB to backupsDir/sessions-YYYY-MM-DD.db
// (skipping if today's file already exists) and prunes anything outside the
// 7-daily + 4-weekly window. apply=false makes it a dry-run.
func (s *service) runBackup(ctx context.Context, apply bool) backupStats {
	t0 := time.Now()
	stats := backupStats{
		Apply:      apply,
		DBPath:     s.sessionsDBPath,
		BackupsDir: s.backupsDir,
	}

	if s.sessionsDBPath == "" || s.backupsDir == "" {
		stats.Error = "sessions-db or backups-dir not configured"
		stats.DurationMs = time.Since(t0).Milliseconds()
		return stats
	}

	info, err := os.Stat(s.sessionsDBPath)
	if err != nil {
		stats.Error = "stat source: " + err.Error()
		stats.DurationMs = time.Since(t0).Milliseconds()
		return stats
	}
	stats.SourceBytes = info.Size()

	if apply {
		if err := os.MkdirAll(s.backupsDir, 0o755); err != nil {
			stats.Error = "mkdir backups-dir: " + err.Error()
			stats.DurationMs = time.Since(t0).Milliseconds()
			return stats
		}
	}

	today := time.Now().Format("2006-01-02")
	target := filepath.Join(s.backupsDir, "sessions-"+today+".db")
	stats.Target = target

	if existing, err := os.Stat(target); err == nil && existing.Size() > 0 {
		stats.SkippedToday = true
		stats.TargetBytes = existing.Size()
	} else if apply {
		// Atomic via temp + rename so a crashed VACUUM never leaves a
		// half-written file under the canonical name.
		tmp := target + ".tmp"
		_ = os.Remove(tmp)
		if err := vacuumInto(ctx, s.sessionsDBPath, tmp); err != nil {
			_ = os.Remove(tmp)
			stats.Error = "vacuum: " + err.Error()
			stats.DurationMs = time.Since(t0).Milliseconds()
			return stats
		}
		if err := os.Rename(tmp, target); err != nil {
			_ = os.Remove(tmp)
			stats.Error = "rename: " + err.Error()
			stats.DurationMs = time.Since(t0).Milliseconds()
			return stats
		}
		if tinfo, err := os.Stat(target); err == nil {
			stats.TargetBytes = tinfo.Size()
		}
	}

	pruned, prunedBytes, err := pruneBackups(s.backupsDir, apply, defaultSessionsBackupKeepDaily, defaultSessionsBackupKeepWeekly)
	if err != nil && stats.Error == "" {
		stats.Error = "prune: " + err.Error()
	}
	stats.Pruned = pruned
	stats.PrunedBytes = prunedBytes

	stats.DurationMs = time.Since(t0).Milliseconds()
	return stats
}

// vacuumInto opens the source DB read-only and runs VACUUM INTO to
// target. modernc.org/sqlite is already a transitive dep through
// internal/stream/sqlite_finalize.go, so no go.mod change.
//
// SQLite quoting: the path is interpolated into a literal rather than
// bound as a parameter because VACUUM INTO is a DDL-shape statement
// that doesn't accept ? placeholders. Single quotes inside the path get
// doubled per SQL literal escaping; the path comes from
// admin-controlled flag/env, not user input.
func vacuumInto(ctx context.Context, source, target string) error {
	dsn := "file:" + source + "?mode=ro&_pragma=busy_timeout(30000)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return fmt.Errorf("open source: %w", err)
	}
	defer db.Close()

	if err := db.PingContext(ctx); err != nil {
		return fmt.Errorf("ping source: %w", err)
	}

	literal := "'" + strings.ReplaceAll(target, "'", "''") + "'"
	if _, err := db.ExecContext(ctx, "VACUUM INTO "+literal); err != nil {
		return err
	}
	return nil
}

// pruneBackups walks backupsDir, parses sessions-YYYY-MM-DD.db files,
// and keeps {keepDaily most-recent days} ∪ {keepWeekly newest weeks
// beyond the daily window, one file per ISO week}. Deletes everything
// else. apply=false reports what would be deleted without doing it.
// Returns (count, bytes, firstErr).
func pruneBackups(backupsDir string, apply bool, keepDaily, keepWeekly int) (int, int64, error) {
	entries, err := os.ReadDir(backupsDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return 0, 0, nil
		}
		return 0, 0, err
	}

	type entry struct {
		path string
		date time.Time
		size int64
	}
	var items []entry
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		m := sessionsBackupNamePattern.FindStringSubmatch(e.Name())
		if m == nil {
			continue
		}
		d, err := time.Parse("2006-01-02", m[1]+"-"+m[2]+"-"+m[3])
		if err != nil {
			continue
		}
		info, err := e.Info()
		if err != nil {
			continue
		}
		items = append(items, entry{
			path: filepath.Join(backupsDir, e.Name()),
			date: d,
			size: info.Size(),
		})
	}
	if len(items) == 0 {
		return 0, 0, nil
	}

	sort.Slice(items, func(i, j int) bool {
		return items[i].date.After(items[j].date)
	})

	keep := make(map[string]struct{}, len(items))
	for i := 0; i < len(items) && i < keepDaily; i++ {
		keep[items[i].path] = struct{}{}
	}

	weeklySeen := map[string]struct{}{}
	for i := keepDaily; i < len(items) && len(weeklySeen) < keepWeekly; i++ {
		y, w := items[i].date.ISOWeek()
		bucket := fmt.Sprintf("%04d-%02d", y, w)
		if _, ok := weeklySeen[bucket]; ok {
			continue
		}
		weeklySeen[bucket] = struct{}{}
		keep[items[i].path] = struct{}{}
	}

	var pruned int
	var prunedBytes int64
	var firstErr error
	for _, it := range items {
		if _, ok := keep[it.path]; ok {
			continue
		}
		pruned++
		prunedBytes += it.size
		if apply {
			if err := os.Remove(it.path); err != nil && firstErr == nil {
				firstErr = err
			}
		}
	}
	return pruned, prunedBytes, firstErr
}

// runScheduledBackup kicks off the background backup goroutine. Same
// shape as runScheduledGC in gc.go: first fire ~2 min after boot (to
// catch days missed across a daemon restart), then every interval.
// Cancelling ctx stops the ticker.
func (s *service) runScheduledBackup(ctx context.Context, interval time.Duration) {
	if interval <= 0 {
		s.log.Info("scheduled sessions backup disabled (interval<=0)")
		return
	}
	if s.sessionsDBPath == "" || s.backupsDir == "" {
		s.log.Info("scheduled sessions backup disabled (db or backups dir unset)")
		return
	}
	t := time.NewTicker(interval)
	defer t.Stop()
	s.log.Info("scheduled sessions backup armed",
		"interval", interval.String(),
		"db", s.sessionsDBPath,
		"backups_dir", s.backupsDir)
	firstFire := time.After(2 * time.Minute)
	for {
		select {
		case <-ctx.Done():
			return
		case <-firstFire:
			s.fireScheduledBackup(ctx)
			firstFire = nil
		case <-t.C:
			s.fireScheduledBackup(ctx)
		}
	}
}

func (s *service) fireScheduledBackup(ctx context.Context) {
	stats := s.runBackup(ctx, true)
	if stats.Error != "" {
		s.log.Warn("scheduled sessions backup error", "err", stats.Error)
		return
	}
	if stats.SkippedToday {
		s.log.Info("scheduled sessions backup — today already present",
			"target", stats.Target,
			"target_bytes", stats.TargetBytes,
			"pruned", stats.Pruned)
		return
	}
	s.log.Info("scheduled sessions backup wrote",
		"target", stats.Target,
		"source_bytes", stats.SourceBytes,
		"target_bytes", stats.TargetBytes,
		"pruned", stats.Pruned,
		"pruned_bytes", stats.PrunedBytes,
		"duration_ms", stats.DurationMs)
}

// handleSessionsBackup exposes the same backup over HTTP for manual
// triggering. `?dry=1` runs the rotation+plan without writing.
func (s *service) handleSessionsBackup(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, errors.New("POST required"))
		return
	}
	apply := r.URL.Query().Get("dry") != "1"
	stats := s.runBackup(r.Context(), apply)
	writeJSON(w, http.StatusOK, stats)
}
