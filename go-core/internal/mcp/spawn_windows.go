//go:build windows

package mcp

import (
	"os/exec"
	"strconv"
)

// Windows has no process groups via SysProcAttr, so spawn-time setup is
// a no-op; the tree teardown lives in killMCPProcessGroup.
func setMCPProcAttr(c *exec.Cmd) {}

// killMCPProcessGroup terminates the child and its descendants. Close()
// calls this BEFORE Process.Kill(), while the parent is still alive, so
// taskkill can enumerate the tree from the parent PID. Common MCP servers
// are npx/node wrappers that spawn a grandchild node, so killing only the
// immediate child (Process.Kill alone) would orphan it — hence /T. A Job
// Object with KILL_ON_JOB_CLOSE is the heavier alternative; taskkill keeps
// this to one call with no extra handle bookkeeping on Connection. The
// error is best-effort (Close ignores it), matching the unix SIGTERM path.
func killMCPProcessGroup(c *exec.Cmd) error {
	if c.Process == nil || c.Process.Pid <= 0 {
		return nil
	}
	return exec.Command("taskkill", "/T", "/F", "/PID", strconv.Itoa(c.Process.Pid)).Run()
}
