//go:build windows

package tuid

import (
	"os"
	"path/filepath"
)

// launcherInvocation returns the argv prefix to invoke yha.ps1 via
// PowerShell. Bypass execution policy so unsigned scripts run without
// requiring the user to flip a global policy. NoProfile skips loading
// the user's profile, which is both faster and more deterministic.
func launcherInvocation(repoRoot string) ([]string, string, error) {
	script := filepath.Join(repoRoot, "yha.ps1")
	return []string{"powershell.exe", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script}, script, nil
}

// stubEchoCommand uses PowerShell's Write-Host on Windows. Avoid cmd.exe
// echo because its quoting rules differ from bash and we don't want to
// special-case characters.
func stubEchoCommand(text string) []string {
	return []string{"powershell.exe", "-NoProfile", "-Command", "Write-Host", text}
}

// tailscaleFunnelArgv builds the argv for enabling tailscale funnel to
// the given local target. On Windows the daemon (tailscaled) runs as a
// SYSTEM service and tailscale.exe sends it RPCs over a local pipe — no
// elevation needed for funnel config, unlike unix. Try the standard
// install path first so the spawn works even when tailscale isn't on
// PATH (which is common right after install, before a shell restart).
func tailscaleFunnelArgv(target string) []string {
	candidates := []string{
		`C:\Program Files\Tailscale\tailscale.exe`,
		`C:\Program Files (x86)\Tailscale\tailscale.exe`,
	}
	bin := "tailscale.exe" // fall through to PATH
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			bin = p
			break
		}
	}
	return []string{bin, "funnel", "--bg", target}
}
