// Package hermes is the Go port of bridge/modules/multichat-partners/hermes.ts.
//
// Hermes is a long-lived Python subprocess shipped as `tui_gateway.entry`
// inside `~/.hermes/hermes-agent`. The Go side owns one singleton
// Gateway per daemon. The Gateway:
//
//   - Spawns and supervises the Python subprocess (auto-restarting on
//     unrequested exit after a 5s delay).
//   - Speaks JSON-RPC over the subprocess's stdin/stdout, routing
//     responses by integer id and emitting JSON-RPC notifications
//     (`{"method":"event","params":{...}}`) onto an internal event bus.
//   - Hands a per-(yhaSessionID, partnerID) Hermes session map to
//     callers via the SessionManager (session.go).
//   - Drives one chat turn end-to-end via SubmitPrompt (prompt.go).
//
// The Harness adapter (harness.go) wraps the Gateway in the
// harness.Harness contract so the participant-routed `/v1/stream-direct/`
// path can dispatch a Hermes-typed partner turn through Go.
//
// Wire shape (mirrors hermes.ts):
//
//	→ {"jsonrpc":"2.0","id":1,"method":"session.create","params":{}}
//	← {"jsonrpc":"2.0","id":1,"result":{"session_id":"abc"}}
//	→ {"jsonrpc":"2.0","id":2,"method":"prompt.submit",
//	   "params":{"session_id":"abc","text":"hi"}}
//	← {"jsonrpc":"2.0","id":2,"result":{}}
//	← {"jsonrpc":"2.0","method":"event",
//	   "params":{"type":"message.delta","session_id":"abc",
//	             "payload":{"text":"…"}}}
//	  …
//	← {"jsonrpc":"2.0","method":"event",
//	   "params":{"type":"message.complete","session_id":"abc",
//	             "payload":{"text":"…","status":"complete"}}}
//
// Auto-restart: the supervisor goroutine waits on the subprocess and,
// if Stop() wasn't called, sleeps 5s and re-spawns. Pending RPC waits
// are rejected with a transport-closed error so callers don't hang.
//
// Test seam: the gateway accepts a Transport interface (see transport.go
// concept; here inlined as the procIO struct) so unit tests drive an
// in-memory io.Pipe pair rather than spawning Python.
package hermes

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"

	"github.com/yha/core/internal/logger"
)

// ── Tuning constants (mirror hermes.ts) ────────────────────────────────────

const (
	// AutoRestartDelay mirrors hermes.ts:149 (5s).
	AutoRestartDelay = 5 * time.Second
	// EnsureRunningTimeout mirrors hermes.ts:232 (15s).
	EnsureRunningTimeout = 15 * time.Second
	// SessionCreateTimeout mirrors hermes.ts:263 (30s).
	SessionCreateTimeout = 30 * time.Second
	// SlashExecTimeout mirrors hermes.ts:277/304 (30s).
	SlashExecTimeout = 30 * time.Second
	// ImageAttachTimeout mirrors hermes.ts:381 (15s).
	ImageAttachTimeout = 15 * time.Second
	// PromptSubmitAckTimeout mirrors hermes.ts:451 (30s) — only the
	// short ack window; the actual turn waits on events.
	PromptSubmitAckTimeout = 30 * time.Second
	// DefaultRPCTimeout is the catch-all RPC budget.
	DefaultRPCTimeout = 60 * time.Second
	// ScannerBufferMax bumps bufio.Scanner from its 64 KiB default to
	// 1 MiB; Hermes can emit large tool-output frames on a single line.
	ScannerBufferMax = 1 * 1024 * 1024
)

// Logger is the minimal log surface the gateway uses.
type Logger interface {
	Info(msg string, fields ...any)
	Warn(msg string, fields ...any)
	Error(msg string, fields ...any)
	Debug(msg string, fields ...any)
}

// noopLogger is the fallback when the caller passes nil.
type noopLogger struct{}

func (noopLogger) Info(string, ...any)  {}
func (noopLogger) Warn(string, ...any)  {}
func (noopLogger) Error(string, ...any) {}
func (noopLogger) Debug(string, ...any) {}

