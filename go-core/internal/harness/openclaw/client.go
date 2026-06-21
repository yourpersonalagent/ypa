// Package openclaw is the Go port of bridge/modules/multichat-partners/openclaw.ts.
//
// OpenClaw is a remote partner-agent gateway speaking WebSocket-RPC v3
// (connect.challenge → connect → sessions.create → chat.send). One Client
// per configured partner record; the Pool keeps a map[partnerID]*Client.
// The harness.Harness implementation (harness.go) drives a per-request
// turn against whichever client the pool resolves.
//
// Wire shape (mirrors openclaw.ts):
//
//   server → {type:"event", event:"connect.challenge"}
//   client → {type:"req", id:"0", method:"connect",
//             params:{role:"operator", token:"…"}}
//   server → {type:"res", id:"0", ok:true, payload:{proto:"v3"}}
//   client → {type:"req", id:"1", method:"sessions.create",
//             params:{agentId:"main"}}
//   server → {type:"res", id:"1", ok:true, payload:{sessionKey:"…"}}
//   client → {type:"req", id:"2", method:"chat.send",
//             params:{sessionKey:"…", text:"…"}}
//   server → {type:"event", event:"session.message",
//             payload:{sessionKey:"…", delta:"…"}}
//   …
//   server → {type:"event", event:"session.message",
//             payload:{sessionKey:"…", final:true, text:"…"}}
//
// Reconnect: on transport error the client schedules a reconnect after
// 5 s (with exponential cap at 60 s) and re-runs the connect handshake.
// Pending RPC responses are rejected — callers retry at a higher level.
package openclaw

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/yha/core/internal/logger"
	"github.com/yha/core/internal/stream"
)

// ── Tuning constants (mirror openclaw.ts) ───────────────────────────────────

const (
	// HandshakeTimeout matches openclaw.ts:65 (10s).
	HandshakeTimeout = 10 * time.Second
	// RPCTimeout matches openclaw.ts:168 default (30s).
	RPCTimeout = 30 * time.Second
	// CreateSessionTimeout matches openclaw.ts:223 (20s).
	CreateSessionTimeout = 20 * time.Second
	// DefaultIdleTimeout matches openclaw.ts:259 (5 min).
	DefaultIdleTimeout = 5 * time.Minute
	// DefaultTotalTimeout matches openclaw.ts:260 (30 min).
	DefaultTotalTimeout = 30 * time.Minute
	// PingInterval keeps the WS alive (no direct TS analogue; ws auto-pings).
	PingInterval = 30 * time.Second
	// ReconnectBaseDelay matches openclaw.ts:92 (5s).
	ReconnectBaseDelay = 5 * time.Second
	// ReconnectMaxDelay caps the exponential backoff.
	ReconnectMaxDelay = 60 * time.Second
)

// Logger is the minimal log surface this package uses. *logger.Logger
// satisfies it; tests can substitute a no-op.
type Logger interface {
	Info(msg string, fields ...any)
	Warn(msg string, fields ...any)
	Error(msg string, fields ...any)
	Debug(msg string, fields ...any)
}

// EmitFn mirrors harness.Emit but lives here so the client package
// doesn't need to import the (yet-scaffolding) harness package directly.
// harness.go's Harness.Stream call-site bridges harness.Emit → EmitFn.
type EmitFn func(stream.Chunk)

// ── On-the-wire message shapes ─────────────────────────────────────────────

// wireMessage is the envelope used for both inbound and outbound frames.
// Type is "req" / "res" / "event"; other fields are populated per role.
type wireMessage struct {
	Type    string          `json:"type"`
	ID      string          `json:"id,omitempty"`
	Method  string          `json:"method,omitempty"`
	Event   string          `json:"event,omitempty"`
	OK      *bool           `json:"ok,omitempty"`
	Params  json.RawMessage `json:"params,omitempty"`
	Payload json.RawMessage `json:"payload,omitempty"`
	Error   *wireError      `json:"error,omitempty"`
}

type wireError struct {
	Message string `json:"message"`
	Code    string `json:"code,omitempty"`
}

// ── Client ─────────────────────────────────────────────────────────────────

// pending tracks an in-flight RPC awaiting its response frame.
type pending struct {
	method string
	out    chan rpcResult
}

type rpcResult struct {
	Payload json.RawMessage
	Err     error
}

