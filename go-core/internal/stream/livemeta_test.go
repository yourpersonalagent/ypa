package stream

import (
	"encoding/json"
	"testing"
)

// TestLiveChunkWireShape pins the on-the-wire contract of a `_live`
// frame so the FE's ingestion assumptions can't silently break:
//   - the `_live` discriminator is present and true,
//   - the four counters round-trip under their documented JSON names,
//   - the frame carries NO `text`/`delta` (so api.ts's `full` text
//     accumulator can't be polluted by a live frame), and
//   - the frame has >1 JSON key, so the FE heartbeat check
//     (`parsed['_hb'] !== undefined && Object.keys(parsed).length === 1`)
//     can never misclassify a `_live` frame as a heartbeat.
func TestLiveChunkWireShape(t *testing.T) {
	c := Chunk{
		Live:          true,
		InputTokens:   1234,
		OutputTokens:  56,
		ToolCallCount: 2,
		APICallCount:  1,
	}
	raw, err := json.Marshal(c)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}

	if m["_live"] != true {
		t.Errorf("_live = %v, want true (raw=%s)", m["_live"], raw)
	}
	// JSON numbers decode to float64.
	want := map[string]float64{
		"inputTokens":   1234,
		"outputTokens":  56,
		"toolCallCount": 2,
		"apiCallCount":  1,
	}
	for k, v := range want {
		got, ok := m[k].(float64)
		if !ok || got != v {
			t.Errorf("%s = %v, want %v (raw=%s)", k, m[k], v, raw)
		}
	}
	if _, hasText := m["text"]; hasText {
		t.Errorf("_live frame must not carry text (raw=%s)", raw)
	}
	if _, hasDelta := m["delta"]; hasDelta {
		t.Errorf("_live frame must not carry delta (raw=%s)", raw)
	}
	if _, hasHB := m["_hb"]; hasHB {
		t.Errorf("_live frame must not carry _hb (raw=%s)", raw)
	}
	if len(m) <= 1 {
		t.Errorf("_live frame has %d keys, want >1 so the FE heartbeat check can't misfire (raw=%s)", len(m), raw)
	}
}

// TestLiveChunkZeroCountersStillMultiKey covers the turn-start edge
// case: before message_start the counters are all zero, so omitempty
// drops them — but `type:""` (no omitempty) plus `_live` keep the frame
// at >1 key, so the heartbeat check still can't misfire. The FE renders
// a missing/zero inputTokens as "—" until the first nonzero frame.
func TestLiveChunkZeroCountersStillMultiKey(t *testing.T) {
	raw, err := json.Marshal(Chunk{Live: true})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var m map[string]any
	if err := json.Unmarshal(raw, &m); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if m["_live"] != true {
		t.Errorf("_live = %v, want true (raw=%s)", m["_live"], raw)
	}
	if len(m) <= 1 {
		t.Errorf("zero-counter _live frame has %d keys, want >1 (raw=%s)", len(m), raw)
	}
}

// TestLiveMetaRegistryLifecycle exercises register → update → snapshot →
// unregister, plus the no-resurrect guard that keeps a late ticker tick
// from re-adding a finalized session to the feed.
func TestLiveMetaRegistryLifecycle(t *testing.T) {
	const sid = "test-livemeta-lifecycle-session"
	UnregisterLiveMeta(sid) // clean slate in case a prior run leaked
	defer UnregisterLiveMeta(sid)

	if _, ok := SnapshotLiveMeta(sid); ok {
		t.Fatalf("session present before register")
	}

	RegisterLiveMeta(sid, "claude-opus-4-8", 1700000000000)
	got, ok := SnapshotLiveMeta(sid)
	if !ok {
		t.Fatalf("session absent after register")
	}
	if got.Status != "streaming" || got.Model != "claude-opus-4-8" || got.TurnStartMs != 1700000000000 {
		t.Errorf("register seed = %+v", got)
	}

	UpdateLiveMeta(LiveSnapshot{
		SessionID:     sid,
		Status:        "streaming",
		Model:         "claude-opus-4-8",
		InputTokens:   100,
		OutputTokens:  20,
		ToolCallCount: 3,
		APICallCount:  2,
		TurnStartMs:   1700000000000,
	})
	got, _ = SnapshotLiveMeta(sid)
	if got.InputTokens != 100 || got.OutputTokens != 20 || got.ToolCallCount != 3 || got.APICallCount != 2 {
		t.Errorf("after update = %+v", got)
	}

	// Present in the all-snapshot.
	found := false
	for _, s := range SnapshotAllLiveMeta() {
		if s.SessionID == sid {
			found = true
		}
	}
	if !found {
		t.Errorf("session missing from SnapshotAllLiveMeta")
	}

	UnregisterLiveMeta(sid)
	if _, ok := SnapshotLiveMeta(sid); ok {
		t.Fatalf("session present after unregister")
	}

	// No-resurrect: a tick that fires after finalize must not re-add it.
	UpdateLiveMeta(LiveSnapshot{SessionID: sid, Status: "streaming", InputTokens: 999})
	if _, ok := SnapshotLiveMeta(sid); ok {
		t.Errorf("UpdateLiveMeta resurrected an unregistered session")
	}
}