// compile-time assertion: *logger.Logger satisfies Logger.
var _ Logger = (*logger.Logger)(nil)

// HermesEvent is one inbound notification from the Python subprocess.
// Type / SessionID / Payload mirror the JSON-RPC notification shape:
//
//	{"method":"event","params":{"type":"<t>","session_id":"<id>","payload":{…}}}
type HermesEvent struct {
	Type      string
	SessionID string
	Payload   map[string]any
}

// Transport is the abstract subprocess-IO seam the gateway talks to.
// Production wires a real exec.Cmd; tests wire io.Pipe pairs so the
// gateway can be exercised without spawning Python.
type Transport interface {
	// Start begins the underlying process / IO. Returns when stdin
	// and stdout are usable. Errors propagate from spawn / pipe set
	// up; the gateway calls Start once per supervised lifetime.
	Start(ctx context.Context) error
	// Stdin returns the writable handle the gateway dumps JSON-RPC
	// frames into. Closing the writer signals end-of-input to the
	// underlying process. Must be safe to call after Start returns.
	Stdin() io.Writer
	// Stdout returns the readable handle the gateway scans frames
	// from. The reader is closed implicitly when the underlying
	// process exits.
	Stdout() io.Reader
	// Wait blocks until the underlying process / transport exits.
	// Returns the exit error verbatim (nil = clean exit).
	Wait() error
	// Kill best-effort terminates the underlying process. Idempotent.
	Kill() error
}

// Gateway is the singleton wrapper around a Hermes subprocess.
// Construct via NewGateway or NewDefault. Lifetime: one instance per
// daemon. Safe for concurrent Subscribe / Send / Stop calls.
//
// Lifecycle:
//   - New: cheap; does not spawn.
//   - Start(ctx): spawns the subprocess and brings up the read /
//     supervisor goroutines. Subsequent Start calls are no-ops if
//     already running.
//   - Send: blocks on the response keyed by integer id (or the timeout).
//   - Subscribe(sessionID): returns a buffered <-chan HermesEvent
//     filtered to events for that session id. Caller must invoke the
//     returned cancel func to release the subscription.
//   - Stop: signals the supervisor to stop, kills the subprocess,
//     rejects pending RPCs, and disables auto-restart.
type Gateway struct {
	log Logger

	// Configuration. Resolved by Start; can be overridden by env
	// HERMES_HOME (see resolveDefaultPaths).
	pythonPath string
	moduleDir  string
	hermesHome string

	// transportFn is the seam tests use to inject an in-memory
	// transport. Production callers leave it nil; Start then builds
	// a real exec-backed transport via newExecTransport.
	transportFn func(ctx context.Context) (Transport, error)

	// mu guards everything below. RWMutex would suit Subscribe but we
	// keep the contention model simple — Subscribe / Send / event
	// dispatch all take the same Mutex.
	mu sync.Mutex

	transport      Transport
	stdin          io.Writer
	scanner        *bufio.Scanner
	reqID          uint64
	pending        map[uint64]*pendingRPC
	subs           map[uint64]*subscription
	nextSubID      uint64
	supervisorWg   sync.WaitGroup
	stopRequested  atomic.Bool
	running        atomic.Bool
	readyCh        chan struct{}
	currentRunDone chan struct{}
}

type pendingRPC struct {
	method string
	out    chan rpcResult
}

type rpcResult struct {
	Result json.RawMessage
	Err    error
}

type subscription struct {
	sessionID string
	ch        chan HermesEvent
}

// NewGateway builds a fresh, un-started Gateway pointing at the
// system-default Hermes install path. Override the install location by
// setting the HERMES_HOME env before calling. log may be nil.
//
// The returned Gateway is dormant — call Start (or rely on lazy-start
// inside SubmitPrompt via SessionManager) to bring up the subprocess.
func NewGateway(log Logger) *Gateway {
	if log == nil {
		log = noopLogger{}
	}
	g := &Gateway{
		log:     log,
		pending: map[uint64]*pendingRPC{},
		subs:    map[uint64]*subscription{},
	}
	g.applyDefaultPaths()
	return g
}

