package codex

// New entrypoint for the harness.Harness contract (Phase 6).
//
// This file holds the post-scaffold public surface: New() builds a
// Codex value that satisfies the harness.Harness interface (the one
// the scaffold agent is landing in internal/harness/harness.go). The
// pre-scaffold Streamer in codex.go / events.go / spawn.go is kept as
// the internal engine — harness.Codex just adapts its Request/Result
// shape to the framework's.
//
// Types declared locally (Request / Result / Usage / Emit / Skill /
// ImageBlock / EmployeeMeta) mirror the harness package contract. The
// wire-up step after all parallel agents return will replace these
// with type aliases or a thin adapter struct — see TODO at the bottom
// of this file.

import (
	"context"
	"errors"
	"strings"
	"time"

	"github.com/yha/core/internal/stream"
)

// HarnessID is the lookup key the registry uses. Mirrors the JS
// harness registration in bridge/modules/harness-codex/index.ts.
const HarnessID = "codex"

// Skill is one skill (Markdown body + name) the route handler passes
// through verbatim. The harness prepends it to the user prompt.
type Skill struct {
	Name    string
	Content string
}

// ImageBlock is one image block from the request. Codex's `exec` mode
// does NOT support image input today (text-only stdin), so we accept
// the field for shape parity but ignore it. When codex adds image
// support the placeholder branch is the only thing that changes.
type ImageBlock struct {
	MediaType string
	Base64    string
}

// EmployeeMeta is the broadcast-receipt metadata the route handler
// stamps onto a turn. The harness doesn't read it; it's forwarded for
// observability so the daemon can record which employee's turn this
// was. Kept on the Request so the shape matches the contract.
type EmployeeMeta struct {
	ID          string
	Name        string
	PartnerType string
	PartnerID   string
}

// Request is the per-turn input. Mirrors the harness.Request shape
// the scaffold agent's interface expects. Fields the codex harness
// doesn't currently use (ImageBlock, BroadcastEmp, Caps) are accepted
// for contract parity — the wire-up step doesn't have to massage
// shapes between the route and the harness.
type Request struct {
	SessionID        string
	HistorySessionID string
	Model            string
	Input            string
	Preset           string
	SystemMode       string
	Effort           string
	Skills           []Skill
	AllowedTools     []string
	CWD              string
	ImageBlocks      []ImageBlock
	HarnessInstance  string
	CodexInstance    string
	Provider         string
	Caps             map[string]any
	BroadcastEmp     *EmployeeMeta
}

// Usage is the per-turn token accounting Result carries. Field names
// mirror the scaffold's harness.Usage so the wire-up step can do
// type-aliasing without manual struct copies.
type Usage struct {
	InputTokens     int64
	OutputTokens    int64
	CacheRead       int64
	CacheCreation   int64
	Cost            float64
	Model           string
}

// Result is the finalize-time payload Stream returns to the caller.
// StopReason is "stop" on a clean turn, "error" when codex died, "" if
// we couldn't determine. Err is non-nil iff the caller should treat
// the whole stream as failed.
type Result struct {
	Text       string
	Usage      Usage
	StopReason string
	Err        error
}

// Emit is the per-chunk callback shape. Identical to stream.EmitFn so
// the route handler can pass its existing emit function through. We
// expose it as a type alias to keep imports tidy at call sites.
type Emit = stream.EmitFn

// Option configures a Codex. Reserved for the future logger/metrics
// injection seam — keeps the constructor's surface stable as the
// scaffold agent adds DI knobs.
type Option func(*Codex)

// Codex is the harness.Harness-conforming type. One instance per
// daemon; safe for concurrent Stream calls (each turn gets its own
// subprocess + parser state).
//
// Codex owns no per-turn state; everything lives on the Request /
// returned Result. The streamer pointer is set by New() and never
// swapped, so concurrent Stream calls are safe with no locking.
type Codex struct {
	streamer *Streamer

	// defaultBinary is the codex executable path used when the Request
	// doesn't carry an override. Wire from config.defaults.codexBin.
	defaultBinary string

	// defaultExecMode is "" / "bypass" (default) or "full-auto".
	defaultExecMode string

	// openaiAPIKey is the OPENAI_API_KEY env value to inject. Empty =
	// leave host env's OPENAI_API_KEY untouched (or fall back to OAuth
	// when CodexInstance is pinned).
	openaiAPIKey string

	// instanceResolver maps a CodexInstance id → CODEX_HOME path. nil
	// falls back to env-var-only (Request.CodexInstance treated as the
	// CODEX_HOME directly when it looks like a path).
	instanceResolver InstanceResolver
}

