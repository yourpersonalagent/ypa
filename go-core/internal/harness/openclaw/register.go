// register.go — wiring helper for cmd/yha-core/main.go.
//
// The scaffold agent's main.go wiring step calls Register(reg, pool) to
// add the OpenClaw harness to the framework registry. We don't import
// the registry concrete type here — we accept anything with an Add
// method matching its signature so this file compiles regardless of
// whether scaffold has finalised the registry shape.

package openclaw

import (
	"github.com/yha/core/internal/harness"
)

// Registrar is the minimal surface this package needs from
// harness.Registry. Once scaffold lands a concrete *harness.Registry
// with an Add method matching this signature, callers pass it directly.
type Registrar interface {
	Add(h harness.Harness) error
}

// Register adds the OpenClaw harness to the framework registry. Returns
// the registry's Add error verbatim so callers can decide on a duplicate.
func Register(reg Registrar, h *Harness) error {
	if h == nil {
		return nil
	}
	return reg.Add(h)
}

// NewDefault builds the canonical wiring: file-backed config loader at
// <bridgeRoot>/partners.json + in-memory session resolver + a Harness
// pointed at the pool. The caller is responsible for plumbing the
// returned Pool into the daemon's shutdown path (pool.StopAll).
//
// log may be nil.
func NewDefault(bridgeRoot string, log Logger) (*Pool, *Harness) {
	loader := NewFileConfigLoader(bridgeRoot)
	pool := NewPool(loader, log)
	h := NewHarness(pool, NewMemoryResolver(), log)
	return pool, h
}
