// Trust-header decorator, bearer-session lookup, TUI link-token store.
// Extracted verbatim from main.go (same package main) — see main.go.

package main

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/yha/core/internal/auth"
	"github.com/yha/core/internal/logger"
	"github.com/yha/core/internal/paths"
)

// trustHeaderDecorator returns a ProxyDecorator that stamps an
// X-Yha-Trust header on outbound proxy requests so Node accepts them
// as authenticated. Two acceptance paths:
//
//  1. Cookie path — request has a valid yha.sid; user info comes from
//     the Go session store.
//  2. Bearer path — request has Authorization: Bearer <YHA_BEARER_TOKEN>;
//     user info is synthesised from $YHA_BEARER_EMAIL (default
//     "yha-cli@local") with allowed=true. Useful for the yha CLI and
//     scripts.
//
// Returns nil (no decorator at all) when SessionStore is nil or
// SESSION_SECRET is empty — Phase 2b legacy fallback.
func trustHeaderDecorator(store *auth.SessionStore, secret string, log *logger.Logger) func(*http.Request) {
	if store == nil || secret == "" {
		return nil
	}
	bearerToken := os.Getenv("YHA_BEARER_TOKEN")
	bearerEmail := os.Getenv("YHA_BEARER_EMAIL")
	if bearerEmail == "" {
		bearerEmail = "yha-cli@local"
	}
	if bearerToken != "" {
		log.Info("bearer auth enabled", "email", bearerEmail)
	}

	return func(r *http.Request) {
		// 1. Bearer fast path. Constant-time compare to avoid timing leaks.
		if bearerToken != "" {
			if h := r.Header.Get("Authorization"); strings.HasPrefix(h, "Bearer ") {
				given := h[len("Bearer "):]
				if len(given) == len(bearerToken) &&
					subtleConstantTimeEq(given, bearerToken) {
					payload := auth.TrustPayload{
						Email:   bearerEmail,
						Name:    "yha CLI",
						Allowed: true,
						UserID:  "cli",
					}
					if header, err := auth.SignTrust(secret, payload, 0); err == nil {
						r.Header.Set(auth.TrustHeaderName, header)
					}
					return
				}
			}
		}

		// 2. Cookie path.
		sess, ok := store.LookupCookieSession(r)
		if !ok {
			return
		}
		header, err := auth.SignTrust(secret, auth.TrustFromSession(sess), 0)
		if err != nil {
			log.Warn("auth.trust.sign", "err", err)
			return
		}
		r.Header.Set(auth.TrustHeaderName, header)
	}
}

// subtleConstantTimeEq compares two equal-length strings in constant time.
// crypto/subtle.ConstantTimeCompare wants []byte; this is a thin wrapper.
func subtleConstantTimeEq(a, b string) bool {
	return subtle.ConstantTimeCompare([]byte(a), []byte(b)) == 1
}

// bearerSessionFromEnv returns a BearerCheck that recognises the same
// $YHA_BEARER_TOKEN the proxy decorator uses. /v1/me native handler
// invokes it so `yha prompt` / `curl -H Authorization: Bearer ...`
// can surface a real (synthetic) identity instead of 401.
func bearerSessionFromEnv() func(*http.Request) *auth.Session {
	token := os.Getenv("YHA_BEARER_TOKEN")
	if token == "" {
		return nil
	}
	email := os.Getenv("YHA_BEARER_EMAIL")
	if email == "" {
		email = "yha-cli@local"
	}
	return func(r *http.Request) *auth.Session {
		h := r.Header.Get("Authorization")
		if !strings.HasPrefix(h, "Bearer ") {
			return nil
		}
		given := h[len("Bearer "):]
		if len(given) != len(token) || !subtleConstantTimeEq(given, token) {
			return nil
		}
		return &auth.Session{
			UserID:  "cli",
			Email:   email,
			Name:    "yha CLI",
			Allowed: true,
		}
	}
}

