// Package auth is the Phase 2a port of bridge/core/auth.ts.
//
// Phase 2a implements the side of auth that doesn't depend on WorkOS:
//
//   - Public-path matching (PUBLIC_PATHS, PUBLIC_PREFIXES, PUBLIC_EXACT,
//     plus the asset-extension regex).
//   - Email allowlist.
//   - Auth log writer (append to bridge/auth-logins.log).
//   - Localhost-trust rule for /proxy/* (Claude-binary calls).
//   - Gate.AuthEnabled flag from env (WORKOS_API_KEY + WORKOS_CLIENT_ID).
//
// What's NOT in Phase 2a:
//
//   - WorkOS OAuth flow (login redirect, callback, accessToken JWT decode).
//     Phase 2b adds this via github.com/workos/workos-go/v4.
//   - Session cookie validation. Phase 2b reads the same session store
//     Express uses (or moves session storage to Go entirely).
//
// Until Phase 2b, the Middleware here can run in "advisory" mode — it
// classifies requests as public/private/restricted and surfaces the
// decision via headers, but doesn't reject anything (Node bridge still
// does the real auth check on the proxied request). Switching to enforce
// mode is one boolean flip in Gate.Enforce.
package auth

import (
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Config carries the env-derived configuration. See FromEnv to populate
// it from the same env vars the Node side reads.
type Config struct {
	WorkOSAPIKey      string
	WorkOSClientID    string
	WorkOSRedirectURI string
	AllowedEmails     []string

	// Path to the append-only auth-logins.log. Defaults to
	// $BRIDGE_ROOT/auth-logins.log resolved at call time.
	LogPath string
}

// FromEnv reads the same environment variables auth.ts uses.
func FromEnv() Config {
	return Config{
		WorkOSAPIKey:      os.Getenv("WORKOS_API_KEY"),
		WorkOSClientID:    os.Getenv("WORKOS_CLIENT_ID"),
		WorkOSRedirectURI: os.Getenv("WORKOS_REDIRECT_URI"),
		AllowedEmails:     parseAllowedEmails(os.Getenv("ALLOWED_EMAILS")),
	}
}

// parseAllowedEmails handles the YHA multi-user grouping format that
// bridge/users/resolver.ts owns. Format:
//
//	`,` separates groups
//	`{...}` optional wrap around a group (stripped, just visual)
//	`;` separates aliases inside a group
//
// All aliases across all groups are "allowed". The first alias of a
// group is the canonical email on the TS side (for per-user folder
// naming) but go-core only needs the flat allow-set so we just collect
// every alias.
//
// Examples (all return the same flat set):
//
//	a@x.com                                 → [a@x.com]
//	a@x.com,b@y.com                         → [a@x.com, b@y.com]
//	{a@x.com;b@y.com}                       → [a@x.com, b@y.com]
//	{a@x.com;b@y.com},{c@z.com}             → [a@x.com, b@y.com, c@z.com]
func parseAllowedEmails(raw string) []string {
	out := []string{}
	for _, group := range strings.Split(raw, ",") {
		group = strings.TrimSpace(group)
		group = strings.TrimPrefix(group, "{")
		group = strings.TrimSuffix(group, "}")
		for _, alias := range strings.Split(group, ";") {
			alias = strings.TrimSpace(alias)
			if alias != "" {
				out = append(out, alias)
			}
		}
	}
	return out
}

// Enabled reports whether WorkOS env vars are present. Mirrors
// AUTH_ENABLED in auth.ts.
func (c Config) Enabled() bool {
	return c.WorkOSAPIKey != "" && c.WorkOSClientID != ""
}

// IsAllowedEmail does the case-insensitive allowlist match. The TS
// side lowercases the email before checking; we do the same so a
// configured "User@Example.com" matches a logged-in "user@example.com".
func (c Config) IsAllowedEmail(email string) bool {
	if email == "" {
		return false
	}
	target := strings.ToLower(email)
	for _, e := range c.AllowedEmails {
		if strings.ToLower(e) == target {
			return true
		}
	}
	return false
}

// ── Path classification ─────────────────────────────────────────────────────

// PublicPaths exactly match req.path or req.path + "/" prefix.
// Mirrors PUBLIC_PATHS in auth.ts. /healthz is the Go-core's native
// liveness check; the bridge's legacy /health stays in the list too.
// /auth/tui-link/start is public because the TUI hits it before any
// browser approval has happened — the link by itself is useless until
// the browser-side approve handler (which IS gated) flips it.
var PublicPaths = []string{
	"/", "/login", "/auth/login", "/auth/callback", "/auth/logout", "/health", "/healthz",
	"/auth/tui-link/start",
}

// PublicPrefixes match req.path.startsWith(prefix).
// Mirrors PUBLIC_PREFIXES in auth.ts. /v1/tui-link/poll/ is public
// because the unauthenticated TUI long-polls this endpoint waiting for
// the browser-side approval to land; the response is useless without
// the matching linkId so leaking the prefix is harmless.
var PublicPrefixes = []string{
	"/assets/", "/css/", "/js/", "/lib/", "/src/", "/uploads/", "/exchange/", "/share/",
	"/v1/tui-link/poll/",
}

// PublicExact match req.path === entry.
// Mirrors PUBLIC_EXACT in auth.ts.
var PublicExact = map[string]struct{}{
	"/favicon.svg":  {},
	"/manifest.json": {},
}

// assetExt matches built-asset filenames (Vite hashes them).
var assetExt = regexp.MustCompile(`(?i)\.(css|js|mjs|map|json|svg|png|jpg|jpeg|gif|webp|ico|woff2?)$`)

// yhaPeerPathRe matches the YHA Net peer endpoints that a not-yet-paired or
// cookieless remote node must reach through the Go front door. These carry NO
// browser session, so the ordinary /v1/* gate would 401 them before the Node
// bridge ever sees them. The bridge performs the real authentication on each
// of these routes — a 10-minute invite secret for the pairing bootstrap
// (join-request / membership-update), or an Ed25519 request signature for
// accepted-member calls — so the front door only needs to forward them.
//
// Must stay in sync with the peer carve-outs in bridge/core/auth.ts
// authMiddleware. Matching is path-only (not method-aware): the bridge router
// is the source of truth for method, and the bridge still verifies the
// invite/signature, so a wrong-method request simply 404s downstream.
var yhaPeerPathRe = regexp.MustCompile(
	`^/v1/peer/networks/[^/]+/(join-request|membership-update|revoke|membership|manifest|offers|model-data|pricing|usage-cost-summary|events|docs/(list|read)|sessions(/[^/]+)?)$`,
)

// IsYhaPeerPath reports whether the path is a YHA Net peer endpoint the front
// door should forward to the bridge unauthenticated. The bridge then enforces
// invite-secret or Ed25519 signature auth itself.
func IsYhaPeerPath(path string) bool {
	return yhaPeerPathRe.MatchString(path)
}

// IsPublicPath returns true when the path can be served without any auth.
// Pure function — easy to unit test.
func IsPublicPath(path string) bool {
	if _, ok := PublicExact[path]; ok {
		return true
	}
	for _, p := range PublicPaths {
		if path == p {
			return true
		}
		if strings.HasPrefix(path, p+"/") {
			return true
		}
	}
	for _, pre := range PublicPrefixes {
		if strings.HasPrefix(path, pre) {
			return true
		}
	}
	return assetExt.MatchString(path)
}

// IsLocalIP reports whether the given remote address looks like a
// loopback connection. Accepts the formats Express sees too:
// "127.0.0.1", "::1", "::ffff:127.0.0.1", and the same with a :port.
// isLocalVersionBypassPath reports version endpoints loopback callers may hit
// without a browser session (operator curl, launcher scripts). Apply is
// included because the bridge only listens on loopback in go-mode.
func isLocalVersionBypassPath(r *http.Request) bool {
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/v1/version":
		return true
	case r.Method == http.MethodPost && r.URL.Path == "/v1/version/check":
		return true
	case r.Method == http.MethodPost && r.URL.Path == "/v1/version/apply":
		return true
	default:
		return false
	}
}

