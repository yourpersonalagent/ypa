// Package stream is the Go port of bridge/tools/stream.ts.
//
// The package owns the multi-turn streaming chat loop that drives
// OpenAI / Anthropic / Gemini-compatible APIs through their tool-use
// cycles. Each provider plugs in via the Provider interface defined
// here; the loop in loop.go is provider-agnostic.
//
// Wire shape from caller's perspective:
//
//	stream.Run(ctx, provider, runner, messages, tools, opts, emit)
//	          // emit is called once per output chunk:
//	          //   text deltas as they arrive
//	          //   tool_use when the model decides to call a tool
//	          //   tool_result after the runner returns
//	          //   done when the conversation completes
//	          //   error if anything failed mid-stream
//
// Caller is responsible for serialising chunks onto the SSE wire (or
// any other transport). The package itself never touches HTTP response
// objects — that lives in the route handler.
package stream

import (
	"context"
	"io"
	"net/http"
	"sync/atomic"

	"github.com/yha/core/internal/tools"
)

// RateLimiter is the per-provider throttle the stream loop wraps every
// outbound HTTP request with. *rate.Limiter satisfies this implicitly;
// tests pass a no-op or scripted double. nil disables throttling (the
// loop calls httpClient.Do directly), which is the legacy behaviour
// preserved for Phase 3 tests.
//
// The signature mirrors rate.Limiter.With minus the attempt counter —
// the stream loop doesn't expose retry metrics to its caller.
type RateLimiter interface {
	With(ctx context.Context, provider string, fn func(context.Context) (*http.Response, error)) (*http.Response, error)
}

// ── Chunk types emitted to the caller ──────────────────────────────────────

