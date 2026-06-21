// client_test.go — fake-WS-server tests for the OpenClaw client.
//
// Each test spins up an httptest.NewServer with a websocket.Upgrader.
// The fake gateway speaks a minimal subset of the OpenClaw protocol:
// emits connect.challenge → waits for connect-with-token → emits res
// id=0 → handles subsequent requests by echoing or scripted replies.

package openclaw

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/yha/core/internal/stream"
)

// fakeGateway is a programmable WS server that lets tests drive any
// sequence of inbound frames + scripted responses.
type fakeGateway struct {
	t            *testing.T
	srv          *httptest.Server
	upgrader     websocket.Upgrader
	mu           sync.Mutex
	connections  []*fakeConn
	skipChallenge bool
	rejectAuth   bool
	// onConnect lets a test push extra frames once authed.
	onAuthed func(c *fakeConn)
	// onReq is the per-request handler. Default echoes ok with empty payload.
	onReq func(c *fakeConn, msg wireMessage) wireMessage
	// disruptAfterAuth: when >0, server closes the WS after this many frames.
	disruptAfterFrames atomic.Int64
}

type fakeConn struct {
	g  *fakeGateway
	ws *websocket.Conn
}

func newFakeGateway(t *testing.T) *fakeGateway {
	g := &fakeGateway{t: t, upgrader: websocket.Upgrader{}}
	g.onReq = func(c *fakeConn, msg wireMessage) wireMessage {
		return defaultEchoReply(msg)
	}
	g.srv = httptest.NewServer(http.HandlerFunc(g.handle))
	return g
}

func (g *fakeGateway) host() string {
	u, _ := url.Parse(g.srv.URL)
	return u.Hostname()
}

func (g *fakeGateway) port() int {
	u, _ := url.Parse(g.srv.URL)
	var p int
	fmt.Sscanf(u.Port(), "%d", &p)
	return p
}

func (g *fakeGateway) close() {
	g.mu.Lock()
	for _, c := range g.connections {
		_ = c.ws.Close()
	}
	g.mu.Unlock()
	g.srv.Close()
}

func (g *fakeGateway) handle(w http.ResponseWriter, r *http.Request) {
	ws, err := g.upgrader.Upgrade(w, r, nil)
	if err != nil {
		g.t.Logf("upgrade: %v", err)
		return
	}
	fc := &fakeConn{g: g, ws: ws}
	g.mu.Lock()
	g.connections = append(g.connections, fc)
	skipChallenge := g.skipChallenge
	g.mu.Unlock()

	if !skipChallenge {
		// Emit connect.challenge.
		fc.writeJSON(wireMessage{Type: "event", Event: "connect.challenge"})
	}

	frameCount := int64(0)
	for {
		if g.disruptAfterFrames.Load() > 0 && frameCount >= g.disruptAfterFrames.Load() {
			_ = ws.Close()
			return
		}
		_, raw, err := ws.ReadMessage()
		if err != nil {
			return
		}
		frameCount++
		var msg wireMessage
		if err := json.Unmarshal(raw, &msg); err != nil {
			continue
		}
		// First frame from client is connect (id="0").
		if msg.ID == "0" && msg.Method == "connect" {
			if g.rejectAuth {
				ok := false
				fc.writeJSON(wireMessage{Type: "res", ID: "0", OK: &ok, Error: &wireError{Message: "bad token"}})
				return
			}
			ok := true
			fc.writeJSON(wireMessage{Type: "res", ID: "0", OK: &ok, Payload: json.RawMessage(`{"proto":"v3"}`)})
			if g.onAuthed != nil {
				go g.onAuthed(fc)
			}
			continue
		}
		// All other requests → onReq handler.
		reply := g.onReq(fc, msg)
		if reply.Type != "" {
			fc.writeJSON(reply)
		}
	}
}

func (c *fakeConn) writeJSON(msg wireMessage) {
	if msg.Payload == nil {
		msg.Payload = json.RawMessage(`{}`)
	}
	b, _ := json.Marshal(msg)
	_ = c.ws.WriteMessage(websocket.TextMessage, b)
}

