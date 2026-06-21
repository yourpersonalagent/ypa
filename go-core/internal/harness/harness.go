// Package harness is the Phase 6 framework for adapter-style chat
// runners that live behind the same `/v1/stream-direct/` POST as the
// direct-API providers but spawn subprocesses (claude, codex, …) or
// talk to partner gateways instead of POSTing to anthropic.com.
//
// Three concerns live here:
//
//  1. The Harness interface every adapter satisfies (see below).
//  2. A Registry that classifies a *streamRequest into the right
//     Harness so route.go can dispatch without growing a switch.
//  3. Cross-adapter helpers — emit-adapter, session-resume history,
//     usage accumulator, stop-process registry — that every adapter
//     pulls in but nobody wants to re-implement.
//
// Each concrete adapter (claudebinary, claude-sdk, codex, hermes,
// openclaw, broadcast) is its own sub-package; they import this one
// but never each other. That keeps the wire-in surface narrow — the
// route handler talks to `harness.Registry` + the resolved
// `harness.Harness`, nothing else.
package harness

import (
	"context"

	"github.com/yha/core/internal/stream"
)

// Request is the per-call payload the route handler hands to a
// Harness. Mirrors streamRequest closely but with the cross-cutting
// fields the framework needs (HarnessInstance, BroadcastEmp, the
// session-resume identifier) hoisted into named fields rather than
// nested in the FE shape.
//
// Most adapters won't read every field — codex doesn't care about
// Skills, broadcast doesn't care about ImageBlocks. Unset values are
// the framework default: empty strings / nil slices.
type Request struct {
	// SessionID is the YHA session id. Buffer entries, the cost-event
	// payload, and the stop registry are all keyed on this.
	SessionID string

	// HistorySessionID, when set and != SessionID, is the id under
	// which prior turn history lives. Broadcast forks (one fan-out
	// session id, one per-employee history id) populate this.
	HistorySessionID string

	// Model is the model id from the request body — claude-opus-4-7,
	// codex/gpt-5, gemini-2.5-pro, etc. The adapter is free to strip
	// any prefix it owns (codex strips "codex/", e.g.).
	Model string

	// Input is the raw user-text prompt. Adapters that need to fold
	// history themselves read History via the resolver passed at
	// construction time — Request never carries the full transcript.
	Input string

	// Preset is the resolved system-prompt text (NOT the preset name).
	// route.go's preset-text resolution happens before Stream is
	// called.
	Preset string

	// SystemMode is "replace" / "append" / "". The adapter uses this
	// to choose between --system-prompt vs --append-system-prompt
	// (or its equivalent).
	SystemMode string

	// Effort is "low" / "medium" / "high" / "xhigh" / "max" / "".
	// Adapters that pass-through to a model that honours --effort
	// (Anthropic, OpenAI o-series) forward it; others ignore.
	Effort string

	// Skills are the ad-hoc skill blocks the user enabled on this
	// turn. Each gets rendered into the system prompt by adapters
	// that support skills (claude-binary, codex).
	Skills []Skill

	// AllowedTools is the per-call tool allow-list. Empty = full
	// catalog. claude-binary and codex translate this into
	// --allowed-tools; broadcast and partners ignore.
	AllowedTools []string

	// CWD is the per-request working directory override. Adapters
	// that spawn subprocesses set cmd.Dir; others ignore.
	CWD string

	// ImageBlocks are the FE-uploaded image attachments. Adapters
	// that support multimodal input (claude-binary's stream-json
	// input frame) emit them inline; others must produce a sensible
	// error when the slice is non-empty (today: claude-sdk + codex).
	ImageBlocks []ImageBlock

	// HarnessInstance pins to a specific instance — used by the
	// claude-instances fan-out (each instance has its own OAuth
	// state and CLAUDE_CONFIG_DIR). Empty = use the daemon default.
	HarnessInstance string

	// CodexInstance is the codex-side analogue of HarnessInstance.
	CodexInstance string

	// GrokInstance is the grok-build analogue of HarnessInstance /
	// CodexInstance (selects per-account HOME for auth isolation).
	// Also used by pickAdapterID + broadcast wrappers to route
	// "grok" employees to the local harness (instead of direct-api).
	GrokInstance string

	// ResumeSessionID, when non-empty, is a harness-specific opaque
	// session id (from prior turn's CLI session.end or equivalent)
	// that the adapter should pass to the subprocess via --resume
	// (or ACP session reuse) so the CLI/agent continues with its
	// native memory (tool calls, plans, compaction, file state)
	// instead of a lossy text fold. Populated by primary adapter
	// fns (via harness.History) or broadcast runner when wired.
	// Broadcast adapters that want per-employee resume roundtrip
	// read this (or do their own lookup using HistorySessionID).
	// Empty = cold start or caller will fold PriorHistory.
	ResumeSessionID string

	// Provider is the FE's explicit provider override (e.g.
	// "Anthropic", "Anthropic-SUB", "Cerebras"). Adapters read this
	// to choose between subscription / API / external-proxy paths.
	Provider string

	// Caps is the FE's Caps map — capability tweaks like
	// `{"reasoning":"enabled"}`. Adapter-specific; framework just
	// passes it through.
	Caps map[string]any

	// BroadcastEmp, when non-nil, signals "this is a broadcast fork
	// running against a single employee". Adapters that don't run
	// inside a broadcast see nil. Today only the broadcast runner
	// (Wave 3) populates this.
	BroadcastEmp *EmployeeMeta
}

