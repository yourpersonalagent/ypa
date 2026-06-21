package tuid

// jobs.go — the job registry. Owns the dictionary of running + recent
// jobs, the per-job ring-buffer fan-out for live subscribers, and the
// on-disk persistence (<job-id>.meta.json + <job-id>.log +
// <job-id>.done.json) that lets a daemon restart reconcile orphans.
//
// Design notes (see §10 of docs/YHA-TUI-Replacement-Plan.md):
//
//   - One Job per spawn. The Job struct holds the running command's
//     *os.Process plus the in-memory ring buffer that fans out live log
//     bytes to currently-attached subscribers.
//   - Every byte the child writes is appended to <job-id>.log AND
//     fanned to live subscribers. The log file is the durable record;
//     the ring buffer only exists for the lifetime of the daemon
//     process.
//   - On Job spawn we write <job-id>.meta.json immediately, before
//     calling cmd.Start, so a crash between start() and the goroutine
//     setup still leaves a discoverable record.
//   - On Job end (clean or signal) we write <job-id>.done.json. The
//     presence of done.json is what reconcile() uses to tell live jobs
//     from terminated ones.
//   - reconcile() runs once at daemon boot. It walks jobs/*.meta.json,
//     and for each entry without a sibling done.json it checks
//     kill(pid, 0):
//       - alive → mark JobOrphanedLive, append a synthetic warning
//         line to the log, surface the entry in list-jobs so the user
//         can find the still-running child manually.
//       - gone  → synthesise done.json with exit_code=-1.

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/yha/core/internal/paths"
)

// Registry is the in-memory job table + on-disk persistence layer.
// Concurrent-safe via mu.
type Registry struct {
	mu        sync.Mutex
	jobs      map[string]*Job
	dir       string
	listeners []chan Envelope // broadcast subscribers (job-started / job-ended fanout)
}

// NewRegistry creates a registry rooted at bridge/state/yha-tui/jobs/.
// Caller should invoke Reconcile() once before serving traffic.
func NewRegistry() (*Registry, error) {
	dir := paths.TUIJobsDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("mkdir jobs dir: %w", err)
	}
	return &Registry{
		jobs: make(map[string]*Job),
		dir:  dir,
	}, nil
}

// Job is the in-memory handle for a single spawned command.
type Job struct {
	mu sync.Mutex

	Info JobInfo

	cmd     *exec.Cmd
	logFile *os.File
	doneCh  chan struct{}

	// fan-out state. subs is the set of channels that want live chunks.
	// We push fixed-size []byte chunks; subscribers that fall behind
	// see chunks coalesced — they only ever get the latest in their
	// buffered channel, never block the writer.
	subs map[chan []byte]struct{}
}

// SpawnSpec describes a job the daemon wants to run.
type SpawnSpec struct {
	Cmd    string   // canonical command name (restart, build, share, …)
	Args   []string // CLI args passed to the underlying tool
	Origin string   // who triggered it (cli, rewind-ui, prefs-modal, #debug)

	// Argv is the actual exec invocation. If empty, the daemon's command
	// dispatcher fills it from Cmd+Args using its command table. This
	// keeps the Registry oblivious to "what does `restart` mean".
	Argv []string
	Env  []string
	Dir  string
}

