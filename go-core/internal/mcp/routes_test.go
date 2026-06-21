package mcp

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/yha/core/internal/logger"
)

// stubConn injects a pipe-backed Connection straight into the pool —
// same trick as the existing pool_test.go. Lets us assert handler
// behaviour without spawning a real subprocess.
func stubConn(t *testing.T, name string, tools []Tool, ok bool) *Connection {
	t.Helper()
	stdinR, stdinW := io.Pipe()
	stdoutR, stdoutW := io.Pipe()
	c := newConnection(name, stdinW, stdoutR, nil, logger.New(io.Discard))
	c.Tools = tools
	c.OK = ok
	t.Cleanup(func() {
		_ = c.Close()
		_ = stdinR.Close()
		_ = stdoutW.Close()
	})
	return c
}

func newTestServer(t *testing.T, registryPath, statePath string, seedConns map[string]*Connection, opts ...RouteOption) (*httptest.Server, *Pool) {
	t.Helper()
	pool := NewPool(logger.New(io.Discard))
	for name, c := range seedConns {
		pool.connections[name] = c
	}
	mux := http.NewServeMux()
	RegisterRoutes(mux, pool, registryPath, statePath, logger.New(io.Discard), opts...)
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	return srv, pool
}

// ── /v1/mcp/state ──────────────────────────────────────────────────────────

func TestStateRoute_ReturnsServerSnapshot(t *testing.T) {
	dir := t.TempDir()
	statePath := filepath.Join(dir, "mcp-state.json")
	conns := map[string]*Connection{
		"alpha": stubConn(t, "alpha", []Tool{{Name: "t1"}, {Name: "t2"}}, true),
		"beta":  stubConn(t, "beta", nil, false),
	}
	srv, _ := newTestServer(t, "", statePath, conns)

	resp, err := http.Get(srv.URL + "/v1/mcp/state")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	var got stateResponse
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Servers) != 2 {
		t.Fatalf("servers = %+v", got.Servers)
	}
	byName := map[string]stateServer{}
	for _, s := range got.Servers {
		byName[s.Name] = s
	}
	if a, ok := byName["alpha"]; !ok || !a.OK || a.ToolsCount != 2 {
		t.Errorf("alpha = %+v", a)
	}
	if b, ok := byName["beta"]; !ok || b.OK || b.ToolsCount != 0 {
		t.Errorf("beta = %+v", b)
	}
	if len(got.Running) != 2 {
		t.Errorf("running should include both alive stubs, got %+v", got.Running)
	}
	// State file should reflect the running set.
	persisted, err := LoadState(statePath)
	if err != nil {
		t.Fatalf("LoadState: %v", err)
	}
	if len(persisted.Running) != 2 {
		t.Errorf("persisted running = %+v", persisted.Running)
	}
}

func TestStateRoute_RejectsPOST(t *testing.T) {
	srv, _ := newTestServer(t, "", "", nil)
	resp, err := http.Post(srv.URL+"/v1/mcp/state", "application/json", bytes.NewReader([]byte("{}")))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405", resp.StatusCode)
	}
}

// ── /v1/mcp/start ──────────────────────────────────────────────────────────

func TestStartRoute_UnknownServer404(t *testing.T) {
	dir := t.TempDir()
	registry := filepath.Join(dir, "registry.json")
	state := filepath.Join(dir, "state.json")
	if err := os.WriteFile(registry, []byte(`{"mcpServers": {}}`), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	srv, _ := newTestServer(t, registry, state, nil)

	body, _ := json.Marshal(startStopRequest{Name: "nope"})
	resp, err := http.Post(srv.URL+"/v1/mcp/start", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d, want 404", resp.StatusCode)
	}
}

func TestStartRoute_MissingNameRejected(t *testing.T) {
	srv, _ := newTestServer(t, "", "", nil)
	resp, err := http.Post(srv.URL+"/v1/mcp/start", "application/json", bytes.NewReader([]byte("{}")))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", resp.StatusCode)
	}
}

func TestStartRoute_InvalidJSON400(t *testing.T) {
	srv, _ := newTestServer(t, "", "", nil)
	resp, err := http.Post(srv.URL+"/v1/mcp/start", "application/json", bytes.NewReader([]byte("not-json")))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", resp.StatusCode)
	}
}

