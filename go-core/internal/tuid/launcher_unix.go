//go:build !windows

package tuid

import (
	"path/filepath"
	"runtime"
)

// launcherInvocation returns the argv prefix used to invoke the launcher
// script (yha.sh / yha.ps1) plus the absolute path to the script (for
// existence checks). On unix the script has a shebang so we can exec it
// directly — argv prefix is just the script path.
func launcherInvocation(repoRoot string) ([]string, string, error) {
	script := filepath.Join(repoRoot, "yha.sh")
	return []string{script}, script, nil
}

// stubEchoCommand wraps a single-line echo for the placeholder "not yet
// implemented" subcommands. Linux uses /bin/sh.
func stubEchoCommand(text string) []string {
	return []string{"/bin/sh", "-c", "echo '" + escapeSingleQuotes(text) + "'"}
}

// tailscaleFunnelArgv builds the argv for enabling tailscale funnel to
// the given local target (e.g. "http://127.0.0.1:8443"). On unix the
// funnel-config call needs sudo because tailscaled is owned by root and
// the unprivileged CLI can only inspect, not mutate, funnel config.
func tailscaleFunnelArgv(target string) []string {
	// The sandboxed macOS app CLI talks to its privileged system extension
	// directly; sudo is neither required nor reliable from the background
	// TUI daemon. Linux tailscaled still requires sudo for this mutation.
	if runtime.GOOS == "darwin" {
		return []string{"tailscale", "funnel", "--bg", target}
	}
	return []string{"sudo", "tailscale", "funnel", "--bg", target}
}

func escapeSingleQuotes(s string) string {
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		if s[i] == '\'' {
			out = append(out, `'\''`...)
		} else {
			out = append(out, s[i])
		}
	}
	return string(out)
}