// newGatewayWithTransport is the test seam — used by gateway_test.go
// to wire an io.Pipe-backed transport directly so unit tests don't
// touch ~/.hermes or spawn Python.
func newGatewayWithTransport(log Logger, fn func(ctx context.Context) (Transport, error)) *Gateway {
	g := NewGateway(log)
	g.transportFn = fn
	return g
}

// applyDefaultPaths populates pythonPath / moduleDir / hermesHome from
// HOME (and HERMES_HOME if set). Mirrors hermes.ts:15-19.
func (g *Gateway) applyDefaultPaths() {
	home := os.Getenv("HOME")
	if home == "" {
		if hd, err := os.UserHomeDir(); err == nil {
			home = hd
		}
	}
	hermesHome := os.Getenv("HERMES_HOME")
	if hermesHome == "" {
		hermesHome = filepath.Join(home, ".hermes")
	}
	agentDir := filepath.Join(hermesHome, "hermes-agent")
	g.hermesHome = hermesHome
	g.pythonPath = filepath.Join(agentDir, "venv", "bin", "python")
	g.moduleDir = agentDir
}

// IsInstalled reports whether the Hermes Python install is present at
// the resolved path. Mirrors hermes.ts:46-54.
func (g *Gateway) IsInstalled() bool {
	if _, err := os.Stat(g.pythonPath); err != nil {
		return false
	}
	if _, err := os.Stat(filepath.Join(g.moduleDir, "tui_gateway", "entry.py")); err != nil {
		return false
	}
	return true
}

// IsRunning reports whether the supervisor has an active subprocess
// and the read loop is up.
func (g *Gateway) IsRunning() bool {
	return g.running.Load()
}

// Start brings the subprocess up. Idempotent: returns nil immediately
// when already running. Returns an error if the install is missing or
// the transport refuses to start. ctx caps the boot timeout.
func (g *Gateway) Start(ctx context.Context) error {
	if g.running.Load() {
		return nil
	}
	g.mu.Lock()
	if g.running.Load() {
		g.mu.Unlock()
		return nil
	}
	g.stopRequested.Store(false)

	transport, err := g.buildTransport(ctx)
	if err != nil {
		g.mu.Unlock()
		return err
	}
	if err := transport.Start(ctx); err != nil {
		g.mu.Unlock()
		return fmt.Errorf("hermes: transport start: %w", err)
	}
	g.transport = transport
	g.stdin = transport.Stdin()
	g.scanner = bufio.NewScanner(transport.Stdout())
	g.scanner.Buffer(make([]byte, 64*1024), ScannerBufferMax)
	g.scanner.Split(bufio.ScanLines)
	g.readyCh = make(chan struct{})
	g.currentRunDone = make(chan struct{})
	g.running.Store(true)

	// Mark ready (no handshake step on Hermes side — once stdin/stdout
	// are wired we can send). Close the readyCh so any waiter
	// proceeds; we keep it around for symmetry with the openclaw
	// connect handshake.
	close(g.readyCh)

	g.mu.Unlock()

	// Spin up the supervisor + reader goroutines.
	g.supervisorWg.Add(2)
	go g.readLoop()
	go g.waitLoop()

	g.log.Info("hermes.gateway-started",
		"python", g.pythonPath, "cwd", g.moduleDir)
	return nil
}

// Stop signals the supervisor to stop, rejects every pending RPC,
// kills the subprocess, and clears subscribers. Idempotent.
func (g *Gateway) Stop() error {
	g.stopRequested.Store(true)
	g.mu.Lock()
	transport := g.transport
	g.rejectAllPendingLocked(errors.New("hermes: gateway stopped"))
	g.subs = map[uint64]*subscription{}
	g.mu.Unlock()
	if transport != nil {
		_ = transport.Kill()
	}
	// Wait for goroutines to drain so callers can rely on Stop being
	// fully synchronous.
	g.supervisorWg.Wait()
	g.running.Store(false)
	return nil
}

