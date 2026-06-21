package stream

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/yha/core/internal/logger"
	"github.com/yha/core/internal/tools"
)

// newAgentTurnID mints a per-chat-turn identifier. Format is
// "<session-short>-<random-hex>" so the bridge's rewind log groups by
// turn but still hints at the originating session. Falls back to just
// the random suffix when sessionID is empty.
func newAgentTurnID(sessionID string) string {
	var buf [8]byte
	_, _ = rand.Read(buf[:])
	suffix := hex.EncodeToString(buf[:])
	prefix := strings.TrimSpace(sessionID)
	if prefix == "" {
		return "turn-" + suffix
	}
	if len(prefix) > 8 {
		prefix = prefix[:8]
	}
	return prefix + "-" + suffix
}

// CostEventSink is the surface the route uses to push finalize-time
// telemetry into Node's /internal/cost-event and /internal/auto-title
// endpoints. *nodecallback.CostEventClient satisfies this implicitly;
// tests pass a recording double. nil = no-op (Phase 1/Phase 3 behaviour).
type CostEventSink interface {
	Record(ctx context.Context, payload CostEventPayload) error
	EnqueueAutoTitle(ctx context.Context, sessionID string) error
	FireAndForget(label string, fn func(context.Context) error)
}

// PersistMessagePayload is the per-message body Go ships to Node's
// /internal/persist-broadcast-message endpoint at finalize time.
// SessionID + Role are required; the rest is best-effort metadata
// that Node folds into bridge/sessions/<sid>.json. Mirrors the JSON
// shape declared on PersistBroadcastMessagePayload in
// internal/nodecallback (kept separate so the stream package doesn't
// import nodecallback).
type PersistMessagePayload struct {
	SessionID    string
	Role         string // "user" | "assistant"
	Text         string
	Blocks       []PersistBlock // rich-block array (tool-call, thinking, text segments)
	Model        string
	Provider     string
	InputTokens  int
	OutputTokens int
	// DurationMs is the wall-clock turn length (turnStart→finalize) the FE
	// renders as the "counted time" in the final meta bar. Without it a
	// reloaded/switched-into turn shows only the persisted wall-clock
	// timestamp, never the elapsed the live timer was counting.
	DurationMs int
	StopReason string
	// Phase drives the live-message lifecycle (start/update/final).
	// Empty = legacy append-and-go. See nodecallback's same field for
	// the wire semantics. The user prompt persists with empty Phase;
	// the assistant turn flows start → update* → final.
	Phase     string
	LiveToken int64

	// Live counters snapshot carried on phase:"update" (and start) persists.
	// This lets reloaded / switched-into live turns have a base set of
	// growing values (tokens, tool/api counts, model, turn start) from
	// core's live ticker even before the activity feed or a new _live
	// frame arrives on re-attach. The authoritative growth stays in
	// Go's registry + tickers; these are durability snapshots.
	ToolCallCount int
	APICallCount  int
	TurnStartMs   int64
}

// PersistBlock is one entry in the rich-blocks array we ship along
// with the assistant turn so the FE can re-render tool-call and
// thinking traces after reload — not just the final text. Wire shape
// mirrors the FE's Block interface (frontend/src/chat/chat-utils.ts:4).
// Empty array → Node falls back to the plain-text path (legacy
// behaviour matches single-paragraph replies).
type PersistBlock struct {
	Type    string `json:"type"`              // "text" | "thinking" | "tool-call" | "tool-result" | "btw"
	Content string `json:"content,omitempty"` // text/thinking body OR tool-result text
	Name    string `json:"name,omitempty"`    // tool-call: tool name
	Detail  any    `json:"detail,omitempty"`  // tool-call: parsed input args
	ToolID  string `json:"toolId,omitempty"`  // tool-call / tool-result link id
	Kind    string `json:"kind,omitempty"`    // tool-result: "ok" | "error"
	// Btw-specific fields. Set when Type == "btw" — the user's
	// mid-stream `#btw <text>` injection. LivePath records how
	// delivery happened ("direct" via live stdin / "harness" queued
	// for next tool boundary / "" unknown) so the FE renders a small
	// badge. Mirrors the FE's btw Block shape
	// (frontend/src/chat/chat-utils.ts).
	Text     string `json:"text,omitempty"`
	LivePath string `json:"livePath,omitempty"`
}

// shouldLiveCheckpoint gates mid-stream persistence writes. Checkpoint payloads
// contain the full accumulated assistant text, so their marshal → HTTP POST →
// JSON parse → SQLite UPDATE cost grows with the turn. Persist small turns
// frequently for crash recovery, but back off as the text becomes large; the
// final write still persists the complete rich-block transcript.
func shouldLiveCheckpoint(now time.Time, textLen int, lastAt *time.Time, lastLen *int) bool {
	if textLen <= 0 {
		return false
	}
	if lastLen != nil && textLen == *lastLen {
		return false
	}
	interval := 2 * time.Second
	switch {
	case textLen >= 1024*1024:
		interval = 30 * time.Second
	case textLen >= 256*1024:
		interval = 15 * time.Second
	case textLen >= 64*1024:
		interval = 8 * time.Second
	case textLen >= 16*1024:
		interval = 4 * time.Second
	}
	if lastAt != nil && !lastAt.IsZero() && now.Sub(*lastAt) < interval {
		return false
	}
	if lastAt != nil {
		*lastAt = now
	}
	if lastLen != nil {
		*lastLen = textLen
	}
	return true
}

// MessagePersister persists a single chat turn message into the
// per-session JSON file Node owns. The route calls this for the user
// prompt + the assistant reply on every successful stream-direct
// turn, so the FE's history survives session switches and reloads.
// nil = no-op (legacy behaviour; data loss on reload).
//
// PersistWithToken is the variant that reads back the live-message
// token returned by phase="start" so subsequent update/final calls
// can address the same placeholder entry. Persist is kept for
// fire-and-forget user-side persists where the response isn't useful.
type MessagePersister interface {
	Persist(ctx context.Context, payload PersistMessagePayload) error
	PersistWithToken(ctx context.Context, payload PersistMessagePayload) (int64, error)
}

// AbandonedMessageFinalizer is an optional extension implemented by the
// Node-backed persister. Go owns /v1/stop, while Node owns displaySessions;
// the stop path uses this callback to clear durable streaming placeholders.
type AbandonedMessageFinalizer interface {
	FinalizeAbandoned(ctx context.Context, sessionID, reason string) error
}

// StopRegistry is the surface the route uses to register and clear
// per-session kill switches so a Go-side POST /v1/stop/:sessionId can
// abort an in-flight turn. *harness.ActiveProcesses satisfies this
// implicitly. nil = the Stop button is a no-op (legacy / tests).
type StopRegistry interface {
	Register(sessionID string, kill func())
	Stop(sessionID string) bool
	Drop(sessionID string)
}

// HistoryLoader fetches prior-turn LLM context for a session. The
// route folds the returned messages into req.Messages before calling
// the model so multi-turn conversations actually carry context across
// turns. Pre-Phase-7 Node owned /v1/stream/ and pulled this in-process
// from chatHistory; after the cutover Go has to hop back to Node via
// /internal/session-history.
//
// selfEmpID scopes the result to one employee's perspective so
// versus / broadcast forks see a coherent monolog (other employees'
// assistant turns become `[Name]: ...` user messages). Empty =
// shared default history. nil loader = legacy "every turn looks
// like turn #1" behaviour.
type HistoryLoader interface {
	Load(ctx context.Context, sessionID, selfEmpID string) ([]Message, error)
}

// CostEventPayload is the JSON body shape POSTed to /internal/cost-event.
// Fields match bridge/routes/internal.ts:106. Mirrors the equivalent
// struct in internal/nodecallback so the stream package doesn't
// import nodecallback (interface boundary keeps cycles out).
type CostEventPayload struct {
	SessionID           string  `json:"sessionId"`
	Model               string  `json:"model"`
	Provider            string  `json:"provider,omitempty"`
	InputTokens         int     `json:"inputTokens"`
	OutputTokens        int     `json:"outputTokens"`
	CacheReadTokens     int     `json:"cacheReadTokens,omitempty"`
	CacheCreationTokens int     `json:"cacheCreationTokens,omitempty"`
	Cost                float64 `json:"cost,omitempty"`
	ToolCallCount       int     `json:"toolCallCount,omitempty"`
	DurationMs          int64   `json:"durationMs"`
	// Tools — one record per tool_use chunk seen during the turn.
	// Node fans these out as `surface:'tool'` telemetry events so the
	// #debug toolsmon byTool panel reflects the model's native tool
	// calls (Read/Write/Bash/Edit/Grep/…) that happen inside the
	// claude-binary subprocess and never touch the bridge's
	// executeBridgeTool path.
	Tools []ToolEventRecord `json:"tools,omitempty"`
}

// ToolEventRecord is one tool_use observation, flushed in batch with
// the cost-event POST. Name = tool name (e.g. "Bash"); OK reflects the
// matching tool_result outcome (defaults to true since the binary's
// tool_result blocks don't carry an error flag at the layer we read).
type ToolEventRecord struct {
	Name string `json:"name"`
	OK   bool   `json:"ok"`
}