// Client is one WS connection to an OpenClaw gateway. Safe for concurrent
// Send / Subscribe calls. Built by Pool.Get; callers should not new()
// directly except in tests.
//
// Lifecycle:
//   - New: cheap; does not dial.
//   - Connect: starts the dial + handshake. Returns when ws.OPEN and the
//     server has acked `connect`. Subsequent Connect calls are no-ops.
//   - Send: blocks on the response or until the WS dies. RPC timeout
//     defaults to RPCTimeout.
//   - Subscribe(sid, emit): registers an emit closure for every
//     server event whose payload.sessionKey == sid.
//   - Disconnect: cancels the run-loop, closes the ws, rejects all
//     pending. Idempotent.
type Client struct {
	host    string
	port    int
	token   string
	agentID string
	log     Logger

	// run-loop coordination
	mu       sync.Mutex
	ws       *websocket.Conn
	ctx      context.Context
	cancel   context.CancelFunc
	sendCh   chan []byte
	pending  map[string]*pending
	subs     map[string]EmitFn // sessionKey → emit
	authOK   bool
	stopping bool

	// connect waiters: callers blocked on Connect
	connectWaiters []*connectWaiter

	// reqIDCounter monotonic; starts at 1 (id="0" is reserved for connect).
	reqIDCounter uint64

	// reconnectDelay backs off from ReconnectBaseDelay → ReconnectMaxDelay.
	reconnectDelay time.Duration

	// dialer is the WS dialer; tests can override.
	dialer *websocket.Dialer

	// timeNow is the clock injection seam for deterministic tests.
	timeNow func() time.Time

	// closed is set on Disconnect so background reconnects don't fire.
	closed atomic.Bool
}

type connectWaiter struct {
	done chan error
}

// New builds a client. Does not dial. URL pieces are stored verbatim;
// the dial happens on Connect.
//
// log may be nil — replaced with a no-op writer at the boundary.
func New(host string, port int, token, agentID string, log Logger) *Client {
	if log == nil {
		log = noopLogger{}
	}
	if agentID == "" {
		agentID = "main"
	}
	if port == 0 {
		port = 18789
	}
	return &Client{
		host:           host,
		port:           port,
		token:          token,
		agentID:        agentID,
		log:            log,
		pending:        map[string]*pending{},
		subs:           map[string]EmitFn{},
		dialer:         &websocket.Dialer{HandshakeTimeout: HandshakeTimeout},
		timeNow:        time.Now,
		reconnectDelay: ReconnectBaseDelay,
	}
}

// Host, Port, AgentID, Token are read-only accessors for the pool's
// "same-config?" check (mirrors openclaw.ts:367).
func (c *Client) Host() string    { return c.host }
func (c *Client) Port() int       { return c.port }
func (c *Client) Token() string   { return c.token }
func (c *Client) AgentID() string { return c.agentID }

// IsConnected reports whether the WS is open AND the handshake succeeded.
// Mirrors openclaw.ts:41-43.
func (c *Client) IsConnected() bool {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.authOK && c.ws != nil
}

// Connect dials the gateway, runs the connect.challenge → connect
// handshake, and returns when the server acks. Subsequent calls are
// no-ops if already connected. ctx caps the dial+handshake wait.
//
// If ctx fires before the handshake completes, Connect returns
// ctx.Err() but leaves the (still-dialling) run-loop in place — the
// next IsConnected/Send call will resolve naturally as the handshake
// either succeeds or the connection drops.
func (c *Client) Connect(ctx context.Context) error {
	c.mu.Lock()
	if c.closed.Load() {
		c.mu.Unlock()
		return errors.New("openclaw: client closed")
	}
	if c.authOK && c.ws != nil {
		c.mu.Unlock()
		return nil
	}
	// Already dialling? Queue a waiter.
	w := &connectWaiter{done: make(chan error, 1)}
	c.connectWaiters = append(c.connectWaiters, w)
	needBoot := c.ws == nil && c.ctx == nil
	c.mu.Unlock()

	if needBoot {
		c.bootRunloop()
	}

	select {
	case err := <-w.done:
		return err
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Disconnect cancels the run-loop, closes the ws, rejects pending RPCs,
// and clears subscribers. Idempotent.
func (c *Client) Disconnect() {
	if !c.closed.CompareAndSwap(false, true) {
		return
	}
	c.mu.Lock()
	c.stopping = true
	cancel := c.cancel
	ws := c.ws
	c.ws = nil
	c.authOK = false
	c.rejectAllPendingLocked(errors.New("openclaw: client disconnected"))
	c.flushWaitersLocked(errors.New("openclaw: client disconnected"))
	c.subs = map[string]EmitFn{}
	c.mu.Unlock()

	if cancel != nil {
		cancel()
	}
	if ws != nil {
		_ = ws.Close()
	}
}

// Subscribe registers an emit closure for server events whose payload's
// sessionKey matches the given sid. There is one subscriber per sid —
// later Subscribes replace earlier ones.
//
// Unsubscribe(sid) removes it.
func (c *Client) Subscribe(sid string, emit EmitFn) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.subs[sid] = emit
}

// Unsubscribe drops the emit closure for sid. Safe to call when the
// subscription doesn't exist.
func (c *Client) Unsubscribe(sid string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.subs, sid)
}