// HermesHome returns the resolved install root (HERMES_HOME).
func (g *Gateway) HermesHome() string { return g.hermesHome }

// Subscribe returns a buffered channel that receives every event
// whose SessionID matches the argument. The cancel func removes the
// subscription; callers must invoke it (defer cancel()) to avoid
// leaking the channel.
//
// Events are dropped (best-effort) when the channel is full — the
// reader goroutine never blocks on slow subscribers. The buffer size
// (64) is generous enough that any sane consumer drains in time.
func (g *Gateway) Subscribe(sessionID string) (<-chan HermesEvent, func()) {
	g.mu.Lock()
	defer g.mu.Unlock()
	id := atomic.AddUint64(&g.nextSubID, 1)
	sub := &subscription{
		sessionID: sessionID,
		ch:        make(chan HermesEvent, 64),
	}
	g.subs[id] = sub
	cancel := func() {
		g.mu.Lock()
		if cur, ok := g.subs[id]; ok && cur == sub {
			delete(g.subs, id)
			close(sub.ch)
		}
		g.mu.Unlock()
	}
	return sub.ch, cancel
}

// Send issues a JSON-RPC request and blocks until the matching
// response arrives or the timeout fires. params may be nil; the
// gateway encodes {} in that case so the Python side gets a stable
// JSON shape.
//
// Send DOES NOT auto-start the subprocess — callers should call Start
// (or rely on EnsureRunning via SessionManager) first. Mirrors
// hermes.ts:205 — fast "not running" rejection.
func (g *Gateway) Send(ctx context.Context, method string, params any, timeout time.Duration) (json.RawMessage, error) {
	if !g.running.Load() {
		return nil, errors.New("hermes: gateway not running")
	}
	if timeout <= 0 {
		timeout = DefaultRPCTimeout
	}

	id := atomic.AddUint64(&g.reqID, 1)

	pend := &pendingRPC{method: method, out: make(chan rpcResult, 1)}
	g.mu.Lock()
	g.pending[id] = pend
	stdin := g.stdin
	g.mu.Unlock()

	if stdin == nil {
		g.mu.Lock()
		delete(g.pending, id)
		g.mu.Unlock()
		return nil, errors.New("hermes: gateway stdin not initialized")
	}

	// Encode params. The Node side sends {} when caller passes none;
	// we mirror that — drop nil into an empty object so the gateway
	// can rely on a present params field.
	rawParams, err := marshalParams(params)
	if err != nil {
		g.mu.Lock()
		delete(g.pending, id)
		g.mu.Unlock()
		return nil, fmt.Errorf("hermes: marshal params: %w", err)
	}

	frame, err := json.Marshal(rpcRequest{
		JSONRPC: "2.0",
		ID:      id,
		Method:  method,
		Params:  rawParams,
	})
	if err != nil {
		g.mu.Lock()
		delete(g.pending, id)
		g.mu.Unlock()
		return nil, fmt.Errorf("hermes: marshal frame: %w", err)
	}
	frame = append(frame, '\n')

	if _, err := stdin.Write(frame); err != nil {
		g.mu.Lock()
		delete(g.pending, id)
		g.mu.Unlock()
		return nil, fmt.Errorf("hermes: write stdin: %w", err)
	}

	select {
	case r := <-pend.out:
		return r.Result, r.Err
	case <-ctx.Done():
		g.mu.Lock()
		delete(g.pending, id)
		g.mu.Unlock()
		return nil, ctx.Err()
	case <-time.After(timeout):
		g.mu.Lock()
		delete(g.pending, id)
		g.mu.Unlock()
		return nil, fmt.Errorf("hermes: RPC timeout: %s", method)
	}
}

