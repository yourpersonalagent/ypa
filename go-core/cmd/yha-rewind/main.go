// yha-rewind is the standalone safety-net service for the rewind feature
// (docs/grill-session-plan.md §4.2, step 3 of the rewind handoff).
//
// Why standalone, not part of the bridge: the whole point of rewind is
// recovering from a self-edit that broke the bridge or frontend. A
// service co-located with what it is supposed to rescue is useless when
// the rescue is needed most. yha-rewind runs as its own pm2 process,
// reads bridge/rewind/ (the JSONL edit log + content-addressed blobs
// the bridge writes), and serves a tiny HTTP API + an inline HTML
// /recover page that works even if the bridge is fully down.
//
// Scope of this first cut:
//   - List edit records and group them into "packs" by git commit
//     boundary. Edits between commits A and B become one pack; edits
//     newer than HEAD form the working pack.
//   - Show the diff for any single record (before/after blob contents).
//   - Restore a single record (undo it). Modify → write before_hash
//     blob back; Create → delete file; Delete → re-create from
//     before_hash blob. Undo of N records is just N single restores
//     in reverse-ts order, handled by the caller.
//   - Inline /recover HTML overlay (no external assets) so the page
//     renders with no bridge, no frontend bundle, no CDN.
//
// Not yet (later steps):
//   - Filesystem polling to observe edits the bridge missed (today the
//     bridge's loader hook is the only writer).
//   - Frontend watchdog injection (step 4).
//   - /__rewind proxy from the bridge (step 4).
package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/yha/core/internal/logger"
	"github.com/yha/core/internal/sysstatus"
)

// 8444 was the original handoff suggestion but it's already taken by the
// bridge's loopback OpenAI-compat endpoint (bridge/chat/openai-internal.ts).
// 8445 is the next free port in the same neighbourhood.
const defaultPort = "8445"

func main() {
	cwd, _ := os.Getwd()
	defaultRewind := filepath.Join(cwd, "bridge", "rewind")
	defaultSessionsDB := filepath.Join(cwd, "bridge", "data", "sessions.db")
	defaultBackupsDir := filepath.Join(cwd, "bridge", "data", "backups")

	var (
		flagPort        = flag.String("port", envOr("YHA_REWIND_PORT", defaultPort), "port to listen on")
		flagBind        = flag.String("bind", envOr("YHA_REWIND_BIND", "127.0.0.1"), "interface to bind (default loopback; the bridge reverse-proxies /__rewind/*)")
		flagRewindDir   = flag.String("rewind-dir", envOr("YHA_REWIND_DIR", defaultRewind), "path to bridge/rewind directory")
		flagRepoRoot    = flag.String("repo-root", envOr("YHA_HOME", cwd), "git repo root used for commit-anchored packs")
		flagSessionsDB  = flag.String("sessions-db", envOr("YHA_SESSIONS_DB", defaultSessionsDB), "path to bridge/data/sessions.db for scheduled snapshots")
		flagBackupsDir  = flag.String("backups-dir", envOr("YHA_SESSIONS_BACKUP_DIR", defaultBackupsDir), "destination directory for sessions.db snapshots")
	)
	flag.Parse()

	log := logger.New(os.Stderr).With("bin", "yha-rewind")

	rewindDir, err := filepath.Abs(*flagRewindDir)
	if err != nil {
		log.Error("bad rewind-dir", "err", err)
		os.Exit(1)
	}
	repoRoot, err := filepath.Abs(*flagRepoRoot)
	if err != nil {
		log.Error("bad repo-root", "err", err)
		os.Exit(1)
	}

	sessionsDB, err := filepath.Abs(*flagSessionsDB)
	if err != nil {
		log.Error("bad sessions-db", "err", err)
		os.Exit(1)
	}
	backupsDir, err := filepath.Abs(*flagBackupsDir)
	if err != nil {
		log.Error("bad backups-dir", "err", err)
		os.Exit(1)
	}

	srv := &service{
		rewindDir:      rewindDir,
		blobsDir:       filepath.Join(rewindDir, "blobs"),
		repoRoot:       repoRoot,
		sessionsDBPath: sessionsDB,
		backupsDir:     backupsDir,
		log:            log,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", srv.healthz)
	mux.HandleFunc("/api/packs", srv.handlePacks)
	mux.HandleFunc("/api/edits", srv.handleEdits)
	mux.HandleFunc("/api/edits/", srv.handleEditOne)
	mux.HandleFunc("/api/diff/", srv.handleDiff)
	mux.HandleFunc("/api/restore/", srv.handleRestore)
	mux.HandleFunc("/api/gc", srv.handleGC)
	mux.HandleFunc("/api/yha-restart", srv.handleYHARestart)
	mux.HandleFunc("/api/top", srv.handleTop)
	mux.HandleFunc("/api/pm2", srv.handlePM2)
	mux.HandleFunc("/api/pm2/restart", srv.handlePM2Restart)
	mux.HandleFunc("/api/sessions", srv.handleSessions)
	mux.HandleFunc("/api/sessions-backup", srv.handleSessionsBackup)
	mux.HandleFunc("/recover", srv.handleRecover)
	mux.HandleFunc("/", srv.handleRecover)

	// Default to loopback. The bridge reverse-proxies /__rewind/* through
	// WorkOS auth on the public TLS port (8442), so the standalone port
	// only ever needs to accept local connections. Pre-fix this listened
	// on :8445 across all interfaces — anyone on the tailnet (or LAN)
	// could call POST /api/restore/{id} and rewrite module source files
	// since the service has no auth of its own.
	httpSrv := &http.Server{
		Addr:              *flagBind + ":" + *flagPort,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Scheduled mark-and-sweep of bridge/rewind/blobs/. Same algorithm
	// as tools/yha-rewind-gc.mjs; running it here means the disk
	// footprint stays bounded without the operator remembering to run
	// the manual script. Set YHA_REWIND_GC_INTERVAL=0 to disable.
	gcInterval := envDuration("YHA_REWIND_GC_INTERVAL", defaultGCInterval)
	gcMinAge := envDuration("YHA_REWIND_GC_MIN_AGE", defaultGCMinAge)
	go srv.runScheduledGC(ctx, gcInterval, gcMinAge)

	// Scheduled VACUUM INTO snapshots of bridge/data/sessions.db. The
	// bridge can stay up for days between restarts, so an in-bridge
	// trigger would miss those days; living here in the long-lived
	// rewind daemon catches them. Set YHA_SESSIONS_BACKUP_INTERVAL=0
	// to disable.
	backupInterval := envDuration("YHA_SESSIONS_BACKUP_INTERVAL", defaultSessionsBackupInterval)
	go srv.runScheduledBackup(ctx, backupInterval)

	go func() {
		log.Info("listening", "bind", *flagBind, "port", *flagPort, "rewind_dir", rewindDir, "repo_root", repoRoot)
		if err := httpSrv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Error("server error", "err", err)
			stop()
		}
	}()

	<-ctx.Done()
	log.Info("shutting down")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = httpSrv.Shutdown(shutdownCtx)
}

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// ─── on-disk record shape (matches bridge/core/rewind.ts) ───────────────────

type fileEntry struct {
	Path       string  `json:"path"`
	Op         string  `json:"op"` // create | modify | delete
	BeforeHash *string `json:"before_hash"`
	AfterHash  *string `json:"after_hash"`
}

type record struct {
	ID             string      `json:"id"`
	TS             int64       `json:"ts"`
	WD             string      `json:"wd"`
	AgentTurnID    *string     `json:"agent_turn_id"`
	Trigger        string      `json:"trigger"`
	Module         string      `json:"module"`
	ModulesTouched []string    `json:"modules_touched"`
	ParentID       *string     `json:"parent_id"`
	Files          []fileEntry `json:"files"`
}

type commit struct {
	Hash string `json:"hash"`
	TS   int64  `json:"ts"`
}

type pack struct {
	CommitFrom *commit  `json:"commit_from"` // older boundary; nil = beginning of history
	CommitTo   *commit  `json:"commit_to"`   // newer boundary; nil = working pack
	Working    bool     `json:"working"`
	EditCount  int      `json:"edit_count"`
	Edits      []record `json:"edits,omitempty"`
}

// ─── service ────────────────────────────────────────────────────────────────

type service struct {
	rewindDir      string
	blobsDir       string
	repoRoot       string
	sessionsDBPath string
	backupsDir     string
	log            *logger.Logger
}

func (s *service) healthz(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "rewind_dir": s.rewindDir})
}