func IsLocalIP(remote string) bool {
	host := remote
	if i := strings.LastIndex(remote, ":"); i > 0 {
		// Strip a trailing :port. Won't disturb "::1" because that has
		// no dot and starts with ":".
		if strings.HasPrefix(remote, "[") {
			if end := strings.Index(remote, "]"); end > 0 {
				host = remote[1:end]
			}
		} else if strings.Count(remote, ":") == 1 {
			host = remote[:i]
		}
	}
	switch host {
	case "127.0.0.1", "::1", "::ffff:127.0.0.1":
		return true
	}
	return false
}

// ── Decision (advisory output of the gate) ─────────────────────────────────

// Decision is what the gate concluded about a request. Phase 2a uses
// this for headers + logging; Phase 2b will act on it (reject 401, etc).
type Decision int

const (
	DecisionPublic     Decision = iota // public path, no session needed
	DecisionLocalProxy                 // /proxy/* from localhost (binary trust)
	DecisionAllow                      // private path, session present and allowed
	DecisionRestricted                 // logged in but not on allowlist
	DecisionUnauth                     // no session, /v1/* or SSE — should 401
	DecisionRedirect                   // no session, browser path — should redirect to /
)

func (d Decision) String() string {
	switch d {
	case DecisionPublic:
		return "public"
	case DecisionLocalProxy:
		return "local-proxy"
	case DecisionAllow:
		return "allow"
	case DecisionRestricted:
		return "restricted"
	case DecisionUnauth:
		return "unauth"
	case DecisionRedirect:
		return "redirect"
	}
	return "unknown"
}

