package server

import (
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/yha/core/internal/logger"
)

// newReverseProxy builds the catch-all handler that forwards everything
// to the Node bridge. SSE is preserved because httputil.ReverseProxy
// uses io.Copy under the hood and we set FlushInterval to -1 (flush on
// every write — see net/http/httputil docs).
//
// onRequest, if non-nil, is invoked once per outgoing request after the
// default Director has rewritten URL/Host. Used by main.go to stamp
// X-Yha-Trust headers on Go-authenticated requests.
func newReverseProxy(target string, log *logger.Logger, onRequest func(*http.Request)) (http.Handler, error) {
	u, err := url.Parse(target)
	if err != nil {
		return nil, err
	}

	proxy := httputil.NewSingleHostReverseProxy(u)

	originalDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		// Capture the client's Host header BEFORE the director runs so
		// we can stamp it onto X-Forwarded-Host even when we then
		// overwrite req.Host below.
		clientHost := req.Host
		originalDirector(req)
		// Preserve the original Host so virtual-host based routing on
		// the Node side keeps working. httputil sets req.Host to the
		// upstream's host by default, which we don't want.
		req.Host = u.Host
		// Stamp X-Forwarded-Host with the client's original Host so the
		// upstream can construct URLs that reference the public URL,
		// not the loopback upstream URL. Critical for auth redirects:
		// WorkOS verifies the redirect_uri matches what the user
		// originally hit (8443) and not what the proxy forwarded to
		// (8442). Bridge's resolveRedirectUri reads X-Forwarded-Host
		// in preference to Host for exactly this reason.
		if clientHost != "" {
			req.Header.Set("X-Forwarded-Host", clientHost)
		}
		sanitizeInboundHeaders(req)
		if onRequest != nil {
			onRequest(req)
		}
	}

	// Negative FlushInterval tells httputil.ReverseProxy to flush every
	// write for SSE first-byte latency (see net/http/httputil docs).
	proxy.FlushInterval = -1

	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Warn("proxy error", "path", r.URL.Path, "err", err)
		http.Error(w, "upstream unavailable", http.StatusBadGateway)
	}

	proxy.ModifyResponse = func(resp *http.Response) error {
		// Mark every response so we know it went through the Go core in
		// dev mode. Trivial debug hook — no semantic effect.
		resp.Header.Set("X-Yha-Core", "proxy")
		return nil
	}

	return proxy, nil
}

// NewBrowserProxy builds a reverse proxy from /proxy/browser/* directly to
// KasmVNC (the yha-chromium container at 127.0.0.1:3011), stripping the
// /proxy/browser prefix. It bypasses the Node bridge entirely.
//
// Why we don't proxy through Node: Bun's http.Server has a regression in
// server.on('upgrade') where socket.write() succeeds but no bytes ever
// reach the client, so http-proxy-middleware's WS upgrade silently
// times out. Reproduced with a 5-line bun program. Go's httputil
// already supports WebSocket upgrades natively (via the Unwrap fix on
// statusRecorder/middlewareRecorder), so we serve the KasmVNC framebuffer
// stream straight from here. KasmVNC itself listens on the container's
// host-mapped :3011 and handles HTTP + WS on the same port.
func NewBrowserProxy(target string, log *logger.Logger) (http.Handler, error) {
	u, err := url.Parse(target)
	if err != nil {
		return nil, fmt.Errorf("browser proxy: parse target: %w", err)
	}
	proxy := httputil.NewSingleHostReverseProxy(u)
	origDirector := proxy.Director
	proxy.Director = func(req *http.Request) {
		origDirector(req)
		// Strip the /proxy/browser prefix so KasmVNC sees its native
		// paths (/, /websockets, /vnc.html, /core/rfb/, …).
		req.URL.Path = strings.TrimPrefix(req.URL.Path, "/proxy/browser")
		if req.URL.Path == "" {
			req.URL.Path = "/"
		}
		req.URL.RawPath = ""
		req.Host = u.Host
	}
	// SSE/long-poll-friendly. WS upgrades hijack the connection so
	// FlushInterval doesn't apply, but it's the right default for any
	// HTTP/1.1 streaming KasmVNC might serve over the same path.
	proxy.FlushInterval = -1
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Warn("browser proxy error", "path", r.URL.Path, "err", err)
		http.Error(w, "remote browser unavailable", http.StatusBadGateway)
	}
	return proxy, nil
}

