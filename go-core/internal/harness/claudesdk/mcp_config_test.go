package claudesdk

import (
	"encoding/json"
	"os"
	"testing"
)

// TestBuildMCPConfigSkipsWhenNoStub — without YHA_BRIDGE_STUB_PATH the
// helper returns (nil, nil) so the harness can omit --mcp-config.
func TestBuildMCPConfigSkipsWhenNoStub(t *testing.T) {
	t.Setenv(EnvBridgeStubPath, "")
	cfg, err := BuildMCPConfig(MCPConfigOpts{
		BridgeURL: "http://127.0.0.1:8443",
		SessionID: "s1",
	})
	if err != nil {
		t.Fatalf("BuildMCPConfig: %v", err)
	}
	if cfg != nil {
		t.Errorf("want nil config (no stub), got %+v", cfg)
	}
}

// TestBuildMCPConfigUsesEnvStubPath — when YHA_BRIDGE_STUB_PATH is set
// the helper materialises a config pointing at it.
func TestBuildMCPConfigUsesEnvStubPath(t *testing.T) {
	t.Setenv(EnvBridgeStubPath, "/opt/yha/mcp/yha-bridge-stub.js")
	t.Setenv(EnvNodeBin, "")
	cfg, err := BuildMCPConfig(MCPConfigOpts{
		BridgeURL: "http://127.0.0.1:8443",
		SessionID: "abc",
	})
	if err != nil {
		t.Fatalf("BuildMCPConfig: %v", err)
	}
	if cfg == nil {
		t.Fatal("want non-nil config")
	}
	entry, ok := cfg.MCPServers["MCP-Tools"]
	if !ok {
		t.Fatalf("missing MCP-Tools entry: %+v", cfg.MCPServers)
	}
	if entry.Command != "node" {
		t.Errorf("Command: want node, got %q", entry.Command)
	}
	if len(entry.Args) != 1 || entry.Args[0] != "/opt/yha/mcp/yha-bridge-stub.js" {
		t.Errorf("Args: %v", entry.Args)
	}
	if entry.Env["YHA_BRIDGE_URL"] != "http://127.0.0.1:8443" {
		t.Errorf("YHA_BRIDGE_URL: %q", entry.Env["YHA_BRIDGE_URL"])
	}
	if entry.Env["YHA_SESSION_ID"] != "abc" {
		t.Errorf("YHA_SESSION_ID: %q", entry.Env["YHA_SESSION_ID"])
	}
}

// TestBuildMCPConfigOptsOverrideEnv — explicit MCPConfigOpts values
// trump env vars.
func TestBuildMCPConfigOptsOverrideEnv(t *testing.T) {
	t.Setenv(EnvBridgeStubPath, "/env/stub.js")
	t.Setenv(EnvNodeBin, "/env/node")
	cfg, err := BuildMCPConfig(MCPConfigOpts{
		BridgeURL: "http://x:1",
		StubPath:  "/opt/explicit.js",
		NodeBin:   "/opt/node",
	})
	if err != nil {
		t.Fatalf("BuildMCPConfig: %v", err)
	}
	if cfg == nil {
		t.Fatal("want non-nil")
	}
	entry := cfg.MCPServers["MCP-Tools"]
	if entry.Command != "/opt/node" {
		t.Errorf("Command override failed: %q", entry.Command)
	}
	if entry.Args[0] != "/opt/explicit.js" {
		t.Errorf("Args override failed: %v", entry.Args)
	}
	if _, ok := entry.Env["YHA_SESSION_ID"]; ok {
		t.Errorf("YHA_SESSION_ID should be absent when SessionID is empty: %+v", entry.Env)
	}
}

// TestBuildMCPConfigRequiresBridgeURL — when StubPath is set but
// BridgeURL is missing, BuildMCPConfig returns an error so the
// configuration bug surfaces at boot.
func TestBuildMCPConfigRequiresBridgeURL(t *testing.T) {
	t.Setenv(EnvBridgeStubPath, "/x.js")
	_, err := BuildMCPConfig(MCPConfigOpts{SessionID: "s"})
	if err == nil {
		t.Errorf("expected error when BridgeURL missing")
	}
}

// TestWriteMCPConfigRoundtrip — the materialised file contains the
// expected JSON shape and Close removes it.
func TestWriteMCPConfigRoundtrip(t *testing.T) {
	cfg := &MCPConfig{
		MCPServers: map[string]MCPServerEntry{
			"MCP-Tools": {
				Command: "node",
				Args:    []string{"/x.js"},
				Env: map[string]string{
					"YHA_BRIDGE_URL": "http://x:1",
					"YHA_SESSION_ID": "s1",
				},
			},
		},
	}
	f, err := WriteMCPConfig(cfg)
	if err != nil {
		t.Fatalf("WriteMCPConfig: %v", err)
	}
	if f == nil {
		t.Fatal("want non-nil MCPConfigFile")
	}
	data, err := os.ReadFile(f.Path)
	if err != nil {
		t.Fatalf("ReadFile: %v", err)
	}
	var got MCPConfig
	if err := json.Unmarshal(data, &got); err != nil {
		t.Fatalf("Unmarshal: %v", err)
	}
	if got.MCPServers["MCP-Tools"].Command != "node" {
		t.Errorf("Command roundtrip: %+v", got.MCPServers)
	}
	// Close removes the file.
	if err := f.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if _, err := os.Stat(f.Path); !os.IsNotExist(err) {
		t.Errorf("expected file removed, stat err = %v", err)
	}
	// Second close is idempotent.
	if err := f.Close(); err != nil {
		t.Errorf("second Close should be no-op, got %v", err)
	}
}

// TestWriteMCPConfigNilNoOp — passing a nil cfg returns (nil, nil) so
// the harness can chain unconditionally.
func TestWriteMCPConfigNilNoOp(t *testing.T) {
	f, err := WriteMCPConfig(nil)
	if err != nil {
		t.Fatalf("WriteMCPConfig(nil): %v", err)
	}
	if f != nil {
		t.Errorf("want nil file, got %+v", f)
	}
}
