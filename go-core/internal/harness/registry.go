// Registry — concurrency-safe lookup for Harness implementations.
//
// The registry's primary job is to answer "given a request that the
// classifier said isn't direct-API, which Harness (if any) should
// handle it natively?". Today the answer is "claude-binary or
// nothing" because that's the only adapter wired; Wave 3-6 grow the
// fan-out to codex, claude-sdk, hermes, openclaw, broadcast.
//
// We deliberately don't reuse the broader register pattern from
// internal/registers — that one is keyed by module name and supports
// hot-add/remove via the module loader. Harnesses don't churn at
// runtime (they ship in the binary), so a simple sync.RWMutex map
// is enough and reads stay lock-free on the hot path via a cached
// id→harness snapshot.
package harness

import (
	"strings"
	"sync"
)

// Registry is the per-daemon map of harness id → Harness plus a
// classifier that turns a route request into "use this harness".
// Construct with NewRegistry; register each adapter at boot.
type Registry struct {
	mu sync.RWMutex
	m  map[string]Harness
}

// NewRegistry returns an empty Registry. Adapters call Register on it
// during daemon boot; subsequent Pick / Lookup reads are lock-free
// for the common hit case via the RWMutex's read lock.
func NewRegistry() *Registry {
	return &Registry{m: map[string]Harness{}}
}

// Register adds h to the registry under h.ID(). Overwrites any
// existing entry — registration order during boot is "last write
// wins" so a future module-system port can re-register without
// duplicate-detection logic at the call site.
//
// Safe for concurrent use; intended for boot-time only.
func (r *Registry) Register(h Harness) {
	if r == nil || h == nil {
		return
	}
	id := h.ID()
	if id == "" {
		return
	}
	r.mu.Lock()
	r.m[id] = h
	r.mu.Unlock()
}

// Lookup returns the harness with the given id, or nil if none. The
// lookup is read-locked; safe under concurrent Register.
func (r *Registry) Lookup(id string) Harness {
	if r == nil || id == "" {
		return nil
	}
	r.mu.RLock()
	h := r.m[id]
	r.mu.RUnlock()
	return h
}

// Len returns the number of registered harnesses. Useful for boot
// diagnostics ("registered N harnesses").
func (r *Registry) Len() int {
	if r == nil {
		return 0
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.m)
}

// RequestView is the minimal projection of streamRequest the Pick
// classifier consults. We define this in the harness package (rather
// than importing stream.streamRequest) so the registry stays free of
// cycles — stream imports harness, not the other way around.
//
// Field names mirror streamRequest 1:1; the route handler builds one
// of these per request from req.* before calling Pick. Adapters
// don't see this type directly — they see Request.
type RequestView struct {
	Model           string
	Input           string
	Provider        string
	HarnessInstance string
	CodexInstance   string
}

// KeyForFn is the api-key-by-provider-name closure passed through
// from route.RouteDeps. The classifier uses it to gate "Anthropic +
// API key present → claude-binary handles" vs "no key → proxy".
type KeyForFn func(provider string) string

// Pick returns the Harness that should serve req, or nil if none
// applies. Phase 7 deleted the Node /v1/stream/ fallback, so a nil
// return now causes the route to surface the canonical 502
// "no harness adapter available" error.
//
// Today only claude-binary is registered and Pick returns it for
// Claude models with an Anthropic API key. As more adapters land we
// extend the classifier; the signature stays stable.
//
// The classifier deliberately mirrors stream.classifyRoute's
// non-direct branch — anything that classifyRoute pushed off the
// direct-API path can still light up a registered harness here. The
// route handler's full decision tree is:
//
//	direct? → run Provider loop (existing)
//	  no  → r.Harnesses.Pick(req) → run h.Stream
//	         nil → 502 "no harness adapter available" (Phase 7)
//
// keyFor is passed through unchanged so the classifier can reach
// Anthropic / OpenAI / Gemini api keys when deciding which adapter
// owns this request.
func (r *Registry) Pick(view *RequestView, keyFor KeyForFn) Harness {
	if r == nil || view == nil {
		return nil
	}
	// claude-binary: model is claude-*, no codex instance / no
	// non-Anthropic provider hint. The route classifier already
	// rejected the direct-API path for it (no API key OR a
	// subscription / harness-instance hint) so picking the binary
	// here is the natural escalation.
	m := strings.ToLower(strings.TrimSpace(view.Model))
	if strings.HasPrefix(m, "claude-") || strings.HasPrefix(m, "claude/") {
		// claude-binary owns: subscription, harness-instance pinned,
		// API + non-API provider hint, or anywhere the direct-API
		// classifier punted but the binary can still handle it.
		// CodexInstance is mutually exclusive with HarnessInstance so
		// any populated CodexInstance means this request was meant
		// for codex; we don't claim it.
		if strings.TrimSpace(view.CodexInstance) != "" {
			return nil
		}
		if h := r.Lookup("claude-binary"); h != nil {
			return h
		}
	}
	// codex: model starts with codex/* OR has a CodexInstance pinned.
	// Future Wave 3 port; today returns nil so the proxy fallback
	// handles it.
	// broadcast: input starts with @<name>. Future Wave 4.
	// hermes / openclaw partners: provider hint matches.
	_ = keyFor // reserved for richer classifier branches.
	return nil
}
