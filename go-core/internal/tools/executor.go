// Bridge tool dispatcher — Go port of bridge/tools/exec.ts.
//
// The Executor holds the per-session working directory, an optional
// path allowlist (path prefixes that supplement cwd for Read/Write),
// and a logger handle. Each Run call dispatches by tool name to a
// Go-native handler in a sibling file (bash.go, read.go, …).
//
// Each per-tool call gets its own derived context.Context with a
// short timeout. The handler honours ctx.Done() and kills any
// subprocess it spawned when the deadline trips.
package tools

import (
	"context"
	"fmt"
	"time"

	"github.com/yha/core/internal/logger"
)

// Default per-tool timeouts. Bash uses 60 s to match the JS version;
// the rest pick conservative limits well above their usual cost.
const (
	defaultBashTimeout    = 60 * time.Second
	defaultReadTimeout    = 30 * time.Second
	defaultWriteTimeout   = 30 * time.Second
	defaultGlobTimeout    = 30 * time.Second
	defaultGrepTimeout    = 30 * time.Second
	defaultFetchTimeout   = 30 * time.Second
)

// Recorder is the minimal metrics surface Run uses to record per-tool
// counter + latency observations. *metrics.Collector satisfies it
// implicitly. nil is permitted; metrics emission is guarded.
type Recorder interface {
	IncCounter(name string, labels map[string]string)
	Observe(name string, labels map[string]string, value float64)
}

// Executor implements ExecutorAPI. CWD scopes Read/Write/Edit. The
// optional Allowlist holds extra absolute path prefixes (e.g. a
// shared config dir) that are reachable on top of CWD. Log may be
// nil — a no-op logger replaces it on construction.
type Executor struct {
	CWD       string
	Allowlist []string
	Log       *logger.Logger

	// catalog is the merged static + MCP tool list this executor
	// advertises. Built once via BuildCatalog at construction time and
	// held here so Tools() can return it without re-allocating. The
	// field is private to leave the public Catalog() method (defined
	// in runner.go) unambiguous.
	catalog []Tool

	// Recorder is optional — when non-nil, Run emits per-call counters
	// + latency. Set via SetRecorder after construction; nil-safe at
	// every call site.
	Recorder Recorder
}

// SetRecorder attaches an optional metrics Recorder. Pass nil to
// disable.
func (e *Executor) SetRecorder(r Recorder) { e.Recorder = r }

// New returns an Executor scoped to cwd. The catalog defaults to the
// static bridge tools; callers can rebuild it via SetCatalog if they
// need MCP-merged entries.
func New(cwd string, allowlist []string, log *logger.Logger) *Executor {
	if log == nil {
		log = logger.New(discardWriter{})
	}
	e := &Executor{
		CWD:       cwd,
		Allowlist: allowlist,
		Log:       log,
	}
	e.catalog = BuildCatalog(e, nil, nil)
	return e
}

// SetCatalog replaces the executor's advertised tool list. Used by
// callers that want to advertise MCP-merged entries; the static
// catalog set at construction stays in BuildCatalog.
func (e *Executor) SetCatalog(t []Tool) { e.catalog = t }

// Tools returns the catalog this executor advertises. Safe for
// concurrent reads; callers should not mutate the returned slice.
func (e *Executor) Tools() []Tool {
	return e.catalog
}

// Run dispatches a tool call by name. Unknown names produce
// OK=false with a clear message rather than an error so the model
// can recover. Genuine system failures (context cancellation,
// programming errors) propagate as the second return value.
//
// When a Recorder is attached, every completion records:
//
//   - tool_run_count{name, status}     status: ok|error|unknown
//   - tool_run_latency_ms{name}        always, on every return
//
// status mapping:
//   - "unknown" — name isn't in the dispatch table
//   - "error"   — system error from the handler OR Result.OK == false
//   - "ok"      — handler returned with Result.OK == true
func (e *Executor) Run(ctx context.Context, name string, args map[string]any) (*Result, error) {
	if args == nil {
		args = map[string]any{}
	}
	start := time.Now()
	res, runErr := e.dispatch(ctx, name, args)
	if e.Recorder != nil {
		status := toolRunStatus(name, res, runErr)
		e.Recorder.IncCounter("tool_run_count", map[string]string{
			"name":   name,
			"status": status,
		})
		e.Recorder.Observe("tool_run_latency_ms",
			map[string]string{"name": name},
			float64(time.Since(start).Microseconds())/1000.0)
	}
	return res, runErr
}

