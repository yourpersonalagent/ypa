package stream

import (
	"fmt"
	"sync"
	"testing"
	"time"
)

func TestBufferAppendStampsMonotonicSeq(t *testing.T) {
	b := NewSessionBuffer()
	c1 := b.Append("s1", Chunk{Type: ChunkTypeDelta, Delta: "a"})
	c2 := b.Append("s1", Chunk{Type: ChunkTypeDelta, Delta: "b"})
	c3 := b.Append("s1", Chunk{Type: ChunkTypeDelta, Delta: "c"})
	if c1.Seq != 1 || c2.Seq != 2 || c3.Seq != 3 {
		t.Errorf("seqs = %d, %d, %d; want 1, 2, 3", c1.Seq, c2.Seq, c3.Seq)
	}
}

func TestBufferAppendPerSessionSeqIndependent(t *testing.T) {
	b := NewSessionBuffer()
	a1 := b.Append("a", Chunk{Type: ChunkTypeDelta})
	b1 := b.Append("b", Chunk{Type: ChunkTypeDelta})
	a2 := b.Append("a", Chunk{Type: ChunkTypeDelta})
	if a1.Seq != 1 || a2.Seq != 2 {
		t.Errorf("session a seqs = %d, %d", a1.Seq, a2.Seq)
	}
	if b1.Seq != 1 {
		t.Errorf("session b first seq = %d, want 1", b1.Seq)
	}
}

func TestBufferReplayReturnsFromSeq(t *testing.T) {
	b := NewSessionBuffer()
	for i := 0; i < 5; i++ {
		b.Append("s1", Chunk{Type: ChunkTypeDelta, Delta: fmt.Sprintf("%d", i)})
	}
	// fromSeq=3 → want seq 3, 4, 5 (1-indexed).
	got, ok := b.Replay("s1", 3)
	if !ok {
		t.Fatal("Replay returned ok=false on existing session")
	}
	if len(got) != 3 {
		t.Fatalf("got %d chunks, want 3: %+v", len(got), got)
	}
	if got[0].Seq != 3 || got[1].Seq != 4 || got[2].Seq != 5 {
		t.Errorf("seqs = %d, %d, %d", got[0].Seq, got[1].Seq, got[2].Seq)
	}
}

func TestBufferReplayMissingSession(t *testing.T) {
	b := NewSessionBuffer()
	got, ok := b.Replay("nope", 0)
	if ok {
		t.Errorf("Replay on missing session returned ok=true (%+v)", got)
	}
}

func TestBufferReplayHonoursFromSeqZero(t *testing.T) {
	b := NewSessionBuffer()
	b.Append("s1", Chunk{Type: ChunkTypeDelta})
	b.Append("s1", Chunk{Type: ChunkTypeDelta})
	got, _ := b.Replay("s1", 0)
	if len(got) != 2 {
		t.Errorf("fromSeq=0 should return all; got %d", len(got))
	}
}

func TestBufferRingCapDropsOldest(t *testing.T) {
	b := NewSessionBufferWithCaps(10, 4, time.Second)
	for i := 1; i <= 6; i++ {
		b.Append("s1", Chunk{Type: ChunkTypeDelta, Delta: fmt.Sprintf("%d", i)})
	}
	// Buffer cap is 4, so chunks 1 and 2 should be evicted; chunks 3-6 remain.
	got, _ := b.Replay("s1", 0)
	if len(got) != 4 {
		t.Fatalf("got %d chunks, want 4", len(got))
	}
	if got[0].Seq != 3 || got[3].Seq != 6 {
		t.Errorf("first/last seqs = %d, %d; want 3, 6", got[0].Seq, got[3].Seq)
	}
}

func TestBufferSubscribeReceivesLiveChunks(t *testing.T) {
	b := NewSessionBuffer()
	ch, unsub := b.Subscribe("s1")
	defer unsub()

	done := make(chan []Chunk, 1)
	go func() {
		var seen []Chunk
		for c := range ch {
			seen = append(seen, c)
			if len(seen) == 3 {
				return
			}
		}
		done <- seen
	}()
	b.Append("s1", Chunk{Type: ChunkTypeDelta, Delta: "a"})
	b.Append("s1", Chunk{Type: ChunkTypeDelta, Delta: "b"})
	b.Append("s1", Chunk{Type: ChunkTypeDelta, Delta: "c"})

	// Give the goroutine a moment to drain.
	time.Sleep(50 * time.Millisecond)
}

func TestBufferUnsubscribeClosesChannel(t *testing.T) {
	b := NewSessionBuffer()
	ch, unsub := b.Subscribe("s1")
	unsub()
	// Channel should be drainable to EOF.
	_, ok := <-ch
	if ok {
		t.Error("expected closed channel after unsub")
	}
}

