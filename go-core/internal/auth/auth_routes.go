package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// OAuth CSRF-state constants. The state value is a random token planted
// in a short-lived cookie at /auth/login and echoed back by WorkOS as the
// `state` query param on /auth/callback. A mismatch (or absence) means the
// callback wasn't initiated by this browser → reject as CSRF.
const (
	oauthStateCookieName = "yha.oauth_state"
	oauthStateTTL        = 10 * time.Minute
)

// RouteDeps wires the auth handlers to their collaborators. Caller
// fills these in once at daemon boot.
type RouteDeps struct {
	WorkOS  *WorkOSClient // nil → /auth/login returns 503
	Store   *SessionStore // session storage + cookie sign/verify
	Cfg     Config        // for the allowlist check during callback
	Secure  bool          // sets Cookie.Secure (false when USE_HTTP=true)
	LogPath string        // optional auth-logins.log path; empty = no log
	Logger  interface {
		Warn(string, ...any)
		Info(string, ...any)
	}
	// BearerCheck, when non-nil, is called by /v1/me before the cookie
	// lookup. If it returns a synthetic Session, that's what the
	// handler reports — useful for the yha CLI hitting /v1/me with a
	// bearer token instead of yha.sid.
	BearerCheck func(*http.Request) *Session
}

// RegisterRoutes mounts /auth/login, /auth/callback, /auth/logout and
// /v1/me on mux. Designed to be called inside the daemon's BeforeProxy
// hook so X-Yha-Core: native is stamped on every response.
func RegisterRoutes(mux *http.ServeMux, deps RouteDeps) {
	mux.HandleFunc("/auth/login", func(w http.ResponseWriter, r *http.Request) {
		loginHandler(w, r, deps)
	})
	mux.HandleFunc("/auth/callback", func(w http.ResponseWriter, r *http.Request) {
		callbackHandler(w, r, deps)
	})
	mux.HandleFunc("/auth/logout", func(w http.ResponseWriter, r *http.Request) {
		logoutHandler(w, r, deps)
	})
	mux.HandleFunc("/v1/me", func(w http.ResponseWriter, r *http.Request) {
		meHandler(w, r, deps)
	})
}

// loginHandler — entry point for the OAuth dance.
//
// If the user already has a valid Go-side session and didn't pass
// prompt=, we short-circuit and redirect them straight into the app
// (matches the TS shortcut for "Enter YHA").
func loginHandler(w http.ResponseWriter, r *http.Request, deps RouteDeps) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	if deps.WorkOS == nil {
		http.Error(w, `{"error":"WorkOS not configured"}`, http.StatusServiceUnavailable)
		return
	}
	prompt := strings.TrimSpace(r.URL.Query().Get("prompt"))

	// Already-logged-in shortcut — only when no prompt override.
	if prompt == "" {
		if sess, ok := deps.Store.LookupCookieSession(r); ok && !sess.Expired() {
			dest := "/ypa"
			if !sess.Allowed {
				dest = "/restricted"
			}
			http.Redirect(w, r, dest, http.StatusFound)
			return
		}
	}

	// LAN/Windows hostnames are useful for discovery but wrong for WorkOS:
	// redirect to the node's configured HTTPS callback origin before issuing the
	// OAuth state cookie, so the callback returns to the same host that owns the
	// state cookie.
	if canonical := deps.WorkOS.CanonicalLoginURL(r, prompt); canonical != "" {
		http.Redirect(w, r, canonical, http.StatusFound)
		return
	}

	// Derive the redirect URI from the incoming request's host so a
	// single WorkOS application can serve multiple nodes (Pi + Windows
	// laptop + funnel). Each derived URI must be registered in the
	// WorkOS Redirects list — WorkOS rejects unknown values.
	// Mint a CSRF state token, plant it in a short-lived cookie, and pass
	// it to WorkOS. The callback rejects any response whose `state` doesn't
	// match this cookie. Fail closed on RNG error: the callback enforces
	// state unconditionally, and a broken crypto/rand would panic at
	// session-create time anyway (SessionStore.GenerateID), so login is
	// impossible in that state regardless.
	state, err := generateOAuthState()
	if err != nil {
		if deps.Logger != nil {
			deps.Logger.Warn("auth.login.state-gen", "err", err)
		}
		http.Error(w, `{"error":"failed to initialize login"}`, http.StatusInternalServerError)
		return
	}
	http.SetCookie(w, issueOAuthStateCookie(state, deps.Secure))

	redirectURI := deps.WorkOS.ResolveRedirectURI(r)
	url, err := deps.WorkOS.AuthorizationURLWithRedirect(prompt, redirectURI, state)
	if err != nil {
		if deps.Logger != nil {
			deps.Logger.Warn("auth.login.url-build", "err", err)
		}
		http.Error(w, `{"error":"failed to build authorization URL"}`, http.StatusInternalServerError)
		return
	}
	http.Redirect(w, r, url, http.StatusFound)
}

