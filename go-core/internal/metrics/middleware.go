package metrics

import (
	"net/http"
	"strconv"
	"strings"
	"time"
)

// HTTPMiddleware records two metrics per request:
//
//   - request_count{route, method, status}     counter (+1 per request)
//   - request_latency_ms{route, method, status} histogram (ms)
//
// The "route" label is the request path collapsed to its first path
// segment (e.g. "/v1/tools/exec" -> "/v1") to keep the cardinality
// bounded — without this guard a noisy crawler hitting /a, /b, /c, …
// would fill the bucket map. A future refactor can pass the matched
// mux pattern through a context value if more granularity is wanted;
// the collector still caps cardinality, so we degrade gracefully.
func (c *Collector) HTTPMiddleware() func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()
			rec := &middlewareRecorder{ResponseWriter: w, status: http.StatusOK}
			next.ServeHTTP(rec, r)

			route := routeLabel(r.URL.Path)
			labels := map[string]string{
				"route":  route,
				"method": r.Method,
				"status": strconv.Itoa(rec.status),
			}
			c.IncCounter("request_count", labels)
			c.Observe("request_latency_ms", labels,
				float64(time.Since(start).Microseconds())/1000.0)
		})
	}
}

// routeLabel collapses a request path to "/" + first segment. Empty
// paths and "/" map to "/". This keeps high-cardinality user content
// (chat IDs, tool names embedded in paths) out of the metric label
// space.
func routeLabel(path string) string {
	if path == "" || path == "/" {
		return "/"
	}
	// Trim any leading slashes, take up to the next '/'.
	trimmed := strings.TrimLeft(path, "/")
	if trimmed == "" {
		return "/"
	}
	if i := strings.IndexByte(trimmed, '/'); i >= 0 {
		return "/" + trimmed[:i]
	}
	return "/" + trimmed
}

// middlewareRecorder captures the response status without breaking
// http.Flusher (needed by SSE handlers that the middleware wraps).
// It mirrors the recorder shape in internal/server/server.go but is
// kept self-contained on purpose — the metrics package can't import
// internal/server.
type middlewareRecorder struct {
	http.ResponseWriter
	status    int
	wroteHead bool
}

func (r *middlewareRecorder) WriteHeader(code int) {
	if !r.wroteHead {
		r.status = code
		r.wroteHead = true
	}
	r.ResponseWriter.WriteHeader(code)
}

// Write makes sure WriteHeader-less handlers still record a 200.
func (r *middlewareRecorder) Write(b []byte) (int, error) {
	if !r.wroteHead {
		r.status = http.StatusOK
		r.wroteHead = true
	}
	return r.ResponseWriter.Write(b)
}

// Flush propagates to the underlying writer when present, so SSE
// handlers (including our own /internal/metrics/stream) keep working
// when wrapped in the middleware.
func (r *middlewareRecorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Unwrap exposes the underlying ResponseWriter so Go 1.20+'s
// http.NewResponseController() can locate the real Hijacker.
// httputil.ReverseProxy needs this for WebSocket upgrades
// (/proxy/browser → KasmVNC, /proxy/serve → live preview). Without
// Unwrap the proxy can't hijack the client connection and WS
// upgrades silently never complete.
func (r *middlewareRecorder) Unwrap() http.ResponseWriter {
	return r.ResponseWriter
}
