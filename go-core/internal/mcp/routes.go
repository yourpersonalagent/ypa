// HTTP control plane for the MCP pool.
//
// Mirrors the /v1/mcp/* routes defined in
// bridge/modules/mcp-client/lib/routes.ts but using the stdlib
// http.ServeMux. The materialize hook (which writes Claude/Codex
// spawn-config files) is intentionally not ported here — it lands in a
// later phase. external-sharing toggle, knowledge/build, and tool-group
// discovery are also out of scope: this file is the minimum surface to
// drive Pool from outside.
//
// Routes registered:
//   GET  /v1/mcp/state  — server status snapshot
//   POST /v1/mcp/start  — body {"name": "..."} → starts a server
//   POST /v1/mcp/stop   — body {"name": "..."} → stops a server
//   GET  /v1/mcp/tools  — aggregated tool listing across the pool
//   POST /v1/mcp/call   — body {"server":..., "tool":..., "arguments":...}
//                         (only registered when a BridgeKey option is
//                         supplied — the call route is the dispatch path
//                         Node delegates to and so requires x-bridge-key
//                         auth)
package mcp

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/yha/core/internal/logger"
)

// startStopHandshakeTimeout is the budget for the synchronous handshake
// from the start route. Mirrors the JS side (~10s) and is short enough
// that a wedged child can't pin the HTTP worker indefinitely.
const startStopHandshakeTimeout = 10 * time.Second

// defaultCallTimeout caps the wait for a standard MCP tools/call.
// Mirrors the JS side's 60s timeout in _callMcpToolRaw.
const defaultCallTimeout = 60 * time.Second

// slowServerTimeouts maps MCP server names to a custom per-call ceiling.
// Servers whose tools legitimately run for many minutes go here:
//   - media-gen   → 5 min  (Lyria audio ≤ 2 min render, Veo video ≤ 3 min)
//   - agent-tools → 20 min (call_agent runs a full sub-agent turn; expected
//                           to grow toward 60+ min as agents get smarter —
//                           the matching Express middleware in bridge/server.ts
//                           and the stub transport must scale together)
var slowServerTimeouts = map[string]time.Duration{
	"media-gen":   5 * time.Minute,
	"agent-tools": 20 * time.Minute,
}

func callTimeoutFor(server string) time.Duration {
	if d, ok := slowServerTimeouts[server]; ok {
		return d
	}
	return defaultCallTimeout
}

// RouteOption configures RegisterRoutes. Functional-options style so
// future knobs (allowlists, etc.) can land without breaking callers.
type RouteOption func(*routeConfig)

type routeConfig struct {
	bridgeKey func() string
}

// WithBridgeKey enables the POST /v1/mcp/call endpoint, gated by the
// x-bridge-key header. The function is invoked per request so callers
// can rotate the key live (yha.sh writes it into env at boot; the Go
// state.Store reads it at NewStore time; a future rotation step can
// just point this fn at a fresh source).
func WithBridgeKey(fn func() string) RouteOption {
	return func(c *routeConfig) { c.bridgeKey = fn }
}

// RegisterRoutes mounts the control-plane endpoints on mux. The pool,
// registryPath, and statePath are captured by the closures so the
// handlers can mutate state.
func RegisterRoutes(mux *http.ServeMux, pool *Pool, registryPath, statePath string, log *logger.Logger, opts ...RouteOption) {
	if log == nil {
		log = logger.New(discardWriter{})
	}
	cfg := routeConfig{}
	for _, o := range opts {
		o(&cfg)
	}
	mux.HandleFunc("/v1/mcp/state", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			methodNotAllowed(w, http.MethodGet)
			return
		}
		handleState(w, pool, statePath, log)
	})
	mux.HandleFunc("/v1/mcp/start", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			methodNotAllowed(w, http.MethodPost)
			return
		}
		handleStart(w, r, pool, registryPath, statePath, log)
	})
	mux.HandleFunc("/v1/mcp/stop", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			methodNotAllowed(w, http.MethodPost)
			return
		}
		handleStop(w, r, pool, statePath, log)
	})
	mux.HandleFunc("/v1/mcp/tools", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			methodNotAllowed(w, http.MethodGet)
			return
		}
		handleTools(w, pool)
	})
	if cfg.bridgeKey != nil {
		mux.HandleFunc("/v1/mcp/call", func(w http.ResponseWriter, r *http.Request) {
			if r.Method != http.MethodPost {
				methodNotAllowed(w, http.MethodPost)
				return
			}
			if !checkBridgeKey(r, cfg.bridgeKey) {
				writeJSON(w, http.StatusUnauthorized, callResponse{OK: false, Error: "bad bridge key"})
				return
			}
			handleCall(w, r, pool)
		})
	}
}

// ── Handlers ──────────────────────────────────────────────────────────────

type stateServer struct {
	Name       string `json:"name"`
	OK         bool   `json:"ok"`
	Error      string `json:"error,omitempty"`
	ToolsCount int    `json:"tools_count"`
}

type stateResponse struct {
	Servers []stateServer `json:"servers"`
	Running []string      `json:"running"`
}

