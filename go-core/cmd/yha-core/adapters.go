// Broadcast + stream adapters (cost/persist/history/stop), direct-API picker.
// Extracted verbatim from main.go (same package main) — see main.go.

package main

import (
	"context"
	"errors"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/yha/core/internal/harness"
	"github.com/yha/core/internal/harness/claudebinary"
	codexh "github.com/yha/core/internal/harness/codex"
	grokbuildh "github.com/yha/core/internal/harness/grokbuild"
	hermesh "github.com/yha/core/internal/harness/hermes"
	openclawh "github.com/yha/core/internal/harness/openclaw"
	"github.com/yha/core/internal/logger"
	"github.com/yha/core/internal/nodecallback"
	"github.com/yha/core/internal/state"
	"github.com/yha/core/internal/stream"
	"github.com/yha/core/internal/stream/broadcast"
	"github.com/yha/core/internal/tools"
)

// broadcastPersistFn builds the broadcast.PersistFn closure that fires
// per-employee replies back to Node's /internal/persist-broadcast-message.
// Each call gets its own 5 s context so the broadcast chain never blocks
// on a slow disk save; errors land in the logger but the chain continues.
func broadcastPersistFn(client *nodecallback.PersistBroadcastMessageClient, log *logger.Logger) broadcast.PersistFn {
	if client == nil {
		return nil
	}
	return func(ctx context.Context, payload broadcast.PersistBroadcastPayload) {
		go func() {
			cctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			var author *nodecallback.PersistBroadcastAuthor
			if payload.Author != nil {
				author = &nodecallback.PersistBroadcastAuthor{
					ID:          payload.Author.ID,
					Name:        payload.Author.Name,
					Role:        payload.Author.Role,
					SymbolColor: payload.Author.SymbolColor,
				}
			}
			err := client.Persist(cctx, nodecallback.PersistBroadcastMessagePayload{
				SessionID:    payload.SessionID,
				EmployeeID:   payload.EmployeeID,
				Text:         payload.Text,
				Model:        payload.Model,
				InputTokens:  int(payload.InputTokens),
				OutputTokens: int(payload.OutputTokens),
				StopReason:   payload.StopReason,
				Author:       author,
			})
			if err != nil && log != nil {
				log.Warn("broadcast.persist", "session", payload.SessionID, "employee", payload.EmployeeID, "err", err)
			}
		}()
	}
}

