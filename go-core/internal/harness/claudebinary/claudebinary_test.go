package claudebinary

import (
	"bytes"
	"context"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/yha/core/internal/stream"
)

// fakeProcess constructs a ProcessHandles that emits a fixed stdout
// fixture, no stderr, and exits cleanly when waited on. Tests use
// this to drive Streamer/Runner without spawning a real binary.
func fakeProcess(stdout, stderr string, exit error) ProcessSpawnFn {
	return func(ctx context.Context, opts SpawnOpts, initialStdin []byte) (ProcessHandles, error) {
		// Capture initialStdin in case tests want to assert it.
		stdoutR := strings.NewReader(stdout)
		stderrR := strings.NewReader(stderr)
		// Stdin sink — io.Pipe so writes from /btw don't block.
		stdinPR, stdinPW := io.Pipe()
		// Drain stdin in background; throw away the bytes.
		go func() {
			_, _ = io.Copy(io.Discard, stdinPR)
		}()
		_ = stdinPR // pipe reader kept alive by goroutine
		_ = initialStdin
		killed := make(chan struct{})
		killFn := func() error {
			select {
			case <-killed:
			default:
				close(killed)
			}
			_ = stdinPW.Close()
			return nil
		}
		waitDone := make(chan struct{})
		waitFn := func() error {
			close(waitDone)
			return exit
		}
		return ProcessHandles{
			Stdout: stdoutR,
			Stderr: stderrR,
			Stdin:  stdinPW,
			Kill:   killFn,
			Wait:   waitFn,
			PID:    -1, // skip nice-level
		}, nil
	}
}

// TestStreamerHappyPath verifies a basic Stream call wires the
// processStream output through emit, saves the binary session id, and
// returns a populated FinalizePayload.
func TestStreamerHappyPath(t *testing.T) {
	fixture := strings.Join([]string{
		`{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}`,
		`{"type":"result","session_id":"sess-1","result":"hi","total_cost_usd":0.001,"usage":{"input_tokens":10,"output_tokens":5},"stop_reason":"end_turn"}`,
	}, "\n")

	resolver := NewMemorySessionResolver()
	s := NewStreamer(resolver, nil).WithProcessSpawn(fakeProcess(fixture, "", nil))

	var got []stream.Chunk
	var mu sync.Mutex
	emit := stream.EmitFn(func(c stream.Chunk) {
		mu.Lock()
		got = append(got, c)
		mu.Unlock()
	})
	final, err := s.Stream(context.Background(), Request{
		Prompt:           "hello",
		HistorySessionID: "hist-1",
		Spawn:            SpawnOpts{Stream: true},
	}, emit)
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if final == nil {
		t.Fatal("expected non-nil FinalizePayload")
	}
	if final.Text != "hi" {
		t.Errorf("Text: %q", final.Text)
	}
	if final.Cost != 0.001 {
		t.Errorf("Cost: %v", final.Cost)
	}
	if final.ClaudeSessionID != "sess-1" {
		t.Errorf("ClaudeSessionID: %q", final.ClaudeSessionID)
	}
	if resolver.Get("hist-1") != "sess-1" {
		t.Errorf("resolver should have cached sess-1, got %q", resolver.Get("hist-1"))
	}
	// Expect at least one delta chunk + a done chunk.
	mu.Lock()
	defer mu.Unlock()
	var sawDelta, sawDone bool
	for _, c := range got {
		if c.Type == stream.ChunkTypeDelta {
			sawDelta = true
		}
		if c.Type == stream.ChunkTypeDone {
			sawDone = true
		}
	}
	if !sawDelta {
		t.Error("expected delta chunk")
	}
	if !sawDone {
		t.Error("expected done chunk")
	}
}

// TestStreamerResumeFromResolver — when the resolver already has a
// claude session id for this history sid, the streamer should pre-fill
// ResumeSessionID so BuildArgs adds --resume.
func TestStreamerResumeFromResolver(t *testing.T) {
	fixture := `{"type":"result","session_id":"sess-2","result":"ok","stop_reason":"end_turn"}`
	resolver := NewMemorySessionResolver()
	resolver.Set("hist-X", "sess-prev")

	// Capture the opts the fake spawn sees so we can assert
	// ResumeSessionID propagated.
	var seenResume string
	spawn := func(ctx context.Context, opts SpawnOpts, initialStdin []byte) (ProcessHandles, error) {
		seenResume = opts.ResumeSessionID
		return fakeProcess(fixture, "", nil)(ctx, opts, initialStdin)
	}
	s := NewStreamer(resolver, nil).WithProcessSpawn(spawn)
	_, err := s.Stream(context.Background(), Request{
		Prompt:           "ping",
		HistorySessionID: "hist-X",
		Spawn:            SpawnOpts{Stream: true},
	}, func(stream.Chunk) {})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if seenResume != "sess-prev" {
		t.Errorf("expected ResumeSessionID=sess-prev, got %q", seenResume)
	}
}

