// Package grokbuild hosts the Go harness for the `grok` CLI (xAI's
// Grok Build agent). It spawns the binary in headless mode
// (`grok -p <prompt> --output-format streaming-json --always-approve`
// or --prompt-file for long prompts) and translates NDJSON into
// unified stream.Chunk (delta/reasoning/tool_use/tool_result/done).
//
// Wire format (2026+; legacy still accepted):
//
//	{"type":"session.start", "sessionId":"..."}
//	{"type":"model.thinking", "data":"..."}   // or "thought"
//	{"type":"tool.call", "id":"t1", "tool":"Bash", "args":{...}}
//	{"type":"tool.result", "id":"t1", "content":"..."}
//	{"type":"model.message", "data":"..."}    // or "text"
//	{"type":"session.end", "stopReason":"EndTurn", "sessionId":"..."}
//
// (usage may appear on end or as sibling event; tokens/cost often 0
// for subscription tiers — real metering on xAI side.)
//
// Resume: --resume <sid> (or --session-id) is wired; the caller
// supplies the sid from a prior session.end via harness.History so
// long agentic sessions keep the CLI's native context/plan/tool state
// instead of lossy 16-turn text folds.
//
// Unknown events are skipped (safe on CLI evolution). Tool events now
// produce proper ChunkTypeToolUse/Result so blocks.go, rewind, and FE
// render rich cards identical to claude-binary/codex.
//
// The package matches codex/claudebinary layout for future extraction.
package grokbuild

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/yha/core/internal/stream"
)

// StartupTimeout kills a grok subprocess that spawns but produces no stdout
// at all (auth/network hang, missing binary on PATH, etc.). Cleared on the
// first non-empty stdout line — including session.start and other events that
// do not surface to the UI — so a long thinking gap after the CLI has
// connected does not trip this watchdog.
const StartupTimeout = 90 * time.Second

// Streamer is the engine that drives one subprocess per Run call.
// Safe for concurrent use; each call owns its own pipes + parser state.
type Streamer struct {
	runFn func(ctx context.Context, opts SpawnOpts) (io.ReadCloser, io.ReadCloser, func() error, func() error, error)
}

// NewStreamer returns a Streamer that drives a real grok subprocess.
func NewStreamer() *Streamer { return &Streamer{} }

type emitFn = stream.EmitFn

// runResult is the engine's internal per-turn output; the public
// Grokbuild adapter in harness.go wraps it into Result.
type runResult struct {
	Text       string
	StopReason string
	SessionID  string

	// Tokens when surfaced by the CLI on session.end (or usage event).
	// Often zero today (subscription model); when non-zero they flow
	// through Result.Usage into finalize / cost ledger.
	InputTokens  int64
	OutputTokens int64

	// Model if the CLI reported the resolved model id (e.g. on start/end).
	// Flows to Result.Usage.Model so the settled meta bar can show the
	// precise one when more specific than the request.
	Model string
}

