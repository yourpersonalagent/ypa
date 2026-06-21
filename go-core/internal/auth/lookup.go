package auth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// WhoAmIResult is the user-info bundle returned by /internal/whoami.
type WhoAmIResult struct {
	HasSession bool
	Email      string
	Allowed    bool
	Name       string
	ID         string
}

// LookupClient calls Node's /internal/whoami endpoint to translate a
// session cookie into user info. Phase 2b uses the hybrid model:
//
//  1. Verify the cookie's HMAC signature in Go (cheap pre-filter).
//  2. Forward the cookie to /internal/whoami with X-Yha-Internal-Key.
//  3. Cache the result for c.Cache.ttl so repeated requests don't
//     round-trip every time.
type LookupClient struct {
	NodeURL       string        // e.g. "http://127.0.0.1:8443"
	InternalKey   string        // shared secret with Node (YHA_INTERNAL_KEY env)
	SessionSecret string        // express-session HMAC secret (SESSION_SECRET)
	HTTPClient    *http.Client  // override for tests
	Cache         *Cache
}

// NewLookupClient builds a client with sensible defaults: 5s timeout,
// 30s TTL cache.
func NewLookupClient(nodeURL, internalKey, sessionSecret string) *LookupClient {
	return &LookupClient{
		NodeURL:       strings.TrimRight(nodeURL, "/"),
		InternalKey:   internalKey,
		SessionSecret: sessionSecret,
		HTTPClient:    &http.Client{Timeout: 5 * time.Second},
		Cache:         NewCache(30 * time.Second),
	}
}

// LookupByCookie verifies the cookie locally then asks Node for user
// info. Returns HasSession=false (without error) for any unverifiable
// or unknown session — callers should treat that as "not logged in".
//
// Errors are reserved for transport/configuration problems (Node
// unreachable, bad config). Callers should log them and degrade
// gracefully rather than rejecting the request outright.
func (c *LookupClient) LookupByCookie(ctx context.Context, cookieValue string) (WhoAmIResult, error) {
	if c.InternalKey == "" {
		return WhoAmIResult{}, errors.New("auth: YHA_INTERNAL_KEY not configured")
	}
	if cookieValue == "" {
		return WhoAmIResult{HasSession: false}, nil
	}
	sessionID, ok := VerifyExpressSessionCookie(cookieValue, c.SessionSecret)
	if !ok {
		return WhoAmIResult{HasSession: false}, nil
	}

	if cached, ok := c.Cache.Get(sessionID); ok {
		return cached, nil
	}

	res, err := c.fetch(ctx, cookieValue)
	if err != nil {
		return WhoAmIResult{}, err
	}
	c.Cache.Set(sessionID, res)
	return res, nil
}

// HTTPLookup builds an auth.SessionLookup function that callers wire
// into Gate. The returned function never returns an error; transport
// failures degrade to "no session" so the gate can reject (or, in
// advisory mode, just tag the response).
func (c *LookupClient) HTTPLookup() SessionLookup {
	return func(r *http.Request) (string, bool, bool) {
		cookie := ExtractSessionCookie(r)
		ctx := r.Context()
		res, err := c.LookupByCookie(ctx, cookie)
		if err != nil {
			// Caller has no way to surface this from the lookup
			// signature; treat as no session and rely on transport
			// retries elsewhere. Real failures should be visible in
			// the daemon log via the http transport itself.
			return "", false, false
		}
		return res.Email, res.Allowed, res.HasSession
	}
}

func (c *LookupClient) fetch(ctx context.Context, cookieValue string) (WhoAmIResult, error) {
	body := bytes.NewReader(nil)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.NodeURL+"/internal/whoami", body)
	if err != nil {
		return WhoAmIResult{}, err
	}
	req.Header.Set("X-Yha-Internal-Key", c.InternalKey)
	// Forward the original cookie so Node's express-session middleware
	// can parse and look it up via its own store. We URL-encode the
	// value to match how browsers send it (matters for cookies whose
	// values contain ':' / '+' / '/'.)
	req.Header.Set("Cookie", SessionCookieName+"="+url.QueryEscape(cookieValue))

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return WhoAmIResult{}, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		return WhoAmIResult{}, fmt.Errorf("auth: whoami HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(b)))
	}

	var raw struct {
		HasSession bool   `json:"hasSession"`
		Email      string `json:"email"`
		Allowed    bool   `json:"allowed"`
		Name       string `json:"name"`
		ID         string `json:"id"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&raw); err != nil {
		return WhoAmIResult{}, fmt.Errorf("auth: whoami decode: %w", err)
	}
	return WhoAmIResult{
		HasSession: raw.HasSession,
		Email:      raw.Email,
		Allowed:    raw.Allowed,
		Name:       raw.Name,
		ID:         raw.ID,
	}, nil
}