// callbackHandler — WorkOS redirects the browser back here with a code.
// We exchange the code for user info, decide whether the email is on
// the allowlist, persist a Session, set the yha.sid cookie, and send
// the browser into the app.
func callbackHandler(w http.ResponseWriter, r *http.Request, deps RouteDeps) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	if deps.WorkOS == nil || deps.Store == nil {
		http.Error(w, `{"error":"auth not configured"}`, http.StatusServiceUnavailable)
		return
	}

	// CSRF: the `state` echoed by WorkOS must match the cookie planted at
	// /auth/login. State is single-use — clear the cookie now so a replay
	// can't reuse it, regardless of how the rest of the callback resolves.
	stateOK := validateOAuthState(r)
	http.SetCookie(w, clearOAuthStateCookie(deps.Secure))
	if !stateOK {
		writeAuthLog(deps, "login_failed", map[string]string{
			"reason": "state_mismatch",
			"ip":     clientIP(r),
		})
		http.Redirect(w, r, "/?error=bad_state", http.StatusFound)
		return
	}

	code := r.URL.Query().Get("code")
	if code == "" {
		writeAuthLog(deps, "login_failed", map[string]string{
			"reason": "missing_code",
			"ip":     clientIP(r),
		})
		http.Redirect(w, r, "/?error=missing_code", http.StatusFound)
		return
	}

	user, err := deps.WorkOS.AuthenticateWithCode(r.Context(), code)
	if err != nil {
		if deps.Logger != nil {
			deps.Logger.Warn("auth.callback.exchange", "err", err)
		}
		writeAuthLog(deps, "login_failed", map[string]string{
			"reason": err.Error(),
			"ip":     clientIP(r),
		})
		http.Redirect(w, r, "/?error=auth_failed", http.StatusFound)
		return
	}

	allowed := deps.Cfg.IsAllowedEmail(user.Email)
	sess, err := deps.Store.Create(user.ID, user.Email, user.Name, allowed, user.WorkOSSessionID)
	if err != nil {
		if deps.Logger != nil {
			deps.Logger.Warn("auth.callback.session-create", "err", err)
		}
		http.Error(w, `{"error":"session create failed"}`, http.StatusInternalServerError)
		return
	}

	http.SetCookie(w, deps.Store.IssueCookie(sess.ID, deps.Secure))
	writeAuthLog(deps, "login_success", map[string]string{
		"email":     user.Email,
		"name":      user.Name,
		"userId":    user.ID,
		"allowed":   fmt.Sprintf("%t", allowed),
		"sessionId": user.WorkOSSessionID,
		"ip":        clientIP(r),
	})

	dest := "/ypa"
	if !allowed {
		dest = "/restricted"
	}
	http.Redirect(w, r, dest, http.StatusFound)
}

// logoutHandler — destroys the local session, clears the cookie, and
// optionally redirects through the WorkOS logout endpoint to also end
// the IdP session (so a subsequent /auth/login can pick a different
// account).
func logoutHandler(w http.ResponseWriter, r *http.Request, deps RouteDeps) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	switchAccount := r.URL.Query().Get("switch") == "1"

	var workosSessionID, email, name, userID string
	var allowed bool
	if sess, ok := deps.Store.LookupCookieSession(r); ok {
		workosSessionID = sess.WorkOSSessionID
		email = sess.Email
		name = sess.Name
		userID = sess.UserID
		allowed = sess.Allowed
		_ = deps.Store.Delete(sess.ID)
	}

	http.SetCookie(w, ClearCookie(deps.Secure))
	writeAuthLog(deps, "logout", map[string]string{
		"email":         email,
		"name":          name,
		"userId":        userID,
		"allowed":       fmt.Sprintf("%t", allowed),
		"sessionId":     workosSessionID,
		"switchAccount": fmt.Sprintf("%t", switchAccount),
		"ip":            clientIP(r),
	})

	loginRedirect := "/"
	if switchAccount {
		loginRedirect = "/auth/login?prompt=select_account"
	}

	if switchAccount && deps.WorkOS != nil && workosSessionID != "" {
		origin := AbsoluteRequestOrigin(r.Host, r.Header.Get("X-Forwarded-Proto"), r.URL.Scheme)
		returnTo := ""
		if origin != "" {
			returnTo = origin + loginRedirect
		}
		if logoutURL, err := deps.WorkOS.LogoutURL(workosSessionID, returnTo); err == nil && logoutURL != "" {
			http.Redirect(w, r, logoutURL, http.StatusFound)
			return
		} else if err != nil && deps.Logger != nil {
			deps.Logger.Warn("auth.logout.workos-url", "err", err)
		}
	}
	http.Redirect(w, r, loginRedirect, http.StatusFound)
}