// Chunk is one event in the output stream. Type determines which
// fields are populated; readers should switch on Type. Empty fields
// are omitted from JSON output to keep the wire compact.
//
// Seq is a per-session monotonic sequence number stamped by the
// SessionBuffer when the route is configured for reattach (Phase 3).
// Clients echo the last seq they've seen on reconnect via
// `?fromSeq=N` to drive replay. Zero = not stamped (loop-direct
// emission paths that bypass the buffer).
type Chunk struct {
	Type       string           `json:"type"`
	Seq        int64            `json:"_seq,omitempty"`
	Text       string           `json:"text,omitempty"`
	Delta      string           `json:"delta,omitempty"`
	Reasoning  string           `json:"reasoning,omitempty"`
	ToolUse    *ToolUseChunk    `json:"toolUse,omitempty"`
	ToolResult *ToolResultChunk `json:"toolResult,omitempty"`
	Error      string           `json:"error,omitempty"`
	DoneReason string           `json:"doneReason,omitempty"`
	Provider   string           `json:"provider,omitempty"`
	// Model is the immutable model assigned when this turn started. Live and
	// terminal frames carry it so clients never have to consult the mutable
	// model picker while rendering per-turn metadata.
	Model string `json:"model,omitempty"`
	// End-of-stream marker. The FE watches for `chunk._end` truthy to
	// flip the per-stream UI state from "running" to "done" and to
	// finalise token/cost counters. Mirrors Node's
	// bridge/sessions-internal/streams.ts:320-333 endChunk shape — every
	// FE-facing terminator must include `_end: true` plus, on clean
	// completion, the StopReason / token / duration / tokensPerSec /
	// cost fields the FE reads to populate the per-segment stats line.
	// On error completion it carries just `_end: true` + Error.
	End                 bool    `json:"_end,omitempty"`
	StopReason          string  `json:"stopReason,omitempty"`
	InputTokens         int     `json:"inputTokens,omitempty"`
	OutputTokens        int     `json:"outputTokens,omitempty"`
	CacheReadTokens     int     `json:"cacheReadTokens,omitempty"`
	CacheCreationTokens int     `json:"cacheCreationTokens,omitempty"`
	DurationMs          int64   `json:"durationMs,omitempty"`
	TokensPerSec        int     `json:"tokensPerSec,omitempty"`
	Cost                float64 `json:"cost,omitempty"`
	// Heartbeat marker. The route emits a `{_hb: <unix-ms>}`-only
	// chunk every 10 s during an otherwise-quiet stream (long tool
	// call, slow upstream) so the FE's 15 s silence watchdog doesn't
	// trip. Mirrors Node old chat.ts:176-191. Excluded from the SSE
	// buffer and not relayed back to chunk handlers — see the route
	// emit closure.
	Heartbeat int64 `json:"_hb,omitempty"`
	// ReplayEnd marker. The reattach handler emits a single
	// `{_replay_end: true}` chunk between the buffered-tail replay
	// and the live-subscribe loop. The FE renders accumulated blocks
	// eagerly on this marker — without it, `inReplay` stays true
	// forever during a watchdog-driven reconnect (because Go never
	// fires `_end` mid-stream) and the bubble stays empty even
	// though chunks ARE arriving. Mirrors the chunk the Node
	// /v1/sessions/:id/stream reattach handler used pre-Phase-7.
	ReplayEnd bool `json:"_replay_end,omitempty"`
	// Live marker. The route emits `_live` frames on a ~450ms ticker for
	// the duration of a turn so the FE can paint a live "busy" meta bar
	// (input/output tokens, tool-call + model-API-call counts) from the
	// turn's START instead of waiting for the terminal `_end` chunk.
	// Mirrors the heartbeat discipline: pushed straight to the writer
	// pump with Seq=0 so it is NEVER buffered/sequenced for reattach
	// (zero replay-buffer bloat). Carries counters only — elapsed time is
	// the client's own clock. A `_live` frame always has >1 JSON key so
	// the FE's single-key heartbeat check can't misclassify it.
	Live bool `json:"_live,omitempty"`
	// APICallCount is the number of model API calls (agentic-loop
	// iterations) so far. Set on `_live` frames and the terminal `_end`
	// chunk. One iteration == one model API call; a tool-use turn loops
	// back for another.
	APICallCount int `json:"apiCallCount,omitempty"`
	// BtwBlock fires when the user types `#btw <text>` while a stream
	// is live. The bridge POST /v1/sessions/:id/btw handler emits a
	// chunk carrying this field through the session's reattach buffer
	// + every active SSE listener so the FE inserts a `btw` block in
	// chronological position alongside tool calls. Without this the
	// user's mid-stream injection is invisible until the next reload
	// — and even then only if the bridge separately persisted it.
	// Mirrors Node bridge/chat/btw-queue.ts:injectBtwBlock.
	BtwBlock *BtwBlockChunk `json:"btwBlock,omitempty"`
	// InterruptBlock fires when the reattach buffer notices a
	// silent listener drop (kind:"disconnect") or a fresh subscriber
	// reattaching to a stream that lost its listeners earlier
	// (kind:"reconnect"). The FE renders these as styled standalone
	// blocks inside the assistant message instead of folding the
	// text into the model's reply. Without this dedicated field the
	// notice text bled straight into the visible answer because the
	// FE's generic text/delta handler appended any chunk with a
	// `text` field to liveText.
	InterruptBlock *InterruptBlockChunk `json:"interruptBlock,omitempty"`
	// ToolCallCount is the number of tool-call chunks emitted during
	// this turn. Set on the terminal _end chunk so the FE's
	// per-segment stats line can show "N tool calls". Matches Node's
	// finalize-extras shape.
	ToolCallCount int `json:"toolCallCount,omitempty"`
	// EmpID identifies the broadcast / versus employee that produced
	// this chunk. Stamped by the broadcast runner in versus mode so the
	// frontend can route per-author segments without substring-parsing
	// Provider. Empty on every non-broadcast emit path.
	EmpID string `json:"_empId,omitempty"`
	// Usage is set only on the terminal `done` chunk and only when the
	// provider surfaced usage telemetry for this stream (Anthropic via
	// message_start + message_delta, OpenAI via the final include_usage
	// frame, Gemini via usageMetadata). Old SSE clients that never
	// reference this field continue to work — the omitempty keeps the
	// wire backward compatible.
	Usage *Usage `json:"usage,omitempty"`
	// PermDenials carries the per-tool permission-denial snapshot for
	// claude-binary turns where the user refused a tool. Populated only
	// on `Type == ChunkTypePermDenials` chunks; readers should switch
	// on Type before reading. Replaces the legacy
	// `Type: "error", Error: "permission_denials:N"` packing so the FE
	// can render a per-tool denial card.
	PermDenials []PermDenial `json:"permDenials,omitempty"`
	// SystemEvent carries claude-binary `system` events (init,
	// mcp_server status, model selection) and codex / hermes lifecycle
	// notices. Populated only on `Type == ChunkTypeSystem` chunks.
	// Used by the debug UI to surface MCP handshake progress + harness
	// boot details without bleeding into the assistant's reply text.
	SystemEvent *SystemEvent `json:"systemEvent,omitempty"`
	// Author identifies the broadcast / versus employee that produced
	// this chunk. Stamped by the broadcast runner so the FE can route
	// per-author segments via a typed payload instead of substring-
	// parsing Reasoning. Empty on every non-broadcast emit path. The
	// legacy EmpID field stays for routing-key compatibility — Author
	// is the descriptive payload (name, role, color, model, adapter).
	Author *Author `json:"_author,omitempty"`

	// payload is the cached SSE wire serialization of this chunk, stamped
	// once at the buffer's fan-out point (SessionBuffer.Append) so every
	// listener — the live POST pump plus each reattach pump — and the
	// replay ring reuse the same bytes instead of re-running json.Marshal
	// per listener. `json:"-"` keeps it off the wire (and out of its own
	// serialization); unexported so it never leaks past this package.
	// nil for chunks built outside Append (heartbeats, the replay-end
	// marker) — those fall back to marshalling in writeChunkFrame.
	payload []byte `json:"-"`
}

