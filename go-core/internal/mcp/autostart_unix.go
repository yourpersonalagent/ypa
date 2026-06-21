//go:build !windows

package mcp

import (
	"errors"
	"os"
	"syscall"
)

// tryAcquireAutostartLock opens (creating if absent) the lock file at
// path and attempts a non-blocking exclusive flock. Returns:
//   - (file, true, nil)  when the lock was acquired
//   - (nil, false, nil)  when another process already holds it (EWOULDBLOCK)
//   - (nil, false, err)  when the open itself failed
func tryAcquireAutostartLock(path string) (*os.File, bool, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return nil, false, err
	}
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		_ = f.Close()
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, false, nil
		}
		return nil, false, err
	}
	return f, true, nil
}

// releaseAutostartLock unlocks + closes; errors are swallowed since the
// daemon is moving on either way.
func releaseAutostartLock(f *os.File) {
	_ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN)
	_ = f.Close()
}
