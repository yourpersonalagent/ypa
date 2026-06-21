package metrics

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/yha/core/internal/logger"
)

// Streaming bounds. The TUI defaults to 2 s; the LLM might want a
// faster cadence when debugging, but anything below 250 ms is
// pointless (the snapshot itself is cheap but allocations add up).
const (
	defaultStreamInterval = 2 * time.Second
	minStreamInterval     = 250 * time.Millisecond
	maxStreamInterval     = 30 * time.Second
)

// RegisterRoutes mounts /internal/metrics and /internal/metrics/stream
// on mux. The collector is the source of every snapshot.
//
// /internal/metrics              GET -> JSON Snapshot
// /internal/metrics/stream       GET -> SSE; one Snapshot per tick.
//
// The SSE endpoint is intended for the (yet-to-build) TUI; it also
// works in `curl -N` for quick eyeballing.
func RegisterRoutes(mux *http.ServeMux, c *Collector, log *logger.Logger) {
	if c == nil {
		panic("metrics: RegisterRoutes called with nil Collector")
	}
	if log == nil {
		log = logger.New(discardWriter{})
	}

	mux.HandleFunc("/internal/metrics", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
			return
		}
		snap := c.Snapshot()
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		if err := json.NewEncoder(w).Encode(snap); err != nil {
			log.Debug("metrics: encode snapshot failed", "err", err)
		}
	})

	mux.HandleFunc("/internal/metrics/stream", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
			return
		}
		flusher, ok := w.(http.Flusher)
		if !ok {
			http.Error(w, `{"error":"streaming not supported"}`, http.StatusInternalServerError)
			return
		}

		interval := streamInterval(r)

		w.Header().Set("Content-Type", "text/event-stream")
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Connection", "keep-alive")
		w.Header().Set("X-Accel-Buffering", "no") // disable nginx buffering if proxied
		w.WriteHeader(http.StatusOK)

		// First frame goes out immediately so clients don't sit
		// staring at a blank stream while waiting for the first tick.
		if err := writeSnapshotEvent(w, c.Snapshot()); err != nil {
			return
		}
		flusher.Flush()

		ticker := time.NewTicker(interval)
		defer ticker.Stop()

		ctx := r.Context()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := writeSnapshotEvent(w, c.Snapshot()); err != nil {
					return
				}
				flusher.Flush()
				// Re-check cancellation immediately so a slow
				// flusher doesn't keep us blocked one extra tick.
				if ctx.Err() != nil {
					return
				}
			}
		}
	})
}

// streamInterval reads ?interval=NNNms (or ?interval=N where N is a
// millisecond integer) and clamps the result.
func streamInterval(r *http.Request) time.Duration {
	raw := r.URL.Query().Get("interval")
	if raw == "" {
		return defaultStreamInterval
	}
	if d, err := time.ParseDuration(raw); err == nil {
		return clampInterval(d)
	}
	if ms, err := strconv.Atoi(raw); err == nil {
		return clampInterval(time.Duration(ms) * time.Millisecond)
	}
	return defaultStreamInterval
}

func clampInterval(d time.Duration) time.Duration {
	if d < minStreamInterval {
		return minStreamInterval
	}
	if d > maxStreamInterval {
		return maxStreamInterval
	}
	return d
}

// writeSnapshotEvent emits one SSE event ("event: snapshot\ndata: ...\n\n").
// We use a named event so future endpoints can multiplex other event
// types onto the same stream without breaking parsers.
func writeSnapshotEvent(w http.ResponseWriter, snap Snapshot) error {
	payload, err := json.Marshal(snap)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(w, "event: snapshot\ndata: %s\n\n", payload); err != nil {
		return err
	}
	// Detect deferred response-writer errors via context.
	return nil
}

// SnapshotHandler returns the same handler /internal/metrics serves —
// exposed for callers that want to mount it under a different prefix
// without re-registering the streaming endpoint.
func SnapshotHandler(c *Collector) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
			return
		}
		snap := c.Snapshot()
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(snap)
	})
}

// discardWriter satisfies io.Writer for the fallback logger when the
// caller passes nil. We can't import io/discard from a package alias
// here (the Logger constructor wants io.Writer), so spell it out.
type discardWriter struct{}

func (discardWriter) Write(p []byte) (int, error) { return len(p), nil }