// TestSnapshotAllLiveMetaSorted verifies the deterministic ordering the
// activity feed relies on for byte-diffing successive snapshots.
func TestSnapshotAllLiveMetaSorted(t *testing.T) {
	ids := []string{"zeta-sess", "alpha-sess", "mid-sess"}
	for _, id := range ids {
		RegisterLiveMeta(id, "m", 1)
		defer UnregisterLiveMeta(id)
	}
	all := SnapshotAllLiveMeta()
	// Filter to our ids (other leaked sessions shouldn't fail the test).
	var seen []string
	for _, s := range all {
		for _, id := range ids {
			if s.SessionID == id {
				seen = append(seen, s.SessionID)
			}
		}
	}
	for i := 1; i < len(seen); i++ {
		if seen[i-1] > seen[i] {
			t.Errorf("SnapshotAllLiveMeta not sorted: %v", seen)
		}
	}
}

// TestLiveMetaStaleReap pins the busy-forever backstop: once a session
// stops making counter progress, a ticker that keeps firing with frozen
// counters (the wedged-adapter signature after a bridge crash) must NOT
// keep it alive — both snapshot readers drop it past the TTL, and
// SnapshotAllLiveMeta deletes the entry outright.
func TestLiveMetaStaleReap(t *testing.T) {
	const sid = "test-livemeta-stale-reap"
	UnregisterLiveMeta(sid)
	defer UnregisterLiveMeta(sid)

	realNow := liveMetaNow
	defer func() { liveMetaNow = realNow }()
	var clock int64 = 1_700_000_000_000_000_000
	liveMetaNow = func() int64 { return clock }

	RegisterLiveMeta(sid, "m", 1)
	if _, ok := SnapshotLiveMeta(sid); !ok {
		t.Fatalf("freshly registered session should be live")
	}
	// A ticker tick with identical counters must not refresh lastBeat.
	UpdateLiveMeta(LiveSnapshot{SessionID: sid, Status: "streaming", Model: "m", TurnStartMs: 1})

	clock += int64(liveMetaStaleAfter) + 1 // advance just past the TTL
	if _, ok := SnapshotLiveMeta(sid); ok {
		t.Errorf("session past TTL with frozen counters must be reaped (SnapshotLiveMeta)")
	}
	for _, s := range SnapshotAllLiveMeta() {
		if s.SessionID == sid {
			t.Errorf("SnapshotAllLiveMeta must drop the stale session")
		}
	}
	liveMetaMu.RLock()
	_, present := liveMetaReg[sid]
	liveMetaMu.RUnlock()
	if present {
		t.Errorf("SnapshotAllLiveMeta must delete the stale entry, not just hide it")
	}
}

// TestLiveMetaProgressDefersReap is the counterpart: genuine counter
// movement refreshes the staleness clock, so a long-but-active turn is
// never false-reaped even as wall time crosses multiples of the TTL.
func TestLiveMetaProgressDefersReap(t *testing.T) {
	const sid = "test-livemeta-progress"
	UnregisterLiveMeta(sid)
	defer UnregisterLiveMeta(sid)

	realNow := liveMetaNow
	defer func() { liveMetaNow = realNow }()
	var clock int64 = 1_700_000_000_000_000_000
	liveMetaNow = func() int64 { return clock }

	RegisterLiveMeta(sid, "m", 1)
	// Each hop advances almost a full TTL, then posts real progress
	// (output grew) before the next hop. Without the lastBeat refresh the
	// second hop would exceed the TTL and falsely reap an active session.
	for i := 1; i <= 2; i++ {
		clock += int64(liveMetaStaleAfter) - 1
		UpdateLiveMeta(LiveSnapshot{SessionID: sid, Status: "streaming", Model: "m", TurnStartMs: 1, OutputTokens: i})
		if _, ok := SnapshotLiveMeta(sid); !ok {
			t.Fatalf("active session reaped despite counter progress (hop %d)", i)
		}
	}
}
