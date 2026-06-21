package internalapi

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// handleModels returns the catalog of qualified model ids ("slug/model").
// Mirrors bridge/chat/openai-internal.ts:69-77.
func (s *Server) handleModels(w http.ResponseWriter, r *http.Request) {
	// Auth-gate the catalog too — Node does. The token doesn't need
	// the catalog scope; any valid key passes.
	if rec := s.authenticate(r, nil); rec == nil {
		writeError(w, http.StatusUnauthorized,
			"Invalid or missing API key. Provide Authorization: Bearer yha_<key> or ?api_key=…",
			"invalid_request_error", "invalid_api_key")
		return
	}
	cfg := s.deps.Store.Config()
	type item struct {
		ID      string `json:"id"`
		Object  string `json:"object"`
		Created int64  `json:"created"`
		OwnedBy string `json:"owned_by"`
	}
	out := struct {
		Object string `json:"object"`
		Data   []item `json:"data"`
	}{Object: "list"}
	for _, p := range cfg.Providers {
		name, _ := p["name"].(string)
		if name == "" {
			continue
		}
		slug := providerSlug(name)
		models, _ := p["models"].(map[string]any)
		for mid := range models {
			out.Data = append(out.Data, item{
				ID:      slug + "/" + mid,
				Object:  "model",
				Created: 0,
				OwnedBy: slug,
			})
		}
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(out)
}

// handleMe is the debug surface — confirms the bearer is recognised.
func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	rec := s.authenticate(r, nil)
	if rec == nil {
		writeError(w, http.StatusUnauthorized,
			"Invalid or missing API key.",
			"invalid_request_error", "invalid_api_key")
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(map[string]any{
		"keyId":      rec.ID,
		"label":      rec.Label,
		"createdAt":  rec.CreatedAt,
		"lastUsedAt": rec.LastUsedAt,
	})
}

// handleChatCompletions is the heart of the server. Reads + verifies
// bearer, decodes the request, resolves the routing branch, and hands
// off to the per-branch proxy.
func (s *Server) handleChatCompletions(w http.ResponseWriter, r *http.Request) {
	const maxBody = 32 * 1024 * 1024 // 32 MiB — generous for image-heavy turns
	body, err := io.ReadAll(io.LimitReader(r.Body, maxBody+1))
	if err != nil {
		writeError(w, http.StatusBadRequest,
			"Failed to read request body: "+err.Error(),
			"invalid_request_error", "")
		return
	}
	if len(body) > maxBody {
		writeError(w, http.StatusRequestEntityTooLarge,
			"Request body exceeds the 32 MiB limit",
			"invalid_request_error", "")
		return
	}

	// Pre-buffer the body so ExtractBearer can read api_key from JSON
	// when the caller put it in the body. The full struct decode
	// happens below.
	var prebuf map[string]any
	_ = json.Unmarshal(body, &prebuf)

	rec := s.authenticate(r, prebuf)
	if rec == nil {
		writeError(w, http.StatusUnauthorized,
			"Invalid or missing API key. Provide Authorization: Bearer yha_<key> or ?api_key=…",
			"invalid_request_error", "invalid_api_key")
		return
	}

	var req OpenAIRequest
	if err := json.Unmarshal(body, &req); err != nil {
		writeError(w, http.StatusBadRequest,
			"Invalid JSON: "+err.Error(),
			"invalid_request_error", "")
		return
	}
	if strings.TrimSpace(req.Model) == "" {
		writeError(w, http.StatusBadRequest,
			`Missing "model" field`,
			"invalid_request_error", "")
		return
	}

	resolver := newStoreResolver(s.deps.Store)
	kind, info := ResolveRoute(req.Model, resolver)
	if kind == RouteUnknown {
		writeError(w, http.StatusNotFound,
			"Unknown model: "+req.Model,
			"invalid_request_error", "")
		return
	}
	if info.Endpoint == "" {
		writeError(w, http.StatusInternalServerError,
			fmt.Sprintf("Provider %q has no endpoint configured", info.ProviderName),
			"server_error", "")
		return
	}

	turnStart := time.Now()
	switch kind {
	case RouteAnthropicSubscription:
		// Out of scope for the Phase 1 §8.2 port; the claude-binary
		// streamer wiring is its own follow-up. Returning 501 lets
		// the caller degrade to Node's hosted endpoint cleanly.
		writeError(w, http.StatusNotImplemented,
			"Anthropic Subscription routing not yet ported to Go internalapi — falling back to Node",
			"server_error", "")
		return

	case RouteAnthropicAPI:
		anReq := OpenAIToAnthropic(req, info.ModelID)
		s.proxyAnthropic(w, r, rec, info, req.Model, anReq, turnStart)

	case RouteGeneric:
		// Forward the original OpenAI body (with the upstream model
		// id swapped to its unqualified form).
		passthroughBody := body
		if info.ModelID != "" && info.ModelID != req.Model {
			if rewritten, err := rewriteModel(body, info.ModelID); err == nil {
				passthroughBody = rewritten
			}
		}
		s.proxyOpenAI(w, r, rec, info, req, passthroughBody, turnStart)
	}
}

// authenticate runs the bearer through the configured VerifyKey func.
// Returns nil when no token is present or the verifier rejects it.
func (s *Server) authenticate(r *http.Request, body map[string]any) *KeyRecord {
	token := ExtractBearer(r, body)
	if token == "" || s.deps.VerifyKey == nil {
		return nil
	}
	return s.deps.VerifyKey(token)
}

// providerSlug derives the OpenAI-style slug from a provider's name.
// "Anthropic API" → "anthropic-api"; mirrors the Node side's
// derivation at line 70-77.
func providerSlug(name string) string {
	out := strings.ToLower(strings.TrimSpace(name))
	out = strings.ReplaceAll(out, " ", "-")
	return out
}

// rewriteModel produces a new JSON body with the top-level "model"
// field set to dst. Used to drop the provider slug ("anthropic-api/")
// before forwarding to the actual upstream which only expects the
// unqualified id.
func rewriteModel(body []byte, dst string) ([]byte, error) {
	var raw map[string]any
	if err := json.Unmarshal(body, &raw); err != nil {
		return nil, err
	}
	raw["model"] = dst
	return json.Marshal(raw)
}

// generateID returns "chatcmpl-<hex>" — same shape OpenAI uses for
// completion ids so any clients that read them survive the port.
func generateID() string {
	var b [12]byte
	_, _ = rand.Read(b[:])
	return "chatcmpl-" + hex.EncodeToString(b[:])
}

// doProxy issues the upstream HTTP request, wrapped in the rate
// limiter when configured. Mirrors the same pattern stream/loop.go
// uses post-§8.1.
func (s *Server) doProxy(ctx context.Context, providerName string, req *http.Request) (*http.Response, error) {
	client := &http.Client{Timeout: 10 * time.Minute}
	if s.deps.Limiter == nil {
		return client.Do(req)
	}
	return s.deps.Limiter.With(ctx, providerName, func(c context.Context) (*http.Response, error) {
		return client.Do(req.WithContext(c))
	})
}

// recordCost fires the per-request telemetry callback so Node's
// recordKeyUsage folds the totals into api-keys.json. Fire-and-forget;
// errors are logged and dropped. Mirrors the JS recordKeyUsage call
// sites on lines 194, 214, 404, 497.
func (s *Server) recordCost(keyID, model, provider, route string, inTok, outTok int, cost float64, started time.Time) {
	if s.deps.Cost == nil || keyID == "" {
		return
	}
	payload := CostEventPayload{
		KeyID:        keyID,
		Model:        model,
		Provider:     provider,
		InputTokens:  inTok,
		OutputTokens: outTok,
		Cost:         cost,
		DurationMs:   time.Since(started).Milliseconds(),
		Route:        route,
	}
	s.deps.Cost.FireAndForget("internalapi.cost-event", func(ctx context.Context) error {
		ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
		defer cancel()
		return s.deps.Cost.Record(ctx, payload)
	})
}

// computeCost looks up per-1M-token pricing via the store and returns
// the dollar amount for the supplied token counts. Mirrors the JS at
// lines 259-265.
func (s *Server) computeCost(model string, inTok, outTok int) float64 {
	if s.deps.Store == nil {
		return 0
	}
	priceIn, priceOut, ok := s.deps.Store.ModelPricing(model)
	if !ok {
		return 0
	}
	return (float64(inTok)/1_000_000.0)*priceIn + (float64(outTok)/1_000_000.0)*priceOut
}

// flushIfPossible nudges any buffered SSE bytes onto the wire. Some
// proxies / FE clients won't render incremental output until the
// kernel TCP send buffer flushes, so the streaming branches call this
// after every chunk write.
func flushIfPossible(w http.ResponseWriter) {
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
}

// readUpstreamFailure pulls the body of an upstream non-2xx response
// for the error envelope. Limits the read to 64 KiB so a runaway
// upstream can't OOM us.
func readUpstreamFailure(resp *http.Response) (string, []byte) {
	const cap = 64 * 1024
	body, _ := io.ReadAll(io.LimitReader(resp.Body, cap))
	return resp.Header.Get("Content-Type"), body
}