// GET /api/packs — list packs (newest first). Pass ?with_edits=1 to inline the edit lists.
func (s *service) handlePacks(w http.ResponseWriter, r *http.Request) {
	records, err := loadAllRecords(s.rewindDir)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	commits, _ := loadCommits(s.repoRoot)
	packs := groupIntoPacks(records, commits)
	if r.URL.Query().Get("with_edits") != "1" {
		for i := range packs {
			packs[i].Edits = nil
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"packs": packs, "commits": commits})
}

// GET /api/edits — flat list of edit records, newest first. ?limit=N.
func (s *service) handleEdits(w http.ResponseWriter, r *http.Request) {
	records, err := loadAllRecords(s.rewindDir)
	if err != nil {
		writeErr(w, http.StatusInternalServerError, err)
		return
	}
	sort.Slice(records, func(i, j int) bool { return records[i].TS > records[j].TS })
	if l := r.URL.Query().Get("limit"); l != "" {
		if n, err := strconv.Atoi(l); err == nil && n > 0 && n < len(records) {
			records = records[:n]
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"edits": records})
}

// GET /api/edits/{id}
func (s *service) handleEditOne(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/edits/")
	rec, err := s.findRecord(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, err)
		return
	}
	writeJSON(w, http.StatusOK, rec)
}

// GET /api/diff/{id} — for each file in the record, return before/after content.
// Text blobs come back as utf-8 strings; non-utf-8 / NUL-containing blobs are
// flagged with `binary: true` + size so the browser doesn't try to render them.
// Caller renders the diff.
func (s *service) handleDiff(w http.ResponseWriter, r *http.Request) {
	id := strings.TrimPrefix(r.URL.Path, "/api/diff/")
	rec, err := s.findRecord(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, err)
		return
	}
	type sidePayload struct {
		Text   *string `json:"text,omitempty"`
		Binary bool    `json:"binary,omitempty"`
		Size   int     `json:"size,omitempty"`
	}
	type fileDiff struct {
		Path   string      `json:"path"`
		Op     string      `json:"op"`
		Before sidePayload `json:"before"`
		After  sidePayload `json:"after"`
	}
	out := make([]fileDiff, 0, len(rec.Files))
	for _, f := range rec.Files {
		fd := fileDiff{Path: f.Path, Op: f.Op}
		if f.BeforeHash != nil {
			fd.Before = s.readBlobPayload(*f.BeforeHash)
		}
		if f.AfterHash != nil {
			fd.After = s.readBlobPayload(*f.AfterHash)
		}
		out = append(out, fd)
	}
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "module": rec.Module, "files": out})
}

// readBlobPayload returns either the blob's text content (when utf-8 and
// NUL-free) or a {binary, size} hint. nil blob/missing file shows up as
// the zero value (Text nil + Binary false + Size 0).
func (s *service) readBlobPayload(hash string) struct {
	Text   *string `json:"text,omitempty"`
	Binary bool    `json:"binary,omitempty"`
	Size   int     `json:"size,omitempty"`
} {
	type payload = struct {
		Text   *string `json:"text,omitempty"`
		Binary bool    `json:"binary,omitempty"`
		Size   int     `json:"size,omitempty"`
	}
	p := filepath.Join(s.blobsDir, hash)
	b, err := os.ReadFile(p)
	if err != nil {
		return payload{}
	}
	if isBinaryBytes(b) {
		return payload{Binary: true, Size: len(b)}
	}
	str := string(b)
	return payload{Text: &str, Size: len(b)}
}

// isBinaryBytes mirrors the heuristic git + diff utilities use: a buffer
// containing NUL inside its first 8 KiB is treated as binary, and the
// full buffer must be valid utf-8 for text rendering.
func isBinaryBytes(b []byte) bool {
	head := b
	if len(head) > 8192 {
		head = head[:8192]
	}
	for _, c := range head {
		if c == 0 {
			return true
		}
	}
	// Stdlib's utf8.Valid is allocation-free.
	return !utf8.Valid(b)
}

// POST /api/restore/{id} — undo (or redo) this record.
// Default (or ?forward=0): UNDO. Write the BEFORE content back so the
// edit is reverted.
//   Modify  → write before_hash blob.
//   Create  → delete the file (it didn't exist before).
//   Delete  → write before_hash blob back (re-create).
// With ?forward=1: REDO. Re-apply the original edit by writing AFTER.
//   Modify  → write after_hash blob.
//   Create  → write after_hash blob (recreate the file).
//   Delete  → delete the file again.
// Returns a per-file outcome list. Errors on individual files don't abort
// the rest — partial restore is better than no restore for the safety net.
func (s *service) handleRestore(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, errors.New("POST required"))
		return
	}
	id := strings.TrimPrefix(r.URL.Path, "/api/restore/")
	forward := r.URL.Query().Get("forward") == "1"
	rec, err := s.findRecord(id)
	if err != nil {
		writeErr(w, http.StatusNotFound, err)
		return
	}
	// Resolve the module directory the record was written against.
	// record.WD is the bridge process's cwd (the bridge/ dir on the live
	// system, captured by the loader hook as REWIND_WD = process.cwd()),
	// so modules live directly under it as `modules/<name>/`. Earlier this
	// joined an extra "bridge" segment, which would resolve to
	// <bridge>/bridge/modules/<name>/ and refuse to write — no record was
	// ever successfully restored through the live system before that bug
	// was caught.
	// We Clean the moduleDir once so the per-file containment check below
	// is a simple prefix test.
	moduleDir, mdErr := filepath.Abs(filepath.Clean(filepath.Join(rec.WD, "modules", rec.Module)))
	if mdErr != nil {
		writeErr(w, http.StatusBadRequest, fmt.Errorf("bad module dir: %w", mdErr))
		return
	}

	type outcome struct {
		Path string `json:"path"`
		Op   string `json:"op"`
		OK   bool   `json:"ok"`
		Err  string `json:"err,omitempty"`
	}
	results := make([]outcome, 0, len(rec.Files))
	for _, f := range rec.Files {
		oc := outcome{Path: f.Path, Op: f.Op}
		// Containment guard. A malformed or hostile record could carry a
		// path like "../../etc/passwd" — refuse to write outside the
		// module dir. Clean + Abs collapse any "../" and a prefix test
		// proves dst is rooted inside moduleDir.
		dst, dstErr := filepath.Abs(filepath.Clean(filepath.Join(moduleDir, f.Path)))
		if dstErr != nil {
			oc.Err = "bad path: " + dstErr.Error()
			results = append(results, oc)
			continue
		}
		if dst != moduleDir && !strings.HasPrefix(dst, moduleDir+string(os.PathSeparator)) {
			oc.Err = "path escapes module dir"
			results = append(results, oc)
			continue
		}
		if forward {
			// REDO: re-apply the original edit.
			switch f.Op {
			case "modify", "create":
				if f.AfterHash == nil {
					oc.Err = "no after_hash"
					results = append(results, oc)
					continue
				}
				if err := s.writeFileFromBlob(dst, *f.AfterHash); err != nil {
					oc.Err = err.Error()
				} else {
					oc.OK = true
				}
			case "delete":
				if err := os.Remove(dst); err != nil && !errors.Is(err, os.ErrNotExist) {
					oc.Err = err.Error()
				} else {
					oc.OK = true
				}
			default:
				oc.Err = "unknown op: " + f.Op
			}
		} else {
			// UNDO: revert to before-edit content.
			switch f.Op {
			case "modify", "delete":
				if f.BeforeHash == nil {
					oc.Err = "no before_hash"
					results = append(results, oc)
					continue
				}
				if err := s.writeFileFromBlob(dst, *f.BeforeHash); err != nil {
					oc.Err = err.Error()
				} else {
					oc.OK = true
				}
			case "create":
				if err := os.Remove(dst); err != nil && !errors.Is(err, os.ErrNotExist) {
					oc.Err = err.Error()
				} else {
					oc.OK = true
				}
			default:
				oc.Err = "unknown op: " + f.Op
			}
		}
		results = append(results, oc)
	}
	direction := "undo"
	if forward {
		direction = "redo"
	}
	s.log.Info("restore applied", "id", id, "module", rec.Module, "files", len(rec.Files), "direction", direction)
	writeJSON(w, http.StatusOK, map[string]any{"id": id, "direction": direction, "results": results})
}

