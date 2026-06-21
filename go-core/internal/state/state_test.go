package state

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadConfigMissingFileReturnsEmpty(t *testing.T) {
	c, err := LoadConfig(filepath.Join(t.TempDir(), "does-not-exist.json"))
	if err != nil {
		t.Fatalf("expected no error on missing config, got %v", err)
	}
	if len(c.Providers) != 0 || len(c.Defaults) != 0 {
		t.Errorf("expected empty config, got %+v", c)
	}
}

func TestSaveLoadRoundTripPreservesDefaults(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	in := Config{
		Providers: []map[string]any{
			{"name": "Anthropic", "model": "claude-opus-4-7"},
		},
		Defaults: map[string]any{
			"model":        "claude-sonnet-4-6",
			"llm_provider": "Anthropic",
			"rateLimit": map[string]any{
				"default":   map[string]any{"rpm": float64(60), "concurrency": float64(1)},
				"Anthropic": map[string]any{"rpm": float64(120)},
			},
		},
	}
	if err := SaveConfig(path, in); err != nil {
		t.Fatalf("save: %v", err)
	}
	out, err := LoadConfig(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if got := out.Defaults["model"]; got != "claude-sonnet-4-6" {
		t.Errorf("defaults.model = %v, want claude-sonnet-4-6", got)
	}
	rl, _ := out.Defaults["rateLimit"].(map[string]any)
	if rl == nil {
		t.Fatalf("rateLimit not preserved: %+v", out.Defaults)
	}
	an, _ := rl["Anthropic"].(map[string]any)
	if an["rpm"].(float64) != 120 {
		t.Errorf("anthropic rpm = %v, want 120", an["rpm"])
	}
}

func TestSaveStripsAPIKey(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	in := Config{
		Providers: []map[string]any{
			{"name": "Anthropic", "api_key": "sk-secret"},
		},
		Defaults: map[string]any{},
	}
	if err := SaveConfig(path, in); err != nil {
		t.Fatalf("save: %v", err)
	}
	raw, _ := os.ReadFile(path)
	if strings.Contains(string(raw), "sk-secret") {
		t.Errorf("api_key leaked into JSON: %s", raw)
	}
}

func TestLoadConfigInjectsAPIKeyFromEnv(t *testing.T) {
	path := filepath.Join(t.TempDir(), "config.json")
	if err := SaveConfig(path, Config{
		Providers: []map[string]any{{"name": "Anthropic"}},
		Defaults:  map[string]any{},
	}); err != nil {
		t.Fatalf("save: %v", err)
	}
	t.Setenv("ANTHROPIC_API_KEY", "sk-test-12345")
	c, err := LoadConfig(path)
	if err != nil {
		t.Fatalf("load: %v", err)
	}
	if got := c.Providers[0]["api_key"]; got != "sk-test-12345" {
		t.Errorf("api_key not injected, got %v", got)
	}
}

func TestWriteEnvKeyAddsNew(t *testing.T) {
	envPath := filepath.Join(t.TempDir(), ".env")
	if err := WriteEnvKey(envPath, "FOO", "bar"); err != nil {
		t.Fatalf("write: %v", err)
	}
	body, _ := os.ReadFile(envPath)
	if string(body) != "FOO=bar\n" {
		t.Errorf("got %q, want %q", body, "FOO=bar\n")
	}
}

func TestWriteEnvKeyReplacesExisting(t *testing.T) {
	envPath := filepath.Join(t.TempDir(), ".env")
	_ = os.WriteFile(envPath, []byte("FOO=old\nBAR=keep\n"), 0o600)
	if err := WriteEnvKey(envPath, "FOO", "new"); err != nil {
		t.Fatalf("write: %v", err)
	}
	body, _ := os.ReadFile(envPath)
	want := "FOO=new\nBAR=keep\n"
	if string(body) != want {
		t.Errorf("got %q, want %q", body, want)
	}
}

func TestBridgeInternalKeyShape(t *testing.T) {
	a := generateBridgeInternalKey()
	b := generateBridgeInternalKey()
	if a == b {
		t.Error("two BridgeInternalKeys collided — RNG broken?")
	}
	if !strings.HasPrefix(a, "sk-bridge-") {
		t.Errorf("missing prefix: %q", a)
	}
	suffix := strings.TrimPrefix(a, "sk-bridge-")
	if len(suffix) != 64 {
		t.Errorf("key body len = %d, want 64 hex chars", len(suffix))
	}
}

func TestResolveBridgeInternalKeyPrefersEnv(t *testing.T) {
	t.Setenv("YHA_BRIDGE_KEY", "sk-bridge-shared-test-value")
	got := resolveBridgeInternalKey(nil)
	if got != "sk-bridge-shared-test-value" {
		t.Errorf("env var ignored, got %q", got)
	}
}

func TestResolveBridgeInternalKeyFallsBackWhenUnset(t *testing.T) {
	t.Setenv("YHA_BRIDGE_KEY", "")
	got := resolveBridgeInternalKey(nil)
	if !strings.HasPrefix(got, "sk-bridge-") {
		t.Errorf("fallback shape wrong: %q", got)
	}
	if got == "sk-bridge-shared-test-value" {
		t.Error("fallback unexpectedly returned the shared test value")
	}
}

func TestNewStoreUsesEnvKey(t *testing.T) {
	t.Setenv("YHA_BRIDGE_KEY", "sk-bridge-store-env-test")
	cfgPath := filepath.Join(t.TempDir(), "config.json")
	store, err := NewStore(cfgPath, nil)
	if err != nil {
		t.Fatalf("NewStore: %v", err)
	}
	if got := store.BridgeInternalKey(); got != "sk-bridge-store-env-test" {
		t.Errorf("BridgeInternalKey() = %q, want shared env value", got)
	}
}

func TestStoreConfigClonesOnRead(t *testing.T) {
	cfgPath := filepath.Join(t.TempDir(), "config.json")
	store, _ := NewStore(cfgPath, nil)
	store.SetConfig(Config{
		Providers: []map[string]any{{"name": "Anthropic"}},
		Defaults:  map[string]any{"model": "x"},
	})
	c1 := store.Config()
	c1.Defaults["model"] = "tampered"
	c2 := store.Config()
	if c2.Defaults["model"] != "x" {
		t.Errorf("Config() mutation leaked back to store: %v", c2.Defaults)
	}
}