// NewDesktopBrowserStreamProxy builds a reverse proxy for the Windows-native
// desktop-browser MCP's CDP screencast WebSocket. Same reasoning as
// NewBrowserProxy for why this lives in go-core instead of routing through
// Bun: Bun's server.on('upgrade') silently drops bytes on hijack.
//
// The upstream port is ephemeral and chosen by _screencast-server.js at MCP
// boot; the chosen port is written to bridge/mcp/exchange/desktop-browser-stream.port.
// We re-read the file on every incoming request rather than caching, so an MCP
// restart with a new port "just works" without bouncing go-core.
//
// portFileDir defaults to bridge/mcp/exchange/ if empty.
func NewDesktopBrowserStreamProxy(portFileDir string, log *logger.Logger) http.Handler {
	if portFileDir == "" {
		portFileDir = "bridge/mcp/exchange"
	}
	portFile := filepath.Join(portFileDir, "desktop-browser-stream.port")

	// One shared Transport so upstream connections stay pooled across requests
	// instead of being discarded each time. The proxy struct is still rebuilt
	// per request (the target port is read live from the port file), but
	// http.Transport keys its connection pool by host:port and is safe to reuse.
	sharedTransport := http.DefaultTransport.(*http.Transport).Clone()

	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Lazy: read the port file per request. Cheap (3-byte read).
		raw, err := os.ReadFile(portFile)
		if err != nil {
			log.Warn("desktop-browser-stream: port file unavailable", "path", portFile, "err", err)
			http.Error(w, "desktop-browser screencast not ready", http.StatusServiceUnavailable)
			return
		}
		port, perr := strconv.Atoi(strings.TrimSpace(string(raw)))
		if perr != nil || port <= 0 || port > 65535 {
			log.Warn("desktop-browser-stream: bad port file contents", "raw", string(raw))
			http.Error(w, "desktop-browser screencast port invalid", http.StatusServiceUnavailable)
			return
		}

		target := fmt.Sprintf("http://127.0.0.1:%d", port)
		u, uerr := url.Parse(target)
		if uerr != nil {
			http.Error(w, "internal proxy error", http.StatusInternalServerError)
			return
		}
		proxy := httputil.NewSingleHostReverseProxy(u)
		proxy.Transport = sharedTransport
		origDirector := proxy.Director
		proxy.Director = func(req *http.Request) {
			origDirector(req)
			// Strip the /proxy/desktop-browser-stream prefix so the upstream
			// (which serves on /) sees its native paths.
			req.URL.Path = strings.TrimPrefix(req.URL.Path, "/proxy/desktop-browser-stream")
			if req.URL.Path == "" {
				req.URL.Path = "/"
			}
			req.URL.RawPath = ""
			req.Host = u.Host
		}
		proxy.FlushInterval = -1
		proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
			log.Warn("desktop-browser-stream proxy error", "path", r.URL.Path, "err", err)
			http.Error(w, "desktop-browser screencast unavailable", http.StatusBadGateway)
		}
		proxy.ServeHTTP(w, r)
	})
}

func sanitizeInboundHeaders(req *http.Request) {
	// The Go core is the public edge (the front door binds 0.0.0.0; tailscale
	// funnel forwards over loopback). Any inbound X-Forwarded-For is therefore
	// client-controlled and spoofable — preserving it would let an attacker
	// inject a bogus hop (e.g. 127.0.0.1) ahead of the real peer that the Node
	// bridge downstream might then trust. Drop it; ReverseProxy.ServeHTTP runs
	// after this Director and repopulates X-Forwarded-For with the genuine
	// RemoteAddr it observed, yielding a trustworthy single-hop value.
	req.Header.Del("X-Forwarded-For")

	// X-Yha-Trust (auth.TrustHeaderName) is a server-minted, HMAC-signed
	// identity header. The trust decorator (onRequest) re-stamps a fresh, valid
	// value immediately after this Director runs whenever the caller has a real
	// session/bearer — so any copy arriving on the inbound request is forged by
	// definition. Strip it at the edge. Node already verifies the HMAC and
	// fails closed on a forgery, but dropping it here means a spoofed header
	// never reaches the bridge at all, even if SESSION_SECRET were to leak.
	// Hard-coded rather than importing internal/auth to keep this leaf package
	// dependency-free; the name must stay in sync with auth.TrustHeaderName.
	req.Header.Del("X-Yha-Trust")
}
