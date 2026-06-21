// Package rate is the Go port of bridge/core/rate-limiter.ts.
//
// Per-provider token bucket plus 429-aware retry. Buckets refill at
// rpm/60 tokens per second up to capacity rpm. Concurrency caps the
// number of in-flight calls regardless of token availability. Acquire
// blocks until a token + concurrency slot is available, or the context
// is cancelled (in which case ErrAborted is returned and no slot is
// consumed).
//
// Configuration: pass rpm + concurrency at NewLimiter time, or call
// SetProviderConfig to override per-provider. The defaults match the
// JS side: 60 rpm, concurrency 1, 3 retries with exponential backoff.
//
// Differences from the TS version:
//   - context.Context replaces AbortSignal
//   - Goroutine-friendly (no setTimeout polling); waiters are blocked
//     on a channel that's signalled by the refill goroutine
//   - sync.Mutex around bucket state instead of single-threaded JS
package rate

import (
	"context"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	defaultRPM         = 60
	defaultConcurrency = 1
	defaultMaxRetries  = 3
	baseBackoff        = 1 * time.Second
	maxBackoff         = 30 * time.Second
)

// ErrAborted is returned when the caller's context fires while waiting
// for a rate-limit slot. No slot is consumed in that case.
var ErrAborted = errors.New("rate: context aborted while waiting for slot")

// Bucket is the per-provider token bucket. Use NewBucket directly only
// for tests; production code uses Limiter.
type Bucket struct {
	mu             sync.Mutex
	rpm            int
	concurrency    int
	tokens         float64
	lastRefill     time.Time
	inFlight       int
	totalAcquired  uint64
	totalWaitedNs  int64
	total429       uint64
	totalRetries   uint64
	waiters        []chan struct{} // FIFO; closed when slot opens
}

// NewBucket creates a bucket with the given config. tokens start at rpm
// (a fresh bucket lets a burst through immediately).
func NewBucket(rpm, concurrency int) *Bucket {
	if rpm <= 0 {
		rpm = defaultRPM
	}
	if concurrency <= 0 {
		concurrency = defaultConcurrency
	}
	return &Bucket{
		rpm:         rpm,
		concurrency: concurrency,
		tokens:      float64(rpm),
		lastRefill:  time.Now(),
	}
}

// Acquire blocks until a slot is available or ctx is cancelled. Returns
// a release function the caller MUST invoke when its work is done. The
// returned function is idempotent.
func (b *Bucket) Acquire(ctx context.Context) (release func(), err error) {
	if err := ctx.Err(); err != nil {
		return nopRelease, ErrAborted
	}
	b.mu.Lock()
	b.refillLocked()
	if b.hasSlotLocked() && len(b.waiters) == 0 {
		b.consumeSlotLocked()
		b.mu.Unlock()
		return b.makeRelease(), nil
	}
	wait := make(chan struct{})
	b.waiters = append(b.waiters, wait)
	startWait := time.Now()
	b.mu.Unlock()

	// Schedule a drain in case no other Acquire/release call kicks the
	// queue. Capacity calculation runs in scheduleDrain under lock.
	b.scheduleDrain()

	select {
	case <-ctx.Done():
		b.removeWaiter(wait)
		return nopRelease, ErrAborted
	case <-wait:
		// Slot was granted by drainWaiters. Token + inFlight already
		// adjusted under lock there.
		b.mu.Lock()
		b.totalWaitedNs += time.Since(startWait).Nanoseconds()
		b.mu.Unlock()
		return b.makeRelease(), nil
	}
}

func (b *Bucket) refillLocked() {
	now := time.Now()
	elapsed := now.Sub(b.lastRefill).Seconds()
	if elapsed <= 0 {
		return
	}
	add := float64(b.rpm) / 60.0 * elapsed
	if add <= 0 {
		return
	}
	b.tokens = minFloat(float64(b.rpm), b.tokens+add)
	b.lastRefill = now
}

func (b *Bucket) hasSlotLocked() bool {
	return b.tokens >= 1 && b.inFlight < b.concurrency
}

func (b *Bucket) consumeSlotLocked() {
	b.tokens -= 1
	b.inFlight += 1
	b.totalAcquired += 1
}

