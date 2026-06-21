//go:build windows

package tools

import (
	"os"
	"os/exec"
)

// bashShell prefers Git Bash if installed (so users get familiar shell
// semantics for the Bash tool). Falls back to PowerShell otherwise. The
// daemon doesn't error out when bash is missing — the spawn just fails
// at runtime with the usual "executable file not found" error.
func bashShell() (string, []string) {
	candidates := []string{
		`C:\Program Files\Git\bin\bash.exe`,
		`C:\Program Files\Git\usr\bin\bash.exe`,
		`C:\Program Files (x86)\Git\bin\bash.exe`,
	}
	for _, p := range candidates {
		if _, err := os.Stat(p); err == nil {
			return p, []string{"-c"}
		}
	}
	return "powershell.exe", []string{"-NoProfile", "-Command"}
}

// Windows has no Setpgid; process trees are managed via job objects
// which we don't wire up here. Leave the SysProcAttr untouched.
func setBashProcAttr(c *exec.Cmd) {}

// killProcessGroup degrades to a single-process kill on Windows. Child
// shells spawned by the bash command may survive briefly until they
// notice their parent is gone. Acceptable for the bash tool's use case
// (short-lived user commands).
func killProcessGroup(c *exec.Cmd) error {
	if c.Process == nil {
		return nil
	}
	return c.Process.Kill()
}