// Skill is one ad-hoc skill block. Mirrors the FE's SkillSet entries.
type Skill struct {
	Name    string
	Content string
}

// ImageBlock is one FE-uploaded image, base64-encoded. The MediaType
// is the same MIME type the FE attached ("image/png", "image/jpeg",
// "image/webp"). Adapter is responsible for translating into the
// provider-specific wire shape (claude expects
// {type:"image", source:{type:"base64", media_type, data}}).
type ImageBlock struct {
	MediaType string
	Base64    string
}

// EmployeeMeta is the broadcast / versus / DM-fork identity. The
// broadcast runner constructs one per fan-out target so adapters
// know which employee's tool / history / cost slice to use.
type EmployeeMeta struct {
	ID          string
	Name        string
	PartnerType string // "" | "hermes" | "openclaw" | …
	PartnerID   string
}

// Emit is the per-chunk callback shape an adapter calls to surface
// streaming output to the route handler. Reuses stream.Chunk so the
// SSE writer's existing serialiser works unchanged.
//
// Adapters MUST NOT call emit concurrently from multiple goroutines —
// the framework's AdaptEmit wraps Buffer.Append + the SSE writer and
// they aren't safe for parallel writers on the same SSE response.
type Emit func(stream.Chunk)

// Usage is the post-stream token / cost tally. The route handler
// folds this into the cost-event payload posted to Node so the
// observability-plus module records real numbers (rather than the
// zero tallies the Phase 5 cutover ships today).
//
// Fields are int64 because some adapters (broadcast aggregator) sum
// across many sub-turns and a 32-bit total would wrap on a long
// session. Cost is float64 USD.
type Usage struct {
	InputTokens   int64
	OutputTokens  int64
	CacheRead     int64
	CacheCreation int64
	Cost          float64
	Model         string
}

// Result is the value Harness.Stream returns once the turn finishes
// (cleanly or with error). Text is the assembled assistant text.
// StopReason mirrors Anthropic's stop_reason vocabulary
// ("end_turn" / "max_tokens" / "tool_use" / "stop_sequence" / "error").
type Result struct {
	Text       string
	Usage      Usage
	StopReason string
	// Err is the terminal error if any. Run-time errors that don't
	// abort the stream (e.g. a tool call failed but the model
	// continued) are emitted as ChunkTypeError chunks and do NOT
	// land here. Err is reserved for spawn failures, parser
	// failures, etc.
	Err error
}

// Harness is what each adapter implements. The framework wires
// concrete instances into a Registry; the route handler calls
// Registry.Pick(...) and forwards to whichever it gets back.
//
// Lifetime: one instance per daemon. Concurrent Stream calls are
// expected (the daemon serves many sessions in parallel). Adapters
// MUST be safe for concurrent invocation. Per-call mutable state
// (e.g. pending subprocesses, partial event buffers) lives on the
// stack of the running Stream call or in a session-scoped substruct
// keyed by Request.SessionID.
type Harness interface {
	// ID is the short stable identifier ("claude-binary", "codex",
	// "claude-sdk", "broadcast"). Used by the registry, the
	// session-resume history, and logging.
	ID() string

	// Stream runs one full turn. Blocks until the turn finishes or
	// ctx is cancelled. Each chunk produced is delivered via emit;
	// the returned Result carries the post-turn aggregates
	// (final text, usage, stop reason).
	//
	// Errors: spawn / parse / unrecoverable transport failures
	// return non-nil err AND populate Result.Err with the same
	// value. ctx.Canceled / ctx.DeadlineExceeded surface verbatim.
	// Adapters MUST NOT panic — wrap any internal panic in a
	// recover()+err return so route.go's defer-finalize fires.
	Stream(ctx context.Context, req Request, emit Emit) (Result, error)
}
