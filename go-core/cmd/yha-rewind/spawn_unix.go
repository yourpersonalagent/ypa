//go:build !windows

package main

import (
	"os/exec"
	"syscall"
)

func setDetachedProcAttr(c *exec.Cmd) {
	c.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}