// RouteDeps wires the route handler to the surrounding daemon. Caller
// provides closures so internal/stream stays free of internal/state.
type RouteDeps struct {
	// APIKeyFor returns the API key for the given provider name
	// ("openai" | "anthropic" | "gemini"). Empty string means the
	// route returns 503 with a clear "no key configured" body.
	APIKeyFor func(provider string) string

	// Runner is the unified tool dispatch surface — it both produces
	// the catalog advertised to the model and executes the tool calls
	// the model issues. In production this is a *tools.CompositeRunner
	// fanned across built-ins, MCP pool, and Node-callback; tests pass
	// any tools.Runner.
	Runner tools.Runner

	// CatalogFilter, when non-nil, narrows Runner.Catalog() to just
	// these tool names per request. The body's "tools" field is fed
	// here from the route's request handler. Empty/nil = full catalog.
	CatalogFilter func(catalog []Tool, names []string) []Tool

	// HTTPClient is the upstream client used by the loop. Optional —
	// a default with 5m timeout is used if nil.
	HTTPClient *http.Client

	Logger *logger.Logger

	// PickProvider overrides the default model-prefix routing. Tests
	// pass a scripted provider here. nil = use the prefix matcher.
	PickProvider func(model string) (Provider, string, error)

	// Recorder is optional — when non-nil, threaded into Opts.Recorder
	// so each /v1/stream-direct/ call emits per-provider counters +
	// latency. Caller passes the daemon's *metrics.Collector here.
	Recorder Recorder

	// Buffer is the per-session reattach ring buffer (Phase 3). When
	// non-nil and the request body carries a non-empty SessionId, every
	// emitted chunk is stamped with a monotonic Seq and appended to the
	// buffer so a later GET /v1/sessions/:id/stream-direct?fromSeq=N
	// can replay missed chunks. nil = no buffering (Phase 1 behaviour).
	Buffer *SessionBuffer

	// CostEvents posts finalize-time cost + auto-title events to Node.
	// Optional — nil leaves telemetry to whatever already sees the
	// stream (e.g. the reattach handler or the FE itself).
	CostEvents CostEventSink

	// PersistMessage saves a user/assistant message into
	// bridge/sessions/<sid>.json so the chat history survives session
	// switches and reloads. Each stream-direct turn (single or
	// broadcast) must call this once per role at finalize — without it,
	// the per-session JSON file stays empty and the FE loses every
	// turn the moment it switches sessions. Wired in cmd/yha-core/main.go
	// to nodecallback.PersistBroadcastMessageClient. Optional, but
	// leaving it nil silently drops every chat turn on disk.
	PersistMessage MessagePersister

	// SQLiteFinalizer (Step 6) writes phase="final" directly into the
	// bridge's sessions.db, bypassing the HTTP round-trip to the bridge
	// for the durability-critical write. The bridge HTTP POST is still
	// issued afterwards so the bridge's in-memory displaySessions Map
	// stays in sync — but the HTTP call is no longer on the path that
	// loses data if the bridge restarts mid-finalize.
	//
	// Optional. nil = legacy behaviour (HTTP-only persist; bridge
	// restart between FE _end and bridge final write surfaces the
	// "Bridge restarted before this reply could finish" interrupt).
	SQLiteFinalizer *SQLiteFinalizer

	// Classifier overrides the default direct-vs-proxy decision. Tests
	// inject a scripted classifier; production uses classifyRoute.
	Classifier func(req *streamRequest, keyFor func(string) string) routeDecision

	// HarnessAdapters maps a harness instance label (e.g.
	// "claude-binary") to a Go-side handler. When a non-direct
	// request matches a key here, the route dispatches to the
	// adapter. As of Phase 6g the per-label env-var gate is opt-OUT:
	// any registered adapter is on by default, and operators force a
	// hard fail by setting YHA_GO_<UPPER>=0 (or "false",
	// case-insensitive) — e.g. YHA_GO_CLAUDE_BINARY=0 makes
	// claude-binary traffic 502 with the Phase 7 "no adapter" error
	// (there is no Node /v1/stream/ fallback after Phase 7).
	// Phase 6 harness ports add their adapter here.
	//
	// Adapter receives the parsed request, an emit callback that
	// already stamps chunks + writes SSE, and a finalize callback so
	// cost/auto-title still fire. The adapter must call emit() for
	// each chunk + finalize() exactly once on clean completion (or
	// return an error and skip finalize).
	HarnessAdapters map[string]HarnessAdapterFn

	// Participants resolves persisted session participant routing
	// state (participants, groupMode, employee/partner targets). When
	// present, any session with participants is kept off the direct-API
	// path so employee / partner semantics don't accidentally bypass
	// Node's routing contract.
	Participants ParticipantResolver

	// GenericProvider resolves a configured non-builtin provider (e.g.
	// DeepSeek, NVIDIA NIM, OpenRouter, Groq) to its OpenAI-compatible
	// endpoint + api key. When pickProvider can't classify a model by
	// id (e.g. "deepseek-chat" doesn't match the gpt-/claude-/gemini-
	// prefixes) but req.Provider names a configured provider with both
	// endpoint and key set, the classifier returns Direct=true and the
	// route hands the call to an OpenAIProvider whose BaseURL points at
	// that endpoint. Restores Node's `type: 'external'` branch from
	// bridge/providers/core.ts:resolveRouteType so third-party models
	// stream token-by-token instead of being funneled through the
	// buffering claude-binary detour.
	//
	// nil = legacy behaviour (only built-in providers stream natively;
	// everything else falls into the harness ladder).
	GenericProvider func(providerName string) (endpoint, apiKey string, ok bool)

	// History loads prior-turn LLM context for the session. The route
	// folds the returned messages in front of req.Messages on every
	// turn so multi-turn conversations carry context. Without this,
	// "what did I say first?" returns "this is a fresh interaction"
	// every time. nil disables history threading.
	History HistoryLoader

	// UploadsDir is the absolute path to bridge/uploads (or the
	// configured upload directory). Used to resolve FE-supplied
	// image attachments — the FE ships `{type:"image",
	// url:"/uploads/abc.png"}` entries; the route reads each file and
	// turns them into base64 ImageBlock entries attached to the new
	// user message. Empty string disables image attachments entirely.
	UploadsDir string

	// SessionsDir is the absolute path to bridge/sessions. The route
	// reads <sid>.json on each turn to honour the session's pinned
	// workingDir when the FE didn't ship CWD explicitly. Empty string
	// → no per-session CWD lookup (FE CWD is the only source).
	SessionsDir string

	// DefaultCWD is the daemon-wide fallback working directory used when
	// neither the FE nor the per-session pin yields a usable path (e.g.
	// the pinned dir no longer exists on disk after a rename/move).
	// Without it, an empty req.CWD would make the spawn inherit the
	// daemon process's own cwd — a silent, surprising fallback that
	// retargets sessions to wherever yha-core happens to be running
	// from. Wired from cmd/yha-core/main.go (env YHA_DEFAULT_CWD →
	// process cwd → $HOME). Should always be a real, existing directory.
	DefaultCWD string

	// BridgeRoot is the absolute path to bridge/. Used to read the
	// shared important-memory.json + cwd-context-memory.json so the
	// "Important — shared memory across agents" and "CWD context"
	// footers get appended to every system prompt. Empty → footers
	// disabled (legacy / tests).
	BridgeRoot string

	// Btw is the per-session #btw queue the FE feeds via
	// POST /v1/sessions/:id/btw. The direct-API tool loop drains it
	// at each tool-call boundary and injects a synthetic user
	// message before the next API roundtrip. nil disables mid-stream
	// injection.
	Btw *BtwQueue

	// ActiveStops is the per-session kill-switch registry. Each
	// turn registers its detached-context cancel func against
	// req.SessionId; a POST /v1/stop/:sid endpoint Stop()s it. nil
	// means the Stop button is a no-op (legacy / tests). Mirrors
	// Node's activeProcesses Map (bridge/core/state.ts).
	ActiveStops StopRegistry

	// ResolveSkills expands a SkillSet name (whatever the FE shipped
	// in body.SkillSet) into the actual skill markdown blocks the
	// harness adapter / direct-API system prompt should fold in. The
	// route handler calls it once per turn before dispatching. Mirrors
	// Node's bridge/chat/helpers.ts:resolveSkills. nil disables skill
	// expansion (FE's skill picker becomes a no-op on Go).
	ResolveSkills func(setName string) []SkillBlock

	// RawLog writes provider request/response audit entries to
	// bridge/api-inout-log/session-NNNN.log so post-hoc forensics
	// (which prompt did the model see / what did it reply) keeps
	// working after Phase 7. Mirrors Node's logRaw call sites in
	// chat.ts, openai-internal.ts, codex.ts. nil disables raw logging.
	RawLog RawLogger

	// ResolveToolSet expands a `ToolSetPreset` body name into the
	// corresponding AllowedTools list from config.toolSets. The route
	// calls this once per turn before dispatch and overwrites
	// req.AllowedTools with the result. Mirrors Node's old chat.ts:
	// 466-469 `allowedTools = [...config.toolSets[ToolSetPreset]]`.
	// nil = the FE's tool-set picker becomes a no-op on Go.
	ResolveToolSet func(setName string) []string

	// ToolCommandOverwrite returns the operator-configured global
	// tool allow-list + whether the gate is enabled. When enabled,
	// the route intersects per-turn AllowedTools with this list so
	// a rogue FE / preset can't smuggle dangerous tools past policy.
	// Mirrors Node config.defaults.tool_command_overwrite_enabled /
	// tool_command_overwrite_tools (bridge/config/handler.ts:261).
	ToolCommandOverwrite func() (allow []string, enabled bool)

	// DefaultSystemPrompt returns the default system prompt to fold
	// in when SystemMode is "append" / unset (Node: appends the
	// configured default before the per-turn preset; SystemMode="replace"
	// drops it). Reads config.defaults.preset → config.presets[name],
	// matching Node's getDefaultSystem (bridge/providers/core.ts:179).
	// Empty string means "no default" — the per-turn preset alone is
	// used.
	DefaultSystemPrompt func() string

	// ResolvePreset turns a per-turn preset reference (req.Preset) into
	// its body text. The FE sends the preset NAME, not the body, so the
	// route must look it up in config.presets before folding it into
	// the system prompt. Mirrors Node's presetText (bridge/providers/
	// core.ts:218): a name in config.presets resolves to its body;
	// anything else is returned verbatim so callers can also pass
	// inline preset text. nil → the route falls back to the raw
	// req.Preset string (legacy Phase-7 behaviour, which leaked the
	// literal name as the prompt).
	ResolvePreset func(nameOrText string) string

	// ModelPricing returns per-1M-token input + output prices for the
	// modelName. The route uses these to stamp `cost` on the `_end`
	// chunk so the FE's per-turn stats line shows real dollars on
	// direct-API paths (was always $0.00 because Node's pricing table
	// wasn't ported). Mirrors Node's bridge/models/config.ts:getModelPricing.
	// nil = cost stays zero on the wire; Node-side accounting still
	// records what it can on the cost-event hop.
	ModelPricing func(modelName string) (priceInput, priceOutput float64, ok bool)

	// Limiter throttles outbound provider HTTP calls so a runaway
	// session can't 429 itself and per-provider concurrency caps are
	// honoured across parallel sessions. Threaded into stream.Opts on
	// every Run call. nil = legacy behaviour (no Go-side back-pressure,
	// upstream proxy still gates per-IP). Wired by cmd/yha-core/main.go
	// from rate.NewLimiter(defaults, rateConfigFromStore(store)).
	Limiter RateLimiter

	// AgentTurn, when non-nil, is called at the start of every chat
	// turn with a per-turn id and at finalize with Clear so the
	// bridge's rewind recorder can tag records written during this
	// turn. Wired in cmd/yha-core/main.go to
	// *nodecallback.AgentTurnClient. nil = bridge falls back to its
	// process-wide id (records grouped by bridge restart, not by turn).
	AgentTurn AgentTurnNotifier
}

// AgentTurnNotifier is the subset of *nodecallback.AgentTurnClient the
// stream route uses. Implementations should be best-effort and never
// block the user-visible chat turn — the route calls FireSet / FireClear
// which dispatch on goroutines with their own timeout.
type AgentTurnNotifier interface {
	FireSet(turnID string)
	FireClear()
}

// RawLogger is the subset of *rawlog.Logger the stream route uses.
// Defined here so the stream package doesn't import internal/rawlog
// directly — the daemon wires the concrete type in main.go.
type RawLogger interface {
	Write(kind, phase string, payload any, meta map[string]any)
}

// HarnessAdapterRequest is the exported, route-normalised view of the
// request passed to opt-in harness adapters. It intentionally mirrors
// the FE body shape fields the Node harnesses care about, while hiding
// the stream package's internal request struct from cmd/yha-core.
type HarnessAdapterRequest struct {
	Model           string
	Input           string
	System          string
	SessionID       string
	CWD             string
	Provider        string
	Preset          string
	Effort          string
	SystemMode      string
	HarnessInstance string
	CodexInstance   string
	GrokInstance    string
	AllowedTools    []string
	Attachments     []any
	// ImageBlocks is the resolved + base64-encoded image set the
	// route has pulled off Attachments. Harness adapters that talk
	// to vision-capable backends (claude-binary, codex with the gpt-
	// 5 image input, …) pass these into their initial stdin / API
	// call. nil = no images on this turn.
	ImageBlocks []ImageBlock
	SkillSet    any
	// Skills are the resolved skill markdown blocks the harness
	// adapter should fold into the prompt. The route resolves
	// SkillSet → []SkillBlock via deps.ResolveSkills before dispatch
	// so each adapter (claudebinary, codex, hermes, …) gets the
	// already-expanded set. nil/empty = no skills on this turn.
	Skills      []SkillBlock
	Caps        map[string]any
	Participant *HarnessAdapterParticipant
	GroupMode   string
	Broadcast   bool
	ViaMention  bool
	// ParticipantIDs is the ordered participant id list copied from
	// the resolved ParticipantRouteContext. The broadcast adapter
	// fans out across these; single-target adapters ignore.
	ParticipantIDs []string
	// PriorHistory is the prior-turn LLM context loaded via
	// deps.History before dispatch. Subscription-style adapters
	// (claude-binary, codex) use this as a fallback when their
	// own session-resume index has no entry for the current
	// session — without it the binary starts a fresh conversation
	// every branch / first turn and "forgets" what was said before.
	// Mirrors Node's claude-stream.ts:87-101 priorHistory fold.
	// Empty for sessions with no prior turns, fresh sessions, or
	// when deps.History is unwired. Adapters that already pass full
	// transcripts (direct API, broadcast) ignore this field.
	PriorHistory []Message
}

