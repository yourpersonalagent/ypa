package metrics

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"sync"
	"testing"
)

func TestCounterIncrement(t *testing.T) {
	c := NewCollector()

	c.IncCounter("requests", map[string]string{"route": "/a"})
	c.IncCounter("requests", map[string]string{"route": "/a"})
	c.IncCounter("requests", map[string]string{"route": "/b"})
	c.AddCounter("requests", map[string]string{"route": "/a"}, 5)

	snap := c.Snapshot()
	got := map[string]int64{}
	for _, cs := range snap.Counters {
		got[cs.Labels["route"]] = cs.Value
	}
	if got["/a"] != 7 {
		t.Fatalf("/a expected 7, got %d", got["/a"])
	}
	if got["/b"] != 1 {
		t.Fatalf("/b expected 1, got %d", got["/b"])
	}
}

func TestCounterRace(t *testing.T) {
	c := NewCollector()
	const goroutines = 100
	const perGoroutine = 1000
	labels := map[string]string{"k": "v"}

	var wg sync.WaitGroup
	wg.Add(goroutines)
	for i := 0; i < goroutines; i++ {
		go func() {
			defer wg.Done()
			for j := 0; j < perGoroutine; j++ {
				c.IncCounter("hot", labels)
			}
		}()
	}
	wg.Wait()

	snap := c.Snapshot()
	if len(snap.Counters) != 1 {
		t.Fatalf("expected 1 counter, got %d", len(snap.Counters))
	}
	want := int64(goroutines * perGoroutine)
	if snap.Counters[0].Value != want {
		t.Fatalf("expected %d, got %d", want, snap.Counters[0].Value)
	}
}

func TestHistogramPercentiles(t *testing.T) {
	c := NewCollector()
	for i := 1; i <= 100; i++ {
		c.Observe("latency", nil, float64(i))
	}
	snap := c.Snapshot()
	if len(snap.Histograms) != 1 {
		t.Fatalf("expected 1 histogram, got %d", len(snap.Histograms))
	}
	h := snap.Histograms[0]
	if h.Count != 100 {
		t.Fatalf("count: want 100, got %d", h.Count)
	}
	// Nearest-rank: ceil(0.5*100)=50, ceil(0.95*100)=95, ceil(0.99*100)=99.
	if h.P50 != 50 {
		t.Errorf("p50: want 50, got %v", h.P50)
	}
	if h.P95 != 95 {
		t.Errorf("p95: want 95, got %v", h.P95)
	}
	if h.P99 != 99 {
		t.Errorf("p99: want 99, got %v", h.P99)
	}
	if h.Max != 100 {
		t.Errorf("max: want 100, got %v", h.Max)
	}
	if h.SumSeconds != 5050 {
		t.Errorf("sum: want 5050, got %v", h.SumSeconds)
	}
}

func TestHistogramRingBufferOverflow(t *testing.T) {
	// 5000 obs into a 4096-slot ring. Count==5000, but percentiles
	// should reflect only the last 4096 (values 905..5000).
	c := newCollectorWith(nil, 4096, DefaultLabelCardinalityCap)
	for i := 1; i <= 5000; i++ {
		c.Observe("ring", nil, float64(i))
	}
	snap := c.Snapshot()
	if len(snap.Histograms) != 1 {
		t.Fatalf("expected 1 histogram, got %d", len(snap.Histograms))
	}
	h := snap.Histograms[0]
	if h.Count != 5000 {
		t.Fatalf("count: want 5000, got %d", h.Count)
	}
	// Latest 4096 values are 905..5000. p50 by nearest-rank is the
	// element at index ceil(0.5*4096)-1 = 2047 in the sorted slice,
	// which corresponds to value 905+2047 = 2952.
	if h.P50 != 2952 {
		t.Errorf("p50: want 2952, got %v", h.P50)
	}
	// p95: index ceil(0.95*4096)-1 = 3891; value 905+3891 = 4796.
	if h.P95 != 4796 {
		t.Errorf("p95: want 4796, got %v", h.P95)
	}
	// p99: index ceil(0.99*4096)-1 = 4055; value 905+4055 = 4960.
	if h.P99 != 4960 {
		t.Errorf("p99: want 4960, got %v", h.P99)
	}
	if h.Max != 5000 {
		t.Errorf("max: want 5000, got %v", h.Max)
	}
}

func TestGaugeSet(t *testing.T) {
	c := NewCollector()
	c.SetGauge("queue_depth", map[string]string{"q": "main"}, 3)
	snap := c.Snapshot()
	if len(snap.Gauges) != 1 || snap.Gauges[0].Value != 3 {
		t.Fatalf("first set: %+v", snap.Gauges)
	}
	c.SetGauge("queue_depth", map[string]string{"q": "main"}, 9)
	c.SetGauge("queue_depth", map[string]string{"q": "side"}, 1)
	snap = c.Snapshot()
	got := map[string]float64{}
	for _, g := range snap.Gauges {
		got[g.Labels["q"]] = g.Value
	}
	if got["main"] != 9 {
		t.Errorf("main: want 9, got %v", got["main"])
	}
	if got["side"] != 1 {
		t.Errorf("side: want 1, got %v", got["side"])
	}
}