// TestStreamerRetriesOnStaleResume — when stderr contains the magic
// string and stdout is empty, the streamer should retry once after
// clearing the cached session id.
func TestStreamerRetriesOnStaleResume(t *testing.T) {
	resolver := NewMemorySessionResolver()
	resolver.Set("hist-stale", "sess-bad")

	attempt := 0
	spawn := func(ctx context.Context, opts SpawnOpts, initialStdin []byte) (ProcessHandles, error) {
		attempt++
		if attempt == 1 {
			// First attempt: no stdout, stderr complains about session.
			return fakeProcess("", "Error: No conversation found with session ID sess-bad", nil)(ctx, opts, initialStdin)
		}
		// Second attempt: clean result. ResumeSessionID should be empty.
		if opts.ResumeSessionID != "" {
			t.Errorf("retry should have cleared ResumeSessionID, got %q", opts.ResumeSessionID)
		}
		return fakeProcess(`{"type":"result","session_id":"sess-new","result":"recovered","stop_reason":"end_turn"}`, "", nil)(ctx, opts, initialStdin)
	}
	s := NewStreamer(resolver, nil).WithProcessSpawn(spawn)
	final, err := s.Stream(context.Background(), Request{
		Prompt:           "retry me",
		HistorySessionID: "hist-stale",
		Spawn:            SpawnOpts{Stream: true},
	}, func(stream.Chunk) {})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if attempt != 2 {
		t.Errorf("expected 2 spawn attempts, got %d", attempt)
	}
	if final.Text != "recovered" {
		t.Errorf("Text: %q", final.Text)
	}
	if final.ClaudeSessionID != "sess-new" {
		t.Errorf("ClaudeSessionID: %q", final.ClaudeSessionID)
	}
	if resolver.Get("hist-stale") != "sess-new" {
		t.Errorf("resolver should now hold sess-new, got %q", resolver.Get("hist-stale"))
	}
}

// TestStreamerCancellation — ctx cancellation kills the fake child
// and surfaces an error.
func TestStreamerCancellation(t *testing.T) {
	// Use an io.Pipe-backed stdout so processStream blocks reading;
	// then cancel ctx and verify Stream returns.
	pr, pw := io.Pipe()
	defer pw.Close()
	spawn := func(ctx context.Context, opts SpawnOpts, initialStdin []byte) (ProcessHandles, error) {
		killed := make(chan struct{})
		return ProcessHandles{
			Stdout: pr,
			Stderr: strings.NewReader(""),
			Kill: func() error {
				select {
				case <-killed:
				default:
					close(killed)
					_ = pw.Close()
				}
				return nil
			},
			Wait: func() error { return nil },
			PID:  -1,
		}, nil
	}
	s := NewStreamer(nil, nil).WithProcessSpawn(spawn)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := s.Stream(ctx, Request{
			Prompt:           "block",
			HistorySessionID: "hist-cancel",
			Spawn:            SpawnOpts{Stream: true},
		}, func(stream.Chunk) {})
		done <- err
	}()
	cancel()
	select {
	case err := <-done:
		if err == nil {
			t.Errorf("expected error after cancellation")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Stream did not return within 2s of cancellation")
	}
}

// TestStreamerErrorEvent — the binary signalling is_error=true should
// propagate up as a Go error.
func TestStreamerErrorEvent(t *testing.T) {
	fixture := `{"type":"result","session_id":"s","result":"crashy","is_error":true,"stop_reason":"error"}`
	s := NewStreamer(nil, nil).WithProcessSpawn(fakeProcess(fixture, "", nil))
	_, err := s.Stream(context.Background(), Request{
		Prompt:           "boom",
		HistorySessionID: "hist-err",
		Spawn:            SpawnOpts{Stream: true},
	}, func(stream.Chunk) {})
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "crashy") {
		t.Errorf("error should mention binary message, got %q", err)
	}
}

// TestStreamerNoOutputSurfacesStderr — when the binary exits non-zero
// without emitting a result event, Stream returns an error that
// includes (tail of) stderr.
func TestStreamerNoOutputSurfacesStderr(t *testing.T) {
	s := NewStreamer(nil, nil).WithProcessSpawn(fakeProcess("", "panic: something\n", errors.New("exit 1")))
	_, err := s.Stream(context.Background(), Request{
		Prompt:           "x",
		HistorySessionID: "hist-x",
		Spawn:            SpawnOpts{Stream: true},
	}, func(stream.Chunk) {})
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "panic") {
		t.Errorf("error should include stderr tail, got %q", err)
	}
}

// TestStreamerInitialStdinIsWritten verifies the fake spawn sees the
// expected JSONL message in initialStdin (streaming mode).
func TestStreamerInitialStdinIsWritten(t *testing.T) {
	fixture := `{"type":"result","session_id":"s","result":"k","stop_reason":"end_turn"}`
	var seenStdin []byte
	spawn := func(ctx context.Context, opts SpawnOpts, initialStdin []byte) (ProcessHandles, error) {
		seenStdin = append([]byte(nil), initialStdin...)
		return fakeProcess(fixture, "", nil)(ctx, opts, initialStdin)
	}
	s := NewStreamer(nil, nil).WithProcessSpawn(spawn)
	_, err := s.Stream(context.Background(), Request{
		Prompt:           "hello world",
		HistorySessionID: "hist-1",
		Spawn:            SpawnOpts{Stream: true},
	}, func(stream.Chunk) {})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if !bytes.Contains(seenStdin, []byte(`"text":"hello world"`)) {
		t.Errorf("seenStdin should contain prompt text, got %q", seenStdin)
	}
	if !bytes.Contains(seenStdin, []byte(`"type":"user"`)) {
		t.Errorf("seenStdin should be JSONL user envelope, got %q", seenStdin)
	}
}
