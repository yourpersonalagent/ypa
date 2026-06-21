package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"sync/atomic"
	"time"

	"github.com/yha/core/internal/logger"
)

// ── Public types ───────────────────────────────────────────────────────────

// ServerConfig matches the shape stored in mcp-registry.json.
type ServerConfig struct {
	Name    string
	Command string
	Args    []string
	Env     map[string]string
}

// Tool / Prompt / Resource describe what an MCP server exposes after
// the handshake. JSON tags match the wire format from initialize.
type Tool struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"inputSchema"`
}

type Prompt struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	Arguments   []map[string]any `json:"arguments"`
}

type Resource struct {
	URI         string `json:"uri"`
	Name        string `json:"name"`
	Description string `json:"description"`
	MIMEType    string `json:"mimeType"`
}

// Recorder is the minimal metrics surface used by Connection.Call to
// emit per-tool latency. *metrics.Collector satisfies this interface
// implicitly. nil is permitted everywhere — the call sites guard before
// invoking, so no-metrics deployments cost nothing.
type Recorder interface {
	IncCounter(name string, labels map[string]string)
	Observe(name string, labels map[string]string, value float64)
}

// Connection is the per-server state: subprocess, framed stdio reader,
// pending request map, plus what the server advertised at handshake.
type Connection struct {
	Name string

	cmd    *exec.Cmd       // nil when built from pipes (tests)
	stdin  io.WriteCloser
	stdout io.ReadCloser
	stderr io.ReadCloser

	sendMu sync.Mutex // serialises Write to stdin

	pendMu  sync.Mutex
	pending map[int]chan response

	nextID int64 // atomic

	infoMu    sync.RWMutex // protects Tools/Prompts/Resources/OK/Err
	Tools     []Tool
	Prompts   []Prompt
	Resources []Resource
	OK        bool
	Err       error

	log      *logger.Logger
	recorder Recorder
	done     chan struct{}
	closed   atomic.Bool
}

type response struct {
	Result json.RawMessage
	Err    *RPCError
}

// ── Pool ───────────────────────────────────────────────────────────────────

// Pool keeps every running MCP server keyed by name. The zero value is
// not useful — call NewPool with a logger.
type Pool struct {
	mu          sync.RWMutex
	connections map[string]*Connection
	log         *logger.Logger
	recorder    Recorder
}

// NewPool returns an empty pool. log may be nil to suppress per-server
// stderr noise; default-routed to a no-op in that case.
func NewPool(log *logger.Logger) *Pool {
	if log == nil {
		log = logger.New(io.Discard)
	}
	return &Pool{
		connections: map[string]*Connection{},
		log:         log,
	}
}

// SetRecorder attaches an optional metrics Recorder. Call before Start
// so freshly-spawned Connections inherit it. Existing connections are
// updated in place — this is safe because metrics emission is the only
// reader of the field and IncCounter/Observe are concurrency-safe on
// the production *metrics.Collector. Pass nil to disable metrics.
func (p *Pool) SetRecorder(r Recorder) {
	p.mu.Lock()
	p.recorder = r
	for _, c := range p.connections {
		c.recorder = r
	}
	p.mu.Unlock()
}

// Start spawns an MCP server and runs the initialize handshake. If the
// server is already running, the existing Connection is returned (mirrors
// the JS idempotent behaviour). handshakeTimeout caps the wait for the
// server to answer initialize + list calls.
func (p *Pool) Start(ctx context.Context, cfg ServerConfig, handshakeTimeout time.Duration) (*Connection, error) {
	if cfg.Name == "" {
		return nil, errors.New("mcp: ServerConfig.Name required")
	}
	p.mu.Lock()
	if existing, ok := p.connections[cfg.Name]; ok && existing.alive() {
		p.mu.Unlock()
		return existing, nil
	}
	p.mu.Unlock()

	conn, err := spawn(cfg, p.log)
	if err != nil {
		return nil, err
	}
	// Inherit the pool's recorder. SetRecorder may swap it later.
	p.mu.RLock()
	conn.recorder = p.recorder
	p.mu.RUnlock()

	hctx := ctx
	if handshakeTimeout > 0 {
		var cancel context.CancelFunc
		hctx, cancel = context.WithTimeout(ctx, handshakeTimeout)
		defer cancel()
	}
	if err := conn.Handshake(hctx); err != nil {
		// Keep the (likely-still-running) process registered with an
		// error state so callers can inspect it; mirrors JS behaviour
		// where conn.ok=false but the entry exists.
		conn.setErr(err)
	}

	p.mu.Lock()
	// Re-check under lock. The gap between the first Unlock (line ~142)
	// and here is unsynchronised, so a concurrent Start() for the same
	// name may have spawned and registered its own child while we were
	// handshaking. If a live connection now exists, discard ours —
	// otherwise we'd clobber the winner's map entry and leak our child
	// (it would never be reaped by Stop/StopAll). This is the documented
	// Start() TOCTOU; see GO-Ownership-Plan.md §5 step 2.
	if existing, ok := p.connections[cfg.Name]; ok && existing.alive() {
		p.mu.Unlock()
		_ = conn.Close()
		return existing, nil
	}
	p.connections[cfg.Name] = conn
	p.mu.Unlock()
	return conn, nil
}

// Get returns the Connection for a server, plus a found flag.
func (p *Pool) Get(name string) (*Connection, bool) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	c, ok := p.connections[name]
	return c, ok
}

// List returns a snapshot of every Connection.
func (p *Pool) List() []*Connection {
	p.mu.RLock()
	defer p.mu.RUnlock()
	out := make([]*Connection, 0, len(p.connections))
	for _, c := range p.connections {
		out = append(out, c)
	}
	return out
}

// Stop kills the named server and removes its Connection. Idempotent.
func (p *Pool) Stop(name string) error {
	p.mu.Lock()
	c, ok := p.connections[name]
	if !ok {
		p.mu.Unlock()
		return nil
	}
	delete(p.connections, name)
	p.mu.Unlock()
	return c.Close()
}

// StopAll kills every running server. Errors are logged but not
// returned individually.
func (p *Pool) StopAll() {
	p.mu.Lock()
	conns := make([]*Connection, 0, len(p.connections))
	for _, c := range p.connections {
		conns = append(conns, c)
	}
	p.connections = map[string]*Connection{}
	p.mu.Unlock()
	for _, c := range conns {
		_ = c.Close()
	}
}

// ── Connection methods ─────────────────────────────────────────────────────

// Send fires a JSON-RPC request without waiting for a response. Used
// for notifications; for request/response use Call.
func (c *Connection) Send(req Request) error {
	if c.closed.Load() {
		return errors.New("mcp: connection closed")
	}
	c.sendMu.Lock()
	defer c.sendMu.Unlock()
	return EncodeRequest(c.stdin, req)
}

// Call sends a request and waits for the matching response. Returns
// the raw result bytes; callers unmarshal into a typed shape.
//
// When a Recorder is attached, every completion records:
//
//   - mcp_call_count{server, tool, status}        status: ok|error|timeout
//   - mcp_call_latency_ms{server, tool}           always, on every return
//
// `tool` is the params.name field of a tools/call (so per-tool
// granularity), and the method verbatim for everything else
// (initialize, tools/list, prompts/list, resources/list, …).
func (c *Connection) Call(ctx context.Context, method string, params any) (json.RawMessage, error) {
	start := time.Now()
	toolLabel := mcpToolLabel(method, params)
	defer func() {
		// Latency is always recorded, regardless of the status path
		// taken below; we record the counter inline next to each
		// return so the status label is accurate.
		if c.recorder != nil {
			c.recorder.Observe("mcp_call_latency_ms",
				map[string]string{"server": c.Name, "tool": toolLabel},
				float64(time.Since(start).Microseconds())/1000.0)
		}
	}()

	emitCount := func(status string) {
		if c.recorder == nil {
			return
		}
		c.recorder.IncCounter("mcp_call_count", map[string]string{
			"server": c.Name,
			"tool":   toolLabel,
			"status": status,
		})
	}

	if c.closed.Load() {
		emitCount("error")
		return nil, errors.New("mcp: connection closed")
	}
	id := int(atomic.AddInt64(&c.nextID, 1))
	ch := make(chan response, 1)
	c.pendMu.Lock()
	c.pending[id] = ch
	c.pendMu.Unlock()

	req := Request{JSONRPC: "2.0", ID: id, Method: method, Params: params}
	if err := c.Send(req); err != nil {
		c.pendMu.Lock()
		delete(c.pending, id)
		c.pendMu.Unlock()
		emitCount("error")
		return nil, err
	}
	select {
	case r := <-ch:
		if r.Err != nil {
			emitCount("error")
			return nil, r.Err
		}
		emitCount("ok")
		return r.Result, nil
	case <-ctx.Done():
		c.pendMu.Lock()
		delete(c.pending, id)
		c.pendMu.Unlock()
		emitCount("timeout")
		return nil, ctx.Err()
	}
}

// mcpToolLabel returns the value used for the "tool" label on
// mcp_call_*. For "tools/call", we look at params.name so the metric
// surfaces the actual tool that was invoked. For every other method
// (initialize, tools/list, prompts/list, resources/list, …) the
// method name is used verbatim.
func mcpToolLabel(method string, params any) string {
	if method != "tools/call" {
		return method
	}
	if m, ok := params.(map[string]any); ok {
		if name, ok := m["name"].(string); ok && name != "" {
			return name
		}
	}
	return method
}

// Handshake performs the four-call MCP startup sequence: initialize,
// tools/list, prompts/list, resources/list. The latter three are
// optional — servers that don't implement them produce a -32601 error
// which is logged but not fatal.
func (c *Connection) Handshake(ctx context.Context) error {
	initParams := map[string]any{
		"protocolVersion": "2024-11-05",
		"capabilities":    map[string]any{},
		"clientInfo":      map[string]string{"name": "yha-core", "version": "1.0"},
	}
	if _, err := c.Call(ctx, "initialize", initParams); err != nil {
		return fmt.Errorf("initialize: %w", err)
	}
	if raw, err := c.Call(ctx, "tools/list", map[string]any{}); err == nil {
		var r struct {
			Tools []Tool `json:"tools"`
		}
		_ = json.Unmarshal(raw, &r)
		c.infoMu.Lock()
		c.Tools = r.Tools
		c.infoMu.Unlock()
	}
	if raw, err := c.Call(ctx, "prompts/list", map[string]any{}); err == nil {
		var r struct {
			Prompts []Prompt `json:"prompts"`
		}
		_ = json.Unmarshal(raw, &r)
		c.infoMu.Lock()
		c.Prompts = r.Prompts
		c.infoMu.Unlock()
	}
	if raw, err := c.Call(ctx, "resources/list", map[string]any{}); err == nil {
		var r struct {
			Resources []Resource `json:"resources"`
		}
		_ = json.Unmarshal(raw, &r)
		c.infoMu.Lock()
		c.Resources = r.Resources
		c.infoMu.Unlock()
	}
	exposesAny := len(c.snapshotTools()) + len(c.snapshotPrompts()) + len(c.snapshotResources())
	c.infoMu.Lock()
	c.OK = exposesAny > 0
	if !c.OK {
		c.Err = errors.New("mcp: server exposes no tools/prompts/resources")
	}
	c.infoMu.Unlock()
	return nil
}

// CallTool is shorthand for Call(ctx, "tools/call", {name, arguments}).
// Returns the result map. The MCP spec wraps tool output in {content:
// [{type: "text", text: "..."}]} which callers can inspect themselves.
func (c *Connection) CallTool(ctx context.Context, toolName string, args map[string]any) (map[string]any, error) {
	if args == nil {
		args = map[string]any{}
	}
	raw, err := c.Call(ctx, "tools/call", map[string]any{
		"name":      toolName,
		"arguments": args,
	})
	if err != nil {
		return nil, err
	}
	var out map[string]any
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("mcp: parse tools/call result: %w", err)
	}
	return out, nil
}

// Close terminates the subprocess (if any) and rejects all pending
// calls. Safe to call multiple times.
func (c *Connection) Close() error {
	if !c.closed.CompareAndSwap(false, true) {
		return nil
	}
	if c.cmd != nil && c.cmd.Process != nil {
		// Kill the entire process group so child-of-child shells (if
		// any) go down with the parent. No-op on Windows (single proc).
		_ = killMCPProcessGroup(c.cmd)
		_ = c.cmd.Process.Kill()
	}
	if c.stdin != nil {
		_ = c.stdin.Close()
	}
	if c.stdout != nil {
		_ = c.stdout.Close()
	}
	if c.stderr != nil {
		_ = c.stderr.Close()
	}
	c.failAllPending(errors.New("mcp: connection closed"))
	if c.cmd != nil {
		// Reap to avoid zombies. Wait blocks; ignore error.
		_ = c.cmd.Wait()
	}
	return nil
}

// alive reports whether the underlying process is still running. Pure
// reads via os/exec.Cmd state.
func (c *Connection) alive() bool {
	if c.closed.Load() {
		return false
	}
	if c.cmd == nil {
		return true // pipe-based test connection
	}
	if c.cmd.ProcessState != nil {
		return false
	}
	return c.cmd.Process != nil
}

func (c *Connection) snapshotTools() []Tool {
	c.infoMu.RLock()
	defer c.infoMu.RUnlock()
	out := make([]Tool, len(c.Tools))
	copy(out, c.Tools)
	return out
}

func (c *Connection) snapshotPrompts() []Prompt {
	c.infoMu.RLock()
	defer c.infoMu.RUnlock()
	out := make([]Prompt, len(c.Prompts))
	copy(out, c.Prompts)
	return out
}

func (c *Connection) snapshotResources() []Resource {
	c.infoMu.RLock()
	defer c.infoMu.RUnlock()
	out := make([]Resource, len(c.Resources))
	copy(out, c.Resources)
	return out
}

func (c *Connection) setErr(err error) {
	c.infoMu.Lock()
	c.Err = err
	c.OK = false
	c.infoMu.Unlock()
}

func (c *Connection) failAllPending(err error) {
	c.pendMu.Lock()
	chans := make([]chan response, 0, len(c.pending))
	for id, ch := range c.pending {
		chans = append(chans, ch)
		delete(c.pending, id)
		_ = ch
	}
	c.pendMu.Unlock()
	for _, ch := range chans {
		select {
		case ch <- response{Err: &RPCError{Code: -1, Message: err.Error()}}:
		default:
		}
	}
}

// ── Spawn (private) ────────────────────────────────────────────────────────

func spawn(cfg ServerConfig, log *logger.Logger) (*Connection, error) {
	cmd := exec.Command(cfg.Command, cfg.Args...)
	// Group leadership lets Close kill the whole tree via -pid on
	// unix; no-op on Windows.
	setMCPProcAttr(cmd)
	// Third-party MCP servers must not inherit the bridge's shared secret. Only
	// first-party scripts under bridge/mcp/ keep the full env; everything else
	// gets YHA_BRIDGE_KEY / BRIDGE_INTERNAL_KEY stripped so a malicious server
	// can't authenticate against /internal or /proxy.
	env := mergeEnv(cfg.Env)
	if !firstPartyMCP(cfg.Args) {
		env = filterBridgeSecrets(env)
	}
	cmd.Env = env

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("mcp: stdin pipe: %w", err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, fmt.Errorf("mcp: stdout pipe: %w", err)
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, fmt.Errorf("mcp: stderr pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("mcp: start %q: %w", cfg.Command, err)
	}

	c := newConnection(cfg.Name, stdin, stdout, stderr, log)
	c.cmd = cmd
	go c.readLoop()
	go c.drainStderr()
	return c, nil
}

// newConnection builds a Connection around already-open pipes. Tests
// use this directly with io.Pipe to avoid spawning a real subprocess.
func newConnection(name string, stdin io.WriteCloser, stdout, stderr io.ReadCloser, log *logger.Logger) *Connection {
	return &Connection{
		Name:    name,
		stdin:   stdin,
		stdout:  stdout,
		stderr:  stderr,
		pending: map[int]chan response{},
		nextID:  10, // start above the handshake range (1–4) so test fixtures with hand-crafted IDs don't collide
		log:     log,
		done:    make(chan struct{}),
	}
}

func (c *Connection) readLoop() {
	defer close(c.done)
	r := NewReader(c.stdout)
	for {
		body, err := r.ReadFrame()
		if err != nil {
			if !errors.Is(err, io.EOF) {
				c.log.Warn("mcp.read", "name", c.Name, "err", err)
			}
			c.failAllPending(fmt.Errorf("read loop: %w", err))
			return
		}
		var resp Response
		if err := json.Unmarshal(body, &resp); err != nil {
			c.log.Warn("mcp.parse", "name", c.Name, "err", err)
			continue
		}
		c.pendMu.Lock()
		ch, ok := c.pending[resp.ID]
		if ok {
			delete(c.pending, resp.ID)
		}
		c.pendMu.Unlock()
		if !ok {
			continue // unsolicited (notification or post-timeout response)
		}
		select {
		case ch <- response{Result: resp.Result, Err: resp.Error}:
		default:
		}
	}
}

func (c *Connection) drainStderr() {
	if c.stderr == nil {
		return
	}
	r := bufioReader(c.stderr)
	for {
		line, err := r.ReadString('\n')
		if line != "" {
			c.log.Warn("mcp.stderr", "name", c.Name, "text", trimRightNewline(line))
		}
		if err != nil {
			return
		}
	}
}

// ── helpers ─────────────────────────────────────────────────────────────────

func mergeEnv(extra map[string]string) []string {
	// We can't import os here without pulling in a circular thing; we
	// just need os.Environ. Done at the call site in pool.go via the
	// package-level helper.
	base := osEnviron()
	if len(extra) == 0 {
		return base
	}
	out := make([]string, 0, len(base)+len(extra))
	out = append(out, base...)
	for k, v := range extra {
		out = append(out, k+"="+v)
	}
	return out
}
