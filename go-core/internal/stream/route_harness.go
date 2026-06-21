// Phase 6 harness adapter dispatch — every harness port (claude-binary,
// claude-sdk, codex, partners hermes / openclaw, broadcast) plugs in
// here. When the classifier says "non-direct" and a registered
// HarnessAdapterFn matches the request, the route hands the request
// off to the adapter (running in-process).
//
// Phase 6g flipped the gate semantics from opt-in to opt-out: with a
// registered adapter, the in-process path is the default. Operators
// disable a specific harness port by setting YHA_GO_<UPPER>=0 (or
// "false", case-insensitive). Phase 7 then deleted the Node /v1/stream/
// fallback — a disabled adapter (or a non-direct request with no
// matching adapter at all) now returns 502 with the canonical
// "no harness adapter available" error (see route.go).
package stream

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// pickHarnessAdapter consults the adapters map + the opt-out env vars
// to decide whether to dispatch in-process. Returns the matched
// adapter + the label it matched on, or (nil, "") if no match.
//
// Matching rules:
//   - Exact match on req.HarnessInstance still wins; this keeps the
//     original "label maps directly to an adapter id" behaviour for
//     future adapters that choose to use it.
//   - Codex is selected by the FE-shape routing signals Node already
//     uses: req.CodexInstance or a model id with the `codex/` prefix.
//   - Claude binary is selected by any non-empty HarnessInstance when
//     a `claude-binary` adapter is registered. The FE sends the picked
//     instance label here; the adapter resolves it to configDir/bin.
//   - For each matched label, the env-var gate is checked. Var name is
//     "YHA_GO_" + UPPER_SNAKE(label) (dashes → underscores). The gate
//     is opt-OUT as of Phase 6g: enabled by default, disabled only
//     when the env var is explicitly "0" or "false" (case-insensitive).
//
// Returning a nil adapter means the route will surface the Phase 7
// 502 ("no harness adapter available") — there is no Node fallback.
func pickHarnessAdapter(adapters map[string]HarnessAdapterFn, req *streamRequest, participantCtx ParticipantRouteContext) (HarnessAdapterFn, string) {
	if len(adapters) == 0 {
		return nil, ""
	}
	// Multi-participant broadcast / versus path. Selected before any
	// single-target adapter so a group session with no @-mention fans
	// out through the broadcast adapter rather than falling into a
	// per-target lookup. The adapter itself walks ParticipantIDs and
	// dispatches each employee through the right per-harness adapter.
	if participantCtx.HasParticipants && participantCtx.Target == nil && len(participantCtx.ParticipantIDs) > 1 {
		if adapter, ok := adapters["broadcast"]; ok && harnessAdapterEnabled("broadcast") {
			return adapter, "broadcast"
		}
	}
	if participantCtx.Target != nil && strings.EqualFold(participantCtx.Target.PartnerType, "openclaw") {
		if adapter, ok := adapters["openclaw"]; ok && harnessAdapterEnabled("openclaw") {
			return adapter, "openclaw"
		}
	}
	if participantCtx.Target != nil && strings.EqualFold(participantCtx.Target.PartnerType, "hermes") {
		if adapter, ok := adapters["hermes"]; ok && harnessAdapterEnabled("hermes") {
			return adapter, "hermes"
		}
	}
	// Slash commands ALWAYS route to claude-binary — the binary owns
	// the / vocabulary (`/help`, `/clear`, `/review`, …). Classifier
	// already marked the turn non-direct; this branch makes sure the
	// adapter ladder doesn't fall through to e.g. codex just because
	// a stale CodexInstance is set in the FE state.
	if isSlashCommandInput(req.Input) {
		if adapter, ok := adapters["claude-binary"]; ok && harnessAdapterEnabled("claude-binary") {
			return adapter, "claude-binary"
		}
	}

	label := strings.TrimSpace(req.HarnessInstance)
	if label != "" {
		if adapter, ok := adapters[label]; ok && harnessAdapterEnabled(label) {
			return adapter, label
		}
	}
	// Provider-driven routing is the source of truth for subscription
	// models — the FE ships both HarnessInstance and CodexInstance
	// globally (independent stores), so a Claude-SUB model can arrive
	// with a stale codexInstance set and vice-versa. Looking at Provider
	// first guarantees Anthropic-SUB* goes to claude-binary and
	// OpenAI-SUB* goes to codex regardless of which instance fields the
	// FE happens to have populated. Mirrors Node's resolveRouteType /
	// resolveSubscriptionProvider (bridge/providers/core.ts).
	provider := strings.TrimSpace(req.Provider)
	if provider != "" {
		if reClaudeSubProvider.MatchString(provider) || provider == "Anthropic Subscription" {
			if adapter, ok := adapters["claude-binary"]; ok && harnessAdapterEnabled("claude-binary") {
				return adapter, "claude-binary"
			}
		}
		if reCodexSubProvider.MatchString(provider) || provider == "OpenAI Subscription" {
			if adapter, ok := adapters["codex"]; ok && harnessAdapterEnabled("codex") {
				return adapter, "codex"
			}
		}
		if reGrokSubProvider.MatchString(provider) || provider == "Grok Subscription" {
			if adapter, ok := adapters["grok"]; ok && harnessAdapterEnabled("grok") {
				return adapter, "grok"
			}
			// Note: grok-acp is not auto-selected by provider alone to
			// keep the default "grok" (headless binary) experience
			// stable; users opt into the ACP/agent-stdio route explicitly
			// via HarnessInstance="grok-acp" (like claude-sdk).
		}
	}
	// Pure-model grok routing. `grok/<model>` prefix pins the request
	// to the grok harness even without a subscription provider hint —
	// symmetrical with the codex/* branch below. The bare `grok-*`
	// model id stays direct-API by default (the GROK_API_KEY path)
	// because that's what most users have configured.
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(req.Model)), "grok/") {
		if adapter, ok := adapters["grok"]; ok && harnessAdapterEnabled("grok") {
			return adapter, "grok"
		}
	}
	// Explicit grok-acp (ACP / `grok agent stdio`) selection, mirroring
	// the claude-sdk special case. This is the "SDK/agent protocol" route
	// for the local Grok Build CLI (long-lived JSON-RPC agent process
	// instead of one-shot headless -p streaming-json). Selected when the
	// FE (or advanced user) pins HarnessInstance == "grok-acp".
	// Allows side-by-side use of both routes, switchable per-turn or
	// per-instance, exactly like claude-binary vs claude-sdk.
	if label != "" && strings.EqualFold(label, "grok-acp") {
		if adapter, ok := adapters["grok-acp"]; ok && harnessAdapterEnabled("grok-acp") {
			return adapter, "grok-acp"
		}
	}
	// Pure-model codex routing. The classic "codex/" prefix is the only
	// model signal that pins this turn to the codex adapter regardless
	// of subscription state. A non-empty CodexInstance ALONE is NOT
	// enough — the FE stores codexInstance globally, so it stays
	// populated after a user switches to a third-party model (DeepSeek,
	// OpenRouter, etc.) and would otherwise drag every subsequent turn
	// onto the codex CLI.
	if strings.HasPrefix(strings.ToLower(strings.TrimSpace(req.Model)), "codex/") {
		if adapter, ok := adapters["codex"]; ok && harnessAdapterEnabled("codex") {
			return adapter, "codex"
		}
	}
	if label != "" {
		// claude-sdk is the SDK-runtime alternate to claude-binary. We
		// select it when the FE explicitly pins HarnessInstance ==
		// "claude-sdk" so existing claude-binary deployments stay
		// unaffected until operators flip YHA_GO_CLAUDE_SDK=1.
		if strings.EqualFold(label, "claude-sdk") {
			if adapter, ok := adapters["claude-sdk"]; ok && harnessAdapterEnabled("claude-sdk") {
				return adapter, "claude-sdk"
			}
		}
		// claude-binary catch-all: the deployment uses the "claude
		// binary as universal client" trick — claude CLI is configured
		// with a custom apiUrl pointing back at the bridge's own proxy,
		// and the bridge rewrites the upstream based on the requested
		// model id (Anthropic for claude-*, DeepSeek for deepseek-*,
		// etc.). So a non-Claude model id with HarnessInstance set is
		// still a valid claude-binary route; do NOT gate this on the
		// model prefix.
		if adapter, ok := adapters["claude-binary"]; ok && harnessAdapterEnabled("claude-binary") {
			return adapter, "claude-binary"
		}
	}
	return nil, ""
}

