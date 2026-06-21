// Package claudebinary is the Go port of bridge/providers/claude-{run,stream}.ts.
//
// The package owns the `claude` CLI subprocess harness: spawn → write
// initial user JSONL → parse stream-json stdout → emit Chunks via the
// existing stream.EmitFn surface → finalize cost/auto-title.
//
// Status (Phase 7, 2026-05-11): default-on adapter. Phase 6g flipped the
// per-label gate to opt-OUT (YHA_GO_CLAUDE_BINARY=0 disables); Phase 7
// then deleted the Node /v1/stream/ fallback so this adapter is one of
// the canonical sinks for any non-direct Claude request.
//
// Files in this package:
//   - claudebinary.go (this file) — Streamer.Stream entry + lifecycle
//   - run.go — synchronous Run() (mirrors runClaude)
//   - spawn.go — subprocess spawn helpers (args, env, niceness)
//   - events.go — stream-json parser → stream.Chunk
package claudebinary

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/yha/core/internal/logger"
	"github.com/yha/core/internal/paths"
	"github.com/yha/core/internal/stream"
)

// FinalizeKillTimeoutMs is the kill-watchdog delay from claude-stream.ts.
// When the binary emits its final "result" we finalize the chunk stream
// immediately, then arm this timer so a hung child doesn't leak.
const FinalizeKillTimeoutMs = 30 * time.Second

// StartupTimeout is the initial-output watchdog. If the binary spawns but
// emits zero chunks (MCP handshake stall, TLS hang, OAuth deadlock) within
// this window we SIGKILL it and surface a "startup stalled" error instead
// of letting the caller spin indefinitely. Mirrors the JS-side timer in
// bridge/providers/claude-stream.ts.
const StartupTimeout = 60 * time.Second

// watchdogLogWarned ensures we only emit one warning per process when the
// monitoring-log NDJSON write fails (disk full, EACCES, RO mount). Without
// the latch, every subsequent watchdog kill would re-log the same error.
var watchdogLogWarned atomic.Bool

// inferKillCause guesses why the binary hung based on stderr keywords.
// Best-effort hint to make recurring patterns visible in the kill log; the
// actual stderr tail is recorded alongside so the operator can verify.
func inferKillCause(stderrTail string) string {
	s := strings.ToLower(stderrTail)
	switch {
	case strings.Contains(s, "tls"), strings.Contains(s, "certificate"):
		return "tls-teardown"
	case strings.Contains(s, "oauth"), strings.Contains(s, "refresh token"):
		return "oauth-refresh"
	case strings.Contains(s, "plugin"), strings.Contains(s, "shutdown"):
		return "plugin-shutdown"
	case strings.Contains(s, "mcp") && (strings.Contains(s, "connect") || strings.Contains(s, "handshake")):
		return "mcp-handshake"
	default:
		return "unknown"
	}
}

// readProcStatus returns the first 12 lines of /proc/<pid>/status on Linux,
// or "" elsewhere. Used in watchdog-kill diagnostics so we can see whether
// the child was waiting on I/O, blocked on a futex, etc.
func readProcStatus(pid int) string {
	if pid <= 0 {
		return ""
	}
	buf, err := os.ReadFile(fmt.Sprintf("/proc/%d/status", pid))
	if err != nil {
		return ""
	}
	lines := strings.SplitN(string(buf), "\n", 13)
	if len(lines) > 12 {
		lines = lines[:12]
	}
	return strings.Join(lines, "\n")
}

// writeWatchdogKillRecord appends one NDJSON line to
// bridge/monitoring-log/<YYYY-MM-DD>-watchdog-kills.ndjson. Best-effort —
// failure warns once per process and otherwise stays quiet.
func writeWatchdogKillRecord(log *logger.Logger, entry map[string]any) {
	dir := filepath.Join(paths.BridgeRoot(), "monitoring-log")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		if watchdogLogWarned.CompareAndSwap(false, true) {
			log.Warn("claudebinary.watchdog-log.mkdir-failed", "dir", dir, "err", err)
		}
		return
	}
	now := time.Now().UTC()
	key := fmt.Sprintf("%04d-%02d-%02d", now.Year(), now.Month(), now.Day())
	entry["ts"] = now.Format(time.RFC3339Nano)
	line, err := json.Marshal(entry)
	if err != nil {
		return
	}
	f, err := os.OpenFile(filepath.Join(dir, key+"-watchdog-kills.ndjson"), os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o644)
	if err != nil {
		if watchdogLogWarned.CompareAndSwap(false, true) {
			log.Warn("claudebinary.watchdog-log.open-failed", "dir", dir, "err", err)
		}
		return
	}
	defer f.Close()
	if _, err := f.Write(append(line, '\n')); err != nil {
		if watchdogLogWarned.CompareAndSwap(false, true) {
			log.Warn("claudebinary.watchdog-log.write-failed", "dir", dir, "err", err)
		}
	}
}

