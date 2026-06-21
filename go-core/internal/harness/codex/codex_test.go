package codex

import (
	"bufio"
	"context"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/yha/core/internal/stream"
)

// fakeProcess simulates a codex subprocess for unit tests. The
// stdout/stderr pipes are in-memory; waitErr is returned by the
// caller's wait closure. We use newWithRunner to inject this into a
// Streamer so Run drives the parser without spawning anything.
type fakeProcess struct {
	stdout  io.ReadCloser
	stderr  io.ReadCloser
	waitErr error
}

func makeFakeRunner(p *fakeProcess) func(context.Context, SpawnOpts) (io.ReadCloser, io.ReadCloser, func() error, error) {
	return func(ctx context.Context, opts SpawnOpts) (io.ReadCloser, io.ReadCloser, func() error, error) {
		_ = ctx
		_ = opts
		return p.stdout, p.stderr, func() error { return p.waitErr }, nil
	}
}

// readClose wraps a reader with a no-op Closer.
type readClose struct {
	io.Reader
}

func (readClose) Close() error { return nil }

// pipeFrom turns a string into an io.ReadCloser that yields the
// content then EOF — exactly what spawnCmd's stdout pipe would
// produce after the subprocess exits.
func pipeFrom(s string) io.ReadCloser {
	return readClose{Reader: strings.NewReader(s)}
}

func TestStreamDefaultModelUsesCodexCLISelection(t *testing.T) {
	var got SpawnOpts
	c := New()
	c.streamer = newWithRunner(func(_ context.Context, opts SpawnOpts) (io.ReadCloser, io.ReadCloser, func() error, error) {
		got = opts
		stdout := pipeFrom(`{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}`)
		return stdout, pipeFrom(""), func() error { return nil }, nil
	})

	res, err := c.Stream(context.Background(), Request{
		Input: "say hi",
		Model: "codex/default",
	}, func(stream.Chunk) {})
	if err != nil {
		t.Fatalf("Stream returned err: %v", err)
	}
	if got.Model != "" {
		t.Fatalf("default sentinel must omit --model, got %q", got.Model)
	}
	if res.Usage.Model != "default" {
		t.Fatalf("result should retain picker model identity, got %q", res.Usage.Model)
	}
}

func TestRunHappyPath(t *testing.T) {
	stdout := strings.Join([]string{
		`{"type":"response.text.delta","delta":"Hello "}`,
		`{"type":"response.text.delta","delta":"world."}`,
		`{"type":"turn.completed","usage":{"input_tokens":12,"output_tokens":2,"input_tokens_details":{"cached_tokens":4}}}`,
	}, "\n")
	fp := &fakeProcess{
		stdout:  pipeFrom(stdout),
		stderr:  pipeFrom(""),
		waitErr: nil,
	}
	s := newWithRunner(makeFakeRunner(fp))

	var chunks []stream.Chunk
	var mu sync.Mutex
	emit := func(c stream.Chunk) {
		mu.Lock()
		defer mu.Unlock()
		chunks = append(chunks, c)
	}

	res, err := s.Run(context.Background(), runRequest{
		Prompt: "say hi",
		Model:  "codex/gpt-5.3-codex",
	}, emit)
	if err != nil {
		t.Fatalf("Run returned err: %v", err)
	}
	if res.Text != "Hello world." {
		t.Errorf("expected concatenated text, got %q", res.Text)
	}
	if res.Usage.InputTokens != 8 {
		t.Errorf("expected NET input=8 (12-4), got %d", res.Usage.InputTokens)
	}
	if res.Usage.OutputTokens != 2 {
		t.Errorf("expected output=2, got %d", res.Usage.OutputTokens)
	}
	if res.Usage.CacheReadTokens != 4 {
		t.Errorf("expected cacheRead=4, got %d", res.Usage.CacheReadTokens)
	}

	// Expect two delta chunks + one done chunk.
	mu.Lock()
	defer mu.Unlock()
	if len(chunks) != 3 {
		t.Fatalf("expected 3 chunks (2 delta + done), got %d: %+v", len(chunks), chunks)
	}
	if chunks[0].Type != stream.ChunkTypeDelta || chunks[0].Delta != "Hello " {
		t.Errorf("first chunk = %+v", chunks[0])
	}
	if chunks[1].Type != stream.ChunkTypeDelta || chunks[1].Delta != "world." {
		t.Errorf("second chunk = %+v", chunks[1])
	}
	if chunks[2].Type != stream.ChunkTypeDone {
		t.Errorf("last chunk should be done, got %+v", chunks[2])
	}
}

