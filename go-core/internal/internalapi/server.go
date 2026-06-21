// Package internalapi is the Go port of bridge/chat/openai-internal.ts.
//
// It hosts a loopback-only OpenAI-compatible HTTP server on
// 127.0.0.1:8444 so subprocesses spawned by harness adapters (claude
// CLI, codex, custom user tools) can phone home to reach a different
// model mid-tool-call. Hosting it in Go means the inner `/v1/messages`
// hop survives a Node restart with the same fidelity as the outer
// SSE — the same "chat keeps streaming across any shell pulse" claim
// extends to nested LLM hops.
//
// Routes:
//
//	GET  /v1/models               — model catalog (`provider-slug/model-id`).
//	POST /v1/chat/completions     — streaming + non-streaming chat dispatch.
//
// Auth: `Authorization: Bearer yha_<key>`; fallback to `?api_key=`
// query param or body field. Verification reads
// bridge/api-keys.json's sha256 hash records — same store the Node
// side uses, so existing keys keep working.
//
// Model routing (mirrors `_router` in openai-internal.ts:103-216):
//
//  1. provider.name == "Anthropic Subscription" → spawn the `claude`
//     CLI via Go's existing harness/claudebinary streamer. Out of
//     scope for the Phase 1 port — the route returns 501 with a
//     "subscription path not yet ported" envelope so callers degrade
//     to the Node-hosted endpoint until §8.2-claude lands.
//  2. /^Anthropic( API)?$/ → translate OpenAI request shape to
//     Anthropic /messages, proxy to provider.endpoint/messages with
//     anthropic-version + x-api-key headers.
//  3. anything else → pass-through to provider.endpoint/chat/completions
//     with Authorization: Bearer <api_key> swapped in.
//
// Env vars:
//
//	YHA_INTERNAL_API_DISABLED=true   — disables the server entirely.
//	YHA_INTERNAL_API_PORT=8444       — listen port (default 8444).
//	YHA_INTERNAL_API_HOST=127.0.0.1  — listen host (always loopback).
//
// Telemetry: after each request, the server fires a fire-and-forget
// callback to nodecallback.CostEventClient with the resolved key id +
// (model, prompt, completion, cost). recordKeyUsage on the Node side
// folds this into bridge/api-keys.json's usage.byModel{} block.
package internalapi

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/yha/core/internal/logger"
	"github.com/yha/core/internal/state"
)

// RateLimiter is the per-provider throttle the internal API wraps
// every outbound upstream HTTP call with. Same shape as
// stream.RateLimiter so cmd/yha-core can satisfy both with a single
// rate.Limiter adapter. nil disables throttling.
type RateLimiter interface {
	With(ctx context.Context, provider string, fn func(context.Context) (*http.Response, error)) (*http.Response, error)
}

// DefaultPort is the loopback port the internal API binds when
// $YHA_INTERNAL_API_PORT isn't set. Same default as
// bridge/chat/openai-internal.ts line 41.
const DefaultPort = 8444

// DefaultHost is the bind address — always loopback so the endpoint
// isn't exposed off-box. Override only for tests via $YHA_INTERNAL_API_HOST.
const DefaultHost = "127.0.0.1"

// Deps wires the server to the rest of the daemon. All fields are
// required unless documented otherwise.
type Deps struct {
	// Store provides the live provider catalog + pricing table. The
	// server consults it for every request to resolve model id →
	// provider endpoint + API key, and to compute cost per recorded
	// usage event.
	Store *state.Store

	// Limiter is the per-provider rate limiter shared with the main
	// stream loop. Outbound proxy calls pass through it so a noisy
	// internal-API consumer (e.g. a `codex` invocation chained from a
	// tool call) honours the same per-provider buckets the outer SSE
	// stream does. Optional; when nil the server falls back to direct
	// httpClient.Do.
	Limiter RateLimiter

	// Cost is the fire-and-forget cost-event sink — typically the same
	// *nodecallback.CostEventClient the main stream route uses. After
	// each request the server posts (model, tokens, cost, keyId) so
	// Node's recordKeyUsage folds the usage into api-keys.json.
	// Optional; nil silently skips telemetry.
	Cost CostEventSink

	// VerifyKey resolves a plain-text bearer token (e.g. "yha_AbC123…")
	// to its KeyRecord, or nil when the token is missing/unknown. The
	// production wiring computes sha256(token) and looks it up against
	// the loaded api-keys.json. Tests pass a scripted resolver.
	VerifyKey func(token string) *KeyRecord

	// Logger receives request-level audit lines. Optional; falls back
	// to a discard logger so the package is safe to use in tests.
	Logger *logger.Logger
}

// rateLimiterAdapter is the surface the internal API uses to wrap
// outbound provider HTTP calls in the per-provider rate limiter. Same
// shape as stream.RateLimiter; defined separately here so the package
// doesn't import internal/stream.

