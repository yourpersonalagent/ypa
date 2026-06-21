package auth

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"testing"
)

const testSecret = "openssl-rand-hex-32-output-goes-here"

func TestEncodeVerifyRoundTrip(t *testing.T) {
	const sid = "abc123-very-uid-safe"
	cookie := EncodeExpressSessionCookie(sid, testSecret)
	got, ok := VerifyExpressSessionCookie(cookie, testSecret)
	if !ok {
		t.Fatalf("verify failed for fresh signed cookie %q", cookie)
	}
	if got != sid {
		t.Errorf("session ID = %q, want %q", got, sid)
	}
}

func TestVerifyRejectsTampered(t *testing.T) {
	cookie := EncodeExpressSessionCookie("good", testSecret)
	tampered := cookie[:len(cookie)-3] + "AAA"
	if _, ok := VerifyExpressSessionCookie(tampered, testSecret); ok {
		t.Error("verify accepted tampered signature")
	}
}

func TestVerifyRejectsWrongSecret(t *testing.T) {
	cookie := EncodeExpressSessionCookie("good", testSecret)
	if _, ok := VerifyExpressSessionCookie(cookie, "different-secret"); ok {
		t.Error("verify accepted cookie signed with different secret")
	}
}

func TestVerifyRejectsUnsignedForm(t *testing.T) {
	for _, raw := range []string{"", "abc", "s:no-dot", "raw-session-id"} {
		if _, ok := VerifyExpressSessionCookie(raw, testSecret); ok {
			t.Errorf("verify accepted invalid form %q", raw)
		}
	}
}

func TestVerifyHandlesPercentEncoded(t *testing.T) {
	// Express's cookie middleware uses decodeURIComponent. Percent-
	// encoded sequences like %3A round-trip; '+' stays literal.
	// Make sure our PathUnescape path matches that.
	const sid = "abc:def"
	cookie := EncodeExpressSessionCookie(sid, testSecret)
	pctEncoded := url.PathEscape(cookie) // %3A on the colon, no + tricks
	got, ok := VerifyExpressSessionCookie(pctEncoded, testSecret)
	if !ok {
		t.Fatalf("percent-encoded form rejected: %q", pctEncoded)
	}
	if got != sid {
		t.Errorf("session ID after pct decode = %q, want %q", got, sid)
	}
}

func TestExtractSessionCookieFromRequest(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	r.AddCookie(&http.Cookie{Name: SessionCookieName, Value: "raw-value"})
	if v := ExtractSessionCookie(r); v != "raw-value" {
		t.Errorf("extracted = %q, want raw-value", v)
	}
}

func TestExtractSessionCookieMissing(t *testing.T) {
	r := httptest.NewRequest("GET", "/", nil)
	if v := ExtractSessionCookie(r); v != "" {
		t.Errorf("expected empty for missing cookie, got %q", v)
	}
}

// SignSessionID matches Express's cookie-signature output exactly.
// This pinned vector guards against drift if anyone changes the
// signing helper later. Verified against:
//
//	$ node -e "const cs=require('cookie-signature'); \
//	    console.log(cs.sign('hello','secret'))"
//	hello.iKqz7ejTrflNJquQ07r9SiCDBww7zOnAFO4EpEOEfAs
func TestSignSessionIDKnownVector(t *testing.T) {
	got := SignSessionID("hello", "secret")
	want := "iKqz7ejTrflNJquQ07r9SiCDBww7zOnAFO4EpEOEfAs"
	if got != want {
		t.Errorf("SignSessionID(\"hello\",\"secret\") = %q, want %q", got, want)
	}
}
