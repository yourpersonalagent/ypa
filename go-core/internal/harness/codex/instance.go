package codex

import "sync"

// InstanceResolver maps a logical CodexInstance id (e.g. "personal",
// "work-acct") to the on-disk CODEX_HOME directory the subprocess
// must run with. Each codex subscription owns its own .codex
// directory; isolating them is how multiple OAuth accounts coexist
// on one box without clobbering each other's auth.json.
//
// Tests pass an in-memory map; production wires this from
// bridge config (config.defaults.codexInstances) when the route
// hands the harness a non-empty Request.CodexInstance.
//
// Resolve returns the absolute CODEX_HOME path and true when the id
// is known; false signals "unknown id, fall back to bare-path
// handling in resolveConfigDir".
type InstanceResolver interface {
	Resolve(id string) (configDir string, ok bool)
}

// MemoryInstanceResolver is an in-memory map implementation. Useful
// for tests and the bare-bones daemon mode where the route handler
// builds the map at boot from config.defaults.codexInstances.
type MemoryInstanceResolver struct {
	mu sync.RWMutex
	m  map[string]string
}

// NewMemoryInstanceResolver returns a fresh, empty resolver.
func NewMemoryInstanceResolver() *MemoryInstanceResolver {
	return &MemoryInstanceResolver{m: map[string]string{}}
}

// Set records a (id → configDir) entry. Idempotent.
func (r *MemoryInstanceResolver) Set(id, configDir string) {
	if id == "" {
		return
	}
	r.mu.Lock()
	r.m[id] = configDir
	r.mu.Unlock()
}

// Resolve implements InstanceResolver.
func (r *MemoryInstanceResolver) Resolve(id string) (string, bool) {
	if id == "" {
		return "", false
	}
	r.mu.RLock()
	defer r.mu.RUnlock()
	dir, ok := r.m[id]
	return dir, ok
}
