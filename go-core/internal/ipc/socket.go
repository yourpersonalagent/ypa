// Package ipc holds Unix-socket helpers shared by yha-core and yha CLI.
//
// The socket is the local-trust path. File perms 0700 mean only the
// process owner can connect; remote clients use HTTPS+bearer instead.
package ipc

import (
	"context"
	"net"
	"net/http"
	"os"
	"path/filepath"
)

// DefaultSocketPath returns the socket location, picking the first
// existing parent dir among $XDG_RUNTIME_DIR, /var/run/user/<uid>, /tmp.
func DefaultSocketPath() string {
	if v := os.Getenv("YHA_CORE_SOCKET"); v != "" {
		return v
	}
	for _, base := range socketDirCandidates() {
		if st, err := os.Stat(base); err == nil && st.IsDir() {
			return filepath.Join(base, "yha.sock")
		}
	}
	return filepath.Join("/tmp", "yha.sock")
}

func socketDirCandidates() []string {
	out := []string{}
	if v := os.Getenv("XDG_RUNTIME_DIR"); v != "" {
		out = append(out, v)
	}
	out = append(out, "/var/run", "/tmp")
	return out
}

// DialSocket opens a Unix-socket connection. Used by the CLI to talk to
// the daemon when both are local.
func DialSocket(path string) (net.Conn, error) {
	return net.Dial("unix", path)
}

// HTTPClientFor returns an *http.Client whose transport dials the given
// Unix socket regardless of the request URL's host. Useful for the CLI
// to reuse stdlib http calls against the daemon — point any URL at e.g.
// http://yha/v1/... and the dialer ignores the host.
func HTTPClientFor(path string) *http.Client {
	return &http.Client{
		Transport: &http.Transport{
			DialContext: func(ctx context.Context, _ string, _ string) (net.Conn, error) {
				var d net.Dialer
				return d.DialContext(ctx, "unix", path)
			},
		},
	}
}