// PermDenial is one entry in a Chunk.PermDenials list — the structured
// replacement for the `permission_denials:N` magic-string Error
// packing. Tool is the tool the user refused (e.g. "Bash", "Edit");
// Reason is the operator-visible refusal text the binary surfaced;
// Count is how many times the model retried (≥1).
type PermDenial struct {
	Tool   string `json:"tool"`
	Reason string `json:"reason,omitempty"`
	Count  int    `json:"count,omitempty"`
}

// SystemEvent is the typed payload of a `Type == ChunkTypeSystem`
// chunk. Kind names the lifecycle moment ("init" / "mcp_server" /
// "model_select" / "ready" / …); Payload carries the raw JSON the
// harness emitted so the FE / debug UI can render it without the Go
// side committing to a fixed schema for every harness's quirks.
type SystemEvent struct {
	Kind    string         `json:"kind,omitempty"`
	Source  string         `json:"source,omitempty"` // "claude-binary" / "codex" / "hermes" / "openclaw"
	Payload map[string]any `json:"payload,omitempty"`
}

// Author is the descriptive payload of a `chunk._author` block stamped
// by the broadcast / versus runner. Replaces the substring-parseable
// tab-separated reasoning string the FE used pre-Phase-8 to identify
// each employee turn. The routing-key EmpID stays separate so the FE
// can fast-path-route on `chunk._empId` without unmarshalling Author.
type Author struct {
	ID          string `json:"id,omitempty"`
	Name        string `json:"name,omitempty"`
	Role        string `json:"role,omitempty"`
	SymbolColor string `json:"symbolColor,omitempty"`
	Model       string `json:"model,omitempty"`
	Adapter     string `json:"adapter,omitempty"`
	Hop         string `json:"hop,omitempty"` // forward-chain source ("partner:hermes/foo")
}

// Usage captures token accounting surfaced by a provider for the
// whole stream (i.e. the running total accumulated across every turn
// of the loop). Zero values are valid — they simply mean the provider
// didn't expose usage on this stream.
//
// Field names mirror the Node-side bridge so downstream telemetry
// (recordCost / recordTokens) sees identical shapes:
//
//   - InputTokens         → Anthropic input_tokens, OpenAI prompt_tokens
//     (NET of cached, to match the bridge's convention), Gemini
//     promptTokenCount.
//   - OutputTokens        → Anthropic output_tokens, OpenAI
//     completion_tokens, Gemini candidatesTokenCount.
//   - CacheReadTokens     → Anthropic cache_read_input_tokens, OpenAI
//     prompt_tokens_details.cached_tokens, Gemini
//     cachedContentTokenCount.
//   - CacheCreationTokens → Anthropic cache_creation_input_tokens. The
//     other providers do not surface this; the field is omitted.
type Usage struct {
	InputTokens         int `json:"inputTokens,omitempty"`
	OutputTokens        int `json:"outputTokens,omitempty"`
	CacheReadTokens     int `json:"cacheReadTokens,omitempty"`
	CacheCreationTokens int `json:"cacheCreationTokens,omitempty"`
}

