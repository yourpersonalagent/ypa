//go:build windows

package mcp

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

// Windows advisory lock via LockFileEx — the direct analog of the unix
// flock(LOCK_EX|LOCK_NB) path. The autostart lock stops two daemons from
// racing to spawn the same MCP child; the production host is now Windows
// (see [[yha-machine-migration]]), so this must be a real lock, not the
// no-op it used to be. LOCKFILE_FAIL_IMMEDIATELY turns contention into a
// return instead of a block, and ERROR_LOCK_VIOLATION maps to
// "not acquired" (mirrors unix EWOULDBLOCK). Locking one byte past an
// empty file is legal on Windows.
func tryAcquireAutostartLock(path string) (*os.File, bool, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, false, err
	}
	var overlapped windows.Overlapped
	err = windows.LockFileEx(
		windows.Handle(f.Fd()),
		windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY,
		0, 1, 0, &overlapped,
	)
	if err != nil {
		_ = f.Close()
		if errors.Is(err, windows.ERROR_LOCK_VIOLATION) {
			return nil, false, nil
		}
		return nil, false, err
	}
	return f, true, nil
}

func releaseAutostartLock(f *os.File) {
	var overlapped windows.Overlapped
	_ = windows.UnlockFileEx(windows.Handle(f.Fd()), 0, 1, 0, &overlapped)
	_ = f.Close()
}
