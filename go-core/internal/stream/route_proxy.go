package stream

import (
	"regexp"
	"strings"
)

// routeDecision is the verdict of the direct-vs-proxy classifier. When
// Direct is true, Go owns the request natively (provider must be one of
// anthropic/openai/gemini with a configured api_key). When false, Go
// dispatches to one of the in-process harness adapters
// (claude-binary / claude-sdk / codex / openclaw / hermes / broadcast),
// each gated by an opt-out env flag. Since Phase 7 there is no Node
// /v1/stream/ fallback target — if no adapter accepts the request the
// route returns 502 (see route.go).
type routeDecision struct {
	Direct bool
	Reason string // human-readable; surfaces in debug logs only
}

// reClaudeSubProvider mirrors bridge/providers/core.ts:153
// (/^Anthropic-SUB\d*$/) — any Claude subscription instance label
// like "Anthropic-SUB", "Anthropic-SUB2", etc.
var reClaudeSubProvider = regexp.MustCompile(`^Anthropic-SUB\d*$`)

// reCodexSubProvider mirrors bridge/providers/core.ts:156
// (/^OpenAI-SUB\d*$/).
var reCodexSubProvider = regexp.MustCompile(`^OpenAI-SUB\d*$`)

// reGrokSubProvider matches Grok subscription provider hints
// ("Grok-SUB", "Grok-SUB2", …). The grok CLI uses OAuth (no API key)
// for subscription mode so any request tagged this way must land on
// the grok harness adapter rather than the direct-API loop.
var reGrokSubProvider = regexp.MustCompile(`^Grok-SUB\d*$`)

// classifyRoute decides whether a parsed streamRequest can be served
// natively (direct-API path) or must be dispatched to a Go harness
// adapter / rejected. The decision mirrors bridge/providers/core.ts's
// resolveRouteType() — we keep this function pure so it's directly
// testable and so the daemon's call-site stays a single boolean check.
//
// keyFor returns the api_key for a stream provider name
// ("anthropic"|"openai"|"gemini"). Empty string means no key is
// configured; that pushes the request to the harness ladder (which since
// Phase 7 must claim it — there is no Node fallback).
func classifyRoute(req *streamRequest, keyFor func(string) string) routeDecision {
	return classifyRouteWithPicker(req, keyFor, pickProvider)
}

// classifyRouteWithGeneric is the variant the route handler actually
// uses. genericProvider lets the classifier route configured
// third-party providers (DeepSeek, NVIDIA NIM, OpenRouter, …) onto
// the direct-API path even when their model id doesn't match a built-
// in prefix. nil disables the external branch (legacy behaviour).
func classifyRouteWithGeneric(
	req *streamRequest,
	keyFor func(string) string,
	picker func(string) (Provider, string, error),
	genericProvider func(string) (string, string, bool),
) routeDecision {
	d := classifyRouteWithPicker(req, keyFor, picker)
	if d.Direct {
		return d
	}
	// Only consider the generic-external branch when the classifier
	// reason is "unknown model" or "no direct api key" — otherwise
	// we'd accidentally steal subscription / participant / broadcast
	// turns from their right adapters.
	if d.Reason != "unknown model" && d.Reason != "no direct api key" {
		return d
	}
	if genericProvider == nil {
		return d
	}
	hint := strings.TrimSpace(req.Provider)
	if hint == "" {
		return d
	}
	// Don't shadow the built-in routes via the generic branch.
	switch hint {
	case "Anthropic", "Anthropic API", "OpenAI", "OpenAI API", "Google", "Google API":
		return d
	}
	if reClaudeSubProvider.MatchString(hint) ||
		reCodexSubProvider.MatchString(hint) ||
		reGrokSubProvider.MatchString(hint) ||
		hint == "Anthropic Subscription" ||
		hint == "OpenAI Subscription" ||
		hint == "Grok Subscription" {
		return d
	}
	if endpoint, key, ok := genericProvider(hint); ok && endpoint != "" && key != "" {
		return routeDecision{Direct: true, Reason: "generic-openai:" + hint}
	}
	return d
}

