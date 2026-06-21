package metrics

// Recorder is the minimal write-only surface that subsystem packages
// depend on for emitting per-call telemetry. Defined here (and not at
// the bucket-level Collector) so packages like internal/mcp,
// internal/tools, and internal/stream can accept a Recorder field
// without importing internal/metrics — which would create a cycle in
// the other direction once metrics grows fanout helpers.
//
// *metrics.Collector satisfies this interface implicitly: the daemon
// constructs the collector once and passes it as a Recorder to every
// hook site. Tests substitute a slice-based capture struct with the
// same two methods.
//
// Implementations MUST be nil-safe — callers should check `if r ==
// nil` before invoking, since most hook sites treat metrics as
// optional. Calling into a non-nil Recorder must be cheap and
// non-blocking; the production Collector uses sync/atomic on the hot
// path.
type Recorder interface {
	IncCounter(name string, labels map[string]string)
	Observe(name string, labels map[string]string, value float64)
}