// IsZero reports whether the Usage has no recorded data. Used by the
// loop / route to avoid stamping an empty *Usage onto the terminal
// chunk (so the SSE wire stays clean when the upstream didn't carry
// any usage events).
func (u Usage) IsZero() bool {
	return u.InputTokens == 0 &&
		u.OutputTokens == 0 &&
		u.CacheReadTokens == 0 &&
		u.CacheCreationTokens == 0
}

// Add folds another Usage into this one. Used by the loop to
// accumulate per-turn usage into the per-stream total. Mirrors the
// JS bridge's `total += turn` pattern.
func (u *Usage) Add(other Usage) {
	u.InputTokens += other.InputTokens
	u.OutputTokens += other.OutputTokens
	u.CacheReadTokens += other.CacheReadTokens
	u.CacheCreationTokens += other.CacheCreationTokens
}

const (
	ChunkTypeDelta      = "delta"
	ChunkTypeText       = "text"
	ChunkTypeReasoning  = "reasoning"
	ChunkTypeToolUse    = "tool_use"
	ChunkTypeToolResult = "tool_result"
	ChunkTypeDone       = "done"
	ChunkTypeError      = "error"
	// ChunkTypePermDenials surfaces a structured list of per-tool
	// permission denials emitted by the claude-binary harness. Replaces
	// the legacy `Error: "permission_denials:N"` packing so the FE can
	// render a per-tool denial card without parsing a magic string.
	ChunkTypePermDenials = "perm_denials"
	// ChunkTypeSystem carries informational system events (claude-binary
	// init / mcp_server status / codex CLI progress) so the debug UI can
	// render MCP handshake + harness lifecycle visibility. Backward
	// compatible — existing FEs ignore unknown chunk types.
	ChunkTypeSystem = "system_event"
)

// ToolUseChunk fires when the model emits a tool call. ID is the
// model-assigned identifier (OpenAI gives one explicitly; Gemini has
// none, so the loop synthesises ${name}#${iter}.${idx}; Anthropic has
// content_block.id).
type ToolUseChunk struct {
	ID    string         `json:"id"`
	Name  string         `json:"name"`
	Input map[string]any `json:"input"`

	// ThoughtSignature carries the Gemini per-functionCall opaque signature
	// that thinking models (gemini-2.5-flash-thinking, gemini-3.5-flash etc)
	// require to be replayed verbatim on the matching {functionCall, thoughtSignature}
	// part in the next user→model turn. See:
	// https://ai.google.dev/gemini-api/docs/thought-signatures
	// Only populated for Gemini direct streams; ignored by other providers.
	ThoughtSignature string `json:"-"`
}

// ToolResultChunk fires after the runner finishes a tool call.
type ToolResultChunk struct {
	ID      string `json:"id"`
	OK      bool   `json:"ok"`
	Content string `json:"content,omitempty"`
	Error   string `json:"error,omitempty"`
}

// BtwBlockChunk is the payload of a `chunk.btwBlock` SSE frame fired
// when the user types `#btw <text>` mid-stream. The FE chunk handler
// inserts a `{type:'btw', text, livePath}` block at the current
// chronological position in the assistant message so the injection is
// visible alongside tool calls. Mirrors the bridge/chat/btw-queue.ts
// shape that pre-Phase-7 Node broadcast.
//
// LivePath is "direct" when the injection went straight into a live
// subprocess stdin (claude-binary stream-json), "harness" when it was
// queued for the next tool-call boundary, or "" when unknown — the FE
// shows a small badge reflecting the actual delivery path.
type BtwBlockChunk struct {
	Text     string `json:"text"`
	LivePath string `json:"livePath,omitempty"`
}

