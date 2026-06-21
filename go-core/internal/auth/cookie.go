package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/url"
	"strings"
)

// SessionCookieName is the name express-session uses by default. The
// bridge uses default config (no `name:` override) so this matches.
const SessionCookieName = "connect.sid"

// VerifyExpressSessionCookie verifies a connect.sid cookie value
// against an HMAC secret. The cookie format is the one Express's
// cookie-signature library produces:
//
//	s:<sessionID>.<base64(hmac-sha256(secret, sessionID)) without trailing '=' padding>
//
// Returns the bare sessionID on success. Mismatched signatures return
// ("", false) — callers MUST treat that as "no session" rather than
// reading the unsigned form.
func VerifyExpressSessionCookie(cookieValue, secret string) (sessionID string, ok bool) {
	if cookieValue == "" || secret == "" {
		return "", false
	}
	// Express's cookie module decodes wire values via decodeURIComponent
	// (percent-encoded only — '+' stays as '+'). Mirror that with
	// url.PathUnescape, which handles %XX and leaves other chars alone.
	// url.QueryUnescape would mangle the '+' chars common in base64
	// signatures.
	decoded, err := url.PathUnescape(cookieValue)
	if err != nil {
		decoded = cookieValue // tolerate malformed escapes — Express does too
	}
	if !strings.HasPrefix(decoded, "s:") {
		return "", false
	}
	payload := decoded[2:]
	// Last '.' separates sessionID from signature. uid-safe IDs don't
	// contain dots in practice but scanning from the end is robust.
	dot := strings.LastIndex(payload, ".")
	if dot < 0 {
		return "", false
	}
	candidateID := payload[:dot]
	sigB64 := payload[dot+1:]

	expected := SignSessionID(candidateID, secret)
	if !hmac.Equal([]byte(sigB64), []byte(expected)) {
		return "", false
	}
	return candidateID, true
}

// SignSessionID produces the same signature express's cookie-signature
// library produces. Exported so tests can build round-trip fixtures.
func SignSessionID(sessionID, secret string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(sessionID))
	return strings.TrimRight(base64.StdEncoding.EncodeToString(mac.Sum(nil)), "=")
}

// EncodeExpressSessionCookie produces the value an express server would
// have set for a given session ID. Used by tests; production never
// needs to issue these (Node handles login flow).
func EncodeExpressSessionCookie(sessionID, secret string) string {
	return "s:" + sessionID + "." + SignSessionID(sessionID, secret)
}

// ExtractSessionCookie reads connect.sid from an http.Request, returning
// the raw cookie value (still in the wire form). Empty string when
// missing.
func ExtractSessionCookie(r *http.Request) string {
	c, err := r.Cookie(SessionCookieName)
	if err != nil {
		return ""
	}
	return c.Value
}
