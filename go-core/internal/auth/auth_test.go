package auth

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestIsPublicPath(t *testing.T) {
	cases := []struct {
		path string
		want bool
	}{
		{"/", true},
		{"/login", true},
		{"/auth/login", true},
		{"/auth/callback", true},
		{"/auth/logout", true},
		{"/health", true},
		{"/auth/anything-deeper", false}, // /auth alone isn't a public path
		{"/favicon.svg", true},
		{"/manifest.json", true},
		{"/assets/index-abc123.js", true},
		{"/css/app.css", true},
		{"/main.js", true}, // matches asset regex
		{"/something.svg", true},
		{"/v1/sessions", false},
		{"/proxy/foo", false},
		{"/ypa", false},
	}
	for _, c := range cases {
		got := IsPublicPath(c.path)
		if got != c.want {
			t.Errorf("IsPublicPath(%q) = %v, want %v", c.path, got, c.want)
		}
	}
}

func TestPublicPathStrictPrefix(t *testing.T) {
	if IsPublicPath("/loginz") {
		t.Error("/loginz must NOT be public — needs slash boundary after /login")
	}
	if !IsPublicPath("/login/sub") {
		t.Error("/login/sub should be public (under /login)")
	}
}

func TestIsYhaPeerPath(t *testing.T) {
	cases := []struct {
		path string
		want bool
	}{
		{"/v1/peer/networks/abc123/join-request", true},
		{"/v1/peer/networks/abc123/membership-update", true},
		{"/v1/peer/networks/abc123/revoke", true},
		{"/v1/peer/networks/abc123/membership", true},
		{"/v1/peer/networks/abc123/manifest", true},
		{"/v1/peer/networks/abc123/offers", true},
		{"/v1/peer/networks/abc123/model-data", true},
		{"/v1/peer/networks/abc123/pricing", true},
		{"/v1/peer/networks/abc123/usage-cost-summary", true},
		{"/v1/peer/networks/abc123/events", true},
		{"/v1/peer/networks/abc123/docs/list", true},
		{"/v1/peer/networks/abc123/docs/read", true},
		{"/v1/peer/networks/abc123/sessions", true},
		{"/v1/peer/networks/abc123/sessions/sess_xyz", true},
		// Not peer endpoints — must NOT be forwarded unauthenticated.
		{"/v1/peer/networks/abc123/docs/write", false},
		{"/v1/peer/networks/abc123/sessions/abc/def", false}, // session id must be one segment
		{"/v1/peer/networks/abc123", false},
		{"/v1/peer/networks/abc/def/join-request", false}, // network id must be one segment
		{"/v1/net/networks/abc123/refresh", false},        // local-only API stays gated
		{"/v1/sessions", false},
	}
	for _, c := range cases {
		if got := IsYhaPeerPath(c.path); got != c.want {
			t.Errorf("IsYhaPeerPath(%q) = %v, want %v", c.path, got, c.want)
		}
	}
}

func TestClassifyYhaPeerPathIsPublic(t *testing.T) {
	cfg := Config{WorkOSAPIKey: "k", WorkOSClientID: "c"}
	r := httptest.NewRequest("POST", "/v1/peer/networks/abc123/join-request", nil)
	// Even with a no-session lookup, a peer path must pass the gate so the
	// bridge can do invite/signature auth.
	if got := Classify(cfg, r, noSession); got != DecisionPublic {
		t.Errorf("peer path should be DecisionPublic, got %v", got)
	}
}

func TestIsAllowedEmail(t *testing.T) {
	cfg := Config{AllowedEmails: []string{"alice@example.com", "Bob@Example.com"}}
	if !cfg.IsAllowedEmail("alice@example.com") {
		t.Error("alice@example.com should be allowed")
	}
	if !cfg.IsAllowedEmail("ALICE@EXAMPLE.COM") {
		t.Error("uppercase form should be allowed (case-insensitive)")
	}
	if !cfg.IsAllowedEmail("bob@example.com") {
		t.Error("bob@example.com should be allowed (config has mixed case)")
	}
	if cfg.IsAllowedEmail("eve@example.com") {
		t.Error("eve@example.com should NOT be allowed")
	}
	if cfg.IsAllowedEmail("") {
		t.Error("empty string should NOT be allowed")
	}
}

func TestIsLocalIP(t *testing.T) {
	cases := map[string]bool{
		"127.0.0.1":        true,
		"127.0.0.1:8443":   true,
		"::1":              true,
		"[::1]:8443":       true,
		"::ffff:127.0.0.1": true,
		"192.168.1.5":      false,
		"192.168.1.5:443":  false,
		"":                 false,
	}
	for in, want := range cases {
		if got := IsLocalIP(in); got != want {
			t.Errorf("IsLocalIP(%q) = %v, want %v", in, got, want)
		}
	}
}

