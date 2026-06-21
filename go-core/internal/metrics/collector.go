// Package metrics is the in-process telemetry sink for yha-core.
// Counters/gauges use atomics (lock-free hot path); histograms keep a
// fixed 4096-obs ring buffer per bucket and compute nearest-rank
// percentiles on a snapshot-time copy. Label cardinality is capped at
// 1024 distinct buckets per metric (one-shot warn log on cap hits).
package metrics

import (
	"math"
	"runtime"
	"sort"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/yha/core/internal/logger"
)

const (
	DefaultHistogramSize       = 4096
	DefaultLabelCardinalityCap = 1024
)

type Snapshot struct {
	GeneratedAt time.Time           `json:"generatedAt"`
	Counters    []CounterSnapshot   `json:"counters"`
	Histograms  []HistogramSnapshot `json:"histograms"`
	Gauges      []GaugeSnapshot     `json:"gauges"`
	Process     ProcessSnapshot     `json:"process"`
}

type CounterSnapshot struct {
	Name   string            `json:"name"`
	Labels map[string]string `json:"labels"`
	Value  int64             `json:"value"`
}
// HistogramSnapshot percentiles cover the latest 4096 observations.
// Count and SumSeconds cover the bucket's full lifetime.
type HistogramSnapshot struct {
	Name       string            `json:"name"`
	Labels     map[string]string `json:"labels"`
	Count      int64             `json:"count"`
	P50        float64           `json:"p50"`
	P95        float64           `json:"p95"`
	P99        float64           `json:"p99"`
	Max        float64           `json:"max"`
	SumSeconds float64           `json:"sumSeconds"`
}
type GaugeSnapshot struct {
	Name   string            `json:"name"`
	Labels map[string]string `json:"labels"`
	Value  float64           `json:"value"`
}
type ProcessSnapshot struct {
	GoVersion     string  `json:"goVersion"`
	Goroutines    int     `json:"goroutines"`
	HeapInUseMB   float64 `json:"heapInUseMB"`
	UptimeSeconds float64 `json:"uptimeSeconds"`
}

type Collector struct {
	startedAt  time.Time
	counters   sync.Map // hashKey -> *counterBucket
	histograms sync.Map // hashKey -> *histogramBucket
	gauges     sync.Map // hashKey -> *gaugeBucket

	cardMu   sync.Mutex
	cardinal map[string]map[string]int // kind -> name -> count
	warned   map[string]bool

	histogramSize int
	cardCap       int
	log           *logger.Logger
}

type counterBucket struct {
	name   string
	labels map[string]string
	value  atomic.Int64
}
type histogramBucket struct {
	name   string
	labels map[string]string
	mu     sync.Mutex
	ring   []float64
	idx    int
	count  int64
	sum    float64
	max    float64
}
type gaugeBucket struct {
	name   string
	labels map[string]string
	bits   atomic.Uint64
}

// NewCollector returns an empty Collector with default sizes.
func NewCollector() *Collector {
	return newCollectorWith(nil, DefaultHistogramSize, DefaultLabelCardinalityCap)
}

// SetLogger attaches a logger so cardinality-cap hits are warned about.
func (c *Collector) SetLogger(log *logger.Logger) { c.log = log }
func newCollectorWith(log *logger.Logger, histSize, cardCap int) *Collector {
	if histSize <= 0 {
		histSize = DefaultHistogramSize
	}
	if cardCap <= 0 {
		cardCap = DefaultLabelCardinalityCap
	}
	return &Collector{
		startedAt:     time.Now(),
		cardinal:      make(map[string]map[string]int),
		warned:        make(map[string]bool),
		histogramSize: histSize,
		cardCap:       cardCap,
		log:           log,
	}
}

func (c *Collector) IncCounter(name string, labels map[string]string) {
	c.AddCounter(name, labels, 1)
}

// upsert is the shared hot path for counters/histograms/gauges. apply
// runs against the existing or freshly-created bucket; create returns
// the bucket to install when the key is new. Returns silently when the
// cardinality cap is full.
func (c *Collector) upsert(m *sync.Map, kind, name string, key string,
	create func() any, apply func(any)) {
	if v, ok := m.Load(key); ok {
		apply(v)
		return
	}
	if !c.admit(kind, name) {
		return
	}
	b := create()
	apply(b)
	if existing, loaded := m.LoadOrStore(key, b); loaded {
		apply(existing)
		c.refund(kind, name)
	}
}

func (c *Collector) AddCounter(name string, labels map[string]string, delta int64) {
	if name == "" {
		return
	}
	c.upsert(&c.counters, "counter", name, hashKey(name, labels),
		func() any { return &counterBucket{name: name, labels: copyLabels(labels)} },
		func(b any) { b.(*counterBucket).value.Add(delta) })
}

func (c *Collector) Observe(name string, labels map[string]string, value float64) {
	if name == "" || math.IsNaN(value) || math.IsInf(value, 0) {
		return
	}
	c.upsert(&c.histograms, "histogram", name, hashKey(name, labels),
		func() any {
			return &histogramBucket{
				name: name, labels: copyLabels(labels),
				ring: make([]float64, c.histogramSize),
			}
		},
		func(b any) { b.(*histogramBucket).observe(value) })
}

