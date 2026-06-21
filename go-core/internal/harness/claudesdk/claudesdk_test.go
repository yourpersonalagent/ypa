package claudesdk

import (
	"bytes"
	"context"
	"errors"
	"io"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/yha/core/internal/stream"
)

// fakeProcess constructs a ProcessHandles that emits fixed stdout/stderr
// and exits cleanly when waited on. Tests use this to drive Streamer
// without spawning a real binary.
func fakeProcess(stdout, stderr string, exit error) ProcessSpawnFn {
	return func(ctx context.Context, opts SpawnOpts, initialStdin []byte) (ProcessHandles, error) {
		stdoutR := strings.NewReader(stdout)
		stderrR := strings.NewReader(stderr)
		stdinPR, stdinPW := io.Pipe()
		go func() {
			_, _ = io.Copy(io.Discard, stdinPR)
		}()
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
		waitFn := func() error {
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

// TestStreamerHappyPath — basic Stream call routes processStream output
// through emit and returns a populated FinalizePayload.
func TestStreamerHappyPath(t *testing.T) {
	t.Setenv(EnvBridgeStubPath, "") // skip MCP wiring
	fixture := strings.Join([]string{
		`{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}`,
		`{"type":"result","session_id":"sess-1","result":"hi","total_cost_usd":0.001,"usage":{"input_tokens":10,"output_tokens":5},"stop_reason":"end_turn"}`,
	}, "\n")

	s := NewStreamer(nil).WithProcessSpawn(fakeProcess(fixture, "", nil))

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
		Spawn:            SpawnOpts{},
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

// TestStreamerCancellation — ctx cancellation kills the fake child and
// surfaces an error.
func TestStreamerCancellation(t *testing.T) {
	t.Setenv(EnvBridgeStubPath, "")
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
	s := NewStreamer(nil).WithProcessSpawn(spawn)
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := s.Stream(ctx, Request{
			Prompt:           "block",
			HistorySessionID: "hist-cancel",
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

// TestStreamerErrorEvent — is_error=true propagates up as a Go error.
func TestStreamerErrorEvent(t *testing.T) {
	t.Setenv(EnvBridgeStubPath, "")
	fixture := `{"type":"result","session_id":"s","result":"crashy","is_error":true,"stop_reason":"error"}`
	s := NewStreamer(nil).WithProcessSpawn(fakeProcess(fixture, "", nil))
	_, err := s.Stream(context.Background(), Request{
		Prompt:           "boom",
		HistorySessionID: "hist-err",
	}, func(stream.Chunk) {})
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "crashy") {
		t.Errorf("error should mention binary message, got %q", err)
	}
}

// TestStreamerNoOutputSurfacesStderr — when the binary exits non-zero
// without emitting a result, Stream returns an error including stderr.
func TestStreamerNoOutputSurfacesStderr(t *testing.T) {
	t.Setenv(EnvBridgeStubPath, "")
	s := NewStreamer(nil).WithProcessSpawn(fakeProcess("", "panic: something\n", errors.New("exit 1")))
	_, err := s.Stream(context.Background(), Request{
		Prompt:           "x",
		HistorySessionID: "hist-x",
	}, func(stream.Chunk) {})
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "panic") {
		t.Errorf("error should include stderr tail, got %q", err)
	}
}

// TestStreamerInitialStdinIsWritten — the fake spawn sees the JSONL
// envelope in initialStdin.
func TestStreamerInitialStdinIsWritten(t *testing.T) {
	t.Setenv(EnvBridgeStubPath, "")
	fixture := `{"type":"result","session_id":"s","result":"k","stop_reason":"end_turn"}`
	var seenStdin []byte
	spawn := func(ctx context.Context, opts SpawnOpts, initialStdin []byte) (ProcessHandles, error) {
		seenStdin = append([]byte(nil), initialStdin...)
		return fakeProcess(fixture, "", nil)(ctx, opts, initialStdin)
	}
	s := NewStreamer(nil).WithProcessSpawn(spawn)
	_, err := s.Stream(context.Background(), Request{
		Prompt: "hello world",
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

// TestStreamerMaterialisesMCPConfig — when YHA_BRIDGE_STUB_PATH is set
// the Streamer writes a transient JSON file and passes it via
// SpawnOpts.MCPConfigPath; the file is cleaned up after Stream returns.
func TestStreamerMaterialisesMCPConfig(t *testing.T) {
	t.Setenv(EnvBridgeStubPath, "/opt/yha-bridge-stub.js")
	fixture := `{"type":"result","session_id":"s","result":"ok","stop_reason":"end_turn"}`

	var seenMCPPath string
	spawn := func(ctx context.Context, opts SpawnOpts, initialStdin []byte) (ProcessHandles, error) {
		seenMCPPath = opts.MCPConfigPath
		// Confirm the file exists at spawn time.
		if seenMCPPath == "" {
			t.Errorf("expected MCPConfigPath to be set")
		}
		return fakeProcess(fixture, "", nil)(ctx, opts, initialStdin)
	}
	s := NewStreamer(nil).WithProcessSpawn(spawn)
	_, err := s.Stream(context.Background(), Request{
		Prompt: "ping",
		MCP: MCPConfigOpts{
			BridgeURL: "http://127.0.0.1:8443",
			SessionID: "sid-1",
		},
	}, func(stream.Chunk) {})
	if err != nil {
		t.Fatalf("Stream: %v", err)
	}
	if seenMCPPath == "" {
		t.Fatal("MCPConfigPath was empty in spawn opts")
	}
	// File should be cleaned up post-Stream.
	if _, statErr := os.Stat(seenMCPPath); !os.IsNotExist(statErr) {
		t.Errorf("MCP config file should have been removed, stat err = %v", statErr)
	}
}

// TestStreamerNilEmitRejected — defensive guard against a misconfigured
// caller.
func TestStreamerNilEmitRejected(t *testing.T) {
	t.Setenv(EnvBridgeStubPath, "")
	s := NewStreamer(nil).WithProcessSpawn(fakeProcess("", "", nil))
	_, err := s.Stream(context.Background(), Request{Prompt: "x"}, nil)
	if err == nil {
		t.Fatal("expected error for nil emit")
	}
}