type HarnessAdapterParticipant struct {
	ID          string
	Name        string
	PartnerType string
	PartnerID   string
}

// HarnessAdapterFn is the signature each Phase 6 harness port must
// satisfy. It runs the harness end-to-end; emit + finalize close over
// the route handler's state so the adapter doesn't have to know about
// reattach buffers / cost events / etc.
//
// emit is called for every chunk; it already does buffer Append + SSE
// write. The adapter MUST NOT close the response writer — the outer
// handler owns its lifecycle.
//
// finalize is called once when the adapter completes cleanly; it
// passes back the final cost/usage so the route handler can post
// cost-event + auto-title. If the adapter returns a non-nil error,
// finalize is NOT called.
type HarnessAdapterFn func(ctx context.Context, req HarnessAdapterRequest, body []byte, emit EmitFn, finalize HarnessFinalizeFn) error

// HarnessFinalizeFn is the callback an adapter invokes with its
// resolved per-turn telemetry. The route handler merges it into the
// CostEventPayload it ships to Node.
type HarnessFinalizeFn func(payload HarnessFinalize)

// HarnessFinalize carries the per-stream telemetry an adapter
// surfaces. Zero values are fine — the cost handler tolerates them.
type HarnessFinalize struct {
	InputTokens         int
	OutputTokens        int
	CacheCreationTokens int
	CacheReadTokens     int
	Cost                float64
	Model               string
	Provider            string
	StopReason          string
}

func buildHarnessAdapterRequest(req *streamRequest, participantCtx ParticipantRouteContext, uploadsDir string, resolveSkills func(string) []SkillBlock) HarnessAdapterRequest {
	if req == nil {
		return HarnessAdapterRequest{}
	}
	input := req.Input
	if strings.TrimSpace(participantCtx.Input) != "" {
		input = participantCtx.Input
	}
	var participant *HarnessAdapterParticipant
	if participantCtx.Target != nil {
		participant = &HarnessAdapterParticipant{
			ID:          participantCtx.Target.ID,
			Name:        participantCtx.Target.Name,
			PartnerType: participantCtx.Target.PartnerType,
			PartnerID:   participantCtx.Target.PartnerID,
		}
	}
	// Skill expansion. The FE ships a SkillSet name (or nothing);
	// the route resolves it once into the actual markdown blocks
	// each harness adapter can fold into its prompt. Empty when
	// SkillSet is unset or the resolver is nil.
	var skills []SkillBlock
	if resolveSkills != nil {
		if setName, _ := req.SkillSet.(string); strings.TrimSpace(setName) != "" {
			skills = resolveSkills(setName)
		}
	}
	return HarnessAdapterRequest{
		Model:           req.Model,
		Input:           input,
		System:          req.System,
		SessionID:       req.SessionId,
		CWD:             req.CWD,
		Provider:        req.Provider,
		Preset:          string(req.Preset),
		Effort:          req.Effort,
		SystemMode:      req.SystemMode,
		HarnessInstance: req.HarnessInstance,
		CodexInstance:   req.CodexInstance,
		GrokInstance:    req.GrokInstance,
		AllowedTools:    append([]string(nil), req.AllowedTools...),
		Attachments:     append([]any(nil), req.Attachments...),
		ImageBlocks:     ResolveImageAttachments(uploadsDir, req.Attachments),
		SkillSet:        req.SkillSet,
		Skills:          skills,
		Caps:            cloneStringAnyMap(req.Caps),
		Participant:     participant,
		GroupMode:       participantCtx.GroupMode,
		Broadcast:       participantCtx.Broadcast,
		ViaMention:      participantCtx.ViaMention,
		ParticipantIDs:  append([]string(nil), participantCtx.ParticipantIDs...),
	}
}

