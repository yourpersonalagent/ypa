// Package claudesdk is the Go port of bridge/chat/agent.ts
// (runClaudeViaSdk / streamClaudeViaSdk).
//
// The Node path uses @anthropic-ai/claude-agent-sdk to drive a
// long-lived Claude agent session with MCP servers fully connected
// before the first turn. The SDK is a JS layer that spawns the same
// `claude` binary underneath; this Go port skips the JS layer and
// spawns the binary directly with the equivalent CLI flags.
//
// What this package owns:
//   - claudesdk.go (this file)  — Streamer.Stream entry + lifecycle
//   - spawn.go                  — subprocess builder (args, env, niceness)
//   - mcp_config.go             — transient --mcp-config JSON file
//   - events.go                 — stream-json parser → stream.Chunk
//   - harness.go                — harness.Harness adapter (registry-ready)
//   - home.go                   — deriveIsolatedHome port
//
// Status (Phase 6, 2026-05-11): scaffolded behind YHA_GO_CLAUDE_SDK
// env-var opt-in. The wiring agent flips classifier defaults; until
// then nothing routes here.
package claudesdk

import (
	"context"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
	"time"

	"github.com/yha/core/internal/logger"
	"github.com/yha/core/internal/stream"
)

// FinalizeKillTimeoutMs is the kill-watchdog delay. When the binary
// emits its final "result" we finalize the chunk stream immediately,
// then arm this timer so a hung child (e.g. mid TLS teardown of a
// stale MCP server) doesn't leak.
const FinalizeKillTimeoutMs = 30 * time.Second

// FinalizePayload is the post-stream data the caller's onFinalize
// hook sees once the turn wraps up. Mirrors the onDone payload Node's
// streamClaudeViaSdk hands to its caller — text, cost, stop reason,
// full token tally.
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

// Request packages everything the streamer needs from the route
// layer. The SDK harness doesn't use --resume (the Node path explicitly
// avoided it), so no HistorySessionID-to-binary-session-id resolver
// is needed — history is folded into Prompt by the caller.
type Request struct {
	// Prompt is the final composed user input (already includes any
	// history-injection the route layer chose to inline).
	Prompt string

	// HistorySessionID is informational here — used only for logging
	// + the FinalizePayload metadata. The SDK harness does not call a
	// SessionResolver since it doesn't issue --resume.
	HistorySessionID string

	// Spawn plugs straight through to BuildCmd. Note that Prompt is
	// NOT in SpawnOpts — it's input to the stdin writer.
	Spawn SpawnOpts

	// ImageBlocks — if non-empty, the initial JSONL message includes
	// them inside a multi-block content array. Each entry is the raw
	// JSON shape the binary expects.
	ImageBlocks []map[string]any

	// MCP holds the per-call MCP config opts. The Streamer materialises
	// a transient JSON file from these and points the binary at it via
	// --mcp-config. Empty MCP.BridgeURL = skip MCP wiring (logs a Warn).
	MCP MCPConfigOpts
}

// Streamer is the entry point for streaming spawns. One instance per
// daemon; safe for concurrent Stream calls.
type Streamer struct {
	log *logger.Logger

	// finalizeKillTimeout overrides FinalizeKillTimeoutMs for tests.
	finalizeKillTimeout time.Duration

	// processSpawn factors out the actual exec.Cmd Start/Wait pair so
	// tests can substitute a fake "binary" that streams scripted JSON.
	// Production sets this to spawnProcess; leaving it nil also works.
	processSpawn ProcessSpawnFn

	// stubWarnOnce protects the "no YHA_BRIDGE_STUB_PATH" warning so it
	// only fires the first time a Stream call discovers the missing
	// config (production logs would otherwise spam on every turn).
	// Pointer so the Streamer can be copy-modified via With* helpers
	// without tripping go vet's lock-copy check.
	stubWarnOnce *sync.Once
}

// NewStreamer returns a Streamer with the given logger. Logger may be
// nil — replaced with a no-op writer.
func NewStreamer(log *logger.Logger) *Streamer {
	if log == nil {
		log = logger.New(io.Discard)
	}
	return &Streamer{
		log:                 log,
		finalizeKillTimeout: FinalizeKillTimeoutMs,
		processSpawn:        spawnProcess,
		stubWarnOnce:        &sync.Once{},
	}
}

// WithProcessSpawn returns a copy of s with a custom spawn function.
// Used by tests to inject a fake subprocess. The original s is not
// mutated.
func (s *Streamer) WithProcessSpawn(fn ProcessSpawnFn) *Streamer {
	cp := *s
	cp.processSpawn = fn
	cp.stubWarnOnce = &sync.Once{}
	return &cp
}

// WithFinalizeKillTimeout returns a copy of s with the kill-watchdog
// timeout overridden. Tests use 0 / very small values to drive the
// watchdog path quickly.
func (s *Streamer) WithFinalizeKillTimeout(d time.Duration) *Streamer {
	cp := *s
	cp.finalizeKillTimeout = d
	cp.stubWarnOnce = &sync.Once{}
	return &cp
}

