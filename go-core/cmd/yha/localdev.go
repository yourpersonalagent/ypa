package main

// localdev.go — auto-discover bearer token + daemon URL when the user
// runs the CLI/TUI from a yha-modular checkout without --token / --url.
//
// Rationale: the daemon enforces bearer auth on every /v1/* request
// (even over Unix socket — Phase 2d). Without auto-discovery, a fresh
// `yha tui` from the project dir 401s on every list call and shows an
// empty Sessions tab, which is the opposite of what the user expects.
// The bearer lives in bridge/.env on the same machine; the CLI reads
// it directly so the local UX matches the web app's "just works" feel.

import (
	"bufio"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

var (
	localDevOnce sync.Once
	localDevURL  string
	localDevTok  string
	localDevKey  string
)

// localDevDefaults returns (url, bearerToken) discovered from the
// nearest bridge/.env walking up from the current working directory.
// Both are empty strings when discovery fails. Cached after first call.
//
// We only return a URL when bridge/.env is found AND it doesn't pin a
// remote endpoint — this is a "local dev convenience" feature, not a
// production override. Production users still set YHA_URL / --url.
func localDevDefaults() (url, token string) {
	localDevOnce.Do(func() {
		envPath := findLocalBridgeEnv()
		if envPath == "" {
			return
		}
		vals := readEnvFile(envPath)
		localDevTok = vals["YHA_BEARER_TOKEN"]
		localDevKey = vals["YHA_BRIDGE_KEY"]
		// The daemon listens on :8443 by default. We pick that as the
		// local URL so we skip the (often-empty) Unix socket path.
		// pm2 process name doesn't matter here — what matters is that
		// the user has a daemon up that the CLI can reach quickly.
		if localDevTok != "" {
			localDevURL = "http://127.0.0.1:8443"
		}
	})
	return localDevURL, localDevTok
}

// localDevBridgeKey returns the shared bridge key used to authenticate to the
// daemon's /proxy/* endpoints (e.g. /proxy/mcp-bridge/rpc, which the bridge
// gates on x-bridge-key whenever YHA_BRIDGE_KEY is set). Prefers an explicit
// env var; otherwise falls back to the YHA_BRIDGE_KEY discovered in the local
// bridge/.env. Returns "" when neither is present — dev/ephemeral mode, where
// the bridge runs with a random per-boot key and skips the check entirely.
func localDevBridgeKey() string {
	if v := os.Getenv("YHA_BRIDGE_KEY"); v != "" {
		return v
	}
	localDevDefaults() // ensure the one-shot bridge/.env discovery has run
	return localDevKey
}

// findLocalBridgeEnv looks for a bridge/.env in two places:
//
//  1. Walking up from the current working directory (so a checkout's
//     project root finds itself).
//  2. Walking up from the directory of the running binary (so `yha tui`
//     run from anywhere on PATH still discovers the project's .env via
//     the binary's install location, e.g. <repo>/bin/yha → <repo>/).
//
// The first hit wins. Returns "" when neither path yields a bridge/.env
// within ~6 directory levels.
func findLocalBridgeEnv() string {
	if cwd, err := os.Getwd(); err == nil {
		if p := walkUpForBridgeEnv(cwd); p != "" {
			return p
		}
	}
	if exe, err := os.Executable(); err == nil {
		// Resolve symlinks (admin/.local/bin/yha → repo/bin/yha) so we
		// walk up from the real install dir, not the symlink farm.
		if real, err := filepath.EvalSymlinks(exe); err == nil {
			exe = real
		}
		if p := walkUpForBridgeEnv(filepath.Dir(exe)); p != "" {
			return p
		}
	}
	return ""
}

func walkUpForBridgeEnv(start string) string {
	dir := start
	for i := 0; i < 6; i++ {
		candidate := filepath.Join(dir, "bridge", ".env")
		if st, err := os.Stat(candidate); err == nil && !st.IsDir() {
			return candidate
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return ""
}

// readEnvFile parses KEY=VALUE lines from a dotenv-style file. Quoted
// values get unquoted; everything after `#` (when not in a quoted run)
// is dropped. Lenient: malformed lines are skipped silently — this is
// best-effort discovery, not a config validator.
func readEnvFile(path string) map[string]string {
	out := map[string]string{}
	f, err := os.Open(path)
	if err != nil {
		return out
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	for sc.Scan() {
		line := strings.TrimSpace(sc.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		eq := strings.IndexByte(line, '=')
		if eq <= 0 {
			continue
		}
		key := strings.TrimSpace(line[:eq])
		val := strings.TrimSpace(line[eq+1:])
		// Strip a trailing inline comment when not inside quotes.
		if !strings.HasPrefix(val, `"`) && !strings.HasPrefix(val, `'`) {
			if h := strings.Index(val, " #"); h >= 0 {
				val = strings.TrimSpace(val[:h])
			}
		}
		// Unquote.
		if len(val) >= 2 {
			if (val[0] == '"' && val[len(val)-1] == '"') ||
				(val[0] == '\'' && val[len(val)-1] == '\'') {
				val = val[1 : len(val)-1]
			}
		}
		out[key] = val
	}
	return out
}

// applyLocalDevDefaults fills in URL and Token from local discovery
// when the caller's values are empty. Used by both `yha tui` and the
// non-interactive CLI commands so they share one auto-config path.
func applyLocalDevDefaults(url, token *string) {
	if *url != "" && *token != "" {
		return
	}
	dURL, dTok := localDevDefaults()
	if *url == "" && dURL != "" {
		*url = dURL
	}
	if *token == "" && dTok != "" {
		*token = dTok
	}
}
