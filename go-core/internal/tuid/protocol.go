// Package tuid implements the YHA TUI daemon (`YHA-TUI-Daemon`) — the
// long-running process that owns operator commands, job state and log
// streaming for the new `yha` TUI front door. See
// docs/YHA-TUI-Replacement-Plan.md for the full design.
//
// protocol.go defines the newline-delimited JSON wire types shared by:
//   - the daemon (unix-socket server, this package)
//   - the viewer (go-core/cmd/yha/tui — connects to daemon)
//   - the bridge HTTP shim (bridge/routes/yha-tui.ts — translates POST
//     bodies into the same envelope)
//
// One envelope per direction. Op strings are fixed; new ops MUST be added
// here so the dispatcher in daemon.go has a single source of truth.
package tuid

import (
	"encoding/json"

	"github.com/yha/core/internal/sysstatus"
)

// ── client → daemon ops ──────────────────────────────────────────────────

const (
	// OpPing — liveness probe. Daemon replies with {"op":"pong"}.
	OpPing = "ping"
	// OpStatus — request a one-shot snapshot of pm2/git/tailscale state.
	OpStatus = "status"
	// OpCmd — run a named command (restart, build, share, …). Daemon
	// allocates a job_id, runs the command serialized through its queue,
	// streams output back on the same connection if the client also
	// sends OpSubscribeJob{job_id}.
	OpCmd = "cmd"
	// OpListJobs — list all known jobs (running + recent). Each entry
	// carries job_id, cmd, status, origin, started_at, ended_at.
	OpListJobs = "list-jobs"
	// OpSubscribeJob — start streaming log chunks for a job. The server
	// replays from `since` (byte offset into the on-disk log) then
	// switches to live tailing. Multiple viewers may subscribe to the
	// same job; each keeps an independent cursor.
	OpSubscribeJob = "subscribe-job"
	// OpUnsubscribeJob — stop streaming log chunks for a job on this
	// connection. Other subscribers keep their streams.
	OpUnsubscribeJob = "unsubscribe-job"
)

// ── daemon → client ops ──────────────────────────────────────────────────

const (
	// OpPong — reply to ping.
	OpPong = "pong"
	// OpAck — generic acknowledgement, optionally carrying a job_id when
	// the client sent OpCmd.
	OpAck = "ack"
	// OpError — request rejected or failed. `err` carries a human-readable
	// message; `code` is a short machine token (bad-op, no-such-job, …).
	OpError = "error"
	// OpStatusSnap — reply to OpStatus.
	OpStatusSnap = "status-snap"
	// OpJobsList — reply to OpListJobs.
	OpJobsList = "jobs-list"
	// OpJobStarted — pushed when any job starts (broadcast to all
	// connected clients so a passive viewer can render "[external:
	// rewind-ui] restart" entries without polling).
	OpJobStarted = "job-started"
	// OpLogChunk — pushed to subscribers of a specific job. `data` is the
	// raw bytes appended since the last chunk; `next_offset` is the new
	// cursor position so a client that reconnects can resume.
	OpLogChunk = "log-chunk"
	// OpJobEnded — pushed when a job exits. `exit_code` is the child's
	// exit code; `reason` is set for daemon-side terminations (orphaned,
	// killed, timeout).
	OpJobEnded = "job-ended"
)

// ── job lifecycle states ─────────────────────────────────────────────────

const (
	JobRunning      = "running"
	JobDone         = "done"
	JobFailed       = "failed"
	// JobOrphanedLive — daemon crashed while a child was running; on
	// reboot, kill(pid, 0) showed the child still alive. The log file is
	// frozen at whatever the kernel flushed before the daemon died; the
	// child's live stdout pipe cannot be reattached across a restart.
	JobOrphanedLive = "orphaned-live"
	// JobOrphanedDead — daemon crashed while a child was running; on
	// reboot the child was gone. Synthesised exit_code = -1.
	JobOrphanedDead = "orphaned-dead"
)

// ── envelope ─────────────────────────────────────────────────────────────

// Envelope is the single message shape for both directions. Fields are
// optional and meaningful only for specific ops; the wire is JSON so
// absent fields are simply omitted.
type Envelope struct {
	Op    string `json:"op"`
	ID    string `json:"id,omitempty"`    // client-supplied correlation id
	JobID string `json:"job_id,omitempty"`

	// OpCmd payload
	Cmd    string   `json:"cmd,omitempty"`
	Args   []string `json:"args,omitempty"`
	Origin string   `json:"origin,omitempty"`

	// OpSubscribeJob payload
	Since int64 `json:"since,omitempty"`

	// OpLogChunk payload
	Data       string `json:"data,omitempty"`
	NextOffset int64  `json:"next_offset,omitempty"`

	// OpJobStarted / OpJobsList entry shape (also reused in JobMeta)
	Job *JobInfo `json:"job,omitempty"`

	// OpJobsList payload
	Jobs []JobInfo `json:"jobs,omitempty"`

	// OpJobEnded payload
	ExitCode *int   `json:"exit_code,omitempty"`
	Reason   string `json:"reason,omitempty"`

	// OpStatusSnap payload
	Status *StatusSnap `json:"status,omitempty"`

	// OpError / OpAck payload
	Err  string `json:"err,omitempty"`
	Code string `json:"code,omitempty"`
}