// Run launches grok, parses its JSON-Lines stdout, and emits
// stream.Chunk events via emit. Returns when the subprocess exits.
// Cancellation: ctx.Done kills the subprocess; Run returns ctx.Err().
func (s *Streamer) Run(ctx context.Context, req runRequest, emit emitFn) (runResult, error) {
	if emit == nil {
		return runResult{}, errors.New("grokbuild.Run: emit must be non-nil")
	}
	if strings.TrimSpace(req.Prompt) == "" {
		return runResult{}, errors.New("grokbuild.Run: prompt required")
	}

	opts := req.Spawn
	if opts.Model == "" {
		opts.Model = req.Model
	}
	opts.Prompt = req.Prompt

	stdout, stderr, wait, kill, err := s.start(ctx, opts)
	if err != nil {
		return runResult{}, fmt.Errorf("grokbuild.Run: spawn: %w", err)
	}

	var sawStdout atomic.Bool
	startupTimer := time.AfterFunc(StartupTimeout, func() {
		if sawStdout.Load() {
			return
		}
		if kill != nil {
			_ = kill()
		}
	})
	defer startupTimer.Stop()
	onStdoutActivity := func() {
		if !sawStdout.Swap(true) {
			startupTimer.Stop()
		}
	}
	wrappedEmit := func(ch stream.Chunk) {
		onStdoutActivity()
		emit(ch)
	}

	// Drain stderr; keep the last ~4 KiB for error reporting.
	var stderrTail strings.Builder
	stderrDone := make(chan struct{})
	go func() {
		defer close(stderrDone)
		buf := make([]byte, 4096)
		for {
			n, rerr := stderr.Read(buf)
			if n > 0 {
				if stderrTail.Len()+n > 4096 {
					existing := stderrTail.String()
					stderrTail.Reset()
					keep := 4096 - n
					if keep > 0 && len(existing) > keep {
						stderrTail.WriteString(existing[len(existing)-keep:])
					}
				}
				stderrTail.Write(buf[:n])
			}
			if rerr != nil {
				return
			}
		}
	}()

	text, stopReason, sessionID, grokErr, inTok, outTok, model, readErr := processStream(stdout, wrappedEmit, onStdoutActivity)
	<-stderrDone
	exitErr := wait()

	// A non-EOF read error means grok's stdout was cut off mid-turn (broken
	// pipe, killed child, or a line we couldn't read). The turn is NOT
	// complete, so surface it as an error even when we managed to buffer
	// partial text — otherwise the caller persists a truncated reply as a
	// clean end_turn and the tail silently disappears.
	if readErr != nil {
		msg := strings.TrimSpace(grokErr)
		if msg == "" {
			msg = "grok stream interrupted: " + readErr.Error()
		}
		if tail := strings.TrimSpace(stderrTail.String()); tail != "" {
			if len(tail) > 300 {
				tail = tail[len(tail)-300:]
			}
			msg += " (" + tail + ")"
		}
		emit(stream.Chunk{Type: stream.ChunkTypeError, Error: msg})
		return runResult{Text: text, StopReason: "error", SessionID: sessionID, InputTokens: inTok, OutputTokens: outTok, Model: model}, errors.New(msg)
	}

	if exitErr != nil && strings.TrimSpace(text) == "" {
		msg := grokErr
		if msg == "" {
			tail := strings.TrimSpace(stderrTail.String())
			if len(tail) > 300 {
				tail = tail[:300]
			}
			msg = tail
		}
		if msg == "" && !sawStdout.Load() {
			msg = fmt.Sprintf("grok produced no output within %s — check `grok login` and binary path", StartupTimeout)
		}
		if msg == "" {
			msg = fmt.Sprintf("grok exited: %v", exitErr)
		}
		emit(stream.Chunk{Type: stream.ChunkTypeError, Error: msg})
		return runResult{Text: text, StopReason: "error", SessionID: sessionID, InputTokens: inTok, OutputTokens: outTok, Model: model}, errors.New(msg)
	}
	if strings.TrimSpace(text) == "" {
		if grokErr != "" {
			emit(stream.Chunk{Type: stream.ChunkTypeError, Error: grokErr})
			return runResult{StopReason: "error", SessionID: sessionID, InputTokens: inTok, OutputTokens: outTok, Model: model}, errors.New(grokErr)
		}
		tail := strings.TrimSpace(stderrTail.String())
		if tail != "" {
			if len(tail) > 300 {
				tail = tail[:300]
			}
			msg := "grok produced no response: " + tail
			emit(stream.Chunk{Type: stream.ChunkTypeError, Error: msg})
			return runResult{StopReason: "error", SessionID: sessionID, InputTokens: inTok, OutputTokens: outTok, Model: model}, errors.New(msg)
		}
	}

	emit(stream.Chunk{Type: stream.ChunkTypeDone, DoneReason: normalizeStopReason(stopReason)})
	return runResult{Text: text, StopReason: normalizeStopReason(stopReason), SessionID: sessionID, InputTokens: inTok, OutputTokens: outTok, Model: model}, nil
}

// start launches the subprocess and returns (stdout, stderr, wait, kill, err).
// In production runFn is nil and we call spawnCmd → process.Start;
// tests set runFn to drive fixture readers.
func (s *Streamer) start(ctx context.Context, opts SpawnOpts) (io.ReadCloser, io.ReadCloser, func() error, func() error, error) {
	if s.runFn != nil {
		return s.runFn(ctx, opts)
	}
	cleanup := func() {}
	if opts.PromptFile == "" && len(opts.Prompt) > 8000 {
		f, err := os.CreateTemp("", "yha-grok-prompt-*.txt")
		if err != nil {
			return nil, nil, nil, nil, err
		}
		if _, err := f.WriteString(opts.Prompt); err != nil {
			_ = f.Close()
			_ = os.Remove(f.Name())
			return nil, nil, nil, nil, err
		}
		if err := f.Close(); err != nil {
			_ = os.Remove(f.Name())
			return nil, nil, nil, nil, err
		}
		opts.PromptFile = f.Name()
		opts.Prompt = ""
		cleanup = func() { _ = os.Remove(f.Name()) }
	}
	cmd := spawnCmd(ctx, opts)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cleanup()
		return nil, nil, nil, nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		cleanup()
		return nil, nil, nil, nil, err
	}
	if err := cmd.Start(); err != nil {
		cleanup()
		return nil, nil, nil, nil, err
	}
	kill := func() error {
		if cmd.Process == nil {
			return nil
		}
		return cmd.Process.Kill()
	}
	wait := func() error {
		defer cleanup()
		return waitProcess(cmd)
	}
	return stdout, stderr, wait, kill, nil
}

