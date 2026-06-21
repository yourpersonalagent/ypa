package stream

import (
	"sort"
	"sync"
	"time"
)

// LiveSnapshot is the per-session live-turn telemetry the route
// publishes while a turn is in flight. It backs two features:
//
//   - the per-turn `_live` SSE frames the active tab reads to paint a
//     live busy meta bar from the START of a response, and
//   - the process-global GET /v1/activity/stream feed every other UI
//     surface (multichat grid, header) reads to know which sessions are
//     busy right now without being attached to their streams.
//
// Counters mirror the terminal `_end` chunk so the busy bar settles
// seamlessly into the final bar. Elapsed time is intentionally absent:
// the client runs its own clock off TurnStartMs, so the backend never
// ships a per-frame duration.
//
// Lifecycle is presence-based. A session is "busy" exactly while it has
// an entry in the registry: RegisterLiveMeta on turn start,
// UnregisterLiveMeta on finalize. Consumers treat absence from a
// snapshot as "not streaming" — there is no transient "done" frame to
// race against. A staleness TTL (liveMetaStaleAfter) additionally reaps
// any entry that stops making progress, so a wedged adapter cannot pin a
// session "busy" forever. Status stays "streaming" for the whole
// lifetime; the field is kept on the wire for forward-compatibility.
type LiveSnapshot struct {
	SessionID     string `json:"sessionId"`
	Status        string `json:"status"` // "streaming"
	Model         string `json:"model,omitempty"`
	InputTokens   int    `json:"inputTokens"`
	OutputTokens  int    `json:"outputTokens"`
	ToolCallCount int    `json:"toolCallCount"`
	APICallCount  int    `json:"apiCallCount"`
	TurnStartMs   int64  `json:"turnStartMs"`
}

// liveMetaStaleAfter bounds how long a session may stay "busy" with no
// stream progress before the registry reaps it. It backstops the one
// path that can otherwise pin a session busy forever: the harness adapter
// (route_harness.go) runs detached on a non-deadlined context, so if its
// upstream read wedges — e.g. a bridge rebuild/crash mid-turn leaves the
// subprocess/socket half-open — the goroutine never returns, the terminal
// cleanup gated on that return never fires, and the 450ms ticker keeps
// the entry looking fresh. Nothing finite can clean up after a goroutine
// that never returns; only elapsed silence can.
//
// "Progress" is counter movement, not the ticker firing: UpdateLiveMeta
// refreshes lastBeat only when the snapshot actually changed. A wedged
// turn's ticker keeps calling UpdateLiveMeta with frozen counters, which
// must NOT keep it alive. The window therefore has to exceed the longest
// expected gap between counter changes — chiefly a single long local tool
// run (build/test/install) that emits nothing — so it is deliberately
// generous. Clean turns never reach it: they unregister at finalize
// (native: defer UnregisterLiveMeta; harness: defer stopLiveMeta on
// adapter return). It is a var, not a const, only so tests can drive
// staleness deterministically.
var liveMetaStaleAfter = 5 * time.Minute

// liveMetaNow returns the current time in unix-nanoseconds. It is a var so
// tests can advance a fake clock and exercise reaping without real sleeps.
var liveMetaNow = func() int64 { return time.Now().UnixNano() }

// liveEntry pairs the on-the-wire snapshot with an internal lastBeat (the
// unix-nano of the last observed progress) used only for staleness
// reaping. lastBeat is never serialized — LiveSnapshot stays the sole
// wire contract.
type liveEntry struct {
	snap     LiveSnapshot
	lastBeat int64
}

// liveMetaReg is the process-global live registry. Guarded by a
// RWMutex — the route's per-turn ticker writes; the activity feed
// handlers read. Mirrors the RegisterEmitSink registry shape in
// route.go.
var (
	liveMetaMu  sync.RWMutex
	liveMetaReg = map[string]liveEntry{}
)

// RegisterLiveMeta marks a session as streaming at turn start so it
// appears in the activity feed immediately, before the first counter
// tick lands. Idempotent: re-registering reseeds TurnStartMs/Model and
// zeroes counters for the new turn. No-op for an empty session id.
func RegisterLiveMeta(sessionID, model string, turnStartMs int64) {
	if sessionID == "" {
		return
	}
	liveMetaMu.Lock()
	liveMetaReg[sessionID] = liveEntry{
		snap: LiveSnapshot{
			SessionID:   sessionID,
			Status:      "streaming",
			Model:       model,
			TurnStartMs: turnStartMs,
		},
		lastBeat: liveMetaNow(),
	}
	liveMetaMu.Unlock()
}

// UpdateLiveMeta overwrites a session's snapshot. The route's per-turn
// ticker builds the full snapshot (counters + model + turn start) each
// tick and stores it here, so the feed reads one source of truth and
// the counters can never drift from what the `_live` frames carry.
//
// No-op for an unregistered session: a ticker tick that races past
// UnregisterLiveMeta must not resurrect a finished entry into the feed.
func UpdateLiveMeta(snap LiveSnapshot) {
	if snap.SessionID == "" {
		return
	}
	liveMetaMu.Lock()
	if e, ok := liveMetaReg[snap.SessionID]; ok {
		// Refresh the staleness clock only on real progress. A ticker
		// that keeps firing with identical counters (the signature of a
		// wedged adapter after a bridge crash) must leave lastBeat
		// untouched so the reaper can retire the entry; genuine counter
		// movement keeps it alive.
		if e.snap != snap {
			e.lastBeat = liveMetaNow()
		}
		e.snap = snap
		liveMetaReg[snap.SessionID] = e
	}
	liveMetaMu.Unlock()
}

// UnregisterLiveMeta drops a session from the live registry on turn
// finalize. The feed's next snapshot omits it, which is how consumers
// learn the turn ended (absence == not streaming).
func UnregisterLiveMeta(sessionID string) {
	if sessionID == "" {
		return
	}
	liveMetaMu.Lock()
	delete(liveMetaReg, sessionID)
	liveMetaMu.Unlock()
}

// SnapshotLiveMeta returns one session's live snapshot, if it is
// currently streaming.
func SnapshotLiveMeta(sessionID string) (LiveSnapshot, bool) {
	liveMetaMu.RLock()
	e, ok := liveMetaReg[sessionID]
	liveMetaMu.RUnlock()
	if !ok || liveMetaNow()-e.lastBeat > int64(liveMetaStaleAfter) {
		return LiveSnapshot{}, false
	}
	return e.snap, true
}

// SnapshotAllLiveMeta returns every streaming session's snapshot, sorted
// by SessionID, and reaps any entry that has gone stale (no counter
// progress within liveMetaStaleAfter). The activity feed calls this once
// a second, so reaping here is what self-heals a busy-forever entry left
// by a wedged adapter — absence from the snapshot is how consumers learn
// the turn ended. The stable order lets the feed diff successive
// snapshots by marshalled bytes so map-iteration shuffling doesn't cause
// spurious re-pushes.
func SnapshotAllLiveMeta() []LiveSnapshot {
	now := liveMetaNow()
	liveMetaMu.Lock()
	out := make([]LiveSnapshot, 0, len(liveMetaReg))
	for id, e := range liveMetaReg {
		if now-e.lastBeat > int64(liveMetaStaleAfter) {
			delete(liveMetaReg, id)
			continue
		}
		out = append(out, e.snap)
	}
	liveMetaMu.Unlock()
	sort.Slice(out, func(i, j int) bool { return out[i].SessionID < out[j].SessionID })
	return out
}
