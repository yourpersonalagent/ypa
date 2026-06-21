package tui

// login.go — TUI link-login flow.
//
// On launch the TUI loads ~/.yha/tui-token.json. If a live token is
// present, it's used as the Bearer credential for every request to the
// bridge. If not (first launch, expired, or revoked) we run the link
// flow:
//
//   1. POST /auth/tui-link/start → returns {linkId, url}.
//   2. Print the URL on stderr and tell the user to open it in a browser
//      where they're already logged in. (Single-user box → they
//      virtually always are.)
//   3. Long-poll GET /v1/tui-link/poll/<id> until status flips out of
//      "pending". On "approved" we get {token, expiresAt} back; cache
//      it to disk and continue.
//
// This file is intentionally pre-tea — runs before bubbletea takes
// over the screen so the user can copy-paste the URL with normal
// scroll-back.

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// tokenCacheFile resolves the location we persist TUI tokens at.
// Honours $YHA_TOKEN_FILE for tests / custom layouts; otherwise picks
// $HOME/.yha/tui-token.json. Returns "" if no home dir is available
// (we'll fall back to in-memory only — token gets thrown away on quit).
func tokenCacheFile() string {
	if v := strings.TrimSpace(os.Getenv("YHA_TOKEN_FILE")); v != "" {
		return v
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".yha", "tui-token.json")
}

// cachedTuiToken mirrors the bridge's /v1/tui-link/poll response, plus
// the local cache file format. ExpiresAt is unix-seconds (matches the
// bridge contract).
type cachedTuiToken struct {
	Token     string `json:"token"`
	Email     string `json:"email,omitempty"`
	Name      string `json:"name,omitempty"`
	ExpiresAt int64  `json:"expiresAt"`
	Endpoint  string `json:"endpoint,omitempty"` // stashed so we don't reuse a token meant for a different bridge
}

// loadCachedToken returns the token from ~/.yha/tui-token.json if it's
// still alive AND matches the current endpoint. Otherwise returns "".
func loadCachedToken(endpoint string) string {
	path := tokenCacheFile()
	if path == "" {
		return ""
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	var c cachedTuiToken
	if err := json.Unmarshal(b, &c); err != nil {
		return ""
	}
	now := time.Now().Unix()
	if c.Token == "" || c.ExpiresAt <= now+30 {
		return ""
	}
	// Endpoint check guards against a leftover token from a different
	// bridge (e.g. dev vs. funnel URL) winding up at the wrong server.
	if c.Endpoint != "" && c.Endpoint != endpoint {
		return ""
	}
	return c.Token
}

// saveCachedToken writes the token to disk. Best-effort — failure just
// means the user re-runs the link flow on next launch.
func saveCachedToken(endpoint string, c cachedTuiToken) {
	path := tokenCacheFile()
	if path == "" {
		return
	}
	c.Endpoint = endpoint
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		fmt.Fprintln(getStderr(), "yha tui: failed to create token cache dir:", err)
		return
	}
	buf, err := json.MarshalIndent(c, "", "  ")
	if err != nil {
		return
	}
	if err := os.WriteFile(path, buf, 0o600); err != nil {
		fmt.Fprintln(getStderr(), "yha tui: failed to write token cache:", err)
	}
}

// clearCachedToken removes the cache file. Called on 401 so the next
// launch starts from a clean state.
func clearCachedToken() {
	path := tokenCacheFile()
	if path == "" {
		return
	}
	_ = os.Remove(path)
}

// EnsureAuthenticated runs before tea.NewProgram. If opts.Token is set,
// trust the user. If a cached token exists for this endpoint, use it.
// Otherwise run the link flow and persist the result. Returns the token
// to use (may be empty when auth is disabled on the bridge).
//
// Probes /healthz to decide whether the bridge needs a token at all —
// no point running the flow against an open dev box.
func EnsureAuthenticated(opts Options) (string, error) {
	// Explicit --token / --token-file always wins.
	if t := tokenFromOpts(opts); t != "" {
		return t, nil
	}
	httpC, endpoint := buildClient(opts)
	// Probe needsAuth via /v1/me — public endpoints don't help us decide.
	if !needsAuth(httpC, endpoint, opts) {
		return "", nil
	}
	if t := loadCachedToken(endpoint); t != "" {
		// Quick health-check the cached token against /v1/me. If it's
		// expired server-side (revoked), wipe it and re-run the flow.
		if probeBearer(httpC, endpoint, t) {
			return t, nil
		}
		clearCachedToken()
	}
	tok, exp, err := runLinkFlow(httpC, endpoint, opts)
	if err != nil {
		return "", err
	}
	saveCachedToken(endpoint, cachedTuiToken{Token: tok, ExpiresAt: exp})
	return tok, nil
}

