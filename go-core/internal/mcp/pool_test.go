package mcp

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/yha/core/internal/logger"
)

// fakeServer simulates an MCP child process via two io.Pipe pairs.
// childIn  — what the Connection writes to (the "child's stdin")
// childOut — what the Connection reads from (the "child's stdout")
// The test goroutine reads requests off childIn and writes responses
// to childOut.
type fakeServer struct {
	childIn  io.ReadCloser
	childOut io.WriteCloser
	conn     *Connection
}

func newFakeServer(t *testing.T) *fakeServer {
	t.Helper()
	stdinR, stdinW := io.Pipe() // child reads stdinR; conn writes stdinW
	stdoutR, stdoutW := io.Pipe() // conn reads stdoutR; child writes stdoutW
	conn := newConnection("test", stdinW, stdoutR, nil, logger.New(io.Discard))
	go conn.readLoop()
	return &fakeServer{
		childIn:  stdinR,
		childOut: stdoutW,
		conn:     conn,
	}
}

func (fs *fakeServer) close() {
	_ = fs.conn.Close()
	_ = fs.childIn.Close()
	_ = fs.childOut.Close()
}

// expectRequest reads one framed request from childIn and decodes it.
func (fs *fakeServer) expectRequest(t *testing.T) Request {
	t.Helper()
	r := NewReader(fs.childIn)
	body, err := r.ReadFrame()
	if err != nil {
		t.Fatalf("expectRequest: %v", err)
	}
	var req Request
	if err := json.Unmarshal(body, &req); err != nil {
		t.Fatalf("expectRequest decode: %v", err)
	}
	return req
}

// reply sends a Response frame back to the connection.
func (fs *fakeServer) reply(id int, result any) {
	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": id, "result": result,
	})
	_ = WriteFrame(fs.childOut, body)
}

func (fs *fakeServer) replyError(id, code int, msg string) {
	body, _ := json.Marshal(map[string]any{
		"jsonrpc": "2.0", "id": id, "error": map[string]any{"code": code, "message": msg},
	})
	_ = WriteFrame(fs.childOut, body)
}

func TestCallReturnsResult(t *testing.T) {
	fs := newFakeServer(t)
	defer fs.close()

	go func() {
		req := fs.expectRequest(t)
		fs.reply(req.ID, map[string]any{"echo": "ok"})
	}()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	raw, err := fs.conn.Call(ctx, "ping", nil)
	if err != nil {
		t.Fatalf("call: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if got["echo"] != "ok" {
		t.Errorf("result = %+v, want echo=ok", got)
	}
}

func TestCallReturnsRPCError(t *testing.T) {
	fs := newFakeServer(t)
	defer fs.close()

	go func() {
		req := fs.expectRequest(t)
		fs.replyError(req.ID, -32601, "method not found")
	}()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, err := fs.conn.Call(ctx, "nope", nil)
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "method not found") {
		t.Errorf("err = %v, want containing 'method not found'", err)
	}
}

func TestCallContextCancel(t *testing.T) {
	fs := newFakeServer(t)
	defer fs.close()
	// Drain childIn so Send doesn't block on the synchronous io.Pipe.
	// Real OS pipes are kernel-buffered; the test pipe isn't.
	go io.Copy(io.Discard, fs.childIn)
	// Server never replies.

	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Millisecond)
	defer cancel()
	_, err := fs.conn.Call(ctx, "slow", nil)
	if !errors.Is(err, context.DeadlineExceeded) {
		t.Errorf("err = %v, want context deadline", err)
	}
}