func TestRunSubprocessNonZeroNoText(t *testing.T) {
	fp := &fakeProcess{
		stdout:  pipeFrom(""),
		stderr:  pipeFrom("codex: command not found\n"),
		waitErr: errors.New("exit status 127"),
	}
	s := newWithRunner(makeFakeRunner(fp))

	var chunks []stream.Chunk
	emit := func(c stream.Chunk) { chunks = append(chunks, c) }

	_, err := s.Run(context.Background(), runRequest{Prompt: "x", Model: "codex/m"}, emit)
	if err == nil {
		t.Fatalf("expected error on non-zero exit with no text")
	}
	if !strings.Contains(err.Error(), "codex") {
		t.Errorf("expected codex in error, got %q", err.Error())
	}
	// Should have emitted an error chunk before returning.
	if len(chunks) == 0 || chunks[len(chunks)-1].Type != stream.ChunkTypeError {
		t.Errorf("expected trailing error chunk, got %+v", chunks)
	}
}

func TestRunEmptyOutputWithCodexError(t *testing.T) {
	// codex prints an error event then exits 0 but with no text.
	stdout := `{"type":"error","message":"context window exceeded"}` + "\n"
	fp := &fakeProcess{
		stdout:  pipeFrom(stdout),
		stderr:  pipeFrom(""),
		waitErr: nil, // clean exit even though codex reported error
	}
	s := newWithRunner(makeFakeRunner(fp))

	var chunks []stream.Chunk
	emit := func(c stream.Chunk) { chunks = append(chunks, c) }

	_, err := s.Run(context.Background(), runRequest{Prompt: "x", Model: "codex/m"}, emit)
	if err == nil {
		t.Fatalf("expected error when codex emits error + no text")
	}
	if !strings.Contains(err.Error(), "context window") {
		t.Errorf("expected codex error message surfaced, got %q", err.Error())
	}
}

func TestRunToolUseAndResultEmitted(t *testing.T) {
	stdout := strings.Join([]string{
		`{"type":"item.started","item":{"id":"t1","type":"command_execution","command":"ls"}}`,
		`{"type":"item.completed","item":{"id":"t1","type":"command_execution","command":"ls","aggregated_output":"file.go","exit_code":0}}`,
		`{"type":"response.text.delta","delta":"done"}`,
		`{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":1}}`,
	}, "\n")
	fp := &fakeProcess{stdout: pipeFrom(stdout), stderr: pipeFrom("")}
	s := newWithRunner(makeFakeRunner(fp))

	var chunks []stream.Chunk
	emit := func(c stream.Chunk) { chunks = append(chunks, c) }

	res, err := s.Run(context.Background(), runRequest{Prompt: "x", Model: "codex/m"}, emit)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Text != "done" {
		t.Errorf("expected text=done, got %q", res.Text)
	}

	// Expect: toolUse (started), toolResult (completed dedups toolUse),
	// delta, done.
	gotTypes := make([]string, len(chunks))
	for i, c := range chunks {
		gotTypes[i] = c.Type
	}
	if len(chunks) < 4 {
		t.Fatalf("expected >=4 chunks, got %d: %v", len(chunks), gotTypes)
	}
	if chunks[0].Type != stream.ChunkTypeToolUse {
		t.Errorf("expected first chunk toolUse, got %s", chunks[0].Type)
	}
	if chunks[1].Type != stream.ChunkTypeToolResult {
		t.Errorf("expected second chunk toolResult, got %s", chunks[1].Type)
	}
	if !strings.Contains(chunks[1].ToolResult.Content, "file.go") {
		t.Errorf("toolResult missing content, got %q", chunks[1].ToolResult.Content)
	}
}