// isBroadcastDispatch reports whether this turn went through the
// broadcast adapter. Broadcast already has its own per-employee
// persistence hook on broadcast.Runner.Persist; calling
// PersistMessage from the route would double-record the assistant
// chunks on multi-participant turns.
func isBroadcastDispatch(label string, req HarnessAdapterRequest) bool {
	if label == "broadcast" {
		return true
	}
	return len(req.ParticipantIDs) > 1
}

// harnessAdapterEnabled reports whether the harness adapter for the
// given label is currently enabled. Phase 6g flipped this from opt-in
// to opt-out: any registered adapter is on by default. Operators
// disable a specific family by setting "YHA_GO_<UPPER>" to "0" or
// "false" (case-insensitive) — any other value (including unset,
// "1", "true", or empty) leaves the adapter enabled. Empty labels
// remain rejected so callers can't accidentally short-circuit the
// adapter-lookup precedence in pickHarnessAdapter.
func harnessAdapterEnabled(label string) bool {
	if strings.TrimSpace(label) == "" {
		return false
	}
	envName := "YHA_GO_" + strings.ToUpper(strings.ReplaceAll(label, "-", "_"))
	switch strings.ToLower(strings.TrimSpace(os.Getenv(envName))) {
	case "0", "false":
		return false
	}
	return true
}

