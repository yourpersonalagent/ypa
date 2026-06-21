// prompt_test.go — unit tests for SubmitPrompt + image post-processing.

package hermes

import (
	"context"
	"encoding/base64"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// driveBasicReplies handles session.create + image.attach +
// prompt.submit by acking each with empty results, and pushes one or
// more scripted server-side events down the wire. Returns a function
// the test can call to push more events after the initial set.
type promptScript struct {
	t         *testing.T
	server    *fakeServer
	sessionID string
}

func (p *promptScript) emit(evt map[string]any) {
	frame := map[string]any{
		"jsonrpc": "2.0",
		"method":  "event",
		"params": map[string]any{
			"type":       evt["type"],
			"session_id": p.sessionID,
			"payload":    evt["payload"],
		},
	}
	if err := p.server.ft.writeServerFrame(frame); err != nil {
		p.t.Fatalf("emit %v: %v", evt["type"], err)
	}
}

// newPromptScript wires a fake server that auto-acks session.create
// with the requested session id and acks every other RPC with an
// empty result. The script side then pushes events via emit.
func newPromptScript(t *testing.T, sessionID string) *promptScript {
	s := newServer(t)
	s.drive(func(req map[string]any) map[string]any {
		switch req["method"] {
		case "session.create":
			return map[string]any{"result": map[string]any{"session_id": sessionID}}
		default:
			return map[string]any{"result": map[string]any{}}
		}
	})
	return &promptScript{t: t, server: s, sessionID: sessionID}
}

func TestSubmitPromptAccumulatesDeltas(t *testing.T) {
	ps := newPromptScript(t, "h-1")
	mgr := NewSessionManager(ps.server.gw)

	var (
		gotDeltas []string
		dmu       sync.Mutex
	)
	onDelta := func(d string) {
		dmu.Lock()
		gotDeltas = append(gotDeltas, d)
		dmu.Unlock()
	}

	// Submit + drive a 2-delta + complete sequence.
	resultCh := make(chan struct {
		res PromptResult
		err error
	}, 1)
	go func() {
		res, err := SubmitPrompt(context.Background(), ps.server.gw, mgr, "yha", "p", "hello",
			onDelta, PromptOpts{IdleTimeout: 2 * time.Second, TotalTimeout: 5 * time.Second})
		resultCh <- struct {
			res PromptResult
			err error
		}{res, err}
	}()

	// Wait a beat so the subscriber is in place before we emit.
	time.Sleep(50 * time.Millisecond)
	ps.emit(map[string]any{"type": "message.delta", "payload": map[string]any{"text": "Hello, "}})
	ps.emit(map[string]any{"type": "message.delta", "payload": map[string]any{"text": "world"}})
	ps.emit(map[string]any{"type": "message.complete", "payload": map[string]any{"text": "Hello, world", "status": "complete"}})

	select {
	case got := <-resultCh:
		if got.err != nil {
			t.Fatalf("SubmitPrompt err: %v", got.err)
		}
		if got.res.RawText != "Hello, world" {
			t.Errorf("RawText: got %q", got.res.RawText)
		}
		if got.res.Status != "complete" {
			t.Errorf("Status: got %q", got.res.Status)
		}
		dmu.Lock()
		joined := strings.Join(gotDeltas, "|")
		dmu.Unlock()
		if joined != "Hello, |world" {
			t.Errorf("onDelta sequence: %q", joined)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("SubmitPrompt did not return after complete event")
	}
}

func TestSubmitPromptIdleTimeoutFires(t *testing.T) {
	ps := newPromptScript(t, "h-idle")
	mgr := NewSessionManager(ps.server.gw)

	resultCh := make(chan error, 1)
	go func() {
		_, err := SubmitPrompt(context.Background(), ps.server.gw, mgr, "yha", "p", "hello",
			func(string) {},
			PromptOpts{IdleTimeout: 100 * time.Millisecond, TotalTimeout: 30 * time.Second})
		resultCh <- err
	}()

	select {
	case err := <-resultCh:
		if err == nil || !strings.Contains(err.Error(), "idle-timeout") {
			t.Fatalf("want idle-timeout error, got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("idle watchdog never fired")
	}
}

func TestSubmitPromptTotalTimeoutOverridesIdle(t *testing.T) {
	ps := newPromptScript(t, "h-total")
	mgr := NewSessionManager(ps.server.gw)

	// Continuously push delta events so idle never trips. Stop pushing
	// once total fires.
	stop := atomic.Bool{}
	go func() {
		// Give SubmitPrompt time to subscribe.
		time.Sleep(50 * time.Millisecond)
		for !stop.Load() {
			ps.emit(map[string]any{
				"type":    "message.delta",
				"payload": map[string]any{"text": "."},
			})
			time.Sleep(30 * time.Millisecond)
		}
	}()

	resultCh := make(chan error, 1)
	go func() {
		_, err := SubmitPrompt(context.Background(), ps.server.gw, mgr, "yha", "p", "hello",
			func(string) {},
			PromptOpts{IdleTimeout: 5 * time.Second, TotalTimeout: 200 * time.Millisecond})
		resultCh <- err
	}()

	select {
	case err := <-resultCh:
		stop.Store(true)
		if err == nil || !strings.Contains(err.Error(), "total-timeout") {
			t.Fatalf("want total-timeout error, got %v", err)
		}
	case <-time.After(3 * time.Second):
		stop.Store(true)
		t.Fatal("total watchdog never fired")
	}
}

func TestSubmitPromptErrorEventDropsSession(t *testing.T) {
	ps := newPromptScript(t, "h-err")
	mgr := NewSessionManager(ps.server.gw)

	resultCh := make(chan error, 1)
	go func() {
		_, err := SubmitPrompt(context.Background(), ps.server.gw, mgr, "yha", "p", "hi",
			func(string) {},
			PromptOpts{IdleTimeout: 5 * time.Second, TotalTimeout: 5 * time.Second})
		resultCh <- err
	}()
	time.Sleep(50 * time.Millisecond)
	ps.emit(map[string]any{"type": "error", "payload": map[string]any{"message": "boom"}})

	select {
	case err := <-resultCh:
		if err == nil || !strings.Contains(err.Error(), "boom") {
			t.Fatalf("want boom error, got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("error event did not terminate prompt")
	}
	if mgr.HermesID("yha", "p") != "" {
		t.Errorf("session should be dropped after error event")
	}
}

func TestSubmitPromptForwardsPromptRequests(t *testing.T) {
	ps := newPromptScript(t, "h-prompt")
	mgr := NewSessionManager(ps.server.gw)

	var (
		gotMu  sync.Mutex
		gotKey string
	)
	onPromptRequest := func(evType string, payload map[string]any) {
		gotMu.Lock()
		gotKey = evType
		gotMu.Unlock()
	}

	resultCh := make(chan error, 1)
	go func() {
		_, err := SubmitPrompt(context.Background(), ps.server.gw, mgr, "yha", "p", "hi",
			func(string) {},
			PromptOpts{
				IdleTimeout:     5 * time.Second,
				TotalTimeout:    5 * time.Second,
				OnPromptRequest: onPromptRequest,
			})
		resultCh <- err
	}()
	time.Sleep(50 * time.Millisecond)
	ps.emit(map[string]any{"type": "approval.request", "payload": map[string]any{"question": "ok?"}})
	// Now finish so the goroutine exits.
	ps.emit(map[string]any{"type": "message.complete", "payload": map[string]any{"text": "done", "status": "complete"}})

	select {
	case err := <-resultCh:
		if err != nil {
			t.Fatalf("unexpected err: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("prompt did not complete")
	}
	gotMu.Lock()
	defer gotMu.Unlock()
	if gotKey != "approval.request" {
		t.Errorf("OnPromptRequest got %q, want approval.request", gotKey)
	}
}

func TestSubmitPromptInjectsPersonaOnFirstTurn(t *testing.T) {
	s := newServer(t)
	// Capture every prompt.submit text so the test can inspect it.
	prompts := make(chan string, 4)
	s.drive(func(req map[string]any) map[string]any {
		switch req["method"] {
		case "session.create":
			return map[string]any{"result": map[string]any{"session_id": "h-z"}}
		case "prompt.submit":
			params, _ := req["params"].(map[string]any)
			if txt, ok := params["text"].(string); ok {
				prompts <- txt
			}
			return map[string]any{"result": map[string]any{}}
		}
		return map[string]any{"result": map[string]any{}}
	})

	mgr := NewSessionManager(s.gw)
	resultCh := make(chan error, 1)
	go func() {
		_, err := SubmitPrompt(context.Background(), s.gw, mgr, "yha", "p", "hi",
			func(string) {},
			PromptOpts{
				IdleTimeout:  5 * time.Second,
				TotalTimeout: 5 * time.Second,
				Presets:      Presets{SystemPrompt: "ALWAYS RHYME"},
			})
		resultCh <- err
	}()
	time.Sleep(50 * time.Millisecond)
	emitTo := &promptScript{t: t, server: s, sessionID: "h-z"}
	emitTo.emit(map[string]any{"type": "message.complete", "payload": map[string]any{"text": "ok", "status": "complete"}})
	<-resultCh

	select {
	case got := <-prompts:
		if !strings.Contains(got, "[Persona Instructions]") {
			t.Errorf("first prompt missing persona header: %q", got)
		}
		if !strings.Contains(got, "ALWAYS RHYME") {
			t.Errorf("first prompt missing persona body: %q", got)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("no prompt.submit captured")
	}
}

// TestProcessHermesImagesConvertsLocalRefs verifies the markdown image
// post-processor rewrites local file refs to data: URIs.
func TestProcessHermesImagesConvertsLocalRefs(t *testing.T) {
	dir := t.TempDir()
	imgPath := filepath.Join(dir, "fixture.png")
	pngBytes := []byte("\x89PNG\r\n\x1a\nfake-png-body")
	if err := os.WriteFile(imgPath, pngBytes, 0o600); err != nil {
		t.Fatalf("write fixture: %v", err)
	}

	in := "before ![alt](" + imgPath + ") after"
	out := processHermesImages(in)

	expected := "data:image/png;base64," + base64.StdEncoding.EncodeToString(pngBytes)
	if !strings.Contains(out, expected) {
		t.Errorf("expected data URI in output. got: %q", out)
	}
	if !strings.Contains(out, "![alt]") {
		t.Errorf("alt text should survive: %q", out)
	}
}

func TestProcessHermesImagesLeavesURLsAlone(t *testing.T) {
	in := "![a](https://example.com/foo.png) ![b](data:image/png;base64,AAAA)"
	out := processHermesImages(in)
	if out != in {
		t.Errorf("URL / data URI sources should pass through unchanged.\n  in: %q\n out: %q", in, out)
	}
}

func TestProcessHermesImagesIgnoresMissingFile(t *testing.T) {
	in := "![a](/this/file/does/not/exist.png)"
	out := processHermesImages(in)
	if out != in {
		t.Errorf("missing file should leave ref untouched: got %q", out)
	}
}

func TestSubmitPromptCleansUpTempImagesAfterAttach(t *testing.T) {
	// Drive a server that acks image.attach + prompt.submit and emits
	// a complete event so the prompt terminates cleanly.
	s := newServer(t)
	attaches := make(chan string, 4)
	s.drive(func(req map[string]any) map[string]any {
		switch req["method"] {
		case "session.create":
			return map[string]any{"result": map[string]any{"session_id": "h-img"}}
		case "image.attach":
			params, _ := req["params"].(map[string]any)
			if p, ok := params["path"].(string); ok {
				attaches <- p
			}
			return map[string]any{"result": map[string]any{}}
		}
		return map[string]any{"result": map[string]any{}}
	})

	mgr := NewSessionManager(s.gw)
	pngBytes := []byte("\x89PNG\r\nfake-image-body")
	encoded := base64.StdEncoding.EncodeToString(pngBytes)

	resultCh := make(chan error, 1)
	go func() {
		_, err := SubmitPrompt(context.Background(), s.gw, mgr, "yha", "p", "hi",
			func(string) {},
			PromptOpts{
				IdleTimeout:  5 * time.Second,
				TotalTimeout: 5 * time.Second,
				ImageBlocks: []ImageBlock{
					{MediaType: "image/png", Base64: encoded},
				},
			})
		resultCh <- err
	}()

	var capturedPath string
	select {
	case capturedPath = <-attaches:
	case <-time.After(2 * time.Second):
		t.Fatal("image.attach not invoked")
	}
	if !strings.Contains(capturedPath, "yha-hermes-") {
		t.Errorf("temp filename: got %q", capturedPath)
	}
	// File should exist at this point.
	if _, err := os.Stat(capturedPath); err != nil {
		t.Errorf("temp file missing before turn ends: %v", err)
	}

	// Finish the turn.
	(&promptScript{t: t, server: s, sessionID: "h-img"}).emit(
		map[string]any{"type": "message.complete", "payload": map[string]any{"text": "ok"}})

	if err := <-resultCh; err != nil {
		t.Fatalf("unexpected err: %v", err)
	}
	// After cleanup, the temp file should be gone.
	if _, err := os.Stat(capturedPath); !os.IsNotExist(err) {
		t.Errorf("temp file should be removed, stat err: %v", err)
	}
}
