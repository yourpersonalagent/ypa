package stream

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestClassifyRouteDirectAnthropic(t *testing.T) {
	req := &streamRequest{Model: "claude-opus-4-7"}
	keyFor := func(p string) string {
		if p == "anthropic" {
			return "sk-test"
		}
		return ""
	}
	d := classifyRoute(req, keyFor)
	if !d.Direct {
		t.Errorf("expected Direct=true, got %+v", d)
	}
}

func TestClassifyRouteDirectOpenAI(t *testing.T) {
	req := &streamRequest{Model: "gpt-4o"}
	keyFor := func(p string) string {
		if p == "openai" {
			return "sk-test"
		}
		return ""
	}
	d := classifyRoute(req, keyFor)
	if !d.Direct {
		t.Errorf("expected Direct=true, got %+v", d)
	}
}

func TestClassifyRouteDirectGemini(t *testing.T) {
	req := &streamRequest{Model: "gemini-2-pro"}
	keyFor := func(p string) string {
		if p == "gemini" {
			return "AIza-test"
		}
		return ""
	}
	d := classifyRoute(req, keyFor)
	if !d.Direct {
		t.Errorf("expected Direct=true, got %+v", d)
	}
}

func TestClassifyRouteCodexProxy(t *testing.T) {
	req := &streamRequest{Model: "codex/gpt-5"}
	keyFor := func(string) string { return "sk-test" } // even with a key
	d := classifyRoute(req, keyFor)
	if d.Direct {
		t.Errorf("expected Direct=false for codex/*, got %+v", d)
	}
	if !strings.Contains(d.Reason, "codex") {
		t.Errorf("reason should mention codex: %q", d.Reason)
	}
}

func TestClassifyRouteHarnessInstanceProxy(t *testing.T) {
	req := &streamRequest{Model: "claude-opus-4-7", HarnessInstance: "instance-1"}
	keyFor := func(p string) string {
		if p == "anthropic" {
			return "sk-test"
		}
		return ""
	}
	d := classifyRoute(req, keyFor)
	if d.Direct {
		t.Errorf("expected Direct=false when HarnessInstance set, got %+v", d)
	}
}

// CodexInstance is now gated on the model id (codex/*). Setting it
// alongside a non-codex model (gpt-4o) is a stale-FE-state signal —
// the request stays on the direct OpenAI path so a leftover global
// codexInstance can't drag every subsequent third-party turn onto
// the buffering codex CLI.
func TestClassifyRouteCodexInstanceGatedOnModel(t *testing.T) {
	keyFor := func(string) string { return "sk-test" }

	// codex/* model + CodexInstance → harness (correct).
	d := classifyRoute(&streamRequest{Model: "codex/gpt-5", CodexInstance: "cdx-1"}, keyFor)
	if d.Direct {
		t.Errorf("codex/* model with CodexInstance should be non-direct, got %+v", d)
	}

	// Non-codex model + CodexInstance → still direct OpenAI.
	d = classifyRoute(&streamRequest{Model: "gpt-4o", CodexInstance: "cdx-1"}, keyFor)
	if !d.Direct {
		t.Errorf("gpt-4o with stale CodexInstance should stay direct, got %+v", d)
	}
}

// HarnessInstance is now gated on the model id (claude-*). Setting it
// alongside a non-Claude model is a stale-FE-state signal — the
// request stays on its right direct path. Mirrors the production
// fix: Gemini/DeepSeek/NVIDIA turns no longer route through
// claude-binary just because harnessInstance is left over from a
// prior Claude subscription chat.
func TestClassifyRouteHarnessInstanceGatedOnModel(t *testing.T) {
	keyFor := func(p string) string {
		switch p {
		case "gemini":
			return "sk-gemini"
		case "openai":
			return "sk-openai"
		}
		return ""
	}
	d := classifyRoute(&streamRequest{Model: "gemini-2.0-flash", HarnessInstance: "sub2"}, keyFor)
	if !d.Direct {
		t.Errorf("gemini model with stale HarnessInstance should stay direct, got %+v", d)
	}
}

