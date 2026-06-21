package auth

import (
	"encoding/base64"
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestNewWorkOSClientRequiresAllFields(t *testing.T) {
	_, err := NewWorkOSClient("", "c", "r")
	if err == nil {
		t.Error("empty APIKey should fail")
	}
	_, err = NewWorkOSClient("k", "", "r")
	if err == nil {
		t.Error("empty ClientID should fail")
	}
	_, err = NewWorkOSClient("k", "c", "")
	if err == nil {
		t.Error("empty RedirectURI should fail")
	}
	c, err := NewWorkOSClient("k", "c", "r")
	if err != nil || c == nil {
		t.Errorf("happy path failed: %v", err)
	}
}

func TestExtractSessionIDFromValidJWT(t *testing.T) {
	// Build a fake JWT: header.payload.signature, all base64url-no-pad.
	// Only the payload is parsed; the signature is irrelevant to us.
	payload := mustB64URL([]byte(`{"sid":"session_abc123","other":"ignored"}`))
	header := mustB64URL([]byte(`{"alg":"HS256"}`))
	signature := mustB64URL([]byte("fake-signature"))
	token := header + "." + payload + "." + signature

	got := extractSessionIDFromAccessToken(token)
	if got != "session_abc123" {
		t.Errorf("got %q, want session_abc123", got)
	}
}

func TestExtractSessionIDFromMalformedToken(t *testing.T) {
	for _, bad := range []string{
		"",
		"only-one-segment",
		"two.segments",
		"header.notbase64$$$.signature",
	} {
		got := extractSessionIDFromAccessToken(bad)
		if got != "" {
			t.Errorf("malformed %q produced %q, want empty", bad, got)
		}
	}
}

func TestExtractSessionIDMissingSidClaim(t *testing.T) {
	payload := mustB64URL([]byte(`{"iss":"workos"}`))
	token := "h." + payload + ".s"
	got := extractSessionIDFromAccessToken(token)
	if got != "" {
		t.Errorf("missing sid produced %q, want empty", got)
	}
}

func TestAbsoluteRequestOriginHonoursForwardedProto(t *testing.T) {
	cases := []struct {
		host, fwd, scheme, want string
	}{
		{"example.com", "https", "", "https://example.com"},
		{"example.com", "http,https", "", "http://example.com"}, // first hop wins
		{"example.com", "", "https", "https://example.com"},
		{"example.com", "", "", "http://example.com"},
		{"", "https", "", ""},
	}
	for _, c := range cases {
		got := AbsoluteRequestOrigin(c.host, c.fwd, c.scheme)
		if got != c.want {
			t.Errorf("AbsoluteRequestOrigin(%q,%q,%q) = %q, want %q", c.host, c.fwd, c.scheme, got, c.want)
		}
	}
}

func TestResolveRedirectURIPrefersConfiguredURIForLoopback(t *testing.T) {
	client := &WorkOSClient{RedirectURI: "https://example.your-tailnet.ts.net/auth/callback"}
	for _, host := range []string{"localhost:8442", "127.0.0.1:8443", "[::1]:8443", "LAPTOP-3EJR5D56:8443", "box.local:8443", "192.168.1.23:8443"} {
		req := httptest.NewRequest("GET", "http://"+host+"/auth/login", nil)
		if got := client.ResolveRedirectURI(req); got != client.RedirectURI {
			t.Errorf("ResolveRedirectURI(%q) = %q, want configured %q", host, got, client.RedirectURI)
		}
	}
}

func TestCanonicalLoginURLForLocalOnlyHost(t *testing.T) {
	client := &WorkOSClient{RedirectURI: "https://example.your-tailnet.ts.net/auth/callback"}
	req := httptest.NewRequest("GET", "http://LAPTOP-3EJR5D56:8443/auth/login?prompt=select_account", nil)
	got := client.CanonicalLoginURL(req, "select_account")
	want := "https://example.your-tailnet.ts.net/auth/login?prompt=select_account"
	if got != want {
		t.Errorf("CanonicalLoginURL() = %q, want %q", got, want)
	}
}

func TestResolveRedirectURIKeepsRegisteredPublicHostDynamic(t *testing.T) {
	client := &WorkOSClient{RedirectURI: "https://fallback.example/auth/callback"}
	req := httptest.NewRequest("GET", "http://example.your-tailnet.ts.net/auth/login", nil)
	if got, want := client.ResolveRedirectURI(req), "https://example.your-tailnet.ts.net/auth/callback"; got != want {
		t.Errorf("ResolveRedirectURI() = %q, want %q", got, want)
	}
}

// mustB64URL is a tiny helper for the JWT fixtures. Encodes without
// padding, matching how WorkOS issues access tokens.
func mustB64URL(data []byte) string {
	return strings.TrimRight(base64.URLEncoding.EncodeToString(data), "=")
}

// Quick sanity: json round-trip the AuthenticatedUser shape doesn't
// drop fields. Future-proofs against accidental tag drift.
func TestAuthenticatedUserRoundTrip(t *testing.T) {
	u := AuthenticatedUser{
		ID: "u", Email: "e@x", Name: "N", AccessToken: "tok", WorkOSSessionID: "sid",
	}
	b, err := json.Marshal(u)
	if err != nil {
		t.Fatal(err)
	}
	var got AuthenticatedUser
	if err := json.Unmarshal(b, &got); err != nil {
		t.Fatal(err)
	}
	if got != u {
		t.Errorf("round-trip diverged: %+v", got)
	}
}