// Stream runs the binary, parses its stream-json output, and emits
// chunks via the supplied stream.EmitFn. Blocks until the binary
// exits or ctx is cancelled.
//
// Returns (finalize, error). finalize is non-nil only on a clean
// completion — error means the spawn failed or the binary emitted
// is_error=true.
//
// Lifecycle order:
//  1. Materialise the MCP config JSON (or skip + warn).
//  2. Build initial stdin payload (single JSONL user message).
//  3. Spawn the binary; kick off the parser goroutine.
//  4. Block until stdout EOFs or ctx is cancelled.
//  5. Arm finalize-watchdog after the last "result" event.
//  6. Wait on the process; surface stderr tail in any spawn error.
//  7. Emit final ChunkTypeDone and return FinalizePayload.
func (s *Streamer) Stream(
	ctx context.Context,
	req Request,
	emit stream.EmitFn,
) (*FinalizePayload, error) {
	if emit == nil {
		return nil, errors.New("claudesdk.Stream: emit must be non-nil")
	}

	// Step 1 — MCP config. WriteMCPConfig returns (nil, nil) when no
	// stub path is configured; we log a Warn once and continue.
	cfg, err := BuildMCPConfig(req.MCP)
	if err != nil {
		return nil, fmt.Errorf("claudesdk: build mcp config: %w", err)
	}
	var mcpFile *MCPConfigFile
	if cfg != nil {
		mcpFile, err = WriteMCPConfig(cfg)
		if err != nil {
			return nil, fmt.Errorf("claudesdk: write mcp config: %w", err)
		}
		req.Spawn.MCPConfigPath = mcpFile.Path
	} else {
		// stubWarnOnce may be nil if the caller constructed a zero-
		// value Streamer; guard so the helper still works.
		if s.stubWarnOnce != nil {
			s.stubWarnOnce.Do(func() {
				s.log.Warn("claudesdk.mcp-disabled",
					"reason", "YHA_BRIDGE_STUB_PATH not set; running without MCP servers")
			})
		}
	}
	defer func() {
		if mcpFile != nil {
			if cerr := mcpFile.Close(); cerr != nil {
				s.log.Warn("claudesdk.mcp-cleanup", "err", cerr, "path", mcpFile.Path)
			}
		}
	}()

	// Step 2 — initial stdin.
	initialStdin, err := buildInitialStdin(req.Prompt, req.ImageBlocks)
	if err != nil {
		return nil, fmt.Errorf("claudesdk: build initial stdin: %w", err)
	}

	// Step 3 — spawn.
	spawnFn := s.processSpawn
	if spawnFn == nil {
		spawnFn = spawnProcess
	}
	handles, err := spawnFn(ctx, req.Spawn, initialStdin)
	if err != nil {
		return nil, fmt.Errorf("claudesdk: spawn: %w", err)
	}
	defer func() {
		if handles.Kill != nil {
			_ = handles.Kill()
		}
	}()

	if handles.PID > 0 {
		if err := SetNiceness(handles.PID, req.Spawn.IsInteractive); err != nil {
			s.log.Warn("claudesdk.setpriority", "err", err, "pid", handles.PID)
		}
	}

	// Step 4 — parser goroutine.
	done := make(chan struct{})
	var (
		result     Result
		stats      EventStats
		processErr error
	)
	emitAdapter := EventEmit(func(c stream.Chunk) { emit(c) })
	go func() {
		defer close(done)
		result, stats, processErr = processStream(ctx, handles.Stdout, handles.Stderr, emitAdapter)
	}()

	ctxCancelled := false
	select {
	case <-done:
	case <-ctx.Done():
		ctxCancelled = true
		if handles.Kill != nil {
			_ = handles.Kill()
		}
		<-done
		if processErr == nil || processErr == io.EOF {
			processErr = ctx.Err()
		}
	}

	// Step 5 — finalize-watchdog.
	if s.finalizeKillTimeout > 0 && stats.ResultEvents > 0 && handles.Kill != nil {
		t := time.AfterFunc(s.finalizeKillTimeout, func() {
			s.log.Warn("claudesdk.finalize.kill-watchdog",
				"reason", "child did not exit within finalize timeout")
			_ = handles.Kill()
		})
		defer t.Stop()
	}

	// Step 6 — wait.
	var waitErr error
	if handles.Wait != nil {
		waitErr = handles.Wait()
	}

	// Error surface.
	if result.IsError {
		return nil, errors.New(result.ErrorMessage)
	}
	if ctxCancelled {
		return nil, ctx.Err()
	}
	if processErr != nil && processErr != io.EOF && !errors.Is(processErr, context.Canceled) {
		return nil, fmt.Errorf("claudesdk: processStream: %w", processErr)
	}
	if result.Text == "" && waitErr != nil {
		stderrTail := stats.StderrText
		if len(stderrTail) > 200 {
			stderrTail = stderrTail[len(stderrTail)-200:]
		}
		return nil, fmt.Errorf("claudesdk: binary exited: %v (stderr: %s)", waitErr, strings.TrimSpace(stderrTail))
	}

	// Step 7 — final done chunk + return.
	emit(stream.Chunk{
		Type:       stream.ChunkTypeDone,
		Text:       result.Text,
		DoneReason: result.StopReason,
		Provider:   "claude-sdk",
	})

	return &FinalizePayload{
		Text:                result.Text,
		Cost:                result.Cost,
		StopReason:          result.StopReason,
		InputTokens:         result.InputTokens,
		OutputTokens:        result.OutputTokens,
		CacheCreationTokens: result.CacheCreationTokens,
		CacheReadTokens:     result.CacheReadTokens,
		ClaudeSessionID:     result.ClaudeSessionID,
	}, nil
}
