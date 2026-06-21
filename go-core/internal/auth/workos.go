package auth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"

	"github.com/workos/workos-go/v4/pkg/usermanagement"
)

// WorkOSClient is a thin wrapper over the v4 SDK that returns shapes
// the rest of internal/auth uses. Keeps the SDK contained so swapping
// it out (or stubbing in tests) only touches this file.
type WorkOSClient struct {
	APIKey      string
	ClientID    string
	RedirectURI string

	client *usermanagement.Client
}

// NewWorkOSClient builds the SDK client. APIKey is the secret,
// ClientID + RedirectURI must match what's configured in the WorkOS
// dashboard.
func NewWorkOSClient(apiKey, clientID, redirectURI string) (*WorkOSClient, error) {
	if apiKey == "" || clientID == "" || redirectURI == "" {
		return nil, errors.New("auth: WorkOS APIKey + ClientID + RedirectURI all required")
	}
	return &WorkOSClient{
		APIKey:      apiKey,
		ClientID:    clientID,
		RedirectURI: redirectURI,
		client:      usermanagement.NewClient(apiKey),
	}, nil
}

// AuthorizationURL generates the URL the browser should be redirected
// to, using the client's configured static RedirectURI. Kept for
// backwards compat / non-HTTP callers; HTTP handlers should prefer
// AuthorizationURLWithRedirect to support multi-node deployments where
// each host has its own callback URL.
func (w *WorkOSClient) AuthorizationURL(prompt string) (string, error) {
	return w.AuthorizationURLWithRedirect(prompt, w.RedirectURI, "")
}

// AuthorizationURLWithRedirect lets the caller override the redirect URI
// per-request. Used by loginHandler to derive the callback URL from the
// incoming request's host so a single WorkOS application can serve
// multiple nodes (Pi + Windows laptop + funnel) without per-host env
// overrides. Every URI passed here must be registered in the WorkOS
// dashboard's Redirects list — WorkOS rejects unregistered values.
//
// state is an opaque CSRF token echoed back on the callback; pass "" to
// omit it. WorkOS round-trips it verbatim as the `state` query param.
func (w *WorkOSClient) AuthorizationURLWithRedirect(prompt, redirectURI, state string) (string, error) {
	if redirectURI == "" {
		redirectURI = w.RedirectURI
	}
	u, err := w.client.GetAuthorizationURL(usermanagement.GetAuthorizationURLOpts{
		ClientID:    w.ClientID,
		RedirectURI: redirectURI,
		Provider:    "authkit",
		State:       state,
	})
	if err != nil {
		return "", fmt.Errorf("auth: WorkOS AuthorizationURL: %w", err)
	}
	if prompt = strings.TrimSpace(prompt); prompt != "" {
		q := u.Query()
		q.Set("prompt", prompt)
		u.RawQuery = q.Encode()
	}
	return u.String(), nil
}

// ResolveRedirectURI derives the WorkOS callback URL from an incoming
// HTTP request. Mirrors the bridge's resolveRedirectUri() so behaviour
// is identical whether go-core handles /auth/* natively (Phase 2d) or
// proxies to bun.
//
// Preference order for host:
//  1. X-Forwarded-Host (set by reverse proxies — but if go-core IS the
//     front door, this is rarely populated)
//  2. r.Host — the client's literal Host header
//
// Preference order for scheme:
//  1. X-Forwarded-Proto
//  2. .ts.net / .tailscale.net host suffix → https (tailscale funnel
//     terminates TLS and forwards as plain HTTP)
//  3. https if r.TLS != nil, else http
func (w *WorkOSClient) ResolveRedirectURI(r *http.Request) string {
	fwdHost := r.Header.Get("X-Forwarded-Host")
	if i := strings.Index(fwdHost, ","); i >= 0 {
		fwdHost = strings.TrimSpace(fwdHost[:i])
	}
	host := strings.TrimSpace(fwdHost)
	if host == "" {
		host = r.Host
	}
	if host == "" {
		return w.RedirectURI
	}
	// Go-core is the public front door and the Bun bridge is an internal
	// loopback upstream. If a browser-control client accidentally enters via a
	// localhost URL, never send that unregistered callback to WorkOS: bounce
	// through the operator-configured canonical redirect instead. Non-loopback
	// hosts remain dynamic so one WorkOS application can still serve multiple
	// registered YHA nodes.
	if isLocalOnlyHost(host) {
		return w.RedirectURI
	}
	fwdProto := r.Header.Get("X-Forwarded-Proto")
	if i := strings.Index(fwdProto, ","); i >= 0 {
		fwdProto = strings.TrimSpace(fwdProto[:i])
	}
	proto := strings.TrimSpace(fwdProto)
	if proto == "" {
		if strings.HasSuffix(host, ".ts.net") ||
			strings.HasSuffix(host, ".tailscale.net") ||
			strings.HasSuffix(host, ".tailnet.ts.net") {
			proto = "https"
		} else if r.TLS != nil {
			proto = "https"
		} else {
			proto = "http"
		}
	}
	return proto + "://" + host + "/auth/callback"
}