func TestPickHarnessAdapterCodexModelOptIn(t *testing.T) {
	t.Setenv("YHA_GO_CODEX", "1")
	want := HarnessAdapterFn(func(context.Context, HarnessAdapterRequest, []byte, EmitFn, HarnessFinalizeFn) error { return nil })
	got, label := pickHarnessAdapter(map[string]HarnessAdapterFn{"codex": want}, &streamRequest{Model: "codex/gpt-5"}, ParticipantRouteContext{})
	if got == nil || label != "codex" {
		t.Fatalf("expected codex adapter, got label=%q nil=%v", label, got == nil)
	}
}

// CodexInstance ALONE no longer routes to the codex adapter. The FE
// stores codexInstance globally, so a stale value would otherwise drag
// every subsequent non-codex turn (DeepSeek, OpenRouter, …) onto the
// codex CLI. Codex routing now requires either model "codex/*" or
// Provider="OpenAI-SUB*" (handled in TestPickHarnessAdapterCodexFromOpenAISubProvider).
func TestPickHarnessAdapterCodexInstanceAloneDoesNotRoute(t *testing.T) {
	t.Setenv("YHA_GO_CODEX", "1")
	want := HarnessAdapterFn(func(context.Context, HarnessAdapterRequest, []byte, EmitFn, HarnessFinalizeFn) error { return nil })
	got, label := pickHarnessAdapter(map[string]HarnessAdapterFn{"codex": want}, &streamRequest{Model: "gpt-4o", CodexInstance: "acct-1"}, ParticipantRouteContext{})
	if got != nil || label != "" {
		t.Fatalf("expected no adapter for CodexInstance alone, got label=%q nil=%v", label, got == nil)
	}
}

// codex/* model prefix is the single model-side signal that pins this
// turn to the codex adapter regardless of subscription state.
func TestPickHarnessAdapterCodexModelPrefix(t *testing.T) {
	t.Setenv("YHA_GO_CODEX", "1")
	want := HarnessAdapterFn(func(context.Context, HarnessAdapterRequest, []byte, EmitFn, HarnessFinalizeFn) error { return nil })
	got, label := pickHarnessAdapter(map[string]HarnessAdapterFn{"codex": want}, &streamRequest{Model: "codex/gpt-5"}, ParticipantRouteContext{})
	if got == nil || label != "codex" {
		t.Fatalf("expected codex adapter for codex/* model, got label=%q nil=%v", label, got == nil)
	}
}

// OpenAI-SUB* provider routes to codex via the subscription path,
// regardless of model id. Mirrors the production fix where a stale FE
// codexInstance for one account must NOT override the SUB-resolved
// account.
func TestPickHarnessAdapterCodexFromOpenAISubProvider(t *testing.T) {
	t.Setenv("YHA_GO_CODEX", "1")
	want := HarnessAdapterFn(func(context.Context, HarnessAdapterRequest, []byte, EmitFn, HarnessFinalizeFn) error { return nil })
	got, label := pickHarnessAdapter(map[string]HarnessAdapterFn{"codex": want}, &streamRequest{Model: "gpt-5-codex", Provider: "OpenAI-SUB2"}, ParticipantRouteContext{})
	if got == nil || label != "codex" {
		t.Fatalf("expected codex adapter for OpenAI-SUB2 provider, got label=%q nil=%v", label, got == nil)
	}
}

// Anthropic-SUB* provider routes to claude-binary even when a stale
// codexInstance is also set in the request. Regression test for the
// "Claude subscription model crashed on Codex" bug.
func TestPickHarnessAdapterClaudeSubBeatsCodexInstance(t *testing.T) {
	want := HarnessAdapterFn(func(context.Context, HarnessAdapterRequest, []byte, EmitFn, HarnessFinalizeFn) error { return nil })
	got, label := pickHarnessAdapter(map[string]HarnessAdapterFn{
		"claude-binary": want,
		"codex":         want,
	}, &streamRequest{Model: "claude-opus-4-7", Provider: "Anthropic-SUB2", CodexInstance: "alt-1"}, ParticipantRouteContext{})
	if got == nil || label != "claude-binary" {
		t.Fatalf("expected claude-binary for Anthropic-SUB2 (even with stale CodexInstance), got label=%q", label)
	}
}

