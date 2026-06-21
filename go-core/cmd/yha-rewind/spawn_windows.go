//go:build windows

package main

import "os/exec"

// Windows has no Setsid. Process.Release() (called after Start) still
// detaches the child from go's waitpid loop, so the spawned restart
// process won't be reaped by us. Without DETACHED_PROCESS it shares
// the parent's console briefly, which is harmless for this use case.
func setDetachedProcAttr(c *exec.Cmd) {}