func TestSnapshotShape(t *testing.T) {
	c := NewCollector()
	c.IncCounter("req", map[string]string{"r": "/x"})
	c.Observe("lat", map[string]string{"r": "/x"}, 1.5)
	c.SetGauge("gauge", map[string]string{"r": "/x"}, 7)

	snap := c.Snapshot()
	raw, err := json.Marshal(snap)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var rt Snapshot
	if err := json.Unmarshal(raw, &rt); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(rt.Counters) != 1 || rt.Counters[0].Value != 1 {
		t.Errorf("counters round-trip: %+v", rt.Counters)
	}
	if len(rt.Histograms) != 1 || rt.Histograms[0].Count != 1 {
		t.Errorf("histograms round-trip: %+v", rt.Histograms)
	}
	if len(rt.Gauges) != 1 || rt.Gauges[0].Value != 7 {
		t.Errorf("gauges round-trip: %+v", rt.Gauges)
	}
	if rt.Process.GoVersion == "" || rt.Process.UptimeSeconds < 0 {
		t.Errorf("process: %+v", rt.Process)
	}

	// Check a few JSON field names are exactly what callers expect
	// (the LLM reads this shape; renaming would silently break it).
	var loose map[string]any
	_ = json.Unmarshal(raw, &loose)
	for _, key := range []string{"generatedAt", "counters", "histograms", "gauges", "process"} {
		if _, ok := loose[key]; !ok {
			t.Errorf("snapshot missing top-level key %q", key)
		}
	}
}

func TestProcessSnapshot(t *testing.T) {
	c := NewCollector()
	snap := c.Snapshot()
	p := snap.Process
	if p.GoVersion == "" {
		t.Errorf("GoVersion empty")
	}
	if p.Goroutines <= 0 {
		t.Errorf("Goroutines should be >0, got %d", p.Goroutines)
	}
	if p.HeapInUseMB <= 0 {
		t.Errorf("HeapInUseMB should be >0, got %v", p.HeapInUseMB)
	}
	if p.UptimeSeconds < 0 {
		t.Errorf("UptimeSeconds should be >=0, got %v", p.UptimeSeconds)
	}
}

func TestLabelCardinalityCap(t *testing.T) {
	c := newCollectorWith(nil, 1024, 1024)
	for i := 0; i < 2000; i++ {
		c.IncCounter("explode", map[string]string{"id": strconv.Itoa(i)})
	}
	snap := c.Snapshot()
	count := 0
	for _, cs := range snap.Counters {
		if cs.Name == "explode" {
			count++
		}
	}
	if count != 1024 {
		t.Fatalf("cap should hold at 1024 distinct buckets, got %d", count)
	}

	// Existing buckets keep updating after the cap is hit — only NEW
	// label combos are dropped.
	c.IncCounter("explode", map[string]string{"id": "0"})
	c.IncCounter("explode", map[string]string{"id": "0"})
	snap2 := c.Snapshot()
	for _, cs := range snap2.Counters {
		if cs.Name == "explode" && cs.Labels["id"] == "0" {
			if cs.Value != 3 {
				t.Errorf("existing bucket id=0: want 3, got %d", cs.Value)
			}
		}
	}
}

func TestHTTPMiddleware(t *testing.T) {
	c := NewCollector()
	mw := c.HTTPMiddleware()

	okHandler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("hi"))
	}))
	failHandler := mw(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Error(w, "boom", http.StatusInternalServerError)
	}))

	rec := httptest.NewRecorder()
	okHandler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/v1/tools/exec", nil))
	if rec.Code != 200 {
		t.Fatalf("want 200, got %d", rec.Code)
	}

	rec = httptest.NewRecorder()
	failHandler.ServeHTTP(rec, httptest.NewRequest(http.MethodPost, "/v1/foo/bar", nil))
	if rec.Code != 500 {
		t.Fatalf("want 500, got %d", rec.Code)
	}

	snap := c.Snapshot()

	// request_count: expect two entries, one with status=200 and one
	// with status=500.
	wantCounts := map[string]int64{
		"/v1|GET|200":  1,
		"/v1|POST|500": 1,
	}
	gotCounts := map[string]int64{}
	for _, cs := range snap.Counters {
		if cs.Name != "request_count" {
			continue
		}
		key := fmt.Sprintf("%s|%s|%s",
			cs.Labels["route"], cs.Labels["method"], cs.Labels["status"])
		gotCounts[key] = cs.Value
	}
	for k, v := range wantCounts {
		if gotCounts[k] != v {
			t.Errorf("counter %q: want %d, got %d", k, v, gotCounts[k])
		}
	}

	// request_latency_ms: each combo should have count=1 and a sane
	// percentile (>=0).
	hits := 0
	for _, h := range snap.Histograms {
		if h.Name != "request_latency_ms" {
			continue
		}
		hits++
		if h.Count != 1 {
			t.Errorf("histogram count for %v: want 1, got %d", h.Labels, h.Count)
		}
		if h.P50 < 0 {
			t.Errorf("p50 negative: %v", h.P50)
		}
	}
	if hits != 2 {
		t.Errorf("expected 2 latency histograms, got %d", hits)
	}
}

func TestRouteLabelCollapse(t *testing.T) {
	cases := map[string]string{
		"":                   "/",
		"/":                  "/",
		"/healthz":           "/healthz",
		"/v1/tools/exec":     "/v1",
		"/internal/metrics":  "/internal",
		"/a/b/c/d":           "/a",
		"//double//slashes":  "/double",
	}
	for in, want := range cases {
		if got := routeLabel(in); got != want {
			t.Errorf("routeLabel(%q): want %q, got %q", in, want, got)
		}
	}
}

func TestHashKeyStability(t *testing.T) {
	a := hashKey("foo", map[string]string{"x": "1", "y": "2"})
	b := hashKey("foo", map[string]string{"y": "2", "x": "1"})
	if a != b {
		t.Errorf("hashKey order-sensitive: %q vs %q", a, b)
	}
	c := hashKey("foo", map[string]string{"x": "1", "y": "3"})
	if a == c {
		t.Errorf("hashKey collided across distinct labels")
	}
}