// ── /v1/mcp/stop ───────────────────────────────────────────────────────────

func TestStopRoute_RemovesEntry(t *testing.T) {
	dir := t.TempDir()
	statePath := filepath.Join(dir, "mcp-state.json")
	conns := map[string]*Connection{"x": stubConn(t, "x", nil, true)}
	srv, pool := newTestServer(t, "", statePath, conns)

	body, _ := json.Marshal(startStopRequest{Name: "x"})
	resp, err := http.Post(srv.URL+"/v1/mcp/stop", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Errorf("status = %d", resp.StatusCode)
	}
	if _, ok := pool.Get("x"); ok {
		t.Error("expected pool to lose entry x after stop")
	}
}

func TestStopRoute_UnknownServerStillOK(t *testing.T) {
	// Stop is idempotent in the Pool, mirror that here.
	srv, _ := newTestServer(t, "", "", nil)
	body, _ := json.Marshal(startStopRequest{Name: "ghost"})
	resp, err := http.Post(srv.URL+"/v1/mcp/stop", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Errorf("status = %d, want 200 (stop is idempotent)", resp.StatusCode)
	}
}

func TestStopRoute_GETRejected(t *testing.T) {
	srv, _ := newTestServer(t, "", "", nil)
	resp, err := http.Get(srv.URL + "/v1/mcp/stop")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405", resp.StatusCode)
	}
}

// ── /v1/mcp/tools ──────────────────────────────────────────────────────────

func TestToolsRoute_AggregatesAcrossPool(t *testing.T) {
	conns := map[string]*Connection{
		"k": stubConn(t, "k", []Tool{
			{Name: "search", Description: "Search docs"},
			{Name: "index", Description: "Build index"},
		}, true),
		"i": stubConn(t, "i", []Tool{{Name: "important_add"}}, true),
	}
	srv, _ := newTestServer(t, "", "", conns)

	resp, err := http.Get(srv.URL + "/v1/mcp/tools")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	var got toolsResponse
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(got.Servers["k"]) != 2 {
		t.Errorf("k tools = %+v", got.Servers["k"])
	}
	if len(got.Servers["i"]) != 1 || got.Servers["i"][0].Name != "important_add" {
		t.Errorf("i tools = %+v", got.Servers["i"])
	}
}

func TestToolsRoute_PostRejected(t *testing.T) {
	srv, _ := newTestServer(t, "", "", nil)
	resp, err := http.Post(srv.URL+"/v1/mcp/tools", "application/json", bytes.NewReader([]byte("{}")))
	if err != nil {
		t.Fatalf("POST: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405", resp.StatusCode)
	}
}

// ── /v1/mcp/call ───────────────────────────────────────────────────────────
//
// Phase 4: the dispatch endpoint Node delegates to when YHA_GO_OWNS_MCP=1.
// Auth gate is x-bridge-key (matches /proxy/tool's Node-side check).

const testBridgeKey = "sk-test-bridgekey-deadbeefdeadbeef"

// postCall is a tiny helper that POSTs a callRequest with an optional
// x-bridge-key header. Returns the *http.Response so callers can assert
// status; body is consumed via JSON decode at the call site.
func postCall(t *testing.T, url string, key string, body callRequest) *http.Response {
	t.Helper()
	buf, _ := json.Marshal(body)
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(buf))
	if err != nil {
		t.Fatalf("NewRequest: %v", err)
	}
	req.Header.Set("Content-Type", "application/json")
	if key != "" {
		req.Header.Set("x-bridge-key", key)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("Do: %v", err)
	}
	return resp
}

func TestCallRoute_NotRegisteredWithoutBridgeKeyOption(t *testing.T) {
	srv, _ := newTestServer(t, "", "", nil)
	// Without WithBridgeKey, the /v1/mcp/call endpoint shouldn't be
	// reachable — the mux 404s unknown paths.
	resp := postCall(t, srv.URL+"/v1/mcp/call", testBridgeKey, callRequest{Server: "x", Tool: "y"})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d, want 404 (call route should be opt-in)", resp.StatusCode)
	}
}

