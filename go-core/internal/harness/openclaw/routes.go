// routes.go — HTTP control plane for the OpenClaw harness.
//
// The Node bridge owns the full /v1/partners* CRUD surface (record
// list, create/update/delete, system-prompt persistence). The Go side
// only ports the read-only status endpoint that the bridge can hit to
// know which OpenClaw clients are currently connected — the rest
// stays in Node until Phase 7 absorbs the partners module wholesale.
//
// Routes registered:
//
//	GET  /v1/openclaw/status         — pool status snapshot
//	POST /v1/openclaw/connect        — body {"partnerId":"…"} → Connect
//	POST /v1/openclaw/disconnect     — body {"partnerId":"…"} → Pool.Stop
//	GET  /v1/openclaw/agents         — query host/port/token → list_agents
//
// All POST endpoints are gated by the bridge key (same as MCP's
// /v1/mcp/call) when WithBridgeKey is supplied.

package openclaw

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"
)

// RouteOption configures RegisterRoutes (functional-options).
type RouteOption func(*routeConfig)

type routeConfig struct {
	bridgeKey func() string
}

// WithBridgeKey enables the mutating POST endpoints, gated on the
// x-bridge-key header. The function is invoked per request so callers
// can rotate the key live.
func WithBridgeKey(fn func() string) RouteOption {
	return func(c *routeConfig) { c.bridgeKey = fn }
}

// RegisterRoutes mounts /v1/openclaw/* on mux. log may be nil.
func RegisterRoutes(mux *http.ServeMux, pool *Pool, log Logger, opts ...RouteOption) {
	if log == nil {
		log = noopLogger{}
	}
	cfg := routeConfig{}
	for _, o := range opts {
		o(&cfg)
	}

	mux.HandleFunc("/v1/openclaw/status", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			methodNotAllowed(w, http.MethodGet)
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":      true,
			"clients": pool.List(),
		})
	})

	mux.HandleFunc("/v1/openclaw/agents", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			methodNotAllowed(w, http.MethodGet)
			return
		}
		host := r.URL.Query().Get("host")
		if host == "" {
			writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "host required"})
			return
		}
		portStr := r.URL.Query().Get("port")
		port := 18789
		if portStr != "" {
			if p, err := strconv.Atoi(portStr); err == nil && p > 0 {
				port = p
			}
		}
		token := r.URL.Query().Get("token")
		// Temporary client outside the pool (mirrors openclaw.ts:392-403).
		cl := New(host, port, token, "main", log)
		defer cl.Disconnect()
		connCtx, cancel := context.WithTimeout(r.Context(), HandshakeTimeout+5*time.Second)
		defer cancel()
		if err := cl.Connect(connCtx); err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		payload, err := cl.Send(r.Context(), "agents.list", map[string]any{})
		if err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": err.Error()})
			return
		}
		var resp struct {
			Agents []map[string]any `json:"agents"`
		}
		if err := json.Unmarshal(payload, &resp); err != nil {
			writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": "bad agents.list payload"})
			return
		}
		names := make([]string, 0, len(resp.Agents))
		for _, a := range resp.Agents {
			if v, ok := a["id"].(string); ok && v != "" {
				names = append(names, v)
				continue
			}
			if v, ok := a["name"].(string); ok && v != "" {
				names = append(names, v)
			}
		}
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "agents": names})
	})

	if cfg.bridgeKey != nil {
		mux.HandleFunc("/v1/openclaw/connect", func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				methodNotAllowed(w, http.MethodPost)
				return
			}
			if !checkBridgeKey(r, cfg.bridgeKey) {
				writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": "bad bridge key"})
				return
			}
			var body struct {
				PartnerID string `json:"partnerId"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid JSON body"})
				return
			}
			if body.PartnerID == "" {
				writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "partnerId required"})
				return
			}
			cl, err := pool.Get(body.PartnerID)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": err.Error()})
				return
			}
			connCtx, cancel := context.WithTimeout(r.Context(), HandshakeTimeout+5*time.Second)
			defer cancel()
			if err := cl.Connect(connCtx); err != nil {
				writeJSON(w, http.StatusBadGateway, map[string]any{"ok": false, "error": err.Error()})
				return
			}
			writeJSON(w, http.StatusOK, map[string]any{"ok": true, "connected": cl.IsConnected()})
		})

		mux.HandleFunc("/v1/openclaw/disconnect", func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				methodNotAllowed(w, http.MethodPost)
				return
			}
			if !checkBridgeKey(r, cfg.bridgeKey) {
				writeJSON(w, http.StatusUnauthorized, map[string]any{"ok": false, "error": "bad bridge key"})
				return
			}
			var body struct {
				PartnerID string `json:"partnerId"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "invalid JSON body"})
				return
			}
			if body.PartnerID == "" {
				writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "error": "partnerId required"})
				return
			}
			pool.Stop(body.PartnerID)
			writeJSON(w, http.StatusOK, map[string]any{"ok": true})
		})
	}
}

// ── helpers ────────────────────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func methodNotAllowed(w http.ResponseWriter, allowed string) {
	w.Header().Set("Allow", allowed)
	writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method not allowed"})
}

func checkBridgeKey(r *http.Request, fn func() string) bool {
	want := fn()
	if want == "" {
		return false
	}
	got := r.Header.Get("x-bridge-key")
	if got == "" || len(got) != len(want) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

// ── ensure unused imports don't drift ──────────────────────────────────────

var _ = fmt.Sprintf // keep fmt imported even if helpers don't yet use it
