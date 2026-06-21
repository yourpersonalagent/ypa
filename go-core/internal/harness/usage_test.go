package harness

import (
	"sync"
	"testing"
)

func TestAccumulatorZero(t *testing.T) {
	var a Accumulator
	u := a.Snapshot()
	if u != (Usage{}) {
		t.Errorf("zero Accumulator snapshot = %+v, want zero Usage", u)
	}
}

func TestAccumulatorAdds(t *testing.T) {
	var a Accumulator
	a.AddInput(100)
	a.AddOutput(50)
	a.AddCacheRead(10)
	a.AddCacheCreation(5)
	a.AddCost(0.025)
	a.SetModel("claude-opus-4-7")
	u := a.Snapshot()
	if u.InputTokens != 100 || u.OutputTokens != 50 {
		t.Errorf("tokens wrong: %+v", u)
	}
	if u.CacheRead != 10 || u.CacheCreation != 5 {
		t.Errorf("cache wrong: %+v", u)
	}
	if u.Cost != 0.025 {
		t.Errorf("cost = %v, want 0.025", u.Cost)
	}
	if u.Model != "claude-opus-4-7" {
		t.Errorf("model = %q", u.Model)
	}
}

func TestAccumulatorClamping(t *testing.T) {
	var a Accumulator
	a.AddInput(-100) // clamped to 0
	a.AddOutput(0)   // also no-op
	a.AddCost(-0.5)
	if u := a.Snapshot(); u.InputTokens != 0 || u.OutputTokens != 0 || u.Cost != 0 {
		t.Errorf("negative/zero adds should clamp, got %+v", u)
	}
}

func TestAccumulatorSetCostOverwrites(t *testing.T) {
	var a Accumulator
	a.AddCost(1.0)
	a.SetCost(0.5)
	if u := a.Snapshot(); u.Cost != 0.5 {
		t.Errorf("SetCost should overwrite, got %v", u.Cost)
	}
}

func TestAccumulatorReset(t *testing.T) {
	var a Accumulator
	a.AddInput(10)
	a.SetCost(1.0)
	a.SetModel("m")
	a.Reset()
	if u := a.Snapshot(); u != (Usage{}) {
		t.Errorf("after Reset = %+v, want zero", u)
	}
}

func TestAccumulatorConcurrentAdds(t *testing.T) {
	var a Accumulator
	const workers = 16
	const iters = 100
	var wg sync.WaitGroup
	for w := 0; w < workers; w++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			for i := 0; i < iters; i++ {
				a.AddInput(1)
				a.AddOutput(2)
				a.AddCost(0.001)
			}
		}()
	}
	wg.Wait()
	u := a.Snapshot()
	wantInput := int64(workers * iters)
	wantOutput := int64(workers * iters * 2)
	if u.InputTokens != wantInput {
		t.Errorf("InputTokens = %d, want %d", u.InputTokens, wantInput)
	}
	if u.OutputTokens != wantOutput {
		t.Errorf("OutputTokens = %d, want %d", u.OutputTokens, wantOutput)
	}
	// Float addition isn't exact; check close-enough.
	expectedCost := 0.001 * float64(workers*iters)
	if diff := u.Cost - expectedCost; diff < -0.01 || diff > 0.01 {
		t.Errorf("Cost = %v, want ~%v", u.Cost, expectedCost)
	}
}

func TestActiveProcessesRegisterStop(t *testing.T) {
	ap := NewActiveProcesses()
	var killed int
	ap.Register("sid-1", func() { killed++ })
	if !ap.Stop("sid-1") {
		t.Errorf("Stop(sid-1) returned false")
	}
	if killed != 1 {
		t.Errorf("kill func not invoked")
	}
	// Idempotent.
	if ap.Stop("sid-1") {
		t.Errorf("second Stop(sid-1) returned true")
	}
}

func TestActiveProcessesRegisterOverwritesKillsPrior(t *testing.T) {
	ap := NewActiveProcesses()
	var firstKilled, secondKilled int
	ap.Register("sid-1", func() { firstKilled++ })
	ap.Register("sid-1", func() { secondKilled++ })
	if firstKilled != 1 {
		t.Errorf("re-register should kill prior, firstKilled=%d", firstKilled)
	}
	if !ap.Stop("sid-1") {
		t.Errorf("Stop(sid-1) returned false")
	}
	if secondKilled != 1 {
		t.Errorf("second kill func not invoked, secondKilled=%d", secondKilled)
	}
}

func TestActiveProcessesDrop(t *testing.T) {
	ap := NewActiveProcesses()
	var killed int
	ap.Register("sid-1", func() { killed++ })
	ap.Drop("sid-1")
	if killed != 0 {
		t.Errorf("Drop should not invoke kill, killed=%d", killed)
	}
	if ap.Stop("sid-1") {
		t.Errorf("after Drop, Stop should return false")
	}
}

func TestActiveProcessesPanicSafe(t *testing.T) {
	ap := NewActiveProcesses()
	ap.Register("sid-1", func() { panic("boom") })
	// Stop must not propagate the panic.
	if !ap.Stop("sid-1") {
		t.Errorf("Stop should still report the kill happened")
	}
}

func TestActiveProcessesLen(t *testing.T) {
	ap := NewActiveProcesses()
	if ap.Len() != 0 {
		t.Errorf("fresh Len = %d", ap.Len())
	}
	ap.Register("sid-1", func() {})
	ap.Register("sid-2", func() {})
	if ap.Len() != 2 {
		t.Errorf("Len = %d, want 2", ap.Len())
	}
	ap.Stop("sid-1")
	if ap.Len() != 1 {
		t.Errorf("after Stop, Len = %d, want 1", ap.Len())
	}
}

func TestActiveProcessesNilSafe(t *testing.T) {
	var ap *ActiveProcesses
	ap.Register("sid", func() {})
	if ap.Stop("sid") {
		t.Errorf("nil receiver Stop = true")
	}
	ap.Drop("sid")
	if got := ap.Len(); got != 0 {
		t.Errorf("nil Len = %d", got)
	}
}