// CostEventSink is the surface the internal-API server uses to record
// per-key usage telemetry after each successful request. Production
// wiring satisfies this with the same *nodecallback.CostEventClient
// the main stream route uses; tests pass a recording double.
type CostEventSink interface {
	Record(ctx context.Context, payload CostEventPayload) error
	FireAndForget(label string, fn func(context.Context) error)
}

// CostEventPayload is the per-request body POSTed to Node's
// /internal/cost-event endpoint. Mirrors stream.CostEventPayload but
// adds the bearer KeyID so Node's recordKeyUsage can fold the totals
// into api-keys.json.
type CostEventPayload struct {
	KeyID            string  `json:"keyId,omitempty"`
	Model            string  `json:"model"`
	Provider         string  `json:"provider,omitempty"`
	InputTokens      int     `json:"inputTokens"`
	OutputTokens     int     `json:"outputTokens"`
	CacheReadTokens  int     `json:"cacheReadTokens,omitempty"`
	CacheWriteTokens int     `json:"cacheCreationTokens,omitempty"`
	Cost             float64 `json:"cost,omitempty"`
	DurationMs       int64   `json:"durationMs"`
	Route            string  `json:"route,omitempty"`
}

// Server hosts the OpenAI-compatible loopback endpoint. Construct via
// NewServer; run via Start; tear down via Shutdown.
type Server struct {
	deps   Deps
	host   string
	port   int
	srv    *http.Server
	listen net.Listener
}

// NewServer prepares a Server bound to the configured host:port. Does
// not start the listener — call Start after wiring.
func NewServer(deps Deps) *Server {
	host := os.Getenv("YHA_INTERNAL_API_HOST")
	if host == "" {
		host = DefaultHost
	}
	port := DefaultPort
	if p := os.Getenv("YHA_INTERNAL_API_PORT"); p != "" {
		if v, err := strconv.Atoi(p); err == nil && v > 0 {
			port = v
		}
	}
	if deps.Logger == nil {
		deps.Logger = logger.New(io.Discard)
	}
	return &Server{deps: deps, host: host, port: port}
}

// Disabled reports whether the server is suppressed via
// $YHA_INTERNAL_API_DISABLED. Operators set this to "true" when they
// want Node to keep hosting the endpoint during a transitional
// rollout. Empty / "false" / "0" all mean enabled.
func Disabled() bool {
	v := strings.ToLower(strings.TrimSpace(os.Getenv("YHA_INTERNAL_API_DISABLED")))
	return v == "true" || v == "1" || v == "yes"
}

// Start binds the listener and runs the HTTP server in a goroutine.
// Returns the bound address (handy for tests using :0) and any bind
// error. The server runs until Shutdown is called or the listener
// errors out.
func (s *Server) Start() (string, error) {
	addr := fmt.Sprintf("%s:%d", s.host, s.port)
	l, err := net.Listen("tcp", addr)
	if err != nil {
		return "", fmt.Errorf("internalapi: listen %s: %w", addr, err)
	}
	s.listen = l
	mux := http.NewServeMux()
	s.registerRoutes(mux)

	s.srv = &http.Server{
		Handler:           mux,
		ReadHeaderTimeout: 30 * time.Second,
		// No write timeout — streaming responses can run minutes.
	}
	go func() {
		if err := s.srv.Serve(l); err != nil && !errors.Is(err, http.ErrServerClosed) {
			s.deps.Logger.Warn("internalapi.serve", "err", err)
		}
	}()
	s.deps.Logger.Info("internalapi started", "addr", l.Addr().String())
	return l.Addr().String(), nil
}

// Shutdown halts the listener with the supplied context's timeout.
// Safe to call on a never-started server.
func (s *Server) Shutdown(ctx context.Context) error {
	if s.srv == nil {
		return nil
	}
	return s.srv.Shutdown(ctx)
}

func (s *Server) registerRoutes(mux *http.ServeMux) {
	mux.HandleFunc("GET /v1/models", s.handleModels)
	mux.HandleFunc("POST /v1/chat/completions", s.handleChatCompletions)
	// Helpful debug surface so operators can confirm the server is
	// reachable + the bearer is recognised without firing a real
	// upstream request.
	mux.HandleFunc("GET /v1/me", s.handleMe)
	// Root + catch-all so an accidental browser hit returns the OpenAI
	// shape instead of Go's stock 404 page.
	mux.HandleFunc("/", s.handleNotFound)
}

func (s *Server) handleNotFound(w http.ResponseWriter, r *http.Request) {
	writeError(w, http.StatusNotFound,
		fmt.Sprintf("Unknown route: %s %s", r.Method, r.URL.Path),
		"invalid_request_error", "")
}
