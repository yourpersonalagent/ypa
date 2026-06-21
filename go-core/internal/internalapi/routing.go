package internalapi

import (
	"regexp"
	"strings"
)

// anthropicNameRe matches provider names that should route through the
// Anthropic-translation branch. "Anthropic Subscription" routes via a
// separate code path before this regex is consulted. Same pattern as
// bridge/chat/openai-internal.ts line 103.
var anthropicNameRe = regexp.MustCompile(`^Anthropic( API)?$`)

// RouteKind names the dispatch branch a given provider triggers.
type RouteKind int

const (
	// RouteUnknown means the request couldn't be resolved to a known
	// provider — return 404.
	RouteUnknown RouteKind = iota
	// RouteAnthropicSubscription spawns the `claude` CLI via the
	// harness/claudebinary streamer. Out of scope for the Phase 1
	// port — handlers return 501 until the subscription branch lands.
	RouteAnthropicSubscription
	// RouteAnthropicAPI translates OpenAI → Anthropic and proxies to
	// provider.endpoint/messages.
	RouteAnthropicAPI
	// RouteGeneric passes through to provider.endpoint/chat/completions
	// with Authorization swapped in. Catches OpenAI, Google, NVIDIA NIM,
	// OpenRouter, DeepSeek, Groq, etc.
	RouteGeneric
)

// ProviderInfo carries the resolved provider record fields the
// handlers need. ProviderName is exactly what the config.providers
// entry says (case-sensitive, matches the Node side's case-sensitive
// `provider.name` comparison).
type ProviderInfo struct {
	ProviderName string
	Endpoint     string
	APIKey       string
	ModelID      string // the unqualified model id the upstream expects
}

// ResolveRoute decodes a request's `model` field into the routing
// decision + the resolved provider record. modelID accepts both
// qualified ("anthropic-api/claude-opus-4-7") and unqualified
// ("claude-opus-4-7") shapes, mirroring the JS side's lookup.
//
// providerLookup is what the production wiring passes (closure over
// state.Store) — it walks bridge/config.json's providers array and
// returns (endpoint, apiKey, ok). Tests inject a scripted resolver.
//
// modelToProvider resolves an unqualified model id to its owning
// provider name + endpoint suffix. Production wiring reads the
// `models` map on each provider entry. Tests scripted in-line.
type ProviderResolver interface {
	ProviderForModel(modelID string) (ProviderInfo, bool)
}

// ResolveRoute is the dispatcher's pre-flight: given a body-supplied
// model id, decide which branch handles the request and pull the
// provider record. Returns RouteUnknown + empty info when nothing
// matches.
func ResolveRoute(modelID string, resolver ProviderResolver) (RouteKind, ProviderInfo) {
	modelID = strings.TrimSpace(modelID)
	if modelID == "" || resolver == nil {
		return RouteUnknown, ProviderInfo{}
	}
	info, ok := resolver.ProviderForModel(modelID)
	if !ok {
		return RouteUnknown, ProviderInfo{}
	}
	switch {
	case info.ProviderName == "Anthropic Subscription":
		return RouteAnthropicSubscription, info
	case anthropicNameRe.MatchString(info.ProviderName):
		return RouteAnthropicAPI, info
	default:
		return RouteGeneric, info
	}
}

// SplitQualified parses "provider-slug/model-id" into its two parts.
// When the id is unqualified the first return is empty and the second
// is the full input.
func SplitQualified(id string) (slug, model string) {
	id = strings.TrimSpace(id)
	if id == "" {
		return "", ""
	}
	idx := strings.Index(id, "/")
	if idx <= 0 || idx == len(id)-1 {
		return "", id
	}
	return id[:idx], id[idx+1:]
}