// classifyRouteWithPicker is the picker-injectable variant. The route
// handler passes deps.PickProvider when set so tests that inject a
// scripted provider see Direct=true for their fake model names — the
// rest of the proxy/subscription/harness logic still applies.
func classifyRouteWithPicker(
	req *streamRequest,
	keyFor func(string) string,
	picker func(string) (Provider, string, error),
) routeDecision {
	if picker == nil {
		picker = pickProvider
	}
	// Slash commands (/help, /clear, /review, /commit, …) always run
	// through the claude binary regardless of the picked model — they
	// are CLI built-ins that have no upstream-API counterpart. Mirrors
	// Node's bridge/providers/core.ts:isSlashCommand path in
	// resolveRouteType. Without this routing, e.g. a `/review` prompt
	// with model=gemini would land on the Gemini API and the model
	// would just narrate that it doesn't know `/review`.
	if isSlashCommandInput(req.Input) {
		return routeDecision{Direct: false, Reason: "slash command"}
	}

	// Codex models — direct-API loop has no Codex provider; classify
	// non-direct so the codex harness adapter picks the request up.
	if strings.HasPrefix(strings.ToLower(req.Model), "codex/") {
		return routeDecision{Direct: false, Reason: "codex model"}
	}

	// Harness-pinned requests carry an instance id, but the FE stores
	// HarnessInstance / CodexInstance GLOBALLY — they persist from the
	// last Claude / Codex subscription turn even after the user
	// switches to a totally different model (Gemini, DeepSeek, NVIDIA,
	// OpenRouter, …). So an unconditional non-direct decision here
	// would drag every subsequent third-party turn into claude-binary
	// and lose token streaming. Only honour these flags when the model
	// id actually matches the harness they were set for.
	if strings.TrimSpace(req.HarnessInstance) != "" && isClaudeModel(req.Model) {
		return routeDecision{Direct: false, Reason: "harness instance pinned"}
	}
	if strings.TrimSpace(req.CodexInstance) != "" && strings.HasPrefix(strings.ToLower(req.Model), "codex/") {
		return routeDecision{Direct: false, Reason: "codex instance pinned"}
	}

	// Subscription-encoded provider hints (Anthropic-SUB / OpenAI-SUB)
	// route to the claude / codex binary harness — Go's direct-API
	// providers can't impersonate the OAuth-backed subscription flow,
	// but the in-process binary adapters can.
	hint := strings.TrimSpace(req.Provider)
	if hint != "" {
		if reClaudeSubProvider.MatchString(hint) || hint == "Anthropic Subscription" {
			return routeDecision{Direct: false, Reason: "claude subscription provider"}
		}
		if reCodexSubProvider.MatchString(hint) || hint == "OpenAI Subscription" {
			return routeDecision{Direct: false, Reason: "codex subscription provider"}
		}
		if reGrokSubProvider.MatchString(hint) || hint == "Grok Subscription" {
			return routeDecision{Direct: false, Reason: "grok subscription provider"}
		}
	}

	// Broadcast / Versus mode — any input that starts with "@" is fan
	// out across multiple employees. The Go broadcast adapter handles
	// it in-process; classify non-direct so the harness ladder picks it.
	if isBroadcastInput(req.Input) {
		return routeDecision{Direct: false, Reason: "mention-based broadcast"}
	}

	// Model classification: derive the provider from the model id like
	// pickProvider does, then check whether an api key is configured.
	provider, providerName, err := picker(req.Model)
	if err != nil || provider == nil {
		// Unknown model — the route surfaces this as a 400 instead of
		// 502 because it never had a chance regardless of adapter
		// wiring (see route.go's no-adapter branch).
		return routeDecision{Direct: false, Reason: "unknown model"}
	}

	apiKey := ""
	if keyFor != nil {
		apiKey = keyFor(providerName)
	}
	if apiKey == "" {
		// No direct-API key configured — the harness ladder must
		// claim it (subscription / binary / partner adapter). If
		// every adapter is disabled the route returns 502.
		return routeDecision{Direct: false, Reason: "no direct api key"}
	}

	// Claude model + explicit provider hint that means "use the
	// subscription / binary harness" — the harness adapter ladder
	// owns it. (Anthropic / "Anthropic API" both mean API-billed =
	// direct.)
	if providerName == "anthropic" && hint != "" &&
		hint != "Anthropic" && hint != "Anthropic API" {
		return routeDecision{Direct: false, Reason: "anthropic non-api provider hint"}
	}

	return routeDecision{Direct: true, Reason: "direct " + providerName}
}

