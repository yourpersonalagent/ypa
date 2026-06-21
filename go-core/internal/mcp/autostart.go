// Autostart brings the running set back up after a daemon restart.
//
// The Node side does this in modules/mcp-client/lib/index.ts on boot:
// reads mcp-state.json's running array, looks each name up in the
// registry, and spawns it. Failures are logged but never fatal — a
// missing or broken server shouldn't block the rest of the daemon from
// coming online.
//
// Concurrency: each server starts in its own goroutine so a slow
// handshake on one doesn't serialise the others. We sync via WaitGroup
// (no errgroup — stdlib only).
//
// Cross-process serialisation: during `yha.sh go-reload` the new and
// old Go daemons can briefly both be alive (SO_REUSEPORT blue-green),
// and both would otherwise race to spawn the same MCP child. We hold a
// flock on <bridgeRoot>/mcp-autostart.lock — second daemon sees the
// lock held, logs a deferral, and returns without starting anything.
package mcp

import (
	"context"
	"path/filepath"
	"sync"
	"time"

	"github.com/yha/core/internal/logger"
)

// AutostartLockName is the filename appended to BridgeRoot for the
// cross-process flock. Exported so tests + ops tooling can locate it.
const AutostartLockName = "mcp-autostart.lock"

// Autostart reads the state file, looks each running entry up in the
// registry file, and starts them on the pool in parallel. Returns nil
// even if individual starts fail — they're logged. Returns an error
// only when the registry/state files themselves can't be read.
//
// A non-blocking flock at <statePath>/../mcp-autostart.lock prevents
// double-spawn during the brief window where a blue-green go-reload has
// two Go daemons running. The second caller logs an info message and
// returns nil — its sibling has already kicked the autostart pass for
// the running set.
func Autostart(ctx context.Context, pool *Pool, registryPath, statePath string, handshakeTimeout time.Duration, log *logger.Logger) error {
	if log == nil {
		log = logger.New(discardWriter{})
	}

	// Lock first. statePath lives at BridgeRoot/mcp-state.json so its
	// parent is the natural home for the lock file too.
	lockPath := filepath.Join(filepath.Dir(statePath), AutostartLockName)
	lock, locked, err := tryAcquireAutostartLock(lockPath)
	if err != nil {
		// Don't propagate — autostart is best-effort; a write-permission
		// hiccup on the lock file shouldn't block the daemon from
		// coming up.
		log.Warn("mcp.autostart-lock-error", "err", err, "path", lockPath)
	} else if !locked {
		log.Info("mcp.autostart-deferred",
			"reason", "another autostart in progress",
			"path", lockPath,
		)
		return nil
	}
	if lock != nil {
		defer releaseAutostartLock(lock)
	}

	state, err := LoadState(statePath)
	if err != nil {
		return err
	}
	if len(state.Running) == 0 {
		return nil
	}
	registry, err := LoadRegistry(registryPath)
	if err != nil {
		return err
	}

	var wg sync.WaitGroup
	for _, name := range state.Running {
		cfg, ok := registry[name]
		if !ok {
			log.Warn("mcp.autostart-missing", "name", name)
			continue
		}
		wg.Add(1)
		go func(cfg ServerConfig) {
			defer wg.Done()
			conn, err := pool.Start(ctx, cfg, handshakeTimeout)
			if err != nil {
				log.Warn("mcp.autostart-failed", "name", cfg.Name, "err", err)
				return
			}
			conn.infoMu.RLock()
			ok := conn.OK
			startErr := conn.Err
			conn.infoMu.RUnlock()
			if !ok {
				log.Warn("mcp.autostart-handshake", "name", cfg.Name, "err", startErr)
				return
			}
			log.Info("mcp.autostart-ok", "name", cfg.Name, "tools", len(conn.snapshotTools()))
		}(cfg)
	}
	wg.Wait()
	return nil
}

// tryAcquireAutostartLock and releaseAutostartLock are defined per-
// platform in autostart_unix.go / autostart_windows.go. On unix they
// use flock(2) for non-blocking exclusive locks. Windows lacks flock;
// the Windows variant is a no-op (always "acquired") because blue-green
// reload isn't supported there anyway, so the race the lock guards
// against can't happen.
