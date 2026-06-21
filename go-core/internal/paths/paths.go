// Package paths centralises filesystem path resolution.
//
// Mirrors bridge/core/paths.ts but resolves at runtime instead of build
// time. BridgeRoot is read from YHA_BRIDGE_ROOT or, failing that, falls
// back to the parent of the running binary's directory (e.g. when the
// binary lives at <repo>/bin/yha-core, BridgeRoot is <repo>/bridge).
package paths

import (
	"os"
	"path/filepath"
	"sync"
)

var (
	once       sync.Once
	bridgeRoot string
)

// BridgeRoot returns the absolute path of the Node bridge directory.
// First call resolves it; subsequent calls return the cached value.
func BridgeRoot() string {
	once.Do(func() {
		if v := os.Getenv("YHA_BRIDGE_ROOT"); v != "" {
			bridgeRoot, _ = filepath.Abs(v)
			return
		}
		exe, err := os.Executable()
		if err == nil {
			// Repo layout: <repo>/bin/yha-core → <repo>/bridge
			repo := filepath.Dir(filepath.Dir(exe))
			candidate := filepath.Join(repo, "bridge")
			if st, err := os.Stat(candidate); err == nil && st.IsDir() {
				bridgeRoot = candidate
				return
			}
		}
		// Last-resort fallback so the binary still starts. Callers that
		// absolutely need the path should error out themselves.
		cwd, _ := os.Getwd()
		bridgeRoot = filepath.Join(cwd, "bridge")
	})
	return bridgeRoot
}

func SessionsDir() string  { return filepath.Join(BridgeRoot(), "sessions") }
func UploadsDir() string   { return filepath.Join(BridgeRoot(), "uploads") }
func MCPRegistry() string  { return filepath.Join(BridgeRoot(), "mcp-registry.json") }
func MCPState() string     { return filepath.Join(BridgeRoot(), "mcp-state.json") }
func ConfigPath() string   { return filepath.Join(BridgeRoot(), "config.json") }
func AuthLogPath() string  { return filepath.Join(BridgeRoot(), "auth-logins.log") }
func ImportantPath() string { return filepath.Join(BridgeRoot(), "important-memory.json") }

// SessionsDBPath is bridge/data/sessions.db — the SQLite file the bridge
// canonically writes to and Go-core writes finalize records into (Step 6 of
// docs/SQL-migration-plan.md). Returned even if the file doesn't exist yet
// so the caller can handle the missing-DB case explicitly.
func SessionsDBPath() string { return filepath.Join(BridgeRoot(), "data", "sessions.db") }

// ── yha TUI daemon state ──────────────────────────────────────────────────
// Everything the TUI daemon (yha-tui-daemon, pm2 service YHA-TUI-Daemon)
// persists lives under bridge/state/yha-tui/. Returned paths may not exist
// yet — callers MkdirAll as needed. See docs/YHA-TUI-Replacement-Plan.md.

func TUIStateDir() string  { return filepath.Join(BridgeRoot(), "state", "yha-tui") }
func TUIJobsDir() string   { return filepath.Join(TUIStateDir(), "jobs") }
func TUISocketPath() string { return filepath.Join(TUIStateDir(), "daemon.sock") }
func TUIConfigPath() string { return filepath.Join(TUIStateDir(), "config.toml") }
func TUIDaemonPID() string  { return filepath.Join(TUIStateDir(), "daemon.pid") }