// claudeBinaryBroadcastAdapter wraps the existing claudebinary
// Streamer into the broadcast.Adapter shape so multi-participant
// turns can fan one employee onto the binary path.
func claudeBinaryBroadcastAdapter(streamer *claudebinary.Streamer, defaults harnessInstances, store *state.Store, nodeURL string) broadcast.Adapter {
	return func(ctx context.Context, req harness.Request, emit harness.Emit) (*harness.Result, error) {
		instance, ok := defaults.pickBySubProvider(req.Provider)
		if !ok {
			instance = defaults.pick(req.HarnessInstance)
		}
		claudeModel := resolveClaudeSubscriptionModel(req.Model)
		external := !isClaudeModelID(claudeModel)
		proxyURL := ""
		if external {
			proxyURL = strings.TrimRight(nodeURL, "/") + "/proxy/" + url.PathEscape(req.Model)
		}
		// Broadcast turns: convert the harness.Request ImageBlocks
		// into the claude-binary wire shape. Pre-Phase-7 Node fed the
		// same FE attachments into every per-employee fork; this keeps
		// vision working in versus / sequential broadcast mode.
		var harnessImages []map[string]any
		for _, img := range req.ImageBlocks {
			blk := claudebinary.BuildImageBlock(img)
			if blk != nil {
				harnessImages = append(harnessImages, blk)
			}
		}
		cb := claudebinary.Request{
			Prompt:           req.Input,
			HistorySessionID: firstNonEmpty(req.HistorySessionID, req.SessionID),
			ImageBlocks:      harnessImages,
			MaxRetries:       1,
			Spawn: claudebinary.SpawnOpts{
				ClaudeBin:            firstNonEmpty(instance.Bin, stringDefault(cfgDefaultsMap(store), "claudeBin")),
				ConfigDir:            expandHomePath(instance.ConfigDir),
				CWD:                  req.CWD,
				Model:                claudeModel,
				Effort:               req.Effort,
				Reasoning:            stringMapValue(req.Caps, "reasoning"),
				Preset:               req.Preset,
				SysMode:              req.SystemMode,
				Subscription:         isClaudeSubscriptionProvider(req.Provider),
				AnthropicAPIKey:      apiKeyFromStore(store)("anthropic"),
				BridgeKey:            store.BridgeInternalKey(),
				SkipPermissions:      true,
				AllowedTools:         append([]string(nil), req.AllowedTools...),
				WorkingDirConstraint: strings.TrimSpace(req.CWD) != "",
				Stream:               true,
				External:             external,
				ProxyURL:             proxyURL,
			},
		}
		fp, err := streamer.Stream(ctx, cb, stream.EmitFn(emit))
		if err != nil {
			return nil, err
		}
		if fp == nil {
			return &harness.Result{}, nil
		}
		return &harness.Result{
			Text:       fp.Text,
			StopReason: fp.StopReason,
			Usage: harness.Usage{
				InputTokens:   int64(fp.InputTokens),
				OutputTokens:  int64(fp.OutputTokens),
				CacheRead:     int64(fp.CacheReadTokens),
				CacheCreation: int64(fp.CacheCreationTokens),
				Cost:          fp.Cost,
				Model:         req.Model,
			},
		}, nil
	}
}

// codexBroadcastAdapter wraps the codex harness into broadcast.Adapter.
func codexBroadcastAdapter(defaults harnessInstances, resolver codexh.InstanceResolver, store *state.Store) broadcast.Adapter {
	return func(ctx context.Context, req harness.Request, emit harness.Emit) (*harness.Result, error) {
		instance, fromSub := defaults.pickBySubProvider(req.Provider)
		if !fromSub {
			instance = defaults.pick(req.CodexInstance)
		}
		codexInstanceID := req.CodexInstance
		if fromSub {
			codexInstanceID = instance.Label
		} else if codexInstanceID == "" {
			codexInstanceID = instance.Label
		}
		codexAPIKey := ""
		if !isOpenAISubscriptionProvider(req.Provider) {
			codexAPIKey = apiKeyFromStore(store)("openai")
		}
		cx := codexh.New(
			codexh.WithBinary(firstNonEmpty(instance.Bin, stringDefault(cfgDefaultsMap(store), "codexBin"))),
			codexh.WithExecMode(stringDefault(cfgDefaultsMap(store), "codexExecMode")),
			codexh.WithOpenAIAPIKey(codexAPIKey),
			codexh.WithInstanceResolver(resolver),
		)
		res, err := cx.Stream(ctx, codexh.Request{
			SessionID:        req.SessionID,
			HistorySessionID: firstNonEmpty(req.HistorySessionID, req.SessionID),
			Model:            req.Model,
			Input:            req.Input,
			Preset:           req.Preset,
			SystemMode:       req.SystemMode,
			Effort:           req.Effort,
			AllowedTools:     append([]string(nil), req.AllowedTools...),
			CWD:              req.CWD,
			HarnessInstance:  req.HarnessInstance,
			CodexInstance:    codexInstanceID,
			Provider:         req.Provider,
			Caps:             req.Caps,
		}, codexh.Emit(emit))
		if err != nil {
			return nil, err
		}
		return &harness.Result{
			Text:       "",
			StopReason: res.StopReason,
			Usage: harness.Usage{
				InputTokens:   res.Usage.InputTokens,
				OutputTokens:  res.Usage.OutputTokens,
				CacheRead:     res.Usage.CacheRead,
				CacheCreation: res.Usage.CacheCreation,
				Cost:          res.Usage.Cost,
				Model:         firstNonEmpty(res.Usage.Model, req.Model),
			},
		}, nil
	}
}

