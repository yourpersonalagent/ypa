package codex

// parser.go — public surface over the codex JSON-Lines event parser.
//
// The actual event taxonomy + decode rules live in events.go (the
// codexEvent / codexItem typed shapes and parseLine). This file
// exposes a small, ergonomic façade so unit tests and the App-Server
// port (future Phase 6+) can drive the parser without spawning a real
// codex.
//
// Event types parsed (per codex.ts:345-420):
//
//	response.text.delta                          → text delta chunk
//	item.started (agent_message)                 → ignored (no text yet)
//	item.started (tool item)                     → tool_use chunk
//	item.completed (agent_message)               → text delta chunk
//	item.completed (tool item)                   → tool_use + tool_result
//	response.output_item.added (function_call)   → tool_use chunk
//	response.function_call_arguments.delta       → buffered (no chunk)
//	response.function_call_arguments.done        → tool_use chunk (final)
//	response.output_item.done (function_call_output) → tool_result chunk
//	error                                        → terminal error
//	turn.failed                                  → terminal error
//	turn.completed                               → usage capture
//	(empty type / non-JSON)                      → text passthrough
//
// Other event types codex emits (response.created, response.in_progress,
// session.created, etc.) are silently skipped — the route handler
// doesn't care about them and crashing on an unknown event would
// brittle the harness against future CLI updates.

import (
	"io"

	"github.com/yha/core/internal/stream"
)

// ParseOptions tweaks the parser behaviour. Reserved for future
// knobs (max buffer size, partial-tool-use suppression, etc.). Zero
// value is valid.
type ParseOptions struct {
	// MaxLineBytes overrides the per-line scan buffer cap. Defaults
	// to 1 MiB (events.go uses 1 MiB internally). Set to a smaller
	// value in tests if you want to assert on truncation.
	MaxLineBytes int
}

// ParseResult is the synchronous parser's return shape. It mirrors
// what Streamer.Run derives internally — useful when callers want to
// run the parser standalone on a fixed byte slice.
type ParseResult struct {
	// Text is the concatenated assistant text (response.text.delta +
	// agent_message item.completed text). Matches the fullText
	// buffer in codex.ts:338.
	Text string

	// Usage is the NET token counts surfaced from turn.completed.
	// InputTokens = gross - cached (codex.ts:457).
	Usage Usage

	// CodexError is the error message from an `error` or `turn.failed`
	// event, if any. Empty on a clean stream.
	CodexError string
}

// Parse consumes a JSON-Lines stream and emits stream.Chunk events
// via emit. Returns ParseResult on EOF. Errors from io.Reader bubble
// up as a non-nil err return; the ParseResult fields still hold what
// was successfully decoded before the failure.
//
// emit must be non-nil. Concurrent calls each get an independent
// parseState (no shared mutation).
//
// This is the test seam — production Streamer.Run uses processStream
// internally which is functionally identical but reports out via
// pointer-returns to feed Streamer.Run's success/error logic.
func Parse(r io.Reader, emit stream.EmitFn, _ ParseOptions) (ParseResult, error) {
	if emit == nil {
		return ParseResult{}, errParserNilEmit
	}
	text, raw, errMsg, _ := processStream(r, emit)
	return ParseResult{
		Text: text,
		Usage: Usage{
			InputTokens:   int64(raw.InputTokens),
			OutputTokens:  int64(raw.OutputTokens),
			CacheRead:     int64(raw.CacheReadTokens),
			CacheCreation: int64(raw.CacheCreationTokens),
		},
		CodexError: errMsg,
	}, nil
}

// errParserNilEmit is the sentinel for the one ergonomic check Parse
// makes — emit must be non-nil. Surfaced as a typed value so callers
// can errors.Is against it if they want; we don't depend on this in
// tests.
var errParserNilEmit = parserError("codex.Parse: emit must be non-nil")

type parserError string

func (e parserError) Error() string { return string(e) }
