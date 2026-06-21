// Runner — per-employee broadcast loop.
//
// Drives each participant in a multi-participant turn through their
// assigned harness adapter and emits the merged stream on a single
// outer SSE pipe. Two modes:
//
//   - "sequential" (default): employees run in order; chunks reach the
//     FE in document order. The shared `chainHistoryId` lets each
//     downstream employee see the previous ones' replies (Node owns
//     the actual history persistence today — see the gap comment below).
//   - "versus": employees run concurrently; every chunk is tagged with
//     `_empId` via the per-employee emitter so the FE routes it into
//     the right author lane.
//
// The runner DOES NOT call into bridge/sessions.json — per-employee
// turn persistence (pushDisplayMsg + rebuildSessionChatHistory) stays
// Node-owned for now. The runner accumulates the assembled text per
// employee in-memory and returns it via ChainResult so the wiring
// agent (or a future Phase-6/7 agent) can POST it to Node when the
// persistence boundary is finalised.

package broadcast

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/yha/core/internal/harness"
	"github.com/yha/core/internal/logger"
	"github.com/yha/core/internal/stream"
)

// ChunkEmitter is the outer per-chunk callback the route hands the
// runner. Compatible with stream.EmitFn so the runner can plug into
// the existing stream.HarnessAdapterFn shape at the route boundary.
//
// The runner is responsible for tagging chunks with `_empId` in
// versus mode — the outer ChunkEmitter sees fully-tagged chunks.
type ChunkEmitter func(stream.Chunk)

// Adapter is the per-employee call signature the runner uses to
// dispatch to a specific harness. Mirrors harness.Harness.Stream
// minus the receiver so tests can register scripted closures without
// constructing full Harness implementations.
//
// Adapters MUST emit chunks via the provided emit closure (which
// already wraps the outer ChunkEmitter + per-employee tagging) and
// return a *harness.Result on clean completion. ctx cancellation
// MUST be respected.
type Adapter func(ctx context.Context, req harness.Request, emit harness.Emit) (*harness.Result, error)

// AdapterID names a runner-routable adapter. The runner picks one of
// these for each employee based on partnerType / model prefix /
// instance hints.
const (
	AdapterClaudeBinary = "claude-binary"
	AdapterCodex        = "codex"
	AdapterGrok         = "grok"
	AdapterOpenClaw     = "openclaw"
	AdapterHermes       = "hermes"
	AdapterDirectAPI    = "direct-api"
)

// Runner is the broadcast / versus dispatcher. Construct once per
// daemon; reuse across requests. Adapters is the per-harness call
// table. Employees is the EmployeeRecord lookup. Log is optional
// (nil = silent).
type Runner struct {
	Adapters  map[string]Adapter
	Employees EmployeeLoader
	Log       *logger.Logger

	// BridgeRoot is the absolute path to bridge/. Used by the per-chain
	// composer to pull the shared IMPORTANT-memory footer and the
	// per-session CWD-context footer into every employee's system
	// prompt. Empty disables footer composition (legacy / tests) —
	// footers then travel via Node's helpers, which is the pre-§8.3
	// behaviour. Wired in cmd/yha-core/main.go to paths.BridgeRoot().
	BridgeRoot string

	// Now is the time source used to fabricate per-chain history ids
	// ("<sessionId>::chain::<ts>::<empId>"). Tests override to
	// produce deterministic ids.
	Now func() time.Time

	// VersusJitter is the inter-employee start delay used in versus
	// mode to keep concurrent requests from leaving the daemon in
	// lockstep. Defaults to 0 (no jitter) so tests are deterministic.
	// Production wiring sets this to a non-zero base (e.g. 220ms) to
	// mirror Node's broadcast.ts behaviour.
	VersusJitter time.Duration

	// Persist, when non-nil, is invoked once per successful employee
	// turn so the assistant reply lands in bridge/sessions/<sid>.json
	// (where the FE expects to read it from on reload). Fire-and-forget:
	// the runner spawns a goroutine with a fresh 5 s timeout so a slow
	// Node-side save never blocks the chain. Errors are logged via
	// Runner.Log; the chain continues regardless.
	//
	// Skipped when Persist is nil, when the employee adapter returned
	// an error, or when the assembled reply text is empty.
	Persist PersistFn
}

// PersistFn is the per-employee callback the runner invokes after each
// successful adapter call. Implementations should be safe for concurrent
// use because versus-mode dispatch fires them from multiple goroutines.
type PersistFn func(ctx context.Context, payload PersistBroadcastPayload)

