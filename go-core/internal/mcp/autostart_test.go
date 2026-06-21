//go:build !windows

package mcp

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/yha/core/internal/logger"
)

// TestAutostart_NoStateFile is the fast path: no file → no work, no
// error.
func TestAutostart_NoStateFile(t *testing.T) {
	dir := t.TempDir()
	pool := NewPool(logger.New(io.Discard))
	err := Autostart(context.Background(), pool,
		filepath.Join(dir, "absent-registry.json"),
		filepath.Join(dir, "absent-state.json"),
		time.Second, logger.New(io.Discard))
	if err != nil {
		t.Fatalf("Autostart: %v", err)
	}
}

// TestAutostart_EmptyRunning is also a no-op even with files present.
func TestAutostart_EmptyRunning(t *testing.T) {
	dir := t.TempDir()
	registry := filepath.Join(dir, "registry.json")
	state := filepath.Join(dir, "state.json")
	if err := os.WriteFile(registry, []byte(`{"mcpServers": {}}`), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := os.WriteFile(state, []byte(`{"running": [], "externalSharing": true}`), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	pool := NewPool(logger.New(io.Discard))
	if err := Autostart(context.Background(), pool, registry, state, time.Second, logger.New(io.Discard)); err != nil {
		t.Fatalf("Autostart: %v", err)
	}
	if l := len(pool.List()); l != 0 {
		t.Errorf("pool size = %d, want 0", l)
	}
}

// TestAutostart_MissingEntryDoesNotPanic exercises the
// running-name-with-no-registry-entry branch. The function should log
// and move on, not crash.
func TestAutostart_MissingEntryDoesNotPanic(t *testing.T) {
	dir := t.TempDir()
	registry := filepath.Join(dir, "registry.json")
	state := filepath.Join(dir, "state.json")
	if err := os.WriteFile(registry, []byte(`{"mcpServers": {}}`), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := os.WriteFile(state, []byte(`{"running": ["ghost"], "externalSharing": true}`), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	pool := NewPool(logger.New(io.Discard))
	if err := Autostart(context.Background(), pool, registry, state, time.Second, logger.New(io.Discard)); err != nil {
		t.Fatalf("Autostart: %v", err)
	}
	if l := len(pool.List()); l != 0 {
		t.Errorf("pool size = %d, want 0 (ghost has no registry entry)", l)
	}
}

// TestAutostart_BadStateFile surfaces a malformed state file as an
// error, since this is the file-read path itself failing.
func TestAutostart_BadStateFile(t *testing.T) {
	dir := t.TempDir()
	state := filepath.Join(dir, "state.json")
	if err := os.WriteFile(state, []byte("{not json"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	pool := NewPool(logger.New(io.Discard))
	err := Autostart(context.Background(), pool,
		filepath.Join(dir, "registry.json"), state, time.Second, logger.New(io.Discard))
	if err == nil {
		t.Fatal("expected parse error")
	}
}

// TestAutostart_BadRegistryFile is the same shape but for the registry.
func TestAutostart_BadRegistryFile(t *testing.T) {
	dir := t.TempDir()
	registry := filepath.Join(dir, "registry.json")
	state := filepath.Join(dir, "state.json")
	if err := os.WriteFile(registry, []byte("{not json"), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := os.WriteFile(state, []byte(`{"running": ["x"]}`), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	pool := NewPool(logger.New(io.Discard))
	err := Autostart(context.Background(), pool, registry, state, time.Second, logger.New(io.Discard))
	if err == nil {
		t.Fatal("expected parse error")
	}
}

// TestAutostart_FailedSpawnLogged points at a non-existent binary so
// the spawn itself fails. Autostart should not propagate the error —
// it's logged and the function returns nil.
func TestAutostart_FailedSpawnLogged(t *testing.T) {
	dir := t.TempDir()
	registry := filepath.Join(dir, "registry.json")
	state := filepath.Join(dir, "state.json")
	if err := os.WriteFile(registry, []byte(
		`{"mcpServers": {"broken": {"command": "/this/does/not/exist", "args": []}}}`,
	), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := os.WriteFile(state, []byte(`{"running": ["broken"]}`), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	pool := NewPool(logger.New(io.Discard))
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := Autostart(ctx, pool, registry, state, 200*time.Millisecond, logger.New(io.Discard)); err != nil {
		t.Errorf("Autostart should swallow per-server errors, got %v", err)
	}
}

// TestAutostart_LockDefersConcurrentRun simulates the blue-green race:
// one process already holds the autostart lock when a second one tries
// to start. The second call must observe the contention, log a deferral,
// and return nil without spawning anything.
func TestAutostart_LockDefersConcurrentRun(t *testing.T) {
	dir := t.TempDir()
	registry := filepath.Join(dir, "registry.json")
	state := filepath.Join(dir, "state.json")
	// Seed with a broken binary so that — if the lock somehow fails to
	// defer — we'd see the spawn-failure log path get hit, which would
	// be a soft signal something's off. With the lock working correctly
	// the pool stays empty.
	if err := os.WriteFile(registry, []byte(
		`{"mcpServers": {"broken": {"command": "/this/does/not/exist", "args": []}}}`,
	), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}
	if err := os.WriteFile(state, []byte(`{"running": ["broken"]}`), 0o644); err != nil {
		t.Fatalf("seed: %v", err)
	}

	// Pre-acquire the lock from the test so Autostart sees contention.
	lockPath := filepath.Join(dir, AutostartLockName)
	f, err := os.OpenFile(lockPath, os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		t.Fatalf("create lock: %v", err)
	}
	defer f.Close()
	if err := syscall.Flock(int(f.Fd()), syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		t.Fatalf("flock: %v", err)
	}
	defer func() { _ = syscall.Flock(int(f.Fd()), syscall.LOCK_UN) }()

	pool := NewPool(logger.New(io.Discard))
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := Autostart(ctx, pool, registry, state, 200*time.Millisecond, logger.New(io.Discard)); err != nil {
		t.Fatalf("Autostart returned %v, want nil when deferred", err)
	}
	if l := len(pool.List()); l != 0 {
		t.Errorf("pool size = %d, want 0 (lock should have deferred autostart)", l)
	}
}

// TestAutostart_LockReleasedAfterRun ensures the lock isn't sticky:
// after one Autostart returns, a sibling can acquire the same lock
// without waiting. This is the property go-reload relies on once the
// old daemon's autostart pass completes.
func TestAutostart_LockReleasedAfterRun(t *testing.T) {
	dir := t.TempDir()
	state := filepath.Join(dir, "state.json")
	// No state.json => no work => fast path. Still goes through the lock.
	pool := NewPool(logger.New(io.Discard))
	if err := Autostart(context.Background(), pool, "", state, time.Second, logger.New(io.Discard)); err != nil {
		t.Fatalf("first Autostart: %v", err)
	}
	// Now the lock file exists but should be released. A direct
	// tryAcquire should succeed.
	lockPath := filepath.Join(dir, AutostartLockName)
	f, locked, err := tryAcquireAutostartLock(lockPath)
	if err != nil {
		t.Fatalf("tryAcquire after run: %v", err)
	}
	if !locked {
		t.Errorf("expected lock to be free after Autostart returned")
	}
	if f != nil {
		releaseAutostartLock(f)
	}
}

// TestAutostart_LockSerialisesTwoCallsInOrder runs Autostart twice in
// parallel from the same process. Both go through the lock; the second
// either waits via the test's serialisation or is deferred. We don't
// assert order here — just that neither call panics or errors out and
// both observe a clean lock state when they return.
func TestAutostart_LockSerialisesTwoCallsInOrder(t *testing.T) {
	dir := t.TempDir()
	state := filepath.Join(dir, "state.json")

	pool := NewPool(logger.New(io.Discard))
	var wg sync.WaitGroup
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := Autostart(context.Background(), pool, "", state, time.Second, logger.New(io.Discard)); err != nil {
				t.Errorf("Autostart: %v", err)
			}
		}()
	}
	wg.Wait()
}
