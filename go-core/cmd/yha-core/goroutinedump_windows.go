//go:build windows

package main

import "github.com/yha/core/internal/logger"

// Windows has no SIGUSR1. The goroutine-dump diagnostic is a no-op
// there; operators can still fall back to the (process-crashing)
// SIGQUIT-equivalent or attach a debugger. Kept as a stub so main.go
// calls the same function on every platform.
func installGoroutineDump(dir string, log *logger.Logger) {
	log.Info("goroutine-dump unavailable on windows (no SIGUSR1)")
}