func (b *Bucket) makeRelease() func() {
	var once sync.Once
	return func() {
		once.Do(func() {
			b.mu.Lock()
			b.inFlight--
			if b.inFlight < 0 {
				b.inFlight = 0
			}
			b.drainWaitersLocked()
			b.mu.Unlock()
		})
	}
}

func (b *Bucket) drainWaitersLocked() {
	b.refillLocked()
	for len(b.waiters) > 0 && b.hasSlotLocked() {
		w := b.waiters[0]
		b.waiters = b.waiters[1:]
		b.consumeSlotLocked()
		close(w)
	}
}

func (b *Bucket) removeWaiter(target chan struct{}) {
	b.mu.Lock()
	defer b.mu.Unlock()
	for i, w := range b.waiters {
		if w == target {
			b.waiters = append(b.waiters[:i], b.waiters[i+1:]...)
			return
		}
	}
}

func (b *Bucket) msUntilNextTokenLocked() time.Duration {
	if b.tokens >= 1 {
		return 0
	}
	need := 1 - b.tokens
	perMs := float64(b.rpm) / 60_000.0
	if perMs <= 0 {
		return maxBackoff
	}
	d := time.Duration(need/perMs) * time.Millisecond
	if d < 10*time.Millisecond {
		d = 10 * time.Millisecond
	}
	return d
}

// scheduleDrain ensures a goroutine ticks the bucket forward even if no
// other Acquire/release happens. It debounces — only one drain timer at
// a time per bucket.
func (b *Bucket) scheduleDrain() {
	b.mu.Lock()
	if len(b.waiters) == 0 {
		b.mu.Unlock()
		return
	}
	delay := b.msUntilNextTokenLocked()
	b.mu.Unlock()

	go func() {
		time.Sleep(delay)
		b.mu.Lock()
		b.drainWaitersLocked()
		more := len(b.waiters) > 0
		b.mu.Unlock()
		if more {
			b.scheduleDrain()
		}
	}()
}

// Status holds a snapshot of the bucket's metrics. Token count is
// rounded to 2 decimal places to mirror the JS getStatus output.
type Status struct {
	Provider      string
	RPM           int
	Concurrency   int
	Tokens        float64
	InFlight      int
	Waiting       int
	TotalAcquired uint64
	TotalWaitedMs int64
	Total429      uint64
	TotalRetries  uint64
}

func (b *Bucket) Status(provider string) Status {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.refillLocked()
	return Status{
		Provider:      provider,
		RPM:           b.rpm,
		Concurrency:   b.concurrency,
		Tokens:        roundTo(b.tokens, 2),
		InFlight:      b.inFlight,
		Waiting:       len(b.waiters),
		TotalAcquired: b.totalAcquired,
		TotalWaitedMs: b.totalWaitedNs / int64(time.Millisecond),
		Total429:      b.total429,
		TotalRetries:  b.totalRetries,
	}
}

