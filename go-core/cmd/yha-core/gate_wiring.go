// Auth gate + stream rate-limit wiring.
// Extracted verbatim from main.go (same package main) — see main.go.

package main

import (
	"context"
	"net/http"
	"os"

	"github.com/yha/core/internal/auth"
	"github.com/yha/core/internal/logger"
	"github.com/yha/core/internal/paths"
	"github.com/yha/core/internal/rate"
	"github.com/yha/core/internal/state"
)

// authEnforceEnabled reports whether the auth gate should REJECT (not merely
// tag) unauthenticated/restricted requests. Fail-closed: enforcement is ON
// unless explicitly disabled with YHA_GO_AUTH_ENFORCE=0.
//
// This is safe to default-on: auth.Classify() still returns DecisionAllow for
// every request when WorkOS auth is disabled (cfg.Enabled()==false) or when no
// session lookup is wired, and login/callback paths are public. So flipping the
// default only bites the genuinely dangerous case — auth IS configured but the
// gate was previously advisory, serving native handlers (exec, sessions,
// /internal/*) without ever rejecting an unauthenticated caller.
func authEnforceEnabled() bool {
	return os.Getenv("YHA_GO_AUTH_ENFORCE") != "0"
}

// goBindHost picks the TCP listen host. With WorkOS auth enabled the gate
// protects the surface, so we bind all interfaces (empty host). With auth
// disabled we bind loopback only — an unauthenticated front door must never
// be network-reachable. YHA_GO_BIND_HOST is an explicit operator override for
// both cases. A Unix-socket deployment ignores this entirely.
func goBindHost(authEnabled bool) string {
	if h := os.Getenv("YHA_GO_BIND_HOST"); h != "" {
		return h
	}
	if authEnabled {
		return ""
	}
	return "127.0.0.1"
}

// buildAuthGate (Phase 2b) is the legacy hybrid path: Go reads sessions
// via Node's /internal/whoami. Kept for fallback only.
func buildAuthGate(nodeURL string, log *logger.Logger) *auth.Gate {
	cfg := auth.FromEnv()
	enforce := authEnforceEnabled()
	g := &auth.Gate{Cfg: cfg, Enforce: enforce}
	sessionSecret := os.Getenv("SESSION_SECRET")
	internalKey := os.Getenv("YHA_INTERNAL_KEY")
	if cfg.Enabled() && sessionSecret != "" && internalKey != "" {
		client := auth.NewLookupClient(nodeURL, internalKey, sessionSecret)
		g.Lookup = client.HTTPLookup()
		log.Info("auth gate (legacy hybrid)", "enforce", enforce, "lookup", "node-whoami")
	} else {
		log.Info("auth gate (no lookup)", "enforce", enforce, "auth_enabled", cfg.Enabled())
	}
	return g
}

// buildAuthGateV2 (Phase 2d) is the Go-native path. When SESSION_SECRET
// is set the daemon owns the session store; on top of that, when
// WorkOS env vars are present, Go also owns the OAuth flow.
//
// Returns:
//
//	gate         — always non-nil; classifies requests + tags X-Yha-Auth
//	sessionStore — non-nil iff SESSION_SECRET is set (file store ready)
//	workosClient — non-nil iff WorkOS env vars are set (auth routes ok)
//
// Three modes:
//   - full (store + WorkOS): /auth/* + /v1/me are Go-native; gate.Lookup
//     reads yha.sid cookie directly. Phase 2d goal state.
//   - store-only (no WorkOS): Go can read its own sessions but can't
//     mint new ones; existing sessions still work, login proxies to Node.
//   - neither: falls back to buildAuthGate (Phase 2b hybrid) so Phase 1
//     proxy behaviour stays intact.
func buildAuthGateV2(nodeURL string, log *logger.Logger) (*auth.Gate, *auth.SessionStore, *auth.WorkOSClient, string, string) {
	cfg := auth.FromEnv()
	enforce := authEnforceEnabled()
	sessionSecret := os.Getenv("SESSION_SECRET")

	if sessionSecret == "" {
		// Can't open the store; fall back to legacy hybrid lookup.
		// "hybrid" if WorkOS env is present so the Node /internal/whoami
		// path is wired; otherwise nothing's wired = "passthrough".
		mode := "hybrid"
		if !cfg.Enabled() {
			mode = "passthrough"
		}
		return buildAuthGate(nodeURL, log), nil, nil, mode, ""
	}

	storePath := paths.BridgeRoot() + "/sessions/auth"
	store, err := auth.NewSessionStore(storePath, sessionSecret, auth.DefaultSessionTTL)
	if err != nil {
		log.Warn("auth store init failed — falling back to hybrid lookup", "err", err)
		mode := "hybrid"
		if !cfg.Enabled() {
			mode = "passthrough"
		}
		return buildAuthGate(nodeURL, log), nil, nil, mode, ""
	}

	gate := &auth.Gate{Cfg: cfg, Enforce: enforce, Lookup: bearerAwareLookup(store.CookieLookup())}

	var wc *auth.WorkOSClient
	if cfg.Enabled() {
		w, werr := auth.NewWorkOSClient(cfg.WorkOSAPIKey, cfg.WorkOSClientID, cfg.WorkOSRedirectURI)
		if werr != nil {
			log.Warn("WorkOS client init failed — /auth/* will not be Go-native", "err", werr)
		} else {
			wc = w
		}
	}

	mode := "store-only"
	logMode := "store-only"
	if wc != nil {
		mode = "full"
		logMode = "full (Go-owned sessions + OAuth)"
	}
	log.Info("auth gate (Phase 2d)",
		"mode", logMode,
		"enforce", enforce,
		"store_dir", storePath,
		"workos_enabled", cfg.Enabled(),
	)
	return gate, store, wc, mode, storePath
}

// streamLimiterAdapter narrows *rate.Limiter down to the surface
// stream.RateLimiter expects — drops the attempt counter so the loop
// signature stays small. The underlying limiter still records per-bucket
// 429 / retry counters; this adapter just hides them from the loop.
type streamLimiterAdapter struct {
	l *rate.Limiter
}

func (a streamLimiterAdapter) With(
	ctx context.Context,
	provider string,
	fn func(context.Context) (*http.Response, error),
) (*http.Response, error) {
	resp, _, err := a.l.With(ctx, provider, fn, rate.WithOpts{})
	return resp, err
}

// rateConfigFromStore builds a ConfigFn that reads
// config.defaults.rateLimit.<provider>.{rpm,concurrency} via the loaded
// state. Mirrors _readCfg() in rate-limiter.ts.
func rateConfigFromStore(store *state.Store) rate.ConfigFn {
	return func(provider string) rate.Config {
		cfg := store.Config()
		root, _ := cfg.Defaults["rateLimit"].(map[string]any)
		if root == nil {
			return rate.Config{}
		}
		out := rate.Config{}
		if def, ok := root["default"].(map[string]any); ok {
			if r, ok := numAsInt(def["rpm"]); ok {
				out.RPM = r
			}
			if c, ok := numAsInt(def["concurrency"]); ok {
				out.Concurrency = c
			}
		}
		if own, ok := root[provider].(map[string]any); ok {
			if r, ok := numAsInt(own["rpm"]); ok {
				out.RPM = r
			}
			if c, ok := numAsInt(own["concurrency"]); ok {
				out.Concurrency = c
			}
		}
		return out
	}
}