// WithBinary sets the codex executable path (PATH lookup by default).
func WithBinary(path string) Option {
	return func(c *Codex) { c.defaultBinary = path }
}

// WithExecMode sets the default exec mode ("bypass" | "full-auto").
func WithExecMode(mode string) Option {
	return func(c *Codex) { c.defaultExecMode = mode }
}

// WithOpenAIAPIKey sets the OPENAI_API_KEY value injected into each
// subprocess. Pass "" to skip injection (rely on host env / OAuth).
func WithOpenAIAPIKey(key string) Option {
	return func(c *Codex) { c.openaiAPIKey = key }
}

// WithInstanceResolver injects an InstanceResolver. See instance.go
// for the contract. Tests pass an in-memory map.
func WithInstanceResolver(r InstanceResolver) Option {
	return func(c *Codex) { c.instanceResolver = r }
}

// New builds a Codex with the provided options. Returns a *Codex
// value; the wire-up step type-asserts it to harness.Harness when the
// scaffold's package lands.
//
// Default config: codex on PATH, exec-mode = bypass, no env API key
// override, no instance resolver (Request.CodexInstance treated as a
// raw CODEX_HOME path when populated).
func New(opts ...Option) *Codex {
	c := &Codex{
		streamer:        NewStreamer(),
		defaultBinary:   "",
		defaultExecMode: "",
	}
	for _, o := range opts {
		o(c)
	}
	return c
}

// ID returns the harness identifier. Matches HarnessID; the registry
// uses this as the lookup key.
func (c *Codex) ID() string { return HarnessID }

// Stream is the harness.Harness contract entry point. Spawns codex,
// pipes the prompt, parses the JSON-Lines stdout, and emits chunks
// via emit. Returns Result when the subprocess exits.
//
// Prompt assembly: the contract gives us Input + Preset + Skills +
// SystemMode + AllowedTools, and the harness is responsible for
// folding them into the prompt the binary sees. This mirrors
// codex.ts:285-296 (skill block + preset + tool preamble). Chat
// history injection is the route handler's job: the codex adapter
// in cmd/yha-core/main.go folds req.PriorHistory into req.Input
// before calling Stream, so by the time we get here Input already
// carries the `[Previous conversation context: ...]` preamble.
func (c *Codex) Stream(ctx context.Context, req Request, emit Emit) (Result, error) {
	if emit == nil {
		return Result{Err: errors.New("codex.Stream: emit must be non-nil")}, errors.New("codex.Stream: emit must be non-nil")
	}
	if strings.TrimSpace(req.Input) == "" {
		err := errors.New("codex.Stream: input required")
		return Result{Err: err}, err
	}

	prompt := assemblePrompt(req)
	model := stripCodexPrefix(req.Model)
	cliModel := model
	if strings.EqualFold(cliModel, "default") || strings.EqualFold(cliModel, "auto") {
		cliModel = ""
	}

	configDir := c.resolveConfigDir(req)
	binary := c.defaultBinary
	execMode := c.defaultExecMode

	opts := SpawnOpts{
		Binary:       binary,
		CWD:          req.CWD,
		Model:        cliModel,
		ExecMode:     execMode,
		OpenAIAPIKey: c.openaiAPIKey,
		Subscription: isCodexSubscriptionProvider(req.Provider),
		ConfigDir:    configDir,
		Stdin:        prompt,
		Effort:       mapEffortToReasoning(req.Effort),
		AllowedTools: filterCodexAllowedTools(req.AllowedTools),
		PresetText:   strings.TrimSpace(req.Preset),
	}

	res, err := c.streamer.Run(ctx, runRequest{
		Prompt: prompt,
		Model:  cliModel,
		Spawn:  opts,
	}, emit)

	out := Result{
		Text: res.Text,
		Usage: Usage{
			InputTokens:   int64(res.Usage.InputTokens),
			OutputTokens:  int64(res.Usage.OutputTokens),
			CacheRead:     int64(res.Usage.CacheReadTokens),
			CacheCreation: int64(res.Usage.CacheCreationTokens),
			Model:         model,
		},
		StopReason: "end_turn",
		Err:        err,
	}
	if err != nil {
		out.StopReason = "error"
	}
	return out, err
}