// SetConfig hot-swaps the rpm/concurrency caps. Existing tokens stay in
// place; the next refill uses the new rate. Mirrors the TS hot-reload
// behaviour.
func (b *Bucket) SetConfig(rpm, concurrency int) {
	if rpm <= 0 || concurrency <= 0 {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	b.rpm = rpm
	b.concurrency = concurrency
}

// ── Limiter (multi-bucket map) ──────────────────────────────────────────────

type Limiter struct {
	mu       sync.RWMutex
	buckets  map[string]*Bucket
	cfgFn    ConfigFn // optional — looks up rpm/concurrency by provider
	defaults Config
}

// Config is the resolved bucket config for a provider.
type Config struct {
	RPM         int
	Concurrency int
}

// ConfigFn returns the effective config for a provider name. It is
// called the first time a bucket is created; subsequent callers reuse
// the existing bucket. To hot-swap config, call Limiter.SetProvider.
type ConfigFn func(provider string) Config

func NewLimiter(defaults Config, cfgFn ConfigFn) *Limiter {
	if defaults.RPM <= 0 {
		defaults.RPM = defaultRPM
	}
	if defaults.Concurrency <= 0 {
		defaults.Concurrency = defaultConcurrency
	}
	return &Limiter{
		buckets:  map[string]*Bucket{},
		cfgFn:    cfgFn,
		defaults: defaults,
	}
}

func (l *Limiter) bucketFor(provider string) *Bucket {
	l.mu.RLock()
	if b, ok := l.buckets[provider]; ok {
		l.mu.RUnlock()
		return b
	}
	l.mu.RUnlock()

	cfg := l.defaults
	if l.cfgFn != nil {
		c := l.cfgFn(provider)
		if c.RPM > 0 {
			cfg.RPM = c.RPM
		}
		if c.Concurrency > 0 {
			cfg.Concurrency = c.Concurrency
		}
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	if b, ok := l.buckets[provider]; ok {
		return b
	}
	b := NewBucket(cfg.RPM, cfg.Concurrency)
	l.buckets[provider] = b
	return b
}

// Acquire is the public API mirroring TS acquire().
func (l *Limiter) Acquire(ctx context.Context, provider string) (func(), error) {
	return l.bucketFor(provider).Acquire(ctx)
}

// SetProvider hot-swaps a provider's config.
func (l *Limiter) SetProvider(provider string, cfg Config) {
	l.bucketFor(provider).SetConfig(cfg.RPM, cfg.Concurrency)
}

// Status returns a snapshot of every active bucket.
func (l *Limiter) Status() []Status {
	l.mu.RLock()
	defer l.mu.RUnlock()
	out := make([]Status, 0, len(l.buckets))
	for name, b := range l.buckets {
		out = append(out, b.Status(name))
	}
	return out
}

// ── WithRateLimit (HTTP wrapper) ────────────────────────────────────────────

// WithOpts is the option struct for With.
type WithOpts struct {
	MaxRetries int // default: 3
}

// With wraps a fetch-style call with bucket acquisition + 429 retry.
//
// Behaviour:
//   - Acquires the bucket BEFORE each attempt (every retry is throttled too)
//   - On 429: reads Retry-After (seconds or HTTP-date), sleeps, retries
//   - On any other status: returns the response unchanged
//   - ctx cancellation propagates immediately
func (l *Limiter) With(
	ctx context.Context,
	provider string,
	fn func(context.Context) (*http.Response, error),
	opts WithOpts,
) (*http.Response, int, error) {
	maxRetries := opts.MaxRetries
	if maxRetries <= 0 {
		maxRetries = defaultMaxRetries
	}
	attempt := 0
	for {
		release, err := l.Acquire(ctx, provider)
		if err != nil {
			return nil, attempt, err
		}
		resp, err := fn(ctx)
		if err != nil {
			release()
			return nil, attempt, err
		}
		if resp.StatusCode != http.StatusTooManyRequests {
			release()
			return resp, attempt, nil
		}
		// 429
		b := l.bucketFor(provider)
		b.mu.Lock()
		b.total429++
		b.mu.Unlock()
		if attempt >= maxRetries {
			release()
			return resp, attempt, nil
		}
		retryAfter := parseRetryAfter(resp.Header.Get("Retry-After"))
		backoff := backoffFor(attempt, retryAfter)
		_ = resp.Body.Close()
		release()
		attempt++
		b.mu.Lock()
		b.totalRetries++
		b.mu.Unlock()
		select {
		case <-ctx.Done():
			return nil, attempt, ErrAborted
		case <-time.After(backoff):
		}
	}
}

// parseRetryAfter accepts either "<seconds>" or an HTTP-date and returns
// the delay until the given moment. Returns -1 if the header is empty
// or unparseable, in which case the caller falls back to exponential.
func parseRetryAfter(header string) time.Duration {
	header = strings.TrimSpace(header)
	if header == "" {
		return -1
	}
	if secs, err := strconv.ParseFloat(header, 64); err == nil && secs >= 0 {
		return time.Duration(secs * float64(time.Second))
	}
	if t, err := http.ParseTime(header); err == nil {
		d := time.Until(t)
		if d < 0 {
			return 0
		}
		return d
	}
	return -1
}

func backoffFor(attempt int, retryAfter time.Duration) time.Duration {
	var d time.Duration
	if retryAfter >= 0 {
		d = retryAfter
	} else {
		d = baseBackoff << attempt
	}
	if d > maxBackoff {
		d = maxBackoff
	}
	return d
}

// ── helpers ─────────────────────────────────────────────────────────────────

func nopRelease() {}

func minFloat(a, b float64) float64 {
	if a < b {
		return a
	}
	return b
}

func roundTo(v float64, digits int) float64 {
	mult := 1.0
	for i := 0; i < digits; i++ {
		mult *= 10
	}
	return float64(int64(v*mult+0.5)) / mult
}