// EnsureRunning blocks until the gateway is up or the deadline
// expires. Mirrors hermes.ts:232. Callers that arrive while the
// supervisor is restarting use this so a fresh prompt isn't rejected
// in the brief gap between subprocess exit and re-spawn.
func (g *Gateway) EnsureRunning(ctx context.Context, timeout time.Duration) error {
	if g.running.Load() {
		return nil
	}
	if !g.IsInstalled() {
		return errors.New("hermes: not installed")
	}
	if !g.stopRequested.Load() {
		// Best-effort lazy start.
		if err := g.Start(ctx); err == nil {
			return nil
		}
	}
	if timeout <= 0 {
		timeout = EnsureRunningTimeout
	}
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if g.running.Load() {
			return nil
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	return errors.New("hermes: gateway did not become ready in time")
}

// ── Internals ──────────────────────────────────────────────────────────────

// buildTransport returns the io seam to talk to the subprocess. When
// transportFn is non-nil (tests) it delegates; otherwise it builds an
// exec-backed transport pointing at the resolved python module.
//
// Caller holds g.mu.
func (g *Gateway) buildTransport(ctx context.Context) (Transport, error) {
	if g.transportFn != nil {
		return g.transportFn(ctx)
	}
	if !g.IsInstalled() {
		return nil, errors.New("hermes: not installed")
	}
	return newExecTransport(g.pythonPath, g.moduleDir, g.hermesHome), nil
}

// readLoop scans one line at a time off the subprocess's stdout and
// dispatches each frame. Exits when the scanner returns false (EOF /
// closed pipe) or when the gateway is stopped.
func (g *Gateway) readLoop() {
	defer g.supervisorWg.Done()
	g.mu.Lock()
	sc := g.scanner
	g.mu.Unlock()
	if sc == nil {
		return
	}
	for sc.Scan() {
		line := sc.Bytes()
		if len(line) == 0 {
			continue
		}
		// Copy out of the scanner buffer before handing off — the
		// scanner reuses the underlying slice on the next call.
		buf := make([]byte, len(line))
		copy(buf, line)
		g.handleFrame(buf)
	}
	// EOF or scanner error. Reject pending so callers don't hang.
	g.mu.Lock()
	g.rejectAllPendingLocked(errors.New("hermes: subprocess output closed"))
	g.mu.Unlock()
}

// waitLoop waits on the subprocess and triggers auto-restart unless
// Stop was called. Mirrors hermes.ts:140-154.
func (g *Gateway) waitLoop() {
	defer g.supervisorWg.Done()
	g.mu.Lock()
	transport := g.transport
	runDone := g.currentRunDone
	g.mu.Unlock()
	if transport == nil {
		if runDone != nil {
			close(runDone)
		}
		return
	}
	err := transport.Wait()
	g.log.Info("hermes.gateway-exited", "err", err)
	g.mu.Lock()
	g.running.Store(false)
	g.rejectAllPendingLocked(fmt.Errorf("hermes: gateway exited: %v", err))
	g.transport = nil
	g.stdin = nil
	g.scanner = nil
	if runDone != nil {
		close(runDone)
	}
	g.mu.Unlock()

	if g.stopRequested.Load() {
		return
	}
	// Auto-restart after a delay. Mirrors hermes.ts:149.
	g.log.Info("hermes.gateway-auto-restart", "delayMs", AutoRestartDelay.Milliseconds())
	select {
	case <-time.After(AutoRestartDelay):
	}
	if g.stopRequested.Load() {
		return
	}
	if err := g.Start(context.Background()); err != nil {
		g.log.Warn("hermes.auto-restart-failed", "err", err)
	}
}

// handleFrame dispatches one inbound JSON frame.
//
// Lines that fail to parse as JSON are dropped silently — the Python
// side occasionally emits banner / debug lines that aren't JSON, and
// we don't want those tripping the read loop. (Mirrors hermes.ts:172.)
func (g *Gateway) handleFrame(raw []byte) {
	var env rpcEnvelope
	if err := json.Unmarshal(raw, &env); err != nil {
		g.log.Debug("hermes.parse-skip", "err", err, "raw", truncateForLog(raw))
		return
	}

	// JSON-RPC response (has id, result or error).
	if env.ID != nil {
		var id uint64
		switch v := (*env.ID).(type) {
		case float64:
			id = uint64(v)
		case string:
			// Node sends string ids; we keep them numeric on our
			// side but accept either form on the wire.
			if v == "" {
				return
			}
			var parsed uint64
			if _, perr := fmt.Sscanf(v, "%d", &parsed); perr != nil {
				return
			}
			id = parsed
		default:
			return
		}
		g.mu.Lock()
		p, ok := g.pending[id]
		if ok {
			delete(g.pending, id)
		}
		g.mu.Unlock()
		if !ok {
			return
		}
		if env.Error != nil {
			p.out <- rpcResult{Err: errors.New(env.Error.Message)}
			return
		}
		p.out <- rpcResult{Result: env.Result}
		return
	}

	// JSON-RPC notification: {method:"event", params:{type, session_id, payload}}
	if env.Method == "event" && len(env.Params) > 0 {
		var ev struct {
			Type      string         `json:"type"`
			SessionID string         `json:"session_id"`
			Payload   map[string]any `json:"payload"`
		}
		if err := json.Unmarshal(env.Params, &ev); err != nil {
			g.log.Debug("hermes.event-parse-skip", "err", err)
			return
		}
		evt := HermesEvent{Type: ev.Type, SessionID: ev.SessionID, Payload: ev.Payload}
		g.fanoutEvent(evt)
	}
}

// fanoutEvent delivers evt to every subscriber whose sessionID matches.
// Drops events when the subscriber's channel is full — never blocks
// the read loop.
func (g *Gateway) fanoutEvent(evt HermesEvent) {
	g.mu.Lock()
	// Snapshot subs so we can release the lock before sending.
	targets := make([]*subscription, 0, len(g.subs))
	for _, s := range g.subs {
		if s.sessionID == "" || s.sessionID == evt.SessionID {
			targets = append(targets, s)
		}
	}
	g.mu.Unlock()

	for _, s := range targets {
		select {
		case s.ch <- evt:
		default:
			g.log.Warn("hermes.event-drop", "sessionId", evt.SessionID, "type", evt.Type)
		}
	}
}

// rejectAllPendingLocked rejects every pending RPC with err. Caller
// holds g.mu.
func (g *Gateway) rejectAllPendingLocked(err error) {
	for id, p := range g.pending {
		select {
		case p.out <- rpcResult{Err: err}:
		default:
		}
		delete(g.pending, id)
	}
}

// PromptRespondTimeout caps each prompt-respond RPC. Mirrors the
// Node-side default in bridge/modules/partners/routes.ts:226 (10s).
const PromptRespondTimeout = 10 * time.Second

// RespondToPrompt dispatches the FE's answer back to Hermes for one
// of the four mid-turn prompt types (approval / clarify / sudo /
// secret). The RPC method is computed as "<promptType>.respond" and
// the params are forwarded verbatim — Hermes validates the shape.
//
// promptType must be one of: "approval", "clarify", "sudo", "secret".
// Any other value returns ErrUnknownPromptType so the route can return
// 400 to the FE.
//
// Used by partnersapi.HandlePromptRespond and the FE's blocking
// dialog flow: the harness broadcasts {hermesPrompt: …} into the SSE
// stream, the FE renders an approval/clarify dialog, the user clicks
// → POST /v1/partners/hermes/prompt-respond → here.
func (g *Gateway) RespondToPrompt(
	ctx context.Context,
	yhaSessionID, partnerID, promptType string,
	params map[string]any,
) (json.RawMessage, error) {
	switch promptType {
	case "approval", "clarify", "sudo", "secret":
		// ok
	default:
		return nil, fmt.Errorf("hermes: unknown prompt type %q", promptType)
	}
	if params == nil {
		params = map[string]any{}
	}
	// Hermes' RPC schema includes the routing keys alongside the
	// per-prompt-type payload so the gateway can address the
	// in-flight prompt request. yhaSessionID is the chat session
	// (i.e. the bridge sessions/<sid>.json id), partnerID is the
	// partner record id.
	params["yhaSessionId"] = yhaSessionID
	params["partnerId"] = partnerID
	return g.Send(ctx, promptType+".respond", params, PromptRespondTimeout)
}

// ── Wire shapes ────────────────────────────────────────────────────────────

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      uint64          `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params,omitempty"`
}

