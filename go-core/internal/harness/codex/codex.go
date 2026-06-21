package codex

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/yha/core/internal/stream"
)

// defaultSilenceTimeout is how long codex may produce ZERO stdout
// before we consider the turn wedged and tear it down. Mirrors the
// bridge's silenceTimeoutMs (bridge/providers/codex.ts:337) — the Go
// port originally dropped this guard, which let a stalled subprocess
// (stdin never consumed, or a hanging shell tool) sit silent for
// minutes detached from the disconnected client before anything
// noticed. We do NOT cap total turn duration (route_harness owns the
// deliberate no-hard-ceiling policy for long reasoning turns); we only
// catch genuine silence.
const defaultSilenceTimeout = 90 * time.Second

// maxCodexLineBytes caps how many bytes of a single codex stdout line we keep
// in memory before truncating. Generous enough for any legitimate event
// (codex truncates its own tool output well below this in the rollout); the cap
// exists only so a pathological multi-MB line — e.g. `grep` over a minified
// bundle — can't bloat memory or, with the old bufio.Scanner, fatally abort the
// turn. Overflow past the cap is read and discarded up to the next newline.
const maxCodexLineBytes = 4 * 1024 * 1024

// defaultEmitTimeout is the maximum time the codex stdout consumer will
// wait for downstream emit() processing. emit is supposed to be quick
// (buffer append + non-blocking fan-out), but the live codex deadlock
// proved a route-side lock/channel can still park it forever. If that
// happens, keep parsing stdout and let the turn finalize instead of
// backpressuring codex into a full-pipe write() zombie.
const defaultEmitTimeout = 15 * time.Second

// defaultProcessExitTimeout is the grace window after we cancel codex
// for the OS process to actually exit. It prevents a completed/errored
// parser path from parking forever in cmd.Wait/stderr drain while the
// frontend row remains streaming=true.
const defaultProcessExitTimeout = 10 * time.Second

// Streamer is the public façade for the codex CLI harness. One
// instance per daemon; safe for concurrent Run calls.
//
// Usage:
//
//	s := codex.New()
//	res, err := s.Run(ctx, codex.Request{...}, emit)
//	// res.Usage carries the NET token counts for cost-event
//	// emit receives stream.Chunk per parsed event
//
// Tests mock the subprocess via the runFn field — see TestRun in
// codex_test.go. Production paths use the default exec.CommandContext
// path through spawnCmd.
type Streamer struct {
	// runFn is the injection seam for tests. In production it's nil
	// and Run uses spawnCmd + process.Start. Unit tests set it to a
	// closure that returns fixture readers + an exit-error channel.
	runFn func(ctx context.Context, opts SpawnOpts) (io.ReadCloser, io.ReadCloser, func() error, error)
}

// NewStreamer builds a Streamer that talks to a real codex binary.
// It's the engine the harness.go Codex value wraps. External callers
// generally want New() in harness.go instead — Streamer is exported
// only so the wire-up step can plumb test seams.
func NewStreamer() *Streamer { return &Streamer{} }

// newWithRunner is the test-only constructor (events_test.go +
// codex_test.go). Keeps the public surface clean.
func newWithRunner(fn func(ctx context.Context, opts SpawnOpts) (io.ReadCloser, io.ReadCloser, func() error, error)) *Streamer {
	return &Streamer{runFn: fn}
}

// runResult is the engine's per-turn return shape. It feeds into the
// public Result in harness.go after the harness fills in StopReason /
// Err / Cost. Kept unexported because callers go through Codex.Stream.
type runResult struct {
	Text  string
	Usage rawUsage
}

// emitFn is the per-chunk callback shape. We mirror stream.EmitFn so
// route handlers can pass their own emit directly without an adapter.
type emitFn = stream.EmitFn

