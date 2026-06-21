//go:build windows

package claudebinary

import "os"

// Windows: setpriority equivalent would be SetPriorityClass via the
// Windows API. We don't wire it up — niceness is a best-effort hint
// already. Return nil so callers don't log a false failure.
func setNicenessNative(pid, nice int) error {
	return nil
}

// Windows: Process.Signal only supports os.Kill. SIGTERM is not
// deliverable. Use Kill() so the child actually goes away.
func sendTermSignal(p *os.Process) error {
	return p.Kill()
}