// grokBroadcastAdapter wraps the grok harness into broadcast.Adapter
// (thin, like codex). Routes via the same instance pick + resolver
// so grok employees get the local CLI (CWD boundary, tool allow-list,
// HOME isolation, --resume when the main path has stored a sid).
// Resume/fold heavy lifting stays in the primary "grok" HarnessAdapterFn
// for now (broadcast employees get the Input as composed by the runner).
func grokBroadcastAdapter(defaults harnessInstances, resolver grokbuildh.InstanceResolver, store *state.Store, hist *harness.History) broadcast.Adapter {
	// Local helpers mirroring grokHistoryResolver (defined in harness_wiring.go)
	// so broadcast employees get the same --resume / sid roundtrip as primary chat.
	getResume := func(key string) string {
		if hist == nil {
			return ""
		}
		v, _ := hist.Get(grokbuildh.HarnessID, key)
		return v
	}
	setResume := func(key, sid string) {
		if hist == nil || sid == "" {
			return
		}
		_ = hist.Set(grokbuildh.HarnessID, key, sid)
	}
	deleteResume := func(key string) {
		if hist == nil || key == "" {
			return
		}
		_ = hist.Delete(grokbuildh.HarnessID, key)
	}

	return func(ctx context.Context, req harness.Request, emit harness.Emit) (*harness.Result, error) {
		instance, fromSub := defaults.pickBySubProvider(req.Provider)
		if !fromSub {
			instance = defaults.pick(firstNonEmpty(req.GrokInstance, req.HarnessInstance))
		}
		grokInstanceID := firstNonEmpty(req.GrokInstance, req.HarnessInstance)
		if fromSub {
			grokInstanceID = instance.Label
		} else if grokInstanceID == "" {
			grokInstanceID = instance.Label
		}

		// Resume lookup for broadcast employees (uses HistorySessionID or SessionID,
		// exactly like primary's grokHist.Get). This completes the "grok in groups"
		// parity from Part 10/11 risks. If present, pass to harness so --resume is used
		// and the lossy fold is skipped by the caller (runner supplies bare Input).
		resumeKey := firstNonEmpty(req.HistorySessionID, req.SessionID)
		resumeID := getResume(resumeKey)

		gx := grokbuildh.New(
			grokbuildh.WithBinary(firstNonEmpty(instance.Bin, stringDefault(cfgDefaultsMap(store), "grokBin"))),
			grokbuildh.WithInstanceResolver(resolver),
		)
		res, err := gx.Stream(ctx, grokbuildh.Request{
			SessionID:        req.SessionID,
			HistorySessionID: resumeKey,
			ResumeSessionID:  resumeID,
			Model:            req.Model,
			Input:            req.Input,
			Preset:           req.Preset,
			SystemMode:       req.SystemMode,
			Effort:           req.Effort,
			AllowedTools:     append([]string(nil), req.AllowedTools...),
			CWD:              req.CWD,
			HarnessInstance:  req.HarnessInstance,
			GrokInstance:     grokInstanceID,
			Provider:         req.Provider,
			Caps:             req.Caps,
			// BroadcastEmp: omitted — grok harness treats it as shape-only
			// (not read today); the outer broadcast runner already tags
			// chunks with _empId / _author.
		}, grokbuildh.Emit(emit))
		if err != nil {
			if resumeID != "" {
				// Poisoned --resume sid from a prior grok turn (CLI session died,
				// auth under the HOME dir went bad, or CLI rejected the sid).
				// Drop it so the next employee turn doesn't inherit the death.
				deleteResume(resumeKey)
			}
			return nil, err
		}
		if res.SessionID != "" {
			setResume(resumeKey, res.SessionID)
		}
		// Estimator fallback for broadcast grok employees too (keeps
		// cost ledger honest when CLI gives 0).
		if res.Usage.InputTokens == 0 && res.Usage.OutputTokens == 0 {
			estIn, estOut := grokbuildh.EstimateGrokUsage(req.Input, res.Text, req.Model)
			res.Usage.InputTokens = estIn
			res.Usage.OutputTokens = estOut
		}
		return &harness.Result{
			Text:       "",
			StopReason: res.StopReason,
			Usage: harness.Usage{
				InputTokens:   res.Usage.InputTokens,
				OutputTokens:  res.Usage.OutputTokens,
				CacheRead:     res.Usage.CacheRead,
				CacheCreation: res.Usage.CacheCreation,
				Cost:          res.Usage.Cost,
				Model:         firstNonEmpty(res.Usage.Model, req.Model),
			},
		}, nil
	}
}