func (c *fakeConn) sendEvent(event string, payload any) {
	body, _ := json.Marshal(payload)
	c.writeJSON(wireMessage{Type: "event", Event: event, Payload: body})
}

func defaultEchoReply(msg wireMessage) wireMessage {
	ok := true
	return wireMessage{Type: "res", ID: msg.ID, OK: &ok, Payload: json.RawMessage(`{}`)}
}

// ── tests ──────────────────────────────────────────────────────────────────

func TestClient_HandshakeSucceeds(t *testing.T) {
	g := newFakeGateway(t)
	defer g.close()

	cl := New(g.host(), g.port(), "tok", "main", nil)
	defer cl.Disconnect()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := cl.Connect(ctx); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	if !cl.IsConnected() {
		t.Fatal("expected IsConnected after Connect")
	}
}

func TestClient_HandshakeRejected(t *testing.T) {
	g := newFakeGateway(t)
	g.rejectAuth = true
	defer g.close()

	cl := New(g.host(), g.port(), "bad", "main", nil)
	defer cl.Disconnect()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	err := cl.Connect(ctx)
	if err == nil || !strings.Contains(err.Error(), "auth failed") {
		t.Fatalf("expected auth failure, got %v", err)
	}
	if cl.IsConnected() {
		t.Fatal("should not be connected")
	}
}

func TestClient_SendRPC_RoundTrip(t *testing.T) {
	g := newFakeGateway(t)
	g.onReq = func(c *fakeConn, msg wireMessage) wireMessage {
		if msg.Method == "sessions.create" {
			ok := true
			return wireMessage{Type: "res", ID: msg.ID, OK: &ok,
				Payload: json.RawMessage(`{"sessionKey":"sess-xyz"}`)}
		}
		return defaultEchoReply(msg)
	}
	defer g.close()

	cl := New(g.host(), g.port(), "tok", "main", nil)
	defer cl.Disconnect()
	if err := cl.Connect(context.Background()); err != nil {
		t.Fatalf("Connect: %v", err)
	}

	payload, err := cl.Send(context.Background(), "sessions.create", map[string]any{"agentId": "main"})
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	var resp struct {
		SessionKey string `json:"sessionKey"`
	}
	if err := json.Unmarshal(payload, &resp); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if resp.SessionKey != "sess-xyz" {
		t.Fatalf("sessionKey = %q, want sess-xyz", resp.SessionKey)
	}
}

func TestClient_SendRPC_ErrorPropagates(t *testing.T) {
	g := newFakeGateway(t)
	g.onReq = func(c *fakeConn, msg wireMessage) wireMessage {
		ok := false
		return wireMessage{Type: "res", ID: msg.ID, OK: &ok,
			Error: &wireError{Message: "no such method"}}
	}
	defer g.close()

	cl := New(g.host(), g.port(), "tok", "main", nil)
	defer cl.Disconnect()
	if err := cl.Connect(context.Background()); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	_, err := cl.Send(context.Background(), "x.unknown", nil)
	if err == nil || !strings.Contains(err.Error(), "no such method") {
		t.Fatalf("expected RPC error, got %v", err)
	}
}