func TestBufferDropClosesListeners(t *testing.T) {
	b := NewSessionBuffer()
	b.Append("s1", Chunk{Type: ChunkTypeDelta})
	ch, _ := b.Subscribe("s1")
	b.Drop("s1")
	if b.Has("s1") {
		t.Error("Drop did not remove session")
	}
	// Listener channel should close.
	select {
	case _, ok := <-ch:
		if ok {
			t.Error("expected closed channel after Drop")
		}
	case <-time.After(time.Second):
		t.Fatal("Drop did not close listener channel within 1 s")
	}
}

func TestBufferLRUEvictsOldest(t *testing.T) {
	b := NewSessionBufferWithCaps(2, 100, time.Second)
	b.Append("a", Chunk{Type: ChunkTypeDelta})
	b.Append("b", Chunk{Type: ChunkTypeDelta})
	b.Append("c", Chunk{Type: ChunkTypeDelta}) // should evict "a"
	// Give the goroutine'd closeEntry a beat.
	time.Sleep(20 * time.Millisecond)
	if b.Has("a") {
		t.Error("session a should have been LRU-evicted")
	}
	if !b.Has("b") || !b.Has("c") {
		t.Error("b and c should still be present")
	}
}

func TestBufferLRUTouchOnAppend(t *testing.T) {
	b := NewSessionBufferWithCaps(2, 100, time.Second)
	b.Append("a", Chunk{Type: ChunkTypeDelta})
	b.Append("b", Chunk{Type: ChunkTypeDelta})
	// Touch "a" so it becomes most-recent.
	b.Append("a", Chunk{Type: ChunkTypeDelta})
	b.Append("c", Chunk{Type: ChunkTypeDelta}) // should evict "b" now
	time.Sleep(20 * time.Millisecond)
	if b.Has("b") {
		t.Error("session b should have been evicted (LRU)")
	}
	if !b.Has("a") || !b.Has("c") {
		t.Error("a and c should still be present")
	}
}

func TestBufferScheduleFinalizeDropsAfterGrace(t *testing.T) {
	b := NewSessionBufferWithCaps(100, 100, 50*time.Millisecond)
	b.Append("s1", Chunk{Type: ChunkTypeDelta})
	b.ScheduleFinalize("s1")
	if !b.Has("s1") {
		t.Fatal("session vanished before grace")
	}
	time.Sleep(120 * time.Millisecond)
	if b.Has("s1") {
		t.Error("session should have been dropped after grace")
	}
}

func TestBufferCancelFinalizeKeepsAlive(t *testing.T) {
	b := NewSessionBufferWithCaps(100, 100, 50*time.Millisecond)
	b.Append("s1", Chunk{Type: ChunkTypeDelta})
	b.ScheduleFinalize("s1")
	b.CancelFinalize("s1")
	time.Sleep(120 * time.Millisecond)
	if !b.Has("s1") {
		t.Error("CancelFinalize did not stop the drop timer")
	}
}

func TestBufferNextSeqStandalone(t *testing.T) {
	b := NewSessionBuffer()
	if got := b.NextSeq("s1"); got != 1 {
		t.Errorf("first NextSeq = %d, want 1", got)
	}
	if got := b.NextSeq("s1"); got != 2 {
		t.Errorf("second NextSeq = %d, want 2", got)
	}
}

func TestBufferEmptySessionIDIsNoOp(t *testing.T) {
	b := NewSessionBuffer()
	c := b.Append("", Chunk{Type: ChunkTypeDelta})
	if c.Seq != 0 {
		t.Errorf("empty sessionId should not stamp seq; got %d", c.Seq)
	}
	if got, ok := b.Replay("", 0); ok || got != nil {
		t.Errorf("Replay on empty session should return nil, false; got %+v, %v", got, ok)
	}
}

// TestBufferConcurrentAppendSubscribeDrop is the race-detector smoke
// test — many goroutines hammering the same session at once must not
// deadlock or corrupt internal state. Run under `go test -race`.
func TestBufferConcurrentAppendSubscribeDrop(t *testing.T) {
	b := NewSessionBufferWithCaps(50, 100, 10*time.Millisecond)
	var wg sync.WaitGroup

	for i := 0; i < 5; i++ {
		sid := fmt.Sprintf("s%d", i)
		// Producers
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				b.Append(sid, Chunk{Type: ChunkTypeDelta})
			}
		}()
		// Subscribers
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 10; j++ {
				ch, unsub := b.Subscribe(sid)
				go func() {
					for range ch {
					}
				}()
				time.Sleep(time.Millisecond)
				unsub()
			}
		}()
		// Readers
		wg.Add(1)
		go func() {
			defer wg.Done()
			for j := 0; j < 50; j++ {
				_, _ = b.Replay(sid, int64(j))
			}
		}()
	}
	// Dropper — eventually wipes the floor.
	wg.Add(1)
	go func() {
		defer wg.Done()
		time.Sleep(20 * time.Millisecond)
		for i := 0; i < 5; i++ {
			b.Drop(fmt.Sprintf("s%d", i))
		}
	}()
	wg.Wait()
}