// SessionLookup fetches the session.user equivalent for a request.
// Phase 2a callers can pass nil to opt out of session checks; Phase 2b
// supplies a real implementation backed by the WorkOS session store.
//
// Returns (email, allowed, hasSession). hasSession=false means "no
// session at all"; allowed=false means "session present but not on
// allowlist".
type SessionLookup func(r *http.Request) (email string, allowed bool, hasSession bool)

// Classify is the pure-function half of the middleware. Given a config
// and an optional session lookup, return what the gate would do. Use
// this from tests and from Middleware below.
func Classify(cfg Config, r *http.Request, lookup SessionLookup) Decision {
	if !cfg.Enabled() {
		// AUTH_ENABLED == false: everything passes (matches TS).
		return DecisionAllow
	}
	if IsPublicPath(r.URL.Path) {
		return DecisionPublic
	}
	// YHA Net peer endpoints: forward to the bridge, which authenticates them
	// itself (invite secret or Ed25519 signature). Without this, a remote node
	// pairing/calling over Funnel has no browser session and would be 401'd here.
	if IsYhaPeerPath(r.URL.Path) {
		return DecisionPublic
	}
	if strings.HasPrefix(r.URL.Path, "/proxy/") && IsLocalIP(remoteAddr(r)) {
		return DecisionLocalProxy
	}
	if IsLocalIP(remoteAddr(r)) && isLocalVersionBypassPath(r) {
		return DecisionAllow
	}
	if lookup == nil {
		// No session lookup wired yet — Phase 2a defaults to permissive
		// because Node bridge will do the actual check on the proxied
		// request.
		return DecisionAllow
	}
	email, allowed, hasSession := lookup(r)
	if !hasSession {
		if isAPIPath(r) {
			return DecisionUnauth
		}
		return DecisionRedirect
	}
	if !allowed {
		if r.URL.Path == "/restricted" {
			return DecisionPublic
		}
		if isAPIPath(r) {
			return DecisionRestricted
		}
		return DecisionRestricted
	}
	_ = email
	return DecisionAllow
}

func isAPIPath(r *http.Request) bool {
	if strings.HasPrefix(r.URL.Path, "/v1/") {
		return true
	}
	if strings.Contains(r.Header.Get("Accept"), "text/event-stream") {
		return true
	}
	return false
}