func TestClient_SubscriberFanout(t *testing.T) {
	g := newFakeGateway(t)
	var c0 atomic.Pointer[fakeConn]
	g.onAuthed = func(c *fakeConn) {
		c0.Store(c)
	}
	defer g.close()

	cl := New(g.host(), g.port(), "tok", "main", nil)
	defer cl.Disconnect()
	if err := cl.Connect(context.Background()); err != nil {
		t.Fatalf("Connect: %v", err)
	}

	got := make(chan stream.Chunk, 4)
	cl.Subscribe("sess-1", func(c stream.Chunk) { got <- c })

	// Wait for onAuthed to record the conn.
	deadline := time.After(2 * time.Second)
	for c0.Load() == nil {
		select {
		case <-deadline:
			t.Fatal("conn not authed in time")
		default:
			time.Sleep(5 * time.Millisecond)
		}
	}

	c0.Load().sendEvent("session.message", map[string]any{
		"sessionKey": "sess-1", "delta": "hello"})
	c0.Load().sendEvent("session.message", map[string]any{
		"sessionKey": "sess-2", "delta": "wrong-sid"}) // should be ignored
	c0.Load().sendEvent("session.message", map[string]any{
		"sessionKey": "sess-1", "final": true, "text": "hello world"})

	select {
	case c := <-got:
		if c.Type != stream.ChunkTypeDelta || c.Delta != "hello" {
			t.Fatalf("first chunk: %+v", c)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no delta received")
	}
	select {
	case c := <-got:
		if c.Type != stream.ChunkTypeDone || c.Text != "hello world" {
			t.Fatalf("done chunk: %+v", c)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no done received")
	}

	// Verify no spurious chunk from sess-2 leaked.
	select {
	case c := <-got:
		t.Fatalf("unexpected extra chunk: %+v", c)
	case <-time.After(200 * time.Millisecond):
	}
}

func TestClient_DisconnectIsIdempotent(t *testing.T) {
	g := newFakeGateway(t)
	defer g.close()
	cl := New(g.host(), g.port(), "tok", "main", nil)
	if err := cl.Connect(context.Background()); err != nil {
		t.Fatalf("Connect: %v", err)
	}
	cl.Disconnect()
	cl.Disconnect() // must not panic / hang
	if cl.IsConnected() {
		t.Fatal("expected disconnected")
	}
}

func TestClient_PendingRejectedOnClose(t *testing.T) {
	g := newFakeGateway(t)
	// Replace onReq with a no-op so the request hangs.
	g.onReq = func(c *fakeConn, msg wireMessage) wireMessage {
		return wireMessage{} // empty type → no reply written
	}
	defer g.close()

	cl := New(g.host(), g.port(), "tok", "main", nil)
	if err := cl.Connect(context.Background()); err != nil {
		t.Fatalf("Connect: %v", err)
	}

	errCh := make(chan error, 1)
	go func() {
		_, err := cl.Send(context.Background(), "slow.method", nil)
		errCh <- err
	}()
	// Tear down the client; pending Send should error.
	time.Sleep(50 * time.Millisecond)
	cl.Disconnect()

	select {
	case err := <-errCh:
		if err == nil {
			t.Fatal("expected error from pending RPC on disconnect")
		}
		if !strings.Contains(err.Error(), "disconnect") && !strings.Contains(err.Error(), "closed") {
			t.Fatalf("expected close/disconnect error, got %v", err)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("pending RPC did not error on disconnect")
	}
}

func TestClient_ReconnectAfterDisconnectFromServer(t *testing.T) {
	g := newFakeGateway(t)
	defer g.close()

	cl := New(g.host(), g.port(), "tok", "main", nil)
	defer cl.Disconnect()
	// Reduce backoff so the reconnect lands in test time.
	cl.reconnectDelay = 50 * time.Millisecond
	if err := cl.Connect(context.Background()); err != nil {
		t.Fatalf("Connect: %v", err)
	}

	// Slam the connection from the server side.
	g.mu.Lock()
	for _, c := range g.connections {
		_ = c.ws.Close()
	}
	g.connections = g.connections[:0]
	g.mu.Unlock()

	// Wait for IsConnected to recover.
	deadline := time.After(5 * time.Second)
	for {
		if cl.IsConnected() {
			return
		}
		select {
		case <-deadline:
			t.Fatal("client never reconnected")
		case <-time.After(20 * time.Millisecond):
		}
	}
}

func TestClient_SendNotConnected(t *testing.T) {
	cl := New("127.0.0.1", 1, "tok", "main", nil)
	_, err := cl.Send(context.Background(), "x", nil)
	if err == nil || !strings.Contains(err.Error(), "not connected") {
		t.Fatalf("expected not connected, got %v", err)
	}
}

func TestClient_HandshakeDialFails(t *testing.T) {
	// Closed-by-test server URL.
	cl := New("127.0.0.1", 1, "tok", "main", nil)
	defer cl.Disconnect()
	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()
	err := cl.Connect(ctx)
	if err == nil {
		t.Fatal("expected dial error")
	}
	if !errors.Is(err, ctx.Err()) && !strings.Contains(err.Error(), "dial") &&
		!strings.Contains(err.Error(), "refused") && !strings.Contains(err.Error(), "closed") {
		t.Fatalf("got %v", err)
	}
}