// needsAuth probes /v1/me with no credentials; if the bridge replies
// 200, auth is disabled and we don't need a token. 401 → flow required.
// Any other status (network error, etc.) we treat as "skip the flow
// for now and let the main TUI surface the error".
func needsAuth(c *http.Client, base string, opts Options) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", base+"/v1/me", nil)
	if err != nil {
		return false
	}
	resp, err := c.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode == 401 || resp.StatusCode == 403
}

// probeBearer verifies a token works against the bridge's /v1/me
// endpoint. Used to detect revoked / expired tokens before the main
// TUI starts streaming.
func probeBearer(c *http.Client, base, token string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", base+"/v1/me", nil)
	if err != nil {
		return false
	}
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := c.Do(req)
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	return resp.StatusCode == 200
}

// runLinkFlow starts a link and polls until approved or denied. Prints
// the URL to stderr and blocks for up to 10 minutes.
func runLinkFlow(c *http.Client, base string, opts Options) (string, int64, error) {
	startResp, err := postLinkStart(c, base)
	if err != nil {
		return "", 0, fmt.Errorf("link start: %w", err)
	}
	fmt.Fprintln(getStderr())
	fmt.Fprintln(getStderr(), "YHA TUI needs a one-time browser confirmation to mint a session token.")
	fmt.Fprintln(getStderr(), "Open this URL in a browser where you're already logged in to YHA:")
	fmt.Fprintln(getStderr())
	fmt.Fprintln(getStderr(), "    "+startResp.URL)
	fmt.Fprintln(getStderr())
	fmt.Fprintln(getStderr(), "Pick a token lifetime on the page (12h, 1d, 7d, or 30d).")
	fmt.Fprintln(getStderr(), "Press Ctrl+C to cancel.")
	fmt.Fprintln(getStderr())

	deadline := time.Now().Add(10 * time.Minute)
	for time.Now().Before(deadline) {
		poll, err := getLinkPoll(c, base, startResp.LinkID)
		if err != nil {
			// Transient network error — retry after a short pause.
			time.Sleep(2 * time.Second)
			continue
		}
		switch poll.Status {
		case "approved":
			fmt.Fprintln(getStderr(), "✓ approved — launching TUI.")
			return poll.Token, poll.ExpiresAt, nil
		case "denied":
			return "", 0, errors.New("link denied in browser")
		case "expired":
			return "", 0, errors.New("link expired before approval")
		}
		time.Sleep(2 * time.Second)
	}
	return "", 0, errors.New("link approval timed out after 10 minutes")
}

type linkStartResp struct {
	LinkID    string `json:"linkId"`
	URL       string `json:"url"`
	ExpiresAt int64  `json:"expiresAt"`
}

type linkPollResp struct {
	Status    string `json:"status"`
	Token     string `json:"token,omitempty"`
	ExpiresAt int64  `json:"expiresAt,omitempty"`
}

func postLinkStart(c *http.Client, base string) (*linkStartResp, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	payload, _ := json.Marshal(map[string]string{"label": "yha-tui"})
	req, err := http.NewRequestWithContext(ctx, "POST", base+"/auth/tui-link/start", bytes.NewReader(payload))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := c.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}
	var out linkStartResp
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, err
	}
	if out.LinkID == "" || out.URL == "" {
		return nil, errors.New("empty response from link/start")
	}
	return &out, nil
}

func getLinkPoll(c *http.Client, base, linkID string) (*linkPollResp, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", base+"/v1/tui-link/poll/"+linkID, nil)
	if err != nil {
		return nil, err
	}
	resp, err := c.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode == 404 {
		return &linkPollResp{Status: "expired"}, nil
	}
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	var out linkPollResp
	if err := json.Unmarshal(body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