// POST /api/yha-restart — kick off a full YHA restart via ./yha.sh.
// Mirrors bridge's /v1/restart so the recover page can trigger the exact
// same flow without needing the bridge to be up — the typical scenario
// for the recover page in the first place.
//
// Mode/backend resolution (request body wins, env is fallback):
//   - body.mode or YHA_MODE — "dev" | "build". YHA_USE_DIST=false ⇒ dev as
//     last-resort signal (matches bridge's currentRuntime() heuristic).
//   - body.backend or YHA_BACKEND — "go" | "node". Defaults to "go" since
//     that's yha.sh's default and what owns :8443 today.
//
// The spawned bash is invoked with --skip-rewind so this very process
// stays alive through the bounce. pm2 still has us under management, but
// yha.sh's `pm2 delete YHA-Rewind` line is skipped, so no signal arrives.
// Result: the recover page keeps serving while YHA-Bridge / YHA-Core cycle.
//
// Spawn pattern: child gets its own session via SysProcAttr.Setsid so it
// survives if pm2 were to kill us anyway. Output redirected to
// restart.log next to yha.sh — same file the bridge writes to.
func (s *service) handleYHARestart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, errors.New("POST required"))
		return
	}
	var body struct {
		Mode    string `json:"mode"`
		Backend string `json:"backend"`
	}
	// Empty body is fine — we'll fall through to env-based detection.
	_ = json.NewDecoder(r.Body).Decode(&body)

	// Fall back to whatever is actually running right now (read from a live
	// sibling's /proc env) rather than our own frozen launch-time env.
	currentMode, currentBackend, _ := currentBridgeRuntime()

	mode := strings.ToLower(strings.TrimSpace(body.Mode))
	if mode != "dev" && mode != "build" {
		mode = currentMode
	}

	backend := strings.ToLower(strings.TrimSpace(body.Backend))
	if backend != "go" && backend != "node" {
		backend = currentBackend
	}

	script := filepath.Join(s.repoRoot, "yha.sh")
	if _, err := os.Stat(script); err != nil {
		writeErr(w, http.StatusInternalServerError, fmt.Errorf("yha.sh not found at %s", script))
		return
	}

	// yha.sh signature: [dev|build] [node] [--owner] [--bare-core] [--skip-rewind].
	// "go" backend is the default and adding it as a positional arg would be
	// rejected by the script's case-match, so we only append "node" for legacy.
	args := []string{"/bin/bash", "./yha.sh", mode}
	if backend == "node" {
		args = append(args, "node")
	}
	args = append(args, "--skip-rewind")

	// Respond before spawning. The client needs the JSON before YHA-Bridge goes
	// down — once the front door is killed any in-flight bridge requests die,
	// but our response is going over the standalone :8445 listener which is
	// completely independent of the bridge, so this is mostly defensive.
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":      true,
		"mode":    mode,
		"backend": backend,
		"args":    args[1:], // omit "/bin/bash"
	})
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}

	go func() {
		// Small delay so the response definitely lands before the script
		// starts tearing things down.
		time.Sleep(300 * time.Millisecond)

		logPath := filepath.Join(s.repoRoot, "restart.log")
		var logF *os.File
		if f, err := os.OpenFile(logPath, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644); err == nil {
			logF = f
			defer logF.Close()
		}

		cmd := exec.Command(args[0], args[1:]...)
		cmd.Dir = s.repoRoot
		cmd.Env = os.Environ()
		if logF != nil {
			cmd.Stdout = logF
			cmd.Stderr = logF
		}
		// New session: even if pm2 were to send our process a signal during
		// the restart (it shouldn't, since --skip-rewind keeps us off the
		// delete list, but defensively), the bash child stays in its own
		// session and survives. No-op on Windows (handled differently via
		// Process.Release alone).
		setDetachedProcAttr(cmd)

		if err := cmd.Start(); err != nil {
			s.log.Error("yha-restart spawn failed", "err", err)
			return
		}
		s.log.Info("yha-restart spawned", "mode", mode, "backend", backend, "pid", cmd.Process.Pid)
		// Don't Wait — we don't want a zombie reaper tied to this short-lived
		// goroutine. The new session keeps the child alive independently.
		_ = cmd.Process.Release()
	}()
}

// GET /api/top — top-by-CPU process snapshot, rendered as preformatted
// text lines so the recover page can drop it into a <pre>. Sampled via
// internal/sysstatus so the same code path (ps on Linux, Get-Process on
// Windows) backs both the TUI dashboard and this rescue page. The pm2
// sample feeds in so processes that belong to the YHA tree get tagged.
func (s *service) handleTop(w http.ResponseWriter, r *http.Request) {
	pm2Procs, _ := sysstatus.SamplePM2()
	rows, errStr := sysstatus.SampleTop(pm2Procs)
	if errStr != "" {
		writeErr(w, http.StatusInternalServerError, fmt.Errorf("top: %s", errStr))
		return
	}
	lines := make([]string, 0, len(rows)+1)
	lines = append(lines, fmt.Sprintf("%-7s %6s %7s  %-14s %s", "PID", "CPU", "MEM", "CMD", "ARGS"))
	for _, p := range rows {
		tag := ""
		if p.Tag != "" {
			tag = "  [" + p.Tag + "]"
		}
		lines = append(lines, fmt.Sprintf("%-7d %5.1f  %5dMB  %-14s %s%s",
			p.PID, p.CPU, p.MemMB, p.Cmd, p.Args, tag))
	}
	writeJSON(w, http.StatusOK, map[string]any{"lines": lines, "captured_at": time.Now().UnixMilli()})
}