func TestCallMultipleConcurrent(t *testing.T) {
	fs := newFakeServer(t)
	defer fs.close()

	// Reflect-back server: every request gets a result with its method name.
	go func() {
		r := NewReader(fs.childIn)
		for {
			body, err := r.ReadFrame()
			if err != nil {
				return
			}
			var req Request
			_ = json.Unmarshal(body, &req)
			fs.reply(req.ID, map[string]any{"method": req.Method})
		}
	}()

	type result struct {
		method string
		err    error
	}
	results := make(chan result, 5)
	for _, m := range []string{"a", "b", "c", "d", "e"} {
		go func(m string) {
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			raw, err := fs.conn.Call(ctx, m, nil)
			if err != nil {
				results <- result{m, err}
				return
			}
			var got map[string]any
			_ = json.Unmarshal(raw, &got)
			results <- result{got["method"].(string), nil}
		}(m)
	}
	got := map[string]bool{}
	for i := 0; i < 5; i++ {
		r := <-results
		if r.err != nil {
			t.Errorf("call %s: %v", r.method, r.err)
			continue
		}
		got[r.method] = true
	}
	for _, m := range []string{"a", "b", "c", "d", "e"} {
		if !got[m] {
			t.Errorf("missing reply for method %q", m)
		}
	}
}

func TestCloseRejectsPending(t *testing.T) {
	fs := newFakeServer(t)
	// Issue a call but never reply.
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := fs.conn.Call(ctx, "hangs", nil)
		done <- err
	}()
	time.Sleep(20 * time.Millisecond) // ensure call is in pending
	_ = fs.conn.Close()
	select {
	case err := <-done:
		if err == nil {
			t.Error("Close should have failed the pending call")
		}
	case <-time.After(500 * time.Millisecond):
		t.Error("Close did not unblock pending call within 500ms")
	}
	// Subsequent Close is a no-op.
	if err := fs.conn.Close(); err != nil {
		t.Errorf("second Close: %v", err)
	}
}

func TestHandshakePopulatesTools(t *testing.T) {
	fs := newFakeServer(t)
	defer fs.close()

	// Server: respond initialize, tools/list with one tool, then the
	// last two list calls with empty arrays.
	go func() {
		r := NewReader(fs.childIn)
		for {
			body, err := r.ReadFrame()
			if err != nil {
				return
			}
			var req Request
			_ = json.Unmarshal(body, &req)
			switch req.Method {
			case "initialize":
				fs.reply(req.ID, map[string]any{"protocolVersion": "2024-11-05"})
			case "tools/list":
				fs.reply(req.ID, map[string]any{"tools": []map[string]any{
					{"name": "echo", "description": "Echoes input"},
				}})
			case "prompts/list":
				fs.reply(req.ID, map[string]any{"prompts": []any{}})
			case "resources/list":
				fs.reply(req.ID, map[string]any{"resources": []any{}})
			}
		}
	}()

	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := fs.conn.Handshake(ctx); err != nil {
		t.Fatalf("handshake: %v", err)
	}
	tools := fs.conn.snapshotTools()
	if len(tools) != 1 || tools[0].Name != "echo" {
		t.Errorf("tools = %+v", tools)
	}
	if !fs.conn.OK {
		t.Errorf("conn.OK = false, want true (server exposed tools)")
	}
}

func TestPoolGetAndList(t *testing.T) {
	// Pool spawning a real subprocess needs an actual MCP server on
	// PATH; that's an integration test, not a unit test. Verify the
	// pool's bookkeeping via a stub Connection so the surface is
	// covered without a child process.
	p := NewPool(logger.New(io.Discard))
	p.connections["x"] = &Connection{Name: "x", pending: map[int]chan response{}}
	got, ok := p.Get("x")
	if !ok || got.Name != "x" {
		t.Errorf("pool Get returned %v %v", got, ok)
	}
	if l := len(p.List()); l != 1 {
		t.Errorf("pool List len = %d, want 1", l)
	}
}

func TestPoolStopRemovesEntry(t *testing.T) {
	p := NewPool(logger.New(io.Discard))
	conn := &Connection{Name: "x", pending: map[int]chan response{}}
	p.connections["x"] = conn
	if err := p.Stop("x"); err != nil {
		t.Fatalf("stop: %v", err)
	}
	if _, ok := p.Get("x"); ok {
		t.Error("expected entry gone after Stop")
	}
	// Stop again is a no-op.
	if err := p.Stop("x"); err != nil {
		t.Errorf("second stop: %v", err)
	}
}
