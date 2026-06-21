package main

// http.go — shared HTTP plumbing for the yha CLI.
//
// All commands (prompt, status, mcp, …) talk to the daemon through
// these helpers so flag handling stays uniform: --socket vs --url
// switches transports, --token / --token-file fills auth, and Unix
// socket discovery falls back to ipc.DefaultSocketPath().

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"

	"github.com/yha/core/internal/ipc"
)

func postJSON(ctx context.Context, pf promptFlags, path string, body any) (*http.Response, error) {
	buf, err := json.Marshal(body)
	if err != nil {
		return nil, fmt.Errorf("marshal body: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, "POST", urlFor(pf, path), bytes.NewReader(buf))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream, application/json")
	if t := tokenFor(pf); t != "" {
		req.Header.Set("Authorization", "Bearer "+t)
	}
	// Shared bridge key for /proxy/* dispatch (e.g. /proxy/mcp-bridge/rpc,
	// used by `yha prompt --as=…`). The bridge enforces this only when it
	// runs with a shared YHA_BRIDGE_KEY; the daemon's /v1/* routes ignore
	// the header, so sending it unconditionally is harmless.
	if k := localDevBridgeKey(); k != "" {
		req.Header.Set("x-bridge-key", k)
	}
	return clientFor(pf).Do(req)
}

func getRequest(ctx context.Context, pf promptFlags, path string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, "GET", urlFor(pf, path), nil)
	if err != nil {
		return nil, err
	}
	if t := tokenFor(pf); t != "" {
		req.Header.Set("Authorization", "Bearer "+t)
	}
	return clientFor(pf).Do(req)
}

// newDeleteRequest builds a DELETE — caller still has to .Do() it via
// clientFor(pf). Used by `yha session kill --delete`.
func newDeleteRequest(ctx context.Context, pf promptFlags, path string) (*http.Request, error) {
	req, err := http.NewRequestWithContext(ctx, "DELETE", urlFor(pf, path), nil)
	if err != nil {
		return nil, err
	}
	if t := tokenFor(pf); t != "" {
		req.Header.Set("Authorization", "Bearer "+t)
	}
	return req, nil
}

// fetchSimple dispatches a GET/POST/DELETE through the shared helpers
// and returns body+0 on success, nil+1 after printing a stderr line.
// `prefix` becomes the leading "yha xxx:" tag so each subcommand gets
// readable error output without re-implementing the same HTTP boilerplate.
func fetchSimple(ctx context.Context, pf promptFlags, prefix, verb, path string, body any) ([]byte, int) {
	var r *http.Response
	var err error
	switch verb {
	case "GET":
		r, err = getRequest(ctx, pf, path)
	case "POST":
		r, err = postJSON(ctx, pf, path, body)
	case "DELETE":
		req, derr := newDeleteRequest(ctx, pf, path)
		if derr != nil {
			err = derr
		} else {
			r, err = clientFor(pf).Do(req)
		}
	default:
		fmt.Fprintf(os.Stderr, "%s: unsupported verb %q\n", prefix, verb)
		return nil, 1
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s: %v\n", prefix, err)
		return nil, 1
	}
	defer r.Body.Close()
	buf, _ := io.ReadAll(r.Body)
	if r.StatusCode >= 300 {
		fmt.Fprintf(os.Stderr, "%s: HTTP %d %s\n", prefix, r.StatusCode, strings.TrimSpace(string(buf)))
		return nil, 1
	}
	return buf, 0
}

func writeJSONOut(b []byte) {
	os.Stdout.Write(b)
	if len(b) == 0 || b[len(b)-1] != '\n' {
		fmt.Println()
	}
}

func clientFor(pf promptFlags) *http.Client {
	if effectiveURL(pf) != "" {
		return &http.Client{} // default transport for remote
	}
	return ipc.HTTPClientFor(socketPath(pf))
}

func urlFor(pf promptFlags, path string) string {
	if u := effectiveURL(pf); u != "" {
		return strings.TrimRight(u, "/") + path
	}
	// Host is ignored when dialing through the Unix-socket transport.
	return "http://yha-core" + path
}

// effectiveURL returns the URL the request should target. Falls back
// to the local-dev URL discovered from bridge/.env when no explicit
// --url / $YHA_URL was given — see localdev.go.
func effectiveURL(pf promptFlags) string {
	if pf.url != "" {
		return pf.url
	}
	url, _ := localDevDefaults()
	return url
}

func socketPath(pf promptFlags) string {
	if pf.socket != "" {
		return pf.socket
	}
	return ipc.DefaultSocketPath()
}

func tokenFor(pf promptFlags) string {
	if pf.token != "" {
		return pf.token
	}
	if pf.tokenFile != "" {
		b, err := os.ReadFile(pf.tokenFile)
		if err == nil {
			return strings.TrimSpace(string(b))
		}
	}
	// Auto-discover the bearer from a local bridge/.env so commands
	// run from the project root work without --token / $YHA_TOKEN.
	_, t := localDevDefaults()
	return t
}

func dumpErr(resp *http.Response) {
	body, _ := io.ReadAll(resp.Body)
	fmt.Fprintf(os.Stderr, "yha: HTTP %d\n", resp.StatusCode)
	if len(body) > 0 {
		fmt.Fprintln(os.Stderr, strings.TrimSpace(string(body)))
	}
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func isPipedStdin() bool {
	stat, err := os.Stdin.Stat()
	if err != nil {
		return false
	}
	return (stat.Mode() & os.ModeCharDevice) == 0
}
