//go:build !windows

package main

import (
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"syscall"
	"time"

	"github.com/yha/core/internal/logger"
)

// installGoroutineDump arms a SIGUSR1 handler that writes a full
// goroutine stack dump to a timestamped file under dir, WITHOUT crashing
// the process. Go's built-in SIGQUIT dump kills the daemon (and every
// live session with it), so it's unusable on a running production core;
// SIGUSR1 here is the non-destructive equivalent.
//
// Why this exists: the codex stdout-consumer deadlock (codex finishes a
// turn, go-core stops draining its stdout, codex zombies blocked in
// write(), the turn hangs streaming:true until the bridge's 60-min
// sweep) is reproducible but the exact blocked goroutine couldn't be
// pinned — `sample` doesn't symbolize Go frames and there's no pprof.
// On the next repro: `kill -USR1 <core-pid>` then read the dumped file
// to see precisely which goroutine is parked on which lock/channel.
//
// SIGUSR2 is already taken (graceful drain, see drain_unix.go); SIGUSR1
// is otherwise unused by the daemon, so it's a safe diagnostic channel.
func installGoroutineDump(dir string, log *logger.Logger) {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGUSR1)
	go func() {
		for range ch {
			path, err := writeGoroutineDump(dir)
			if err != nil {
				log.Warn("goroutine-dump.write-failed", "err", err.Error())
				continue
			}
			log.Info("goroutine-dump.written", "path", path, "signal", "USR1")
		}
	}()
	log.Info("goroutine-dump armed", "signal", "USR1", "dir", dir,
		"hint", "kill -USR1 <pid> to capture all goroutine stacks without stopping the daemon")
}

// writeGoroutineDump captures every goroutine's stack and writes it to a
// fresh timestamped file. The buffer grows until runtime.Stack reports
// it captured everything (it truncates silently when the buffer is too
// small, so we can't trust a fixed size on a daemon with thousands of
// goroutines).
func writeGoroutineDump(dir string) (string, error) {
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return "", err
	}
	buf := make([]byte, 1<<20) // 1 MiB to start
	for {
		n := runtime.Stack(buf, true)
		if n < len(buf) {
			buf = buf[:n]
			break
		}
		buf = make([]byte, 2*len(buf))
	}
	name := fmt.Sprintf("goroutines-%s-pid%d.txt", time.Now().Format("20060102-150405"), os.Getpid())
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, buf, 0o644); err != nil {
		return "", err
	}
	return path, nil
}
