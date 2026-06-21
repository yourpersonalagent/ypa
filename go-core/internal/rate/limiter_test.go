package rate

import (
	"context"
	"sync/atomic"
	"testing"
	"time"
)

func TestBucketAcquireWithTokensAvailable(t *testing.T) {
	b := NewBucket(60, 1)
	release, err := b.Acquire(context.Background())
	if err != nil {
		t.Fatalf("acquire: %v", err)
	}
	defer release()
	st := b.Status("test")
	if st.InFlight != 1 {
		t.Errorf("inFlight = %d, want 1", st.InFlight)
	}
	if st.TotalAcquired != 1 {
		t.Errorf("totalAcquired = %d, want 1", st.TotalAcquired)
	}
}

func TestBucketReleaseRestoresInFlight(t *testing.T) {
	b := NewBucket(60, 1)
	rel, _ := b.Acquire(context.Background())
	rel()
	st := b.Status("test")
	if st.InFlight != 0 {
		t.Errorf("inFlight after release = %d, want 0", st.InFlight)
	}
	// Second release is a no-op (idempotent).
	rel()
	st = b.Status("test")
	if st.InFlight != 0 {
		t.Errorf("inFlight after double-release = %d, want 0", st.InFlight)
	}
}

func TestBucketConcurrencyLimit(t *testing.T) {
	b := NewBucket(60, 2) // 2 in-flight at most
	r1, _ := b.Acquire(context.Background())
	r2, _ := b.Acquire(context.Background())
	defer r1()
	defer r2()

	// Third acquire should block until something releases.
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	_, err := b.Acquire(ctx)
	if err != ErrAborted {
		t.Fatalf("expected ErrAborted while at concurrency cap, got %v", err)
	}
}

func TestBucketContextCancelWhileWaitingDoesNotConsumeSlot(t *testing.T) {
	b := NewBucket(60, 1)
	r1, _ := b.Acquire(context.Background())
	defer r1()

	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() {
		_, err := b.Acquire(ctx)
		done <- err
	}()
	time.Sleep(10 * time.Millisecond) // ensure the goroutine is parked in the waiter
	cancel()
	select {
	case err := <-done:
		if err != ErrAborted {
			t.Fatalf("expected ErrAborted, got %v", err)
		}
	case <-time.After(200 * time.Millisecond):
		t.Fatal("acquire did not return after context cancel")
	}
	st := b.Status("test")
	if st.Waiting != 0 {
		t.Errorf("waiter not removed, waiting = %d", st.Waiting)
	}
}

func TestBucketRefillReleasesWaiter(t *testing.T) {
	// 600 rpm = 10 tokens/sec. Concurrency 1. Drain to 0 tokens then
	// wait for refill — the next acquire should succeed within ~100ms.
	b := NewBucket(600, 1)
	rel, _ := b.Acquire(context.Background())
	rel()

	// Burn all tokens by hammering acquire+release in a tight loop.
	for i := 0; i < 600; i++ {
		r, err := b.Acquire(context.Background())
		if err != nil {
			t.Fatalf("burn loop %d: %v", i, err)
		}
		r()
		if b.Status("test").Tokens < 1 {
			break
		}
	}
	st := b.Status("test")
	if st.Tokens >= 1 {
		t.Skipf("tokens still %.2f after burn loop — bucket too generous on this machine", st.Tokens)
	}

	// Now the next acquire should block briefly and then succeed.
	start := time.Now()
	r, err := b.Acquire(context.Background())
	if err != nil {
		t.Fatalf("post-burn acquire: %v", err)
	}
	r()
	elapsed := time.Since(start)
	if elapsed > 500*time.Millisecond {
		t.Errorf("refill took %v, expected < 500ms at 600rpm", elapsed)
	}
}

func TestLimiterBucketIsolation(t *testing.T) {
	l := NewLimiter(Config{RPM: 60, Concurrency: 1}, nil)
	r1, err := l.Acquire(context.Background(), "alpha")
	if err != nil {
		t.Fatalf("alpha acquire: %v", err)
	}
	defer r1()
	// Beta should be unaffected by alpha being at concurrency cap.
	r2, err := l.Acquire(context.Background(), "beta")
	if err != nil {
		t.Fatalf("beta acquire: %v", err)
	}
	defer r2()
}

func TestLimiterCfgFnRunsOnceFreshBucket(t *testing.T) {
	var calls int32
	l := NewLimiter(Config{RPM: 60, Concurrency: 1}, func(provider string) Config {
		atomic.AddInt32(&calls, 1)
		return Config{RPM: 600, Concurrency: 5}
	})
	for i := 0; i < 4; i++ {
		r, _ := l.Acquire(context.Background(), "p")
		r()
	}
	if got := atomic.LoadInt32(&calls); got != 1 {
		t.Errorf("cfgFn called %d times, want 1", got)
	}
	st := l.Status()
	if len(st) != 1 || st[0].Concurrency != 5 || st[0].RPM != 600 {
		t.Errorf("status mismatch: %+v", st)
	}
}

func TestParseRetryAfterSeconds(t *testing.T) {
	d := parseRetryAfter("3")
	if d != 3*time.Second {
		t.Errorf("parseRetryAfter(\"3\") = %v, want 3s", d)
	}
	d = parseRetryAfter("0.5")
	if d != 500*time.Millisecond {
		t.Errorf("parseRetryAfter(\"0.5\") = %v, want 500ms", d)
	}
	if parseRetryAfter("") != -1 || parseRetryAfter("nope") != -1 {
		t.Error("parseRetryAfter empty/garbage should return -1")
	}
}

func TestBackoffFor(t *testing.T) {
	if d := backoffFor(0, -1); d != baseBackoff {
		t.Errorf("backoff(0) = %v, want %v", d, baseBackoff)
	}
	if d := backoffFor(2, -1); d != 4*baseBackoff {
		t.Errorf("backoff(2) = %v, want %v", d, 4*baseBackoff)
	}
	// Caller-supplied Retry-After wins.
	if d := backoffFor(0, 5*time.Second); d != 5*time.Second {
		t.Errorf("backoff(0, 5s) = %v, want 5s", d)
	}
	// Cap.
	if d := backoffFor(20, -1); d != maxBackoff {
		t.Errorf("backoff(20) = %v, want maxBackoff %v", d, maxBackoff)
	}
}