func cloneStringAnyMap(in map[string]any) map[string]any {
	if len(in) == 0 {
		return nil
	}
	out := make(map[string]any, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}

// flexString is a string field that also accepts JSON numbers, bools,
// or null on the wire. Non-string values are coerced to "" — the FE
// historically ships `Preset: 0` (numeric, vestigial of an old
// preset-index design) which Node accepted silently. Go's strict typed
// decoder rejected it as `cannot unmarshal number into string` and
// surfaced as a 400 on every chat once Phase 7 made Go the FE default.
type flexString string

func (s *flexString) UnmarshalJSON(b []byte) error {
	if len(b) == 0 || string(b) == "null" {
		*s = ""
		return nil
	}
	if b[0] == '"' {
		var raw string
		if err := json.Unmarshal(b, &raw); err != nil {
			return err
		}
		*s = flexString(raw)
		return nil
	}
	*s = ""
	return nil
}

// streamRequest is the JSON body the route accepts. Two parallel
// surfaces:
//
//   - Lower-case fields (model, input, messages, …) are the Go-native
//     wire shape used since Phase 1 of the cutover. Tests + the
//     embedded `yha` CLI still talk to these.
//   - Capitalised fields (Input, Model, Provider, …) match the body
//     Node's POST /v1/stream/ has accepted since the beginning — what
//     the frontend ships today (frontend/src/api.ts:111). Phase 5
//     teaches Go to accept both so the FE feature-flag flip is a
//     one-line endpoint swap and nothing else.
//
// The decoder layer normalises the two into the lower-case fields the
// downstream code already uses; if both are present the upper-case
// wins (so when the FE sends `Model`, the override is unambiguous).
type streamRequest struct {
	// Go-native fields (Phase 1).
	Model     string    `json:"model"`
	Input     string    `json:"input"`
	Messages  []Message `json:"messages"`
	System    string    `json:"system"`
	Tools     []string  `json:"tools"` // names to expose; nil = full catalog
	MaxTokens int       `json:"max_tokens"`
	Effort    string    `json:"effort"`
	// SessionId threads through tool calls so Node-served module tools
	// (AskUser, RunCode, Task) can attach to the right session for
	// downstream UI prompts and cost tracking. Empty = no session.
	SessionId string `json:"sessionId"`
	// CWD overrides the daemon's default working directory for tool
	// calls in this request. Mostly used by Node-served tools that
	// need a per-request cwd (RunCode in particular).
	CWD string `json:"cwd"`

	// FE-shape fields (Phase 5). All Pascal-cased keys match the body
	// bridge/routes/chat.ts:114 destructures. The route doesn't have
	// to act on every one of these — most are forwarded verbatim when
	// the request proxies to Node. But Provider / HarnessInstance /
	// CodexInstance are inspected by the classifier to decide whether
	// Go owns the request or it proxies.
	UCInput         string         `json:"Input,omitempty"`
	UCModel         string         `json:"Model,omitempty"`
	Provider        string         `json:"Provider,omitempty"`
	Preset          flexString     `json:"Preset,omitempty"`
	Presets         []string       `json:"Presets,omitempty"`
	UCSessionId     string         `json:"SessionId,omitempty"`
	Attachments     []any          `json:"Attachments,omitempty"`
	UCEffort        string         `json:"Effort,omitempty"`
	SystemMode      string         `json:"SystemMode,omitempty"`
	SkillSet        any            `json:"SkillSet,omitempty"`
	HarnessInstance string         `json:"HarnessInstance,omitempty"`
	CodexInstance   string         `json:"CodexInstance,omitempty"`
	GrokInstance    string         `json:"GrokInstance,omitempty"`
	Caps            map[string]any `json:"Caps,omitempty"`
	AllowedTools    []string       `json:"AllowedTools,omitempty"`
	ToolSetPreset   string         `json:"ToolSetPreset,omitempty"`
	UCCWD           string         `json:"CWD,omitempty"`
}

// normalise folds the Pascal-cased FE-shape fields into the
// lower-case Go-native ones the rest of the route already reads.
// Upper-case wins when both are populated because the FE-driven
// flow is the Phase 5 cutover target — Phase 1 tests with
// lower-case keys keep working untouched.
func (req *streamRequest) normalise() {
	if req.UCModel != "" {
		req.Model = req.UCModel
	}
	if req.UCInput != "" {
		req.Input = req.UCInput
	}
	if req.UCSessionId != "" {
		req.SessionId = req.UCSessionId
	}
	if req.UCEffort != "" {
		req.Effort = req.UCEffort
	}
	if req.UCCWD != "" {
		req.CWD = req.UCCWD
	}
	// Note: Preset → System fold is done at the route-handler level
	// now so it can honour SystemMode (replace vs append) and the
	// configured default-system fallback. See the block right after
	// req.normalise() in RegisterRoute.
	if len(req.Tools) == 0 && len(req.AllowedTools) > 0 {
		req.Tools = req.AllowedTools
	}
}

// RegisterRoute mounts POST /v1/stream-direct/ on mux. Phase 7 deleted
// the Node /v1/stream/ POST route — this is now the only POST stream
// endpoint. The route handles direct-API providers itself and dispatches
// every other class of request through the registered HarnessAdapters
// (claude-binary, claude-sdk, codex, openclaw, hermes, broadcast). When
// nothing claims the request the route surfaces a 502 with the
// canonical "no harness adapter available" body.
func RegisterRoute(mux *http.ServeMux, deps RouteDeps) {
	if deps.Logger == nil {
		deps.Logger = logger.New(io.Discard)
	}
	mux.HandleFunc("/v1/stream-direct/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
			return
		}

		// Buffer the body so we can re-send it to Node if classifyRoute
		// decides this isn't a direct-API request. ReadAll caps at the
		// http.Server's default body limit — anything beyond that is
		// rejected upstream already.
		bodyBytes, err := io.ReadAll(r.Body)
		if err != nil {
			http.Error(w, `{"error":"failed to read body"}`, http.StatusBadRequest)
			return
		}
		_ = r.Body.Close()

		var req streamRequest
		if err := json.Unmarshal(bodyBytes, &req); err != nil {
			http.Error(w, `{"error":"invalid JSON body"}`, http.StatusBadRequest)
			return
		}
		req.normalise()
		if req.Model == "" {
			http.Error(w, `{"error":"model required"}`, http.StatusBadRequest)
			return
		}
		if len(req.Messages) == 0 && req.Input == "" {
			http.Error(w, `{"error":"input or messages required"}`, http.StatusBadRequest)
			return
		}
		// Tag every rewind record written during this chat turn with a
		// fresh id so the rewind UI can group edits within a single
		// user message. Best-effort: FireSet/FireClear dispatch on
		// goroutines with their own timeout; if Node is unreachable the
		// bridge falls back to its process-wide id.
		if deps.AgentTurn != nil {
			turnID := newAgentTurnID(req.SessionId)
			deps.AgentTurn.FireSet(turnID)
			defer deps.AgentTurn.FireClear()
		}
		// Extract inline `![alt](/uploads/...)` markdown image
		// references from the prompt body. Mirrors Node's
		// bridge/sessions-internal/images.ts:extractImageBlocks —
		// the prompt is rewritten with `[Image: alt]` placeholders
		// and the resolved blocks are folded into req.Attachments so
		// the downstream image-resolver path treats them identically
		// to FE-uploaded attachments.
		if deps.UploadsDir != "" && strings.TrimSpace(req.Input) != "" {
			rewritten, inline := ExtractInlineImageBlocks(deps.UploadsDir, req.Input)
			if len(inline) > 0 {
				req.Input = rewritten
				// Convert into the Attachments wire shape (the FE
				// sends `{type:"image", url}` entries — for inline
				// blocks the URL is implicit, so we emit a synthetic
				// data-URI form that ResolveImageAttachments would
				// also accept). Easier: short-circuit by appending
				// the resolved ImageBlocks to req.Attachments as
				// already-decoded entries that the harness pipeline
				// picks up via buildHarnessAdapterRequest.
				for _, blk := range inline {
					req.Attachments = append(req.Attachments, map[string]any{
						"type":      "image",
						"mediaType": blk.MediaType,
						"base64":    blk.Base64,
					})
				}
			}
		}

		// Fold the per-session workingDir override into req.CWD when
		// the FE didn't supply one. SQLite is canonical (Step 4 of
		// docs/SQL-migration-plan.md); the JSON-file read is kept as a
		// fallback for setups that haven't activated Step 6 yet.
		//
		// Stale-cwd guard: persisted session cwds outlive directory
		// renames/deletes; spawning the binary with a missing `cmd.Dir`
		// fails with `chdir: no such file or directory` (Linux) or
		// "The system cannot find the path specified" (Windows) and the
		// turn produces zero tokens.
		//
		// FE-supplied req.CWD validation: historically trusted as-is so
		// tests / explicit overrides kept working. On Windows that bit
		// us when a Pi-exported session (cwd = "/home/user/...") was
		// re-opened on a Windows install — FE sent the Linux path, the
		// binary spawn failed with ERROR_PATH_NOT_FOUND, error message
		// confusingly pointed at the binary path (not the cwd). Now we
		// stat-check the FE-supplied value too; if it's a real dir we
		// keep it, otherwise we clear it and fall through to the
		// session-pin / DefaultCWD chain.
		if cwd := strings.TrimSpace(req.CWD); cwd != "" {
			if _, err := os.Stat(cwd); err != nil {
				if deps.Logger != nil {
					deps.Logger.Warn("stream.cwd.fe-missing",
						"session", req.SessionId, "cwd", cwd, "err", err)
				}
				req.CWD = ""
			}
		}
		//
		// Final fallback: deps.DefaultCWD. Without it, an empty req.CWD
		// leaks downstream and the harness spawn silently inherits the
		// daemon process's own cwd — every session retargets to wherever
		// yha-core was launched. Always assigning an explicit DefaultCWD
		// makes the working directory observable in logs and keeps
		// chats deterministic regardless of how the daemon was started.
		if strings.TrimSpace(req.CWD) == "" {
			pinned, ok := deps.SQLiteFinalizer.SessionWorkingDir(req.SessionId)
			if !ok || pinned == "" {
				if deps.SessionsDir != "" {
					pinned = LoadSessionWorkingDir(deps.SessionsDir, req.SessionId)
				}
			}
			if pinned != "" {
				if _, err := os.Stat(pinned); err != nil {
					if deps.Logger != nil {
						deps.Logger.Warn("stream.cwd.missing",
							"session", req.SessionId, "cwd", pinned, "err", err)
					}
				} else {
					req.CWD = pinned
				}
			}
			if strings.TrimSpace(req.CWD) == "" && strings.TrimSpace(deps.DefaultCWD) != "" {
				req.CWD = deps.DefaultCWD
				if deps.Logger != nil {
					deps.Logger.Info("stream.cwd.default",
						"session", req.SessionId, "cwd", req.CWD)
				}
			}
		}

		// ToolSetPreset expansion: when the FE shipped a named tool
		// set (e.g. "Coder-Tools"), substitute the resolved list into
		// req.AllowedTools so downstream catalog filtering + harness
		// adapters see the real tools. Mirrors Node old chat.ts:466.
		if name := strings.TrimSpace(req.ToolSetPreset); name != "" && deps.ResolveToolSet != nil {
			if expanded := deps.ResolveToolSet(name); len(expanded) > 0 {
				req.AllowedTools = expanded
				if len(req.Tools) == 0 {
					req.Tools = expanded
				}
			}
		}
		// Global tool-command-overwrite gate. When the operator has
		// flipped `config.defaults.tool_command_overwrite_enabled = true`,
		// the per-turn AllowedTools is intersected with the global
		// allow-list at `config.defaults.tool_command_overwrite_tools`.
		// Mirrors Node old chat.ts:446-462 — a security knob so a
		// rogue FE / preset can't smuggle dangerous tools past the
		// operator's policy.
		if deps.ToolCommandOverwrite != nil {
			if allow, on := deps.ToolCommandOverwrite(); on && len(allow) > 0 {
				allowSet := make(map[string]struct{}, len(allow))
				for _, t := range allow {
					allowSet[t] = struct{}{}
				}
				filter := func(in []string) []string {
					if len(in) == 0 {
						return in
					}
					out := make([]string, 0, len(in))
					for _, t := range in {
						if _, ok := allowSet[t]; ok {
							out = append(out, t)
						}
					}
					return out
				}
				req.AllowedTools = filter(req.AllowedTools)
				req.Tools = filter(req.Tools)
			}
		}
		pickFn := deps.PickProvider
		if pickFn == nil {
			pickFn = pickProvider
		}

		var participantCtx ParticipantRouteContext
		if deps.Participants != nil && strings.TrimSpace(req.SessionId) != "" {
			participantCtx, err = deps.Participants.Resolve(req.SessionId, req.Input)
			if err != nil {
				deps.Logger.Warn("stream.participants.resolve", "sessionId", req.SessionId, "err", err)
			}
		}

		// Employee-level capability gates. When the resolved
		// participant target is a single employee (not broadcast
		// fan-out), honour the capVision / capTools / skillSet /
		// systemPromptPreset overrides recorded in the employee's
		// markdown frontmatter. Mirrors Node chat.ts:471-473 pre-
		// Phase-7. Broadcast fan-out has its own per-employee gate
		// logic inside broadcast.Runner — this branch only fires for
		// the single-target case.
		if participantCtx.Target != nil && len(participantCtx.ParticipantIDs) <= 1 {
			emp := participantCtx.Target
			if emp.CapVision == "off" {
				req.Attachments = nil
			}
			switch emp.CapTools {
			case "off":
				req.AllowedTools = []string{}
				req.Tools = []string{}
			case "filter":
				if emp.ToolSetPreset != "" && deps.ResolveToolSet != nil {
					if expanded := deps.ResolveToolSet(emp.ToolSetPreset); len(expanded) > 0 {
						req.AllowedTools = expanded
						req.Tools = expanded
					}
				}
			}
			if s, _ := req.SkillSet.(string); strings.TrimSpace(s) == "" && emp.SkillSet != "" {
				req.SkillSet = emp.SkillSet
			}
			if strings.TrimSpace(string(req.Preset)) == "" && emp.SystemPromptPreset != "" {
				req.Preset = flexString(emp.SystemPromptPreset)
			}
		}

		// Global caps.tools from the main request (non-employee path).
		// FE sends Caps: {tools: false | "off" | "filter" | "on"} (bool or string).
		// When off, force explicit empty lists so the catalog logic above yields
		// zero tools → no "tools" array in the Gemini/OpenAI-direct request body.
		// This is the missing gate that made "deactivate tool calls" a no-op for
		// direct Gemini models (gemini-*-flash etc). Employee CapTools handled above.
		if c := req.Caps; c != nil {
			if tv, ok := c["tools"]; ok {
				off := false
				switch v := tv.(type) {
				case bool:
					off = !v
				case string:
					vs := strings.ToLower(strings.TrimSpace(v))
					off = (vs == "false" || vs == "off" || vs == "0" || vs == "")
				case float64:
					off = v == 0
				}
				if off {
					req.AllowedTools = []string{}
					req.Tools = []string{}
				}
			}
		}

		// SystemMode resolution. "replace" → per-turn preset wins
		// outright; anything else (default "append" / unset) → fold
		// the default system prompt in front. Mirrors Node old
		// chat.ts:254-257 + providers/core.ts:_resolveSystemPrompt.
		// Only acts when System wasn't explicitly set by the caller.
		// Runs *after* the employee-gate block so an employee's
		// systemPromptPreset frontmatter (which assigns req.Preset
		// above) actually reaches the resolver.
		if strings.TrimSpace(req.System) == "" {
			rawPreset := string(req.Preset)
			if len(req.Presets) > 0 {
				parts := make([]string, 0, len(req.Presets))
				seen := map[string]bool{}
				for _, name := range req.Presets {
					name = strings.TrimSpace(name)
					if name == "" || seen[name] {
						continue
					}
					seen[name] = true
					if deps.ResolvePreset != nil {
						name = deps.ResolvePreset(name)
					}
					if trimmed := strings.TrimSpace(name); trimmed != "" {
						parts = append(parts, trimmed)
					}
				}
				rawPreset = strings.Join(parts, "\n\n")
			} else if deps.ResolvePreset != nil {
				rawPreset = deps.ResolvePreset(rawPreset)
			}
			preset := strings.TrimSpace(rawPreset)
			mode := strings.ToLower(strings.TrimSpace(req.SystemMode))
			defaultSys := ""
			if deps.DefaultSystemPrompt != nil {
				defaultSys = strings.TrimSpace(deps.DefaultSystemPrompt())
			}
			switch {
			case mode == "replace":
				req.System = preset
			case preset != "" && defaultSys != "":
				req.System = defaultSys + "\n\n" + preset
			case preset != "":
				req.System = preset
			default:
				req.System = defaultSys
			}
		}
		// Append the shared "Important" + per-CWD "CWD context"
		// footers onto whatever system prompt we ended up with.
		// These are the small in-process notepads the user edits via
		// the MCP `important` tool / cwd-context tool; every Node-served
		// turn folded them in, so a Go turn without them silently
		// drops the user's pinned reminders.
		if deps.BridgeRoot != "" {
			req.System = AppendSystemFooters(req.System, deps.BridgeRoot, req.CWD)
		}

		// Phase 5: classify direct-API vs proxy. The classifier is pure
		// + injectable so route_test.go can drive both branches with no
		// real Node upstream. PickProvider override (set by tests with
		// scripted model ids) flows into the picker the classifier uses
		// so a scripted model still routes direct.
		classify := deps.Classifier
		var decision routeDecision
		if participantCtx.HasParticipants {
			decision = routeDecision{Direct: false, Reason: "participant-routed session"}
		} else if classify != nil {
			decision = classify(&req, deps.APIKeyFor)
		} else {
			decision = classifyRouteWithGeneric(&req, deps.APIKeyFor, pickFn, deps.GenericProvider)
		}
		if !decision.Direct {
			// Phase 6 harness-port opt-out (default-on since 6g):
			// if a HarnessAdapters entry matches this request AND the
			// per-label YHA_GO_<UPPER>=0 flag is NOT set, dispatch to
			// the in-process adapter. Operators can force a hard fail
			// for a specific harness by flipping its env var off.
			if adapter, label := pickHarnessAdapter(deps.HarnessAdapters, &req, participantCtx); adapter != nil {
				deps.Logger.Info("stream.harness-adapter",
					"label", label,
					"model", req.Model,
					"provider", req.Provider,
				)
				// Load prior-turn history so the adapter can fold it
				// into the prompt when its session-resume index has
				// no entry yet (fresh branch session, first turn
				// after a daemon restart that lost the resolver
				// cache, etc.). Mirrors the Node pre-Phase-7
				// claude-stream.ts:87-101 fallback that prepended
				// "[Previous conversation context: ...]" to the
				// user prompt when --resume was unavailable.
				var harnessPriorHistory []Message
				if deps.History != nil && strings.TrimSpace(req.SessionId) != "" {
					selfEmp := ""
					if participantCtx.Target != nil && len(participantCtx.ParticipantIDs) <= 1 {
						selfEmp = participantCtx.Target.ID
					}
					hctx, hcancel := context.WithTimeout(context.Background(), 3*time.Second)
					loaded, herr := deps.History.Load(hctx, req.SessionId, selfEmp)
					hcancel()
					if herr != nil {
						deps.Logger.Warn("stream.history.load.harness", "session", req.SessionId, "err", herr)
					} else {
						harnessPriorHistory = loaded
					}
				}
				adapterReq := buildHarnessAdapterRequest(&req, participantCtx, deps.UploadsDir, deps.ResolveSkills)
				adapterReq.PriorHistory = harnessPriorHistory
				dispatchHarnessAdapter(w, r, deps, adapterReq, bodyBytes, adapter, label)
				return
			}

			// Phase 7: there is no Node /v1/stream/ fallback anymore.
			// Every non-direct request MUST be claimed by either the
			// classifier (Direct=true → handled below) or one of the
			// registered harness adapters above. If we reach this
			// point the operator has explicitly disabled every adapter
			// that could match this request (YHA_GO_*=0) AND there's
			// no direct-API key — surface a clear 502 so the FE shows
			// the user a usable error instead of a hang/timeout.
			//
			// "unknown model" stays a 400: the request never had a
			// chance regardless of adapter wiring.
			if decision.Reason == "unknown model" {
				writeJSONError(w, http.StatusBadRequest,
					fmt.Sprintf("unsupported model %q — pick claude-*, gpt-*, o1-*, o3-*, or gemini-*", req.Model))
				return
			}
			deps.Logger.Warn("stream.no-adapter",
				"model", req.Model,
				"provider", req.Provider,
				"reason", decision.Reason,
			)
			writeJSONError(w, http.StatusBadGateway,
				"no harness adapter available for request — Node /v1/stream/ has been removed in Phase 7")
			return
		}

		// Fold prior-turn history into the messages slice. The FE
		// currently only sends the new user turn (Input); without this
		// step the upstream model sees a single message and can't
		// answer "what did I say earlier". Mirrors Node's pre-Phase-7
		// chat handler that read getHistory(sid) before each turn.
		// Best-effort: a fetch failure just degrades to no-history,
		// matching pre-refactor behaviour for fresh sessions.
		var historyMessages []Message
		if deps.History != nil && strings.TrimSpace(req.SessionId) != "" {
			// Per-employee history scope when a single participant
			// target is resolved (chat with a named employee). Empty
			// when no target / broadcast fan-out — broadcast has its
			// own per-employee scope inside the runner.
			selfEmp := ""
			if participantCtx.Target != nil && len(participantCtx.ParticipantIDs) <= 1 {
				selfEmp = participantCtx.Target.ID
			}
			hctx, hcancel := context.WithTimeout(context.Background(), 3*time.Second)
			loaded, herr := deps.History.Load(hctx, req.SessionId, selfEmp)
			hcancel()
			if herr != nil {
				deps.Logger.Warn("stream.history.load", "session", req.SessionId, "err", herr)
			} else {
				historyMessages = loaded
			}
		}
		// Resolve any uploaded image attachments off disk so the
		// upstream provider gets the real base64 (FE only ships URL
		// references). Same source-of-truth as harness adapters use
		// via buildHarnessAdapterRequest's ResolveImageAttachments
		// call. Empty when no images / no UploadsDir configured.
		var imageBlocks []ImageBlock
		if deps.UploadsDir != "" {
			imageBlocks = ResolveImageAttachments(deps.UploadsDir, req.Attachments)
		}

		if len(req.Messages) == 0 {
			req.Messages = []Message{{Role: "user", Content: req.Input, ImageBlocks: imageBlocks}}
		} else if len(imageBlocks) > 0 {
			// FE supplied messages explicitly but also attachments —
			// stamp the image blocks onto the final user message so the
			// model sees them with the prompt.
			for i := len(req.Messages) - 1; i >= 0; i-- {
				if req.Messages[i].Role == "user" {
					req.Messages[i].ImageBlocks = append(req.Messages[i].ImageBlocks, imageBlocks...)
					break
				}
			}
		}
		if len(historyMessages) > 0 {
			// Don't double-add the current input if the FE already
			// included it in req.Messages — the history endpoint
			// returns prior turns only (it's drawn from displaySessions
			// which is populated by the previous turn's persist hop).
			req.Messages = append(append([]Message(nil), historyMessages...), req.Messages...)
		}
		var (
			provider     Provider
			providerName string
			apiKey       string
		)
		// Generic-OpenAI branch: classifier marked this turn Direct=true
		// because the configured non-builtin provider can be reached
		// via an OpenAI-compatible endpoint. Skip pickFn (which only
		// knows the built-in prefixes) and construct the provider
		// directly with the resolved BaseURL.
		if genericLabel, ok := genericProviderFromDecision(decision); ok && deps.GenericProvider != nil {
			endpoint, key, gotProvider := deps.GenericProvider(genericLabel)
			if !gotProvider || endpoint == "" || key == "" {
				writeJSONError(w, http.StatusServiceUnavailable,
					fmt.Sprintf("provider %q not configured", genericLabel))
				return
			}
			// Bridge config stores endpoints with the /v1 suffix
			// (e.g. https://api.deepseek.com/v1), but OpenAIProvider
			// always appends /v1/chat/completions to BaseURL. Strip
			// the trailing /v1 so we don't end up with a doubled
			// path like /v1/v1/chat/completions → 404.
			provider = &OpenAIProvider{
				Model:   req.Model,
				BaseURL: trimOpenAIBaseSuffix(endpoint),
			}
			providerName = genericLabel
			apiKey = key
		} else {
			p, name, err := pickFn(req.Model)
			if err != nil {
				writeJSONError(w, http.StatusBadRequest, err.Error())
				return
			}
			provider, providerName = p, name
			if deps.APIKeyFor != nil {
				apiKey = deps.APIKeyFor(providerName)
			}
			if apiKey == "" {
				writeJSONError(w, http.StatusServiceUnavailable,
					fmt.Sprintf("no API key configured for provider %q", providerName))
				return
			}
		}

		// Open the SSE response.
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("X-Accel-Buffering", "no") // nginx
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)
		if flusher != nil {
			flusher.Flush()
		}

		sessionID := req.SessionId
		// The Subscribe-based pump architecture requires a buffer.
		// Production wires one in deps.Buffer; tests that don't get
		// an ephemeral per-request fallback so emit's Append still
		// fans out to the pump's Subscribe.
		sessionBuffer := deps.Buffer
		if sessionBuffer == nil {
			sessionBuffer = NewSessionBuffer()
		}
		// Cancel any pending Drop from a previous stream on the same
		// session — a new turn keeps the buffer warm.
		sessionBuffer.CancelFinalize(sessionID)
		// Create the buffer entry up-front so a reattach EventSource
		// opened before Run's first emit() doesn't 404. Otherwise a
		// session switch in the gap between POST start and the
		// model's first chunk leaves the FE without a reconnect
		// target.
		sessionBuffer.Ensure(sessionID)

		// Persist the user message SYNCHRONOUSLY before the upstream
		// call starts. Pre-Phase-7 Node wrote a live-message placeholder
		// on first chunk so a switch-away or reload couldn't lose the
		// prompt. Without this, the FE's local user-bubble is the only
		// record; switching sessions before the stream finalizes wipes
		// it because /v1/sessions/<sid>.json on disk is still empty.
		// Same regression as auto-title perpetually returning "new
		// chat" — the titler runs against an empty session.
		if deps.PersistMessage != nil && sessionID != "" {
			userText := strings.TrimSpace(req.Input)
			if userText != "" {
				persistCtx, persistCancel := context.WithTimeout(context.Background(), 5*time.Second)
				if perr := deps.PersistMessage.Persist(persistCtx, PersistMessagePayload{
					SessionID: sessionID,
					Role:      "user",
					Text:      userText,
				}); perr != nil {
					deps.Logger.Warn("stream.persist.user-pre", "session", sessionID, "err", perr)
				}
				persistCancel()
			}
		}

		// Phase 5 finalize-hook stats. Counters are bumped on each
		// chunk and folded into the CostEventPayload after Run returns.
		var (
			toolCallCount atomic.Int64
			apiCallCount  atomic.Int64 // bumped per model API call by the loop; read by the live-meta ticker
			toolEventsMu  sync.Mutex
			toolEvents    []ToolEventRecord
			turnStart     = time.Now()
			textMu        sync.Mutex
			assistantText strings.Builder         // accumulated for /internal/persist-broadcast-message at finalize
			blockAccum    = NewBlockAccumulator() // rich-block array so reload shows tool-call traces, not just text
			liveToken     atomic.Int64            // 0 until startLiveMsg returned; subsequent updates pin to it
			liveStarted   atomic.Bool
		)

		// startLivePlaceholder mirrors the same name in route_harness.go:
		// on the first content-carrying chunk it writes a `streaming:true`
		// placeholder to bridge/sessions/<sid>.json so a crash/OOM mid-
		// stream still leaves the partial reply visible on reload.
		startLivePlaceholder := func() {
			if deps.PersistMessage == nil || sessionID == "" {
				return
			}
			if !liveStarted.CompareAndSwap(false, true) {
				return
			}
			go func() {
				pctx, pcancel := context.WithTimeout(context.Background(), 5*time.Second)
				defer pcancel()
				tok, err := deps.PersistMessage.PersistWithToken(pctx, PersistMessagePayload{
					SessionID: sessionID,
					Role:      "assistant",
					Phase:     "start",
					Model:     req.Model,
					Provider:  providerName,
				})
				if err != nil {
					deps.Logger.Warn("stream.persist.live-start", "session", sessionID, "err", err)
					return
				}
				liveToken.Store(tok)
			}()
		}

		// pumpCh is the local channel the SSE writer pump drains. Same
		// architecture as the harness path: emit() pushes here and
		// also calls Buffer.Append for reattach fan-out. Slow consumer
		// stalls its own pump only.
		pumpCh := make(chan Chunk, 1024)
		pumpDone := make(chan struct{})

		emit := func(c Chunk) {
			if sessionID != "" {
				c = sessionBuffer.Append(sessionID, c)
			}
			if c.Type == ChunkTypeToolUse {
				toolCallCount.Add(1)
				if c.ToolUse != nil && c.ToolUse.Name != "" {
					toolEventsMu.Lock()
					toolEvents = append(toolEvents, ToolEventRecord{
						Name: c.ToolUse.Name,
						OK:   true,
					})
					toolEventsMu.Unlock()
				}
			}
			if c.Type == ChunkTypeDelta {
				t := c.Text
				if t == "" {
					t = c.Delta
				}
				if t != "" {
					textMu.Lock()
					assistantText.WriteString(t)
					textMu.Unlock()
				}
			}
			textMu.Lock()
			blockAccum.Observe(c)
			textMu.Unlock()
			switch c.Type {
			case ChunkTypeDelta, ChunkTypeText, ChunkTypeReasoning, ChunkTypeToolUse, ChunkTypeToolResult:
				startLivePlaceholder()
			}
			select {
			case pumpCh <- c:
			default:
			}
		}
		// Out-of-band injections (currently: the /v1/sessions/:id/btw
		// POST handler) fan into the same pipeline through this sink.
		// Without it the btw chunk would only land in Buffer.Append —
		// the live POST writer (pumpCh) and the persistence path
		// (blockAccum) would never see it. Unregister on handler exit
		// so a finalized stream's stale emit closure isn't kept warm.
		if sessionID != "" {
			RegisterEmitSink(sessionID, emit, "direct-api")
			defer UnregisterEmitSink(sessionID)
		}

		// Build the catalog from the Runner. The model sees the runner's
		// full advertised set, optionally narrowed by req.Tools when
		// the caller supplied a filter list.
		var (
			catalog []Tool
			runner  tools.Runner = deps.Runner
		)
		if runner != nil {
			fullCatalog := toolsToStreamTools(runner.Catalog())
			if req.Tools != nil {
				// Explicit list supplied (even empty): empty means "tools off" for this turn
				// (caps.tools=false or employee capTools=off), non-empty means filter/narrow.
				// nil means "no restriction" → full catalog. This lets deactivate actually
				// omit the tools decl for Gemini/OpenAI-direct so eager models (gemini-3.5 etc)
				// don't emit function calls when the user has the ⚙ badge set to off.
				if len(req.Tools) == 0 {
					catalog = []Tool{}
				} else if deps.CatalogFilter != nil {
					catalog = deps.CatalogFilter(fullCatalog, req.Tools)
				} else {
					catalog = filterCatalogByName(fullCatalog, req.Tools)
				}
			} else {
				catalog = fullCatalog
			}
		}

		// Thread cwd + sessionId through to the runner so the
		// Node-callback layer can pass them on to /proxy/tool. Composite
		// runners use WithSession; plain *tools.Executor ignores both.
		effectiveRunner := runner
		explicitOff := (req.Tools != nil && len(req.Tools) == 0) || (req.AllowedTools != nil && len(req.AllowedTools) == 0)
		if explicitOff {
			// tools deactivated this turn (caps.tools=false, employee cap off,
			// or explicit empty AllowedTools) → nil runner so runToolSafely
			// refuses side-effecting execution even if model emits calls anyway.
			effectiveRunner = nil
		} else if cr, ok := runner.(*tools.CompositeRunner); ok {
			effectiveRunner = cr.WithSession(req.CWD, req.SessionId)
		}

		opts := Opts{
			APIKey:       apiKey,
			HTTPClient:   deps.HTTPClient,
			Logger:       deps.Logger,
			Recorder:     deps.Recorder,
			SessionID:    sessionID,
			Btw:          deps.Btw,
			RawLog:       deps.RawLog,
			Limiter:      deps.Limiter,
			APICallCount: &apiCallCount,
		}
		// Per-call request opts ride on the messages history.
		extractedSystem := req.System
		if extractedSystem == "" {
			extractedSystem = extractSystemFromMessages(&req.Messages)
		}
		// Loop-level RequestOpts.
		opts.MaxIter = 8

		// Provider needs to know model + max_tokens etc; pass via the
		// request building path. We tweak each provider's local model
		// before the loop runs.
		setProviderModel(provider, req.Model)

		// Build per-turn opts that BuildRequest will receive — we
		// piggy-back on the Provider's BuildRequest seeing RequestOpts
		// via the loop's runtime state (loop.go injects {Stream:true}
		// only). To get System / MaxTokens / Effort to BuildRequest,
		// we wrap the provider with a small adapter.
		// Pull the FE-shipped caps.reasoning toggle out of req.Caps so
		// Anthropic's `thinking` block fires even without an effort
		// budget. Mirrors Node tools/stream.ts:545-548.
		var capsReasoning string
		if v, ok := req.Caps["reasoning"].(string); ok {
			capsReasoning = v
		}
		wrapped := &requestOptsAdapter{
			inner:     provider,
			System:    extractedSystem,
			Max:       req.MaxTokens,
			Effort:    req.Effort,
			Reasoning: capsReasoning,
			Model:     req.Model,
		}
		// Clear any prior usage accumulator. Provider values are
		// created fresh per request today (pickProvider returns a
		// new struct), but ResetUsage stays cheap + future-proof
		// against provider pooling.
		if up, ok := provider.(UsageProvider); ok {
			up.ResetUsage()
		}

		// Detach the upstream call from the HTTP request context — same
		// rationale as the harness adapter dispatcher: switching FE tabs
		// must not cancel the in-flight model response. Multi-tasking
		// was a pre-Phase-7 Node feature (activeStreams kept streams
		// alive across reattaches); we restore it here by giving Run
		// its own context with no deadline. Client disconnect is
		// surfaced separately via r.Context().Done() if we wanted to
		// short-circuit, but the buffer captures all chunks and the FE
		// reattaches via /v1/sessions/:id/stream-direct.
		//
		// No deadline because tool-heavy turns regularly stream for
		// 15-60+ min (reasoning models like OpenAI o* can "think" for a
		// long time before/during streaming; agent loops with slow tools
		// too). The previous 10-min hard cap killed live conversations
		// exactly at the boundary (stopReason="", tokens=0,
		// "stopped instantly"). Runaway protection comes from /v1/stop,
		// Node's sweeper (which now also POSTs stop back), and per-harness
		// timeouts — not a blanket route-level timer.
		ctx, runCancel := context.WithCancel(context.Background())
		defer runCancel()
		// Kill-switch registration. POST /v1/stop/:sid → runCancel
		// → upstream provider HTTP fetch context unwinds and Run
		// returns. Mirrors Node's activeProcesses path.
		if deps.ActiveStops != nil && sessionID != "" {
			deps.ActiveStops.Register(sessionID, runCancel)
			defer deps.ActiveStops.Drop(sessionID)
		}
		// Writer pump. Drains pumpCh + emits heartbeats every 10 s +
		// writes to the response writer; exits on _end / write fail /
		// r.Context cancellation. Slow tunneled FE only stalls its
		// own pump; the adapter (Run) keeps Appending into the ring
		// buffer and reattach subscribers drain through their own
		// channels.
		go func() {
			defer close(pumpDone)
			streamChunksToClient(r.Context(), w, flusher, pumpCh, nil)
		}()

		// Periodic live-message checkpoint. Same shape as the harness
		// path — every 2 s POST the current text + blocks against the
		// placeholder opened by startLivePlaceholder so a daemon
		// crash mid-stream leaves the partial reply on disk.
		liveCheckpointStop := make(chan struct{})
		go func() {
			ticker := time.NewTicker(2 * time.Second)
			defer ticker.Stop()
			var lastCheckpointAt time.Time
			lastCheckpointLen := 0
			for {
				select {
				case <-liveCheckpointStop:
					return
				case <-ticker.C:
					tok := liveToken.Load()
					if tok == 0 || deps.PersistMessage == nil {
						continue
					}
					textMu.Lock()
					txt := assistantText.String()
					textMu.Unlock()
					if strings.TrimSpace(txt) == "" {
						continue
					}
					if !shouldLiveCheckpoint(time.Now(), len(txt), &lastCheckpointAt, &lastCheckpointLen) {
						continue
					}
					// Checkpoints intentionally persist only the flat text.
					// Final persistence below still writes rich blocks. Avoid
					// re-marshalling accumulated tool-result blocks every 2s,
					// which can become a large synchronous bridge payload.
					pctx, pcancel := context.WithTimeout(context.Background(), 5*time.Second)
					// Snapshot current live counters for durability on live updates
					// (parallel to harness path). Lets switch/reload have core-sourced
					// meta values even across brief bridge disconnects. Native path
					// gets tokens from the provider UsageProvider each tick (no
					// per-chunk atomics like harness).
					inC, outC := 0, 0
					if up, ok := provider.(UsageProvider); ok {
						u := up.Usage()
						inC, outC = u.InputTokens, u.OutputTokens
					}
					tcC := int(toolCallCount.Load())
					acC := int(apiCallCount.Load())
					if err := deps.PersistMessage.Persist(pctx, PersistMessagePayload{
						SessionID:     sessionID,
						Role:          "assistant",
						Phase:         "update",
						LiveToken:     tok,
						Text:          txt,
						InputTokens:   inC,
						OutputTokens:  outC,
						ToolCallCount: tcC,
						APICallCount:  acC,
						TurnStartMs:   turnStart.UnixMilli(),
						Model:         req.Model,
					}); err != nil {
						deps.Logger.Warn("stream.persist.live-update", "session", sessionID, "err", err)
					}
					pcancel()
				}
			}
		}()
		defer close(liveCheckpointStop)

		// Live-meta ticker. Every ~1 s it snapshots the in-flight
		// counters and does two things:
		//   1. publishes them to the process-global live registry
		//      (livemeta.go) so GET /v1/activity/stream surfaces this
		//      session's busy state to every other UI surface, and
		//   2. pushes a `_live` Chunk STRAIGHT to pumpCh — Seq=0,
		//      bypassing emit()/sessionBuffer.Append so it is never
		//      sequenced or replayed (mirrors the heartbeat in
		//      sse_write.go). The FE paints a live busy bar from these
		//      frames from the turn's start instead of waiting for `_end`.
		// Counters only; elapsed time is the client's own clock.
		RegisterLiveMeta(sessionID, req.Model, turnStart.UnixMilli())
		defer UnregisterLiveMeta(sessionID)
		liveMetaStop := make(chan struct{})
		go func() {
			ticker := time.NewTicker(1 * time.Second)
			defer ticker.Stop()
			for {
				select {
				case <-liveMetaStop:
					return
				case <-ticker.C:
					in, out := 0, 0
					if up, ok := provider.(UsageProvider); ok {
						u := up.Usage()
						in, out = u.InputTokens, u.OutputTokens
					}
					tc := int(toolCallCount.Load())
					ac := int(apiCallCount.Load())
					UpdateLiveMeta(LiveSnapshot{
						SessionID:     sessionID,
						Status:        "streaming",
						Model:         req.Model,
						InputTokens:   in,
						OutputTokens:  out,
						ToolCallCount: tc,
						APICallCount:  ac,
						TurnStartMs:   turnStart.UnixMilli(),
					})
					// Non-blocking send mirrors emit(): a stalled
					// consumer stalls only its own pump, never the
					// model loop. pumpCh is buffered (1024); a post-`_end`
					// send (pump already returned) just sits unread and
					// is GC'd with the channel.
					select {
					case pumpCh <- Chunk{
						Live:          true,
						Model:         req.Model,
						InputTokens:   in,
						OutputTokens:  out,
						ToolCallCount: tc,
						APICallCount:  ac,
					}:
					default:
					}
				}
			}
		}()
		defer close(liveMetaStop)

		// Audit log — input side. Mirrors Node's
		// `logRaw('model','in', body, {route, modelId, stream})` call
		// in old chat.ts / openai-internal.ts. Captures the prompt the
		// upstream actually saw (after history fold + system prompt +
		// effort) so a botched answer can be traced.
		if deps.RawLog != nil {
			deps.RawLog.Write("model", "in", map[string]any{
				"model":     req.Model,
				"system":    extractedSystem,
				"messages":  req.Messages,
				"tools":     catalog,
				"effort":    req.Effort,
				"maxTokens": req.MaxTokens,
			}, map[string]any{
				"route":     "/v1/stream-direct/",
				"provider":  providerName,
				"sessionId": sessionID,
				"stream":    true,
			})
		}
		runErr := Run(ctx, wrapped, effectiveRunner, req.Messages, catalog, opts, emit)
		if runErr != nil {
			deps.Logger.Warn("stream.run", "provider", providerName, "err", runErr)
			// emit() already wrote an error chunk inside Run; just close.
		}
		// Terminal _end marker. The FE flips "running" → "done" on
		// this chunk and reads stopReason / tokens / cost / duration /
		// tokensPerSec off it. Matches Node's endChunk shape
		// (bridge/sessions-internal/streams.ts:320-333).
		usage := Usage{}
		if up, ok := provider.(UsageProvider); ok {
			usage = up.Usage()
		}
		// Audit log — output side.
		if deps.RawLog != nil {
			textMu.Lock()
			assistantSnap := assistantText.String()
			textMu.Unlock()
			deps.RawLog.Write("model", "out", map[string]any{
				"text":  assistantSnap,
				"usage": usage,
				"error": func() string {
					if runErr != nil {
						return runErr.Error()
					}
					return ""
				}(),
			}, map[string]any{
				"route":     "/v1/stream-direct/",
				"provider":  providerName,
				"sessionId": sessionID,
				"stream":    true,
			})
		}
		durationMs := time.Since(turnStart).Milliseconds()
		endChunk := Chunk{Type: ChunkTypeDone, End: true, Model: req.Model}
		if runErr != nil {
			endChunk.Error = runErr.Error()
		} else {
			endChunk.StopReason = "end_turn"
			endChunk.InputTokens = usage.InputTokens
			endChunk.OutputTokens = usage.OutputTokens
			endChunk.CacheReadTokens = usage.CacheReadTokens
			endChunk.CacheCreationTokens = usage.CacheCreationTokens
			endChunk.DurationMs = durationMs
			endChunk.ToolCallCount = int(toolCallCount.Load())
			endChunk.APICallCount = int(apiCallCount.Load())
			if durationMs > 500 && usage.OutputTokens > 0 {
				endChunk.TokensPerSec = int(float64(usage.OutputTokens) / (float64(durationMs) / 1000.0))
			}
			// Per-turn cost. Prices are per-1M tokens; convert at the
			// last possible moment so float drift doesn't accumulate.
			if deps.ModelPricing != nil {
				if pi, po, ok := deps.ModelPricing(req.Model); ok {
					endChunk.Cost = (float64(usage.InputTokens)*pi + float64(usage.OutputTokens)*po) / 1_000_000.0
				}
			}
		}
		emit(endChunk)
		// Arm the post-finish grace timer regardless of clean/error
		// exit so a late reattach can pull the final chunk. We do NOT
		// drop the buffer on client-side disconnects (ctx.Err) — that
		// is exactly the case reattach exists for.
		if sessionID != "" {
			sessionBuffer.ScheduleFinalize(sessionID)
		}
		// Wait for the pump to deliver the terminal chunk to the
		// client before the handler returns and TCP gets torn down.
		// 2 s ceiling — pump exits as soon as it sees End:true so
		// this is normally instant.
		select {
		case <-pumpDone:
		case <-time.After(2 * time.Second):
		}

		// Per-turn assistant persistence. The user prompt landed
		// synchronously at the top of the handler so a mid-stream
		// switch-away can't lose it. This block writes the final
		// assistant reply once the turn completes — fire-and-forget
		// with a 5 s timeout per call.
		// Final assistant persist. Flip the open live placeholder to
		// phase:"final" (strips streaming:true) when one exists, else
		// fall through to a plain push so a very-short / errored turn
		// still lands on disk.
		if deps.PersistMessage != nil && sessionID != "" {
			textMu.Lock()
			assistantOut := assistantText.String()
			blocksOut := blockAccum.Blocks()
			textMu.Unlock()
			tok := liveToken.Load()
			if strings.TrimSpace(assistantOut) != "" || len(blocksOut) > 0 {
				go func() {
					phase := ""
					if tok > 0 {
						phase = "final"
					}
					finalPayload := PersistMessagePayload{
						SessionID:    sessionID,
						Role:         "assistant",
						Text:         assistantOut,
						Blocks:       blocksOut,
						Model:        req.Model,
						Provider:     providerName,
						InputTokens:  usage.InputTokens,
						OutputTokens: usage.OutputTokens,
						StopReason:   endChunk.StopReason,
						Phase:        phase,
						LiveToken:    tok,
					}

					// Step 6: write finalize directly to SQLite before the
					// HTTP POST, so a bridge restart between here and the POST
					// landing can't drop the finalized state (the "Bridge
					// restarted before this reply could finish" interrupt).
					// Mirrors route_harness.go. Skipped cleanly when
					// SQLiteFinalizer is nil (pre-Step-6 deploy) or phase !=
					// "final" (helper returns ok=false); the HTTP POST below
					// still fires either way to keep the bridge's in-memory
					// displaySessions Map in sync.
					if deps.SQLiteFinalizer != nil && phase == "final" {
						sctx, scancel := context.WithTimeout(context.Background(), 5*time.Second)
						if _, serr := deps.SQLiteFinalizer.FinalizeMessage(sctx, finalPayload); serr != nil {
							deps.Logger.Warn("stream.persist.sqlite", "session", sessionID, "err", serr)
						}
						scancel()
					}

					ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
					defer cancel()
					if err := deps.PersistMessage.Persist(ctx, finalPayload); err != nil {
						deps.Logger.Warn("stream.persist.assistant", "session", sessionID, "err", err)
					}
				}()
			}
		}

		// Finalize telemetry: post cost-event + trigger auto-title
		// on Node. Fire-and-forget so user-perceived latency doesn't
		// include the round-trip; the CostEventSink layer bounds the
		// goroutine with a 5s timeout and logs failures.
		//
		// Token counts come from the provider's UsageProvider
		// surface — Anthropic surfaces input + cache breakdown via
		// message_start, output via message_delta; OpenAI surfaces
		// the full block on the final include_usage frame; Gemini
		// surfaces cumulative-context totals on every chunk's
		// usageMetadata. Cost stays zero on the wire: Node computes
		// it from model + token counts in
		// bridge/routes/internal.ts so we don't duplicate the rate
		// table here.
		if deps.CostEvents != nil && sessionID != "" {
			usage := Usage{}
			if up, ok := provider.(UsageProvider); ok {
				usage = up.Usage()
			}
			toolEventsMu.Lock()
			toolsSnap := make([]ToolEventRecord, len(toolEvents))
			copy(toolsSnap, toolEvents)
			toolEventsMu.Unlock()
			payload := CostEventPayload{
				SessionID:           sessionID,
				Model:               req.Model,
				Provider:            providerName,
				InputTokens:         usage.InputTokens,
				OutputTokens:        usage.OutputTokens,
				CacheReadTokens:     usage.CacheReadTokens,
				CacheCreationTokens: usage.CacheCreationTokens,
				ToolCallCount:       int(toolCallCount.Load()),
				DurationMs:          time.Since(turnStart).Milliseconds(),
				Tools:               toolsSnap,
			}
			deps.CostEvents.FireAndForget("cost-event", func(ctx context.Context) error {
				return deps.CostEvents.Record(ctx, payload)
			})
			deps.CostEvents.FireAndForget("auto-title", func(ctx context.Context) error {
				return deps.CostEvents.EnqueueAutoTitle(ctx, sessionID)
			})
		}
	})

	// Reattach endpoints: GET /v1/sessions/:id/stream-direct?fromSeq=N
	// and GET /v1/sessions/:id/stream?fromSeq=N. Returns 404 when the
	// buffer is disabled or the session is unknown; otherwise replays
	// buffered chunks then continues live. Both URL shapes hit the
	// same handler so the frontend's existing reconnect URL (Node
	// bridge contract `/stream`) keeps working when Phase 5 flips the
	// front door.
	if deps.Buffer != nil {
		handler := reattachHandler(deps)
		mux.HandleFunc("GET /v1/sessions/{id}/stream-direct", handler)
		mux.HandleFunc("GET /v1/sessions/{id}/stream", handler)

		// GET /v1/sessions/:id/status — Go-side liveness probe so the
		// FE picker / reconnect logic knows when to reattach. Pre-
		// Phase-7 Node served this from its activeStreams map; that
		// map is empty for Go-owned turns now, so the FE thought every
		// session was inactive and never tried to reattach when the
		// user switched back. Reads directly off SessionBuffer so the
		// answer matches what the reattach endpoint would replay.
		// Same wire shape as bridge/routes/chat-lifecycle.ts:23-35.
		status := func(w http.ResponseWriter, r *http.Request) {
			s := deps.Buffer.Status(r.PathValue("id"))
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			_ = json.NewEncoder(w).Encode(s)
		}
		mux.HandleFunc("GET /v1/sessions/{id}/status", status)

		// GET /internal/active-streams — bridge-key gated set of
		// session IDs currently streaming on the Go side. Node's
		// `/v1/sessions/` handler calls this to populate the
		// `isRunning` field on the session list (its own
		// activeStreams Map is empty for Go-owned turns). Mirrors
		// the activeStreams.get(sid)?.status === 'streaming' check
		// at bridge/routes/sessions.ts:109.
		mux.HandleFunc("GET /internal/active-streams", func(w http.ResponseWriter, r *http.Request) {
			sessions := deps.Buffer.ActiveSessions()
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			payload, _ := json.Marshal(map[string]any{
				"success":  true,
				"sessions": sessions,
			})
			_, _ = w.Write(payload)
		})

		// POST /v1/sessions/:id/stream/detach — FE marks an
		// upcoming SSE close as deliberate (session switch / delete)
		// so the next listener-unsub doesn't emit a "Connection lost"
		// interrupt block. Mirrors Node bridge/routes/chat-lifecycle.ts.
		mux.HandleFunc("POST /v1/sessions/{id}/stream/detach", func(w http.ResponseWriter, r *http.Request) {
			ok := deps.Buffer.MarkIntentionalDetach(r.PathValue("id"), 0)
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			_, _ = fmt.Fprintf(w, `{"ok":%t}`, ok)
		})
	}

	// GET /v1/activity/stream — process-global live activity feed. One
	// long-lived SSE per client (the FE opens exactly one) reporting the
	// busy state + live counters of EVERY in-flight session, so the
	// multichat grid / header can show per-session progress without
	// attaching to each stream. Reads the live registry (livemeta.go);
	// independent of deps.Buffer. Auth is gated the same way the
	// /internal/active-streams neighbor is — via the `native` front door
	// + path mount in main.go, no per-handler key check. Mirrors the
	// heartbeat discipline of the other SSE writers (10 s single-key
	// `_hb` frame) so the FE silence-watchdog stays quiet on an idle box.
	mux.HandleFunc("GET /v1/activity/stream", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-cache")
		w.Header().Set("X-Accel-Buffering", "no") // nginx
		w.WriteHeader(http.StatusOK)
		flusher, _ := w.(http.Flusher)

		snapshotFrame := func() string {
			payload, _ := json.Marshal(map[string]any{
				"type":     "activity",
				"sessions": SnapshotAllLiveMeta(),
			})
			return string(payload)
		}

		// Initial snapshot so a freshly-opened feed isn't blank until the
		// first membership/counter change lands.
		last := snapshotFrame()
		if _, err := fmt.Fprintf(w, "data: %s\n\n", last); err != nil {
			return
		}
		if flusher != nil {
			flusher.Flush()
		}

		ctx := r.Context()
		// 2 s (was 1 s): the activity feed is for cross-session busy presence
		// (picker/rail dots, header) and coarse counters. The per-current-session
		// live bar and token counts come from the session's own _live frames
		// (1 s ticker in the turn goroutine). Halving the global feed rate
		// reduces marshal+write+FE onmessage work when 4–N sessions are live
		// concurrently, without hurting switcher freshness (membership changes
		// and dirty events still trigger immediate list pulls).
		dataTicker := time.NewTicker(2 * time.Second)
		defer dataTicker.Stop()
		hbTicker := time.NewTicker(10 * time.Second)
		defer hbTicker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-dataTicker.C:
				next := snapshotFrame()
				if next == last {
					continue // push only on change; idle box stays quiet bar the heartbeat
				}
				last = next
				if _, err := fmt.Fprintf(w, "data: %s\n\n", next); err != nil {
					return
				}
				if flusher != nil {
					flusher.Flush()
				}
			case <-hbTicker.C:
				if _, err := fmt.Fprintf(w, "data: {\"_hb\":%d}\n\n", time.Now().UnixMilli()); err != nil {
					return
				}
				if flusher != nil {
					flusher.Flush()
				}
			}
		}
	})

	// POST /v1/stop/:sessionId — Go-side hard stop endpoint. The FE
	// hits this when the user clicks "Stop" mid-stream; we Stop() the
	// registered kill switch which cancels the adapter's detached
	// context. Node has its own /v1/stop route in
	// bridge/routes/chat-lifecycle.ts but its activeProcesses map is
	// empty for Go-owned turns, so without this the button was a
	// no-op for everything except pre-Go-cutover sessions. The route
	// is mounted regardless of deps.ActiveStops so the FE always sees
	// a 200; when no registry is wired it just reports "no such
	// session" and the FE shrugs.
	if deps.ActiveStops != nil {
		mux.HandleFunc("POST /v1/stop/{sessionId}", func(w http.ResponseWriter, r *http.Request) {
			sid := r.PathValue("sessionId")
			stopped := deps.ActiveStops.Stop(sid)
			if finalizer, ok := deps.PersistMessage.(AbandonedMessageFinalizer); ok {
				ctx, cancel := context.WithTimeout(r.Context(), 3*time.Second)
				if err := finalizer.FinalizeAbandoned(ctx, sid, "stopped"); err != nil {
					deps.Logger.Warn("stream.stop.finalize-abandoned", "session", sid, "err", err)
				}
				cancel()
			}
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			_, _ = fmt.Fprintf(w, `{"ok":true,"stopped":%t}`, stopped)
		})
	}

	// POST /v1/sessions/:id/btw — enqueue mid-stream user injection.
	// The active direct-API tool loop picks these up at the next
	// tool-call boundary (see Opts.Btw in loop.go); harness adapters
	// fall back to next-turn fold-in. Mirrors Node's
	// bridge/routes/sessions.ts:379 endpoint.
	if deps.Btw != nil {
		mux.HandleFunc("POST /v1/sessions/{id}/btw", func(w http.ResponseWriter, r *http.Request) {
			var body struct {
				Text string `json:"text"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				http.Error(w, `{"success":false,"error":"invalid JSON body"}`, http.StatusBadRequest)
				return
			}
			text := strings.TrimSpace(body.Text)
			if text == "" {
				http.Error(w, `{"success":false,"error":"text required"}`, http.StatusBadRequest)
				return
			}
			sid := r.PathValue("id")
			// Live-stdin first (per §8.5): when a claude-binary
			// subprocess is alive for this session, the registered sink
			// writes the JSONL user-event straight into its stdin so the
			// model sees the injection at the next turn boundary instead
			// of waiting for the next history rebuild. On any failure
			// (no sink, broken pipe, child exited) we fall back to the
			// queue so the next tool-call boundary still picks the item
			// up — same behaviour Node has at
			// bridge/routes/sessions.ts:430-435.
			livePath := "harness"
			if TryLiveStdinInject(sid, text) {
				// claude-binary live stdin accepted the write.
				livePath = "direct"
			} else {
				deps.Btw.Enqueue(sid, text)
				// For direct-API sessions the loop in loop.go drains
				// the queue at the next tool-call boundary (same turn),
				// so the livePath badge should be "direct" — the model
				// WILL see this injection before the next API call.
				// Only harness paths (claude-binary stdin closed, codex)
				// truly defer to the next history rebuild.
				if GetEmitRouteType(sid) == "direct-api" {
					livePath = "direct"
				}
			}
			// Inline-broadcast a `btwBlock` chunk so the FE shows the
			// user's injection at its chronological position in the
			// active assistant turn — without this the bubble silently
			// absorbs the queued #btw and the user sees nothing until
			// (maybe) a next-turn fold. Mirrors Node's
			// bridge/chat/btw-queue.ts:injectBtwBlock. LivePath is
			// "direct" when the live stdin sink accepted the write or
			// the session is on the direct-API tool-loop path,
			// "harness" when we fell back to the queue on a harness turn.
			//
			// Route through the live stream's emit() when one is
			// registered so the chunk lands in pumpCh (the initial-POST
			// SSE writer the user is connected to) + blockAccum (so
			// persistence captures the btw block) + Buffer.Append (so
			// reattach subscribers replay it). Falling back to
			// Buffer.Append-only keeps reattach correct when the live
			// POST has already finished but the buffer hasn't been
			// finalized yet.
			btwChunk := Chunk{BtwBlock: &BtwBlockChunk{Text: text, LivePath: livePath}}
			injected := TryEmitInject(sid, btwChunk)
			if !injected {
				if deps.Buffer != nil && deps.Buffer.Has(sid) {
					deps.Buffer.Append(sid, btwChunk)
				}
				// Emit sink unregistered (stream just finalized or never
				// started). Buffer.Append alone only reaches reattach
				// subscribers and the chunk never lands in the persisted
				// message blocks — on the next reload bridge/sessions/<sid>.json
				// has no trace of the user's #btw. Mirror Node's
				// bridge/routes/sessions.ts:419 fallback: persist a top-level
				// `#btw` note that slots in before the live (or
				// just-finalized) assistant entry. Fire-and-forget; the
				// response we just sent doesn't depend on this hop.
				if deps.PersistMessage != nil {
					go func(sessionID, body string) {
						pctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
						defer cancel()
						if err := deps.PersistMessage.Persist(pctx, PersistMessagePayload{
							SessionID: sessionID,
							Role:      "note",
							Text:      "#btw " + body,
							Phase:     "before-live",
						}); err != nil && deps.Logger != nil {
							deps.Logger.Warn("stream.btw.persist-note", "session", sessionID, "err", err)
						}
					}(sid, text)
				}
			}
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			_, _ = fmt.Fprintf(w, `{"success":true,"queued":%d,"livePath":%q,"injected":%t}`, len(deps.Btw.Peek(sid)), livePath, injected)
		})
		mux.HandleFunc("GET /v1/sessions/{id}/btw", func(w http.ResponseWriter, r *http.Request) {
			items := deps.Btw.Peek(r.PathValue("id"))
			w.Header().Set("Content-Type", "application/json; charset=utf-8")
			payload, _ := json.Marshal(map[string]any{"success": true, "items": items})
			_, _ = w.Write(payload)
		})
	}
}