func TestRunFunctionCallStreamingFlow(t *testing.T) {
	stdout := strings.Join([]string{
		`{"type":"response.output_item.added","item":{"type":"function_call","call_id":"c1","name":"search"}}`,
		`{"type":"response.function_call_arguments.delta","call_id":"c1","delta":"{\"q\":"}`,
		`{"type":"response.function_call_arguments.delta","call_id":"c1","delta":"\"go\"}"}`,
		`{"type":"response.function_call_arguments.done","call_id":"c1","arguments":"{\"q\":\"go\"}"}`,
		`{"type":"response.output_item.done","item":{"type":"function_call_output","call_id":"c1","output":"42 results"}}`,
		`{"type":"response.text.delta","delta":"ok"}`,
		`{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}`,
	}, "\n")
	fp := &fakeProcess{stdout: pipeFrom(stdout), stderr: pipeFrom("")}
	s := newWithRunner(makeFakeRunner(fp))

	var chunks []stream.Chunk
	emit := func(c stream.Chunk) { chunks = append(chunks, c) }

	res, err := s.Run(context.Background(), runRequest{Prompt: "x", Model: "codex/m"}, emit)
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Text != "ok" {
		t.Errorf("expected text=ok, got %q", res.Text)
	}

	// Expect: placeholder toolUse, final toolUse, toolResult, delta, done.
	var (
		toolUseCount    int
		toolResultCount int
		gotResultText   string
		gotFinalQ       any
	)
	for _, c := range chunks {
		switch c.Type {
		case stream.ChunkTypeToolUse:
			toolUseCount++
			if c.ToolUse.Input != nil {
				if q, ok := c.ToolUse.Input["q"]; ok {
					gotFinalQ = q
				}
			}
		case stream.ChunkTypeToolResult:
			toolResultCount++
			gotResultText = c.ToolResult.Content
		}
	}
	if toolUseCount < 2 {
		t.Errorf("expected at least 2 toolUse (placeholder + final), got %d", toolUseCount)
	}
	if toolResultCount != 1 {
		t.Errorf("expected exactly 1 toolResult, got %d", toolResultCount)
	}
	if gotResultText != "42 results" {
		t.Errorf("expected toolResult=42 results, got %q", gotResultText)
	}
	if gotFinalQ != "go" {
		t.Errorf("expected final args.q=go, got %v", gotFinalQ)
	}
}

func TestRunRequiresPromptAndEmit(t *testing.T) {
	s := newWithRunner(makeFakeRunner(&fakeProcess{stdout: pipeFrom(""), stderr: pipeFrom("")}))
	if _, err := s.Run(context.Background(), runRequest{Model: "codex/m"}, func(stream.Chunk) {}); err == nil {
		t.Errorf("expected error on empty prompt")
	}
	if _, err := s.Run(context.Background(), runRequest{Prompt: "x", Model: "codex/m"}, nil); err == nil {
		t.Errorf("expected error on nil emit")
	}
}

func TestRunDoesNotLeakGoroutines(t *testing.T) {
	// Smoke: drive Run with a small stream; the test would hang if
	// the stderr-drain goroutine never returned. We don't measure
	// goroutine count (flaky in CI) — the assertion is the test
	// completing within the deadline.
	stdout := `{"type":"response.text.delta","delta":"x"}` + "\n" +
		`{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}` + "\n"
	fp := &fakeProcess{stdout: pipeFrom(stdout), stderr: pipeFrom("noise\n")}
	s := newWithRunner(makeFakeRunner(fp))

	done := make(chan struct{})
	go func() {
		defer close(done)
		_, _ = s.Run(context.Background(), runRequest{Prompt: "x", Model: "codex/m"}, func(stream.Chunk) {})
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatalf("Run hung — stderr drain probably stuck")
	}
}

// ctxBlockingReader blocks every Read until its context is cancelled,
// then reports EOF — modelling a codex subprocess that has spawned but
// gone silent (stdin EOF never landed, or a tool wedged). procCancel
// from the silence watchdog cancels ctx, which unblocks the scanner.
type ctxBlockingReader struct{ ctx context.Context }