// GET /api/pm2 — slim wrapper over sysstatus.SamplePM2. On Linux that's
// `pm2 jlist`; on Windows it's yha.ps1's pid file enriched with
// Get-Process. The JSON tags on sysstatus.PM2Process already match what
// the recover-page JS reads (name/status/cpu/mem_mb/uptime_ms).
func (s *service) handlePM2(w http.ResponseWriter, r *http.Request) {
	procs, errStr := sysstatus.SamplePM2()
	if errStr != "" {
		writeErr(w, http.StatusInternalServerError, fmt.Errorf("pm2: %s", errStr))
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"procs": procs, "captured_at": time.Now().UnixMilli()})
}

// POST /api/pm2/restart?name=<NAME> — bounce a single pm2 process.
// Guardrails:
//   - "YHA-Rewind" rejected: restarting ourselves kills this page mid-flight
//     and the user is left wondering whether the request landed.
//   - "all" rejected: the user wants the full YHA restart button for that;
//     it spawns yha.sh and respects --skip-rewind. Letting pm2 restart all
//     here would still kill us without the survival guarantees.
//   - Name shape validated: pm2 names from ecosystem config are alphanum +
//     hyphen + underscore. Anything else is rejected before reaching exec
//     to keep the query-string surface clean.
func (s *service) handlePM2Restart(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		writeErr(w, http.StatusMethodNotAllowed, errors.New("POST required"))
		return
	}
	name := strings.TrimSpace(r.URL.Query().Get("name"))
	if name == "" {
		writeErr(w, http.StatusBadRequest, errors.New("name required"))
		return
	}
	if name == "YHA-Rewind" || strings.EqualFold(name, "all") {
		writeErr(w, http.StatusBadRequest, errors.New("refusing to restart self or 'all' — use the full YHA restart button"))
		return
	}
	for _, c := range name {
		ok := (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
			(c >= '0' && c <= '9') || c == '-' || c == '_'
		if !ok {
			writeErr(w, http.StatusBadRequest, errors.New("invalid name (alnum + - _ only)"))
			return
		}
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "pm2", "restart", name)
	out, err := cmd.CombinedOutput()
	if err != nil {
		s.log.Warn("pm2 restart failed", "name", name, "err", err)
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"ok": false, "name": name, "err": err.Error(), "output": string(out),
		})
		return
	}
	s.log.Info("pm2 restart issued", "name", name)
	writeJSON(w, http.StatusOK, map[string]any{"ok": true, "name": name, "output": string(out)})
}

// GET /api/sessions — proxies the bridge's /internal/sessions-summary so
// the recover page can show "what is the agent doing right now?". The
// bridge being down is the most likely reason the recover page is up in
// the first place, so this is best-effort: we return ok=false with a
// reachable=false flag when the bridge can't be reached, and the page
// renders "core unreachable — restart above".
//
// Auth: the bridge endpoint expects x-bridge-key matching $YHA_BRIDGE_KEY.
// yha-rewind inherits that env from pm2 (yha.sh exports it for every
// child). If the key isn't set we still attempt the call and surface
// the 401 — operator can see the misconfig.
func (s *service) handleSessions(w http.ResponseWriter, r *http.Request) {
	port := envOr("YHA_CORE_PORT", "8443")
	url := "http://127.0.0.1:" + port + "/internal/sessions-summary"
	ctx, cancel := context.WithTimeout(r.Context(), 1500*time.Millisecond)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if key := os.Getenv("YHA_BRIDGE_KEY"); key != "" {
		req.Header.Set("x-bridge-key", key)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": false, "reachable": false, "err": err.Error(),
		})
		return
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 400 {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": false, "reachable": true, "status": resp.StatusCode,
			"body": string(body),
		})
		return
	}
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{
			"ok": false, "reachable": true, "parse_err": err.Error(),
		})
		return
	}
	raw["reachable"] = true
	raw["ok"] = true
	writeJSON(w, http.StatusOK, raw)
}

// GET /recover — inline HTML overlay. Single self-contained page so the
// browser can load it directly on :8444 when the bridge is down. Talks to
// the same-origin /api/* endpoints with fetch().
//
// The HTML carries two server-side values via small <meta> tags so the JS
// can pre-select the same mode/backend the process was started in (no
// extra round-trip needed before the user hits "Restart").
func (s *service) handleRecover(w http.ResponseWriter, r *http.Request) {
	mode, backend, _ := currentBridgeRuntime()
	html := strings.ReplaceAll(recoverHTML, "{{YHA_MODE}}", mode)
	html = strings.ReplaceAll(html, "{{YHA_BACKEND}}", backend)
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	_, _ = w.Write([]byte(html))
}

// currentBridgeRuntime returns the mode/backend the YHA install is *currently*
// running in by reading /proc/<pid>/environ of a live YHA sibling process —
// YHA-Bridge first, then YHA-Core / YHA-TUI-Daemon as fallbacks. Reading our
// own os.Getenv would lock the answer to whichever mode yha-rewind itself
// was first started in; because the recover page survives every restart via
// --skip-rewind, that value can be stale for hours. Sibling /proc reads
// pick up the current truth on every page load.
//
// The third return value is the "source" tag — useful for debugging
// ("proc:YHA-Bridge", "proc:YHA-Core", "self-env", "default"). Today only the
// page consumes mode + backend, but the tag is small and worth surfacing.
func currentBridgeRuntime() (mode, backend, source string) {
	for _, name := range []string{"YHA-Bridge", "YHA-Core", "YHA-TUI-Daemon"} {
		if pid := pidOfPM2Process(name); pid > 0 {
			if env, err := readProcEnviron(pid); err == nil {
				m, b := runtimeFromEnvMap(env)
				return m, b, "proc:" + name
			}
		}
	}
	m, b := runtimeFromEnvMap(envFromOS())
	return m, b, "self-env"
}

func runtimeFromEnvMap(env map[string]string) (mode, backend string) {
	mode = strings.ToLower(env["YHA_MODE"])
	if mode != "dev" && mode != "build" {
		if strings.ToLower(env["YHA_USE_DIST"]) == "false" {
			mode = "dev"
		} else {
			mode = "build"
		}
	}
	backend = strings.ToLower(env["YHA_BACKEND"])
	if backend != "go" && backend != "node" {
		backend = "go"
	}
	return mode, backend
}

func envFromOS() map[string]string {
	out := map[string]string{}
	for _, kv := range os.Environ() {
		if i := strings.IndexByte(kv, '='); i > 0 {
			out[kv[:i]] = kv[i+1:]
		}
	}
	return out
}

func readProcEnviron(pid int) (map[string]string, error) {
	raw, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/environ")
	if err != nil {
		return nil, err
	}
	out := make(map[string]string, 32)
	for _, kv := range strings.Split(string(raw), "\x00") {
		if kv == "" {
			continue
		}
		if i := strings.IndexByte(kv, '='); i > 0 {
			out[kv[:i]] = kv[i+1:]
		}
	}
	return out, nil
}