// pickProvider routes a model id to the right provider implementation.
// Names match the Provider.Name() values for log filtering.
func pickProvider(model string) (Provider, string, error) {
	m := strings.ToLower(model)
	switch {
	case strings.HasPrefix(m, "claude-"), strings.HasPrefix(m, "claude/"):
		return &AnthropicProvider{Model: model}, "anthropic", nil
	case strings.HasPrefix(m, "gpt-"), strings.HasPrefix(m, "openai/"),
		strings.HasPrefix(m, "o1-"), strings.HasPrefix(m, "o3-"):
		return &OpenAIProvider{Model: model}, "openai", nil
	case strings.HasPrefix(m, "gemini-"), strings.HasPrefix(m, "google/"):
		return &GeminiProvider{Model: model}, "gemini", nil
	}
	return nil, "", fmt.Errorf("unsupported model %q — pick claude-*, gpt-*, o1-*, o3-*, or gemini-*", model)
}

// setProviderModel updates a provider's model field via type switch.
// The interface doesn't expose a setter so we go concrete here.
func setProviderModel(p Provider, model string) {
	switch v := p.(type) {
	case *AnthropicProvider:
		v.Model = model
	case *OpenAIProvider:
		v.Model = model
	case *GeminiProvider:
		v.Model = model
	}
}