// openclawBroadcastAdapter forwards directly to the openclaw harness.
func openclawBroadcastAdapter(h *openclawh.Harness) broadcast.Adapter {
	return func(ctx context.Context, req harness.Request, emit harness.Emit) (*harness.Result, error) {
		res, err := h.Stream(ctx, req, emit)
		if err != nil {
			return nil, err
		}
		return &res, nil
	}
}

// hermesBroadcastAdapter forwards directly to the hermes harness.
func hermesBroadcastAdapter(h *hermesh.Harness) broadcast.Adapter {
	return func(ctx context.Context, req harness.Request, emit harness.Emit) (*harness.Result, error) {
		res, err := h.Stream(ctx, req, emit)
		if err != nil {
			return nil, err
		}
		return &res, nil
	}
}

// defaultDirectAPIPicker mirrors the unexported pickProvider in
// internal/stream/route.go so the broadcast direct-API adapter can
// resolve a Provider for a given model id without importing an
// unexported helper. Routing rules MUST stay in sync with the
// canonical picker — same model-id prefixes, same provider names.
func defaultDirectAPIPicker(model string) (stream.Provider, string, error) {
	m := strings.ToLower(model)
	switch {
	case strings.HasPrefix(m, "claude-"), strings.HasPrefix(m, "claude/"):
		return &stream.AnthropicProvider{Model: model}, "anthropic", nil
	case strings.HasPrefix(m, "gpt-"), strings.HasPrefix(m, "openai/"),
		strings.HasPrefix(m, "o1-"), strings.HasPrefix(m, "o3-"):
		return &stream.OpenAIProvider{Model: model}, "openai", nil
	case strings.HasPrefix(m, "gemini-"), strings.HasPrefix(m, "google/"):
		return &stream.GeminiProvider{Model: model}, "gemini", nil
	}
	return nil, "", errors.New("unsupported model " + model + " — pick claude-*, gpt-*, o1-*, o3-*, or gemini-*")
}