func handleState(w http.ResponseWriter, pool *Pool, statePath string, log *logger.Logger) {
	conns := pool.List()
	resp := stateResponse{Servers: make([]stateServer, 0, len(conns)), Running: []string{}}
	for _, c := range conns {
		c.infoMu.RLock()
		ok := c.OK
		errStr := ""
		if c.Err != nil {
			errStr = c.Err.Error()
		}
		toolsCount := len(c.Tools)
		c.infoMu.RUnlock()
		resp.Servers = append(resp.Servers, stateServer{
			Name:       c.Name,
			OK:         ok,
			Error:      errStr,
			ToolsCount: toolsCount,
		})
		if c.alive() {
			resp.Running = append(resp.Running, c.Name)
		}
	}
	// Best-effort persist of the running set so a daemon restart can
	// autostart what was up. State-file failures are logged but not
	// propagated to the HTTP response — the snapshot itself is fine.
	if statePath != "" {
		cur, _ := LoadState(statePath)
		cur.Running = append([]string(nil), resp.Running...)
		if err := SaveState(statePath, cur); err != nil {
			log.Warn("mcp.state-save-failed", "err", err)
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

type startStopRequest struct {
	Name string `json:"name"`
}

type startResponse struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

func handleStart(w http.ResponseWriter, r *http.Request, pool *Pool, registryPath, statePath string, log *logger.Logger) {
	var req startStopRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, startResponse{OK: false, Error: "invalid JSON body"})
		return
	}
	if req.Name == "" {
		writeJSON(w, http.StatusBadRequest, startResponse{OK: false, Error: "name required"})
		return
	}
	registry, err := LoadRegistry(registryPath)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, startResponse{OK: false, Error: err.Error()})
		return
	}
	cfg, ok := registry[req.Name]
	if !ok {
		writeJSON(w, http.StatusNotFound, startResponse{OK: false, Error: fmt.Sprintf("unknown MCP server: %s", req.Name)})
		return
	}

	ctx, cancel := context.WithTimeout(r.Context(), startStopHandshakeTimeout+2*time.Second)
	defer cancel()
	conn, err := pool.Start(ctx, cfg, startStopHandshakeTimeout)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, startResponse{OK: false, Error: err.Error()})
		return
	}

	conn.infoMu.RLock()
	startErr := ""
	if conn.Err != nil {
		startErr = conn.Err.Error()
	}
	startedOK := conn.OK
	conn.infoMu.RUnlock()

	persistRunning(pool, statePath, log)

	writeJSON(w, http.StatusOK, startResponse{OK: startedOK, Error: startErr})
}

func handleStop(w http.ResponseWriter, r *http.Request, pool *Pool, statePath string, log *logger.Logger) {
	var req startStopRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, startResponse{OK: false, Error: "invalid JSON body"})
		return
	}
	if req.Name == "" {
		writeJSON(w, http.StatusBadRequest, startResponse{OK: false, Error: "name required"})
		return
	}
	if err := pool.Stop(req.Name); err != nil {
		writeJSON(w, http.StatusInternalServerError, startResponse{OK: false, Error: err.Error()})
		return
	}
	persistRunning(pool, statePath, log)
	writeJSON(w, http.StatusOK, startResponse{OK: true})
}

type toolsResponse struct {
	Servers map[string][]Tool `json:"servers"`
}

func handleTools(w http.ResponseWriter, pool *Pool) {
	out := toolsResponse{Servers: map[string][]Tool{}}
	for _, c := range pool.List() {
		out.Servers[c.Name] = c.snapshotTools()
	}
	writeJSON(w, http.StatusOK, out)
}

type callRequest struct {
	Server    string         `json:"server"`
	Tool      string         `json:"tool"`
	Arguments map[string]any `json:"arguments"`
}

type callResponse struct {
	OK     bool           `json:"ok"`
	Result map[string]any `json:"result,omitempty"`
	Error  string         `json:"error,omitempty"`
}

func handleCall(w http.ResponseWriter, r *http.Request, pool *Pool) {
	var req callRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, callResponse{OK: false, Error: "invalid JSON body"})
		return
	}
	if req.Server == "" {
		writeJSON(w, http.StatusBadRequest, callResponse{OK: false, Error: "server required"})
		return
	}
	if req.Tool == "" {
		writeJSON(w, http.StatusBadRequest, callResponse{OK: false, Error: "tool required"})
		return
	}
	conn, ok := pool.Get(req.Server)
	if !ok {
		writeJSON(w, http.StatusNotFound, callResponse{OK: false, Error: fmt.Sprintf("unknown MCP server: %s", req.Server)})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), callTimeoutFor(req.Server))
	defer cancel()
	result, err := conn.CallTool(ctx, req.Tool, req.Arguments)
	if err != nil {
		writeJSON(w, http.StatusOK, callResponse{OK: false, Error: err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, callResponse{OK: true, Result: result})
}

// checkBridgeKey returns true when the x-bridge-key header matches the
// value supplied by the configured fn. Uses crypto/subtle so a timing
// side-channel can't be used to extract the key one byte at a time.
func checkBridgeKey(r *http.Request, fn func() string) bool {
	want := fn()
	if want == "" {
		return false
	}
	got := r.Header.Get("x-bridge-key")
	if got == "" {
		return false
	}
	if len(got) != len(want) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

// ── helpers (private) ──────────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func methodNotAllowed(w http.ResponseWriter, allowed string) {
	w.Header().Set("Allow", allowed)
	writeJSON(w, http.StatusMethodNotAllowed, map[string]any{"ok": false, "error": "method not allowed"})
}

// persistRunning rewrites mcp-state.json with the current pool's alive
// connections. ExternalSharing is preserved from the existing file.
func persistRunning(pool *Pool, statePath string, log *logger.Logger) {
	if statePath == "" {
		return
	}
	cur, _ := LoadState(statePath)
	running := make([]string, 0)
	for _, c := range pool.List() {
		if c.alive() {
			running = append(running, c.Name)
		}
	}
	cur.Running = running
	if err := SaveState(statePath, cur); err != nil {
		log.Warn("mcp.state-save-failed", "err", err)
	}
}

// discardWriter satisfies io.Writer for the no-op logger fallback. We
// can't import io.Discard here without dragging "io" in for one symbol.
type discardWriter struct{}

func (discardWriter) Write(p []byte) (int, error) { return len(p), nil }
