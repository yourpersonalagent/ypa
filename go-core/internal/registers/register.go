// Package registers mirrors bridge/core/registers/.
//
// A Register[T] holds entries keyed by ID, attributed to a module, with
// optional ordering hints (Order, Before, After). Removal by module is
// the primitive that makes module unload safe — disable a module and
// every entry it added vanishes.
//
// Phase 1 ships a minimal subset: Add / Get / List / RemoveAllByModule.
// Topo sort with Before/After hints lands when actual core code starts
// reading from registers (Phase 2a+).
package registers

import (
	"errors"
	"sort"
	"sync"
)

type EntryMeta struct {
	ID     string
	Module string
	Order  int    // lower = earlier
	Before string // place before this ID
	After  string // place after this ID
	Core   bool   // true = pinned, can't be removed by module
}

type Register[T any] struct {
	mu      sync.RWMutex
	name    string
	entries map[string]registered[T]
}

type registered[T any] struct {
	Meta  EntryMeta
	Value T
}

func New[T any](name string) *Register[T] {
	return &Register[T]{name: name, entries: map[string]registered[T]{}}
}

func (r *Register[T]) Name() string { return r.name }

// Add inserts an entry. Returns an error if the ID is already taken
// (matches the modular plan's "duplicate-id is a fault" rule).
func (r *Register[T]) Add(meta EntryMeta, value T) error {
	if meta.ID == "" {
		return errors.New("registers: missing ID")
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if _, exists := r.entries[meta.ID]; exists {
		return errors.New("registers: duplicate ID: " + meta.ID)
	}
	r.entries[meta.ID] = registered[T]{Meta: meta, Value: value}
	return nil
}

// Get returns the entry for an ID, plus a found flag.
func (r *Register[T]) Get(id string) (T, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	e, ok := r.entries[id]
	if !ok {
		var zero T
		return zero, false
	}
	return e.Value, true
}

// List returns entries sorted by Order, then ID. Phase 2+ extends this
// to honour Before/After via a stable topo sort.
func (r *Register[T]) List() []T {
	r.mu.RLock()
	defer r.mu.RUnlock()
	all := make([]registered[T], 0, len(r.entries))
	for _, e := range r.entries {
		all = append(all, e)
	}
	sort.SliceStable(all, func(i, j int) bool {
		if all[i].Meta.Order != all[j].Meta.Order {
			return all[i].Meta.Order < all[j].Meta.Order
		}
		return all[i].Meta.ID < all[j].Meta.ID
	})
	out := make([]T, len(all))
	for i, e := range all {
		out[i] = e.Value
	}
	return out
}

// RemoveAllByModule removes every entry attributed to the given module
// except those with Core=true. Returns the count removed.
func (r *Register[T]) RemoveAllByModule(module string) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	n := 0
	for id, e := range r.entries {
		if e.Meta.Module == module && !e.Meta.Core {
			delete(r.entries, id)
			n++
		}
	}
	return n
}

// Len returns the entry count. Cheap, holds the read lock briefly.
func (r *Register[T]) Len() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.entries)
}