// Send writes an RPC request to the server and blocks until the response
// frame arrives (or the WS dies, or the timeout fires). Returns the raw
// payload bytes; callers json.Unmarshal into their own shape.
//
// Send DOES NOT auto-Connect — callers should call Connect first. The
// rationale matches openclaw.ts:170: callers want a fast "not connected"
// error when the gateway is unreachable, not a hidden multi-second dial.
func (c *Client) Send(ctx context.Context, method string, params any) (json.RawMessage, error) {
	return c.SendWithTimeout(ctx, method, params, RPCTimeout)
}

// SendWithTimeout is Send with a per-call override of the timeout.
func (c *Client) SendWithTimeout(ctx context.Context, method string, params any, timeout time.Duration) (json.RawMessage, error) {
	c.mu.Lock()
	if !c.authOK || c.ws == nil {
		c.mu.Unlock()
		return nil, errors.New("openclaw: not connected")
	}
	id := strconv.FormatUint(atomic.AddUint64(&c.reqIDCounter, 1), 10)
	pend := &pending{method: method, out: make(chan rpcResult, 1)}
	c.pending[id] = pend
	c.mu.Unlock()

	body, err := json.Marshal(wireMessage{
		Type:   "req",
		ID:     id,
		Method: method,
		Params: marshalParams(params),
	})
	if err != nil {
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, fmt.Errorf("openclaw: marshal params: %w", err)
	}

	select {
	case c.sendCh <- body:
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, ctx.Err()
	}

	select {
	case r := <-pend.out:
		return r.Payload, r.Err
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, ctx.Err()
	case <-time.After(timeout):
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return nil, fmt.Errorf("openclaw: RPC timeout: %s", method)
	}
}

// ── Internals ──────────────────────────────────────────────────────────────

// bootRunloop kicks off the dial + read/write/ping goroutines. Returns
// immediately; the handshake completes (or fails) on the goroutines and
// flushes connectWaiters from there.
func (c *Client) bootRunloop() {
	c.mu.Lock()
	if c.ctx != nil {
		// Already running.
		c.mu.Unlock()
		return
	}
	rctx, cancel := context.WithCancel(context.Background())
	c.ctx = rctx
	c.cancel = cancel
	c.sendCh = make(chan []byte, 32)
	c.mu.Unlock()

	go c.runLoop(rctx)
}

// runLoop dials, runs the handshake, drives read/write/ping goroutines,
// then either returns (Disconnect) or schedules a reconnect after a delay.
func (c *Client) runLoop(ctx context.Context) {
	for {
		if ctx.Err() != nil || c.closed.Load() {
			return
		}
		if err := c.dialAndServe(ctx); err != nil {
			c.log.Warn("openclaw.ws-error", "host", c.host, "err", err)
		}
		// Don't reconnect if Disconnect was called.
		if c.closed.Load() || ctx.Err() != nil {
			return
		}
		// Backoff. Cleared on successful handshake.
		delay := c.reconnectDelay
		c.log.Info("openclaw.ws-reconnect-scheduled", "host", c.host, "delay", delay.String())
		select {
		case <-time.After(delay):
		case <-ctx.Done():
			return
		}
		if c.reconnectDelay*2 <= ReconnectMaxDelay {
			c.reconnectDelay *= 2
		} else {
			c.reconnectDelay = ReconnectMaxDelay
		}
	}
}

