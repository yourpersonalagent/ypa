// Synchronous claude binary invocation — mirror of claude-run.ts.
//
// Used by /v1/command and any other call site that wants a single
// result blob rather than a chunked stream. Internally we still spawn
// the binary in --output-format=json (NOT stream-json) so there's
// exactly one JSON object on stdout to parse.
package claudebinary

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
)

// RunResult is the data shape callers of Run see — text + cost +
// tokens + the binary's session_id (for resume next time).
type RunResult struct {
	Text                string
	Cost                float64
	InputTokens         int
	OutputTokens        int
	CacheCreationTokens int
	CacheReadTokens     int
	ClaudeSessionID     string
}

// Runner is the synchronous-Run entry point. Like Streamer it's a
// thin facade around the spawn infra so callers don't have to
// thread the session resolver themselves.
type Runner struct {
	streamer *Streamer
}

// NewRunner wraps a Streamer (or constructs one from the supplied
// resolver if streamer is nil). Sharing the Streamer keeps the
// session map consistent across synchronous + streaming calls.
func NewRunner(streamer *Streamer) *Runner {
	if streamer == nil {
		streamer = NewStreamer(nil, nil)
	}
	return &Runner{streamer: streamer}
}

// Run spawns the binary in synchronous --print --output-format=json
// mode, writes the prompt to stdin, blocks for the full stdout, and
// parses the single result blob. Mirrors runClaude() in TS.
//
// On stale-resume retry the function calls itself once (matches the
// TS _retryCount<1 guard).
func (r *Runner) Run(ctx context.Context, req Request) (*RunResult, error) {
	return r.runWithRetry(ctx, req, 0)
}

func (r *Runner) runWithRetry(ctx context.Context, req Request, retryCount int) (*RunResult, error) {
	hSID := req.HistorySessionID
	if hSID == "" {
		hSID = req.Spawn.ConfigDir
	}
	if req.Spawn.ResumeSessionID == "" {
		req.Spawn.ResumeSessionID = r.streamer.resolver.Get(hSID)
	}

	// Synchronous spawn — Stream is false, HasImages may be true.
	req.Spawn.Stream = false
	initialStdin, err := buildInitialStdin(req.Prompt, req.ImageBlocks, /*stream*/ false)
	if err != nil {
		return nil, fmt.Errorf("claudebinary.Run: build stdin: %w", err)
	}

	spawnFn := r.streamer.processSpawn
	if spawnFn == nil {
		spawnFn = spawnProcess
	}
	handles, err := spawnFn(ctx, req.Spawn, initialStdin)
	if err != nil {
		return nil, fmt.Errorf("claudebinary.Run: spawn: %w", err)
	}
	defer func() {
		if handles.Kill != nil {
			_ = handles.Kill()
		}
	}()
	if handles.PID > 0 {
		if err := SetNiceness(handles.PID, req.Spawn.IsInteractive); err != nil {
			r.streamer.log.Warn("claudebinary.Run.setpriority", "err", err, "pid", handles.PID)
		}
		// See Streamer.streamWithRetry: bind the child to go-core's
		// lifetime so a crash can't orphan it. Best-effort; reaped by
		// yha.ps1 Kill-OrphanHarness as backstop.
		if err := assignChildToParentLifetime(handles.PID); err != nil {
			r.streamer.log.Warn("claudebinary.Run.killjob.assign", "err", err, "pid", handles.PID)
		}
	}

	// Drain stdout + stderr concurrently. Synchronous mode emits a
	// single JSON object on stdout (no per-line parsing) followed by
	// an optional trailing newline.
	type drainResult struct {
		out  []byte
		err  error
		from string
	}
	resCh := make(chan drainResult, 2)
	go func() {
		buf := &bytes.Buffer{}
		_, err := io.Copy(buf, handles.Stdout)
		resCh <- drainResult{out: buf.Bytes(), err: err, from: "stdout"}
	}()
	go func() {
		buf := &bytes.Buffer{}
		_, err := bufio.NewReader(handles.Stderr).WriteTo(buf)
		resCh <- drainResult{out: buf.Bytes(), err: err, from: "stderr"}
	}()

	var stdoutBytes, stderrBytes []byte
	var stdoutErr, stderrErr error
	for i := 0; i < 2; i++ {
		select {
		case r := <-resCh:
			switch r.from {
			case "stdout":
				stdoutBytes, stdoutErr = r.out, r.err
			case "stderr":
				stderrBytes, stderrErr = r.out, r.err
			}
		case <-ctx.Done():
			if handles.Kill != nil {
				_ = handles.Kill()
			}
			// Drain remaining channels so goroutines don't leak.
			for j := i; j < 2; j++ {
				<-resCh
			}
			return nil, ctx.Err()
		}
	}
	_ = stdoutErr
	_ = stderrErr

	var waitErr error
	if handles.Wait != nil {
		waitErr = handles.Wait()
	}

	stdoutText := strings.TrimSpace(string(stdoutBytes))
	stderrText := string(stderrBytes)

	// Stale-resume retry.
	if stdoutText == "" &&
		strings.Contains(stderrText, "No conversation found with session ID") &&
		retryCount < retryBudget(req) {
		r.streamer.log.Info("claudebinary.Run.retry-stale-resume",
			"history_sid", hSID, "retry", retryCount+1)
		r.streamer.resolver.Delete(hSID)
		req.Spawn.ResumeSessionID = ""
		return r.runWithRetry(ctx, req, retryCount+1)
	}

	// Parse the single JSON result.
	if stdoutText == "" {
		msg := strings.TrimSpace(stderrText)
		if msg == "" {
			if waitErr != nil {
				msg = waitErr.Error()
			} else {
				msg = "claude produced no output"
			}
		}
		return nil, errors.New(msg)
	}

	var parsed map[string]any
	if err := json.Unmarshal([]byte(stdoutText), &parsed); err != nil {
		// Mirrors the TS fallback: when stdout isn't JSON, just return
		// it as plain text with zero cost.
		return &RunResult{Text: stdoutText}, nil
	}

	res := &RunResult{}
	if sid, ok := parsed["session_id"].(string); ok && sid != "" {
		res.ClaudeSessionID = sid
		r.streamer.resolver.Set(hSID, sid)
	}
	if t, ok := parsed["result"].(string); ok {
		res.Text = t
	}
	res.Cost = asFloat64(parsed["total_cost_usd"])
	res.InputTokens = asInt(parsed["input_tokens"])
	res.OutputTokens = asInt(parsed["output_tokens"])
	if usage, ok := parsed["usage"].(map[string]any); ok {
		if res.InputTokens == 0 {
			res.InputTokens = asInt(usage["input_tokens"])
		}
		if res.OutputTokens == 0 {
			res.OutputTokens = asInt(usage["output_tokens"])
		}
		res.CacheCreationTokens = asInt(usage["cache_creation_input_tokens"])
		res.CacheReadTokens = asInt(usage["cache_read_input_tokens"])
	}
	return res, nil
}
