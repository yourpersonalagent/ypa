package grokbuild

import "sync"

// InstanceResolver maps a logical GrokInstance id (e.g. "personal",
// "work-acct") to the per-instance HOME directory the subprocess must
// run with. Grok stores auth in the OS keychain / user-data area, so
// the HOME override is the only knob to coexist multiple accounts on
// one machine without manual login swaps.
type InstanceResolver interface {
	Resolve(id string) (homeDir string, ok bool)
}

// MemoryInstanceResolver is an in-memory map implementation. Useful
// for tests and the bare-bones daemon mode where the route handler
// builds the map at boot from config.defaults.grokInstances.
type MemoryInstanceResolver struct {
	mu sync.RWMutex
	m  map[string]string
}

// NewMemoryInstanceResolver returns a fresh, empty resolver.
func NewMemoryInstanceResolver() *MemoryInstanceResolver {
	return &MemoryInstanceResolver{m: map[string]string{}}
}

// Set records a (id → homeDir) entry. Idempotent.
func (r *MemoryInstanceResolver) Set(id, homeDir string) {
	if id == "" {
		return
	}
	r.mu.Lock()
	r.m[id] = homeDir
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