func TestPickHarnessAdapterClaudeBinaryFromHarnessInstance(t *testing.T) {
	t.Setenv("YHA_GO_CLAUDE_BINARY", "1")
	want := HarnessAdapterFn(func(context.Context, HarnessAdapterRequest, []byte, EmitFn, HarnessFinalizeFn) error { return nil })
	got, label := pickHarnessAdapter(map[string]HarnessAdapterFn{"claude-binary": want}, &streamRequest{
		Model:           "claude-opus-4-7",
		HarnessInstance: "alt-1",
	}, ParticipantRouteContext{})
	if got == nil || label != "claude-binary" {
		t.Fatalf("expected claude-binary adapter, got label=%q nil=%v", label, got == nil)
	}
}

func TestPickHarnessAdapterDisabledWhenEnvOff(t *testing.T) {
	// Phase 6g flipped the gate to opt-OUT. The "no adapter" outcome
	// now requires explicit YHA_GO_<UPPER>=0 on every registered
	// label that could match this request.
	t.Setenv("YHA_GO_CODEX", "0")
	t.Setenv("YHA_GO_CLAUDE_BINARY", "0")
	got, label := pickHarnessAdapter(map[string]HarnessAdapterFn{
		"codex":         func(context.Context, HarnessAdapterRequest, []byte, EmitFn, HarnessFinalizeFn) error { return nil },
		"claude-binary": func(context.Context, HarnessAdapterRequest, []byte, EmitFn, HarnessFinalizeFn) error { return nil },
	}, &streamRequest{
		Model:           "codex/gpt-5",
		HarnessInstance: "alt-1",
		CodexInstance:   "acct-1",
	}, ParticipantRouteContext{})
	if got != nil || label != "" {
		t.Fatalf("expected no adapter when env flags are explicitly off, got label=%q", label)
	}
}

func TestPickHarnessAdapterOpenClawFromParticipantContext(t *testing.T) {
	t.Setenv("YHA_GO_OPENCLAW", "1")
	want := HarnessAdapterFn(func(context.Context, HarnessAdapterRequest, []byte, EmitFn, HarnessFinalizeFn) error { return nil })
	got, label := pickHarnessAdapter(map[string]HarnessAdapterFn{"openclaw": want}, &streamRequest{Model: "claude-opus-4-7"}, ParticipantRouteContext{
		HasParticipants: true,
		Target: &ParticipantTarget{
			ID:          "oc-1",
			Name:        "Claw",
			PartnerType: "openclaw",
			PartnerID:   "oc-1",
		},
	})
	if got == nil || label != "openclaw" {
		t.Fatalf("expected openclaw adapter, got label=%q nil=%v", label, got == nil)
	}
}

func TestClassifyRouteClaudeSubscriptionProxy(t *testing.T) {
	for _, hint := range []string{"Anthropic-SUB", "Anthropic-SUB2", "Anthropic Subscription"} {
		req := &streamRequest{Model: "claude-opus-4-7", Provider: hint}
		keyFor := func(p string) string {
			if p == "anthropic" {
				return "sk-test"
			}
			return ""
		}
		d := classifyRoute(req, keyFor)
		if d.Direct {
			t.Errorf("hint %q: expected Direct=false, got %+v", hint, d)
		}
	}
}

func TestClassifyRouteCodexSubscriptionProxy(t *testing.T) {
	for _, hint := range []string{"OpenAI-SUB", "OpenAI-SUB3", "OpenAI Subscription"} {
		req := &streamRequest{Model: "gpt-4o", Provider: hint}
		keyFor := func(string) string { return "sk-test" }
		d := classifyRoute(req, keyFor)
		if d.Direct {
			t.Errorf("hint %q: expected Direct=false, got %+v", hint, d)
		}
	}
}

func TestClassifyRouteDirectWithAnthropicHint(t *testing.T) {
	// "Anthropic" / "Anthropic API" both mean API-billed — direct path.
	for _, hint := range []string{"", "Anthropic", "Anthropic API"} {
		req := &streamRequest{Model: "claude-opus-4-7", Provider: hint}
		keyFor := func(p string) string {
			if p == "anthropic" {
				return "sk-test"
			}
			return ""
		}
		d := classifyRoute(req, keyFor)
		if !d.Direct {
			t.Errorf("hint %q: expected Direct=true, got %+v", hint, d)
		}
	}
}