func (b ctxBlockingReader) Read(p []byte) (int, error) {
	<-b.ctx.Done()
	return 0, io.EOF
}
func (b ctxBlockingReader) Close() error { return nil }

func TestRunSilenceWatchdogTripsOnStall(t *testing.T) {
	s := newWithRunner(func(ctx context.Context, _ SpawnOpts) (io.ReadCloser, io.ReadCloser, func() error, error) {
		return ctxBlockingReader{ctx: ctx}, pipeFrom(""), func() error { return ctx.Err() }, nil
	})

	var mu sync.Mutex
	var errChunks int
	emit := func(c stream.Chunk) {
		mu.Lock()
		defer mu.Unlock()
		if c.Type == stream.ChunkTypeError {
			errChunks++
		}
	}

	done := make(chan struct{})
	var runErr error
	go func() {
		_, runErr = s.Run(context.Background(), runRequest{Prompt: "hi", SilenceTimeout: 150 * time.Millisecond}, emit)
		close(done)
	}()

	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("watchdog never tripped — Run hung on a silent subprocess")
	}

	if runErr == nil || !strings.Contains(runErr.Error(), "no output") {
		t.Fatalf("expected a no-output watchdog error, got %v", runErr)
	}
	mu.Lock()
	defer mu.Unlock()
	if errChunks != 1 {
		t.Fatalf("expected exactly one error chunk emitted, got %d", errChunks)
	}
}

// A subprocess that streams a clean turn must NOT trip the watchdog.
func TestRunSilenceWatchdogQuietOnHealthyTurn(t *testing.T) {
	stdout := strings.Join([]string{
		`{"type":"response.text.delta","delta":"ok"}`,
		`{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}`,
	}, "\n")
	s := newWithRunner(makeFakeRunner(&fakeProcess{stdout: pipeFrom(stdout), stderr: pipeFrom("")}))

	_, err := s.Run(context.Background(), runRequest{Prompt: "hi", SilenceTimeout: 150 * time.Millisecond}, func(stream.Chunk) {})
	if err != nil {
		t.Fatalf("healthy turn should not error: %v", err)
	}
}

func TestProcessStreamDirect(t *testing.T) {
	// Drive processStream without the rest of Run so we cover the
	// loop in isolation. Useful when adding new event types.
	in := strings.NewReader(`{"type":"response.text.delta","delta":"a"}` + "\n" +
		`{"type":"response.text.delta","delta":"b"}` + "\n")
	var chunks []stream.Chunk
	text, usage, errMsg, completed := processStream(in, func(c stream.Chunk) {
		chunks = append(chunks, c)
	})
	if text != "ab" {
		t.Errorf("text=%q", text)
	}
	if !usage.isZero() {
		t.Errorf("expected zero usage when no turn.completed, got %+v", usage)
	}
	if errMsg != "" {
		t.Errorf("errMsg=%q", errMsg)
	}
	if completed {
		t.Error("stream without turn.completed reported completion")
	}
	if len(chunks) != 2 {
		t.Errorf("expected 2 chunks, got %d", len(chunks))
	}
}

func TestProcessStreamStopsAtTurnCompleted(t *testing.T) {
	in := strings.NewReader(`{"type":"response.text.delta","delta":"done"}` + "\n" +
		`{"type":"turn.completed","usage":{"input_tokens":2,"output_tokens":1}}` + "\n" +
		`{"type":"response.text.delta","delta":"must-not-be-read"}` + "\n")

	text, usage, errMsg, completed := processStream(in, func(stream.Chunk) {})
	if !completed {
		t.Fatal("expected turn.completed to terminate the parser")
	}
	if text != "done" {
		t.Fatalf("text=%q, want %q", text, "done")
	}
	if usage.InputTokens != 2 || usage.OutputTokens != 1 {
		t.Fatalf("usage=%+v", usage)
	}
	if errMsg != "" {
		t.Fatalf("errMsg=%q", errMsg)
	}
}

