//go:build !windows

package tools

import (
	"os/exec"
	"syscall"
)

func bashShell() (string, []string) {
	return "/bin/sh", []string{"-c"}
}

func setBashProcAttr(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func killProcessGroup(c *exec.Cmd) error {
	if c.Process == nil {
		return nil
	}
	pid := c.Process.Pid
	if pid > 0 {
		if err := syscall.Kill(-pid, syscall.SIGTERM); err == nil {
			return nil
		}
	}
	return c.Process.Signal(syscall.SIGTERM)
}