func TestClassifyRouteOtherProviderHintProxy(t *testing.T) {
	// A non-Anthropic provider hint on a Claude model means "use that
	// other provider's stack". We proxy — Node knows about other
	// providers' subscription flows.
	req := &streamRequest{Model: "claude-opus-4-7", Provider: "Cerebras"}
	keyFor := func(string) string { return "sk-test" }
	d := classifyRoute(req, keyFor)
	if d.Direct {
		t.Errorf("expected Direct=false with non-API provider hint, got %+v", d)
	}
}

func TestClassifyRouteNoAPIKeyProxy(t *testing.T) {
	req := &streamRequest{Model: "claude-opus-4-7"}
	keyFor := func(string) string { return "" } // no key configured
	d := classifyRoute(req, keyFor)
	if d.Direct {
		t.Errorf("expected Direct=false without api key, got %+v", d)
	}
}

func TestClassifyRouteUnknownModelProxy(t *testing.T) {
	req := &streamRequest{Model: "llama-3-70b"}
	keyFor := func(string) string { return "sk-test" }
	d := classifyRoute(req, keyFor)
	if d.Direct {
		t.Errorf("expected Direct=false for unknown model, got %+v", d)
	}
}

func TestClassifyRouteBroadcastInputProxy(t *testing.T) {
	req := &streamRequest{
		Model: "claude-opus-4-7",
		Input: "@assistant-bot help me debug this",
	}
	keyFor := func(p string) string {
		if p == "anthropic" {
			return "sk-test"
		}
		return ""
	}
	d := classifyRoute(req, keyFor)
	if d.Direct {
		t.Errorf("expected Direct=false for @-mention input, got %+v", d)
	}
}

func TestIsBroadcastInputEdgeCases(t *testing.T) {
	cases := map[string]bool{
		"@bot hi":    true,
		"   @bot hi": true,  // leading whitespace
		"@ bot hi":   false, // space after @
		"  @\t":      false, // tab after @
		"":           false,
		"@":          false,
		"hello @bot": false, // not at start
		"@b":         true,  // single char OK
	}
	for in, want := range cases {
		if got := isBroadcastInput(in); got != want {
			t.Errorf("isBroadcastInput(%q) = %v, want %v", in, got, want)
		}
	}
}

// ── No-adapter fallthrough tests (Phase 7) ─────────────────────────────────
//
// Phase 7 deleted the Node /v1/stream/ POST route and the matching Go
// reverse-proxy. Non-direct requests must now be claimed by one of the
// in-process harness adapters (claude-binary / codex / openclaw /
// hermes / broadcast). If every adapter is disabled or none is wired,
// the route returns 502 with a canonical error message — these tests
// exercise that contract.

const phase7NoAdapterMsg = "no harness adapter available for request — Node /v1/stream/ has been removed in Phase 7"

// TestRouteReturns502WhenNoAdapterClaimsCodex verifies that a codex/*
// model with no codex adapter registered + no api key returns the
// Phase 7 502, not a hang or 503.
func TestRouteReturns502WhenNoAdapterClaimsCodex(t *testing.T) {
	srv := newRouteServer(t, RouteDeps{
		APIKeyFor: func(string) string { return "sk-test" },
		// No HarnessAdapters — codex/* has nowhere to go.
	})
	defer srv.Close()

	body := `{"model":"codex/gpt-5","input":"hi","SessionId":"sid-1"}`
	resp, err := http.Post(srv.URL+"/v1/stream-direct/", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", resp.StatusCode)
	}
	buf, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(buf), phase7NoAdapterMsg) {
		t.Errorf("body should contain Phase 7 error message: %s", buf)
	}
}

// TestRouteReturns502ForSubscriptionProviderWithoutAdapter is the
// post-Phase-7 counterpart to the old proxy-forwarding test: an
// Anthropic-SUB hint with no claude-binary adapter wired must surface
// the 502, not silently fall through to a missing Node endpoint.
func TestRouteReturns502ForSubscriptionProviderWithoutAdapter(t *testing.T) {
	srv := newRouteServer(t, RouteDeps{
		APIKeyFor: func(string) string { return "sk-test" },
		// No HarnessAdapters registered.
	})
	defer srv.Close()

	body := `{"model":"claude-opus-4-7","input":"hi","Provider":"Anthropic-SUB2","SessionId":"sid-1"}`
	resp, err := http.Post(srv.URL+"/v1/stream-direct/", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", resp.StatusCode)
	}
	buf, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(buf), phase7NoAdapterMsg) {
		t.Errorf("body should contain Phase 7 error message: %s", buf)
	}
}