// dispatchHarnessAdapter wires the adapter into the response: opens
// the SSE response, builds the emit closure (with buffer stamping +
// SSE writer), runs the adapter, schedules buffer finalize on exit,
// and posts cost-event / auto-title.
//
// This is a near-clone of the direct-API branch tail in
// RegisterRoute's handler — the duplication is deliberate because the
// adapter path may want to evolve independently of direct-API
// streaming (different telemetry, different reattach semantics).
func dispatchHarnessAdapter(
	w http.ResponseWriter,
	r *http.Request,
	deps RouteDeps,
	req HarnessAdapterRequest,
	body []byte,
	adapter HarnessAdapterFn,
	label string,
) {
	// Open the SSE response.
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher, _ := w.(http.Flusher)
	if flusher != nil {
		flusher.Flush()
	}

	sessionID := req.SessionID
	// The Subscribe-based pump architecture requires a buffer to fan
	// chunks out through. Production always wires one in deps.Buffer;
	// for tests / edge cases that don't, create an ephemeral
	// per-request buffer so emit's Append still fans out to our pump's
	// Subscribe. The ephemeral buffer is GC'd when the request
	// goroutines unwind; it's not reachable for reattach subscribers
	// (no one else knows about it), but tests don't exercise reattach.
	sessionBuffer := deps.Buffer
	if sessionBuffer == nil {
		sessionBuffer = NewSessionBuffer()
	}
	sessionBuffer.CancelFinalize(sessionID)
	// Create the buffer entry up-front so a reattach EventSource
	// opened before the adapter's first emit() doesn't 404. Without
	// this, a user switching sessions in the small gap between POST
	// start and the model's first chunk leaves the reattach handler
	// finding "no stream" — the FE then never reconnects and shows
	// only the disk state (or nothing) until a manual reload.
	sessionBuffer.Ensure(sessionID)

	// Persist the user message NOW, synchronously, before the adapter
	// starts. Pre-Phase-7 Node wrote a `streaming: true` live-message
	// placeholder on first chunk so a user who hit send and immediately
	// switched away (or reloaded) didn't lose the prompt. Our delayed
	// post-finalize persistence had a race window: switch away after
	// send but before finalize, and the prompt disappears entirely from
	// disk — the FE re-renders the session from /v1/sessions/<sid>.json
	// on switch-back and sees nothing. Synchronously persisting the
	// user role closes that window. Broadcast turns persist via their
	// own runner hook so skip them here. Fire from a fresh context so
	// an immediate client disconnect doesn't kill the bridge POST.
	if deps.PersistMessage != nil && sessionID != "" && !isBroadcastDispatch(label, req) {
		userText := strings.TrimSpace(req.Input)
		if userText != "" {
			persistCtx, persistCancel := context.WithTimeout(context.Background(), 5*time.Second)
			if err := deps.PersistMessage.Persist(persistCtx, PersistMessagePayload{
				SessionID: sessionID,
				Role:      "user",
				Text:      userText,
			}); err != nil {
				deps.Logger.Warn("stream.persist.user-pre", "session", sessionID, "err", err)
			}
			persistCancel()
		}
	}

	var (
		toolCallCount atomic.Int64
		apiCallCount  atomic.Int64
		inModelTurn   atomic.Bool
		// Running token usage stashed off in-flight chunks so the
		// live-meta ticker below can paint a token count on the busy bar
		// from the turn's start. claude-binary attaches per-message usage
		// to its delta/reasoning/tool chunks (see claudebinary/events.go);
		// adapters that don't simply leave these at 0 until the terminal
		// chunk, which is harmless (the bar still shows model + clock).
		liveInputTok    atomic.Int64
		liveOutputTok   atomic.Int64
		liveCacheRead   atomic.Int64
		liveCacheCreate atomic.Int64
		toolEventsMu    sync.Mutex
		toolEvents      []ToolEventRecord
		turnStart       = time.Now()
		endEmitted      atomic.Bool // adapter emitted its own _end? skip the post-return synthesizer.
		endCh           = make(chan struct{}, 1)
		textMu          sync.Mutex
		assistantText   strings.Builder         // accumulated assistant reply for /internal/persist-broadcast-message
		blockAccum      = NewBlockAccumulator() // rich-block accumulator so reload shows tool-call + thinking traces, not just flat text
		liveToken       atomic.Int64            // 0 until startLiveMsg returned a token; subsequent updates pin to it
		liveStarted     atomic.Bool
		// finalPersisted flips true once we've written the
		// phase:"final" record to Node — either synchronously from
		// the emit closure right before forwarding _end, or
		// asynchronously from postFinalize (whichever fires first).
		// postFinalize checks this flag and skips its own persist call
		// so we don't double-finalise (which would APPEND a duplicate
		// assistant message — finalizeLiveMsg fails to find the
		// already-cleared liveToken and falls back to pushDisplayMsg).
		finalPersisted atomic.Bool
		// Adapter-finalize capture state. Declared here (not just
		// before postFinalize) because the emit closure needs to
		// snapshot the latest finalize payload before persisting the
		// pre-_end record, so the disk row carries real tokens / stop
		// reason instead of zeroes.
		finalizeMu sync.Mutex
		finalizeFP HarnessFinalize
		gotFinal   bool
	)

	// finalize is the callback adapters invoke with their per-turn
	// totals. Declared up-front so the emit closure's pre-_end
	// persistFinal can snapshot the latest values via finalizeMu.
	finalize := HarnessFinalizeFn(func(fp HarnessFinalize) {
		fmt.Fprintf(os.Stderr, "{\"trace\":\"route_harness.finalize\",\"stage\":\"set\",\"fields\":{\"label\":%q,\"input\":%d,\"output\":%d,\"cost\":%g,\"stopReason\":%q}}\n",
			label, fp.InputTokens, fp.OutputTokens, fp.Cost, fp.StopReason)
		finalizeMu.Lock()
		defer finalizeMu.Unlock()
		finalizeFP = fp
		gotFinal = true
	})

	// persistFinal writes the `phase:"final"` record that strips
	// streaming:true / _liveToken from the on-disk placeholder. It
	// runs synchronously (5 s timeout) so the disk is clean before
	// the caller continues. Idempotent: the finalPersisted flag
	// ensures we only fire once across the two call-sites (emit's
	// pre-_end hook + postFinalize's async tail). Broadcast turns
	// skip — their per-employee persistence runs through the
	// broadcast.Runner hook instead.
	//
	// Called from the emit closure when `_end` is observed (before
	// the chunk reaches the SSE writer) so a bridge restart between
	// "FE shows done" and "Go-side postFinalize POSTs final" can't
	// leave a streaming:true placeholder on disk and cause the
	// _normalizeAbandonedLiveMessages sweep to append a spurious
	// "Bridge restarted before this reply could finish" interrupt.
	persistFinal := func(fp HarnessFinalize, hadFinal bool) {
		if !finalPersisted.CompareAndSwap(false, true) {
			return
		}
		if deps.PersistMessage == nil || sessionID == "" || isBroadcastDispatch(label, req) {
			return
		}
		textMu.Lock()
		assistantOut := assistantText.String()
		blocksOut := blockAccum.Blocks()
		textMu.Unlock()
		if strings.TrimSpace(assistantOut) == "" && len(blocksOut) == 0 {
			return
		}
		modelName := req.Model
		providerName := req.Provider
		if hadFinal {
			if fp.Model != "" {
				modelName = fp.Model
			}
			if fp.Provider != "" {
				providerName = fp.Provider
			}
		}
		tok := liveToken.Load()
		// First, fire a phase:"update" write so the latest content
		// lands on disk even if the phase:"final" call below fails
		// (Node restarting mid-call, slow finalizeLiveMsg, transient
		// network blip). updateLiveMsg keeps streaming:true so the FE
		// would still see the placeholder as streaming until Node's
		// _liveDeadline sweep finalises it — but the BLOCKS are there,
		// which is what the user actually cares about. The user's
		// previous complaint ("saw more content while live than after
		// refresh") was this exact race.
		if tok > 0 {
			uctx, ucancel := context.WithTimeout(context.Background(), 10*time.Second)
			// Include live counters here too (pre-final safety net).
			inC := int(liveInputTok.Load())
			outC := int(liveOutputTok.Load())
			crC := int(liveCacheRead.Load())
			ccC := int(liveCacheCreate.Load())
			tcC := int(toolCallCount.Load())
			acC := int(apiCallCount.Load())
			if err := deps.PersistMessage.Persist(uctx, PersistMessagePayload{
				SessionID:     sessionID,
				Role:          "assistant",
				Phase:         "update",
				LiveToken:     tok,
				Text:          assistantOut,
				Blocks:        blocksOut,
				InputTokens:   inC + crC + ccC,
				OutputTokens:  outC,
				ToolCallCount: tcC,
				APICallCount:  acC,
				TurnStartMs:   turnStart.UnixMilli(),
				Model:         req.Model,
			}); err != nil {
				deps.Logger.Warn("stream.persist.assistant.pre-final-update", "session", sessionID, "err", err)
			}
			ucancel()
		}
		phase := ""
		if tok > 0 {
			phase = "final"
		}

		// Resolve the per-turn token totals. fp comes from the adapter's
		// finalize() callback, but the synchronous pre-_end persist (this
		// helper's caller in the emit closure's c.End hook) fires BEFORE
		// finalize() runs: claude-binary emits its terminal `_end` chunk
		// from inside processStream, while finalize() is only invoked once
		// processStream returns. So fp is still the zero value at snapshot
		// time and the row would persist inputTokens:0/outputTokens:0 (the
		// "hidden final meta bar on reload/switch" bug). The live usage
		// atomics, by contrast, were just stamped from that same `_end`
		// chunk (see the emit closure's usage stash), so fall back to them
		// whenever fp is empty.
		inTok := fp.InputTokens
		outTok := fp.OutputTokens
		cacheRead := fp.CacheReadTokens
		cacheCreate := fp.CacheCreationTokens
		if inTok == 0 {
			inTok = int(liveInputTok.Load())
		}
		if outTok == 0 {
			outTok = int(liveOutputTok.Load())
		}
		if cacheRead == 0 {
			cacheRead = int(liveCacheRead.Load())
		}
		if cacheCreate == 0 {
			cacheCreate = int(liveCacheCreate.Load())
		}
		// PersistMessagePayload carries no cache-token fields, and the FE
		// folds cacheRead+cacheCreate into the displayed "tokens in" anyway.
		// Pre-fold them into InputTokens so a reloaded / switched-into harness
		// session shows the true prompt size instead of the uncached delta
		// (often ~2 under prompt caching) — matching the live `_end` path,
		// which folds the same three counts FE-side (chat-streaming `_end`).
		inTok += cacheRead + cacheCreate

		finalPayload := PersistMessagePayload{
			SessionID:    sessionID,
			Role:         "assistant",
			Text:         assistantOut,
			Blocks:       blocksOut,
			Model:        modelName,
			Provider:     providerName,
			InputTokens:  inTok,
			OutputTokens: outTok,
			// Wall-clock turn length, identical to the value the SSE `_end`
			// chunk carries (endChunk.DurationMs, also time.Since(turnStart)),
			// so the reloaded final bar shows the same elapsed the live timer
			// counted instead of falling back to the bare wall-clock timestamp.
			DurationMs: int(time.Since(turnStart).Milliseconds()),
			StopReason: fp.StopReason,
			Phase:      phase,
			LiveToken:  tok,
		}

		// Step 6: write directly to SQLite first. The bridge HTTP POST
		// below still fires so displaySessions stays in-memory-consistent,
		// but the durable record is committed *before* we touch the
		// network. A bridge restart between here and the HTTP POST
		// completing no longer drops the finalized state.
		//
		// Skipped cleanly when SQLiteFinalizer is nil (Pre-Step-6 deploy)
		// or when Phase != "final" (the helper returns ok=false). In
		// either case we fall through to the legacy HTTP retry loop.
		var sqliteOK bool
		if deps.SQLiteFinalizer != nil && phase == "final" {
			sctx, scancel := context.WithTimeout(context.Background(), 5*time.Second)
			ok, serr := deps.SQLiteFinalizer.FinalizeMessage(sctx, finalPayload)
			scancel()
			if serr != nil {
				deps.Logger.Warn("stream.persist.sqlite", "session", sessionID, "err", serr)
				// Fall through to the HTTP path as a fallback.
			} else {
				sqliteOK = ok
			}
		}

		// Retry the bridge POST a few times — Node's finalizeLiveMsg
		// path includes a synchronous flushSessionToDisk() that can
		// take a beat under load. When the SQLite direct write
		// already landed, this loop's job shrinks to "best-effort
		// in-memory sync"; a single failure is logged but does not
		// require rolling back finalPersisted (durability is already
		// secured via the SQLite write above).
		var lastErr error
		for attempt := 0; attempt < 3; attempt++ {
			pctx, pcancel := context.WithTimeout(context.Background(), 15*time.Second)
			err := deps.PersistMessage.Persist(pctx, finalPayload)
			pcancel()
			if err == nil {
				return
			}
			lastErr = err
			// Backoff: 100 ms, 500 ms, then give up.
			if attempt < 2 {
				time.Sleep(time.Duration(100*(attempt+1)*5) * time.Millisecond)
			}
		}
		deps.Logger.Warn("stream.persist.assistant", "session", sessionID, "err", lastErr, "sqlite_ok", sqliteOK)
		if sqliteOK {
			// SQLite write succeeded; the message is durable. The
			// bridge will pick up the finalized state from the DB
			// on next read or restart. No need to mark the write
			// as unfinished.
			return
		}
		// Roll the flag back so postFinalize's async retry path
		// can still attempt the write. Disk already has the
		// updateLiveMsg content from above, so the user won't see
		// content loss even if the final-phase strip fails.
		finalPersisted.Store(false)
	}

	// startLivePlaceholder kicks off the mid-stream live-message
	// lifecycle on the first content chunk. Mirrors Node's
	// startLiveMsg — writes a `streaming:true` entry to disk
	// immediately so a daemon crash mid-stream still leaves the
	// partial reply visible. liveToken is filled in once Node returns.
	// Broadcast turns persist via their own runner hook so skip.
	startLivePlaceholder := func() {
		if deps.PersistMessage == nil || sessionID == "" || isBroadcastDispatch(label, req) {
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
				Provider:  req.Provider,
			})
			if err != nil {
				deps.Logger.Warn("stream.persist.live-start", "session", sessionID, "err", err)
				return
			}
			liveToken.Store(tok)
		}()
	}

	// pumpCh is the local channel the SSE writer pump drains. emit()
	// pushes every chunk here AND (when a buffer + sessionID is
	// available) calls Buffer.Append so reattach EventSource
	// subscribers get the same fan-out. This unifies the live POST and
	// reattach paths architecturally — both are "subscribers" reading
	// from a channel; a slow client only stalls its own pump.
	// 1024 cap matches buffer.Subscribe; non-blocking send drops if
	// full (recoverable via reattach + ring buffer).
	pumpCh := make(chan Chunk, 1024)
	pumpDone := make(chan struct{})

	// emit is now write-into-channel + buffer fan-out — no direct
	// response.Write. The unified pump (streamChunksToClient) runs in
	// its own goroutine and is responsible for SSE I/O. This is the
	// architectural fix the user asked for: a slow tunneled FE can
	// stall its own pump without poisoning the adapter or reattach
	// subscribers.
	emit := EmitFn(func(c Chunk) {
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
		// API call counter for harness-driven agent loops (grok/codex/claude-binary/...).
		// Mirrors the block-counting logic in FE (chat-utils computeBlockCounts) and
		// the per-iteration bump in native route loop. Lets live meta bar show "2×"
		// etc for multi-step turns on both attached and activity-feed (switched/reload)
		// paths. State machine: a model response starts on first content (delta/reasoning/tool-use)
		// after start or after a tool-result.
		if c.Type == ChunkTypeDelta || c.Type == ChunkTypeReasoning || c.Type == ChunkTypeToolUse {
			if !inModelTurn.Load() {
				inModelTurn.Store(true)
				apiCallCount.Add(1)
			}
		}
		if c.Type == ChunkTypeToolResult {
			inModelTurn.Store(false)
		}
		// Stash any token usage riding on this chunk for the live-meta
		// ticker. Last-writer-wins: claude-binary reports the in-flight
		// per-message totals, which grow over the turn.
		if c.InputTokens > 0 {
			liveInputTok.Store(int64(c.InputTokens))
		}
		if c.OutputTokens > 0 {
			liveOutputTok.Store(int64(c.OutputTokens))
		}
		if c.CacheReadTokens > 0 {
			liveCacheRead.Store(int64(c.CacheReadTokens))
		}
		if c.CacheCreationTokens > 0 {
			liveCacheCreate.Store(int64(c.CacheCreationTokens))
		}
		// Persist-side text accumulation. Each delta chunk gets folded
		// into a per-stream buffer that the postFinalize hook POSTs
		// back to Node so bridge/sessions/<sid>.json stays the FE's
		// source of truth across session switches + reloads.
		needsAccum := c.Type == ChunkTypeDelta ||
			c.Type == ChunkTypeText ||
			c.Type == ChunkTypeReasoning ||
			c.Type == ChunkTypeToolUse ||
			c.Type == ChunkTypeToolResult ||
			c.Type == ChunkTypeError
		if needsAccum && !textMu.TryLock() {
			// emit() sits directly on harness stdout consumers. It must never
			// park forever on the persistence accumulator: one stuck lock here
			// stops draining codex/claude stdout, fills the subprocess pipe, and
			// zombies the whole turn. Prefer dropping one live checkpoint block
			// over deadlocking the adapter; clean finalize / rollout salvage are
			// the durable backstops.
			deps.Logger.Warn("stream.harness.emit.accumulator-busy", "session", sessionID, "label", label, "chunk", c.Type)
		} else if needsAccum {
			if c.Type == ChunkTypeDelta {
				t := c.Text
				if t == "" {
					t = c.Delta
				}
				if t != "" {
					assistantText.WriteString(t)
				}
			}
			blockAccum.Observe(c)
			textMu.Unlock()
		}
		// First content-carrying chunk opens the live-message
		// placeholder on disk. Anything visible (delta / reasoning /
		// tool-use / tool-result / error) counts as evidence the model is
		// actually replying — heartbeats and the synthetic _end don't.
		// Including ChunkTypeError ensures pure-error harness turns (spawn
		// fail, early CLI exit, pipe break mid-turn, poisoned resume, etc)
		// always create an assistant row so the error surfaces in history
		// instead of the user prompt having no following message at all.
		switch c.Type {
		case ChunkTypeDelta, ChunkTypeText, ChunkTypeReasoning, ChunkTypeToolUse, ChunkTypeToolResult, ChunkTypeError:
			startLivePlaceholder()
		}
		if c.End && !endEmitted.Swap(true) {
			// First _end seen. Persist phase:"final" synchronously
			// BEFORE the chunk reaches the FE pump (via Append, which
			// already happened above — but the pump's channel is
			// buffered so we have a small window). Without this, the
			// FE sees "done" instantly, the user restarts the bridge a
			// beat later, and Go's async postFinalize never makes it
			// to Node — leaving streaming:true on disk + a spurious
			// "Bridge restarted before this reply could finish"
			// interrupt block on next load.
			finalizeMu.Lock()
			fpSnap := finalizeFP
			hadFinalSnap := gotFinal
			finalizeMu.Unlock()
			persistFinal(fpSnap, hadFinalSnap)
			// Arm the buffer's grace timer NOW so Status flips to
			// "done" and ActiveSessions stops reporting this session
			// as live. Without this the session poller would see
			// serverRunning=true → AppEffects fires reconnectStream
			// → pushes a fresh typing placeholder → replay re-delivers
			// _end → duplicates the agent message.
			if sessionID != "" {
				sessionBuffer.ScheduleFinalize(sessionID)
				// Drop the activity-feed busy entry at the same instant
				// the buffer flips to "done": _end means the turn is
				// finished. Otherwise busy-clear rides stopLiveMeta, which
				// is gated on the adapter goroutine returning — but
				// claude-binary blocks in handles.Wait() until the
				// subprocess exits its TLS/plugin teardown; the 30s
				// finalize watchdog isn't prompt on Windows, so the 5-min
				// livemeta TTL was what cleared it, leaving finished chats
				// "busy" for minutes. Safe: the 450ms ticker's
				// UpdateLiveMeta no-ops for an unregistered session (no
				// resurrection), and a turn the user abandoned before _end
				// stays busy until the adapter returns or the TTL reaps it.
				UnregisterLiveMeta(sessionID)
			}
			select {
			case endCh <- struct{}{}:
			default:
			}
		}
		// Push to the pump channel for SSE delivery. Non-blocking so
		// a stalled client never blocks the adapter — dropped chunks
		// are recoverable through the buffer's ring on reattach.
		select {
		case pumpCh <- c:
		default:
		}
	})
	// Out-of-band injections (currently: the /v1/sessions/:id/btw POST
	// handler) fan into the same pipeline through this sink. Mirrors
	// the direct-API path's RegisterEmitSink call — without it the
	// btw chunk would only land in Buffer.Append and skip the live
	// POST writer + blockAccum persistence.
	//
	// Lifetime: tied to the adapter, NOT the HTTP handler. The handler
	// returns as soon as _end reaches the FE (earlyEnd path) or the
	// client disconnects (ctx.Done path), but the adapter — and its
	// live-stdin sink in claude-binary — keeps running detached so
	// follow-up turns are still possible. Unregistering at handler-
	// return broke that symmetry: a #btw arriving after the first
	// turn's _end was accepted by live-stdin (model saw it) but found
	// no emit sink, so it skipped blockAccum and never landed as a
	// persisted btw block (and never broadcast to reattach
	// subscribers). The post-adapter cleanup goroutines below (and
	// the inline-completion tail) call UnregisterEmitSink at the
	// moment the adapter actually finishes.
	if sessionID != "" {
		RegisterEmitSink(sessionID, EmitSink(emit), "harness")
	}

	// postFinalize fires the buffer ScheduleFinalize + cost-event +
	// auto-title + chat-history persistence. Called either inline
	// (adapter returned without emitting _end) or from the detached
	// cleanup goroutine after the handler has already returned to the
	// FE.
	postFinalize := func() {
		if sessionID != "" {
			sessionBuffer.ScheduleFinalize(sessionID)
		}
		finalizeMu.Lock()
		fp := finalizeFP
		hadFinal := gotFinal
		finalizeMu.Unlock()

		modelName := req.Model
		providerName := req.Provider
		if hadFinal {
			if fp.Model != "" {
				modelName = fp.Model
			}
			if fp.Provider != "" {
				providerName = fp.Provider
			}
		}

		// Audit log — output side. Same shape as Node's
		// `logRaw('model', 'out', ...)` so api-inout-log entries from
		// Go and Node remain grep-compatible.
		if deps.RawLog != nil {
			textMu.Lock()
			assistantSnap := assistantText.String()
			textMu.Unlock()
			fmt.Fprintf(os.Stderr, "{\"trace\":\"route_harness.postFinalize\",\"stage\":\"audit-write\",\"fields\":{\"label\":%q,\"hadFinal\":%t,\"input\":%d,\"output\":%d,\"cost\":%g,\"stopReason\":%q,\"sessionId\":%q}}\n",
				label, hadFinal, fp.InputTokens, fp.OutputTokens, fp.Cost, fp.StopReason, sessionID)
			deps.RawLog.Write("model", "out", map[string]any{
				"text":         assistantSnap,
				"stopReason":   fp.StopReason,
				"inputTokens":  fp.InputTokens,
				"outputTokens": fp.OutputTokens,
				"cost":         fp.Cost,
			}, map[string]any{
				"route":     "/v1/stream-direct/",
				"harness":   label,
				"provider":  providerName,
				"sessionId": sessionID,
			})
		}
		// Persist the assistant reply at finalize. The user prompt
		// already landed synchronously at the top of the handler (see
		// the pre-stream persist block) so a switch-away mid-stream
		// can't lose it. The shared persistFinal helper is idempotent
		// via the finalPersisted CAS — if the emit closure already
		// fired its synchronous pre-_end persist this is a no-op,
		// otherwise (no _end was ever observed: error path, adapter
		// returned without emitting one) we fire it now in a
		// goroutine so postFinalize's tail doesn't block the handler.
		go persistFinal(fp, hadFinal)

		if deps.CostEvents != nil && sessionID != "" {
			toolEventsMu.Lock()
			toolsSnap := make([]ToolEventRecord, len(toolEvents))
			copy(toolsSnap, toolEvents)
			toolEventsMu.Unlock()
			payload := CostEventPayload{
				SessionID:           sessionID,
				Model:               modelName,
				Provider:            providerName,
				InputTokens:         fp.InputTokens,
				OutputTokens:        fp.OutputTokens,
				CacheReadTokens:     fp.CacheReadTokens,
				CacheCreationTokens: fp.CacheCreationTokens,
				Cost:                fp.Cost,
				ToolCallCount:       int(toolCallCount.Load()),
				DurationMs:          time.Since(turnStart).Milliseconds(),
				Tools:               toolsSnap,
			}
			deps.CostEvents.FireAndForget("cost-event:harness:"+label, func(ctx context.Context) error {
				return deps.CostEvents.Record(ctx, payload)
			})
			deps.CostEvents.FireAndForget("auto-title:harness:"+label, func(ctx context.Context) error {
				return deps.CostEvents.EnqueueAutoTitle(ctx, sessionID)
			})
		}
	}

	// Detach the adapter's lifetime from the HTTP request context.
	// Pre-Phase-7 Node kept streams running in activeStreams independent
	// of any single HTTP connection — switching tabs / sessions didn't
	// cancel the in-flight model call, and the FE could reattach via
	// GET /v1/sessions/:id/stream to pick the response back up. Tying
	// the adapter to r.Context() killed multi-tasking: as soon as the
	// user switched away from a session, the request closed, the
	// context cancelled, and the subprocess / direct call aborted
	// mid-response. Use a fresh, non-deadlined context so the adapter
	// completes regardless of who's currently watching. responseDone
	// gates the HTTP writer separately so we stop pushing bytes into a
	// closed socket while the adapter keeps feeding the reattach buffer.
	//
	// Why no deadline: tool-heavy turns regularly stream for 15-60+ min
	// (long-running shell tools, deep agent runs, model thinking hard,
	// especially OpenAI o-series reasoning models whose first token or
	// full CoT can take a long time). A previous 10-min hard cap killed
	// live conversations mid-stream — the user saw "stopped instantly"
	// at exactly the 10-min mark, disk had no clean finalize,
	// tokens/stopReason both zero. Pre-Phase-7 Node had no such ceiling;
	// matching that behaviour.
	// The runaway-process guards we DO keep:
	//   - POST /v1/stop/:sid → adapterCancel via the kill switch
	//   - Node's 60 min sweeper (LIVE_MSG_MAX_DURATION_MS) injects a
	//     kind=timeout interrupt and also fires /v1/stop to abort the
	//     adapter goroutine promptly.
	//   - The subprocess exec.Cmd is bound to the user's session;
	//     orphans are GC'd by the OS when the parent dies.
	adapterCtx, adapterCancel := context.WithCancel(context.Background())
	// Kill-switch registration. POST /v1/stop/:sid calls
	// StopRegistry.Stop(sid) → adapterCancel fires → the adapter's
	// upstream call / subprocess context unwinds. Mirrors Node's
	// activeProcesses Map populated by codex.ts / claude-stream.ts.
	if deps.ActiveStops != nil && sessionID != "" {
		deps.ActiveStops.Register(sessionID, adapterCancel)
	}
	// Audit log — input side. Captures the FE-supplied prompt and
	// the harness label so a botched turn can be traced from
	// bridge/api-inout-log/. Output side fires from postFinalize.
	if deps.RawLog != nil {
		deps.RawLog.Write("model", "in", map[string]any{
			"model":        req.Model,
			"input":        req.Input,
			"preset":       req.Preset,
			"systemMode":   req.SystemMode,
			"effort":       req.Effort,
			"allowedTools": req.AllowedTools,
			"images":       len(req.ImageBlocks),
			"skills":       len(req.Skills),
		}, map[string]any{
			"route":     "/v1/stream-direct/",
			"harness":   label,
			"provider":  req.Provider,
			"sessionId": sessionID,
		})
	}

	// Writer pump. Drains pumpCh + emits heartbeats every 10 s +
	// writes to the response writer; exits on _end / write fail /
	// r.Context cancellation. A slow tunneled FE can stall this pump
	// without affecting the adapter or reattach subscribers — the
	// adapter keeps Appending into the ring buffer, reattach listeners
	// drain through their own Subscribe channels.
	go func() {
		defer close(pumpDone)
		streamChunksToClient(r.Context(), w, flusher, pumpCh, nil)
	}()

	// Periodic live-message checkpoint. Mirrors Node's debounced
	// updateLiveMsg — every 2 s we POST the current accumulated text
	// + blocks against the open placeholder so a daemon crash / OOM /
	// hard kill leaves the partial reply on disk for the FE to render
	// on reload. The first content chunk in the emit closure above
	// opens the placeholder; this loop runs until the adapter actually
	// completes — NOT just until the HTTP handler returns — so a tab
	// switch / ctx.Done doesn't freeze the disk snapshot at the
	// switch-away moment. The detached postFinalize goroutine calls
	// stopLiveCheckpoint immediately before its `phase:"final"` write
	// so the streaming-placeholder is finalised before the loop dies.
	liveCheckpointStop := make(chan struct{})
	var liveCheckpointOnce sync.Once
	stopLiveCheckpoint := func() {
		liveCheckpointOnce.Do(func() { close(liveCheckpointStop) })
	}
	go func() {
		ticker := time.NewTicker(2 * time.Second)
		defer ticker.Stop()
		var lastCheckpointAt time.Time
		lastCheckpointLen := 0
		var lastBlockCheckpointAt time.Time
		lastBlockApproxLen := 0
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
				blocks := blockAccum.Blocks()
				textMu.Unlock()

				// Snapshot current live counters (from the same atomics the 1s
				// meta ticker uses) so the persisted live placeholder carries
				// last-known meta. This makes the bar on switch/reload have
				// real values sourced from core even if the activity SSE or
				// first post-reattach _live hasn't arrived yet.
				inC := int(liveInputTok.Load())
				outC := int(liveOutputTok.Load())
				crC := int(liveCacheRead.Load())
				ccC := int(liveCacheCreate.Load())
				tcC := int(toolCallCount.Load())
				acC := int(apiCallCount.Load())

				// Once the turn has produced any non-text block (tool call,
				// thinking, …) the checkpoint MUST carry the full blocks array,
				// not just flat text. A text-only update deletes entry.blocks on
				// the bridge, and — critically — if the turn never reaches a clean
				// _end (e.g. a long codex/grok agent run that outlives the bridge's
				// 60-min live-msg ceiling and gets force-finalized by
				// sweepExpiredLiveMsgs) the placeholder is finalized from whatever
				// the last checkpoint left behind. A text-only checkpoint there
				// drops the entire tool transcript — exactly the "long answer with
				// tool calls disappears ~an hour later" bug. Blocks are heavier
				// than text, so they ride a size-scaled cadence (shouldLiveCheckpoint
				// keyed off the approx serialized length) instead of the fast 2s
				// flat-text path. The clean-finalize write still ships the complete
				// transcript; this just makes the *partial* durable too.
				if blocksHaveStructure(blocks) {
					approxLen := blocksApproxLen(blocks)
					if !shouldLiveCheckpoint(time.Now(), approxLen, &lastBlockCheckpointAt, &lastBlockApproxLen) {
						continue
					}
					pctx, pcancel := context.WithTimeout(context.Background(), 10*time.Second)
					if err := deps.PersistMessage.Persist(pctx, PersistMessagePayload{
						SessionID:     sessionID,
						Role:          "assistant",
						Phase:         "update",
						LiveToken:     tok,
						Text:          txt,
						Blocks:        blocks,
						InputTokens:   inC + crC + ccC,
						OutputTokens:  outC,
						ToolCallCount: tcC,
						APICallCount:  acC,
						TurnStartMs:   turnStart.UnixMilli(),
						Model:         req.Model,
					}); err != nil {
						deps.Logger.Warn("stream.persist.live-update-blocks", "session", sessionID, "err", err)
					}
					pcancel()
					continue
				}

				// Pure-text reply so far (no tool calls): keep the cheap,
				// frequent flat-text checkpoint for crash recovery.
				if strings.TrimSpace(txt) == "" {
					continue
				}
				if !shouldLiveCheckpoint(time.Now(), len(txt), &lastCheckpointAt, &lastCheckpointLen) {
					continue
				}
				pctx, pcancel := context.WithTimeout(context.Background(), 5*time.Second)
				if err := deps.PersistMessage.Persist(pctx, PersistMessagePayload{
					SessionID:     sessionID,
					Role:          "assistant",
					Phase:         "update",
					LiveToken:     tok,
					Text:          txt,
					InputTokens:   inC + crC + ccC,
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
	// Ownership of stopLiveCheckpoint is handed off explicitly: the
	// inline-completion path stops it just before its synchronous
	// postFinalize, and each detached-goroutine branch (earlyEnd /
	// ctx.Done) stops it just before its detached postFinalize. We do
	// NOT defer-close at handler exit — that would kill the checkpoint
	// the instant a tab switch fires ctx.Done, freezing the disk
	// snapshot at the switch-away moment while the adapter is still
	// running detached for minutes. The sync.Once above keeps the
	// hand-offs idempotent against panics or future refactor mistakes.

	// Live-meta ticker. The native-provider route (route.go) emits `_live`
	// frames from its own per-turn ticker so the FE paints a "busy" meta
	// bar (model + elapsed clock + tokens + tool count) from the turn's
	// START. The harness adapters had no such ticker, so claude-binary /
	// codex / … turns showed nothing live — the bar only appeared on the
	// terminal `_end`. This mirrors route.go's ticker: every ~1s it
	//   1. publishes the in-flight counters to the process-global live
	//      registry (livemeta.go) so GET /v1/activity/stream sees this
	//      session as busy, and
	//   2. pushes a `_live` Chunk straight to pumpCh (non-blocking, like
	//      the heartbeat) for the attached tab.
	// Elapsed time is the client's own clock off TurnStartMs; tokens come
	// from the running atomics the emit closure stashes off in-flight
	// chunks. Lifetime mirrors the live-checkpoint loop: stopped via the
	// sync.Once at the same three terminal points (earlyEnd / ctx.Done
	// detached goroutines + the inline-completion tail), NOT at handler
	// return, so a tab switch doesn't drop the session from the feed
	// while the adapter keeps running detached.
	RegisterLiveMeta(sessionID, req.Model, turnStart.UnixMilli())
	liveMetaStop := make(chan struct{})
	var liveMetaOnce sync.Once
	stopLiveMeta := func() {
		liveMetaOnce.Do(func() {
			close(liveMetaStop)
			UnregisterLiveMeta(sessionID)
		})
	}
	go func() {
		ticker := time.NewTicker(1 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-liveMetaStop:
				return
			case <-ticker.C:
				in := int(liveInputTok.Load())
				out := int(liveOutputTok.Load())
				cr := int(liveCacheRead.Load())
				cc := int(liveCacheCreate.Load())
				tc := int(toolCallCount.Load())
				ac := int(apiCallCount.Load())
				// For harnesses that only surface usage at turn end (grok, codex and
				// similar subscription CLIs), backfill a running output estimate from
				// streamed assistant text length. This makes the activity-feed busy
				// bar (used for switched-into / reloaded sessions) show plausible
				// climbing token counts instead of hard 0/0 while live — matching
				// the attached tab's own totalChars/4 est in the _live handler.
				if out == 0 && (label == "grok" || label == "codex") {
					textMu.Lock()
					olen := assistantText.Len()
					textMu.Unlock()
					if olen > 0 {
						out = int(int64(olen) / 4)
						if out < 1 {
							out = 1
						}
					}
				}
				// The activity feed (GET /v1/activity/stream → React MessageList)
				// reads LiveSnapshot directly and cannot fold cache tokens: the
				// struct carries no cache fields. Pre-fold cacheRead+cacheCreation
				// into InputTokens here so the switched-into / reloaded busy bar
				// shows the true prompt size, not the bare uncached delta (~2 under
				// prompt caching). Matches the attached tab (which folds the same
				// three counts FE-side, chat-streaming `_live`) and the `_end` /
				// persist path. The `_live` Chunk below keeps the counts disjoint,
				// so the attached tab's own fold does not double-count.
				UpdateLiveMeta(LiveSnapshot{
					SessionID:     sessionID,
					Status:        "streaming",
					Model:         req.Model,
					InputTokens:   in + cr + cc,
					OutputTokens:  out,
					ToolCallCount: tc,
					APICallCount:  ac,
					TurnStartMs:   turnStart.UnixMilli(),
				})
				select {
				case pumpCh <- Chunk{
					Live:                true,
					Model:               req.Model,
					InputTokens:         in,
					OutputTokens:        out,
					CacheReadTokens:     cr,
					CacheCreationTokens: cc,
					ToolCallCount:       tc,
					APICallCount:        ac,
				}:
				default:
				}
			}
		}
	}()

	adapterDone := make(chan error, 1)
	go func() {
		// Guaranteed busy-state cleanup the instant the adapter returns —
		// on normal completion, error, or panic — without waiting on the
		// three terminal handlers below (each of which gates stopLiveMeta
		// on <-adapterDone). stopLiveMeta is a sync.Once, so the terminal
		// handlers' own calls stay harmless no-ops. This does NOT cover a
		// wedged adapter that never returns (bridge crash leaving the
		// upstream read blocked) — that case is reaped by the livemeta TTL.
		defer stopLiveMeta()
		err := adapter(adapterCtx, req, body, emit, finalize)
		adapterDone <- err
		adapterCancel()
		if deps.ActiveStops != nil && sessionID != "" {
			deps.ActiveStops.Drop(sessionID)
		}
	}()
	var err error
	earlyEnd := false
	select {
	case err = <-adapterDone:
		// Adapter finished before / without emitting an _end. We'll
		// synthesise one below if needed and let the pump drain it.
	case <-endCh:
		// _end seen on the wire. Hand the rest of the adapter's
		// lifetime over to a detached goroutine so cost-event
		// recording + buffer scheduling still happen on real
		// completion. The pump will deliver the _end chunk to the FE
		// and then return on its own (streamChunksToClient exits when
		// it sees End:true). We wait briefly for the pump to drain
		// before letting the handler return so the FE actually sees
		// the terminal chunk before the TCP close.
		earlyEnd = true
		go func() {
			adapterErr := <-adapterDone
			if adapterErr != nil && !errors.Is(adapterErr, context.Canceled) {
				deps.Logger.Warn("stream.harness-adapter.error-after-end",
					"label", label, "err", adapterErr)
			}
			if sessionID != "" {
				UnregisterEmitSink(sessionID)
			}
			stopLiveCheckpoint()
			stopLiveMeta()
			postFinalize()
		}()
	case <-r.Context().Done():
		// Client disconnected mid-stream (tab switch, browser close).
		// The adapter has its own detached context, so it keeps
		// running and the reattach buffer keeps capturing chunks. The
		// pump already exited on its own ctx.Done. Hand the rest of
		// the adapter's lifetime over to a detached cleanup goroutine.
		// The 2-s live-checkpoint loop keeps running inside that
		// goroutine so the disk snapshot stays fresh while the user
		// is elsewhere; stopLiveCheckpoint fires only when the
		// adapter actually finishes, just before postFinalize.
		earlyEnd = true
		go func() {
			adapterErr := <-adapterDone
			if adapterErr != nil && !errors.Is(adapterErr, context.Canceled) {
				deps.Logger.Warn("stream.harness-adapter.error-after-disconnect",
					"label", label, "err", adapterErr)
			}
			if sessionID != "" {
				UnregisterEmitSink(sessionID)
			}
			stopLiveCheckpoint()
			stopLiveMeta()
			postFinalize()
		}()
	}
	if earlyEnd {
		// Give the pump up to 2 s to drain the terminal chunk before
		// the handler returns and the underlying TCP gets torn down.
		// On the ctx.Done branch the pump already exited; the select
		// fall-through here is essentially a no-op.
		select {
		case <-pumpDone:
		case <-time.After(2 * time.Second):
		}
		return
	}
	if err != nil && !errors.Is(err, context.Canceled) {
		deps.Logger.Warn("stream.harness-adapter.error", "label", label, "err", err)
		// Surface as an error chunk so the FE renders it. We can't
		// switch to a non-200 status now because headers already
		// flushed.
		errChunk := Chunk{Type: ChunkTypeError, Error: err.Error()}
		emit(errChunk)
	}
	// Terminal _end chunk for adapters that didn't emit their own
	// (codex, hermes, claude-sdk, broadcast). Mirrors Node's endChunk
	// shape (bridge/sessions-internal/streams.ts:320-333).
	if !endEmitted.Load() {
		finalizeMu.Lock()
		endFP := finalizeFP
		hadFinal := gotFinal
		finalizeMu.Unlock()
		endChunk := Chunk{Type: ChunkTypeDone, End: true, Model: req.Model}
		if err != nil {
			endChunk.Error = err.Error()
		} else if hadFinal {
			if endFP.Model != "" {
				endChunk.Model = endFP.Model
			}
			endChunk.StopReason = endFP.StopReason
			if endChunk.StopReason == "" {
				endChunk.StopReason = "end_turn"
			}
			endChunk.InputTokens = endFP.InputTokens
			endChunk.OutputTokens = endFP.OutputTokens
			endChunk.CacheReadTokens = endFP.CacheReadTokens
			endChunk.CacheCreationTokens = endFP.CacheCreationTokens
			endChunk.Cost = endFP.Cost
			// Harness adapters may not have a cost (claude-binary
			// subscription is free at the bridge; codex returns its
			// own number). Fall back to the configured pricing table
			// when the adapter didn't supply one.
			if endChunk.Cost == 0 && deps.ModelPricing != nil {
				if pi, po, ok := deps.ModelPricing(req.Model); ok {
					endChunk.Cost = (float64(endFP.InputTokens)*pi + float64(endFP.OutputTokens)*po) / 1_000_000.0
				}
			}
			endChunk.DurationMs = time.Since(turnStart).Milliseconds()
			endChunk.ToolCallCount = int(toolCallCount.Load())
			endChunk.APICallCount = int(apiCallCount.Load())
			if endChunk.DurationMs > 500 && endFP.OutputTokens > 0 {
				endChunk.TokensPerSec = int(float64(endFP.OutputTokens) / (float64(endChunk.DurationMs) / 1000.0))
			}
		} else {
			endChunk.StopReason = "end_turn"
			endChunk.DurationMs = time.Since(turnStart).Milliseconds()
			endChunk.ToolCallCount = int(toolCallCount.Load())
			endChunk.APICallCount = int(apiCallCount.Load())
		}
		emit(endChunk)
	}
	// Inline (synchronous) completion path. Stop the 2-s update loop
	// before postFinalize so the streaming-placeholder is flipped to
	// phase:"final" without a stale update racing in after it.
	if sessionID != "" {
		UnregisterEmitSink(sessionID)
	}
	stopLiveCheckpoint()
	stopLiveMeta()
	postFinalize()
	// Wait for the pump to drain the terminal chunk before letting the
	// handler return — otherwise the TCP close races the final write
	// and the FE may not see the `_end` (it would stay in "running"
	// state until the silence-watchdog reconnects). 2 s ceiling
	// matches the earlyEnd drain timeout above.
	select {
	case <-pumpDone:
	case <-time.After(2 * time.Second):
	}
}