func TestConfigEnabledRequiresBothEnvVars(t *testing.T) {
	tests := []struct {
		api, client string
		want        bool
	}{
		{"k", "c", true},
		{"k", "", false},
		{"", "c", false},
		{"", "", false},
	}
	for _, tt := range tests {
		c := Config{WorkOSAPIKey: tt.api, WorkOSClientID: tt.client}
		if got := c.Enabled(); got != tt.want {
			t.Errorf("Enabled(api=%q,client=%q) = %v, want %v", tt.api, tt.client, got, tt.want)
		}
	}
}

func TestClassifyAuthDisabledAlwaysAllows(t *testing.T) {
	cfg := Config{} // not enabled
	r := httptest.NewRequest("GET", "/v1/sessions/abc", nil)
	if got := Classify(cfg, r, nil); got != DecisionAllow {
		t.Errorf("disabled auth should allow, got %v", got)
	}
}

func TestClassifyPublicPathReturnsPublic(t *testing.T) {
	cfg := Config{WorkOSAPIKey: "k", WorkOSClientID: "c"}
	r := httptest.NewRequest("GET", "/login", nil)
	if got := Classify(cfg, r, nil); got != DecisionPublic {
		t.Errorf("public path should return DecisionPublic, got %v", got)
	}
}

func TestClassifyLocalProxy(t *testing.T) {
	cfg := Config{WorkOSAPIKey: "k", WorkOSClientID: "c"}
	r := httptest.NewRequest("POST", "/proxy/anthropic/v1/messages", nil)
	r.RemoteAddr = "127.0.0.1:54321"
	if got := Classify(cfg, r, nil); got != DecisionLocalProxy {
		t.Errorf("local /proxy/* should be DecisionLocalProxy, got %v", got)
	}
}

func TestClassifyLocalVersionReadPaths(t *testing.T) {
	cfg := Config{WorkOSAPIKey: "k", WorkOSClientID: "c"}
	for _, tc := range []struct {
		method string
		path   string
	}{
		{http.MethodGet, "/v1/version"},
		{http.MethodPost, "/v1/version/check"},
		{http.MethodPost, "/v1/version/apply"},
	} {
		r := httptest.NewRequest(tc.method, tc.path, nil)
		r.RemoteAddr = "127.0.0.1:54321"
		if got := Classify(cfg, r, noSession); got != DecisionAllow {
			t.Errorf("%s %s from loopback = %v, want DecisionAllow", tc.method, tc.path, got)
		}
	}
}

func TestClassifyRemoteProxyWithoutLookupDefaultsAllow(t *testing.T) {
	cfg := Config{WorkOSAPIKey: "k", WorkOSClientID: "c"}
	r := httptest.NewRequest("POST", "/proxy/anthropic/v1/messages", nil)
	r.RemoteAddr = "10.0.0.1:54321"
	if got := Classify(cfg, r, nil); got != DecisionAllow {
		t.Errorf("remote /proxy/* with no lookup defaults to DecisionAllow in Phase 2a, got %v", got)
	}
}

func noSession(_ *http.Request) (string, bool, bool)  { return "", false, false }
func sessAllowed(_ *http.Request) (string, bool, bool) { return "alice@example.com", true, true }
func sessNotAllowed(_ *http.Request) (string, bool, bool) {
	return "eve@example.com", false, true
}

func TestClassifyAPIPathWithoutSessionIsUnauth(t *testing.T) {
	cfg := Config{WorkOSAPIKey: "k", WorkOSClientID: "c"}
	r := httptest.NewRequest("GET", "/v1/sessions/abc", nil)
	if got := Classify(cfg, r, noSession); got != DecisionUnauth {
		t.Errorf("v1 + no session = %v, want DecisionUnauth", got)
	}
}

func TestClassifySSEWithoutSessionIsUnauth(t *testing.T) {
	cfg := Config{WorkOSAPIKey: "k", WorkOSClientID: "c"}
	r := httptest.NewRequest("GET", "/whatever", nil)
	r.Header.Set("Accept", "text/event-stream")
	if got := Classify(cfg, r, noSession); got != DecisionUnauth {
		t.Errorf("SSE + no session = %v, want DecisionUnauth", got)
	}
}

func TestClassifyBrowserPathWithoutSessionRedirects(t *testing.T) {
	cfg := Config{WorkOSAPIKey: "k", WorkOSClientID: "c"}
	r := httptest.NewRequest("GET", "/ypa", nil)
	if got := Classify(cfg, r, noSession); got != DecisionRedirect {
		t.Errorf("/ypa + no session = %v, want DecisionRedirect", got)
	}
}

func TestClassifyAllowedSession(t *testing.T) {
	cfg := Config{WorkOSAPIKey: "k", WorkOSClientID: "c"}
	r := httptest.NewRequest("GET", "/v1/sessions/abc", nil)
	if got := Classify(cfg, r, sessAllowed); got != DecisionAllow {
		t.Errorf("allowed session = %v, want DecisionAllow", got)
	}
}