func isCodexSubscriptionProvider(provider string) bool {
	p := strings.TrimSpace(provider)
	if p == "" {
		return false
	}
	if p == "OpenAI Subscription" {
		return true
	}
	if p == "OpenAI" || p == "OpenAI API" {
		return false
	}
	return strings.HasPrefix(p, "OpenAI-SUB")
}

// stripCodexPrefix mirrors codex.ts:258 by removing a leading "codex/".
func stripCodexPrefix(modelID string) string {
	if i := strings.IndexByte(modelID, '/'); i >= 0 && strings.EqualFold(modelID[:i], "codex") {
		return modelID[i+1:]
	}
	return modelID
}

// runRequest is the internal Streamer.Run input. Kept separate from
// the public Request so the public surface can evolve without
// disturbing the engine.
type runRequest struct {
	Prompt string
	Model  string
	Spawn  SpawnOpts

	// SilenceTimeout overrides the no-output watchdog window. Zero uses
	// defaultSilenceTimeout. Exposed mainly so tests can shrink it.
	SilenceTimeout time.Duration
}

// resolveConfigDir picks the CODEX_HOME path for this turn. Precedence:
//  1. Request.CodexInstance + resolver lookup
//  2. Request.CodexInstance treated as a literal path (when no
//     resolver is configured)
//  3. empty (subprocess uses host env's CODEX_HOME / default)
func (c *Codex) resolveConfigDir(req Request) string {
	id := strings.TrimSpace(req.CodexInstance)
	if id == "" {
		return ""
	}
	if c.instanceResolver != nil {
		if dir, ok := c.instanceResolver.Resolve(id); ok {
			return dir
		}
	}
	// Bare-path fallback: when the value looks like a path, use it
	// directly. This is the "env-var-only path" the task spec
	// described — works for the simple case where the route handler
	// has already resolved the instance.
	if strings.ContainsAny(id, "/\\") {
		return id
	}
	return ""
}

// assemblePrompt folds skills + preset + tool preamble into the user
// input. Mirrors codex.ts:285-296. History is already folded into
// req.Input by the route adapter, so it rides through as part of the
// user message here.
func assemblePrompt(req Request) string {
	prompt := req.Input

	if len(req.Skills) > 0 {
		var blocks []string
		for _, s := range req.Skills {
			if strings.TrimSpace(s.Name) == "" && strings.TrimSpace(s.Content) == "" {
				continue
			}
			blocks = append(blocks, "## Skill: "+s.Name+"\n\n"+s.Content)
		}
		if len(blocks) > 0 {
			prompt = strings.Join(blocks, "\n\n---\n\n") + "\n\n---\n\n" + prompt
		}
	}

	if preset := strings.TrimSpace(req.Preset); preset != "" {
		if req.SystemMode == "replace" {
			prompt = "[Instructions: " + preset + "]\n\n" + prompt
		} else {
			prompt = prompt + "\n\n[Additional context: " + preset + "]"
		}
	}

	if preamble := buildToolPreamble(req.AllowedTools); preamble != "" {
		prompt = preamble + "\n\n---\n\n" + prompt
	}

	return prompt
}

// Register exposes the codex harness factory for the scaffold's
// registry. The wire-up step in cmd/yha-core/main.go calls this with
// the registry value built there.
//
// Signature kept generic via the `any` parameter so this file
// compiles before scaffold lands — the wire-up step replaces the body
// with a real *harness.Registry call. Until then this is a no-op
// stub.
//
// TODO(scaffold-wireup): once internal/harness/harness.go is in,
// change `reg any` → `reg *harness.Registry` and call
// `reg.Add(HarnessID, factory(opts...))` here. The factory closes
// over `opts` and returns harness.Harness — concretely *Codex, which
// satisfies the contract via ID()+Stream().
func Register(reg any, opts ...Option) {
	_ = reg
	_ = opts
}