// Run launches a codex subprocess, parses its JSON-Lines stdout, and
// emits stream.Chunk events via emit. Returns when the process exits
// (clean or error). The returned error is non-nil only when the
// subprocess produced no usable output AND the parser saw no error
// event — i.e. a true infrastructure failure (codex not on PATH,
// permission denied, sandbox-killed early, etc.).
//
// Cancellation: when ctx is cancelled, exec.CommandContext kills the
// subprocess and Run returns ctx.Err(). The emit closure may still
// fire one final error chunk before Run returns.
//
// Concurrency: Run is reentrant; multiple goroutines can call it on
// the same Streamer (each call gets its own subprocess + parser
// state). Inside a single Run, emit is called from one goroutine
// (the stdout parser); callers don't need to serialise on the emit
// side.
func (s *Streamer) Run(ctx context.Context, req runRequest, emit emitFn) (runResult, error) {
	if emit == nil {
		return runResult{}, errors.New("codex.Run: emit must be non-nil")
	}
	if strings.TrimSpace(req.Prompt) == "" {
		return runResult{}, errors.New("codex.Run: prompt required")
	}

	opts := req.Spawn
	opts.Stdin = req.Prompt
	if opts.Model == "" {
		opts.Model = req.Model
	}

	// Codex's protocol has an explicit terminal event (turn.completed).
	// Give the subprocess its own cancellable context so that event can
	// release a CLI whose stdout/process remains open after the turn is
	// semantically complete, without cancelling the parent stream context.
	procCtx, procCancel := context.WithCancel(ctx)
	defer procCancel()
	stdout, stderr, wait, err := s.start(procCtx, opts)
	if err != nil {
		return runResult{}, fmt.Errorf("codex.Run: spawn: %w", err)
	}

	// Silence watchdog. Codex exec is supposed to stream JSON-Lines
	// continuously; a window with zero stdout means it's wedged —
	// classically the stdin EOF never landed (so codex sits at
	// "Reading prompt from stdin...") or a tool call hung. Without this
	// the subprocess can stay alive and silent for minutes, especially
	// after the watching client disconnected (the adapter runs on a
	// detached context, so nothing else would notice). We reset the
	// clock on every stdout read; on expiry we cancel procCtx, which
	// kills the subprocess and unblocks the scanner below.
	silence := req.SilenceTimeout
	if silence <= 0 {
		silence = defaultSilenceTimeout
	}
	var (
		lastActivityNano atomic.Int64
		watchdogTripped  atomic.Bool
	)
	lastActivityNano.Store(time.Now().UnixNano())
	watchdogStop := make(chan struct{})
	go func() {
		// Poll a few times per window so a trip is detected within
		// ~silence/3 of the deadline without a busy loop.
		interval := silence / 3
		if interval < time.Second {
			interval = time.Second
		}
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-watchdogStop:
				return
			case <-procCtx.Done():
				return
			case <-ticker.C:
				last := time.Unix(0, lastActivityNano.Load())
				if time.Since(last) >= silence {
					watchdogTripped.Store(true)
					procCancel()
					return
				}
			}
		}
	}()
	parseSrc := &activityReader{r: stdout, bump: func() { lastActivityNano.Store(time.Now().UnixNano()) }}

	// Drain stderr concurrently. Codex writes infrequent log lines
	// here; we keep the last ~4 KiB for the error message but
	// otherwise discard.
	var stderrTail strings.Builder
	stderrDone := make(chan struct{})
	go func() {
		defer close(stderrDone)
		buf := make([]byte, 4096)
		for {
			n, rerr := stderr.Read(buf)
			if n > 0 {
				// Keep at most 4 KiB.
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

	// Drive the parser loop on stdout. processStream is factored out
	// so events_test.go can drive it with fixture readers.
	text, usage, codexErr, turnCompleted := processStream(parseSrc, emit)
	close(watchdogStop)

	// Once stdout parsing returns, this one-shot codex process no longer has
	// a reason to stay alive. Always cancel its process context before any
	// blocking waits. This is deliberately broader than the terminal-event
	// path: if the scanner exits early (malformed/oversize line, pipe error,
	// unexpected EOF), waiting for stderr EOF before killing codex can wedge
	// forever while codex is still trying to write stdout.
	procCancel()

	// Wait on the subprocess before waiting on stderr EOF. stderr is already
	// being drained concurrently; the important ordering is that process
	// termination is what closes stderr, not the other way around.
	waitDone := make(chan error, 1)
	go func() { waitDone <- wait() }()
	var exitErr error
	select {
	case exitErr = <-waitDone:
	case <-time.After(defaultProcessExitTimeout):
		exitErr = fmt.Errorf("codex process did not exit within %s after stdout parser returned", defaultProcessExitTimeout)
	}

	// Wait briefly for stderr drain so we don't truncate the tail before
	// composing the error message, but never let stderr bookkeeping keep the
	// DB row streaming forever.
	select {
	case <-stderrDone:
	case <-time.After(2 * time.Second):
	}
	if turnCompleted {
		// procCancel may make Wait report a killed/cancelled process. The
		// protocol already declared success, so that status is cleanup noise.
		exitErr = nil
	}

	// Silence watchdog tripped: codex went quiet past the window and we
	// killed it. Surface a specific error instead of the generic
	// "codex exited" / "no response" message so the FE (and logs) make
	// the stall diagnosable. We only do this when the turn didn't
	// already complete — a late kill after turn.completed is harmless.
	if watchdogTripped.Load() && !turnCompleted {
		secs := int(silence / time.Second)
		msg := codexErr
		if msg == "" {
			if tail := strings.TrimSpace(stderrTail.String()); tail != "" {
				if len(tail) > 200 {
					tail = tail[len(tail)-200:]
				}
				msg = fmt.Sprintf("codex produced no output for %ds and was stopped (last log: %s)", secs, tail)
			} else {
				msg = fmt.Sprintf("codex produced no output for %ds and was stopped — likely a stalled prompt/stdin or a hanging tool call", secs)
			}
		}
		emitWithTimeout(emit, stream.Chunk{Type: stream.ChunkTypeError, Error: msg})
		return runResult{Text: text, Usage: usage}, errors.New(msg)
	}

	// Decide success vs error. Mirrors codex.ts:425-447, extended:
	//   - non-zero exit + no text → error
	//   - empty text + codex error event → error
	//   - empty text + stderr → error
	//   - codex error event with partial text → propagate error (don't swallow)
	//   - otherwise → emit done
	if exitErr != nil && strings.TrimSpace(text) == "" {
		msg := codexErr
		if msg == "" {
			tail := strings.TrimSpace(stderrTail.String())
			if len(tail) > 300 {
				tail = tail[:300]
			}
			msg = tail
		}
		if msg == "" {
			msg = fmt.Sprintf("codex exited: %v", exitErr)
		}
		emitWithTimeout(emit, stream.Chunk{Type: stream.ChunkTypeError, Error: msg})
		return runResult{Text: text, Usage: usage}, errors.New(msg)
	}
	if strings.TrimSpace(text) == "" {
		if codexErr != "" {
			emitWithTimeout(emit, stream.Chunk{Type: stream.ChunkTypeError, Error: codexErr})
			return runResult{Usage: usage}, errors.New(codexErr)
		}
		tail := strings.TrimSpace(stderrTail.String())
		if tail != "" {
			if len(tail) > 300 {
				tail = tail[:300]
			}
			msg := "codex produced no response: " + tail
			emitWithTimeout(emit, stream.Chunk{Type: stream.ChunkTypeError, Error: msg})
			return runResult{Usage: usage}, errors.New(msg)
		}
		// Empty output, no error — surface as a done event regardless
		// so the FE doesn't hang. Caller decides whether to treat
		// empty as an error upstream.
	}

	// When codex emitted an error or turn.failed event alongside partial
	// text (e.g. context-length exceeded, rate limit, auth failure mid-
	// stream), the old "otherwise → done" path swallowed it and the FE
	// showed a clean truncated response with no indication of the failure.
	// Return the error so dispatchHarnessAdapter surfaces it to the FE.
	// We do NOT emit ChunkTypeError here — the route handler emits it once
	// after the adapter returns, avoiding a duplicate error chunk.
	if codexErr != "" {
		return runResult{Text: text, Usage: usage}, errors.New(codexErr)
	}
	emitWithTimeout(emit, stream.Chunk{Type: stream.ChunkTypeDone, DoneReason: "stop"})
	return runResult{Text: text, Usage: usage}, nil
}

// start launches the subprocess and returns (stdout, stderr,
// wait-fn, err). The wait-fn closes the underlying pipes implicitly
// by waiting on the process. Caller's responsibility: read both
// pipes to EOF before invoking wait, otherwise the subprocess can
// deadlock on its stdout write side.
//
// In production runFn is nil and we call spawnCmd → process.Start.
// In tests runFn is supplied directly so the harness can drive
// fixture readers.
func (s *Streamer) start(ctx context.Context, opts SpawnOpts) (io.ReadCloser, io.ReadCloser, func() error, error) {
	if s.runFn != nil {
		return s.runFn(ctx, opts)
	}
	cmd := spawnCmd(ctx, opts)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, nil, nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return nil, nil, nil, err
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		return nil, nil, nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, nil, nil, err
	}

	// Pump stdin in a goroutine — codex's exec mode reads to EOF
	// before producing any stdout events.
	go func() {
		_ = writePromptThenClose(stdin, opts.Stdin)
	}()

	wait := func() error {
		return waitProcess(cmd)
	}
	return stdout, stderr, wait, nil
}

// waitProcess wraps cmd.Wait so codex.go can call it without a
// direct exec.Cmd dependency in the public surface. Wait returns
// *ExitError when the process exited non-zero, which we surface as
// the spawned-process error.
func waitProcess(cmd *exec.Cmd) error {
	if err := cmd.Wait(); err != nil {
		return err
	}
	return nil
}

// processStream is the loop unit-tests target. It owns the line
// buffer, the parseState (start/complete dedup + function_call
// argument accumulation), and the emit-side translation from
// codex's wire format to stream.Chunk.
//
// Returns (fullText, usage, codexErrMsg, turnCompleted). On parser-level error
// (e.g. unreadable stdout pipe), the function still returns what it
// managed to accumulate so the caller can compose the right error.
//
// Decoupled drain: a dedicated goroutine reads stdout to EOF, parses
// each line, and pushes the result onto an UNBOUNDED queue; the loop
// below consumes from the queue and calls emit. This is the structural
// fix for the codex stdout-consumer deadlock [[codex-stdout-deadlock]].
// Previously parseLine + emit ran inline in the read loop, so if any
// emit() call stalled (a slow/blocked downstream persist or fan-out),
// scanner.Scan() stopped, codex's 64 KiB stdout pipe filled, and codex
// blocked forever in write() — finishing the turn internally
// (task_complete in its rollout) while go-core never saw it. The row
// hung streaming:true until the bridge's 60-min sweep finalized it
// empty, and codex zombied alive holding its MCP child. By always
// draining stdout in its own goroutine, codex can never be
// backpressured: it runs to task_complete and exits cleanly even if the
// emit side is wedged, and every parsed event up to the terminal one is
// captured. The queue is bounded in practice by the turn size (codex
// exec is one-shot and ends the turn), so "unbounded" can't grow without
// limit.
func processStream(stdout io.Reader, emit emitFn) (string, rawUsage, string, bool) {
	// Codex writes JSON-Lines. We read newline-delimited lines with a
	// bufio.Reader, NOT a bufio.Scanner. A single tool result can blow past
	// any fixed cap — e.g. `grep` matching a minified bundle emits one
	// multi-MB line on stdout (codex truncates it in its own rollout but
	// streams the full thing to us). bufio.Scanner treats an over-cap line as
	// a fatal, NON-resumable error (bufio.ErrTooLong); that used to kill the
	// whole turn ("codex stdout scan error: token too long") before codex's
	// final answer ever arrived. Instead readLineTruncated caps each line at
	// maxCodexLineBytes, discards the overflow up to the next newline, and
	// keeps going: the giant event is dropped (a truncated line is invalid
	// JSON and parses to lineSkip) but the stream proceeds to task_complete.
	br := bufio.NewReaderSize(stdout, 64*1024)

	state := newParseState()
	q := newParsedQueue()

	// Drain goroutine: the ONLY reader of stdout. It must never block on
	// the consumer, so it pushes onto the unbounded queue and keeps
	// going. It runs until EOF (clean turn-end, or codex killed by the
	// watchdog/procCancel, both of which close stdout).
	go func() {
		for {
			line, _, err := readLineTruncated(br, maxCodexLineBytes)
			if line != "" {
				q.push(parseLine(line, state))
			}
			if err != nil {
				if err != io.EOF {
					// A real read failure (not a clean EOF). Surface it so Run
					// doesn't believe stdout ended cleanly and wait forever for
					// a still-running codex process.
					q.push(parsed{kind: lineErr, errMsg: "codex stdout read error: " + err.Error()})
				}
				break
			}
		}
		q.close()
	}()

	var (
		fullText      strings.Builder
		usage         rawUsage
		codexErrMsg   string
		turnCompleted bool
	)

	for {
		p, ok := q.pop()
		if !ok {
			break // queue closed and drained (stdout EOF)
		}
		switch p.kind {
		case lineSkip:
			continue
		case lineDelta:
			fullText.WriteString(p.delta)
			emitWithTimeout(emit, stream.Chunk{Type: stream.ChunkTypeDelta, Delta: p.delta})
		case lineToolUse:
			emitWithTimeout(emit, toChunkToolUse(p.toolUse))
		case lineToolResult:
			emitWithTimeout(emit, toChunkToolResult(p.toolRes))
		case lineToolUseAndResult:
			if p.toolUse != nil {
				emitWithTimeout(emit, toChunkToolUse(p.toolUse))
			}
			if p.toolRes != nil {
				emitWithTimeout(emit, toChunkToolResult(p.toolRes))
			}
		case lineUsage:
			turnCompleted = true
			if p.usage != nil {
				usage = *p.usage
			}
			// This is the semantic end of the one-shot exec turn. Do not wait
			// for EOF: some Codex/MCP combinations leave an inherited handle
			// open after emitting turn.completed. The drain goroutine keeps
			// running until stdout closes (procCancel in Run kills codex);
			// the unbounded queue means it never blocks on our exit.
		case lineErr:
			if codexErrMsg == "" {
				codexErrMsg = p.errMsg
			}
		}
		if turnCompleted {
			break
		}
	}
	return fullText.String(), usage, codexErrMsg, turnCompleted
}

// parsedQueue is an unbounded FIFO of parsed events handed from the
// stdout drain goroutine to the emit consumer in processStream. Unbounded
// is deliberate: it's what lets the drain goroutine read codex's stdout
// to EOF without ever blocking on a stalled consumer, which is the whole
// point of the decoupling (see processStream). Bounded in practice by the
// turn's event count.
type parsedQueue struct {
	mu     sync.Mutex
	cond   *sync.Cond
	items  []parsed
	closed bool
}

func newParsedQueue() *parsedQueue {
	q := &parsedQueue{}
	q.cond = sync.NewCond(&q.mu)
	return q
}

// push appends an item and wakes a waiting pop. No-op after close so a
// late scanner read (post-consumer-exit) can't panic or leak.
func (q *parsedQueue) push(p parsed) {
	q.mu.Lock()
	if !q.closed {
		q.items = append(q.items, p)
		q.cond.Signal()
	}
	q.mu.Unlock()
}

// close marks the queue done; pop drains remaining items then reports
// !ok. Wakes every waiter.
func (q *parsedQueue) close() {
	q.mu.Lock()
	q.closed = true
	q.cond.Broadcast()
	q.mu.Unlock()
}

// pop blocks until an item is available or the queue is closed AND
// drained. Returns (item, true) while items remain (even after close, so
// the terminal task_complete buffered just before EOF is still
// processed), or (zero, false) once closed and empty.
func (q *parsedQueue) pop() (parsed, bool) {
	q.mu.Lock()
	defer q.mu.Unlock()
	for len(q.items) == 0 && !q.closed {
		q.cond.Wait()
	}
	if len(q.items) == 0 {
		return parsed{}, false
	}
	p := q.items[0]
	q.items[0] = parsed{} // release reference for GC
	q.items = q.items[1:]
	return p, true
}

// readLineTruncated reads one '\n'-terminated line from br, keeping at most
// maxBytes of it. Any bytes beyond maxBytes (up to and including the newline)
// are read and discarded so the NEXT call starts cleanly on the following line.
// Returns the line without its trailing newline, whether it was truncated, and
// an error (io.EOF at a clean end-of-stream, after returning any final
// newline-less line).
//
// Unlike bufio.Scanner, an over-long line is NOT a fatal error — the stream
// keeps flowing. Unlike bufio.Reader.ReadString/ReadBytes, memory stays bounded
// by maxBytes no matter how long the physical line is.
func readLineTruncated(br *bufio.Reader, maxBytes int) (string, bool, error) {
	var buf []byte
	truncated := false
	for {
		frag, err := br.ReadSlice('\n')
		if len(frag) > 0 {
			// frag aliases br's internal buffer and is only valid until the
			// next read, so copy what we keep right now.
			switch room := maxBytes - len(buf); {
			case room <= 0:
				truncated = true // already at the cap; drop this fragment
			case len(frag) <= room:
				buf = append(buf, frag...)
			default:
				buf = append(buf, frag[:room]...)
				truncated = true
			}
		}
		switch err {
		case nil:
			// frag ended with the delimiter; strip a trailing \r\n.
			return strings.TrimRight(string(buf), "\r\n"), truncated, nil
		case bufio.ErrBufferFull:
			continue // line longer than br's buffer — more fragments follow
		default:
			// io.EOF or a real read error: return what we accumulated.
			return strings.TrimRight(string(buf), "\r\n"), truncated, err
		}
	}
}

func emitWithTimeout(emit emitFn, c stream.Chunk) bool {
	if emit == nil {
		return false
	}
	done := make(chan struct{})
	go func() {
		defer close(done)
		emit(c)
	}()
	select {
	case <-done:
		return true
	case <-time.After(defaultEmitTimeout):
		return false
	}
}

// activityReader wraps the subprocess stdout and pings bump on every
// non-empty read. The silence watchdog uses bump to know codex is
// still alive; a long gap with no Read means the stream stalled.
type activityReader struct {
	r    io.Reader
	bump func()
}

func (a *activityReader) Read(p []byte) (int, error) {
	n, err := a.r.Read(p)
	if n > 0 && a.bump != nil {
		a.bump()
	}
	return n, err
}

func toChunkToolUse(t *toolUseShape) stream.Chunk {
	if t == nil {
		return stream.Chunk{}
	}
	return stream.Chunk{
		Type: stream.ChunkTypeToolUse,
		ToolUse: &stream.ToolUseChunk{
			ID:    t.ID,
			Name:  t.Name,
			Input: t.Input,
		},
	}
}

func toChunkToolResult(t *toolResShape) stream.Chunk {
	if t == nil {
		return stream.Chunk{}
	}
	return stream.Chunk{
		Type: stream.ChunkTypeToolResult,
		ToolResult: &stream.ToolResultChunk{
			ID:      t.ID,
			OK:      true,
			Content: t.Content,
		},
	}
}