// JobInfo is the on-the-wire and on-disk representation of a job. The
// daemon also persists this as <job-id>.meta.json on disk so a daemon
// restart can reconcile orphaned children.
type JobInfo struct {
	JobID     string   `json:"job_id"`
	Cmd       string   `json:"cmd"`
	Args      []string `json:"args,omitempty"`
	Origin    string   `json:"origin,omitempty"`
	Status    string   `json:"status"`
	PID       int      `json:"pid,omitempty"`
	StartedAt int64    `json:"started_at"`         // unix milliseconds
	EndedAt   int64    `json:"ended_at,omitempty"` // unix milliseconds, 0 if running
	ExitCode  *int     `json:"exit_code,omitempty"`
	Reason    string   `json:"reason,omitempty"` // populated for orphaned/killed
	LogBytes  int64    `json:"log_bytes,omitempty"`
}

// StatusSnap is the cached pm2 + git + tailscale snapshot the daemon
// refreshes on its own schedule and returns to status callers. v1 keeps
// this lean; pretty parsers (§7 of plan) flesh it out later.
type StatusSnap struct {
	SampledAt int64           `json:"sampled_at"` // unix milliseconds
	PM2       []PM2Process    `json:"pm2,omitempty"`
	PM2Error  string          `json:"pm2_error,omitempty"`
	Git       *GitSnap        `json:"git,omitempty"`
	Tailscale *TailscaleSnap  `json:"tailscale,omitempty"`
	Runtime   *RuntimeSnap    `json:"runtime,omitempty"`
	Top       []TopProc       `json:"top,omitempty"`
	TopError  string          `json:"top_error,omitempty"`
	Daemon    DaemonSelfStats `json:"daemon"`
}

// TopProc is one row of the "what's actually running" panel. Aliased to
// sysstatus.TopProc so the sampler in internal/sysstatus and the standalone
// rewind binary (cmd/yha-rewind) can both produce/consume it without an
// adapter, while tuid consumers keep using `tuid.TopProc`.
type TopProc = sysstatus.TopProc

// RuntimeSnap captures which mode the running bridge was started with.
// Source of truth is /proc/<YHA-Bridge-pid>/environ so the answer reflects
// the *current* live bridge — not whatever env the long-lived TUI daemon
// inherited at its own start time (those drift apart whenever the user
// re-runs `./yha.sh dev|build` without bouncing the daemon, which is the
// common case since the daemon survives restarts on purpose).
type RuntimeSnap struct {
	Mode    string `json:"mode,omitempty"`    // "dev" | "build"
	Backend string `json:"backend,omitempty"` // "go" | "node"
	UseDist bool   `json:"use_dist"`          // YHA_USE_DIST
	Source  string `json:"source,omitempty"`  // "proc-env" | "self-env" | "inferred"
	Error   string `json:"error,omitempty"`
}

// PM2Process is one row of the pm2-like service table. Aliased to
// sysstatus.PM2Process so the shared sampler can produce it directly.
type PM2Process = sysstatus.PM2Process

type GitSnap struct {
	Branch   string `json:"branch,omitempty"`
	Head     string `json:"head,omitempty"`
	Staged   int    `json:"staged"`
	Unstaged int    `json:"unstaged"`
	Untracked int   `json:"untracked"`
	Ahead    int    `json:"ahead,omitempty"`
	Behind   int    `json:"behind,omitempty"`
	Dirty    bool   `json:"dirty"`
}

type TailscaleSnap struct {
	FunnelTarget string `json:"funnel_target,omitempty"` // local target, e.g. http://127.0.0.1:8443
	FunnelURL    string `json:"funnel_url,omitempty"`    // public URL, e.g. https://host.ts.net
	FunnelOK     bool   `json:"funnel_ok"`
	Error        string `json:"error,omitempty"`
}

type DaemonSelfStats struct {
	PID       int   `json:"pid"`
	StartedAt int64 `json:"started_at"`
	Uptime    int64 `json:"uptime_ms"`
	Jobs      int   `json:"jobs_known"`
}

// MarshalLine returns the envelope as a single line of JSON terminated
// by '\n'. The wire is one envelope per line — callers can write the
// result directly to the socket without buffering ceremony.
func (e *Envelope) MarshalLine() ([]byte, error) {
	b, err := json.Marshal(e)
	if err != nil {
		return nil, err
	}
	return append(b, '\n'), nil
}