func TestCallRoute_RejectsMissingBridgeKey(t *testing.T) {
	srv, _ := newTestServer(t, "", "", nil, WithBridgeKey(func() string { return testBridgeKey }))
	resp := postCall(t, srv.URL+"/v1/mcp/call", "", callRequest{Server: "x", Tool: "y"})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", resp.StatusCode)
	}
}

func TestCallRoute_RejectsBadBridgeKey(t *testing.T) {
	srv, _ := newTestServer(t, "", "", nil, WithBridgeKey(func() string { return testBridgeKey }))
	resp := postCall(t, srv.URL+"/v1/mcp/call", "wrong-key", callRequest{Server: "x", Tool: "y"})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Errorf("status = %d, want 401", resp.StatusCode)
	}
}

func TestCallRoute_UnknownServer404(t *testing.T) {
	srv, _ := newTestServer(t, "", "", nil, WithBridgeKey(func() string { return testBridgeKey }))
	resp := postCall(t, srv.URL+"/v1/mcp/call", testBridgeKey, callRequest{Server: "ghost", Tool: "y"})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Errorf("status = %d, want 404", resp.StatusCode)
	}
}

func TestCallRoute_MissingServer400(t *testing.T) {
	srv, _ := newTestServer(t, "", "", nil, WithBridgeKey(func() string { return testBridgeKey }))
	resp := postCall(t, srv.URL+"/v1/mcp/call", testBridgeKey, callRequest{Tool: "y"})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", resp.StatusCode)
	}
}

func TestCallRoute_MissingTool400(t *testing.T) {
	srv, _ := newTestServer(t, "", "", nil, WithBridgeKey(func() string { return testBridgeKey }))
	resp := postCall(t, srv.URL+"/v1/mcp/call", testBridgeKey, callRequest{Server: "x"})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusBadRequest {
		t.Errorf("status = %d, want 400", resp.StatusCode)
	}
}

func TestCallRoute_DispatchesToPool(t *testing.T) {
	// Wire a fake child process up to a real Connection so CallTool's
	// JSON-RPC round-trip exercises the same code paths it does in prod.
	fs := newFakeServer(t)
	defer fs.close()
	// Reflect-back server: echo the tools/call arguments under "echoed".
	go func() {
		r := NewReader(fs.childIn)
		for {
			body, err := r.ReadFrame()
			if err != nil {
				return
			}
			var req Request
			_ = json.Unmarshal(body, &req)
			if req.Method == "tools/call" {
				params, _ := req.Params.(map[string]any)
				fs.reply(req.ID, map[string]any{
					"content": []map[string]any{
						{"type": "text", "text": "ok"},
					},
					"echoed": params,
				})
			}
		}
	}()

	conns := map[string]*Connection{"alpha": fs.conn}
	srv, _ := newTestServer(t, "", "", conns, WithBridgeKey(func() string { return testBridgeKey }))

	resp := postCall(t, srv.URL+"/v1/mcp/call", testBridgeKey, callRequest{
		Server: "alpha",
		Tool:   "echo",
		Arguments: map[string]any{
			"hello": "world",
		},
	})
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("status = %d, want 200", resp.StatusCode)
	}
	var got callResponse
	if err := json.NewDecoder(resp.Body).Decode(&got); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if !got.OK {
		t.Fatalf("ok = false, error = %q", got.Error)
	}
	echoed, _ := got.Result["echoed"].(map[string]any)
	if echoed == nil || echoed["name"] != "echo" {
		t.Errorf("echoed name = %+v, want echo", echoed)
	}
	args, _ := echoed["arguments"].(map[string]any)
	if args == nil || args["hello"] != "world" {
		t.Errorf("echoed arguments = %+v, want hello=world", args)
	}
}

func TestCallRoute_GETRejected(t *testing.T) {
	srv, _ := newTestServer(t, "", "", nil, WithBridgeKey(func() string { return testBridgeKey }))
	resp, err := http.Get(srv.URL + "/v1/mcp/call")
	if err != nil {
		t.Fatalf("GET: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("status = %d, want 405", resp.StatusCode)
	}
}