func TestClassifyNotAllowedAPIPath(t *testing.T) {
	cfg := Config{WorkOSAPIKey: "k", WorkOSClientID: "c"}
	r := httptest.NewRequest("GET", "/v1/sessions/abc", nil)
	if got := Classify(cfg, r, sessNotAllowed); got != DecisionRestricted {
		t.Errorf("not allowed + v1 = %v, want DecisionRestricted", got)
	}
}

func TestClassifyNotAllowedRestrictedPageIsPublic(t *testing.T) {
	cfg := Config{WorkOSAPIKey: "k", WorkOSClientID: "c"}
	r := httptest.NewRequest("GET", "/restricted", nil)
	if got := Classify(cfg, r, sessNotAllowed); got != DecisionPublic {
		t.Errorf("/restricted should be reachable for not-allowed users, got %v", got)
	}
}

// ── Middleware enforcement ──────────────────────────────────────────────────

func TestMiddlewareAdvisoryAlwaysPasses(t *testing.T) {
	cfg := Config{WorkOSAPIKey: "k", WorkOSClientID: "c"}
	gate := &Gate{Cfg: cfg, Lookup: noSession}
	called := false
	h := gate.Middleware()(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
		w.WriteHeader(200)
	}))
	rec := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/v1/sessions/abc", nil)
	h.ServeHTTP(rec, r)
	if !called {
		t.Error("advisory mode should always call next handler")
	}
	if rec.Header().Get("X-Yha-Auth") != "unauth" {
		t.Errorf("advisory header = %q, want unauth", rec.Header().Get("X-Yha-Auth"))
	}
	if rec.Code != 200 {
		t.Errorf("status = %d, want 200 (advisory should not reject)", rec.Code)
	}
}

func TestMiddlewareEnforceRejectsUnauth(t *testing.T) {
	cfg := Config{WorkOSAPIKey: "k", WorkOSClientID: "c"}
	gate := &Gate{Cfg: cfg, Lookup: noSession, Enforce: true}
	called := false
	h := gate.Middleware()(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		called = true
	}))
	rec := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/v1/sessions/abc", nil)
	h.ServeHTTP(rec, r)
	if called {
		t.Error("enforce mode must NOT call next on unauth")
	}
	if rec.Code != 401 {
		t.Errorf("status = %d, want 401", rec.Code)
	}
}

func TestMiddlewareEnforceRedirectsBrowser(t *testing.T) {
	cfg := Config{WorkOSAPIKey: "k", WorkOSClientID: "c"}
	gate := &Gate{Cfg: cfg, Lookup: noSession, Enforce: true}
	h := gate.Middleware()(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	rec := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/ypa", nil)
	h.ServeHTTP(rec, r)
	if rec.Code != 302 {
		t.Errorf("status = %d, want 302", rec.Code)
	}
	if loc := rec.Header().Get("Location"); loc != "/" {
		t.Errorf("Location = %q, want /", loc)
	}
}

func TestMiddlewareEnforceForbidsRestrictedAPI(t *testing.T) {
	cfg := Config{WorkOSAPIKey: "k", WorkOSClientID: "c"}
	gate := &Gate{Cfg: cfg, Lookup: sessNotAllowed, Enforce: true}
	h := gate.Middleware()(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {}))
	rec := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/v1/sessions/abc", nil)
	h.ServeHTTP(rec, r)
	if rec.Code != 403 {
		t.Errorf("status = %d, want 403", rec.Code)
	}
}

// ── Log ─────────────────────────────────────────────────────────────────────

func TestLogEventWritesSingleLine(t *testing.T) {
	dir := t.TempDir()
	log := filepath.Join(dir, "auth-logins.log")
	if err := LogEvent(log, "login_success", map[string]string{
		"email": "alice@example.com",
		"ip":    "1.2.3.4",
	}); err != nil {
		t.Fatalf("log: %v", err)
	}
	body, err := os.ReadFile(log)
	if err != nil {
		t.Fatalf("read: %v", err)
	}
	if c := strings.Count(string(body), "\n"); c != 1 {
		t.Errorf("expected 1 newline, got %d in %q", c, body)
	}
	if !strings.Contains(string(body), "login_success") {
		t.Errorf("missing event in log line: %q", body)
	}
	if !strings.Contains(string(body), "alice@example.com") {
		t.Errorf("missing email in log line: %q", body)
	}
}

func TestLogEventOmitsBlankFields(t *testing.T) {
	dir := t.TempDir()
	log := filepath.Join(dir, "auth-logins.log")
	if err := LogEvent(log, "logout", map[string]string{
		"email": "alice@example.com",
		"ip":    "",
	}); err != nil {
		t.Fatalf("log: %v", err)
	}
	body, _ := os.ReadFile(log)
	if strings.Contains(string(body), "ip=") {
		t.Errorf("blank ip should be omitted, got %q", body)
	}
}

func TestSanitizeCollapsesWhitespace(t *testing.T) {
	got := sanitize("  hello\n\nworld\t  ")
	if got != "hello world" {
		t.Errorf("sanitize collapsed wrong: %q", got)
	}
}