func TestReadLineTruncated(t *testing.T) {
	// Normal lines pass through; an over-cap line is truncated to maxBytes and
	// the reader resumes cleanly on the following line (the bytes between the
	// cap and the newline are discarded, not carried into the next line).
	const limit = 8
	r := bufio.NewReaderSize(strings.NewReader("ab\n"+strings.Repeat("X", 50)+"\ncd\n"), 16)

	line, trunc, err := readLineTruncated(r, limit)
	if line != "ab" || trunc || err != nil {
		t.Fatalf("line1: got %q trunc=%v err=%v", line, trunc, err)
	}
	line, trunc, err = readLineTruncated(r, limit)
	if len(line) != limit || !trunc || err != nil {
		t.Fatalf("line2: len=%d trunc=%v err=%v (want len=%d, truncated)", len(line), trunc, err, limit)
	}
	line, trunc, err = readLineTruncated(r, limit)
	if line != "cd" || trunc || err != nil {
		t.Fatalf("line3: got %q trunc=%v err=%v (want \"cd\", resumed cleanly past the giant line)", line, trunc, err)
	}
	if line, _, err = readLineTruncated(r, limit); line != "" || err != io.EOF {
		t.Fatalf("eof: got %q err=%v (want \"\" io.EOF)", line, err)
	}
}

func TestProcessStreamOversizedLineDoesNotKillTurn(t *testing.T) {
	// Regression for "codex stdout scan error: bufio.Scanner: token too long".
	// A single tool-result line larger than maxCodexLineBytes (e.g. grep over a
	// minified bundle, which codex streams in full on stdout) must NOT abort the
	// turn. The giant line is truncated → invalid JSON → skipped, and the stream
	// still reaches turn.completed with the surrounding text intact.
	huge := strings.Repeat("X", maxCodexLineBytes+1024)
	in := strings.NewReader(
		`{"type":"response.text.delta","delta":"hi"}` + "\n" +
			`{"type":"response_item","payload":{"type":"function_call_output","call_id":"c1","output":"` + huge + `"}}` + "\n" +
			`{"type":"response.text.delta","delta":" there"}` + "\n" +
			`{"type":"turn.completed","usage":{"input_tokens":5,"output_tokens":2}}` + "\n")

	text, usage, errMsg, completed := processStream(in, func(stream.Chunk) {})
	if !completed {
		t.Fatal("oversized tool line aborted the turn (want turn.completed reached)")
	}
	if errMsg != "" {
		t.Fatalf("oversized line surfaced an error: %q", errMsg)
	}
	if text != "hi there" {
		t.Fatalf("text=%q, want %q (deltas around the giant line must survive)", text, "hi there")
	}
	if usage.InputTokens != 5 || usage.OutputTokens != 2 {
		t.Fatalf("usage=%+v", usage)
	}
}

func TestRunCancelsProcessThatLingersAfterTurnCompleted(t *testing.T) {
	runner := func(ctx context.Context, _ SpawnOpts) (io.ReadCloser, io.ReadCloser, func() error, error) {
		stdoutR, stdoutW := io.Pipe()
		stderrR, stderrW := io.Pipe()
		go func() {
			_, _ = io.WriteString(stdoutW, `{"type":"response.text.delta","delta":"finished"}`+"\n")
			_, _ = io.WriteString(stdoutW, `{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":1}}`+"\n")
			<-ctx.Done()
			_ = stdoutW.Close()
		}()
		go func() {
			<-ctx.Done()
			_ = stderrW.Close()
		}()
		return stdoutR, stderrR, func() error {
			<-ctx.Done()
			return ctx.Err()
		}, nil
	}

	s := newWithRunner(runner)
	done := make(chan error, 1)
	go func() {
		res, err := s.Run(context.Background(), runRequest{Prompt: "x", Model: "codex/m"}, func(stream.Chunk) {})
		if err == nil && res.Text != "finished" {
			err = errors.New("unexpected result text: " + res.Text)
		}
		done <- err
	}()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("Run returned err: %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Run waited for process EOF after turn.completed")
	}
}

// isZero is the test-only helper paralleling stream.Usage.IsZero.
// rawUsage doesn't ship a method today, so this lives here.
func (u rawUsage) isZero() bool {
	return u.InputTokens == 0 && u.OutputTokens == 0 &&
		u.CacheReadTokens == 0 && u.CacheCreationTokens == 0
}