// isSlashCommandInput reports whether the user input is a claude-CLI
// slash command (e.g. "/help", "/clear", "/review"). Matches the
// Node-side regex /^\/[a-z]/ from providers/core.ts:isSlashCommand.
// Used by the classifier to force every slash turn onto the
// claude-binary harness, where the binary expands the command into a
// real prompt — non-Claude models don't speak this protocol.
func isSlashCommandInput(input string) bool {
	trimmed := strings.TrimLeft(input, " \t\r\n")
	if len(trimmed) < 2 {
		return false
	}
	if trimmed[0] != '/' {
		return false
	}
	c := trimmed[1]
	return c >= 'a' && c <= 'z'
}

// isClaudeModel reports whether the model id is an Anthropic-native
// Claude model. Matches the two prefixes pickProvider recognises for
// Anthropic, lower-cased. Used by classifyRouteWithPicker to scope
// the HarnessInstance early-exit to Claude-routed turns only — the
// FE keeps HarnessInstance global, so the check has to gate on the
// model id to avoid hijacking Gemini / DeepSeek / NVIDIA / etc.
func isClaudeModel(model string) bool {
	m := strings.ToLower(strings.TrimSpace(model))
	return strings.HasPrefix(m, "claude-") || strings.HasPrefix(m, "claude/")
}

// trimOpenAIBaseSuffix strips a trailing "/v1" (or "/v1/") off a
// provider endpoint URL so it can be used as OpenAIProvider.BaseURL
// without producing a doubled "/v1/v1/chat/completions" path. The
// bridge config conventionally stores endpoints with the /v1 already
// appended (api.deepseek.com/v1, integrate.api.nvidia.com/v1, …),
// matching the form humans paste from each provider's docs. Returns
// the input unchanged when no /v1 suffix is present (e.g. localhost
// Ollama).
func trimOpenAIBaseSuffix(u string) string {
	u = strings.TrimRight(strings.TrimSpace(u), "/")
	if strings.HasSuffix(u, "/v1") {
		return strings.TrimSuffix(u, "/v1")
	}
	return u
}

// genericProviderFromDecision pulls the provider hint back out of a
// classifier decision whose Reason was stamped by the
// generic-OpenAI-compatible branch in classifyRouteWithGeneric. The
// prefix is "generic-openai:<providerName>". Returns ("", false) when
// the decision didn't come from that branch.
func genericProviderFromDecision(d routeDecision) (string, bool) {
	const prefix = "generic-openai:"
	if !d.Direct {
		return "", false
	}
	if !strings.HasPrefix(d.Reason, prefix) {
		return "", false
	}
	return d.Reason[len(prefix):], true
}

// isBroadcastInput returns true when the user message starts with an
// "@name" mention — chat.ts used to fan that out across employees
// (broadcast / versus / DM-via-mention). Go's broadcast adapter
// (internal/harness/broadcast) handles the same routing in-process now;
// this helper survives because the classifier still uses it to keep
// mention-prefixed turns off the direct-API path so the in-process
// broadcast adapter (or the participant resolver) gets first dibs.
func isBroadcastInput(input string) bool {
	trimmed := strings.TrimLeft(input, " \t\r\n")
	if trimmed == "" {
		return false
	}
	if trimmed[0] != '@' {
		return false
	}
	// Bare "@" without a follower isn't a mention. Common typos
	// (e.g. "@ what's up?") should still go through direct-API.
	if len(trimmed) < 2 {
		return false
	}
	c := trimmed[1]
	return c != ' ' && c != '\t' && c != '\n'
}
