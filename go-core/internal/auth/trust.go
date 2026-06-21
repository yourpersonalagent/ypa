package auth

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

// TrustHeaderName is the HTTP header the Go core sets on every request
// it forwards to the Node bridge after authenticating the user via
// yha.sid. Node's auth middleware verifies + populates req.session.user
// from the payload, allowing the existing /v1/* surface to work with
// Go-issued sessions without dual-cookie complexity.
const TrustHeaderName = "X-Yha-Trust"

// DefaultTrustTTL is the lifetime baked into each header. Short by
// design — Go re-mints on every proxied request, so a long TTL gains
// nothing and a short one limits replay if the header ever leaks.
const DefaultTrustTTL = 60 * time.Second

// TrustPayload is the user-info bundle Go signs and Node trusts.
// Short JSON field names keep the header compact under typical HTTP
// header-size limits.
type TrustPayload struct {
	Email   string `json:"e"`
	Name    string `json:"n,omitempty"`
	Allowed bool   `json:"a"`
	UserID  string `json:"u,omitempty"`
	Exp     int64  `json:"x"` // unix seconds
}

// SignTrust returns "<base64url-payload>.<base64url-signature>" using
// HMAC-SHA256 over the encoded payload with the given secret.
//
// If user.Exp is zero, it's filled in as time.Now()+ttl. ttl <= 0
// falls back to DefaultTrustTTL.
func SignTrust(secret string, user TrustPayload, ttl time.Duration) (string, error) {
	if secret == "" {
		return "", errors.New("auth: empty trust secret")
	}
	if ttl <= 0 {
		ttl = DefaultTrustTTL
	}
	if user.Exp == 0 {
		user.Exp = time.Now().Add(ttl).Unix()
	}
	if user.Email == "" {
		return "", errors.New("auth: trust payload requires Email")
	}
	body, err := json.Marshal(user)
	if err != nil {
		return "", err
	}
	payload := base64.RawURLEncoding.EncodeToString(body)
	sig := signTrustRaw(secret, payload)
	return payload + "." + sig, nil
}

// VerifyTrust validates the header. Returns (payload, true) iff the
// signature is correct AND the payload hasn't expired. Returns
// (nil, false) on any failure with no extra error context — callers
// log the raw header at most.
func VerifyTrust(secret, header string) (*TrustPayload, bool) {
	if header == "" || secret == "" {
		return nil, false
	}
	dot := strings.IndexByte(header, '.')
	if dot <= 0 || dot >= len(header)-1 {
		return nil, false
	}
	payload, sig := header[:dot], header[dot+1:]
	expected := signTrustRaw(secret, payload)
	if !hmac.Equal([]byte(sig), []byte(expected)) {
		return nil, false
	}
	body, err := base64.RawURLEncoding.DecodeString(payload)
	if err != nil {
		return nil, false
	}
	var p TrustPayload
	if err := json.Unmarshal(body, &p); err != nil {
		return nil, false
	}
	if p.Exp <= 0 || time.Now().Unix() > p.Exp {
		return nil, false
	}
	return &p, true
}

func signTrustRaw(secret, payload string) string {
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
}

// TrustFromSession is a small helper: build a TrustPayload from a
// Session. Caller passes the result to SignTrust.
func TrustFromSession(s *Session) TrustPayload {
	if s == nil {
		return TrustPayload{}
	}
	return TrustPayload{
		Email:   s.Email,
		Name:    s.Name,
		Allowed: s.Allowed,
		UserID:  s.UserID,
	}
}