// bearerAwareLookup wraps the cookie SessionLookup so the enforcing gate
// also accepts Authorization: Bearer requests. Without this, the gate's
// cookie-only lookup classifies every cookieless /v1/* request as
// DecisionUnauth → 401 *before* the request can reach the native handler
// or the Node proxy where bearer validation actually lives. That's what
// made the go-TUI's Sessions + Notes tabs (which authenticate with a
// tui-link bearer, not a browser cookie) return 401 once the gate flipped
// to enforce-by-default on Windows.
//
// The cookie path is untouched: a valid yha.sid still resolves exactly as
// before, so browser auth (the working Linux path) is preserved. Only when
// there is NO valid cookie session do we inspect the bearer, honouring the
// same two token kinds Node and the proxy trust decorator already accept:
//
//   - $YHA_BEARER_TOKEN (static, env) → synthetic allowed CLI identity,
//     matching bearerSessionFromEnv / the proxy decorator.
//   - tui-link tokens minted by the browser-approved /auth/tui-link flow,
//     persisted in bridge/users/<email>/tokens/tui-tokens.json (new layout)
//     or bridge/state/tui-tokens.json (legacy). Validated by reading those
//     files directly — mirrors verifyBearer in bridge/core/tui-link.ts, so
//     no Node round-trip and no YHA_INTERNAL_KEY dependency.
//
// Once the gate allows the request, /v1/sessions/ + /v1/sessions/notes
// fall through the catch-all to Node, whose verifyBearer re-validates the
// forwarded Authorization header; native handlers (stream-direct) are
// served in-process. An invalid or expired bearer still yields no session
// → the gate 401s exactly as it would for an anonymous caller.
func bearerAwareLookup(cookie auth.SessionLookup) auth.SessionLookup {
	envToken := os.Getenv("YHA_BEARER_TOKEN")
	envEmail := os.Getenv("YHA_BEARER_EMAIL")
	if envEmail == "" {
		envEmail = "yha-cli@local"
	}
	return func(r *http.Request) (string, bool, bool) {
		// Browser cookie wins — this path is byte-for-byte the prior behaviour.
		if cookie != nil {
			if email, allowed, has := cookie(r); has {
				return email, allowed, has
			}
		}
		given := bearerTokenFromRequest(r)
		if given == "" {
			return "", false, false
		}
		// 1. Static env bearer ($YHA_BEARER_TOKEN).
		if envToken != "" && len(given) == len(envToken) && subtleConstantTimeEq(given, envToken) {
			return envEmail, true, true
		}
		// 2. tui-link token store(s).
		if email, allowed, ok := lookupTuiLinkToken(given); ok {
			return email, allowed, true
		}
		return "", false, false
	}
}

// bearerTokenFromRequest extracts the raw token from an
// `Authorization: Bearer <token>` header, or "" if absent/malformed.
func bearerTokenFromRequest(r *http.Request) string {
	h := r.Header.Get("Authorization")
	if !strings.HasPrefix(h, "Bearer ") {
		return ""
	}
	return strings.TrimSpace(h[len("Bearer "):])
}

// tuiTokenFile / tuiTokenEntry mirror the on-disk shape of the bridge's
// tui-tokens.json (see persistTokens in bridge/core/tui-link.ts).
type tuiTokenFile struct {
	Tokens []tuiTokenEntry `json:"tokens"`
}

type tuiTokenEntry struct {
	Token     string `json:"token"`
	Email     string `json:"email"`
	Name      string `json:"name"`
	Allowed   bool   `json:"allowed"`
	UserID    string `json:"userId"`
	ExpiresAt int64  `json:"expiresAt"` // Unix seconds; 0 = no expiry
}

// lookupTuiLinkToken validates a bearer token against the bridge's
// tui-link token stores and returns the associated identity. Mirrors
// verifyBearer in bridge/core/tui-link.ts: constant-time match, allowed
// flag honoured, expiry enforced. ok=false means "no live token matched"
// (absent, mismatched, or expired) → the gate treats it as no session.
func lookupTuiLinkToken(given string) (email string, allowed bool, ok bool) {
	now := time.Now().Unix()
	for _, p := range tuiTokenStorePaths() {
		data, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		var f tuiTokenFile
		if err := json.Unmarshal(data, &f); err != nil {
			continue
		}
		for _, t := range f.Tokens {
			if t.Token == "" || len(t.Token) != len(given) {
				continue
			}
			if !subtleConstantTimeEq(t.Token, given) {
				continue
			}
			if t.ExpiresAt > 0 && t.ExpiresAt <= now {
				return "", false, false // matched but expired
			}
			return t.Email, t.Allowed, true
		}
	}
	return "", false, false
}

// tuiTokenStorePaths returns candidate tui-tokens.json paths: every
// per-user store (new layout) plus the legacy shared store. A tui-link
// token is a 32-byte random value, so a match in any file authenticates
// that user regardless of which canonical-email folder it lives under —
// this avoids re-deriving the ALLOWED_EMAILS group→canonical mapping in Go.
func tuiTokenStorePaths() []string {
	root := paths.BridgeRoot()
	out := []string{}
	if entries, err := os.ReadDir(filepath.Join(root, "users")); err == nil {
		for _, e := range entries {
			if e.IsDir() {
				out = append(out, filepath.Join(root, "users", e.Name(), "tokens", "tui-tokens.json"))
			}
		}
	}
	out = append(out, filepath.Join(root, "state", "tui-tokens.json"))
	return out
}
