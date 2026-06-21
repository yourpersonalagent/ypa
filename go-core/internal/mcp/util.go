package mcp

import (
	"bufio"
	"io"
	"os"
	"path/filepath"
	"strings"
)

// osEnviron is a thin wrapper so pool.go can read process env without
// importing os twice (and so tests can stub it via an init-time swap
// if needed in the future).
func osEnviron() []string { return os.Environ() }

// firstPartyMCP reports whether the spawn config points at a YHA-shipped MCP
// script. First-party scripts live under bridge/mcp/ (referenced as
// ./mcp/*.js); user-configured third-party servers run arbitrary commands
// (npx, docker, absolute node_modules paths, etc.). Only first-party scripts
// are trusted to receive the bridge's shared secret.
// First-party scripts are spawned with the bridge root as cwd and referenced
// by a relative path rooted at the shipped `mcp/` directory (e.g.
// "./mcp/bash-console-server.js"). We therefore require the cleaned arg to be a
// relative path whose first segment is exactly "mcp". This matches the Node
// gate (which resolves args against the bridge dir and requires the result to
// live under bridge/mcp/) and refuses the previous suffix-only match — an
// absolute "/tmp/attacker/mcp/evil.js" or a "../escape/mcp/x.js" must NOT be
// trusted with the bridge secret.
func firstPartyMCP(args []string) bool {
	for _, a := range args {
		lower := strings.ToLower(a)
		if !strings.HasSuffix(lower, ".js") && !strings.HasSuffix(lower, ".mjs") &&
			!strings.HasSuffix(lower, ".cjs") && !strings.HasSuffix(lower, ".ts") {
			continue
		}
		if filepath.IsAbs(a) {
			continue
		}
		clean := filepath.ToSlash(filepath.Clean(a))
		if clean == ".." || strings.HasPrefix(clean, "../") {
			continue // escapes the bridge root
		}
		if clean == "mcp" || strings.HasPrefix(clean, "mcp/") {
			return true
		}
	}
	return false
}

// filterBridgeSecrets removes the bridge's shared auth secrets from an env
// slice so they aren't inherited by an untrusted child. YHA_BRIDGE_KEY is the
// master secret shared between the Node bridge and Go core; BRIDGE_INTERNAL_KEY
// is its mirror. Either one grants /internal/* + /proxy/* authority.
func filterBridgeSecrets(env []string) []string {
	out := make([]string, 0, len(env))
	for _, kv := range env {
		if strings.HasPrefix(kv, "YHA_BRIDGE_KEY=") || strings.HasPrefix(kv, "BRIDGE_INTERNAL_KEY=") {
			continue
		}
		out = append(out, kv)
	}
	return out
}

func bufioReader(r io.Reader) *bufio.Reader {
	return bufio.NewReader(r)
}

func trimRightNewline(s string) string {
	return strings.TrimRight(s, "\r\n")
}
