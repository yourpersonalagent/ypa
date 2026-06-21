// mcp_config.go — write a transient JSON file the claude CLI loads
// via --mcp-config so the SDK-style harness exposes YHA's MCP pool.
//
// Mirror of bridge/chat/agent.ts loadMcpServers():
//
//	{
//	  "mcpServers": {
//	    "MCP-Tools": {
//	      "command": "<node>",
//	      "args":    ["<path-to-yha-bridge-stub>"],
//	      "env":     { "YHA_BRIDGE_URL": "...", "YHA_BRIDGE_KEY": "...", "YHA_SESSION_ID": "..." }
//	    }
//	  }
//	}
//
// The Node bridge embeds this config in-memory and hands it to the SDK
// via `mcpServers`. The Go CLI counterpart accepts the same shape from
// disk via `--mcp-config <path>`. We materialise the file in the
// system tmpdir on each Stream call and clean it up on Close.
//
// Env overrides:
//   - YHA_BRIDGE_STUB_PATH — absolute path to yha-bridge-stub.js
//   - YHA_NODE_BIN         — node binary (default "node")
//
// Without YHA_BRIDGE_STUB_PATH the file is omitted entirely (no
// --mcp-config flag) and the harness still works for plain
// conversation; we log a Warn once.
package claudesdk

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// EnvBridgeStubPath is the env var holding the absolute path to
// yha-bridge-stub.js. When unset the harness skips MCP wiring.
const EnvBridgeStubPath = "YHA_BRIDGE_STUB_PATH"

// EnvNodeBin overrides the node executable used to spawn the MCP stub.
// Defaults to "node" (PATH lookup) when unset.
const EnvNodeBin = "YHA_NODE_BIN"

// MCPServerEntry models one server entry in the mcpServers map.
// Public so tests can assert on the serialised shape.
type MCPServerEntry struct {
	Command string            `json:"command"`
	Args    []string          `json:"args,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
}

// MCPConfig is the top-level on-disk shape the claude CLI consumes.
type MCPConfig struct {
	MCPServers map[string]MCPServerEntry `json:"mcpServers"`
}

// MCPConfigOpts is the input to BuildMCPConfig — the small set of
// per-call knobs the route layer hands down.
type MCPConfigOpts struct {
	// SessionID is forwarded to the stub via YHA_SESSION_ID so the
	// stub's mcp__MCP-Tools__bridge__AskUser route can address the
	// correct SSE stream. Empty = omit the env var.
	SessionID string

	// BridgeURL is the http://127.0.0.1:<port> URL the stub forwards
	// JSON-RPC frames to. Required — empty BridgeURL returns an error
	// because there's nothing useful the stub can talk to.
	BridgeURL string

	// StubPath overrides EnvBridgeStubPath. Empty falls back to the
	// env var; if both are empty BuildMCPConfig returns (nil, nil) so
	// the caller can omit --mcp-config entirely.
	StubPath string

	// NodeBin overrides EnvNodeBin. Empty falls back to the env var
	// or "node".
	NodeBin string
}

// BuildMCPConfig produces an in-memory MCPConfig from the opts. Returns
// (nil, nil) when no stub path is configured — the caller treats nil
// as "skip --mcp-config and warn once". Returns an error when a stub
// path IS configured but BridgeURL is missing (configuration bug).
func BuildMCPConfig(opts MCPConfigOpts) (*MCPConfig, error) {
	stub := opts.StubPath
	if stub == "" {
		stub = os.Getenv(EnvBridgeStubPath)
	}
	if stub == "" {
		return nil, nil
	}
	if opts.BridgeURL == "" {
		return nil, errors.New("claudesdk.BuildMCPConfig: BridgeURL required when StubPath is set")
	}
	node := opts.NodeBin
	if node == "" {
		node = os.Getenv(EnvNodeBin)
	}
	if node == "" {
		node = "node"
	}
	env := map[string]string{
		"YHA_BRIDGE_URL": opts.BridgeURL,
	}
	if k := os.Getenv("YHA_BRIDGE_KEY"); k != "" {
		env["YHA_BRIDGE_KEY"] = k
	}
	if opts.SessionID != "" {
		env["YHA_SESSION_ID"] = opts.SessionID
	}
	return &MCPConfig{
		MCPServers: map[string]MCPServerEntry{
			"MCP-Tools": {
				Command: node,
				Args:    []string{stub},
				Env:     env,
			},
		},
	}, nil
}

// MCPConfigFile owns the lifecycle of one materialised JSON config.
// Path is the absolute on-disk path the caller hands to --mcp-config.
// Close removes the file; safe to call multiple times.
type MCPConfigFile struct {
	Path string
	// closed prevents double-cleanup. Not a sync.Once so tests can
	// observe whether cleanup was reached.
	closed bool
}

// WriteMCPConfig serialises cfg to a transient JSON file in the
// system tmpdir and returns a handle whose Close removes the file.
// Returns (nil, nil) when cfg is nil so the caller can chain the
// "no stub configured" path without an extra nil check.
//
// The file is created with 0600 permissions because it embeds the
// YHA_BRIDGE_URL which, in some deployments, encodes a localhost
// auth token. The claude binary reads it once at startup; we delete
// after the spawn exits.
func WriteMCPConfig(cfg *MCPConfig) (*MCPConfigFile, error) {
	if cfg == nil {
		return nil, nil
	}
	enc, err := json.MarshalIndent(cfg, "", "  ")
	if err != nil {
		return nil, fmt.Errorf("claudesdk.WriteMCPConfig: marshal: %w", err)
	}
	f, err := os.CreateTemp("", "yha-claude-mcp-*.json")
	if err != nil {
		return nil, fmt.Errorf("claudesdk.WriteMCPConfig: tempfile: %w", err)
	}
	path := f.Name()
	// Ensure 0600 regardless of umask. os.CreateTemp uses 0600 already
	// on POSIX, but make it explicit so the invariant doesn't rely on
	// platform defaults.
	_ = os.Chmod(path, 0600)
	if _, err := f.Write(enc); err != nil {
		_ = f.Close()
		_ = os.Remove(path)
		return nil, fmt.Errorf("claudesdk.WriteMCPConfig: write: %w", err)
	}
	if err := f.Close(); err != nil {
		_ = os.Remove(path)
		return nil, fmt.Errorf("claudesdk.WriteMCPConfig: close: %w", err)
	}
	return &MCPConfigFile{Path: path}, nil
}

// Close removes the underlying file. Idempotent; missing-file errors
// are ignored so multi-stage cleanup (defer + explicit) is safe.
func (m *MCPConfigFile) Close() error {
	if m == nil || m.closed {
		return nil
	}
	m.closed = true
	if m.Path == "" {
		return nil
	}
	if err := os.Remove(m.Path); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

// ensureTmpdir is a defensive helper for environments where TMPDIR
// is set to a nonexistent path. Not currently called; kept for the
// follow-up that adds explicit TMPDIR validation to the route layer.
func ensureTmpdir() (string, error) {
	dir := os.TempDir()
	if dir == "" {
		return "", errors.New("os.TempDir() returned empty")
	}
	if err := os.MkdirAll(dir, 0700); err != nil {
		return "", err
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	return abs, nil
}