// Spawn launches the job, persists metadata, and starts a copier
// goroutine that fans every output byte into the log file + live
// subscribers.
func (r *Registry) Spawn(spec SpawnSpec) (*Job, error) {
	if len(spec.Argv) == 0 {
		return nil, errors.New("Spawn: empty argv")
	}

	jobID := uuid.NewString()
	now := time.Now().UnixMilli()

	job := &Job{
		Info: JobInfo{
			JobID:     jobID,
			Cmd:       spec.Cmd,
			Args:      spec.Args,
			Origin:    spec.Origin,
			Status:    JobRunning,
			StartedAt: now,
		},
		doneCh: make(chan struct{}),
		subs:   make(map[chan []byte]struct{}),
	}

	logPath := r.logPath(jobID)
	f, err := os.OpenFile(logPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return nil, fmt.Errorf("open log: %w", err)
	}
	job.logFile = f

	cmd := exec.Command(spec.Argv[0], spec.Argv[1:]...)
	if spec.Dir != "" {
		cmd.Dir = spec.Dir
	}
	if len(spec.Env) > 0 {
		cmd.Env = spec.Env
	}
	// Child stdout + stderr go through a single pipe so ordering is
	// preserved as the user would see in a terminal.
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		f.Close()
		return nil, fmt.Errorf("stdout pipe: %w", err)
	}
	cmd.Stderr = cmd.Stdout

	// Persist metadata BEFORE starting so a crash between start and the
	// goroutine setup still leaves a discoverable record.
	if err := r.writeMeta(&job.Info); err != nil {
		f.Close()
		return nil, fmt.Errorf("write meta: %w", err)
	}

	if err := cmd.Start(); err != nil {
		f.Close()
		// Synthesise a done.json so reconcile doesn't pick this up as
		// an orphan later.
		exit := -1
		job.Info.Status = JobFailed
		job.Info.EndedAt = time.Now().UnixMilli()
		job.Info.ExitCode = &exit
		job.Info.Reason = "start failed: " + err.Error()
		_ = r.writeDone(&job.Info)
		return nil, fmt.Errorf("start: %w", err)
	}

	job.cmd = cmd
	job.Info.PID = cmd.Process.Pid
	_ = r.writeMeta(&job.Info) // refresh with PID

	r.mu.Lock()
	r.jobs[jobID] = job
	listeners := append([]chan Envelope(nil), r.listeners...)
	r.mu.Unlock()

	// Broadcast job-started to passive subscribers.
	startedEnv := Envelope{Op: OpJobStarted, JobID: jobID, Job: snapshotInfo(&job.Info)}
	for _, ch := range listeners {
		select {
		case ch <- startedEnv:
		default:
		}
	}

	go r.runPipe(job, stdout)

	return job, nil
}

// runPipe drains the child's combined stdout/stderr, appends to the log
// file, fans out to live subscribers, and on EOF waits for the child to
// exit and persists done.json.
func (r *Registry) runPipe(job *Job, stdout io.ReadCloser) {
	defer close(job.doneCh)

	buf := make([]byte, 4096)
	for {
		n, err := stdout.Read(buf)
		if n > 0 {
			chunk := make([]byte, n)
			copy(chunk, buf[:n])

			job.mu.Lock()
			if _, werr := job.logFile.Write(chunk); werr == nil {
				job.Info.LogBytes += int64(n)
			}
			// Fan out to live subscribers — non-blocking; if a
			// subscriber's channel is full we drop and let them
			// reconcile via the on-disk log on next subscribe.
			for ch := range job.subs {
				select {
				case ch <- chunk:
				default:
				}
			}
			job.mu.Unlock()
		}
		if err != nil {
			break
		}
	}

	// Wait for the child to exit so we have a real exit code.
	waitErr := job.cmd.Wait()
	_ = job.logFile.Sync()
	_ = job.logFile.Close()

	exit := 0
	status := JobDone
	reason := ""
	if waitErr != nil {
		var ee *exec.ExitError
		if errors.As(waitErr, &ee) {
			exit = ee.ExitCode()
		} else {
			exit = -1
			reason = waitErr.Error()
		}
		status = JobFailed
	}

	job.mu.Lock()
	job.Info.Status = status
	job.Info.EndedAt = time.Now().UnixMilli()
	job.Info.ExitCode = &exit
	job.Info.Reason = reason
	subs := make([]chan []byte, 0, len(job.subs))
	for ch := range job.subs {
		subs = append(subs, ch)
	}
	job.mu.Unlock()

	_ = r.writeMeta(&job.Info)
	_ = r.writeDone(&job.Info)

	// Close subscriber channels so they exit their read loops.
	for _, ch := range subs {
		close(ch)
	}

	// Broadcast job-ended.
	r.mu.Lock()
	listeners := append([]chan Envelope(nil), r.listeners...)
	r.mu.Unlock()
	endedEnv := Envelope{
		Op:       OpJobEnded,
		JobID:    job.Info.JobID,
		ExitCode: &exit,
		Reason:   reason,
		Job:      snapshotInfo(&job.Info),
	}
	for _, ch := range listeners {
		select {
		case ch <- endedEnv:
		default:
		}
	}
}