// PersistBroadcastPayload is the data sent to PersistFn. Mirrors the
// Node-side /internal/persist-broadcast-message body
// (cmd/yha-core/main.go builds the closure that copies these fields into
// nodecallback.PersistBroadcastMessagePayload).
type PersistBroadcastPayload struct {
	SessionID    string
	EmployeeID   string
	Text         string
	Model        string
	InputTokens  int64
	OutputTokens int64
	StopReason   string
	Author       *PersistBroadcastAuthor
}

// PersistBroadcastAuthor is the embedded author block the FE renders as
// the per-employee message header.
type PersistBroadcastAuthor struct {
	ID          string
	Name        string
	Role        string
	SymbolColor string
}

// Request is the per-chain input. SessionID, Model, Input, Preset
// flow into each employee's harness call alongside the per-employee
// preset / allow-list / image filter. CWD, SystemMode, Effort,
// Caps, Skills, AllowedTools, ImageBlocks, HarnessInstance,
// CodexInstance, GrokInstance, Provider are passed through unchanged.
type Request struct {
	SessionID       string
	Input           string
	Model           string
	BasePreset      string
	SystemMode      string
	Effort          string
	CWD             string
	Provider        string
	HarnessInstance string
	CodexInstance   string
	GrokInstance    string
	AllowedTools    []string
	ImageBlocks     []harness.ImageBlock
	Caps            map[string]any
	Skills          []harness.Skill

	// PresetTools is the tool allow-list bucket the FE configured
	// for this turn's ToolSetPreset. The runner narrows it per
	// employee via AllowedToolsForEmployee.
	PresetTools []string
}

// ChainResult is the aggregate the runner returns once every
// employee finishes (or the chain errors out). PerEmployee carries
// one entry per employee in dispatch order; Combined is the
// concatenation of every successful reply for callers that want a
// single string.
type ChainResult struct {
	PerEmployee []EmployeeResult
	Combined    string
	Usage       harness.Usage
	Err         error
}

// EmployeeResult is the per-employee row in a ChainResult.
type EmployeeResult struct {
	EmployeeID string
	Text       string
	Usage      harness.Usage
	StopReason string
	Err        error
}

// RunChain is the entry point. ids is the ordered list of employee
// ids; mode is "sequential" (default) or "versus"; base is the
// per-chain Request. emit is the outer ChunkEmitter.
//
// Returns a ChainResult with one EmployeeResult per id, even when
// individual employees fail (their Err field is set; the chain
// continues so other employees can still answer). Chain-level
// failures (ctx cancellation, employee loader errors) populate
// ChainResult.Err.
func (r *Runner) RunChain(ctx context.Context, ids []string, mode string, base Request, emit ChunkEmitter) (*ChainResult, error) {
	if r == nil {
		return nil, errors.New("broadcast: nil Runner")
	}
	if r.Employees == nil {
		return nil, errors.New("broadcast: Runner.Employees is required")
	}
	if emit == nil {
		emit = func(stream.Chunk) {}
	}
	if r.Now == nil {
		r.Now = time.Now
	}
	mode = normalizeMode(mode)

	chainTS := r.Now().UnixNano()
	chainID := fmt.Sprintf("%s::chain::%d", base.SessionID, chainTS)
	if mode == "versus" {
		chainID = fmt.Sprintf("%s::vs::%d", base.SessionID, chainTS)
	}

	// Resolve every employee up front so we can short-circuit on
	// load errors before opening the SSE pipe.
	records := make([]*EmployeeRecord, 0, len(ids))
	for _, id := range ids {
		rec, err := r.Employees.Load(id)
		if err != nil {
			return &ChainResult{Err: fmt.Errorf("broadcast: load %q: %w", id, err)}, err
		}
		if rec == nil {
			continue
		}
		records = append(records, rec)
	}
	if len(records) == 0 {
		return &ChainResult{}, nil
	}

	if mode == "versus" {
		return r.runVersus(ctx, records, chainID, base, emit), nil
	}
	return r.runSequential(ctx, records, chainID, base, emit), nil
}

