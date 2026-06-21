package tools

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/yha/core/internal/logger"
)

func newRouteServer(t *testing.T, defaultCWD string) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	RegisterRoutes(mux, defaultCWD, logger.New(io.Discard))
	return httptest.NewServer(mux)
}

func TestExecRouteRejectsGet(t *testing.T) {
	srv := newRouteServer(t, t.TempDir())
	defer srv.Close()
	resp, err := http.Get(srv.URL + "/v1/tools/exec")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405", resp.StatusCode)
	}
	if al := resp.Header.Get("Allow"); al != "POST" {
		t.Errorf("Allow header = %q, want POST", al)
	}
}

func TestExecRouteRejectsBadJSON(t *testing.T) {
	srv := newRouteServer(t, t.TempDir())
	defer srv.Close()
	resp, err := http.Post(srv.URL+"/v1/tools/exec", "application/json", strings.NewReader("nope"))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", resp.StatusCode)
	}
}

func TestExecRouteRequiresName(t *testing.T) {
	srv := newRouteServer(t, t.TempDir())
	defer srv.Close()
	resp, err := http.Post(srv.URL+"/v1/tools/exec", "application/json", strings.NewReader(`{"args":{}}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", resp.StatusCode)
	}
}

func TestExecRouteRunsBash(t *testing.T) {
	cwd := t.TempDir()
	srv := newRouteServer(t, cwd)
	defer srv.Close()
	body := `{"name":"Bash","args":{"command":"echo hello-from-go"}}`
	resp, err := http.Post(srv.URL+"/v1/tools/exec", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	var out Result
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !out.OK {
		t.Errorf("Bash result OK=false, error=%q", out.Error)
	}
	if !strings.Contains(out.Content, "hello-from-go") {
		t.Errorf("content = %q, want it to contain hello-from-go", out.Content)
	}
}

func TestExecRouteUnknownTool(t *testing.T) {
	srv := newRouteServer(t, t.TempDir())
	defer srv.Close()
	resp, err := http.Post(srv.URL+"/v1/tools/exec", "application/json", strings.NewReader(`{"name":"NotARealTool"}`))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Errorf("status = %d, want 200 (Result has the error, not the HTTP layer)", resp.StatusCode)
	}
	var out Result
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if out.OK {
		t.Errorf("expected OK=false for unknown tool")
	}
	if !strings.Contains(out.Error, "unknown tool") {
		t.Errorf("error = %q, want 'unknown tool'", out.Error)
	}
}

func TestExecRouteCWDOverride(t *testing.T) {
	defaultCWD := t.TempDir()
	overrideCWD := t.TempDir()
	srv := newRouteServer(t, defaultCWD)
	defer srv.Close()

	// Prove the override took effect by having the shell write a marker
	// into its working dir, then checking which dir it landed in.
	// Comparing `pwd` output directly is fragile on Windows: the MSYS
	// shell prints "/tmp/..." for a path physically under
	// %LOCALAPPDATA%\Temp — correct, but not string-equal to overrideCWD.
	body := `{"name":"Bash","args":{"command":"echo ok > yha-cwd-probe.txt"},"cwd":` + jsonString(overrideCWD) + `}`
	resp, err := http.Post(srv.URL+"/v1/tools/exec", "application/json", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out Result
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if !out.OK {
		t.Fatalf("bash failed: %s", out.Error)
	}
	if _, err := os.Stat(filepath.Join(overrideCWD, "yha-cwd-probe.txt")); err != nil {
		t.Errorf("probe not created in overrideCWD %q: %v", overrideCWD, err)
	}
	if _, err := os.Stat(filepath.Join(defaultCWD, "yha-cwd-probe.txt")); err == nil {
		t.Errorf("probe wrongly created in defaultCWD %q (override ignored)", defaultCWD)
	}
}

// jsonString quotes s for embedding directly into a JSON literal.
func jsonString(s string) string {
	b, _ := json.Marshal(s)
	return string(b)
}
