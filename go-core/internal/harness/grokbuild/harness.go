package grokbuild

// harness.go — public Grokbuild type that satisfies harness.Harness.
// Mirrors the codex package shape: New() with options, ID()+Stream().

import (
	"context"
	"errors"
	"path/filepath"
	"strings"

	"github.com/yha/core/internal/stream"
)

// HarnessID is the registry key. Matches the FE harness type id +
// the bridge `harnesses` register entry.
const HarnessID = "grok"

// Skill is one skill block the route handler passes through.
type Skill struct {
	Name    string
	Content string
}

// ImageBlock is an image attachment. Grok's headless single-turn mode
// accepts JSON content blocks via --prompt-json, which we don't wire
// yet — the field is accepted for contract parity and currently
// ignored.
type ImageBlock struct {
	MediaType string
	Base64    string
}

// EmployeeMeta — broadcast / versus / DM-fork identity. Not read by
// the harness; carried for shape parity with the framework Request.
type EmployeeMeta struct {
	ID          string
	Name        string
	PartnerType string
	PartnerID   string
}

// Request mirrors harness.Request. Fields the harness doesn't use yet
// (ImageBlocks, BroadcastEmp, Caps) are accepted for parity.
type Request struct {
	SessionID        string
	HistorySessionID string

	// ResumeSessionID is the grok CLI's opaque session id from a
	// prior turn's session.end (round-tripped by the YHA adapter via
	// harness.History keyed under HarnessID). When non-empty we pass
	// --resume so the subprocess continues with its native memory
	// (tool calls/results, file edits, plans, compaction) instead of
	// a lossy text fold. The adapter typically skips the fold when
	// this is present. See https://docs.x.ai/build/cli/headless-scripting
	// (-r/--resume, -s/--session-id, -c/--continue) and the grok
	// broadcast adapter for employee parity.
	ResumeSessionID string

	Model           string
	Input           string
	Preset          string
	SystemMode      string
	Effort          string
	Skills          []Skill
	AllowedTools    []string
	CWD             string
	ImageBlocks     []ImageBlock
	HarnessInstance string
	GrokInstance    string
	Provider        string
	Caps            map[string]any
	BroadcastEmp    *EmployeeMeta
}

// Usage mirrors harness.Usage. We now parse input/output tokens when
// the grok CLI includes them on session.end (or a usage sibling event).
// Many subscription runs still emit 0 here (metering happens on xAI
// side); Cost is left 0. The finalize path and ledger will see real
// numbers as soon as the CLI surfaces them.
type Usage struct {
	InputTokens   int64
	OutputTokens  int64
	CacheRead     int64
	CacheCreation int64
	Cost          float64
	Model         string
}

// Result is what Stream returns to the caller.
type Result struct {
	Text       string
	Usage      Usage
	StopReason string
	SessionID  string
	Err        error
}

// Emit is the per-chunk callback shape.
type Emit = stream.EmitFn

// Option configures a Grokbuild via New().
type Option func(*Grokbuild)

// Grokbuild is the harness.Harness implementation. One per daemon;
// safe for concurrent Stream calls.
type Grokbuild struct {
	streamer *Streamer

	// defaultBinary is the grok executable path used when the Request
	// doesn't carry an override. Wire from config.defaults.grokBin.
	defaultBinary string

	// instanceResolver maps a GrokInstance id → a per-instance HOME
	// directory (auth lives in OS keychain / per-user storage; HOME is
	// the only knob we have to separate accounts on one box).
	instanceResolver InstanceResolver
}

// WithBinary sets the grok executable path (PATH lookup by default).
func WithBinary(path string) Option {
	return func(g *Grokbuild) { g.defaultBinary = path }
}

// WithInstanceResolver injects an InstanceResolver. See instance.go.
func WithInstanceResolver(r InstanceResolver) Option {
	return func(g *Grokbuild) { g.instanceResolver = r }
}

// New builds a Grokbuild with the provided options.
func New(opts ...Option) *Grokbuild {
	g := &Grokbuild{streamer: NewStreamer()}
	for _, o := range opts {
		o(g)
	}
	return g
}

// ID returns the harness identifier.
func (g *Grokbuild) ID() string { return HarnessID }