func (r *Runner) runSequential(ctx context.Context, records []*EmployeeRecord, chainID string, base Request, emit ChunkEmitter) *ChainResult {
	out := &ChainResult{PerEmployee: make([]EmployeeResult, 0, len(records))}
	var combined strings.Builder

	for i, rec := range records {
		if err := ctx.Err(); err != nil {
			out.Err = err
			return out
		}
		historyID := fmt.Sprintf("%s::%d::%s", chainID, i, rec.ID)
		res := r.runOne(ctx, rec, base, historyID, emit, "" /* untagged in sequential */)
		out.PerEmployee = append(out.PerEmployee, res)
		out.Usage.InputTokens += res.Usage.InputTokens
		out.Usage.OutputTokens += res.Usage.OutputTokens
		out.Usage.CacheRead += res.Usage.CacheRead
		out.Usage.CacheCreation += res.Usage.CacheCreation
		out.Usage.Cost += res.Usage.Cost
		if res.Err == nil && res.Text != "" {
			if combined.Len() > 0 {
				combined.WriteString("\n")
			}
			combined.WriteString(res.Text)
		}
	}
	out.Combined = combined.String()
	return out
}

func (r *Runner) runVersus(ctx context.Context, records []*EmployeeRecord, chainID string, base Request, emit ChunkEmitter) *ChainResult {
	out := &ChainResult{PerEmployee: make([]EmployeeResult, len(records))}

	// Serialise outer emit calls — the SSE writer + reattach buffer
	// in the route handler is single-threaded. The harness package
	// docs the same invariant: "Adapters MUST NOT call emit
	// concurrently from multiple goroutines."
	var emitMu sync.Mutex
	wrappedEmit := func(c stream.Chunk) {
		emitMu.Lock()
		defer emitMu.Unlock()
		emit(c)
	}

	var wg sync.WaitGroup
	for i, rec := range records {
		wg.Add(1)
		go func(idx int, employee *EmployeeRecord) {
			defer wg.Done()
			// Optional inter-employee jitter so concurrent requests
			// don't leave the daemon in lockstep. Default 0 →
			// kicks off immediately (deterministic in tests).
			if r.VersusJitter > 0 && idx > 0 {
				select {
				case <-time.After(time.Duration(idx) * r.VersusJitter):
				case <-ctx.Done():
					out.PerEmployee[idx] = EmployeeResult{EmployeeID: employee.ID, Err: ctx.Err()}
					return
				}
			}
			historyID := fmt.Sprintf("%s::%d::%s", chainID, idx, employee.ID)
			res := r.runOne(ctx, employee, base, historyID, wrappedEmit, employee.ID /* tagged */)
			out.PerEmployee[idx] = res
		}(i, rec)
	}
	wg.Wait()

	var combined strings.Builder
	for _, res := range out.PerEmployee {
		out.Usage.InputTokens += res.Usage.InputTokens
		out.Usage.OutputTokens += res.Usage.OutputTokens
		out.Usage.CacheRead += res.Usage.CacheRead
		out.Usage.CacheCreation += res.Usage.CacheCreation
		out.Usage.Cost += res.Usage.Cost
		if res.Err == nil && res.Text != "" {
			if combined.Len() > 0 {
				combined.WriteString("\n")
			}
			combined.WriteString(res.Text)
		}
	}
	out.Combined = combined.String()
	return out
}

