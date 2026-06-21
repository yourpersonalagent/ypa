package mcp

import (
	"os"
	"path/filepath"
	"testing"
)

// ── LoadRegistry ──────────────────────────────────────────────────────────

func TestLoadRegistry_HappyPath(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "mcp-registry.json")
	const fixture = `{
		"mcpServers": {
			"knowledge-memory": {
				"command": "node",
				"args": ["/abs/knowledge-server.js"],
				"env": {"FOO": "bar"}
			},
			"important": {
				"command": "node",
				"args": ["/abs/important.js"]
			}
		}
	}`
	if err := os.WriteFile(path, []byte(fixture), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	got, err := LoadRegistry(path)
	if err != nil {
		t.Fatalf("LoadRegistry: %v", err)
	}
	if len(got) != 2 {
		t.Fatalf("got %d entries, want 2", len(got))
	}
	km := got["knowledge-memory"]
	if km.Name != "knowledge-memory" || km.Command != "node" {
		t.Errorf("knowledge-memory = %+v", km)
	}
	if len(km.Args) != 1 || km.Args[0] != "/abs/knowledge-server.js" {
		t.Errorf("args = %+v", km.Args)
	}
	if km.Env["FOO"] != "bar" {
		t.Errorf("env FOO = %q, want bar", km.Env["FOO"])
	}
	imp := got["important"]
	if imp.Name != "important" {
		t.Errorf("important name = %q", imp.Name)
	}
	if imp.Env != nil {
		t.Errorf("important env = %+v, want nil for absent key", imp.Env)
	}
}

func TestLoadRegistry_MissingFileReturnsEmpty(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "absent.json")
	got, err := LoadRegistry(path)
	if err != nil {
		t.Fatalf("LoadRegistry: %v", err)
	}
	if len(got) != 0 {
		t.Errorf("got %d entries, want 0 for missing file", len(got))
	}
}

func TestLoadRegistry_MalformedJSONErrors(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bad.json")
	if err := os.WriteFile(path, []byte("{not json"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	_, err := LoadRegistry(path)
	if err == nil {
		t.Fatal("expected parse error")
	}
}

// ── SaveRegistry ──────────────────────────────────────────────────────────

func TestSaveRegistry_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "mcp-registry.json")
	in := map[string]ServerConfig{
		"x": {Name: "x", Command: "node", Args: []string{"a", "b"}, Env: map[string]string{"K": "V"}},
		"y": {Name: "y", Command: "python", Args: []string{}},
	}
	if err := SaveRegistry(path, in); err != nil {
		t.Fatalf("SaveRegistry: %v", err)
	}
	out, err := LoadRegistry(path)
	if err != nil {
		t.Fatalf("LoadRegistry: %v", err)
	}
	if len(out) != 2 {
		t.Fatalf("round-trip lost entries: %+v", out)
	}
	if out["x"].Env["K"] != "V" {
		t.Errorf("x env lost: %+v", out["x"])
	}
	if out["y"].Command != "python" {
		t.Errorf("y cmd = %q", out["y"].Command)
	}
}

func TestSaveRegistry_AtomicWriteUnwritableDirErrors(t *testing.T) {
	// Pointing at a non-existent parent directory triggers WriteFile
	// failure on the temp file — exercises the error path.
	bad := filepath.Join(t.TempDir(), "nope", "registry.json")
	err := SaveRegistry(bad, map[string]ServerConfig{})
	if err == nil {
		t.Fatal("expected error writing into missing parent dir")
	}
}

// ── LoadState ──────────────────────────────────────────────────────────────

func TestLoadState_HappyPath(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "mcp-state.json")
	const fixture = `{"running": ["a", "b"], "externalSharing": false}`
	if err := os.WriteFile(path, []byte(fixture), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	got, err := LoadState(path)
	if err != nil {
		t.Fatalf("LoadState: %v", err)
	}
	if len(got.Running) != 2 || got.Running[0] != "a" || got.Running[1] != "b" {
		t.Errorf("running = %+v", got.Running)
	}
	if got.ExternalSharing {
		t.Errorf("externalSharing = true, want false")
	}
}

func TestLoadState_MissingFileDefaultsOn(t *testing.T) {
	dir := t.TempDir()
	got, err := LoadState(filepath.Join(dir, "absent.json"))
	if err != nil {
		t.Fatalf("LoadState: %v", err)
	}
	if len(got.Running) != 0 {
		t.Errorf("running = %+v, want empty", got.Running)
	}
	if !got.ExternalSharing {
		t.Errorf("externalSharing = false, want true (default-on)")
	}
}

func TestLoadState_OmittedToggleDefaultsOn(t *testing.T) {
	// Mirrors the JS rule: missing key → true.
	dir := t.TempDir()
	path := filepath.Join(dir, "mcp-state.json")
	if err := os.WriteFile(path, []byte(`{"running": ["x"]}`), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	got, err := LoadState(path)
	if err != nil {
		t.Fatalf("LoadState: %v", err)
	}
	if !got.ExternalSharing {
		t.Errorf("externalSharing = false, want default-on")
	}
}

func TestLoadState_MalformedJSONErrors(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "bad.json")
	if err := os.WriteFile(path, []byte("not json"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	_, err := LoadState(path)
	if err == nil {
		t.Fatal("expected parse error")
	}
}

// ── SaveState ──────────────────────────────────────────────────────────────

func TestSaveState_RoundTrip(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "mcp-state.json")
	in := StateFile{Running: []string{"x", "y"}, ExternalSharing: false}
	if err := SaveState(path, in); err != nil {
		t.Fatalf("SaveState: %v", err)
	}
	out, err := LoadState(path)
	if err != nil {
		t.Fatalf("LoadState: %v", err)
	}
	if len(out.Running) != 2 || out.ExternalSharing {
		t.Errorf("round-trip = %+v", out)
	}
}

func TestSaveState_NilRunningPersistsAsEmpty(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "mcp-state.json")
	if err := SaveState(path, StateFile{Running: nil, ExternalSharing: true}); err != nil {
		t.Fatalf("SaveState: %v", err)
	}
	out, err := LoadState(path)
	if err != nil {
		t.Fatalf("LoadState: %v", err)
	}
	if out.Running == nil {
		t.Errorf("Running = nil, want empty slice")
	}
}

func TestSaveState_UnwritableDirErrors(t *testing.T) {
	bad := filepath.Join(t.TempDir(), "missing-parent", "state.json")
	err := SaveState(bad, StateFile{})
	if err == nil {
		t.Fatal("expected error writing into missing parent dir")
	}
}
