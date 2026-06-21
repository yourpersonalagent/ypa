// ActiveProcesses — per-session kill-switch registry.
//
// Why this lives in the framework: harness adapters spawn long-lived
// subprocesses (claude --print, codex exec) and need a way to be
// killed when the user clicks "Stop" in the chat UI. The Node bridge
// has activeProcesses Map<sessionId, {killFn}>; the future Go-side
// POST /v1/sessions/:id/stop endpoint will look up the same map and
// call killFn.
//
// This file just provides the registry — the endpoint itself is
// out of scope for Phase 6 scaffold (the plan calls it out as
// "do NOT add /v1/sessions/:id/stop endpoint"). Once Phase 6+ wires
// it, the endpoint reads ActiveProcesses.Stop(sid).
//
// Concurrency: sync.Mutex'd map. Stop / Register / Drop are all
// goroutine-safe and idempotent. Stopping an unknown sid is a no-op;
// double-registering on the same sid kills+replaces the previous
// killFn (a new turn on the same session = the old process is gone
// anyway).
package harness

import "sync"

// KillFn is the per-process termination closure adapters hand off
// when they spawn a subprocess. Implementations should be idempotent
// — calling Stop on an already-dead process is safe.
type KillFn func()

// ActiveProcesses tracks the current spawn (if any) per session id.
// One per daemon; safe for concurrent use.
type ActiveProcesses struct {
	mu sync.Mutex
	m  map[string]KillFn
}

// NewActiveProcesses returns an empty registry.
func NewActiveProcesses() *ActiveProcesses {
	return &ActiveProcesses{m: map[string]KillFn{}}
}

// Register associates kill with sessionID. If an existing process is
// already registered for sessionID, its kill func is invoked first
// (best-effort) and then replaced. Empty sessionID is a no-op so
// adapters can register unconditionally without a nil check.
func (a *ActiveProcesses) Register(sessionID string, kill KillFn) {
	if a == nil || sessionID == "" || kill == nil {
		return
	}
	a.mu.Lock()
	prev := a.m[sessionID]
	a.m[sessionID] = kill
	a.mu.Unlock()
	if prev != nil {
		// Outside the lock to avoid holding it during the kill;
		// kill closures may be slow (waitpid on Linux).
		safeKill(prev)
	}
}

// Stop kills the registered process for sessionID and removes the
// entry. Idempotent — unknown sids are a no-op. Returns true if a
// kill func was invoked.
func (a *ActiveProcesses) Stop(sessionID string) bool {
	if a == nil || sessionID == "" {
		return false
	}
	a.mu.Lock()
	kill, ok := a.m[sessionID]
	if ok {
		delete(a.m, sessionID)
	}
	a.mu.Unlock()
	if !ok {
		return false
	}
	safeKill(kill)
	return true
}

// Drop removes the entry for sessionID without invoking the kill
// func. Used by the harness adapter after its subprocess exits
// cleanly — no need to kill an already-dead process. Idempotent.
func (a *ActiveProcesses) Drop(sessionID string) {
	if a == nil || sessionID == "" {
		return
	}
	a.mu.Lock()
	delete(a.m, sessionID)
	a.mu.Unlock()
}

// Len returns the number of currently-registered processes. Useful
// for /internal/metrics + boot diagnostics.
func (a *ActiveProcesses) Len() int {
	if a == nil {
		return 0
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	return len(a.m)
}

// safeKill runs kill with a defer-recover so a panicking kill (e.g.
// closing an already-closed channel) doesn't take the daemon down.
// Panics here are swallowed silently — the harness adapter already
// logged whatever surfaced from its parser path.
func safeKill(kill KillFn) {
	defer func() { _ = recover() }()
	kill()
}
