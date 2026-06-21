// session.go — bridge between the per-package SessionResolver
// interface and the framework-level harness.History store.
//
// The existing Streamer was designed before harness.History existed,
// so its resolver surface is local (Get / Set / Delete) and
// in-memory-by-default (NewMemorySessionResolver). The harness
// framework needs the resume map to survive daemon restarts — that's
// the whole point of putting it on disk.
//
// historyResolver implements claudebinary.SessionResolver and
// forwards every call to the supplied *harness.History, keying by
// the harness id "claude-binary". A nil History falls back to the
// in-memory resolver so tests + boot-without-disk keep working.
package claudebinary

import (
	"github.com/yha/core/internal/harness"
)

// historyResolver adapts a *harness.History into the SessionResolver
// surface the Streamer wants.
type historyResolver struct {
	store *harness.History
	mem   *MemorySessionResolver // fallback when store is nil
}

// newHistoryResolver returns a SessionResolver backed by store. When
// store is nil it returns an in-memory resolver so the Streamer still
// works (sessions just don't survive process restart).
func newHistoryResolver(store *harness.History) SessionResolver {
	if store == nil {
		return NewMemorySessionResolver()
	}
	return &historyResolver{store: store, mem: NewMemorySessionResolver()}
}

// Get implements SessionResolver. Read from disk first; fall back to
// the in-memory cache if the disk read missed (covers the brief
// window during boot before History.load completes).
func (r *historyResolver) Get(yhaSID string) string {
	if r == nil {
		return ""
	}
	if r.store != nil {
		if v, ok := r.store.Get(HarnessID, yhaSID); ok {
			return v
		}
	}
	if r.mem != nil {
		return r.mem.Get(yhaSID)
	}
	return ""
}

// Set implements SessionResolver. Writes to disk (atomic) and the
// in-memory mirror. Disk errors are swallowed — the in-memory mirror
// keeps the active turn's resume working, the next Set retries.
func (r *historyResolver) Set(yhaSID, claudeSID string) {
	if r == nil {
		return
	}
	if r.mem != nil {
		r.mem.Set(yhaSID, claudeSID)
	}
	if r.store != nil {
		// Errors are logged inside History.persist; swallowing here is
		// fine — the in-memory cache keeps the resume working for the
		// current spawn.
		_ = r.store.Set(HarnessID, yhaSID, claudeSID)
	}
}

// Delete implements SessionResolver.
func (r *historyResolver) Delete(yhaSID string) {
	if r == nil {
		return
	}
	if r.mem != nil {
		r.mem.Delete(yhaSID)
	}
	if r.store != nil {
		_ = r.store.Delete(HarnessID, yhaSID)
	}
}