// dispatch is the underlying name → handler switch, kept separate from
// Run so the metrics wrapper above stays tidy.
func (e *Executor) dispatch(ctx context.Context, name string, args map[string]any) (*Result, error) {
	switch name {
	case "Bash":
		c, cancel := withTimeout(ctx, defaultBashTimeout)
		defer cancel()
		return e.bashRun(c, args)
	case "Read":
		c, cancel := withTimeout(ctx, defaultReadTimeout)
		defer cancel()
		return e.readRun(c, args)
	case "Write":
		c, cancel := withTimeout(ctx, defaultWriteTimeout)
		defer cancel()
		return e.writeRun(c, args)
	case "Glob":
		c, cancel := withTimeout(ctx, defaultGlobTimeout)
		defer cancel()
		return e.globRun(c, args)
	case "Grep":
		c, cancel := withTimeout(ctx, defaultGrepTimeout)
		defer cancel()
		return e.grepRun(c, args)
	case "WebFetch":
		c, cancel := withTimeout(ctx, defaultFetchTimeout)
		defer cancel()
		return e.webFetchRun(c, args)
	default:
		return &Result{
			OK:    false,
			Error: fmt.Sprintf("unknown tool: %s", name),
		}, nil
	}
}

// toolRunStatus collapses (Result, error) into one of the three
// status labels Run emits. "unknown" wins over "error" so dashboards
// can distinguish "the model called something we don't have" from
// "we tried, it failed".
func toolRunStatus(name string, res *Result, err error) string {
	known := false
	switch name {
	case "Bash", "Read", "Write", "Glob", "Grep", "WebFetch":
		known = true
	}
	if !known {
		return "unknown"
	}
	if err != nil {
		return "error"
	}
	if res != nil && !res.OK {
		return "error"
	}
	return "ok"
}

// withTimeout derives a child context with the given deadline. If
// the parent has an earlier deadline, that wins.
func withTimeout(parent context.Context, d time.Duration) (context.Context, context.CancelFunc) {
	if parent == nil {
		parent = context.Background()
	}
	return context.WithTimeout(parent, d)
}

// argString reads a string field from args. Missing or non-string
// returns the supplied default.
func argString(args map[string]any, key, dflt string) string {
	v, ok := args[key]
	if !ok {
		return dflt
	}
	s, ok := v.(string)
	if !ok {
		return dflt
	}
	return s
}

// argInt reads an integer-flavoured field. Accepts float64 (JSON
// default), int, int64. Anything else returns the default.
func argInt(args map[string]any, key string, dflt int) int {
	v, ok := args[key]
	if !ok {
		return dflt
	}
	switch n := v.(type) {
	case float64:
		return int(n)
	case int:
		return n
	case int64:
		return int(n)
	case int32:
		return int(n)
	}
	return dflt
}

// argBool reads a boolean field. Treats only the literal `true`
// boolean as truthy; strings like "true" are NOT coerced — the
// caller should normalise upstream if it wants laxer parsing.
func argBool(args map[string]any, key string, dflt bool) bool {
	v, ok := args[key]
	if !ok {
		return dflt
	}
	if b, ok := v.(bool); ok {
		return b
	}
	return dflt
}

// errResult is a small helper for wrapping a security/sandbox error
// as an OK=false Result. Keeps the per-tool handlers concise.
func errResult(err error) *Result {
	return &Result{OK: false, Error: err.Error()}
}

// discardWriter is a tiny io.Writer that throws everything away. Used
// as the fallback when New is called with a nil logger.
type discardWriter struct{}

func (discardWriter) Write(p []byte) (int, error) { return len(p), nil }
