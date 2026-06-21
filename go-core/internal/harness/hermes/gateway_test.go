// gateway_test.go — unit tests for the Gateway using an io.Pipe-backed
// fake transport. No real Python subprocess is involved.

package hermes

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeTransport is an in-memory Transport. The test "server" side is
// exposed as a *fakeTransport methods; the gateway reads/writes the
// piped sides.
type fakeTransport struct {
	mu      sync.Mutex
	stdin   *io.PipeReader // gateway → us
	stdinW  *io.PipeWriter
	stdout  *io.PipeWriter // us → gateway
	stdoutR *io.PipeReader

	started  bool
	waitCh   chan error
	killOnce sync.Once
}

func newFakeTransport() *fakeTransport {
	t := &fakeTransport{waitCh: make(chan error, 1)}
	t.stdin, t.stdinW = io.Pipe()
	t.stdoutR, t.stdout = io.Pipe()
	return t
}

func (t *fakeTransport) Start(_ context.Context) error {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.started = true
	return nil
}

// Stdin from the gateway's perspective is the pipe it writes into;
// the test "server" reads from t.stdin.
func (t *fakeTransport) Stdin() io.Writer  { return t.stdinW }
func (t *fakeTransport) Stdout() io.Reader { return t.stdoutR }

func (t *fakeTransport) Wait() error {
	return <-t.waitCh
}

func (t *fakeTransport) Kill() error {
	t.killOnce.Do(func() {
		_ = t.stdinW.Close()
		_ = t.stdout.Close()
		select {
		case t.waitCh <- nil:
		default:
		}
	})
	return nil
}

// readClientFrame reads one newline-terminated JSON frame the gateway
// wrote to its stdin.
func (t *fakeTransport) readClientFrame() (map[string]any, error) {
	br := bufio.NewReader(t.stdin)
	line, err := br.ReadBytes('\n')
	if err != nil {
		return nil, err
	}
	var m map[string]any
	if err := json.Unmarshal(line, &m); err != nil {
		return nil, err
	}
	return m, nil
}

// writeServerFrame pushes one newline-terminated JSON frame down the
// "server → gateway" pipe.
func (t *fakeTransport) writeServerFrame(v any) error {
	b, err := json.Marshal(v)
	if err != nil {
		return err
	}
	b = append(b, '\n')
	_, err = t.stdout.Write(b)
	return err
}

// finishExit signals the wait goroutine to wake up. Used by tests
// that exercise auto-restart / exit-cleanup paths.
func (t *fakeTransport) finishExit(err error) {
	t.killOnce.Do(func() {
		_ = t.stdinW.Close()
		_ = t.stdout.Close()
		select {
		case t.waitCh <- err:
		default:
		}
	})
}

// startGatewayWithFake wires a gateway to the fakeTransport and starts
// it. Returns both so the test can drive the server side.
func startGatewayWithFake(t *testing.T) (*Gateway, *fakeTransport) {
	t.Helper()
	ft := newFakeTransport()
	gw := newGatewayWithTransport(nil, func(ctx context.Context) (Transport, error) {
		return ft, nil
	})
	if err := gw.Start(context.Background()); err != nil {
		t.Fatalf("gateway start: %v", err)
	}
	return gw, ft
}