// TestRouteReturns502ForUpperCaseHarnessBodyWithoutAdapter ensures the
// Pascal-cased FE body shape lands on the same 502 path when nothing
// claims it.
func TestRouteReturns502ForUpperCaseHarnessBodyWithoutAdapter(t *testing.T) {
	srv := newRouteServer(t, RouteDeps{
		APIKeyFor: func(string) string { return "" }, // no api key → non-direct
		// No HarnessAdapters registered.
	})
	defer srv.Close()

	// FE body — all Pascal-cased fields, harness-pinned.
	body := `{"Model":"claude-opus-4-7","Input":"hi","SessionId":"sid-1","HarnessInstance":"h1","Preset":"be helpful","Caps":{"vision":true}}`
	resp, err := http.Post(srv.URL+"/v1/stream-direct/", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", resp.StatusCode)
	}
	buf, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(buf), phase7NoAdapterMsg) {
		t.Errorf("body should contain Phase 7 error message: %s", buf)
	}
}

// TestRouteReturns400ForUnknownModel keeps the "unknown model" branch
// surfacing 400 rather than the generic 502 so an operator
// misconfigured-model error stays distinguishable from a missing
// adapter.
func TestRouteReturns400ForUnknownModel(t *testing.T) {
	srv := newRouteServer(t, RouteDeps{
		APIKeyFor: func(string) string { return "sk-test" },
	})
	defer srv.Close()

	body := `{"model":"llama-3-70b","input":"hi"}`
	resp, err := http.Post(srv.URL+"/v1/stream-direct/", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", resp.StatusCode)
	}
}

func TestRouteDispatchesCodexHarnessAdapterWhenOptedIn(t *testing.T) {
	t.Setenv("YHA_GO_CODEX", "1")

	var (
		called atomic.Bool
		gotReq atomic.Value
	)
	srv := newRouteServer(t, RouteDeps{
		APIKeyFor: func(string) string { return "sk-test" },
		HarnessAdapters: map[string]HarnessAdapterFn{
			"codex": func(_ context.Context, req HarnessAdapterRequest, _ []byte, emit EmitFn, finalize HarnessFinalizeFn) error {
				called.Store(true)
				gotReq.Store(req)
				emit(Chunk{Type: ChunkTypeDelta, Delta: "adapter"})
				finalize(HarnessFinalize{Model: req.Model, Provider: "openai"})
				return nil
			},
		},
	})
	defer srv.Close()

	body := `{"Model":"codex/gpt-5","Input":"hi","SessionId":"sid-1","AllowedTools":["Read"],"CodexInstance":"acct-1"}`
	resp, err := http.Post(srv.URL+"/v1/stream-direct/", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	if !called.Load() {
		t.Fatal("expected codex adapter to be called")
	}
	req := gotReq.Load().(HarnessAdapterRequest)
	if req.Model != "codex/gpt-5" || req.SessionID != "sid-1" || req.CodexInstance != "acct-1" {
		t.Fatalf("unexpected adapter request: %+v", req)
	}
	if len(req.AllowedTools) != 1 || req.AllowedTools[0] != "Read" {
		t.Fatalf("allowed tools not forwarded: %+v", req.AllowedTools)
	}
}

// ── Cost-event sink tests ──────────────────────────────────────────────────

// recordingSink captures calls into the CostEventSink for inspection.
// It implements all three interface methods directly against
// context.Context so it slots straight into RouteDeps.CostEvents.
type recordingSink struct {
	mu             sync.Mutex
	payloads       []CostEventPayload
	autoTitleCalls []string
	wg             sync.WaitGroup
}

func (s *recordingSink) Record(_ context.Context, p CostEventPayload) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.payloads = append(s.payloads, p)
	return nil
}
func (s *recordingSink) EnqueueAutoTitle(_ context.Context, sid string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.autoTitleCalls = append(s.autoTitleCalls, sid)
	return nil
}
func (s *recordingSink) FireAndForget(_ string, fn func(context.Context) error) {
	s.wg.Add(1)
	go func() {
		defer s.wg.Done()
		_ = fn(context.Background())
	}()
}
func (s *recordingSink) wgDone() <-chan struct{} {
	out := make(chan struct{})
	go func() {
		s.wg.Wait()
		close(out)
	}()
	return out
}