func (c *Collector) SetGauge(name string, labels map[string]string, value float64) {
	if name == "" {
		return
	}
	bits := math.Float64bits(value)
	c.upsert(&c.gauges, "gauge", name, hashKey(name, labels),
		func() any { return &gaugeBucket{name: name, labels: copyLabels(labels)} },
		func(b any) { b.(*gaugeBucket).bits.Store(bits) })
}

// Snapshot is sorted by name+labels for stable, frame-to-frame output.
func (c *Collector) Snapshot() Snapshot {
	s := Snapshot{GeneratedAt: time.Now().UTC()}
	c.counters.Range(func(_, v any) bool {
		b := v.(*counterBucket)
		s.Counters = append(s.Counters, CounterSnapshot{
			Name: b.name, Labels: copyLabels(b.labels), Value: b.value.Load(),
		})
		return true
	})
	c.histograms.Range(func(_, v any) bool {
		s.Histograms = append(s.Histograms, v.(*histogramBucket).snapshot())
		return true
	})
	c.gauges.Range(func(_, v any) bool {
		b := v.(*gaugeBucket)
		s.Gauges = append(s.Gauges, GaugeSnapshot{
			Name: b.name, Labels: copyLabels(b.labels),
			Value: math.Float64frombits(b.bits.Load()),
		})
		return true
	})
	sort.Slice(s.Counters, func(i, j int) bool {
		return hashKey(s.Counters[i].Name, s.Counters[i].Labels) <
			hashKey(s.Counters[j].Name, s.Counters[j].Labels)
	})
	sort.Slice(s.Histograms, func(i, j int) bool {
		return hashKey(s.Histograms[i].Name, s.Histograms[i].Labels) <
			hashKey(s.Histograms[j].Name, s.Histograms[j].Labels)
	})
	sort.Slice(s.Gauges, func(i, j int) bool {
		return hashKey(s.Gauges[i].Name, s.Gauges[i].Labels) <
			hashKey(s.Gauges[j].Name, s.Gauges[j].Labels)
	})
	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	s.Process = ProcessSnapshot{
		GoVersion:     runtime.Version(),
		Goroutines:    runtime.NumGoroutine(),
		HeapInUseMB:   float64(ms.HeapInuse) / (1024 * 1024),
		UptimeSeconds: time.Since(c.startedAt).Seconds(),
	}
	return s
}

// admit reserves a cardinality slot. Returns false if the cap is full;
// logs once the first time we trip it.
func (c *Collector) admit(kind, name string) bool {
	c.cardMu.Lock()
	defer c.cardMu.Unlock()
	byName, ok := c.cardinal[kind]
	if !ok {
		byName = make(map[string]int)
		c.cardinal[kind] = byName
	}
	if byName[name] >= c.cardCap {
		flag := kind + "|" + name
		if !c.warned[flag] {
			c.warned[flag] = true
			if c.log != nil {
				c.log.Warn("metrics: cardinality cap hit",
					"kind", kind, "name", name, "cap", c.cardCap)
			}
		}
		return false
	}
	byName[name]++
	return true
}

func (c *Collector) refund(kind, name string) {
	c.cardMu.Lock()
	defer c.cardMu.Unlock()
	if byName, ok := c.cardinal[kind]; ok && byName[name] > 0 {
		byName[name]--
	}
}

func (b *histogramBucket) observe(v float64) {
	b.mu.Lock()
	b.ring[b.idx] = v
	b.idx = (b.idx + 1) % len(b.ring)
	b.count++
	b.sum += v
	if v > b.max {
		b.max = v
	}
	b.mu.Unlock()
}

func (b *histogramBucket) snapshot() HistogramSnapshot {
	b.mu.Lock()
	count, sum, max := b.count, b.sum, b.max
	live := int64(len(b.ring))
	if count < live {
		live = count
	}
	values := make([]float64, live)
	if count < int64(len(b.ring)) {
		copy(values, b.ring[:live])
	} else {
		copy(values, b.ring)
	}
	labels := copyLabels(b.labels)
	name := b.name
	b.mu.Unlock()

	sort.Float64s(values)
	return HistogramSnapshot{
		Name: name, Labels: labels, Count: count,
		P50: percentile(values, 0.50),
		P95: percentile(values, 0.95),
		P99: percentile(values, 0.99),
		Max: max, SumSeconds: sum,
	}
}

func percentile(sorted []float64, q float64) float64 {
	n := len(sorted)
	if n == 0 {
		return 0
	}
	if q <= 0 {
		return sorted[0]
	}
	if q >= 1 {
		return sorted[n-1]
	}
	rank := int(math.Ceil(q*float64(n))) - 1
	if rank < 0 {
		rank = 0
	} else if rank >= n {
		rank = n - 1
	}
	return sorted[rank]
}

// hashKey returns a stable string key for (name, labels). Used both
// as a sync.Map key and as the sort key in Snapshot.
func hashKey(name string, labels map[string]string) string {
	if len(labels) == 0 {
		return name + "\x00"
	}
	keys := make([]string, 0, len(labels))
	for k := range labels {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	var b strings.Builder
	b.Grow(len(name) + 16*len(keys))
	b.WriteString(name)
	b.WriteByte(0)
	for _, k := range keys {
		b.WriteString(k)
		b.WriteByte('=')
		b.WriteString(labels[k])
		b.WriteByte(0x1f)
	}
	return b.String()
}

func copyLabels(in map[string]string) map[string]string {
	if len(in) == 0 {
		return map[string]string{}
	}
	out := make(map[string]string, len(in))
	for k, v := range in {
		out[k] = v
	}
	return out
}
