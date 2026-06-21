package auth

import (
	"encoding/base64"
	"strings"
	"testing"
	"time"
)

func TestSignVerifyTrustRoundTrip(t *testing.T) {
	const secret = "shared-with-node"
	in := TrustPayload{Email: "alice@example.com", Name: "Alice", Allowed: true, UserID: "user_1"}
	header, err := SignTrust(secret, in, time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	got, ok := VerifyTrust(secret, header)
	if !ok {
		t.Fatal("verify failed for fresh signature")
	}
	if got.Email != in.Email || got.Name != in.Name || !got.Allowed || got.UserID != in.UserID {
		t.Errorf("payload diverged: got %+v, want %+v", got, in)
	}
	if got.Exp <= time.Now().Unix() {
		t.Errorf("Exp = %d, expected future", got.Exp)
	}
}

func TestSignTrustRequiresSecret(t *testing.T) {
	_, err := SignTrust("", TrustPayload{Email: "x@y"}, 0)
	if err == nil {
		t.Error("empty secret should fail")
	}
}

func TestSignTrustRequiresEmail(t *testing.T) {
	_, err := SignTrust("s", TrustPayload{}, 0)
	if err == nil {
		t.Error("empty email should fail")
	}
}

func TestVerifyRejectsTamperedSignature(t *testing.T) {
	const secret = "s"
	header, _ := SignTrust(secret, TrustPayload{Email: "a@b"}, time.Minute)
	tampered := header[:len(header)-3] + "AAA"
	if _, ok := VerifyTrust(secret, tampered); ok {
		t.Error("tampered header verified")
	}
}

func TestVerifyRejectsTamperedPayload(t *testing.T) {
	const secret = "s"
	header, _ := SignTrust(secret, TrustPayload{Email: "alice@example.com", Allowed: false}, time.Minute)
	dot := strings.IndexByte(header, '.')
	// Replace the payload with a hand-crafted "Allowed: true" — same
	// secret can't sign it without changing the sig too.
	evil := base64.RawURLEncoding.EncodeToString([]byte(`{"e":"hacker@evil.com","a":true,"x":9999999999}`))
	tampered := evil + header[dot:]
	if _, ok := VerifyTrust(secret, tampered); ok {
		t.Error("payload swap verified — signature should not match")
	}
}

func TestVerifyTrustRejectsWrongSecret(t *testing.T) {
	header, _ := SignTrust("real", TrustPayload{Email: "a@b"}, time.Minute)
	if _, ok := VerifyTrust("guess", header); ok {
		t.Error("wrong secret verified")
	}
}

func TestVerifyRejectsExpired(t *testing.T) {
	const secret = "s"
	// Sign with a past exp.
	header, err := SignTrust(secret, TrustPayload{Email: "a@b", Exp: time.Now().Add(-1 * time.Second).Unix()}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := VerifyTrust(secret, header); ok {
		t.Error("expired header verified")
	}
}

func TestVerifyRejectsMalformed(t *testing.T) {
	for _, bad := range []string{
		"",
		"no-dot",
		".only-sig",
		"only-payload.",
		"not-base64$$$.sig",
	} {
		if _, ok := VerifyTrust("s", bad); ok {
			t.Errorf("malformed %q verified", bad)
		}
	}
}

func TestTrustFromSessionPreservesFields(t *testing.T) {
	s := &Session{Email: "a@b", Name: "A", Allowed: true, UserID: "u"}
	p := TrustFromSession(s)
	if p.Email != "a@b" || p.Name != "A" || !p.Allowed || p.UserID != "u" {
		t.Errorf("TrustFromSession dropped fields: %+v", p)
	}
}

func TestTrustFromNilSession(t *testing.T) {
	p := TrustFromSession(nil)
	if p.Email != "" {
		t.Errorf("nil session should produce zero payload, got %+v", p)
	}
}
