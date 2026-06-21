package internalapi

import (
	"strings"

	"github.com/yha/core/internal/state"
)

// storeResolver implements ProviderResolver against an in-memory
// state.Store. It accepts both qualified ("anthropic-api/claude-…")
// and unqualified ("claude-…") model ids:
//
//   - Qualified: the slug is matched against the provider's name via
//     providerSlug() — Node's bridge/chat/openai-internal.ts:237-257
//     does the same thing.
//   - Unqualified: every provider's `models` map is scanned for an
//     entry whose key equals the supplied id; the first hit wins.
type storeResolver struct {
	store *state.Store
}

func newStoreResolver(store *state.Store) *storeResolver {
	return &storeResolver{store: store}
}

func (r *storeResolver) ProviderForModel(modelID string) (ProviderInfo, bool) {
	if r == nil || r.store == nil || modelID == "" {
		return ProviderInfo{}, false
	}
	cfg := r.store.Config()
	slug, unqual := SplitQualified(modelID)
	for _, p := range cfg.Providers {
		name, _ := p["name"].(string)
		if name == "" {
			continue
		}
		if slug != "" {
			if providerSlug(name) != slug {
				continue
			}
		}
		endpoint, _ := p["endpoint"].(string)
		apikey, _ := p["api_key"].(string)
		models, _ := p["models"].(map[string]any)
		if slug != "" {
			// Qualified — accept the provider even when models map
			// doesn't list the unqualified id (matches the Node side's
			// lenient lookup).
			return ProviderInfo{
				ProviderName: name,
				Endpoint:     strings.TrimRight(endpoint, "/"),
				APIKey:       apikey,
				ModelID:      unqual,
			}, true
		}
		// Unqualified — only return if this provider lists the model.
		if _, ok := models[unqual]; ok {
			return ProviderInfo{
				ProviderName: name,
				Endpoint:     strings.TrimRight(endpoint, "/"),
				APIKey:       apikey,
				ModelID:      unqual,
			}, true
		}
	}
	return ProviderInfo{}, false
}
