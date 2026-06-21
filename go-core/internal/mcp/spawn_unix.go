//go:build !windows

package mcp

import (
	"os/exec"
	"syscall"
)

func setMCPProcAttr(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func killMCPProcessGroup(c *exec.Cmd) error {
	if c.Process == nil {
		return nil
	}
	if pid := c.Process.Pid; pid > 0 {
		return syscall.Kill(-pid, syscall.SIGTERM)
	}
	return nil
}
