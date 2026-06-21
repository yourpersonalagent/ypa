// Package partnersapi hosts the Go-native partner control plane —
// port of bridge/modules/partners/routes.ts.
//
// Status (Phase 1 of §8.6): the load-bearing prompt-respond route is
// wired. The other eight CRUD / connect / disconnect routes stay on
// the Node side until a follow-up port lands, since they touch
// bridge/partners.json directly and that file's authority still lives
// in Node's partner module.
//
// Routes registered here:
//
//	POST /v1/partners/hermes/prompt-respond
//	    Body: {sessionId, partnerId, type, ...params}
//	    Behaviour: dispatches to hermes.Gateway.RespondToPrompt with
//	    a 10s per-call timeout. type ∈ {approval, clarify, sudo,
//	    secret}; payload shape is per the Hermes RPC schema.
//
// Auth: bridge-key gated (`X-Bridge-Key`), same as /v1/mcp/*.
package partnersapi

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strings"

	"github.com/yha/core/internal/harness/hermes"
	"github.com/yha/core/internal/logger"
)

// Deps wires the partnersapi routes to the rest of the daemon.
type Deps struct {
	// Hermes is the live Gateway driving the singleton Python
	// subprocess. nil disables every Hermes route — the handler
	// returns 503 in that case so the FE can degrade.
	Hermes *hermes.Gateway

	// BridgeKey is the shared X-Bridge-Key value the FE proxies in.
	// Empty disables the gate (tests / dev).
	BridgeKey func() string

	// Logger receives request-level audit lines. Optional.
	Logger *logger.Logger
}

// RegisterRoutes attaches the partner-side control-plane routes onto
// mux. Each route is wrapped in the same bridge-key middleware
// /v1/mcp/* uses.
func RegisterRoutes(mux *http.ServeMux, deps Deps) {
	mux.HandleFunc("POST /v1/partners/hermes/prompt-respond", deps.wrap(deps.handlePromptRespond))
}

func (d Deps) wrap(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if d.BridgeKey != nil {
			want := strings.TrimSpace(d.BridgeKey())
			got := strings.TrimSpace(r.Header.Get("X-Bridge-Key"))
			// Constant-time compare so the key can't be recovered byte-by-byte
			// via response timing. Empty want still disables the gate (dev/tests).
			if want != "" && subtle.ConstantTimeCompare([]byte(got), []byte(want)) != 1 {
				writeJSON(w, http.StatusUnauthorized, map[string]any{
					"success": false,
					"error":   "invalid bridge key",
				})
				return
			}
		}
		h(w, r)
	}
}

// handlePromptRespond is the FE → Hermes RPC dispatcher for the four
// mid-turn prompt types. Returns:
//
//	200 {success:true, result:<rpc-response>}    — RPC succeeded
//	400 {success:false, error:"…"}                — bad request body
//	503 {success:false, error:"…"}                — Hermes not running
//	500 {success:false, error:"…"}                — RPC failed / timed out
func (d Deps) handlePromptRespond(w http.ResponseWriter, r *http.Request) {
	if d.Hermes == nil {
		writeJSON(w, http.StatusServiceUnavailable, map[string]any{
			"success": false,
			"error":   "hermes gateway not configured",
		})
		return
	}

	var body struct {
		SessionID string         `json:"sessionId"`
		PartnerID string         `json:"partnerId"`
		Type      string         `json:"type"`
		Params    map[string]any `json:"-"`
	}
	// Decode top-level fields, then re-decode into a map so the
	// per-prompt-type params (e.g. {approved:true} or {answer:"…"})
	// flow through to Hermes unchanged.
	raw := map[string]any{}
	if err := json.NewDecoder(r.Body).Decode(&raw); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"success": false,
			"error":   "invalid JSON body: " + err.Error(),
		})
		return
	}
	body.SessionID, _ = raw["sessionId"].(string)
	body.PartnerID, _ = raw["partnerId"].(string)
	body.Type, _ = raw["type"].(string)
	if body.SessionID == "" || body.Type == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{
			"success": false,
			"error":   "sessionId and type are required",
		})
		return
	}
	// Strip routing fields; everything else is per-type params.
	delete(raw, "sessionId")
	delete(raw, "partnerId")
	delete(raw, "type")
	body.Params = raw

	ctx, cancel := context.WithTimeout(r.Context(), hermes.PromptRespondTimeout)
	defer cancel()
	result, err := d.Hermes.RespondToPrompt(ctx, body.SessionID, body.PartnerID, body.Type, body.Params)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]any{
			"success": false,
			"error":   err.Error(),
		})
		return
	}
	// result is raw JSON — pass through as-is so the FE sees the
	// exact RPC response Hermes returned.
	var resultParsed any
	if len(result) > 0 {
		_ = json.Unmarshal(result, &resultParsed)
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"success": true,
		"result":  resultParsed,
	})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