// remoteAddr returns the client address used for the IsLocalIP() trust check.
//
// X-Forwarded-For is only honoured when the immediate TCP peer is itself a
// trusted local proxy (the Node bridge and `tailscale funnel` both connect
// over loopback). The Go front door binds 0.0.0.0, so a direct external client
// could otherwise send `X-Forwarded-For: 127.0.0.1` to win the IsLocalIP()
// check and skip auth on /proxy/* (e.g. the KasmVNC browser surface). When the
// peer is trusted we take the right-most XFF entry — the address our own proxy
// actually observed — rather than the left-most, which is fully client-set.
func remoteAddr(r *http.Request) string {
	if IsLocalIP(r.RemoteAddr) {
		if ff := r.Header.Get("X-Forwarded-For"); ff != "" {
			parts := strings.Split(ff, ",")
			if last := strings.TrimSpace(parts[len(parts)-1]); last != "" {
				return last
			}
		}
	}
	return r.RemoteAddr
}

// ── Gate / Middleware ──────────────────────────────────────────────────────

// Gate carries the runtime config and chooses the enforcement policy.
type Gate struct {
	Cfg     Config
	Lookup  SessionLookup // optional; Phase 2b wires WorkOS session decoder
	Enforce bool          // false = advisory (header only); true = reject
	Logger  func(msg string, kv ...any)
}

// Middleware returns the http.Handler middleware. Default behaviour
// (Enforce=false) is to add an X-Yha-Auth header indicating the gate's
// decision and pass the request on. Setting Enforce=true rejects unauth
// and restricted requests with the same status codes auth.ts uses.
func (g *Gate) Middleware() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			d := Classify(g.Cfg, r, g.Lookup)
			w.Header().Set("X-Yha-Auth", d.String())
			if !g.Enforce {
				next.ServeHTTP(w, r)
				return
			}
			switch d {
			case DecisionPublic, DecisionLocalProxy, DecisionAllow:
				next.ServeHTTP(w, r)
			case DecisionUnauth:
				http.Error(w, `{"error":"Unauthorized"}`, http.StatusUnauthorized)
			case DecisionRestricted:
				if isAPIPath(r) {
					http.Error(w, `{"error":"Access denied"}`, http.StatusForbidden)
					return
				}
				http.Redirect(w, r, "/restricted", http.StatusFound)
			case DecisionRedirect:
				http.Redirect(w, r, "/", http.StatusFound)
			}
		})
	}
}

// ── Auth log ──────────────────────────────────────────────────────────────

// LogEvent appends a single line to bridge/auth-logins.log. The line
// format mirrors auth.ts: `[ISO-8601] event key="value" ...`. Values
// have whitespace collapsed and outer whitespace trimmed.
func LogEvent(logPath, event string, fields map[string]string) error {
	if logPath == "" {
		return errors.New("auth: log path required")
	}
	if err := os.MkdirAll(filepath.Dir(logPath), 0o755); err != nil {
		return fmt.Errorf("auth: mkdir log dir: %w", err)
	}
	parts := []string{
		"[" + time.Now().UTC().Format(time.RFC3339Nano) + "]",
		event,
	}
	// Stable key order so log lines diff cleanly across runs.
	keys := make([]string, 0, len(fields))
	for k, v := range fields {
		if v == "" {
			continue
		}
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		parts = append(parts, fmt.Sprintf(`%s=%q`, k, sanitize(fields[k])))
	}

	// Shared mutex around append so two concurrent log calls can't
	// interleave bytes into a single line.
	logMu.Lock()
	defer logMu.Unlock()
	f, err := os.OpenFile(logPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return fmt.Errorf("auth: open log: %w", err)
	}
	defer f.Close()
	_, err = fmt.Fprint(f, strings.Join(parts, " ")+"\n")
	return err
}

var logMu sync.Mutex

func sanitize(s string) string {
	// Collapse whitespace runs to single spaces and trim — matches
	// sanitizeLogValue in auth.ts.
	var b strings.Builder
	prevSpace := false
	for _, r := range s {
		if r == ' ' || r == '\t' || r == '\n' || r == '\r' {
			if prevSpace {
				continue
			}
			b.WriteByte(' ')
			prevSpace = true
			continue
		}
		b.WriteRune(r)
		prevSpace = false
	}
	return strings.TrimSpace(b.String())
}
