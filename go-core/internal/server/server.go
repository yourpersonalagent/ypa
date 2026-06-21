// Package server is the HTTP front door of yha-core.
//
// In Phase 1 the only handler is a reverse proxy to the Node bridge.
// Native handlers (auth, mcp, tools) are added in later phases by
// registering on the same mux before the proxy fallback.
package server

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"github.com/yha/core/internal/logger"
)

// listenReusePort is defined per-platform in reuseport_unix.go /
// reuseport_windows.go. Linux/macOS bind with SO_REUSEADDR + SO_REUSEPORT
// so two daemons can hold the port during blue-green reload. Windows has
// no equivalent — its variant returns a plain net.Listen.

type Config struct {
	Host    string // TCP bind host; empty = all interfaces. Ignored if Socket is set.
	Port    string // TCP port; ignored if Socket is non-empty
	Socket  string // Unix socket path (preferred when set)
	NodeURL string // upstream Node bridge URL for proxy fallback
	Logger  *logger.Logger
	// ReusePort, when true, binds the TCP listener with SO_REUSEPORT
	// (and SO_REUSEADDR) so multiple processes can hold the same port
	// at the same time. This is the kernel-level primitive that makes
	// zero-downtime blue-green restarts work: the new binary binds the
	// port before the old one drains, so the public socket is never
	// closed. Linux/macOS only; ignored when Socket != "". See
	// docs/YHA-go-core.md "Phase 4: Blue-green restart".
	ReusePort bool
	// Auth wraps the mux. Phase 2b passes auth.Gate.Middleware() here.
	// Nil = no auth layer (Phase 1 behaviour).
	Auth func(http.Handler) http.Handler
	// Metrics wraps the request handler outside Auth so per-route
	// counters/latencies record auth-rejected requests too. Phase 4
	// passes metrics.Collector.HTTPMiddleware() here.
	Metrics func(http.Handler) http.Handler
	// BeforeProxy is called once during New, after /healthz is
	// registered and before the catch-all reverse-proxy fallback.
	// Use it to register Go-native HTTP handlers (MCP control plane,
	// tools, metrics) that should NOT be proxied to Node.
	BeforeProxy func(mux *http.ServeMux)
	// ProxyDecorator is called on every outgoing request the catch-
	// all reverse proxy forwards to NodeURL. Phase 2d uses this to
	// stamp X-Yha-Trust headers so Node accepts Go-issued sessions
	// for the legacy /v1/* surface. Nil = no decoration.
	ProxyDecorator func(*http.Request)
}

type Server struct {
	cfg     Config
	mux     *http.ServeMux
	httpSrv *http.Server
	listener net.Listener
	log     *logger.Logger
}

func New(cfg Config) (*Server, error) {
	if cfg.Logger == nil {
		return nil, errors.New("server: Logger is required")
	}
	if cfg.NodeURL == "" {
		return nil, errors.New("server: NodeURL is required")
	}
	if cfg.Socket == "" && cfg.Port == "" {
		return nil, errors.New("server: either Port or Socket is required")
	}

	mux := http.NewServeMux()

	proxy, err := newReverseProxy(cfg.NodeURL, cfg.Logger, cfg.ProxyDecorator)
	if err != nil {
		return nil, fmt.Errorf("server: reverse proxy: %w", err)
	}
	// /healthz advertises X-Yha-Core-Pid so blue-green orchestration
	// (./yha.sh go-reload) can tell which of the two SO_REUSEPORT
	// processes served a given probe — the kernel load-balances, so
	// without this the script can't confirm the new binary is live.
	healthPID := fmt.Sprintf("%d", os.Getpid())
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Header().Set("X-Yha-Core", "native")
		w.Header().Set("X-Yha-Core-Pid", healthPID)
		_, _ = w.Write([]byte("ok\n"))
	})
	if cfg.BeforeProxy != nil {
		cfg.BeforeProxy(mux)
	}
	// Catch-all: proxy everything that isn't natively handled.
	mux.Handle("/", proxy)

	var handler http.Handler = mux
	if cfg.Auth != nil {
		handler = cfg.Auth(handler)
	}
	if cfg.Metrics != nil {
		// Outside Auth so 401/403 still get counted with the right status.
		handler = cfg.Metrics(handler)
	}
	httpSrv := &http.Server{
		Handler:           withRequestLog(handler, cfg.Logger),
		ReadHeaderTimeout: 30 * time.Second,
		// Bound idle keep-alive connections so a client that opens a socket and
		// goes silent can't pin a goroutine+fd indefinitely on the public edge
		// (this listener binds 0.0.0.0 behind the tailscale funnel). We
		// deliberately omit WriteTimeout: SSE and the browser screencast stream
		// hold a single response open for the lifetime of the turn, and a
		// WriteTimeout would sever them mid-stream.
		IdleTimeout: 120 * time.Second,
	}

	return &Server{
		cfg:     cfg,
		mux:     mux,
		httpSrv: httpSrv,
		log:     cfg.Logger,
	}, nil
}