func TestGatewaySendReceivesResponseByID(t *testing.T) {
	gw, ft := startGatewayWithFake(t)
	t.Cleanup(func() { _ = gw.Stop() })

	// Spin a server-side goroutine that reads one request and replies.
	done := make(chan map[string]any, 1)
	go func() {
		frame, err := ft.readClientFrame()
		if err != nil {
			done <- nil
			return
		}
		done <- frame
		// Echo the id back with a fixed result.
		id, _ := frame["id"].(float64)
		_ = ft.writeServerFrame(map[string]any{
			"jsonrpc": "2.0",
			"id":      id,
			"result":  map[string]any{"session_id": "abc"},
		})
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	raw, err := gw.Send(ctx, "session.create", map[string]any{}, 2*time.Second)
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	var resp struct {
		SessionID string `json:"session_id"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if resp.SessionID != "abc" {
		t.Errorf("session_id: want abc, got %q", resp.SessionID)
	}

	req := <-done
	if req["method"] != "session.create" {
		t.Errorf("method on wire: want session.create, got %v", req["method"])
	}
	if req["jsonrpc"] != "2.0" {
		t.Errorf("missing jsonrpc field: %v", req)
	}
	if _, ok := req["id"].(float64); !ok {
		t.Errorf("id is not numeric: %T", req["id"])
	}
}

func TestGatewaySendRejectsWhenNotRunning(t *testing.T) {
	gw := NewGateway(nil)
	_, err := gw.Send(context.Background(), "foo", nil, time.Second)
	if err == nil || !strings.Contains(err.Error(), "not running") {
		t.Fatalf("want not-running error, got %v", err)
	}
}

func TestGatewayRPCSurfacesError(t *testing.T) {
	gw, ft := startGatewayWithFake(t)
	t.Cleanup(func() { _ = gw.Stop() })

	go func() {
		frame, err := ft.readClientFrame()
		if err != nil {
			return
		}
		id, _ := frame["id"].(float64)
		_ = ft.writeServerFrame(map[string]any{
			"jsonrpc": "2.0",
			"id":      id,
			"error":   map[string]any{"code": -1, "message": "boom"},
		})
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	_, err := gw.Send(ctx, "bad.method", nil, 2*time.Second)
	if err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("want RPC error to surface, got %v", err)
	}
}

func TestGatewayRPCTimeoutFires(t *testing.T) {
	gw, ft := startGatewayWithFake(t)
	t.Cleanup(func() { _ = gw.Stop() })
	// Drain the client frame so the pipe doesn't block, then never reply.
	go func() {
		_, _ = ft.readClientFrame()
	}()

	_, err := gw.Send(context.Background(), "stuck", nil, 50*time.Millisecond)
	if err == nil || !strings.Contains(err.Error(), "timeout") {
		t.Fatalf("want timeout error, got %v", err)
	}
}

func TestGatewaySubscribeFiltersBySessionID(t *testing.T) {
	gw, ft := startGatewayWithFake(t)
	t.Cleanup(func() { _ = gw.Stop() })

	ch, cancel := gw.Subscribe("hermes-1")
	defer cancel()

	// Send one event for our session and one for another. Only the
	// first should land on our channel.
	_ = ft.writeServerFrame(map[string]any{
		"jsonrpc": "2.0",
		"method":  "event",
		"params": map[string]any{
			"type":       "message.delta",
			"session_id": "hermes-1",
			"payload":    map[string]any{"text": "hi"},
		},
	})
	_ = ft.writeServerFrame(map[string]any{
		"jsonrpc": "2.0",
		"method":  "event",
		"params": map[string]any{
			"type":       "message.delta",
			"session_id": "hermes-other",
			"payload":    map[string]any{"text": "nope"},
		},
	})

	select {
	case evt := <-ch:
		if evt.Type != "message.delta" || evt.SessionID != "hermes-1" {
			t.Errorf("got unexpected event: %+v", evt)
		}
		if got, _ := evt.Payload["text"].(string); got != "hi" {
			t.Errorf("payload.text: want hi, got %q", got)
		}
	case <-time.After(time.Second):
		t.Fatal("expected delta event")
	}

	// Make sure the wrong-session event didn't sneak in.
	select {
	case evt := <-ch:
		t.Errorf("unexpected second event: %+v", evt)
	case <-time.After(100 * time.Millisecond):
	}
}

func TestGatewaySubscribeCancelReleasesChannel(t *testing.T) {
	gw, ft := startGatewayWithFake(t)
	t.Cleanup(func() { _ = gw.Stop() })

	ch, cancel := gw.Subscribe("sid")
	cancel()
	// Channel should be closed after cancel.
	select {
	case _, ok := <-ch:
		if ok {
			t.Errorf("channel should be closed after cancel")
		}
	case <-time.After(time.Second):
		t.Fatal("cancel didn't close channel")
	}
	// Push an event to make sure no panics fire on send to closed sub.
	_ = ft.writeServerFrame(map[string]any{
		"jsonrpc": "2.0",
		"method":  "event",
		"params": map[string]any{
			"type":       "message.delta",
			"session_id": "sid",
			"payload":    map[string]any{"text": "ignored"},
		},
	})
	// No assertion — just ensuring no panic. Sleep briefly so the
	// read loop processes the frame before the test exits.
	time.Sleep(50 * time.Millisecond)
}

func TestGatewayParsesStringID(t *testing.T) {
	gw, ft := startGatewayWithFake(t)
	t.Cleanup(func() { _ = gw.Stop() })

	go func() {
		frame, err := ft.readClientFrame()
		if err != nil {
			return
		}
		id, _ := frame["id"].(float64)
		// Reply with a stringified id — gateway should accept it.
		_ = ft.writeServerFrame(map[string]any{
			"jsonrpc": "2.0",
			"id":      strFromFloat(id),
			"result":  map[string]any{"ok": true},
		})
	}()

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	raw, err := gw.Send(ctx, "ping", nil, 2*time.Second)
	if err != nil {
		t.Fatalf("Send: %v", err)
	}
	if !strings.Contains(string(raw), "ok") {
		t.Errorf("result body: %s", raw)
	}
}

func TestGatewayStopRejectsPendingAndDrainsGoroutines(t *testing.T) {
	gw, ft := startGatewayWithFake(t)

	// Pending RPC that the server never answers.
	go func() {
		_, _ = ft.readClientFrame()
	}()

	gotErr := make(chan error, 1)
	go func() {
		_, err := gw.Send(context.Background(), "stuck", nil, time.Minute)
		gotErr <- err
	}()

	// Give the goroutine a beat to register the pending entry.
	time.Sleep(50 * time.Millisecond)
	if err := gw.Stop(); err != nil {
		t.Fatalf("Stop: %v", err)
	}

	select {
	case err := <-gotErr:
		if err == nil {
			t.Fatal("want error on pending RPC after stop")
		}
	case <-time.After(time.Second):
		t.Fatal("pending RPC not released after Stop")
	}

	if gw.IsRunning() {
		t.Errorf("gateway still reports running after Stop")
	}
}

func TestGatewaySkipsMalformedLines(t *testing.T) {
	gw, ft := startGatewayWithFake(t)
	t.Cleanup(func() { _ = gw.Stop() })

	// Subscribe first so we don't race the read loop.
	ch, cancel := gw.Subscribe("s")
	t.Cleanup(cancel)

	// Write some garbage, then a real event. Garbage must not break
	// the read loop, and the real event after must still land.
	_, _ = ft.stdout.Write([]byte("this is not json\n"))
	_, _ = ft.stdout.Write([]byte("\n")) // empty line
	_ = ft.writeServerFrame(map[string]any{
		"jsonrpc": "2.0",
		"method":  "event",
		"params": map[string]any{
			"type":       "message.delta",
			"session_id": "s",
			"payload":    map[string]any{"text": "after-garbage"},
		},
	})

	select {
	case evt := <-ch:
		if got, _ := evt.Payload["text"].(string); got != "after-garbage" {
			t.Errorf("got %q, want after-garbage", got)
		}
	case <-time.After(time.Second):
		t.Fatal("delta event after garbage not received")
	}
}

func TestGatewayIsInstalledDetectsMissingFiles(t *testing.T) {
	gw := NewGateway(nil)
	gw.pythonPath = "/nonexistent/python"
	gw.moduleDir = "/nonexistent/module"
	if gw.IsInstalled() {
		t.Errorf("IsInstalled should be false for missing files")
	}
}

func TestGatewayStartIsIdempotent(t *testing.T) {
	gw, ft := startGatewayWithFake(t)
	t.Cleanup(func() { _ = gw.Stop() })
	_ = ft

	// Second Start should be a no-op.
	if err := gw.Start(context.Background()); err != nil {
		t.Fatalf("second start: %v", err)
	}
}

// strFromFloat formats a float as an integer-looking string so the
// server can send a stringified id without dragging strconv in here.
func strFromFloat(f float64) string {
	return jsonInt(int64(f))
}

func jsonInt(i int64) string {
	b, _ := json.Marshal(i)
	return strings.Trim(string(b), `"`)
}

// Sanity assertion: the Transport interface is satisfied by our fake.
var _ Transport = (*fakeTransport)(nil)

// Sanity: scanner buffer extension is reachable.
var _ = errors.New