func (w *WorkOSClient) CanonicalLoginURL(r *http.Request, prompt string) string {
	if w == nil || w.RedirectURI == "" {
		return ""
	}
	fwdHost := r.Header.Get("X-Forwarded-Host")
	if i := strings.Index(fwdHost, ","); i >= 0 {
		fwdHost = strings.TrimSpace(fwdHost[:i])
	}
	host := strings.TrimSpace(fwdHost)
	if host == "" {
		host = r.Host
	}
	if !isLocalOnlyHost(host) {
		return ""
	}
	canonical, err := url.Parse(w.RedirectURI)
	if err != nil || canonical.Host == "" {
		return ""
	}
	if strings.EqualFold(canonical.Host, host) {
		return ""
	}
	canonical.Path = "/auth/login"
	canonical.RawQuery = ""
	q := canonical.Query()
	if strings.TrimSpace(prompt) != "" {
		q.Set("prompt", strings.TrimSpace(prompt))
	}
	canonical.RawQuery = q.Encode()
	return canonical.String()
}

func isLoopbackHost(hostport string) bool {
	host := strings.TrimSpace(hostport)
	if split, _, err := net.SplitHostPort(host); err == nil {
		host = split
	}
	host = strings.Trim(host, "[]")
	if strings.EqualFold(host, "localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func isLocalOnlyHost(hostport string) bool {
	if isLoopbackHost(hostport) {
		return true
	}
	host := strings.TrimSpace(hostport)
	if split, _, err := net.SplitHostPort(host); err == nil {
		host = split
	}
	host = strings.Trim(host, "[]")
	lower := strings.ToLower(host)
	if lower == "" {
		return false
	}
	if strings.HasSuffix(lower, ".local") || strings.HasSuffix(lower, ".lan") {
		return true
	}
	if !strings.Contains(lower, ".") {
		return true
	}
	ip := net.ParseIP(lower)
	if ip4 := ip.To4(); ip4 != nil {
		return ip4[0] == 10 ||
			(ip4[0] == 192 && ip4[1] == 168) ||
			(ip4[0] == 172 && ip4[1] >= 16 && ip4[1] <= 31)
	}
	return false
}

// AuthenticateWithCode exchanges an OAuth code for user info + tokens.
// Returns the trimmed user shape we persist into Session.
type AuthenticatedUser struct {
	ID              string
	Email           string
	Name            string // FirstName ?? Email
	AccessToken     string
	WorkOSSessionID string // extracted from JWT sid claim
}

func (w *WorkOSClient) AuthenticateWithCode(ctx context.Context, code string) (*AuthenticatedUser, error) {
	resp, err := w.client.AuthenticateWithCode(ctx, usermanagement.AuthenticateWithCodeOpts{
		ClientID: w.ClientID,
		Code:     code,
	})
	if err != nil {
		return nil, fmt.Errorf("auth: AuthenticateWithCode: %w", err)
	}
	name := strings.TrimSpace(resp.User.FirstName)
	if name == "" {
		name = resp.User.Email
	}
	return &AuthenticatedUser{
		ID:              resp.User.ID,
		Email:           resp.User.Email,
		Name:            name,
		AccessToken:     resp.AccessToken,
		WorkOSSessionID: extractSessionIDFromAccessToken(resp.AccessToken),
	}, nil
}

// LogoutURL builds the WorkOS-side logout URL, ending the IdP session.
// Used for the "switch account" flow. Returns ("", nil) if workosSID
// is empty (caller should redirect locally instead).
func (w *WorkOSClient) LogoutURL(workosSessionID, returnTo string) (string, error) {
	if workosSessionID == "" {
		return "", nil
	}
	u, err := w.client.GetLogoutURL(usermanagement.GetLogoutURLOpts{
		SessionID: workosSessionID,
		ReturnTo:  returnTo,
	})
	if err != nil {
		return "", fmt.Errorf("auth: WorkOS LogoutURL: %w", err)
	}
	return u.String(), nil
}

// extractSessionIDFromAccessToken parses the JWT payload (middle
// segment of dot-separated token) and returns the `sid` claim. No
// signature verification — the access token came from WorkOS over
// HTTPS, the trust model is "we trust the API call we just made".
//
// Returns "" on any parse failure.
func extractSessionIDFromAccessToken(accessToken string) string {
	parts := strings.Split(accessToken, ".")
	if len(parts) < 2 {
		return ""
	}
	payload := parts[1]
	// JWT uses base64url-without-padding. Add padding to standard b64.
	if pad := len(payload) % 4; pad != 0 {
		payload += strings.Repeat("=", 4-pad)
	}
	raw, err := base64.URLEncoding.DecodeString(payload)
	if err != nil {
		return ""
	}
	var claims struct {
		SID string `json:"sid"`
	}
	if err := json.Unmarshal(raw, &claims); err != nil {
		return ""
	}
	return claims.SID
}

// AbsoluteRequestOrigin reconstructs the public-facing origin (proto
// + host) from a request, honouring X-Forwarded-Proto so Tailscale
// Funnel-fronted requests resolve correctly.
//
// Used to build absolute returnTo URLs for the WorkOS logout redirect.
func AbsoluteRequestOrigin(host, forwardedProto, scheme string) string {
	proto := strings.TrimSpace(forwardedProto)
	if proto != "" {
		// Take only the first hop in case the chain forwarded multiple.
		if i := strings.Index(proto, ","); i >= 0 {
			proto = strings.TrimSpace(proto[:i])
		}
	} else if scheme != "" {
		proto = scheme
	} else {
		proto = "http"
	}
	if host == "" {
		return ""
	}
	u := url.URL{Scheme: proto, Host: host}
	return u.String()
}