func (s *Server) Run() error {
	ln, err := s.listen()
	if err != nil {
		return err
	}
	s.listener = ln
	addr := ln.Addr().String()
	s.log.Info("listening", "addr", addr)
	if err := s.httpSrv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("server: serve: %w", err)
	}
	return nil
}

func (s *Server) Shutdown(ctx context.Context) error {
	defer func() {
		if s.cfg.Socket != "" {
			_ = os.Remove(s.cfg.Socket)
		}
	}()
	return s.httpSrv.Shutdown(ctx)
}

func (s *Server) listen() (net.Listener, error) {
	if s.cfg.Socket != "" {
		// Unix socket: ensure parent dir exists, remove stale socket file
		// if present, then enforce 0700 permissions on the socket itself.
		if dir := filepath.Dir(s.cfg.Socket); dir != "" && dir != "." {
			if err := os.MkdirAll(dir, 0o755); err != nil {
				return nil, fmt.Errorf("server: mkdir socket dir: %w", err)
			}
		}
		if err := os.Remove(s.cfg.Socket); err != nil && !errors.Is(err, os.ErrNotExist) {
			return nil, fmt.Errorf("server: clean socket: %w", err)
		}
		ln, err := net.Listen("unix", s.cfg.Socket)
		if err != nil {
			return nil, fmt.Errorf("server: listen unix: %w", err)
		}
		if err := os.Chmod(s.cfg.Socket, 0o700); err != nil {
			_ = ln.Close()
			return nil, fmt.Errorf("server: chmod socket: %w", err)
		}
		return ln, nil
	}
	addr := s.cfg.Host + ":" + s.cfg.Port
	if s.cfg.ReusePort {
		ln, err := listenReusePort("tcp", addr)
		if err != nil {
			return nil, fmt.Errorf("server: listen tcp %s (SO_REUSEPORT): %w", addr, err)
		}
		s.log.Info("listener bound with SO_REUSEPORT", "addr", addr)
		return ln, nil
	}
	ln, err := net.Listen("tcp", addr)
	if err != nil {
		return nil, fmt.Errorf("server: listen tcp %s: %w", addr, err)
	}
	return ln, nil
}

func withRequestLog(next http.Handler, log *logger.Logger) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		rec := &statusRecorder{ResponseWriter: w, status: 200}
		next.ServeHTTP(rec, r)
		log.Debug("req",
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.status,
			"dur_ms", time.Since(start).Milliseconds(),
		)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status     int
	wroteHead  bool
}

func (r *statusRecorder) WriteHeader(code int) {
	if !r.wroteHead {
		r.status = code
		r.wroteHead = true
	}
	r.ResponseWriter.WriteHeader(code)
}

// Flush proxies the underlying ResponseWriter's Flusher when present —
// required for SSE pass-through via the reverse proxy.
func (r *statusRecorder) Flush() {
	if f, ok := r.ResponseWriter.(http.Flusher); ok {
		f.Flush()
	}
}

// Unwrap returns the underlying ResponseWriter so Go 1.20+'s
// http.NewResponseController() can find the real Hijacker on it.
// Without this, httputil.ReverseProxy's WebSocket-upgrade path
// fails — the reverse proxy needs to hijack the client connection
// to splice it with the upstream, and the wrapper hides that
// capability. Visible regression: /proxy/browser KasmVNC window
// opened but never connected, /proxy/serve WS preview never came
// online. ResponseController walks the Unwrap chain looking for
// the first writer that implements http.Hijacker.
func (r *statusRecorder) Unwrap() http.ResponseWriter {
	return r.ResponseWriter
}
