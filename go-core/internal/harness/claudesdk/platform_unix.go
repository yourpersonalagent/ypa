//go:build !windows

package claudesdk

import (
	"fmt"
	"os"
	"syscall"
)

func setNicenessNative(pid, nice int) error {
	if err := syscall.Setpriority(syscall.PRIO_PROCESS, pid, nice); err != nil {
		return fmt.Errorf("setpriority pid=%d nice=%d: %w", pid, nice, err)
	}
	return nil
}

func sendTermSignal(p *os.Process) error {
	return p.Signal(syscall.SIGTERM)
}