// extractSystemFromMessages pulls a leading system message off the
// front of the slice and returns its text. The slice is mutated in
// place. This matches how Anthropic / Gemini want it.
func extractSystemFromMessages(messages *[]Message) string {
	out := ""
	rest := (*messages)[:0]
	for _, m := range *messages {
		if m.Role == "system" {
			if out != "" {
				out += "\n\n"
			}
			out += m.Content
			continue
		}
		rest = append(rest, m)
	}
	*messages = rest
	return out
}

// requestOptsAdapter wraps a Provider so BuildRequest sees the per-call
// system / max_tokens / effort. Without this, callers couldn't get
// these knobs through the Provider interface (which only exposes
// RequestOpts via Run's internal-only construction).
type requestOptsAdapter struct {
	inner     Provider
	System    string
	Max       int
	Effort    string
	Reasoning string
	Model     string
}

func (a *requestOptsAdapter) Name() string                      { return a.inner.Name() }
func (a *requestOptsAdapter) Endpoint() string                  { return a.inner.Endpoint() }
func (a *requestOptsAdapter) Headers(apiKey string) http.Header { return a.inner.Headers(apiKey) }
func (a *requestOptsAdapter) BuildRequest(messages []Message, tools []Tool, opts RequestOpts) ([]byte, error) {
	if a.System != "" {
		opts.System = a.System
	}
	if a.Max > 0 {
		opts.MaxTokens = a.Max
	}
	if a.Effort != "" {
		opts.Effort = a.Effort
	}
	if a.Reasoning != "" {
		opts.Reasoning = a.Reasoning
	}
	if a.Model != "" {
		opts.Model = a.Model
	}
	return a.inner.BuildRequest(messages, tools, opts)
}
func (a *requestOptsAdapter) Stream(ctx context.Context, body io.Reader, emit EmitFn) ([]ToolUseChunk, bool, error) {
	return a.inner.Stream(ctx, body, emit)
}