// pidOfPM2Process returns the live PID for a pm2-managed process by name,
// or 0 if not found / not running. Best-effort: pm2 jlist failures, JSON
// parse errors, and missing-name lookups all return 0 so callers can
// just fall through to the next signal.
func pidOfPM2Process(name string) int {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "pm2", "jlist").Output()
	if err != nil {
		return 0
	}
	var raw []map[string]any
	if err := json.Unmarshal(out, &raw); err != nil {
		return 0
	}
	for _, p := range raw {
		if n, _ := p["name"].(string); n == name {
			if v, ok := p["pid"].(float64); ok && v > 0 {
				return int(v)
			}
		}
	}
	return 0
}

// ─── helpers ────────────────────────────────────────────────────────────────

func (s *service) findRecord(id string) (*record, error) {
	records, err := loadAllRecords(s.rewindDir)
	if err != nil {
		return nil, err
	}
	for i := range records {
		if records[i].ID == id {
			return &records[i], nil
		}
	}
	return nil, fmt.Errorf("record %q not found", id)
}

// readBlob returns the blob's content as a string pointer, or nil on
// any failure (missing blob, IO error). Caller treats nil as "content
// unavailable" rather than failing the whole request.
func (s *service) readBlob(hash string) *string {
	p := filepath.Join(s.blobsDir, hash)
	b, err := os.ReadFile(p)
	if err != nil {
		return nil
	}
	str := string(b)
	return &str
}

// writeFileFromBlob writes the given blob's content to dst atomically
// (tmp + rename), creating parent dirs as needed.
func (s *service) writeFileFromBlob(dst, hash string) error {
	src := filepath.Join(s.blobsDir, hash)
	b, err := os.ReadFile(src)
	if err != nil {
		return fmt.Errorf("read blob %s: %w", hash, err)
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		return err
	}
	tmp := dst + ".rewind.tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, dst)
}

// loadAllRecords reads every *.jsonl file in rewindDir and returns the
// concatenated records sorted by ts ascending. Malformed lines stop
// that file's read but don't abort the request.
func loadAllRecords(rewindDir string) ([]record, error) {
	entries, err := os.ReadDir(rewindDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil, nil
		}
		return nil, err
	}
	var out []record
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".jsonl") {
			continue
		}
		f, err := os.Open(filepath.Join(rewindDir, e.Name()))
		if err != nil {
			continue
		}
		dec := json.NewDecoder(f)
		for {
			var r record
			if err := dec.Decode(&r); err != nil {
				if !errors.Is(err, io.EOF) {
					// malformed — stop reading this file but keep what we have
				}
				break
			}
			out = append(out, r)
		}
		_ = f.Close()
	}
	sort.Slice(out, func(i, j int) bool { return out[i].TS < out[j].TS })
	return out, nil
}

// loadCommits runs `git log --format=%H%x09%ct` in repoRoot. Returns
// commits newest-first. Soft-fails (empty slice) if git is unhappy.
func loadCommits(repoRoot string) ([]commit, error) {
	cmd := exec.Command("git", "log", "--format=%H%x09%ct", "-n", "200")
	cmd.Dir = repoRoot
	out, err := cmd.Output()
	if err != nil {
		return nil, err
	}
	var commits []commit
	for _, line := range strings.Split(strings.TrimSpace(string(out)), "\n") {
		parts := strings.SplitN(line, "\t", 2)
		if len(parts) != 2 {
			continue
		}
		ts, err := strconv.ParseInt(parts[1], 10, 64)
		if err != nil {
			continue
		}
		commits = append(commits, commit{Hash: parts[0], TS: ts * 1000}) // record ts is ms
	}
	return commits, nil
}

