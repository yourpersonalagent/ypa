package claudebinary

import (
	"context"
	"errors"
	"strings"
	"testing"
)

// TestRunnerHappyPath drives Runner.Run with a fixture that emits a
// single JSON object (no per-line splitting — synchronous mode) and
// verifies fields parse correctly.
func TestRunnerHappyPath(t *testing.T) {
	fixture := `{"session_id":"sess-r1","result":"yes","total_cost_usd":0.01,"usage":{"input_tokens":7,"output_tokens":3,"cache_creation_input_tokens":1,"cache_read_input_tokens":4},"stop_reason":"end_turn"}`
	streamer := NewStreamer(nil, nil).WithProcessSpawn(fakeProcess(fixture, "", nil))
	r := NewRunner(streamer)

	res, err := r.Run(context.Background(), Request{
		Prompt:           "yo",
		HistorySessionID: "hist-r",
		Spawn:            SpawnOpts{},
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Text != "yes" {
		t.Errorf("Text: %q", res.Text)
	}
	if res.Cost != 0.01 {
		t.Errorf("Cost: %v", res.Cost)
	}
	if res.InputTokens != 7 || res.OutputTokens != 3 {
		t.Errorf("tokens: %d/%d", res.InputTokens, res.OutputTokens)
	}
	if res.CacheCreationTokens != 1 || res.CacheReadTokens != 4 {
		t.Errorf("cache tokens: %d/%d", res.CacheCreationTokens, res.CacheReadTokens)
	}
	if res.ClaudeSessionID != "sess-r1" {
		t.Errorf("ClaudeSessionID: %q", res.ClaudeSessionID)
	}
	// Resolver should be updated.
	if streamer.resolver.Get("hist-r") != "sess-r1" {
		t.Errorf("resolver: %q", streamer.resolver.Get("hist-r"))
	}
}

// TestRunnerPlainTextFallback — when stdout isn't valid JSON, Run
// returns it as plain text with zero cost (matches TS fallback).
func TestRunnerPlainTextFallback(t *testing.T) {
	streamer := NewStreamer(nil, nil).WithProcessSpawn(fakeProcess("just plain text", "", nil))
	r := NewRunner(streamer)
	res, err := r.Run(context.Background(), Request{Prompt: "x", HistorySessionID: "h"})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if res.Text != "just plain text" {
		t.Errorf("Text: %q", res.Text)
	}
	if res.Cost != 0 {
		t.Errorf("Cost should be 0 for plain-text fallback, got %v", res.Cost)
	}
}

// TestRunnerStaleResumeRetry — same retry semantics as the Streamer.
func TestRunnerStaleResumeRetry(t *testing.T) {
	streamer := NewStreamer(nil, nil)
	streamer.resolver.Set("hist-stale", "sess-old")

	attempt := 0
	spawn := func(ctx context.Context, opts SpawnOpts, initialStdin []byte) (ProcessHandles, error) {
		attempt++
		if attempt == 1 {
			return fakeProcess("", "Error: No conversation found with session ID sess-old\n", nil)(ctx, opts, initialStdin)
		}
		if opts.ResumeSessionID != "" {
			t.Errorf("retry should clear ResumeSessionID, got %q", opts.ResumeSessionID)
		}
		return fakeProcess(`{"session_id":"sess-fresh","result":"ok","stop_reason":"end_turn"}`, "", nil)(ctx, opts, initialStdin)
	}
	streamer = streamer.WithProcessSpawn(spawn)
	r := NewRunner(streamer)
	res, err := r.Run(context.Background(), Request{Prompt: "p", HistorySessionID: "hist-stale"})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if attempt != 2 {
		t.Errorf("attempts: %d", attempt)
	}
	if res.Text != "ok" || res.ClaudeSessionID != "sess-fresh" {
		t.Errorf("res: %+v", res)
	}
}

// TestRunnerEmptyStdoutWithStderrError — no output + stderr text
// surfaces the stderr as the error message.
func TestRunnerEmptyStdoutWithStderrError(t *testing.T) {
	streamer := NewStreamer(nil, nil).WithProcessSpawn(fakeProcess("", "boom!", errors.New("exit 1")))
	r := NewRunner(streamer)
	_, err := r.Run(context.Background(), Request{Prompt: "x", HistorySessionID: "h"})
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "boom") {
		t.Errorf("error should include stderr, got %q", err)
	}
}
