// Accumulator — pure-data token / cost accumulator used by every
// harness adapter.
//
// Why this lives in the framework: every adapter parses its own
// usage events differently (anthropic emits message_delta.usage,
// codex emits turn.completed.usage, claude-binary emits a result
// event with both top-level + nested usage), but the post-stream
// shape they hand to the route handler is identical: a Usage struct
// with input/output/cache numbers + a cost field. Accumulator lets
// the adapters .Add* during parsing and .Snapshot() at the end
// without re-implementing the same handful of atomic adds.
//
// Concurrency: Accumulator uses sync.Mutex so multi-goroutine
// adapters (broadcast aggregator, future SDK port) can call into it
// safely. Single-goroutine adapters take the uncontended fast path.
package harness

import "sync"

// Accumulator is the thread-safe token / cost tally. Zero value is
// usable — no constructor needed. Snapshot() returns a Usage struct
// the route handler can fold into its CostEventPayload.
type Accumulator struct {
	mu sync.Mutex

	inputTokens   int64
	outputTokens  int64
	cacheRead     int64
	cacheCreation int64
	cost          float64
	model         string
}

// AddInput adds n to the input-token tally. Negative n is treated as
// zero — adapters shouldn't subtract, and a parse oddity (e.g. an
// out-of-order usage event with a smaller value) shouldn't corrupt
// the cumulative total.
func (a *Accumulator) AddInput(n int64) { a.addClamped(&a.inputTokens, n) }

// AddOutput adds n to the output-token tally.
func (a *Accumulator) AddOutput(n int64) { a.addClamped(&a.outputTokens, n) }

// AddCacheRead adds n to the cache-read tally.
func (a *Accumulator) AddCacheRead(n int64) { a.addClamped(&a.cacheRead, n) }

// AddCacheCreation adds n to the cache-creation tally.
func (a *Accumulator) AddCacheCreation(n int64) { a.addClamped(&a.cacheCreation, n) }

// AddCost adds n to the cumulative-cost tally. Adapters may also
// call SetCost when the upstream provides a running total rather
// than a delta (claude-binary's total_cost_usd is cumulative across
// the conversation — SetCost is the right call there).
func (a *Accumulator) AddCost(n float64) {
	if n <= 0 {
		return
	}
	a.mu.Lock()
	a.cost += n
	a.mu.Unlock()
}

// SetCost overwrites the cost tally. Used when the upstream reports
// a cumulative running total — see claude-binary's total_cost_usd.
func (a *Accumulator) SetCost(n float64) {
	a.mu.Lock()
	a.cost = n
	a.mu.Unlock()
}

// SetModel records the model id used for this turn. Surfaced via
// Snapshot.Model so the cost-event payload can include it without
// the route handler having to thread the model separately.
func (a *Accumulator) SetModel(m string) {
	if m == "" {
		return
	}
	a.mu.Lock()
	a.model = m
	a.mu.Unlock()
}

// Snapshot returns the current totals. Safe under concurrent Add*.
// Returned value is a copy — callers can mutate it freely.
func (a *Accumulator) Snapshot() Usage {
	a.mu.Lock()
	defer a.mu.Unlock()
	return Usage{
		InputTokens:   a.inputTokens,
		OutputTokens:  a.outputTokens,
		CacheRead:     a.cacheRead,
		CacheCreation: a.cacheCreation,
		Cost:          a.cost,
		Model:         a.model,
	}
}

// Reset zeroes out every field. Used by tests; production code
// constructs a fresh Accumulator per turn instead.
func (a *Accumulator) Reset() {
	a.mu.Lock()
	a.inputTokens = 0
	a.outputTokens = 0
	a.cacheRead = 0
	a.cacheCreation = 0
	a.cost = 0
	a.model = ""
	a.mu.Unlock()
}

func (a *Accumulator) addClamped(field *int64, n int64) {
	if n <= 0 {
		return
	}
	a.mu.Lock()
	*field += n
	a.mu.Unlock()
}