// TestRouteFinalizeHooksFire verifies that after a clean stream
// completes, the cost-event sink receives both Record and
// EnqueueAutoTitle calls with the right session id and accumulated
// tool call count.
func TestRouteFinalizeHooksFire(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(200)
	}))
	defer upstream.Close()

	scripted := &scriptedRouteProvider{
		endpoint: upstream.URL,
		responses: []scriptedResponse{
			{
				emit: []Chunk{
					{Type: ChunkTypeToolUse, ToolUse: &ToolUseChunk{ID: "t1", Name: "Bash"}},
				},
				done: true,
			},
		},
	}
	sink := &recordingSink{}
	srv := newRouteServer(t, RouteDeps{
		APIKeyFor:    func(string) string { return "sk-test" },
		Runner:       &mockRunner{},
		PickProvider: func(string) (Provider, string, error) { return scripted, "anthropic", nil },
		CostEvents:   sink,
	})
	defer srv.Close()

	body := `{"model":"claude-opus-4-7","input":"hi","SessionId":"sid-42"}`
	resp, err := http.Post(srv.URL+"/v1/stream-direct/", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	// Wait for the fire-and-forget goroutines to drain.
	if !waitFor(sink.wgDone(), 500*time.Millisecond) {
		t.Fatal("sink fire-and-forget didn't complete in time")
	}

	sink.mu.Lock()
	defer sink.mu.Unlock()
	if len(sink.payloads) != 1 {
		t.Fatalf("got %d payloads, want 1: %+v", len(sink.payloads), sink.payloads)
	}
	p := sink.payloads[0]
	if p.SessionID != "sid-42" {
		t.Errorf("SessionID = %q, want sid-42", p.SessionID)
	}
	if p.Model != "claude-opus-4-7" {
		t.Errorf("Model = %q", p.Model)
	}
	if p.ToolCallCount != 1 {
		t.Errorf("ToolCallCount = %d, want 1", p.ToolCallCount)
	}
	if p.DurationMs < 0 {
		t.Errorf("DurationMs = %d, want >= 0", p.DurationMs)
	}
	if len(sink.autoTitleCalls) != 1 || sink.autoTitleCalls[0] != "sid-42" {
		t.Errorf("autoTitleCalls = %+v", sink.autoTitleCalls)
	}
}

// TestRouteFinalizeHooksSkippedWithoutSession ensures we don't post
// telemetry for stream requests that arrive without a sessionId
// (e.g. yha-cli ad-hoc runs).
func TestRouteFinalizeHooksSkippedWithoutSession(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.WriteHeader(200)
	}))
	defer upstream.Close()

	scripted := &scriptedRouteProvider{
		endpoint: upstream.URL,
		responses: []scriptedResponse{
			{emit: []Chunk{{Type: ChunkTypeDelta, Delta: "hi"}}, done: true},
		},
	}
	sink := &recordingSink{}
	srv := newRouteServer(t, RouteDeps{
		APIKeyFor:    func(string) string { return "sk-test" },
		Runner:       &mockRunner{},
		PickProvider: func(string) (Provider, string, error) { return scripted, "anthropic", nil },
		CostEvents:   sink,
	})
	defer srv.Close()

	body := `{"model":"claude-opus-4-7","input":"hi"}` // no SessionId
	resp, err := http.Post(srv.URL+"/v1/stream-direct/", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	resp.Body.Close()

	// Brief wait for any goroutine that might have spawned.
	time.Sleep(50 * time.Millisecond)
	sink.mu.Lock()
	defer sink.mu.Unlock()
	if len(sink.payloads) != 0 {
		t.Errorf("unexpected payloads when sessionId absent: %+v", sink.payloads)
	}
	if len(sink.autoTitleCalls) != 0 {
		t.Errorf("unexpected auto-title calls when sessionId absent: %+v", sink.autoTitleCalls)
	}
}