// directAPIBroadcastAdapter wraps the in-process direct-API streamer
// (stream.Run) into a broadcast.Adapter so a versus / broadcast turn
// can fan onto an employee whose model is served by a direct
// Anthropic / OpenAI / Gemini API call (no harness instance pinned).
//
// The closure mirrors the canonical direct-API leg in
// internal/stream/route.go: pick the provider, fetch the API key,
// build the message slice + tool catalog, narrow by AllowedTools,
// thread the per-call cwd/sessionId into the runner via WithSession,
// and call stream.Run. Provider usage (Anthropic message_start +
// message_delta, OpenAI final include_usage frame, Gemini
// usageMetadata) is folded back through UsageProvider into the
// returned harness.Result so the broadcast Runner can aggregate
// across the chain.
//
// Text accumulation is deliberately left to the broadcast Runner —
// its per-employee wrappedEmit accumulates Delta/Text chunks and
// fills EmployeeResult.Text when our Result.Text is empty.
func directAPIBroadcastAdapter(
	pickFn func(model string) (stream.Provider, string, error),
	apiKeyFor func(provider string) string,
	runner tools.Runner,
	httpClient *http.Client,
	log *logger.Logger,
	recorder stream.Recorder,
	limiter stream.RateLimiter,
) broadcast.Adapter {
	return func(ctx context.Context, req harness.Request, emit harness.Emit) (*harness.Result, error) {
		if pickFn == nil {
			err := errors.New("direct-api broadcast adapter: PickProvider not configured")
			emit(stream.Chunk{Type: stream.ChunkTypeError, Error: err.Error()})
			return nil, err
		}
		provider, providerName, err := pickFn(req.Model)
		if err != nil {
			emit(stream.Chunk{Type: stream.ChunkTypeError, Error: err.Error()})
			return nil, err
		}
		apiKey := ""
		if apiKeyFor != nil {
			apiKey = apiKeyFor(providerName)
		}
		if apiKey == "" {
			err := errors.New("direct-api broadcast adapter: no API key configured for provider " + providerName)
			emit(stream.Chunk{Type: stream.ChunkTypeError, Error: err.Error()})
			return nil, err
		}

		// Build the conversation: optional system message from req.Preset
		// (the broadcast runner has already composed identity + footers
		// into Preset), then the user turn.
		messages := []stream.Message{}
		if strings.TrimSpace(req.Preset) != "" {
			messages = append(messages, stream.Message{Role: "system", Content: req.Preset})
		}
		messages = append(messages, stream.Message{Role: "user", Content: req.Input})

		// Tool catalog: pull the runner's full advertised set and
		// narrow by req.AllowedTools when set. Mirrors the route's
		// CatalogFilter / filterCatalogByName logic, kept local so we
		// don't depend on unexported helpers.
		var catalog []stream.Tool
		perCallRunner := runner
		if runner != nil {
			catalog = narrowCatalogForDirectAPI(runner.Catalog(), req.AllowedTools)
			if req.AllowedTools != nil && len(req.AllowedTools) == 0 {
				// explicit off (capTools=off etc) → prevent exec of hallucinated calls
				perCallRunner = nil
			} else if cr, ok := runner.(*tools.CompositeRunner); ok {
				// Per-session view so Node-callback tools receive the
				// right cwd + sessionId. *tools.CompositeRunner exposes
				// WithSession; plain *tools.Executor ignores both.
				perCallRunner = cr.WithSession(req.CWD, req.SessionID)
			}
		}

		opts := stream.Opts{
			APIKey:     apiKey,
			HTTPClient: httpClient,
			Logger:     log,
			Recorder:   recorder,
			Limiter:    limiter,
		}

		// Reset any leftover usage on the provider before the loop
		// runs. pickFn returns a fresh struct today, but ResetUsage
		// is cheap + future-proof against pooled instances.
		if up, ok := provider.(stream.UsageProvider); ok {
			up.ResetUsage()
		}

		runErr := stream.Run(ctx, provider, perCallRunner, messages, catalog, opts, stream.EmitFn(emit))

		// Even on error, fold the provider's accumulated usage so the
		// caller sees the partial telemetry. stream.Run emitted any
		// inline error chunk itself.
		result := &harness.Result{
			StopReason: "end_turn",
			Usage:      harness.Usage{Model: req.Model},
		}
		if up, ok := provider.(stream.UsageProvider); ok {
			u := up.Usage()
			result.Usage.InputTokens = int64(u.InputTokens)
			result.Usage.OutputTokens = int64(u.OutputTokens)
			result.Usage.CacheRead = int64(u.CacheReadTokens)
			result.Usage.CacheCreation = int64(u.CacheCreationTokens)
		}
		if runErr != nil {
			result.StopReason = "error"
			result.Err = runErr
			return result, runErr
		}
		return result, nil
	}
}