func (c *Client) dialAndServe(ctx context.Context) error {
	u := url.URL{Scheme: "ws", Host: net_JoinHostPort(c.host, c.port)}
	hdr := http.Header{}
	if c.token != "" {
		hdr.Set("Authorization", "Bearer "+c.token)
	}

	dialCtx, cancel := context.WithTimeout(ctx, HandshakeTimeout)
	defer cancel()
	ws, _, err := c.dialer.DialContext(dialCtx, u.String(), hdr)
	if err != nil {
		c.mu.Lock()
		c.flushWaitersLocked(fmt.Errorf("openclaw: dial: %w", err))
		c.mu.Unlock()
		return fmt.Errorf("dial %s: %w", u.String(), err)
	}

	c.mu.Lock()
	c.ws = ws
	c.authOK = false
	c.mu.Unlock()
	c.log.Info("openclaw.ws-open", "host", c.host, "port", c.port, "agentId", c.agentID)

	// Wrap subordinate goroutines in a context that's cancelled when
	// any of them exit so the others wind down cleanly.
	loopCtx, loopCancel := context.WithCancel(ctx)
	defer loopCancel()

	readErr := make(chan error, 1)
	go func() { readErr <- c.readLoop(loopCtx, ws) }()

	writeErr := make(chan error, 1)
	go func() { writeErr <- c.writeLoop(loopCtx, ws) }()

	pingErr := make(chan error, 1)
	go func() { pingErr <- c.pingLoop(loopCtx, ws) }()

	// Wait for the first goroutine to return.
	var firstErr error
	select {
	case firstErr = <-readErr:
	case firstErr = <-writeErr:
	case firstErr = <-pingErr:
	case <-loopCtx.Done():
		firstErr = loopCtx.Err()
	}
	loopCancel()
	_ = ws.Close()

	c.mu.Lock()
	wasAuthed := c.authOK
	c.authOK = false
	c.ws = nil
	c.rejectAllPendingLocked(fmt.Errorf("openclaw: ws closed (%v)", firstErr))
	if !wasAuthed {
		c.flushWaitersLocked(fmt.Errorf("openclaw: ws closed before auth: %v", firstErr))
	}
	c.mu.Unlock()
	c.log.Info("openclaw.ws-closed", "host", c.host, "wasAuthed", wasAuthed)

	// Drain the other two so they don't leak.
	<-readErr
	<-writeErr
	<-pingErr
	return firstErr
}

func (c *Client) readLoop(ctx context.Context, ws *websocket.Conn) error {
	for {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		_, raw, err := ws.ReadMessage()
		if err != nil {
			return err
		}
		c.handleFrame(raw)
	}
}

func (c *Client) writeLoop(ctx context.Context, ws *websocket.Conn) error {
	// Drive an initial connect.challenge response WHEN the server sends
	// its challenge — but we send our auth proactively too in case the
	// server happens to skip the challenge frame (matches openclaw.ts:
	// the explicit response is wired through handleFrame, so writeLoop
	// only drains sendCh).
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case msg, ok := <-c.sendCh:
			if !ok {
				return errors.New("openclaw: sendCh closed")
			}
			if err := ws.WriteMessage(websocket.TextMessage, msg); err != nil {
				return err
			}
		}
	}
}

func (c *Client) pingLoop(ctx context.Context, ws *websocket.Conn) error {
	t := time.NewTicker(PingInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-t.C:
			_ = ws.SetWriteDeadline(time.Now().Add(5 * time.Second))
			if err := ws.WriteMessage(websocket.PingMessage, nil); err != nil {
				return err
			}
		}
	}
}