func waitProcess(cmd *exec.Cmd) error {
	if err := cmd.Wait(); err != nil {
		return err
	}
	return nil
}

// processStream consumes the grok JSON-Lines stdout, emits delta /
// reasoning / tool_use / tool_result / error chunks via emit, and
// returns the assembled text + terminal stopReason + sessionId (for
// --resume roundtrip) + any grok error + tokens if the CLI emitted
// usage on end/session.end + model name if CLI reported one.
func processStream(stdout io.Reader, emit emitFn, onActivity func()) (string, string, string, string, int64, int64, string, error) {
	// bufio.Reader (not Scanner): grok's agentic streaming-json emits
	// single NDJSON lines that routinely blow past any fixed cap — a large
	// model.message block, or a tool.result carrying a big diff / file read.
	// (Historical: a bufio.Scanner with a 1 MiB cap hit bufio.ErrTooLong on
	// such a line, stopped silently, and the rest of the turn vanished while
	// Run still reported a clean end_turn — "grok started answering then nothing
	// showed".) ReadString grows to fit any line and lets us distinguish a
	// clean EOF from a broken pipe / killed child so an interrupted turn is
	// surfaced as an error (and with the route harness fix, always produces a
	// persisted assistant row instead of a silent missing reply).
	reader := bufio.NewReaderSize(stdout, 64*1024)

	var (
		mu         sync.Mutex
		fullText   strings.Builder
		stopReason string
		sessionID  string
		grokErr    string
		inTokens   int64
		outTokens  int64
		model      string
		readErr    error
	)

	for {
		line, err := reader.ReadString('\n')
		if strings.TrimSpace(line) != "" && onActivity != nil {
			onActivity()
		}
		if len(line) == 0 {
			if err != nil {
				if err != io.EOF {
					readErr = err
				}
				break
			}
			continue
		}
		p := parseLine(line)
		switch p.kind {
		case lineSkip:
			continue
		case lineDelta:
			mu.Lock()
			fullText.WriteString(p.delta)
			mu.Unlock()
			emit(stream.Chunk{Type: stream.ChunkTypeDelta, Delta: p.delta})
		case lineReasoning:
			emit(stream.Chunk{Type: stream.ChunkTypeReasoning, Text: p.delta})
		case lineEnd:
			if p.stopReason != "" {
				stopReason = p.stopReason
			}
			if p.sessionID != "" {
				sessionID = p.sessionID
			}
			if p.inputTokens > 0 {
				inTokens = p.inputTokens
			}
			if p.outputTokens > 0 {
				outTokens = p.outputTokens
			}
			if p.model != "" {
				model = p.model
			}
		case lineErr:
			if grokErr == "" {
				grokErr = p.errMsg
			}
		case lineToolUse:
			id := p.toolID
			if id == "" {
				id = "grok-" + strings.ToLower(strings.ReplaceAll(p.toolName, " ", "-"))
			}
			input := map[string]any{}
			switch v := p.toolArgs.(type) {
			case map[string]any:
				input = v
			case nil:
			default:
				if b, err := json.Marshal(v); err == nil {
					input = map[string]any{"_raw": string(b)}
				}
			}
			emit(stream.Chunk{
				Type: stream.ChunkTypeToolUse,
				ToolUse: &stream.ToolUseChunk{
					ID:    id,
					Name:  p.toolName,
					Input: input,
				},
			})
		case lineToolResult:
			emit(stream.Chunk{
				Type: stream.ChunkTypeToolResult,
				ToolResult: &stream.ToolResultChunk{
					ID:      p.resultID,
					OK:      true,
					Content: p.resultContent,
				},
			})
		}
		if err != nil {
			if err != io.EOF {
				readErr = err
			}
			break
		}
	}
	return fullText.String(), stopReason, sessionID, grokErr, inTokens, outTokens, model, readErr
}

// normalizeStopReason maps grok's stopReason vocabulary
// ("EndTurn", "ToolUse", "MaxTokens", ...) to YHA's Anthropic-aligned
// stop_reason names ("end_turn", "tool_use", "max_tokens").
// Unknown values pass through lower-cased.
func normalizeStopReason(s string) string {
	switch strings.TrimSpace(s) {
	case "", "EndTurn", "end_turn", "Stop", "stop":
		return "end_turn"
	case "MaxTokens", "max_tokens":
		return "max_tokens"
	case "ToolUse", "tool_use":
		return "tool_use"
	}
	return strings.ToLower(s)
}

// runRequest is the engine input. Kept separate from the public Request
// so the public surface can evolve without touching the engine.
type runRequest struct {
	Prompt string
	Model  string
	Spawn  SpawnOpts
}

// firstNonEmpty returns the first non-blank string (used to prefer a
// CLI-reported model name over the request one for the final meta bar).
func firstNonEmpty(a, b string) string {
	if strings.TrimSpace(a) != "" {
		return a
	}
	return b
}