// SessionResolver is the surface the Streamer uses to look up the
// binary's previously-saved session id (so --resume continues the same
// conversation across spawn boundaries). It's deliberately minimal so
// tests can inject an in-memory map.
//
// Get returns the binary session id for the given history session id,
// or empty string if none is known.
//
// Set records a session id returned by the binary's result event.
//
// Delete drops a known id (used when the binary returns
// "No conversation found with session ID" so the next retry starts
// fresh). Idempotent — deleting an unknown id is a no-op.
type SessionResolver interface {
	Get(historySessionID string) string
	Set(historySessionID, claudeSessionID string)
	Delete(historySessionID string)
}

// MemorySessionResolver is the default in-memory implementation —
// good enough for the Phase 6a tests and for the daemon when Node's
// state isn't reachable. Phase 6g may wire this to a Go-side
// claudeSessions store backed by sessions/internal-index.json.
type MemorySessionResolver struct {
	mu sync.RWMutex
	m  map[string]string
}

// NewMemorySessionResolver returns a fresh, empty resolver.
func NewMemorySessionResolver() *MemorySessionResolver {
	return &MemorySessionResolver{m: map[string]string{}}
}

// Get implements SessionResolver.
func (r *MemorySessionResolver) Get(k string) string {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.m[k]
}

// Set implements SessionResolver.
func (r *MemorySessionResolver) Set(k, v string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.m[k] = v
}

// Delete implements SessionResolver.
func (r *MemorySessionResolver) Delete(k string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.m, k)
}

// FinalizePayload is the data the caller's onFinalize hook sees once
// the stream wraps up. Mirrors the onDone payload Node's streamClaude
// hands to its caller — text, cost, stop reason, full token tally.
type FinalizePayload struct {
	Text                string
	Cost                float64
	StopReason          string
	InputTokens         int
	OutputTokens        int
	CacheCreationTokens int
	CacheReadTokens     int
	ClaudeSessionID     string
}

// Request packages everything the streamer needs from the route layer.
// Mostly a flat copy of the SpawnOpts so callers can build it once
// per request and not thread state-store accessors through here.
type Request struct {
	Prompt           string
	HistorySessionID string

	// SpawnOpts plug straight through to BuildCmd. Note that Prompt
	// + HistorySessionID are NOT in SpawnOpts — they're inputs to the
	// stdin writer, not the spawn.
	Spawn SpawnOpts

	// ImageBlocks — if non-empty, the initial JSONL message includes
	// them inside a multi-block content array. Each entry is the raw
	// JSON shape the binary expects (e.g. {type:"image", source:...}).
	ImageBlocks []map[string]any

	// MaxRetries caps how many times we retry on "No conversation
	// found with session ID" stderr. Mirrors the TS _retryCount<1
	// guard. Default 1 (one retry).
	MaxRetries int
}

// Streamer is the entry point for streaming spawns. One instance per
// daemon; safe for concurrent Stream calls.
type Streamer struct {
	resolver SessionResolver
	log      *logger.Logger

	// finalizeKillTimeout overrides FinalizeKillTimeoutMs for tests.
	finalizeKillTimeout time.Duration

	// processSpawn factors out the actual exec.Cmd Start/Wait pair so
	// tests can substitute a fake "binary" that streams scripted JSON.
	// Production sets this to spawnProcess (defined below); leaving it
	// nil also works — Streamer.Stream falls back to spawnProcess.
	processSpawn ProcessSpawnFn
}

// ProcessSpawnFn is the test seam — a function that, given the spawn
// opts + initial stdin payload, returns the stdout/stderr readers,
// a Kill func, a Wait func, and the PID (for nice-level adjustment).
// The Wait func should block until the process exits and return its
// exit code (or -1 on error).
type ProcessSpawnFn func(ctx context.Context, opts SpawnOpts, initialStdin []byte) (ProcessHandles, error)