// Usage forwards to the inner provider if it implements UsageProvider.
// Otherwise returns the zero Usage. Lets callers read accumulated
// usage off the wrapped adapter without unwrapping.
func (a *requestOptsAdapter) Usage() Usage {
	if up, ok := a.inner.(UsageProvider); ok {
		return up.Usage()
	}
	return Usage{}
}

// ResetUsage forwards to the inner provider if it implements
// UsageProvider; otherwise a no-op.
func (a *requestOptsAdapter) ResetUsage() {
	if up, ok := a.inner.(UsageProvider); ok {
		up.ResetUsage()
	}
}

func writeJSONError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// toolsToStreamTools converts the runner's []tools.Tool into []Tool.
// Same field names, different declaring packages; the converter exists
// because the stream package keeps its own Tool type to avoid forcing
// downstream callers (the chat loop) to import internal/tools just for
// the catalog shape.
func toolsToStreamTools(in []tools.Tool) []Tool {
	out := make([]Tool, 0, len(in))
	for _, t := range in {
		out = append(out, Tool{
			Name:        t.Name,
			Description: t.Description,
			InputSchema: t.InputSchema,
		})
	}
	return out
}

// filterCatalogByName narrows a catalog to the tools whose names appear
// in the supplied allowlist. Empty/nil names is a no-op (full catalog).
// Used by the stream route when the request body's `tools` field is a
// per-call allowlist.
func filterCatalogByName(in []Tool, names []string) []Tool {
	if len(names) == 0 {
		return in
	}
	allow := make(map[string]struct{}, len(names))
	for _, n := range names {
		allow[n] = struct{}{}
	}
	out := make([]Tool, 0, len(in))
	for _, t := range in {
		if _, ok := allow[t.Name]; ok {
			out = append(out, t)
		}
	}
	return out
}