// TestStreamRequestUpperCaseNormalisation verifies that a body with
// Pascal-cased FE-shape fields normalises into the lower-case fields
// the loop already uses.
func TestStreamRequestUpperCaseNormalisation(t *testing.T) {
	body := `{
		"Model":"claude-opus-4-7",
		"Input":"hello world",
		"SessionId":"sid-9",
		"Effort":"high",
		"AllowedTools":["Bash","Read"],
		"Preset":"be brief"
	}`
	var req streamRequest
	if err := json.Unmarshal([]byte(body), &req); err != nil {
		t.Fatal(err)
	}
	req.normalise()

	if req.Model != "claude-opus-4-7" {
		t.Errorf("Model = %q", req.Model)
	}
	if req.Input != "hello world" {
		t.Errorf("Input = %q", req.Input)
	}
	if req.SessionId != "sid-9" {
		t.Errorf("SessionId = %q", req.SessionId)
	}
	if req.Effort != "high" {
		t.Errorf("Effort = %q", req.Effort)
	}
	if len(req.Tools) != 2 || req.Tools[0] != "Bash" {
		t.Errorf("Tools = %+v", req.Tools)
	}
	// Note: Preset → System fold moved out of normalise() into the
	// route handler so it can honour SystemMode (replace vs append)
	// and the configured default-system fallback. normalise() now
	// leaves req.System empty when only Preset was supplied —
	// integration tests should drive RegisterRoute instead.
	if req.System != "" {
		t.Errorf("System should be untouched by normalise: %q", req.System)
	}
}

// ── Phase 6g opt-out gate tests ────────────────────────────────────────────

// TestHarnessAdapterEnabledOptOutDefaults exercises the opt-out gate
// directly. With no env var set, any non-empty label is enabled; only
// the explicit "0" / "false" variants disable it.
func TestHarnessAdapterEnabledOptOutDefaults(t *testing.T) {
	// Default-on: unset env var → enabled.
	t.Setenv("YHA_GO_CODEX", "")
	if !harnessAdapterEnabled("codex") {
		t.Fatalf("expected codex enabled by default when env unset")
	}
	// "1" or "true" obviously enabled (backwards compat).
	t.Setenv("YHA_GO_CODEX", "1")
	if !harnessAdapterEnabled("codex") {
		t.Fatalf("expected codex enabled when env=1")
	}
	t.Setenv("YHA_GO_CODEX", "true")
	if !harnessAdapterEnabled("codex") {
		t.Fatalf("expected codex enabled when env=true")
	}
	// Explicit disable.
	t.Setenv("YHA_GO_CODEX", "0")
	if harnessAdapterEnabled("codex") {
		t.Fatalf("expected codex disabled when env=0")
	}
	t.Setenv("YHA_GO_CODEX", "false")
	if harnessAdapterEnabled("codex") {
		t.Fatalf("expected codex disabled when env=false")
	}
	t.Setenv("YHA_GO_CODEX", "FALSE")
	if harnessAdapterEnabled("codex") {
		t.Fatalf("expected codex disabled when env=FALSE (case-insensitive)")
	}
	// Empty label still rejected (precedence guard).
	t.Setenv("YHA_GO_CODEX", "")
	if harnessAdapterEnabled("") {
		t.Fatalf("expected empty label to remain disabled")
	}
}

// TestPickHarnessAdapterDefaultOnNoEnv confirms the Phase 6g default:
// with a registered adapter and NO YHA_GO_* env var pinned, the
// adapter is selected (opt-OUT semantics).
func TestPickHarnessAdapterDefaultOnNoEnv(t *testing.T) {
	// t.Setenv with empty string clears any inherited value for the
	// duration of the test (and restores it on cleanup) so we
	// observe the "unset" branch deterministically.
	t.Setenv("YHA_GO_CODEX", "")
	want := HarnessAdapterFn(func(context.Context, HarnessAdapterRequest, []byte, EmitFn, HarnessFinalizeFn) error { return nil })
	got, label := pickHarnessAdapter(
		map[string]HarnessAdapterFn{"codex": want},
		&streamRequest{Model: "codex/gpt-5"},
		ParticipantRouteContext{},
	)
	if got == nil || label != "codex" {
		t.Fatalf("expected codex adapter selected by default, got label=%q nil=%v", label, got == nil)
	}
}