// ProcessHandles is the bundle a ProcessSpawnFn returns. Each handle
// has well-defined ownership:
//   - Stdout / Stderr: owned by the streamer; closed on its return.
//   - Stdin: optional. When non-nil, the streamer keeps it open for
//     /btw mid-turn writes. May be nil for ProcessSpawnFns that don't
//     plan to accept further input.
//   - Kill: idempotent; called on context cancellation OR on the
//     finalize-watchdog timer.
//   - Wait: blocks until the process exits. Called once.
//   - PID: used for SetNiceness. -1 = unknown / unsupported.
type ProcessHandles struct {
	Stdout io.Reader
	Stderr io.Reader
	Stdin  io.WriteCloser
	Kill   func() error
	Wait   func() error
	PID    int
}

// NewStreamer returns a Streamer with the given resolver and logger.
// Logger may be nil — replaced with a no-op writer.
func NewStreamer(resolver SessionResolver, log *logger.Logger) *Streamer {
	if resolver == nil {
		resolver = NewMemorySessionResolver()
	}
	if log == nil {
		log = logger.New(io.Discard)
	}
	return &Streamer{
		resolver:            resolver,
		log:                 log,
		finalizeKillTimeout: FinalizeKillTimeoutMs,
		processSpawn:        spawnProcess,
	}
}

// WithProcessSpawn returns a copy of s with a custom spawn function.
// Used by tests to inject a fake subprocess. The original s is not
// mutated.
func (s *Streamer) WithProcessSpawn(fn ProcessSpawnFn) *Streamer {
	cp := *s
	cp.processSpawn = fn
	return &cp
}

// WithFinalizeKillTimeout returns a copy of s with the kill-watchdog
// timeout overridden. Tests use 0 / very small values to drive the
// watchdog path quickly.
func (s *Streamer) WithFinalizeKillTimeout(d time.Duration) *Streamer {
	cp := *s
	cp.finalizeKillTimeout = d
	return &cp
}

// HasResume reports whether the resolver has a stored claude-binary
// session id for the given YHA history session id. The route /
// adapter wiring uses this to decide whether to fold prior-turn
// history into the prompt — when --resume IS available the binary
// already remembers the conversation, so injecting history again
// would duplicate context and confuse the model. Mirrors the
// `cSid` check in bridge/providers/claude-stream.ts:83-87.
func (s *Streamer) HasResume(historySID string) bool {
	if s == nil || s.resolver == nil {
		return false
	}
	if strings.TrimSpace(historySID) == "" {
		return false
	}
	return strings.TrimSpace(s.resolver.Get(historySID)) != ""
}

// Stream runs the binary, parses its stream-json output, and emits
// chunks via the supplied stream.EmitFn. Blocks until the binary
// exits or ctx is cancelled.
//
// Returns (finalize, error). finalize is non-nil only on a clean
// completion — error means the spawn failed or the binary emitted
// is_error=true.
//
// On stale-resume retry, Stream calls itself recursively (capped by
// req.MaxRetries; default 1). The retry path clears the cached
// claude session id before respawning.
func (s *Streamer) Stream(
	ctx context.Context,
	req Request,
	emit stream.EmitFn,
) (*FinalizePayload, error) {
	return s.streamWithRetry(ctx, req, emit, 0)
}