// InterruptBlockChunk is the payload of a `chunk.interruptBlock` SSE
// frame the buffer emits when a listener silently drops (connection
// dropped notice) or a new subscriber attaches to a stream that lost
// listeners (resume notice). The FE chunk handler at chat-streaming.ts
// renders these as their own styled blocks via `interruptBlockHtml` —
// pre-Phase-7 Node used the same `{interruptBlock:{kind,text,ts}}`
// shape, so the matching CSS (`.msg-interrupt-inline`) was already
// shipping. Without this shape Go's chunks with `Type:"interrupt"` +
// a `Text` field fell through to the FE's generic text/delta handler
// and the notice text bled straight into the assistant's reply
// (looked like the model "said" "Stream connection dropped…").
//
// Kind is "disconnect" / "reconnect" / "stopped" / "timeout" / "note"
// — the FE picks the title via a small switch in chat-utils.ts.
// Ts is unix-ms.
type InterruptBlockChunk struct {
	Kind string `json:"kind,omitempty"`
	Text string `json:"text"`
	Ts   int64  `json:"ts,omitempty"`
}

// EmitFn is the per-chunk callback. Implementations typically write to
// an SSE response or buffer. The function MUST be cheap — the loop
// calls it on the hot path and does not goroutine it.
type EmitFn func(Chunk)

// ── Conversation shape ─────────────────────────────────────────────────────

// Message is one entry in the conversation history. Provider parsers
// translate this into their own request shape via BuildRequest.
//
// Role is "system" | "user" | "assistant" | "tool". For role=assistant,
// ToolCalls may be populated (the model wants to call tools). For
// role=tool, ToolCallID points back to the assistant's tool_use entry.
//
// ImageBlocks attach to role=user messages. Each block is rendered
// per-provider (Anthropic image source.base64 block, OpenAI image_url
// data URI part, Gemini inline_data part). Mirrors Node's
// bridge/sessions-internal/images.ts pre-Phase-7 wire shape.
type Message struct {
	Role        string
	Content     string         // simple text — extend later for multimodal
	ImageBlocks []ImageBlock   // role=user only; rendered per-provider in BuildRequest
	ToolCalls   []ToolUseChunk // role=assistant only
	ToolCallID  string         // role=tool only
}

// ImageBlock is one base64-encoded image attached to a user message.
// MediaType is the MIME type the FE uploaded ("image/png" etc.).
// Same shape as harness.ImageBlock — kept here separately so the
// stream package can describe its own wire without importing harness.
type ImageBlock struct {
	MediaType string
	Base64    string
}

// Tool is the catalog entry advertised to the model. Mirrors
// tools.Tool but lives in this package so callers don't need to
// import internal/tools just for the type.
type Tool struct {
	Name        string
	Description string
	InputSchema map[string]any
}

// ── Provider plug-in interface ─────────────────────────────────────────────

// Provider is what each provider parser implements. The loop calls
// BuildRequest, then HTTP-POSTs to Endpoint with Headers, then hands
// the response body to Stream — exactly once per turn.
type Provider interface {
	// Name is a short identifier surfaced on emitted chunks ("openai",
	// "anthropic", "gemini").
	Name() string

	// Endpoint returns the full URL to POST to. Some providers route
	// per-model (OpenAI v1/chat/completions, Anthropic v1/messages)
	// so the implementation may consult internal state.
	Endpoint() string

	// Headers returns auth + content-type headers. The loop calls
	// req.Header = provider.Headers(apiKey) before sending.
	Headers(apiKey string) http.Header

	// BuildRequest renders messages + tools + opts into a request body
	// in the provider's native shape. The loop will set Content-Type
	// from Headers; the body bytes are JSON.
	BuildRequest(messages []Message, tools []Tool, opts RequestOpts) ([]byte, error)

	// Stream consumes the SSE response body and emits parsed chunks
	// via emit. It returns:
	//   toolCalls: any tool-use blocks the model produced this turn
	//   done:      true when the model signalled stop / end-of-turn
	//   err:       transport / parse / shape errors
	Stream(ctx context.Context, body io.Reader, emit EmitFn) (toolCalls []ToolUseChunk, done bool, err error)
}