// TestRouteReturns502WhenAdapterExplicitlyDisabled verifies the Phase 7
// opt-out semantics: YHA_GO_CODEX=0 with a registered codex adapter
// makes the route return the canonical 502 (Node /v1/stream/ is gone,
// so there's no fallback target). Replaces the pre-Phase-7 test that
// asserted the request was reverse-proxied to Node.
func TestRouteReturns502WhenAdapterExplicitlyDisabled(t *testing.T) {
	t.Setenv("YHA_GO_CODEX", "0")

	var adapterCalls atomic.Int64
	srv := newRouteServer(t, RouteDeps{
		APIKeyFor: func(string) string { return "sk-test" },
		HarnessAdapters: map[string]HarnessAdapterFn{
			"codex": func(_ context.Context, _ HarnessAdapterRequest, _ []byte, emit EmitFn, finalize HarnessFinalizeFn) error {
				adapterCalls.Add(1)
				emit(Chunk{Type: ChunkTypeDelta, Delta: "should-not-fire"})
				finalize(HarnessFinalize{})
				return nil
			},
		},
	})
	defer srv.Close()

	body := `{"Model":"codex/gpt-5","Input":"hi","SessionId":"sid-optout","CodexInstance":"acct-1"}`
	resp, err := http.Post(srv.URL+"/v1/stream-direct/", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", resp.StatusCode)
	}
	buf, _ := io.ReadAll(resp.Body)
	if !strings.Contains(string(buf), phase7NoAdapterMsg) {
		t.Errorf("body should contain Phase 7 error message: %s", buf)
	}
	if n := adapterCalls.Load(); n != 0 {
		t.Fatalf("expected codex adapter to be skipped, got %d calls", n)
	}
}

// TestRouteDispatchesCodexHarnessAdapterByDefault is the
// route-handler-level counterpart to TestPickHarnessAdapterDefaultOnNoEnv:
// with no YHA_GO_CODEX env var pinned and a registered adapter, the
// route hits the adapter. After Phase 7 there is no Node fallback to
// guard against — disabling the adapter would simply 502 (covered by
// TestRouteReturns502WhenAdapterExplicitlyDisabled).
func TestRouteDispatchesCodexHarnessAdapterByDefault(t *testing.T) {
	t.Setenv("YHA_GO_CODEX", "") // ensure "unset" relative to the test

	var called atomic.Bool
	srv := newRouteServer(t, RouteDeps{
		APIKeyFor: func(string) string { return "sk-test" },
		HarnessAdapters: map[string]HarnessAdapterFn{
			"codex": func(_ context.Context, req HarnessAdapterRequest, _ []byte, emit EmitFn, finalize HarnessFinalizeFn) error {
				called.Store(true)
				emit(Chunk{Type: ChunkTypeDelta, Delta: "from-adapter"})
				finalize(HarnessFinalize{Model: req.Model, Provider: "openai"})
				return nil
			},
		},
	})
	defer srv.Close()

	body := `{"Model":"codex/gpt-5","Input":"hi","SessionId":"sid-default","CodexInstance":"acct-1"}`
	resp, err := http.Post(srv.URL+"/v1/stream-direct/", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	if !called.Load() {
		t.Fatal("expected codex adapter to fire by default under opt-out gate")
	}
}

// ── Helpers ────────────────────────────────────────────────────────────────

func waitFor(ch <-chan struct{}, timeout time.Duration) bool {
	select {
	case <-ch:
		return true
	case <-time.After(timeout):
		return false
	}
}

// readSSELines reads back the data: portion of each SSE frame as a
// raw string. Less strict than readSSEChunks which expects JSON.
func readSSELines(t *testing.T, body io.Reader) []string {
	t.Helper()
	out := []string{}
	br := bufio.NewReader(body)
	var data bytes.Buffer
	for {
		line, err := br.ReadString('\n')
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			if data.Len() > 0 {
				out = append(out, data.String())
				data.Reset()
			}
			continue
		}
		if strings.HasPrefix(line, "data:") {
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.WriteString(strings.TrimPrefix(strings.TrimPrefix(line, "data:"), " "))
		}
	}
	if data.Len() > 0 {
		out = append(out, data.String())
	}
	return out
}