type rpcEnvelope struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      *any            `json:"id"`
	Method  string          `json:"method,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Result  json.RawMessage `json:"result,omitempty"`
	Error   *rpcError       `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func marshalParams(v any) (json.RawMessage, error) {
	if v == nil {
		return json.RawMessage("{}"), nil
	}
	if raw, ok := v.(json.RawMessage); ok {
		if len(raw) == 0 {
			return json.RawMessage("{}"), nil
		}
		return raw, nil
	}
	return json.Marshal(v)
}

func truncateForLog(b []byte) string {
	const max = 300
	if len(b) <= max {
		return string(b)
	}
	return string(b[:max]) + "…"
}

// ── Exec-backed transport (production wiring) ──────────────────────────────

// execTransport runs the real Python subprocess. Built only when no
// test transportFn is supplied.
type execTransport struct {
	python     string
	moduleDir  string
	hermesHome string

	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.ReadCloser
	stderr io.ReadCloser
}

func newExecTransport(python, moduleDir, hermesHome string) *execTransport {
	return &execTransport{python: python, moduleDir: moduleDir, hermesHome: hermesHome}
}

func (t *execTransport) Start(ctx context.Context) error {
	cmd := exec.CommandContext(ctx, t.python, "-m", "tui_gateway.entry")
	cmd.Dir = t.moduleDir
	cmd.Env = t.buildEnv()
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		return err
	}
	t.cmd = cmd
	t.stdin = stdin
	t.stdout = stdout
	t.stderr = stderr
	// Drain stderr so it doesn't fill its pipe; one goroutine per
	// transport instance.
	go func() {
		_, _ = io.Copy(io.Discard, stderr)
	}()
	return nil
}