// runOne dispatches a single employee through the right adapter,
// emits an `author` chunk first, then forwards every adapter chunk
// (tagged with _empId if taggedEmpID is non-empty). Returns the
// per-employee result — never panics; adapter errors fold into
// EmployeeResult.Err and an SSE error chunk is emitted so the FE
// surfaces the failure.
//
// Per-employee history persistence is intentionally omitted: Node
// still owns pushDisplayMsg + rebuildSessionChatHistory; the
// in-memory `Text` accumulator returned here is the only place the
// reply survives once the SSE pipe closes. The wiring agent (or a
// future Phase agent) can POST these to /internal/persist-broadcast
// once the API surface is finalised.
func (r *Runner) runOne(ctx context.Context, rec *EmployeeRecord, base Request, historyID string, emit ChunkEmitter, taggedEmpID string) EmployeeResult {
	res := EmployeeResult{EmployeeID: rec.ID}

	adapterID, err := r.pickAdapterID(rec, base)
	if err != nil {
		res.Err = err
		emitError(emit, taggedEmpID, err.Error())
		return res
	}
	adapter, ok := r.Adapters[adapterID]
	if !ok || adapter == nil {
		err := fmt.Errorf("broadcast: no adapter registered for %q (employee %s)", adapterID, rec.ID)
		res.Err = err
		emitError(emit, taggedEmpID, err.Error())
		return res
	}

	// Effective model + preset for this employee.
	model := EffectiveModel(rec, base.Model)
	preset := ComposePreset(
		base.BasePreset,
		IdentityNote(rec.Name),
		ImportantFooter(r.BridgeRoot),
		CWDContextFooter(r.BridgeRoot, base.CWD),
	)
	sysMode := EffectiveSystemMode(base.SystemMode)
	images := ImagesForEmployee(rec, base.ImageBlocks)
	allowed := AllowedToolsForEmployee(rec, base.PresetTools)
	if allowed == nil && len(base.AllowedTools) > 0 {
		// Session-level allow-list trickles through when the
		// employee didn't override.
		allowed = append([]string(nil), base.AllowedTools...)
	}

	// Author chunk — the FE keys per-author segments off this. The
	// typed Author block (`chunk._author`) replaces the tab-separated
	// reasoning string the FE used to substring-parse pre-§8.4; the
	// reasoning string is kept in parallel for one release so older FEs
	// continue to render the right tag while new FEs read the typed
	// payload. Drop the reasoning fallback after the FE has shipped.
	authorChunk := stream.Chunk{
		Type:     stream.ChunkTypeText,
		Text:     "",
		Provider: adapterID,
		Author: &stream.Author{
			ID:          rec.ID,
			Name:        rec.Name,
			Role:        rec.Role,
			SymbolColor: rec.SymbolColor,
			Model:       model,
			Adapter:     adapterID,
		},
	}
	if taggedEmpID != "" {
		// Versus mode: stamp the chunk with the empId via the typed
		// Chunk.EmpID field (serialised as `_empId` on the wire to
		// match bridge/modules/multichat-broadcast/runner.ts).
		authorChunk.EmpID = taggedEmpID
	}
	authorChunk.Reasoning = formatAuthor(rec, model, adapterID)
	emit(authorChunk)

	// Per-employee emit wrapper: tag every chunk with the empId in
	// versus mode, forward unchanged in sequential mode.
	empEmit := func(c stream.Chunk) {
		if taggedEmpID != "" {
			c.EmpID = taggedEmpID
		}
		emit(c)
	}
	var accum strings.Builder
	wrappedEmit := harness.Emit(func(c stream.Chunk) {
		if c.Type == stream.ChunkTypeDelta && c.Delta != "" {
			accum.WriteString(c.Delta)
		}
		if c.Type == stream.ChunkTypeText && c.Text != "" {
			accum.WriteString(c.Text)
		}
		empEmit(c)
	})

	req := harness.Request{
		SessionID:        base.SessionID,
		HistorySessionID: historyID,
		Model:            model,
		Input:            base.Input,
		Preset:           preset,
		SystemMode:       sysMode,
		Effort:           base.Effort,
		Skills:           base.Skills,
		AllowedTools:     allowed,
		CWD:              base.CWD,
		ImageBlocks:      images,
		HarnessInstance:  base.HarnessInstance,
		CodexInstance:    base.CodexInstance,
		GrokInstance:     base.GrokInstance,
		Provider:         base.Provider,
		Caps:             base.Caps,
		BroadcastEmp: &harness.EmployeeMeta{
			ID:          rec.ID,
			Name:        rec.Name,
			PartnerType: rec.PartnerType,
			PartnerID:   rec.PartnerID,
		},
	}

	result, err := adapter(ctx, req, wrappedEmit)
	if err != nil {
		res.Err = err
		res.Text = accum.String()
		if r.Log != nil {
			r.Log.Warn("broadcast.adapter-error", "employee", rec.ID, "adapter", adapterID, "err", err)
		}
		emitError(empEmit, taggedEmpID, err.Error())
		return res
	}
	if result != nil {
		res.Usage = result.Usage
		res.StopReason = result.StopReason
		if strings.TrimSpace(result.Text) != "" {
			res.Text = result.Text
		} else {
			res.Text = accum.String()
		}
	} else {
		res.Text = accum.String()
	}

	// Persistence hop — Phase 6g/7. Fire-and-forget POST to Node's
	// /internal/persist-broadcast-message so this employee's assistant
	// reply lands in bridge/sessions/<sid>.json. Only fires when the
	// adapter succeeded AND produced non-empty text; errors are logged
	// via Runner.Log but never fail the chain.
	if r.Persist != nil && res.Err == nil && res.Text != "" {
		payload := PersistBroadcastPayload{
			SessionID:    base.SessionID,
			EmployeeID:   rec.ID,
			Text:         res.Text,
			Model:        model,
			InputTokens:  res.Usage.InputTokens,
			OutputTokens: res.Usage.OutputTokens,
			StopReason:   res.StopReason,
			Author: &PersistBroadcastAuthor{
				ID:          rec.ID,
				Name:        rec.Name,
				Role:        rec.Role,
				SymbolColor: rec.SymbolColor,
			},
		}
		r.Persist(ctx, payload)
	}
	return res
}

