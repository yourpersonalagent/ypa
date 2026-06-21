package tools

import (
	"encoding/json"
	"net/http"

	"github.com/yha/core/internal/logger"
)

// RegisterRoutes mounts the tools control plane on mux.
//
// Today: one route — POST /v1/tools/exec. Body shape:
//
//	{
//	  "name": "Bash",
//	  "args": {"command": "ls"},
//	  "cwd":  "/optional/override"   // defaults to defaultCWD if empty
//	}
//
// Response is a JSON-encoded Result. Per-request Executors are cheap
// (no goroutines, no caches) so we build one per call rather than
// holding a single shared instance — that way each call gets its own
// CWD scoping without locking. The optional Recorder is propagated to
// every per-request Executor so /v1/tools/exec calls show up in
// /internal/metrics like everything else.
func RegisterRoutes(mux *http.ServeMux, defaultCWD string, log *logger.Logger, opts ...RouteOption) {
	if log == nil {
		log = logger.New(discardWriter{})
	}
	cfg := routeConfig{}
	for _, o := range opts {
		o(&cfg)
	}
	mux.HandleFunc("/v1/tools/exec", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost {
			w.Header().Set("Allow", "POST")
			http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
			return
		}
		var body struct {
			Name string         `json:"name"`
			Args map[string]any `json:"args"`
			CWD  string         `json:"cwd"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			http.Error(w, `{"error":"invalid JSON body"}`, http.StatusBadRequest)
			return
		}
		if body.Name == "" {
			http.Error(w, `{"error":"name required"}`, http.StatusBadRequest)
			return
		}
		cwd := body.CWD
		if cwd == "" {
			cwd = defaultCWD
		}
		exec := New(cwd, nil, log)
		if cfg.recorder != nil {
			exec.SetRecorder(cfg.recorder)
		}
		result, err := exec.Run(r.Context(), body.Name, body.Args)
		if err != nil {
			// Genuine system failures (ctx cancellation etc) — surface as 500.
			log.Warn("tools.exec.system-error", "name", body.Name, "err", err)
			http.Error(w, `{"error":"`+jsonEscape(err.Error())+`"}`, http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		_ = json.NewEncoder(w).Encode(result)
	})
}

// jsonEscape produces a fragment safe to embed inside a JSON string.
// We avoid json.Marshal(string) here because we want just the inner
// bytes (not the surrounding quotes).
func jsonEscape(s string) string {
	b, _ := json.Marshal(s)
	if len(b) < 2 {
		return ""
	}
	return string(b[1 : len(b)-1])
}

// RouteOption configures RegisterRoutes. Functional-options style so we
// can add knobs (allowlist, custom timeouts, etc.) without breaking
// existing callers.
type RouteOption func(*routeConfig)

type routeConfig struct {
	recorder Recorder
}

// WithRecorder attaches a metrics Recorder to every per-request Executor.
func WithRecorder(r Recorder) RouteOption {
	return func(c *routeConfig) { c.recorder = r }
}