// List returns a snapshot of every known job (running first by start
// time desc, then ended).
func (r *Registry) List() []JobInfo {
	r.mu.Lock()
	defer r.mu.Unlock()
	out := make([]JobInfo, 0, len(r.jobs))
	for _, j := range r.jobs {
		j.mu.Lock()
		out = append(out, j.Info)
		j.mu.Unlock()
	}
	return out
}

// Get returns the in-memory handle for a job, or nil.
func (r *Registry) Get(jobID string) *Job {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.jobs[jobID]
}

// Subscribe attaches `out` as a live-chunk subscriber for the job.
// Returns the on-disk replay reader (which the caller must drain
// BEFORE expecting live chunks — the daemon's dispatcher handles that
// sequencing). When the job ends or Unsubscribe is called the channel
// is closed.
//
// `since` is the byte offset into the on-disk log to start replaying
// from; 0 means "everything from the start." See §10 of the plan for
// the locked concurrent-viewer cursor semantics.
func (r *Registry) Subscribe(jobID string, since int64, out chan []byte) (*os.File, int64, error) {
	job := r.Get(jobID)
	if job == nil {
		return nil, 0, fmt.Errorf("no such job: %s", jobID)
	}
	// Open log file for replay. The job's writer side holds its own
	// fd; this read fd is independent so we don't risk a partial-write
	// race with the writer.
	f, err := os.Open(r.logPath(jobID))
	if err != nil {
		return nil, 0, fmt.Errorf("open log for replay: %w", err)
	}
	if since > 0 {
		if _, err := f.Seek(since, io.SeekStart); err != nil {
			f.Close()
			return nil, 0, fmt.Errorf("seek log: %w", err)
		}
	}
	job.mu.Lock()
	// If the job has already ended, don't register a live subscriber —
	// the channel would just dangle until the caller closes it. Caller
	// drains the file and is done.
	alreadyDone := job.Info.Status != JobRunning
	if !alreadyDone {
		job.subs[out] = struct{}{}
	}
	logBytes := job.Info.LogBytes
	job.mu.Unlock()
	if alreadyDone {
		// Signal "stream is finished after the file replay" by closing
		// the channel up front. Caller can still read the file.
		close(out)
	}
	return f, logBytes, nil
}

// Unsubscribe removes the channel from the job's live fan-out.
// Idempotent — safe to call after job ended.
func (r *Registry) Unsubscribe(jobID string, out chan []byte) {
	job := r.Get(jobID)
	if job == nil {
		return
	}
	job.mu.Lock()
	if _, ok := job.subs[out]; ok {
		delete(job.subs, out)
	}
	job.mu.Unlock()
}

// AddListener registers a channel that receives job-started /
// job-ended events for every job. Used by the daemon's broadcast
// fan-out so passive viewers get external-call notifications.
func (r *Registry) AddListener(ch chan Envelope) {
	r.mu.Lock()
	r.listeners = append(r.listeners, ch)
	r.mu.Unlock()
}

// RemoveListener detaches a listener.
func (r *Registry) RemoveListener(ch chan Envelope) {
	r.mu.Lock()
	defer r.mu.Unlock()
	for i, c := range r.listeners {
		if c == ch {
			r.listeners = append(r.listeners[:i], r.listeners[i+1:]...)
			return
		}
	}
}

// LogPath exposes the on-disk path for a job's log so the HTTP shim can
// stream it without going through the unix socket.
func (r *Registry) LogPath(jobID string) string { return r.logPath(jobID) }