// Stream is the harness.Harness contract entry point. Spawns grok,
// parses streaming-json stdout, emits chunks via emit, and returns
// Result when the subprocess exits.
func (g *Grokbuild) Stream(ctx context.Context, req Request, emit Emit) (Result, error) {
	if emit == nil {
		err := errors.New("grokbuild.Stream: emit must be non-nil")
		return Result{Err: err}, err
	}
	if strings.TrimSpace(req.Input) == "" {
		err := errors.New("grokbuild.Stream: input required")
		return Result{Err: err}, err
	}

	prompt := assemblePrompt(req)
	model := stripGrokPrefix(req.Model)

	opts := SpawnOpts{
		Binary:          g.defaultBinary,
		CWD:             req.CWD,
		Model:           model,
		HomeDir:         g.resolveHomeDir(req),
		Prompt:          prompt,
		Effort:          mapEffort(req.Effort),
		AllowedTools:    filterGrokAllowedTools(req.AllowedTools),
		PresetText:      strings.TrimSpace(req.Preset),
		SystemMode:      strings.TrimSpace(req.SystemMode),
		ResumeSessionID: req.ResumeSessionID,
	}

	res, err := g.streamer.Run(ctx, runRequest{
		Prompt: prompt,
		Model:  model,
		Spawn:  opts,
	}, emit)

	out := Result{
		Text: res.Text,
		Usage: Usage{
			InputTokens:  res.InputTokens,
			OutputTokens: res.OutputTokens,
			Model:        firstNonEmpty(res.Model, model),
			// Cost stays 0 — grok CLI subscription runs typically do not
			// emit per-turn dollars; real spend is on the xAI account.
			// When the CLI starts surfacing usage we will pick it up here.
		},
		StopReason: res.StopReason,
		SessionID:  res.SessionID,
		Err:        err,
	}
	if err != nil && out.StopReason == "" {
		out.StopReason = "error"
	}
	if out.StopReason == "" {
		out.StopReason = "end_turn"
	}
	return out, err
}

// stripGrokPrefix mirrors the codex stripCodexPrefix path — accepts
// model ids like `grok/grok-4` and returns just `grok-4`. The FE
// generally sends the raw model id (`grok-4-fast`) but we tolerate
// the prefixed form for symmetry.
func stripGrokPrefix(modelID string) string {
	if i := strings.IndexByte(modelID, '/'); i >= 0 && strings.EqualFold(modelID[:i], "grok") {
		return modelID[i+1:]
	}
	return modelID
}

// resolveHomeDir picks the HOME / per-instance directory for this turn.
// Precedence:
//  1. Request.GrokInstance + resolver lookup
//  2. Request.GrokInstance treated as a literal path (when no resolver)
//  3. empty (subprocess inherits the daemon's HOME)
func (g *Grokbuild) resolveHomeDir(req Request) string {
	id := strings.TrimSpace(req.GrokInstance)
	if id == "" {
		return ""
	}
	if g.instanceResolver != nil {
		if dir, ok := g.instanceResolver.Resolve(id); ok {
			return dir
		}
	}
	if strings.ContainsAny(id, "/\\") {
		return normalizeHomeDir(id)
	}
	return ""
}

func normalizeHomeDir(dir string) string {
	dir = strings.TrimSpace(dir)
	if dir == "" {
		return ""
	}
	clean := filepath.Clean(dir)
	if strings.EqualFold(filepath.Base(clean), ".grok") {
		parent := filepath.Dir(clean)
		if parent != "." && parent != clean {
			return parent
		}
	}
	return dir
}

// EstimateGrokUsage provides a rough token estimate for grok-build turns
// when the CLI emits 0 (common under subscription tiers where real
// metering is account-level, not per-turn in the streaming-json).
// Uses simple char/4 heuristic + small overhead for prompt formatting.
// Called by the adapter fns (primary + broadcast) as fallback before
// finalize so ledger/busy-bar see plausible numbers instead of hard 0.
// Not a replacement for real usage when the CLI starts surfacing it.
func EstimateGrokUsage(input, output, model string) (inTokens, outTokens int64) {
	// Very rough: ~4 chars per token for English/code mix (common heuristic).
	// Add a bit for the YHA preamble/skills/tool-preamble wrapper and
	// the system/rules injection.
	const approx = 4
	baseIn := int64(len(input)+len(output)) / approx
	if baseIn < 0 {
		baseIn = 0
	}
	// Overhead for context wrapper, skills blocks, tool preamble etc.
	overhead := int64(256)
	if len(input) > 2000 {
		overhead += 512
	}
	inTokens = baseIn + overhead
	// Output is usually smaller; assume ~60% of input for coding turns
	// (conservative; real varies wildly with tool use).
	outTokens = int64(float64(inTokens) * 0.6)
	if outTokens < 32 {
		outTokens = 32
	}
	// Model ignored for now (grok-build-0.1 and variants similar rates).
	_ = model
	return inTokens, outTokens
}

// assemblePrompt folds skills + preset into the user input. Mirrors
// the codex pattern; grok understands --system-prompt-override and
// --rules for preset injection, but we keep skill blocks inline so
// the model sees them in the user turn just like codex does.
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

	if preamble := buildToolPreamble(req.AllowedTools); preamble != "" {
		prompt = preamble + "\n\n---\n\n" + prompt
	}

	return prompt
}