// narrowCatalogForDirectAPI mirrors stream.filterCatalogByName for
// the broadcast direct-API adapter.
//   - names == nil   → full catalog (no restriction)
//   - names == []{}  → empty catalog (capTools=off or tools deactivated)
//   - non-empty      → only the named tools (filter)
func narrowCatalogForDirectAPI(in []tools.Tool, names []string) []stream.Tool {
	out := make([]stream.Tool, 0, len(in))
	if names == nil {
		// nil = no restriction from caller → full
		for _, t := range in {
			out = append(out, stream.Tool{
				Name:        t.Name,
				Description: t.Description,
				InputSchema: t.InputSchema,
			})
		}
		return out
	}
	// non-nil (incl. explicit empty) = allow-list; empty list yields no matches
	allow := make(map[string]struct{}, len(names))
	for _, n := range names {
		allow[n] = struct{}{}
	}
	for _, t := range in {
		if _, ok := allow[t.Name]; !ok {
			continue
		}
		out = append(out, stream.Tool{
			Name:        t.Name,
			Description: t.Description,
			InputSchema: t.InputSchema,
		})
	}
	return out
}

// streamProviderToConfigName maps the stream package's provider name
// ("openai" | "anthropic" | "gemini") to the bridge config's provider
// label ("OpenAI" | "Anthropic" | "Google" — yes, Gemini uses "Google").
var streamProviderToConfigName = map[string]string{
	"openai":    "OpenAI",
	"anthropic": "Anthropic",
	"gemini":    "Google",
}

// costEventAdapter bridges stream.CostEventSink ⇆
// nodecallback.CostEventClient. The stream package declares its own
// payload struct to keep an import boundary; this adapter copies fields
// across at the route-finalize site.
type costEventAdapter struct {
	client *nodecallback.CostEventClient
}

func (a costEventAdapter) Record(ctx context.Context, p stream.CostEventPayload) error {
	var tools []nodecallback.ToolEventRecord
	if len(p.Tools) > 0 {
		tools = make([]nodecallback.ToolEventRecord, len(p.Tools))
		for i, t := range p.Tools {
			tools[i] = nodecallback.ToolEventRecord{Name: t.Name, OK: t.OK}
		}
	}
	return a.client.Record(ctx, nodecallback.CostEventPayload{
		SessionID:           p.SessionID,
		Model:               p.Model,
		Provider:            p.Provider,
		InputTokens:         p.InputTokens,
		OutputTokens:        p.OutputTokens,
		CacheReadTokens:     p.CacheReadTokens,
		CacheCreationTokens: p.CacheCreationTokens,
		Cost:                p.Cost,
		ToolCallCount:       p.ToolCallCount,
		DurationMs:          p.DurationMs,
		Tools:               tools,
	})
}

func (a costEventAdapter) EnqueueAutoTitle(ctx context.Context, sessionID string) error {
	return a.client.EnqueueAutoTitle(ctx, sessionID)
}

func (a costEventAdapter) FireAndForget(label string, fn func(context.Context) error) {
	a.client.FireAndForget(label, fn)
}

// persistMessageAdapter bridges the stream package's
// stream.MessagePersister surface to the nodecallback
// PersistBroadcastMessageClient. The Node endpoint is generic over
// role + text + meta — "broadcast" is in the name for historical
// reasons. The stream package keeps its own payload type so it
// doesn't need to import nodecallback; this adapter copies fields.
type persistMessageAdapter struct {
	client *nodecallback.PersistBroadcastMessageClient
}

func (a persistMessageAdapter) Persist(ctx context.Context, p stream.PersistMessagePayload) error {
	if a.client == nil {
		return nil
	}
	return a.client.Persist(ctx, a.payload(p))
}

func (a persistMessageAdapter) PersistWithToken(ctx context.Context, p stream.PersistMessagePayload) (int64, error) {
	if a.client == nil {
		return 0, nil
	}
	resp, err := a.client.PersistWithToken(ctx, a.payload(p))
	if err != nil {
		return 0, err
	}
	return resp.LiveToken, nil
}

func (a persistMessageAdapter) FinalizeAbandoned(ctx context.Context, sessionID, reason string) error {
	if a.client == nil {
		return nil
	}
	return a.client.FinalizeAbandoned(ctx, sessionID, reason)
}

