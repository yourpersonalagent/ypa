package tui

// state.go — tiny on-disk persistence for client-only TUI state.
// Mirrors what the web frontend stores in localStorage so a TUI boot
// restores the last-used session, the same way the web restores the
// last `currentSession`. Stored at:
//
//   $XDG_CONFIG_HOME/yha/tui/last-session
//   ~/.config/yha/tui/last-session            (fallback)
//
// File contents = the session id string, nothing else. Failures are
// silent — this is a UX nicety, not load-bearing.

import (
	"os"
	"path/filepath"
	"strings"
)

func tuiStateDir() string {
	if v := os.Getenv("XDG_CONFIG_HOME"); v != "" {
		return filepath.Join(v, "yha", "tui")
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".config", "yha", "tui")
}

func loadLastSessionID() string {
	dir := tuiStateDir()
	if dir == "" {
		return ""
	}
	b, err := os.ReadFile(filepath.Join(dir, "last-session"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func saveLastSessionID(id string) {
	dir := tuiStateDir()
	if dir == "" || id == "" {
		return
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return
	}
	_ = os.WriteFile(filepath.Join(dir, "last-session"), []byte(id), 0o600)
}