func (s *Streamer) streamWithRetry(
	ctx context.Context,
	req Request,
	emit stream.EmitFn,
	retryCount int,
) (*FinalizePayload, error) {
	hSID := req.HistorySessionID
	if hSID == "" {
		hSID = req.Spawn.ConfigDir // fallback so the resolver still works
	}

	// --resume continuation. Carries forward the binary's session id
	// from a previous spawn, if any.
	if req.Spawn.ResumeSessionID == "" {
		req.Spawn.ResumeSessionID = s.resolver.Get(hSID)
	}

	initialStdin, err := buildInitialStdin(req.Prompt, req.ImageBlocks, req.Spawn.Stream)
	if err != nil {
		return nil, fmt.Errorf("claudebinary: build initial stdin: %w", err)
	}

	spawnFn := s.processSpawn
	if spawnFn == nil {
		spawnFn = spawnProcess
	}
	handles, err := spawnFn(ctx, req.Spawn, initialStdin)
	if err != nil {
		return nil, fmt.Errorf("claudebinary: spawn: %w", err)
	}
	spawnedAt := time.Now()
	defer func() {
		// Best-effort cleanup. Kill is idempotent.
		if handles.Kill != nil {
			_ = handles.Kill()
		}
	}()

	// Best-effort niceness — error here is non-fatal.
	if handles.PID > 0 {
		if err := SetNiceness(handles.PID, req.Spawn.IsInteractive); err != nil {
			s.log.Warn("claudebinary.setpriority", "err", err, "pid", handles.PID)
		}
		// Bind the child to go-core's lifetime via the OS so a hard crash
		// or `taskkill /F` (the only way the Windows supervisor stops us —
		// SIGTERM isn't deliverable, so graceful shutdown never runs)
		// can't leave an orphaned claude.exe pegging RAM + a session slot.
		// See jobobject_windows.go. Best-effort: yha.ps1 Kill-OrphanHarness
		// is the backstop if this fails.
		if err := assignChildToParentLifetime(handles.PID); err != nil {
			s.log.Warn("claudebinary.killjob.assign", "err", err, "pid", handles.PID)
		}
	}

	// Track pending /btw turns and accumulate per-event results.
	// pendingTurns starts at 1 (the initial prompt); each successful
	// /btw write bumps it; each "result" event decrements. We finalize
	// when it reaches 0.
	pendingTurns := int64(1)
	var (
		permEmitMu sync.Mutex
		permEmit   = func(snapshot map[string]any) {
			permEmitMu.Lock()
			defer permEmitMu.Unlock()
			// Emit a typed perm-denials chunk so the FE renders a
			// per-tool denial card instead of parsing the legacy
			// `permission_denials:N` magic-string Error packing.
			emit(stream.Chunk{
				Type:        stream.ChunkTypePermDenials,
				PermDenials: snapshotToPermDenials(snapshot),
			})
		}
	)

	// Live-stdin sink registration. While a subprocess is alive, the
	// /v1/sessions/:id/btw POST writes straight into its stdin between
	// turns instead of waiting for the next history rebuild. Mirrors
	// bridge/chat/claude-stream.ts:289-310. The JSONL wrapper text
	// matches what the binary sees from the FE, so the model treats it
	// as a real user-side mid-response interjection.
	stdinMu := &sync.Mutex{}
	stdinClosed := int64(0)
	if req.HistorySessionID != "" && handles.Stdin != nil {
		sid := req.HistorySessionID
		sink := func(text string) bool {
			if atomic.LoadInt64(&stdinClosed) != 0 {
				return false
			}
			line, err := json.Marshal(map[string]any{
				"type": "user",
				"message": map[string]any{
					"role": "user",
					"content": []map[string]any{{
						"type": "text",
						"text": stream.FormatBtwInjectionText(text),
					}},
				},
			})
			if err != nil {
				return false
			}
			stdinMu.Lock()
			defer stdinMu.Unlock()
			if _, werr := handles.Stdin.Write(append(line, '\n')); werr != nil {
				// Broken pipe — child has exited / closed stdin. Mark
				// closed so future TryLiveStdinInject short-circuits
				// without retrying the write.
				atomic.StoreInt64(&stdinClosed, 1)
				return false
			}
			atomic.AddInt64(&pendingTurns, 1)
			return true
		}
		stream.RegisterLiveStdin(sid, sink)
		defer stream.UnregisterLiveStdin(sid)
	}

	// onTurn fires per "result" event. Decrements the pendingTurns
	// counter — initial prompt is 1, each successful /btw write bumps
	// it via the live-stdin sink above. Finalize fires when the counter
	// reaches 0.
	onTurn := func(ev ResultEvent) bool {
		atomic.AddInt64(&pendingTurns, -1)
		return atomic.LoadInt64(&pendingTurns) <= 0
	}

	// Initial-output watchdog. Distinct from the finalize watchdog below:
	// fires when the binary spawns but emits no chunks at all within
	// StartupTimeout. Cancels on the first parsed event.
	var (
		firstEvent      atomic.Bool
		startupTimedOut atomic.Bool
	)
	startupTimer := time.AfterFunc(StartupTimeout, func() {
		if firstEvent.Load() {
			return
		}
		startupTimedOut.Store(true)
		s.log.Warn("claudebinary.startup-timeout",
			"history_sid", req.HistorySessionID, "timeout", StartupTimeout)
		if handles.Kill != nil {
			_ = handles.Kill()
		}
	})
	defer startupTimer.Stop()

	// Run the parser. Cancelling ctx unblocks via the Kill defer above
	// — processStream itself respects ctx.
	done := make(chan struct{})
	var (
		result      Result
		stats       EventStats
		processErr  error
		waitErr     error
		finalizeErr error
	)
	emitAdapter := EventEmit(func(c stream.Chunk) {
		if firstEvent.CompareAndSwap(false, true) {
			startupTimer.Stop()
		}
		emit(c)
	})
	go func() {
		defer close(done)
		result, stats, processErr = processStream(ctx, handles.Stdout, handles.Stderr, emitAdapter, permEmit, onTurn)
	}()

	// Block until either the parser returns or ctx is cancelled.
	ctxCancelled := false
	select {
	case <-done:
	case <-ctx.Done():
		ctxCancelled = true
		if handles.Kill != nil {
			_ = handles.Kill()
		}
		<-done
		// Surface ctx.Err only if parser didn't already record a more
		// specific failure. EOF from the pipe close is not an error
		// we want to mask the cancellation with.
		if processErr == nil || processErr == io.EOF {
			processErr = ctx.Err()
		}
	}

	// Arm a watchdog to kill the child if it didn't exit promptly
	// after the last result event. The TS code does this exactly — the
	// child can hang in TLS teardown / plugin shutdown.
	if s.finalizeKillTimeout > 0 && stats.ResultEvents > 0 && handles.Kill != nil {
		t := time.AfterFunc(s.finalizeKillTimeout, func() {
			pid := handles.PID
			stderrTail := stats.StderrText
			if len(stderrTail) > 2000 {
				stderrTail = stderrTail[len(stderrTail)-2000:]
			}
			cause := inferKillCause(stderrTail)
			writeWatchdogKillRecord(s.log, map[string]any{
				"source":            "go-core/claudebinary",
				"history_sid":       hSID,
				"model":             req.Spawn.Model,
				"pid":               pid,
				"duration_ms":       time.Since(spawnedAt).Milliseconds(),
				"finalize_timeout":  s.finalizeKillTimeout.String(),
				"cause":             cause,
				"stderr_tail":       stderrTail,
				"proc_status":       readProcStatus(pid),
			})
			s.log.Warn("claudebinary.finalize.kill-watchdog",
				"reason", "child did not exit within finalize timeout",
				"pid", pid, "cause", cause, "duration_ms", time.Since(spawnedAt).Milliseconds(),
			)
			_ = handles.Kill()
		})
		defer t.Stop()
	}

	if handles.Wait != nil {
		waitErr = handles.Wait()
	}

	// Retry on stale resume. Two triggers:
	//   1. Documented failure — stderr explicitly mentions the missing
	//      session id.
	//   2. Silent failure — --resume was passed and the binary produced
	//      zero result events (no output, no is_error). Some binary
	//      versions / auth states exit cleanly with empty stdout instead
	//      of the documented stderr message; without this branch the
	//      caller falls through to "success with empty text" and the FE
	//      sees no response and no error.
	hadResume := strings.TrimSpace(req.Spawn.ResumeSessionID) != ""
	silentExit := !result.IsError &&
		result.Text == "" &&
		stats.ResultEvents == 0
	knownStaleMsg := strings.Contains(stats.StderrText, "No conversation found with session ID")
	if (knownStaleMsg || (hadResume && silentExit)) &&
		retryCount < retryBudget(req) {
		trigger := "stderr-match"
		if !knownStaleMsg {
			trigger = "silent-exit"
		}
		s.log.Info("claudebinary.retry-stale-resume",
			"history_sid", hSID, "retry", retryCount+1, "trigger", trigger)
		s.resolver.Delete(hSID)
		req.Spawn.ResumeSessionID = ""
		return s.streamWithRetry(ctx, req, emit, retryCount+1)
	}

	// Retry once if the OS killed the child before it produced any output
	// (SIGKILL from the OOM killer on memory-constrained hosts). The session
	// id is kept — the conversation is intact, the binary just never ran.
	killedByOS := waitErr != nil && strings.Contains(waitErr.Error(), "signal: killed")
	if silentExit && killedByOS && retryCount < retryBudget(req) {
		s.log.Info("claudebinary.retry-killed",
			"history_sid", hSID, "retry", retryCount+1)
		return s.streamWithRetry(ctx, req, emit, retryCount+1)
	}

	// Surface silent failure as an error so the FE renders something
	// instead of a blank turn. Reaches here only when retry was either
	// disabled (budget exhausted) or already attempted without a resume
	// hint. Without this, the success fall-through below would emit a
	// bare _end chunk and the user would see no response and no message.
	if !result.IsError && result.Text == "" && stats.ResultEvents == 0 {
		if startupTimedOut.Load() {
			return nil, fmt.Errorf("claudebinary: startup stalled — no output within %s", StartupTimeout)
		}
		stderrTail := strings.TrimSpace(stats.StderrText)
		if len(stderrTail) > 200 {
			stderrTail = stderrTail[len(stderrTail)-200:]
		}
		detail := stderrTail
		if detail == "" && waitErr != nil {
			detail = waitErr.Error()
		}
		if detail == "" {
			detail = "no stream output"
		}
		return nil, fmt.Errorf("claudebinary: binary produced no result event: %s", detail)
	}

	// Error paths.
	if result.IsError {
		return nil, errors.New(result.ErrorMessage)
	}
	if ctxCancelled {
		// If the binary already emitted at least one result event before
		// the cancel, `result` holds the per-turn usage — return it so
		// cost telemetry isn't lost. The cancel is still surfaced as an
		// error to the caller. Without this, a client disconnecting
		// immediately after the SSE done chunk (the common case for
		// streaming turns) drops the entire turn's accounting.
		if stats.ResultEvents > 0 {
			return &FinalizePayload{
				Text:                result.Text,
				Cost:                result.Cost,
				StopReason:          result.StopReason,
				InputTokens:         result.InputTokens,
				OutputTokens:        result.OutputTokens,
				CacheCreationTokens: result.CacheCreationTokens,
				CacheReadTokens:     result.CacheReadTokens,
				ClaudeSessionID:     result.ClaudeSessionID,
			}, ctx.Err()
		}
		return nil, ctx.Err()
	}
	if processErr != nil && processErr != io.EOF && !errors.Is(processErr, context.Canceled) {
		return nil, fmt.Errorf("claudebinary: processStream: %w", processErr)
	}
	if result.Text == "" && waitErr != nil {
		stderrTail := stats.StderrText
		if len(stderrTail) > 200 {
			stderrTail = stderrTail[len(stderrTail)-200:]
		}
		return nil, fmt.Errorf("claudebinary: binary exited: %v (stderr: %s)", waitErr, strings.TrimSpace(stderrTail))
	}

	// Persist the binary's session id so the next /v1/stream call
	// resumes seamlessly.
	if result.ClaudeSessionID != "" {
		s.resolver.Set(hSID, result.ClaudeSessionID)
	}

	// Emit a final "done" chunk so the SSE writer flushes the
	// terminator. Mirrors the TS onDone hook semantics (consumer sees
	// {done:true}).
	emit(stream.Chunk{
		Type:       stream.ChunkTypeDone,
		Text:       result.Text,
		DoneReason: result.StopReason,
		Provider:   "claude-binary",
	})

	final := &FinalizePayload{
		Text:                result.Text,
		Cost:                result.Cost,
		StopReason:          result.StopReason,
		InputTokens:         result.InputTokens,
		OutputTokens:        result.OutputTokens,
		CacheCreationTokens: result.CacheCreationTokens,
		CacheReadTokens:     result.CacheReadTokens,
		ClaudeSessionID:     result.ClaudeSessionID,
	}
	_ = finalizeErr // reserved for future post-emit error surface
	return final, nil
}