// payload converts stream's typed PersistBlock slice to the generic
// map shape the Node endpoint accepts. Empty Blocks falls back to
// the text-only legacy path on the bridge side.
func (a persistMessageAdapter) payload(p stream.PersistMessagePayload) nodecallback.PersistBroadcastMessagePayload {
	var blocks []map[string]any
	for _, b := range p.Blocks {
		blk := map[string]any{"type": b.Type}
		if b.Content != "" {
			blk["content"] = b.Content
		}
		if b.Name != "" {
			blk["name"] = b.Name
		}
		if b.Detail != nil {
			blk["detail"] = b.Detail
		}
		if b.ToolID != "" {
			blk["toolId"] = b.ToolID
		}
		if b.Kind != "" {
			blk["kind"] = b.Kind
		}
		blocks = append(blocks, blk)
	}
	return nodecallback.PersistBroadcastMessagePayload{
		SessionID:     p.SessionID,
		Role:          p.Role,
		Text:          p.Text,
		Blocks:        blocks,
		Model:         p.Model,
		InputTokens:   p.InputTokens,
		OutputTokens:  p.OutputTokens,
		DurationMs:    p.DurationMs,
		StopReason:    p.StopReason,
		Phase:         p.Phase,
		LiveToken:     p.LiveToken,
		ToolCallCount: p.ToolCallCount,
		APICallCount:  p.APICallCount,
		TurnStartMs:   p.TurnStartMs,
	}
}

// historyLoaderAdapter bridges nodecallback.SessionHistoryClient to
// stream.HistoryLoader so the route can ask Node for prior-turn LLM
// context without importing nodecallback directly.
type historyLoaderAdapter struct {
	client *nodecallback.SessionHistoryClient
}

func (a historyLoaderAdapter) Load(ctx context.Context, sessionID, selfEmpID string) ([]stream.Message, error) {
	if a.client == nil {
		return nil, nil
	}
	msgs, err := a.client.Load(ctx, sessionID, selfEmpID)
	if err != nil {
		return nil, err
	}
	out := make([]stream.Message, 0, len(msgs))
	for _, m := range msgs {
		out = append(out, stream.Message{Role: m.Role, Content: m.Content})
	}
	return out, nil
}

// stopRegistryAdapter bridges harness.ActiveProcesses to the route's
// StopRegistry surface. The two share Register/Stop/Drop but the
// ActiveProcesses signature uses the named `harness.KillFn` type
// while the interface declares `func()` — Go's method-set matching
// requires this thin wrapper. Mirrors Node's
// bridge/core/state.ts:activeProcesses Map.
type stopRegistryAdapter struct {
	active *harness.ActiveProcesses
}

func (a stopRegistryAdapter) Register(sessionID string, kill func()) {
	if a.active == nil {
		return
	}
	a.active.Register(sessionID, harness.KillFn(kill))
}

func (a stopRegistryAdapter) Stop(sessionID string) bool {
	if a.active == nil {
		return false
	}
	return a.active.Stop(sessionID)
}

func (a stopRegistryAdapter) Drop(sessionID string) {
	if a.active == nil {
		return
	}
	a.active.Drop(sessionID)
}

// apiKeyFromStore returns a closure that resolves API keys for the
// stream route. state.LoadConfig already injects env-var keys into
// each provider map (api_key field) so this is a straight lookup via
// the read-locked Store.APIKey helper — no deep-clone per call.
func apiKeyFromStore(s *state.Store) func(string) string {
	return func(streamProvider string) string {
		configName, ok := streamProviderToConfigName[streamProvider]
		if !ok {
			return ""
		}
		if k := s.APIKey(configName); k != "" {
			return k
		}
		// Fallback: read directly from env in case config.json doesn't
		// list this provider yet.
		switch streamProvider {
		case "openai":
			return os.Getenv("OPENAI_API_KEY")
		case "anthropic":
			return os.Getenv("ANTHROPIC_API_KEY")
		case "gemini":
			return os.Getenv("GOOGLE_API_KEY")
		}
		return ""
	}
}