// pickAdapterID encodes the per-employee adapter-routing rules.
// Mirrors the empRoute switch in bridge/modules/multichat-broadcast/
// runner.ts plus the Phase-6 partner-type carve-outs.
//
// Precedence (top wins):
//  1. partnerType=="openclaw" → openclaw
//  2. partnerType=="hermes"   → hermes
//  3. model has codex/ prefix OR base.CodexInstance set → codex
//  4. model has claude- prefix AND base.Provider is a Subscription
//     hint → claude-binary
//  5. base.HarnessInstance set → claude-binary
//  6. otherwise → direct-api
//
// Unknown partner types return an error so the SSE wire gets a
// clear "unsupported partner" rather than silently re-routing to
// direct-api (which would call anthropic.com with a partner-only
// payload).
func (r *Runner) pickAdapterID(rec *EmployeeRecord, base Request) (string, error) {
	switch strings.ToLower(strings.TrimSpace(rec.PartnerType)) {
	case "openclaw":
		return AdapterOpenClaw, nil
	case "hermes":
		return AdapterHermes, nil
	case "":
		// not a partner — fall through to model-based routing
	default:
		return "", fmt.Errorf("broadcast: unsupported partner type %q for employee %s", rec.PartnerType, rec.ID)
	}

	model := strings.ToLower(strings.TrimSpace(EffectiveModel(rec, base.Model)))
	if strings.HasPrefix(model, "codex/") || strings.TrimSpace(base.CodexInstance) != "" {
		return AdapterCodex, nil
	}
	// Grok routing (model prefix, explicit GrokInstance, or Grok-SUB /
	// xai provider hints). Placed before HarnessInstance->claude so a
	// grok employee/model wins even if HarnessInstance is also set.
	if strings.HasPrefix(model, "grok/") || strings.HasPrefix(model, "grok-") ||
		strings.TrimSpace(base.GrokInstance) != "" ||
		strings.Contains(strings.ToLower(base.Provider), "grok") ||
		strings.Contains(strings.ToLower(base.Provider), "xai") {
		return AdapterGrok, nil
	}
	if strings.HasPrefix(model, "claude-") && strings.Contains(strings.ToLower(base.Provider), "subscription") {
		return AdapterClaudeBinary, nil
	}
	if strings.TrimSpace(base.HarnessInstance) != "" {
		return AdapterClaudeBinary, nil
	}
	return AdapterDirectAPI, nil
}

func normalizeMode(mode string) string {
	switch strings.ToLower(strings.TrimSpace(mode)) {
	case "versus":
		return "versus"
	default:
		return "sequential"
	}
}

// formatAuthor produces the human-readable author tag the FE stuffs
// into the assistant message header. Mirrors the broadcastChunk's
// { author: { id, name, role, symbolColor }, model } shape, encoded
// as a tab-separated reasoning chunk because stream.Chunk doesn't
// have a dedicated author field yet.
//
// Example: "author\temp-1\tAlice\tBoss\t#ff0000\tclaude-opus\tdirect-api"
//
// TODO(broadcast-tag): replace once stream.Chunk grows a typed
// Author block. Today the FE has to substring-parse this.
func formatAuthor(rec *EmployeeRecord, model, adapter string) string {
	parts := []string{
		"author",
		rec.ID,
		rec.Name,
		rec.Role,
		rec.SymbolColor,
		model,
		adapter,
	}
	return strings.Join(parts, "\t")
}

// emitError sends a typed error chunk down the outer pipe so the FE
// surfaces the failure without aborting peer-employee streams (which
// matters in versus mode — one employee crashing shouldn't kill the
// others).
func emitError(emit ChunkEmitter, taggedEmpID, msg string) {
	c := stream.Chunk{Type: stream.ChunkTypeError, Error: msg}
	if taggedEmpID != "" {
		c.EmpID = taggedEmpID
	}
	emit(c)
}