// ── reconcile (crash recovery) ───────────────────────────────────────────

// Reconcile walks the jobs dir and folds any meta.json without a
// matching done.json into the in-memory registry, marking each as
// orphaned-live (child still running) or orphaned-dead (child gone).
// Called once at daemon boot.
func (r *Registry) Reconcile() error {
	entries, err := os.ReadDir(r.dir)
	if err != nil {
		return err
	}
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		name := e.Name()
		if !strings.HasSuffix(name, ".meta.json") {
			continue
		}
		jobID := strings.TrimSuffix(name, ".meta.json")
		info, err := r.readMeta(jobID)
		if err != nil {
			continue
		}
		donePath := r.donePath(jobID)
		if _, err := os.Stat(donePath); err == nil {
			// Terminated cleanly — bring the latest meta + done into
			// the registry as a finished job so list-jobs sees it.
			r.adoptFinished(info)
			continue
		}
		// No done.json — child status is unknown.
		alive := info.PID > 0 && pidAlive(info.PID)
		if alive {
			info.Status = JobOrphanedLive
			info.Reason = "daemon restart — log stream lost, child still running"
			// Append a synthetic notice to the log so future viewers
			// see the gap is documented.
			r.appendNotice(jobID,
				fmt.Sprintf("\n[daemon-restart: log stream lost, child still running pid=%d]\n",
					info.PID))
		} else {
			info.Status = JobOrphanedDead
			info.EndedAt = time.Now().UnixMilli()
			exit := -1
			info.ExitCode = &exit
			info.Reason = "orphaned (daemon crash)"
			_ = r.writeDone(info)
		}
		_ = r.writeMeta(info)
		r.adoptFinished(info)
	}
	return nil
}

// adoptFinished registers a non-running JobInfo so list-jobs surfaces
// it. We don't create a Job handle (no cmd, no subscribers) — just a
// stub with the info populated.
func (r *Registry) adoptFinished(info *JobInfo) {
	stub := &Job{Info: *info, doneCh: closedChan(), subs: make(map[chan []byte]struct{})}
	r.mu.Lock()
	r.jobs[info.JobID] = stub
	r.mu.Unlock()
}

func closedChan() chan struct{} {
	ch := make(chan struct{})
	close(ch)
	return ch
}

func pidAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	// On Unix, FindProcess always succeeds; the real check is signal 0.
	return p.Signal(syscall.Signal(0)) == nil
}

// ── on-disk file helpers ─────────────────────────────────────────────────

func (r *Registry) logPath(jobID string) string {
	return filepath.Join(r.dir, jobID+".log")
}
func (r *Registry) metaPath(jobID string) string {
	return filepath.Join(r.dir, jobID+".meta.json")
}
func (r *Registry) donePath(jobID string) string {
	return filepath.Join(r.dir, jobID+".done.json")
}

func (r *Registry) writeMeta(info *JobInfo) error {
	return atomicJSONWrite(r.metaPath(info.JobID), info)
}

func (r *Registry) writeDone(info *JobInfo) error {
	return atomicJSONWrite(r.donePath(info.JobID), info)
}

func (r *Registry) readMeta(jobID string) (*JobInfo, error) {
	b, err := os.ReadFile(r.metaPath(jobID))
	if err != nil {
		return nil, err
	}
	var info JobInfo
	if err := json.Unmarshal(b, &info); err != nil {
		return nil, err
	}
	if info.JobID == "" {
		info.JobID = jobID
	}
	return &info, nil
}

func (r *Registry) appendNotice(jobID, line string) {
	f, err := os.OpenFile(r.logPath(jobID), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	w := bufio.NewWriter(f)
	_, _ = w.WriteString(line)
	_ = w.Flush()
}

func atomicJSONWrite(path string, v any) error {
	b, err := json.MarshalIndent(v, "", "  ")
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, b, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func snapshotInfo(in *JobInfo) *JobInfo {
	cp := *in
	return &cp
}