func TestBufferStaleStreamWatchdogFinalizesIdleEntry(t *testing.T) {
	b := NewSessionBufferWithCaps(10, 100, time.Second)
	defer b.StopStaleStreamWatchdog()
	b.Append("s1", Chunk{Type: ChunkTypeDelta})
	// Status: streaming, no listeners attached → meets watchdog criteria
	// once we push lastAppendAt back beyond the threshold.
	if st := b.Status("s1"); st.Status != "streaming" || st.Listeners != 0 {
		t.Fatalf("setup: want streaming+0 listeners, got %+v", st)
	}
	// Force the entry's lastAppendAt into the past so the sweep sees
	// it as stale. Then trigger one synchronous sweep at a threshold
	// the entry is now beyond.
	b.mu.RLock()
	e := b.sessions["s1"]
	b.mu.RUnlock()
	if e == nil {
		t.Fatal("entry vanished after Append")
	}
	e.mu.Lock()
	e.lastAppendAt = time.Now().Add(-2 * time.Hour).UnixNano()
	e.mu.Unlock()
	b.sweepStaleStreams(time.Hour)
	// Sweep schedules a finalize → status flips to "done".
	st := b.Status("s1")
	if st.Status != "done" {
		t.Errorf("after stale sweep want status=done, got %+v", st)
	}
	// And ActiveSessions no longer reports it as live.
	for _, sid := range b.ActiveSessions() {
		if sid == "s1" {
			t.Errorf("ActiveSessions still returns finalised session: %v", b.ActiveSessions())
		}
	}
}

func TestBufferStaleStreamWatchdogSkipsAttachedListener(t *testing.T) {
	b := NewSessionBufferWithCaps(10, 100, time.Second)
	defer b.StopStaleStreamWatchdog()
	b.Append("s1", Chunk{Type: ChunkTypeDelta})
	_, unsub := b.Subscribe("s1")
	defer unsub()
	b.mu.RLock()
	e := b.sessions["s1"]
	b.mu.RUnlock()
	e.mu.Lock()
	e.lastAppendAt = time.Now().Add(-2 * time.Hour).UnixNano()
	e.mu.Unlock()
	b.sweepStaleStreams(time.Hour)
	// Listener still attached → watchdog must leave the entry alone so
	// genuinely-quiet tool-call windows don't get killed.
	if st := b.Status("s1"); st.Status != "streaming" {
		t.Errorf("listener attached: want streaming, got %+v", st)
	}
}

func TestBufferStaleStreamWatchdogSkipsRecentAppend(t *testing.T) {
	b := NewSessionBufferWithCaps(10, 100, time.Second)
	defer b.StopStaleStreamWatchdog()
	b.Append("s1", Chunk{Type: ChunkTypeDelta})
	// lastAppendAt is fresh — sweep with a generous threshold must
	// leave the entry alone.
	b.sweepStaleStreams(time.Hour)
	if st := b.Status("s1"); st.Status != "streaming" {
		t.Errorf("fresh append: want streaming, got %+v", st)
	}
}

func TestBufferEnableStaleStreamWatchdogRuns(t *testing.T) {
	// End-to-end smoke: the goroutine actually fires the sweep on its
	// own. Grace is long (10 s) so ScheduleFinalize's drop timer
	// doesn't tear down the entry before we observe the "done"
	// transition.
	b := NewSessionBufferWithCaps(10, 100, 10*time.Second)
	b.EnableStaleStreamWatchdog(20*time.Millisecond, 10*time.Millisecond)
	defer b.StopStaleStreamWatchdog()
	b.Append("s1", Chunk{Type: ChunkTypeDelta})
	// Backdate the append so the first tick treats it as stale.
	b.mu.RLock()
	e := b.sessions["s1"]
	b.mu.RUnlock()
	e.mu.Lock()
	e.lastAppendAt = time.Now().Add(-time.Hour).UnixNano()
	e.mu.Unlock()
	// Poll up to 500 ms for the watchdog goroutine to flip status.
	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if b.Status("s1").Status == "done" {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Errorf("watchdog goroutine never finalised stale entry; got %+v", b.Status("s1"))
}

func TestBufferAppendIgnoresDroppedEntry(t *testing.T) {
	b := NewSessionBuffer()
	b.Append("s1", Chunk{Type: ChunkTypeDelta})
	b.Drop("s1")
	// Append re-creates the entry — verify replay sees only the new chunk.
	b.Append("s1", Chunk{Type: ChunkTypeDelta, Delta: "fresh"})
	got, ok := b.Replay("s1", 0)
	if !ok {
		t.Fatal("Replay after re-Append returned ok=false")
	}
	if len(got) != 1 || got[0].Delta != "fresh" {
		t.Errorf("expected single fresh chunk, got %+v", got)
	}
}
