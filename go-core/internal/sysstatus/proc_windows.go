//go:build windows

package sysstatus

import "errors"

// ReadProcEnviron is unsupported on Windows: there's no /proc equivalent
// the daemon can read another process's environment from. Callers fall
// back to their own env (which is what sampleRuntime in tuid already
// does on Linux when /proc/<pid>/environ isn't readable).
func ReadProcEnviron(pid int) (map[string]string, error) {
	return nil, errors.New("ReadProcEnviron: not supported on windows")
}