// groupIntoPacks buckets records by commit boundary. Edits older than
// the oldest known commit go into a synthetic "pre-history" pack with
// commit_from=nil. Edits newer than HEAD form the working pack.
// Returned packs are newest-first.
func groupIntoPacks(records []record, commits []commit) []pack {
	// commits are newest-first; reverse to oldest-first for boundary math.
	asc := make([]commit, len(commits))
	for i, c := range commits {
		asc[len(commits)-1-i] = c
	}

	// Build empty packs: one per gap between commits + one working pack.
	// Boundaries: (-inf, c0], (c0, c1], ..., (cN-1, cN], (cN, +inf) = working.
	packs := make([]pack, 0, len(asc)+1)
	for i := range asc {
		var from *commit
		to := asc[i]
		if i > 0 {
			c := asc[i-1]
			from = &c
		}
		packs = append(packs, pack{CommitFrom: from, CommitTo: &to})
	}
	// Working pack.
	var fromHead *commit
	if len(asc) > 0 {
		c := asc[len(asc)-1]
		fromHead = &c
	}
	packs = append(packs, pack{CommitFrom: fromHead, CommitTo: nil, Working: true})

	// Place each record. Records are ts-ascending.
	for _, r := range records {
		idx := len(packs) - 1 // default to working
		for i, p := range packs {
			if p.CommitTo != nil && r.TS <= p.CommitTo.TS {
				idx = i
				break
			}
		}
		packs[idx].Edits = append(packs[idx].Edits, r)
	}
	for i := range packs {
		packs[i].EditCount = len(packs[i].Edits)
	}
	// Drop empty non-working packs to keep the UI clean.
	kept := packs[:0]
	for _, p := range packs {
		if p.Working || p.EditCount > 0 {
			kept = append(kept, p)
		}
	}
	// Reverse to newest-first for UI.
	for i, j := 0, len(kept)-1; i < j; i, j = i+1, j-1 {
		kept[i], kept[j] = kept[j], kept[i]
	}
	return kept
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeErr(w http.ResponseWriter, status int, err error) {
	writeJSON(w, status, map[string]string{"error": err.Error()})
}

// recoverHTML is the inline overlay served at / and /recover. Zero
// external assets — the whole point is that the browser can render it
// when the bridge + frontend bundle are gone.
const recoverHTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>YHA Rewind — Recovery</title>
<meta name="yha-mode" content="{{YHA_MODE}}">
<meta name="yha-backend" content="{{YHA_BACKEND}}">
<style>
  :root { color-scheme: dark; }
  body { font: 14px/1.45 ui-monospace, SFMono-Regular, Menlo, monospace;
         margin: 0; padding: 24px; background: #0c0c10; color: #e8e8ea; }
  h1 { margin: 0 0 12px; font-size: 18px; }
  h2 { margin: 24px 0 8px; font-size: 14px; color: #9aa; }
  .pill { display: inline-block; padding: 1px 6px; border-radius: 4px;
          background: #2a2a32; color: #cdd; margin-right: 6px; font-size: 11px; }
  .pack { border: 1px solid #2a2a32; border-radius: 6px; margin: 8px 0; padding: 10px 12px; }
  .pack.working { border-color: #4a6; }
  .edit { padding: 6px 0; border-top: 1px dashed #2a2a32; }
  .edit:first-child { border-top: 0; }
  .edit code { color: #cdd; }
  button { font: inherit; padding: 4px 10px; border-radius: 4px; cursor: pointer;
           background: #1e2a3a; color: #cde; border: 1px solid #345; margin-left: 6px; }
  button:hover { background: #2a3a4a; }
  button.danger { background: #3a1e1e; border-color: #543; color: #fdd; }
  button.good { background: #1e3a1e; border-color: #354; color: #dfd; }
  #log { margin-top: 16px; padding: 8px 12px; background: #14141a;
         border-radius: 6px; max-height: 200px; overflow: auto; white-space: pre-wrap; }
  .muted { color: #678; }
  /* redo bar */
  #redobar { margin-top: 16px; padding: 8px 10px; background: #14141a; border-radius: 6px;
             border: 1px solid #2a2a32; display: none; }
  #redobar.has-items { display: block; }
  #redobar .item { display: inline-block; margin-right: 8px; padding: 2px 6px; background: #1e2a3a;
                   border-radius: 4px; font-size: 11px; }
  /* diagnostic panels (top / pm2 / sessions) */
  .panels { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 16px; }
  @media (max-width: 900px) { .panels { grid-template-columns: 1fr; } }
  .panel { background: #14141a; border: 1px solid #2a2a32; border-radius: 6px; padding: 10px 12px;
           min-height: 120px; }
  .panel h2 { margin: 0 0 8px; }
  .panel pre { margin: 0; font: 11px/1.35 ui-monospace, SFMono-Regular, Menlo, monospace;
               white-space: pre; overflow-x: auto; color: #cdd; }
  .pm2-row { display: grid; grid-template-columns: 1.4fr 0.6fr 0.6fr 0.6fr 0.6fr auto;
             gap: 6px; padding: 4px 0; border-top: 1px dashed #2a2a32; align-items: center;
             font-size: 12px; }
  .pm2-row.head { color: #678; border-top: 0; font-weight: bold; }
  .pm2-row .name { color: #cde; }
  .pm2-row .stat-online { color: #8d8; }
  .pm2-row .stat-stopped { color: #fa8; }
  .pm2-row .stat-errored { color: #f88; }
  .pm2-row button { padding: 2px 8px; margin: 0; font-size: 11px; }
  .pm2-row button:disabled { opacity: 0.35; cursor: not-allowed; }
  .sess-row { padding: 5px 0; border-top: 1px dashed #2a2a32; font-size: 12px; }
  .sess-row.head { color: #678; border-top: 0; font-weight: bold; }
  .sess-running { color: #8d8; font-weight: bold; }
  .sess-idle { color: #678; }
  .panel .err { color: #fa8; font-style: italic; }
  .panel .stamp { color: #4a4a52; font-size: 10px; float: right; }
  /* restart panel */
  #restartbar { margin-top: 12px; padding: 8px 10px; background: #14141a; border-radius: 6px;
                border: 1px solid #2a2a32; display: flex; align-items: center; gap: 10px;
                flex-wrap: wrap; }
  #restartbar label { color: #9aa; font-size: 12px; }
  #restartbar select { font: inherit; padding: 2px 6px; background: #1e2a3a; color: #cde;
                       border: 1px solid #345; border-radius: 4px; }
  #restartbar .current { color: #678; font-size: 11px; }
  /* diff modal */
  #modal { position: fixed; inset: 0; background: rgba(0,0,0,.75); display: none;
           align-items: stretch; justify-content: center; z-index: 1000; }
  #modal.open { display: flex; }
  #modalBody { margin: 24px; background: #0c0c10; border: 1px solid #2a2a32;
               border-radius: 8px; flex: 1; max-width: 1400px; display: flex; flex-direction: column;
               overflow: hidden; }
  #modalHead { padding: 10px 14px; border-bottom: 1px solid #2a2a32; display: flex;
               justify-content: space-between; align-items: center; }
  #modalHead h3 { margin: 0; font-size: 14px; }
  #modalContent { flex: 1; overflow: auto; padding: 12px 14px; }
  .filehdr { color: #aeb; margin: 12px 0 6px; font-weight: bold; }
  .filehdr:first-child { margin-top: 0; }
  .diffgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px;
              border: 1px solid #2a2a32; border-radius: 4px; overflow: hidden; }
  .diffside { background: #14141a; padding: 8px 10px; max-height: 60vh; overflow: auto; }
  .diffside .label { color: #9aa; font-size: 11px; margin-bottom: 6px; }
  .diffside pre { margin: 0; white-space: pre-wrap; word-break: break-word;
                  font: 12px/1.4 ui-monospace, SFMono-Regular, Menlo, monospace; }
  .diffline.add { background: rgba(60,200,80,0.12); }
  .diffline.del { background: rgba(220,80,80,0.18); }
  .diffline.empty { color: #4a4a52; }
  .binmark { color: #fcb; font-style: italic; }
</style></head><body>
<h1>YHA Rewind — Recovery</h1>
<div class="muted">Standalone safety-net service. Bridge does not need to be up.</div>

<div style="margin-top: 12px" id="toprow">
  <button id="btn-reload" onclick="location.reload()">Reload page</button>
  <button id="btn-hard" onclick="hardReload()">Hard reload (clear cache)</button>
  <button onclick="refreshAll()">Refresh all</button>
</div>

<div id="restartbar">
  <strong>Restart YHA:</strong>
  <label>mode <select id="restartMode"><option value="dev">dev</option><option value="build">build</option></select></label>
  <label>backend <select id="restartBackend"><option value="go">go</option><option value="node">node</option></select></label>
  <button class="danger" onclick="restartYHA()">↻ Restart now</button>
  <span class="current" id="restartCurrent"></span>
</div>

<div id="redobar">
  <strong>Redo stack:</strong>
  <span id="redoItems"></span>
  <button class="good" onclick="redoLast()">Redo last undo</button>
  <button onclick="clearRedo()">Clear</button>
</div>

<div class="panels">
  <div class="panel"><h2>System (top)<span class="stamp" id="topStamp"></span></h2>
    <pre id="topOut">loading…</pre></div>
  <div class="panel"><h2>pm2 processes<span class="stamp" id="pm2Stamp"></span></h2>
    <div id="pm2Out">loading…</div></div>
  <div class="panel" style="grid-column: 1 / -1"><h2>Active chat sessions<span class="stamp" id="sessStamp"></span></h2>
    <div id="sessOut">loading…</div></div>
</div>

<h2>Recent edits</h2>
<div id="packs">loading…</div>
<div id="log"></div>

<div id="modal" onclick="if(event.target===this)closeModal()">
  <div id="modalBody">
    <div id="modalHead"><h3 id="modalTitle">diff</h3>
      <button onclick="closeModal()">close</button></div>
    <div id="modalContent"></div>
  </div>
</div>

<script>
// When loaded via the bridge proxy at /__rewind/recover, absolute fetches
// like /api/packs would hit the bridge root (which has no such route) and
// 302 back to /. Detect the prefix from window.location.pathname and use it.
const BASE = (function() {
  const p = location.pathname;
  const m = p.match(/^(\/[^/]+)?\/recover(\/|$)/);
  return m && m[1] ? m[1] : '';
})();
// When embedded in the watchdog overlay iframe, the outer overlay already
// owns Reload + Hard reload — hide the inner duplicates to avoid noise.
if (window.self !== window.top) {
  const r = document.getElementById('btn-reload');
  const h = document.getElementById('btn-hard');
  if (r) r.style.display = 'none';
  if (h) h.style.display = 'none';
}

// Redo stack: ids of records that the user has undone via this page,
// in LIFO order. Persisted across reloads in sessionStorage so a
// soft-refresh doesn't lose the undo chain. Cleared on hard-reload (a
// new tab gets a fresh sessionStorage namespace).
const REDO_KEY = 'yha-rewind-redo-stack';
function loadRedoStack() {
  try { return JSON.parse(sessionStorage.getItem(REDO_KEY) || '[]'); }
  catch(e) { return []; }
}
function saveRedoStack(s) {
  try { sessionStorage.setItem(REDO_KEY, JSON.stringify(s)); } catch(e) {}
}
function pushRedo(id) {
  const s = loadRedoStack();
  s.push(id);
  saveRedoStack(s);
  renderRedoBar();
}
function popRedo() {
  const s = loadRedoStack();
  const v = s.pop();
  saveRedoStack(s);
  renderRedoBar();
  return v;
}
function clearRedo() { saveRedoStack([]); renderRedoBar(); }
function renderRedoBar() {
  const s = loadRedoStack();
  const bar = document.getElementById('redobar');
  const items = document.getElementById('redoItems');
  if (!s.length) { bar.classList.remove('has-items'); return; }
  bar.classList.add('has-items');
  items.innerHTML = s.map(id => '<span class="item">' + id.slice(0,8) + '</span>').join('');
}
renderRedoBar();

// Pre-fill the restart selectors from the server-rendered meta tags so the
// "Restart" defaults match what's currently running. Operator can override
// per-restart by changing the select before clicking.
(function initRestartBar() {
  const metaMode = document.querySelector('meta[name="yha-mode"]');
  const metaBackend = document.querySelector('meta[name="yha-backend"]');
  const m = (metaMode && metaMode.content) || 'build';
  const b = (metaBackend && metaBackend.content) || 'go';
  const ms = document.getElementById('restartMode');
  const bs = document.getElementById('restartBackend');
  if (ms) ms.value = (m === 'dev' || m === 'build') ? m : 'build';
  if (bs) bs.value = (b === 'go' || b === 'node') ? b : 'go';
  const cur = document.getElementById('restartCurrent');
  if (cur) cur.textContent = '(currently: ' + m + ' / ' + b + ')';
})();

async function restartYHA() {
  const mode = document.getElementById('restartMode').value;
  const backend = document.getElementById('restartBackend').value;
  if (!confirm('Restart YHA in ' + mode + ' / ' + backend + ' mode?\n' +
    'YHA-Bridge and YHA-Core will bounce (~10–30 s). This page stays up.')) return;
  log('restart requested: ' + mode + ' / ' + backend + '…');
  let r;
  try {
    r = await api('/api/yha-restart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode, backend }),
    });
  } catch (e) {
    log('restart request failed: ' + (e && e.message || e));
    return;
  }
  if (r.error) { log('restart error: ' + r.error); return; }
  log('restart spawned (' + (r.args || []).join(' ') + ') — poll bridge…');
  // Poll the bridge healthz to detect when it's back. The bridge proxies
  // /__rewind/* to us, so the same-origin /healthz-bridge probe routes
  // through it. When embedded standalone (no proxy), we skip the poll.
  pollBridgeReady();
}

async function pollBridgeReady() {
  // BASE = '/__rewind' when embedded behind the bridge proxy, '' when on
  // the standalone port. We only poll the bridge if it's the one in front
  // of us — otherwise there's no bridge endpoint to hit through this origin.
  if (!BASE) {
    log('standalone mode — refresh manually when ready.');
    return;
  }
  const start = Date.now();
  const timeoutMs = 60000;
  const tick = async () => {
    try {
      // Probe the bridge root (not /__rewind/*) — a 200 or 401/302 from the
      // bridge counts as "front door alive". A network error means it's
      // still down.
      const r = await fetch('/', { method: 'HEAD', cache: 'no-store' });
      if (r) {
        log('bridge responded (status ' + r.status + ') — reloading in 1s.');
        setTimeout(() => location.reload(), 1000);
        return;
      }
    } catch (e) { /* expected during the down window */ }
    if (Date.now() - start > timeoutMs) {
      log('still no bridge after ' + (timeoutMs/1000) + 's — refresh manually.');
      return;
    }
    setTimeout(tick, 1500);
  };
  setTimeout(tick, 2000);
}

async function api(path, opts) {
  const r = await fetch(BASE + path, opts);
  return r.json();
}
function log(msg) {
  const el = document.getElementById('log');
  el.textContent = '[' + new Date().toISOString().slice(11,19) + '] ' + msg + '\n' + el.textContent;
}
function hardReload() {
  if ('caches' in window) caches.keys().then(ks => ks.forEach(k => caches.delete(k)));
  location.reload();
}
async function loadPacks() {
  document.getElementById('packs').textContent = 'loading…';
  const data = await api('/api/packs?with_edits=1');
  const root = document.getElementById('packs');
  root.innerHTML = '';
  for (const p of data.packs) {
    const div = document.createElement('div');
    div.className = 'pack' + (p.working ? ' working' : '');
    const label = p.working
      ? 'Working pack (uncommitted) — ' + p.edit_count + ' edits'
      : ((p.commit_from ? p.commit_from.hash.slice(0,7) : 'init') + ' → ' +
         (p.commit_to ? p.commit_to.hash.slice(0,7) : 'HEAD') + ' — ' + p.edit_count + ' edits');
    div.innerHTML = '<div><strong>' + label + '</strong></div>';
    for (const e of (p.edits || []).slice().reverse()) {
      const ed = document.createElement('div');
      ed.className = 'edit';
      const ts = new Date(e.ts).toISOString().slice(0,19).replace('T',' ');
      const files = e.files.map(f => f.op[0] + ':' + f.path).join(', ');
      ed.innerHTML =
        '<span class="pill">' + e.trigger + '</span>' +
        '<span class="pill">' + e.module + '</span>' +
        '<span class="muted">' + ts + '</span><br>' +
        '<code>' + esc(files) + '</code> ' +
        '<button onclick="showDiff(\'' + e.id + '\')">diff</button>' +
        '<button class="danger" onclick="restore(\'' + e.id + '\')">undo</button>';
      div.appendChild(ed);
    }
    root.appendChild(div);
  }
}
function esc(s) {
  return String(s).replace(/[&<>]/g, c =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;');
}
function closeModal() { document.getElementById('modal').classList.remove('open'); }
function openModal(title, html) {
  document.getElementById('modalTitle').textContent = title;
  document.getElementById('modalContent').innerHTML = html;
  document.getElementById('modal').classList.add('open');
}
async function showDiff(id) {
  log('loading diff ' + id + '…');
  const d = await api('/api/diff/' + id);
  if (d.error) { log('diff error: ' + d.error); return; }
  const parts = [];
  for (const f of (d.files || [])) {
    parts.push('<div class="filehdr">' + esc(f.op) + ' ' + esc(f.path) + '</div>');
    parts.push('<div class="diffgrid">');
    parts.push(renderSide('before', f.before));
    parts.push(renderSide('after',  f.after));
    parts.push('</div>');
  }
  openModal('diff — ' + d.id.slice(0,8) + ' · ' + (d.module || ''), parts.join(''));
}
function renderSide(label, side) {
  if (!side) return '<div class="diffside"><div class="label">' + label +
    '</div><pre class="binmark">(no content)</pre></div>';
  if (side.binary) {
    return '<div class="diffside"><div class="label">' + label +
      '</div><pre class="binmark">(binary, ' + (side.size || 0) + ' bytes)</pre></div>';
  }
  const txt = (side.text == null) ? '' : side.text;
  return '<div class="diffside"><div class="label">' + label +
    '</div><pre>' + esc(txt) + '</pre></div>';
}
async function restore(id) {
  if (!confirm('Undo edit ' + id + '?\nThis writes the BEFORE content back to disk.')) return;
  const r = await api('/api/restore/' + id, { method: 'POST' });
  if (r.error) { log('undo failed: ' + r.error); return; }
  const okN = (r.results||[]).filter(x=>x.ok).length;
  const failN = (r.results||[]).filter(x=>!x.ok).length;
  log('undid ' + id.slice(0,8) + ' — ' + okN + ' OK, ' + failN + ' failed');
  if (okN > 0) pushRedo(id);
  loadPacks();
}
async function redoLast() {
  const id = popRedo();
  if (!id) { log('redo: nothing to redo'); return; }
  log('redo ' + id.slice(0,8) + '…');
  const r = await api('/api/restore/' + id + '?forward=1', { method: 'POST' });
  if (r.error) { log('redo failed: ' + r.error); pushRedo(id); return; }
  const okN = (r.results||[]).filter(x=>x.ok).length;
  const failN = (r.results||[]).filter(x=>!x.ok).length;
  log('redid ' + id.slice(0,8) + ' — ' + okN + ' OK, ' + failN + ' failed');
  loadPacks();
}
// ── Diagnostic panels ──────────────────────────────────────────────────────
function fmtUptimeMs(ms) {
  if (!ms || ms < 0) return '–';
  const s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ' + (s % 60) + 's';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ' + (m % 60) + 'm';
  const d = Math.floor(h / 24);
  return d + 'd ' + (h % 24) + 'h';
}
function nowStamp() { return new Date().toISOString().slice(11,19); }

async function loadTop() {
  const el = document.getElementById('topOut');
  const stamp = document.getElementById('topStamp');
  el.textContent = 'loading…';
  try {
    const d = await api('/api/top');
    if (d.error) { el.innerHTML = '<span class="err">' + esc(d.error) + '</span>'; return; }
    el.textContent = (d.lines || []).join('\n');
    stamp.textContent = nowStamp();
  } catch (e) {
    el.innerHTML = '<span class="err">' + esc(String(e && e.message || e)) + '</span>';
  }
}

async function loadPM2() {
  const el = document.getElementById('pm2Out');
  const stamp = document.getElementById('pm2Stamp');
  el.textContent = 'loading…';
  try {
    const d = await api('/api/pm2');
    if (d.error) { el.innerHTML = '<span class="err">' + esc(d.error) + '</span>'; return; }
    const procs = d.procs || [];
    if (!procs.length) { el.innerHTML = '<span class="muted">no pm2 processes</span>'; return; }
    const rows = [
      '<div class="pm2-row head"><div>name</div><div>status</div><div>cpu</div><div>mem</div><div>uptime</div><div></div></div>'
    ];
    for (const p of procs) {
      const statClass = p.status === 'online' ? 'stat-online'
                      : (p.status === 'stopped' ? 'stat-stopped' : 'stat-errored');
      // Block restart for self + "all" — same guardrail the server enforces,
      // surfaced here so the button is greyed out rather than the user getting
      // a 400 after clicking. The full restart button at the top is the
      // intended path for restarting everything.
      const blocked = p.name === 'YHA-Rewind';
      rows.push(
        '<div class="pm2-row">' +
          '<div class="name">' + esc(p.name) + '</div>' +
          '<div class="' + statClass + '">' + esc(p.status || '?') + '</div>' +
          '<div>' + (p.cpu || 0).toFixed(0) + '%</div>' +
          '<div>' + (p.mem_mb || 0).toFixed(0) + 'MB</div>' +
          '<div>' + fmtUptimeMs(p.uptime_ms) + '</div>' +
          '<div>' + (blocked
            ? '<button disabled title="restarting yha-rewind would kill this page — use the full restart">restart</button>'
            : '<button onclick="restartPM2(\'' + esc(p.name) + '\')">restart</button>') + '</div>' +
        '</div>'
      );
    }
    el.innerHTML = rows.join('');
    stamp.textContent = nowStamp();
  } catch (e) {
    el.innerHTML = '<span class="err">' + esc(String(e && e.message || e)) + '</span>';
  }
}

async function restartPM2(name) {
  if (!confirm('Restart pm2 process ' + name + '?')) return;
  log('pm2 restart ' + name + '…');
  try {
    const r = await api('/api/pm2/restart?name=' + encodeURIComponent(name), { method: 'POST' });
    if (r.ok) {
      log('pm2 restart ' + name + ' — OK');
    } else {
      log('pm2 restart ' + name + ' failed: ' + (r.err || r.error || 'unknown'));
    }
    setTimeout(loadPM2, 800); // let pm2 settle before refresh
  } catch (e) {
    log('pm2 restart ' + name + ' threw: ' + (e && e.message || e));
  }
}

async function loadSessions() {
  const el = document.getElementById('sessOut');
  const stamp = document.getElementById('sessStamp');
  el.textContent = 'loading…';
  try {
    const d = await api('/api/sessions');
    if (!d.reachable) {
      el.innerHTML = '<span class="err">core unreachable</span> <span class="muted">' +
        esc(d.err || '') + ' — use the Restart button above.</span>';
      stamp.textContent = nowStamp();
      return;
    }
    if (d.status && d.status >= 400) {
      el.innerHTML = '<span class="err">core returned ' + d.status + '</span>' +
        ' <span class="muted">(check YHA_BRIDGE_KEY in env)</span>';
      stamp.textContent = nowStamp();
      return;
    }
    const sessions = d.sessions || [];
    if (!sessions.length) { el.innerHTML = '<span class="muted">no sessions</span>'; return; }
    const rows = [
      '<div class="sess-row head">' + (d.runningCount || 0) + ' running · ' +
        (d.count || 0) + ' total — newest first</div>'
    ];
    for (const s of sessions.slice(0, 25)) {
      const running = s.isRunning
        ? '<span class="sess-running">● running</span> ' +
          (s.runningForMs ? '<span class="muted">' + fmtUptimeMs(s.runningForMs) + '</span>' : '')
        : '<span class="sess-idle">idle</span>';
      const last = s.lastUsed
        ? new Date(s.lastUsed).toISOString().slice(0,19).replace('T',' ')
        : '–';
      rows.push(
        '<div class="sess-row">' + running + ' · ' +
          '<strong>' + esc(s.name || s.id) + '</strong> ' +
          '<span class="muted">(' + s.messageCount + ' msgs · last ' + last + ')</span>' +
        '</div>'
      );
    }
    if (sessions.length > 25) {
      rows.push('<div class="sess-row muted">… +' + (sessions.length - 25) + ' more</div>');
    }
    el.innerHTML = rows.join('');
    stamp.textContent = nowStamp();
  } catch (e) {
    el.innerHTML = '<span class="err">' + esc(String(e && e.message || e)) + '</span>';
  }
}

// One refresh button does everything. Panels load in parallel so a slow
// /api/top (3s timeout) doesn't block pm2/sessions/packs.
function refreshAll() {
  loadPacks(); loadTop(); loadPM2(); loadSessions();
}

refreshAll();
</script>
</body></html>`