// UsageProvider is the optional addition for Providers that surface
// token-usage telemetry. The loop calls Usage() after Run completes
// (when implemented) to forward the running total into the route's
// cost-event payload. Implementations are expected to be cheap +
// safe to call concurrently with Stream — the loop only invokes it
// after the final turn returns.
type UsageProvider interface {
	// Usage returns the running total for the current stream
	// (accumulated across every turn of the loop). It is reset by
	// ResetUsage when a fresh stream begins on the same provider
	// instance.
	Usage() Usage
	// ResetUsage clears the accumulator. The route calls this before
	// each /v1/stream-direct/ request so concurrent reuse of a
	// provider value across sessions doesn't leak counts.
	ResetUsage()
}

// RequestOpts carries per-call knobs the provider may honour (model id,
// system prompt, max tokens). Providers ignore unknown fields.
type RequestOpts struct {
	Model     string
	System    string
	MaxTokens int
	Effort    string // "low" | "medium" | "high" — used by some reasoning models
	// Reasoning is the FE-supplied caps.reasoning value
	// ("enabled" | "disabled" | "" / unset). Anthropic's direct API
	// honours `thinking: {type:"enabled"}` independent of effort,
	// matching what the FE's reasoning toggle implies — without this
	// the per-turn thinking trace was suppressed on the Go path even
	// when the toggle was on. Mirrors Node tools/stream.ts:545-548.
	Reasoning string
	Stream    bool // always true for streaming, kept for symmetry
}

// ── Tool execution boundary ────────────────────────────────────────────────

// ToolRunner is the surface the loop uses to execute tools. In
// production this is *tools.Executor; tests provide a mock.
type ToolRunner interface {
	Run(ctx context.Context, name string, args map[string]any) (*tools.Result, error)
}

// Recorder is the minimal metrics surface the loop uses for emitting
// per-provider counter + latency observations. *metrics.Collector
// satisfies it implicitly. nil is permitted; emission is guarded.
type Recorder interface {
	IncCounter(name string, labels map[string]string)
	Observe(name string, labels map[string]string, value float64)
}

// Opts configures the loop itself.
type Opts struct {
	APIKey     string
	HTTPClient *http.Client
	MaxIter    int // safety cap on turns; defaults to 8
	Logger     interface{ Warn(string, ...any) }

	// Recorder is optional — when non-nil, Run emits per-provider
	// counters + latency for stream_request_count, stream_request_duration_ms,
	// and stream_iteration_count. Set by RouteDeps wiring; tests pass
	// a slice-based capture struct.
	Recorder Recorder

	// SessionID is the chat session this Run is serving; threaded
	// through so the loop can drain the BtwQueue keyed by it at each
	// tool-call boundary.
	SessionID string
	// Btw is the per-session #btw queue. The loop drains it after
	// each tool-result roundtrip and prepends drained items as a
	// synthetic user message before the next API call. nil disables
	// mid-stream injection (legacy / tests).
	Btw *BtwQueue

	// RawLog records provider request bodies + response telemetry at
	// each turn boundary so post-hoc forensics keeps working. Mirrors
	// Node's bridge/observability/raw-logs.ts:logRaw call sites in
	// chat.ts / openai-internal.ts. nil disables provider-level audit.
	RawLog interface {
		Write(kind, phase string, payload any, meta map[string]any)
	}

	// Limiter throttles outbound provider HTTP calls via per-provider
	// token bucket + concurrency cap. The loop wraps each
	// httpClient.Do invocation in Limiter.With(provider, ...) so a
	// runaway session can't 429 itself and parallel sessions respect
	// the configured per-provider concurrency. nil disables throttling
	// (legacy / tests). Mirrors the JS withRateLimit wrapper from
	// bridge/core/rate-limiter.ts.
	Limiter RateLimiter

	// APICallCount, when non-nil, is incremented once per model API
	// call — i.e. once per agentic-loop iteration (a tool-use turn
	// loops back and increments again). The route reads it on its
	// `_live` ticker so the FE busy bar can show "API×N" live. nil
	// disables (legacy / tests).
	APICallCount *atomic.Int64
}
