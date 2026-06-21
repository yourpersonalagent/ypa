// home.go — port of bridge/chat/helpers.ts deriveIsolatedHome.
//
// Why this exists: when CLAUDE_CONFIG_DIR points at an isolated
// per-instance state directory (e.g. /home/user/.claude-instance-2/.claude),
// the binary's $HOME must also be the parent of that directory so any
// fallback paths Claude derives from $HOME (XDG dirs, libsecret keys,
// credential JSON files) land inside the same isolated tree. Multiple
// subscription instances otherwise overwrite each other's state.
//
// The TS helper splits the path on the trailing ".claude" segment and
// returns the parent. We mirror that exactly so a side-by-side
// directory layout migrates without surprises.
package claudesdk

import (
	"path/filepath"
	"strings"
)

// IsolatedHomeMarker is the suffix the helper looks for (".claude").
// Exported so callers can reuse the constant in tests or in alternate
// SDKs that wrap the same binary.
const IsolatedHomeMarker = ".claude"

// deriveIsolatedHome mirrors bridge/chat/helpers.ts deriveIsolatedHome.
//
// configDir typically looks like "/home/user/.claude-instance-N/.claude" —
// strip the trailing ".claude" segment to get the per-instance HOME.
// Returns "" if the path doesn't end with ".claude" (TS returns null).
//
// The TS implementation accepts a `suffix` parameter (".claude" |
// ".codex") so it can be reused for the codex harness. We hard-code
// ".claude" here because the claudesdk port only ever cares about the
// claude config dir; the codex harness has its own helper.
func deriveIsolatedHome(configDir string) string {
	if configDir == "" {
		return ""
	}
	clean := filepath.Clean(configDir)
	dir, base := filepath.Split(clean)
	if base != IsolatedHomeMarker {
		return ""
	}
	// Trim any trailing separator that filepath.Split leaves so the
	// returned path doesn't end in "/".
	dir = strings.TrimRight(dir, string(filepath.Separator))
	if dir == "" {
		return ""
	}
	return dir
}