func (t *execTransport) Stdin() io.Writer  { return t.stdin }
func (t *execTransport) Stdout() io.Reader { return t.stdout }

func (t *execTransport) Wait() error {
	if t.cmd == nil {
		return errors.New("hermes: transport not started")
	}
	return t.cmd.Wait()
}

func (t *execTransport) Kill() error {
	if t.cmd == nil || t.cmd.Process == nil {
		return nil
	}
	if t.stdin != nil {
		_ = t.stdin.Close()
	}
	_ = t.cmd.Process.Kill()
	return nil
}

// buildEnv composes the subprocess env. Mirrors hermes.ts:116-124:
// HERMES_HOME, PYTHONPATH, VIRTUAL_ENV, PATH (with venv bin prepended),
// TERMINAL_CWD.
func (t *execTransport) buildEnv() []string {
	base := os.Environ()
	overrides := map[string]string{
		"HERMES_HOME": t.hermesHome,
		"PYTHONPATH":  t.moduleDir,
		"VIRTUAL_ENV": filepath.Join(t.moduleDir, "venv"),
	}
	venvBin := filepath.Join(t.moduleDir, "venv", "bin")
	if existing := os.Getenv("PATH"); existing != "" {
		overrides["PATH"] = venvBin + string(os.PathListSeparator) + existing
	} else {
		overrides["PATH"] = venvBin
	}
	if termCWD := os.Getenv("TERMINAL_CWD"); termCWD != "" {
		overrides["TERMINAL_CWD"] = termCWD
	} else if cwd, err := os.Getwd(); err == nil {
		overrides["TERMINAL_CWD"] = cwd
	}

	out := make([]string, 0, len(base)+len(overrides))
	seen := make(map[string]bool, len(overrides))
	for _, kv := range base {
		eq := indexByte(kv, '=')
		if eq < 0 {
			out = append(out, kv)
			continue
		}
		key := kv[:eq]
		if v, ok := overrides[key]; ok {
			out = append(out, key+"="+v)
			seen[key] = true
			continue
		}
		out = append(out, kv)
	}
	for k, v := range overrides {
		if !seen[k] {
			out = append(out, k+"="+v)
		}
	}
	return out
}

// indexByte avoids dragging in "strings" for one call.
func indexByte(s string, b byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			return i
		}
	}
	return -1
}