// handleFrame parses one inbound WS message and dispatches it:
//   - connect.challenge event → send our connect request (id="0")
//   - response to id="0" → mark authed + flush connect waiters
//   - response to any other id → resolve pending
//   - other events → fanout to subscribers whose sessionKey matches
//
// Errors during parse are logged and silently dropped (mirrors
// openclaw.ts:118).
func (c *Client) handleFrame(raw []byte) {
	var msg wireMessage
	if err := json.Unmarshal(raw, &msg); err != nil {
		c.log.Debug("openclaw.ws-parse", "err", err, "raw", string(raw))
		return
	}
	switch {
	case msg.Type == "event" && msg.Event == "connect.challenge":
		// openclaw.ts:121-128: respond with role=operator + token.
		params := map[string]any{"role": "operator", "token": c.token}
		body, _ := json.Marshal(wireMessage{
			Type: "req", ID: "0", Method: "connect",
			Params: marshalParams(params),
		})
		select {
		case c.sendCh <- body:
		default:
			c.log.Warn("openclaw.ws-challenge-send-blocked")
		}
	case msg.Type == "res" && msg.ID == "0":
		// Auth result. ok=true → flushWaiters(); ok=false → flush with error.
		c.mu.Lock()
		var err error
		if msg.OK == nil || !*msg.OK {
			detail := "rejected"
			if msg.Error != nil && msg.Error.Message != "" {
				detail = msg.Error.Message
			}
			err = fmt.Errorf("openclaw: auth failed: %s", detail)
			c.log.Warn("openclaw.ws-auth-failed", "host", c.host, "err", detail)
		} else {
			c.authOK = true
			c.reconnectDelay = ReconnectBaseDelay
			c.log.Info("openclaw.ws-authed", "host", c.host)
		}
		c.flushWaitersLocked(err)
		c.mu.Unlock()
	case msg.Type == "res" && msg.ID != "":
		c.mu.Lock()
		p, ok := c.pending[msg.ID]
		if ok {
			delete(c.pending, msg.ID)
		}
		c.mu.Unlock()
		if !ok {
			return
		}
		if msg.OK != nil && !*msg.OK {
			detail := "RPC error"
			if msg.Error != nil && msg.Error.Message != "" {
				detail = msg.Error.Message
			}
			p.out <- rpcResult{Err: errors.New(detail)}
		} else {
			p.out <- rpcResult{Payload: msg.Payload}
		}
	case msg.Type == "event":
		// Fan out to subscribers whose sessionKey matches the payload's.
		var pl struct {
			SessionKey string `json:"sessionKey"`
		}
		_ = json.Unmarshal(msg.Payload, &pl)
		c.mu.Lock()
		emit, ok := c.subs[pl.SessionKey]
		c.mu.Unlock()
		if !ok || emit == nil {
			return
		}
		c.dispatchEventToEmit(msg, emit)
	}
}

// dispatchEventToEmit translates an OpenClaw server-push event into
// stream.Chunk(s). Currently maps:
//
//   - session.message with payload.delta → ChunkTypeDelta
//   - session.message with payload.final → ChunkTypeDone (Text=payload.text)
//   - session.error → ChunkTypeError
//
// The harness.go Stream() loop reads the same events directly off
// Subscribe (it needs more than just the chunk — it needs to know when
// to return) so this method is the fallback for callers that just want
// chunk fanout.
func (c *Client) dispatchEventToEmit(msg wireMessage, emit EmitFn) {
	var pl map[string]any
	_ = json.Unmarshal(msg.Payload, &pl)
	switch msg.Event {
	case "session.message":
		if d, ok := pl["delta"].(string); ok && d != "" {
			emit(stream.Chunk{Type: stream.ChunkTypeDelta, Delta: d})
		}
		if f, _ := pl["final"].(bool); f {
			txt, _ := pl["text"].(string)
			emit(stream.Chunk{
				Type:       stream.ChunkTypeDone,
				Text:       txt,
				DoneReason: "stop",
				Provider:   "openclaw",
			})
		}
	case "session.error":
		errMsg, _ := pl["message"].(string)
		if errMsg == "" {
			errMsg, _ = pl["error"].(string)
		}
		emit(stream.Chunk{Type: stream.ChunkTypeError, Error: errMsg})
	}
}

// rejectAllPendingLocked rejects every pending RPC with err. Caller
// holds c.mu.
func (c *Client) rejectAllPendingLocked(err error) {
	for id, p := range c.pending {
		p.out <- rpcResult{Err: err}
		delete(c.pending, id)
	}
}

func (c *Client) flushWaitersLocked(err error) {
	for _, w := range c.connectWaiters {
		w.done <- err
	}
	c.connectWaiters = nil
}

// ── small helpers ──────────────────────────────────────────────────────────

func marshalParams(v any) json.RawMessage {
	if v == nil {
		return nil
	}
	if raw, ok := v.(json.RawMessage); ok {
		return raw
	}
	b, err := json.Marshal(v)
	if err != nil {
		return json.RawMessage("null")
	}
	return b
}

// net_JoinHostPort avoids dragging "net" into the public symbols list.
// Underscore so it doesn't look like an exported alias.
func net_JoinHostPort(host string, port int) string {
	return host + ":" + strconv.Itoa(port)
}

// noopLogger satisfies Logger when the caller passes nil.
type noopLogger struct{}

func (noopLogger) Info(string, ...any)  {}
func (noopLogger) Warn(string, ...any)  {}
func (noopLogger) Error(string, ...any) {}
func (noopLogger) Debug(string, ...any) {}

// Compile-time assertion: *logger.Logger satisfies Logger.
var _ Logger = (*logger.Logger)(nil)