// meHandler — Go-native /v1/me. Returns the same shape Node's /v1/me
// returns so the existing frontend works unchanged.
func meHandler(w http.ResponseWriter, r *http.Request, deps RouteDeps) {
	if r.Method != http.MethodGet {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")

	// Bearer fast path — lets the yha CLI report identity without yha.sid.
	if deps.BearerCheck != nil {
		if synth := deps.BearerCheck(r); synth != nil {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"id":      synth.UserID,
				"email":   synth.Email,
				"name":    synth.Name,
				"allowed": synth.Allowed,
			})
			return
		}
	}

	sess, ok := deps.Store.LookupCookieSession(r)
	if !ok {
		// Match Node's behaviour: 401 when auth is enabled, empty
		// {} when running open.
		if deps.Cfg.Enabled() {
			w.WriteHeader(http.StatusUnauthorized)
			_ = json.NewEncoder(w).Encode(map[string]string{"error": "Unauthorized"})
			return
		}
		_, _ = w.Write([]byte("{}"))
		return
	}
	_ = json.NewEncoder(w).Encode(map[string]any{
		"id":      sess.UserID,
		"email":   sess.Email,
		"name":    sess.Name,
		"allowed": sess.Allowed,
	})
}

// ── helpers ────────────────────────────────────────────────────────────────

// generateOAuthState returns a 256-bit random, URL-safe CSRF token.
// Returns ("", err) only if the system RNG fails.
func generateOAuthState() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// issueOAuthStateCookie builds the short-lived cookie that carries the
// CSRF state across the WorkOS round-trip. Scoped to /auth so it's only
// sent to the auth endpoints (the callback lives at /auth/callback).
// SameSite=Lax so it survives the top-level GET redirect back from WorkOS.
func issueOAuthStateCookie(state string, secure bool) *http.Cookie {
	return &http.Cookie{
		Name:     oauthStateCookieName,
		Value:    state,
		Path:     "/auth",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(oauthStateTTL.Seconds()),
	}
}

// clearOAuthStateCookie expires the state cookie. State is single-use —
// cleared on both success and failure of the callback.
func clearOAuthStateCookie(secure bool) *http.Cookie {
	return &http.Cookie{
		Name:     oauthStateCookieName,
		Value:    "",
		Path:     "/auth",
		HttpOnly: true,
		Secure:   secure,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	}
}

// validateOAuthState constant-time-compares the `state` query param against
// the cookie planted at /auth/login. Returns false if either is missing or
// they differ — i.e. the callback wasn't initiated by this browser.
func validateOAuthState(r *http.Request) bool {
	got := r.URL.Query().Get("state")
	if got == "" {
		return false
	}
	c, err := r.Cookie(oauthStateCookieName)
	if err != nil || c.Value == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(got), []byte(c.Value)) == 1
}

func clientIP(r *http.Request) string {
	if ff := r.Header.Get("X-Forwarded-For"); ff != "" {
		if i := strings.Index(ff, ","); i >= 0 {
			return strings.TrimSpace(ff[:i])
		}
		return strings.TrimSpace(ff)
	}
	return r.RemoteAddr
}

func writeAuthLog(deps RouteDeps, event string, fields map[string]string) {
	if deps.LogPath == "" {
		return
	}
	if err := LogEvent(deps.LogPath, event, fields); err != nil {
		if deps.Logger != nil {
			deps.Logger.Warn("auth.log.write", "err", err)
		}
	}
}