func retryBudget(req Request) int {
	if req.MaxRetries <= 0 {
		return 1
	}
	return req.MaxRetries
}

// snapshotToPermDenials converts the map[toolName]rawDenial snapshot
// the event parser maintains into the typed stream.PermDenial slice the
// FE renders. The denial blob shape is the binary's own JSON — we read
// the operator-visible reason text + (when present) retry count, and
// fall back to a placeholder when neither is structured.
func snapshotToPermDenials(snapshot map[string]any) []stream.PermDenial {
	if len(snapshot) == 0 {
		return nil
	}
	out := make([]stream.PermDenial, 0, len(snapshot))
	for tool, raw := range snapshot {
		d := stream.PermDenial{Tool: tool}
		if obj, ok := raw.(map[string]any); ok {
			if reason, ok := obj["reason"].(string); ok && reason != "" {
				d.Reason = reason
			} else if text, ok := obj["text"].(string); ok && text != "" {
				d.Reason = text
			} else if msg, ok := obj["message"].(string); ok && msg != "" {
				d.Reason = msg
			}
			if c, ok := obj["count"].(float64); ok && c > 0 {
				d.Count = int(c)
			}
		} else if s, ok := raw.(string); ok && s != "" {
			d.Reason = s
		}
		if d.Count == 0 {
			d.Count = 1
		}
		out = append(out, d)
	}
	return out
}
