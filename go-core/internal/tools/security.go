// Security primitives ported from bridge/tools/security.ts.
//
// Two public helpers:
//   ResolveSafePath(rawPath, cwd) — path-traversal guard for Read / Write / Edit
//   ValidateFetchURL(rawURL)      — SSRF guard for WebFetch / fetch-tool
//
// Both return a typed error on rejection so callers can surface the
// reason in a 400 response without leaking the raw input back at the
// model.
package tools

import (
	"errors"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// SecurityError is returned when a path or URL fails the sandbox
// check. The Reason field is human-readable; Detail holds structured
// fields for log forwarding.
type SecurityError struct {
	Reason string
	Detail map[string]any
}

func (e *SecurityError) Error() string { return e.Reason }

func newSecurityError(reason string, detail map[string]any) *SecurityError {
	return &SecurityError{Reason: reason, Detail: detail}
}

// ── SSRF blocked ranges ────────────────────────────────────────────────────

// ssrfBlockedV4 mirrors SSRF_BLOCKED_HOSTS in security.ts (IPv4 entries).
var ssrfBlockedV4 = []string{
	"127.0.0.0/8",
	"10.0.0.0/8",
	"172.16.0.0/12",
	"192.168.0.0/16",
	"169.254.0.0/16",
	"0.0.0.0/8",
}

// IPv6 blocked ranges. ::1 is loopback; fc00::/7 is ULA; fe80::/10 is
// link-local.
var ssrfBlockedV6 = []string{
	"::1/128",
	"fc00::/7",
	"fe80::/10",
}

// IsPrivateIP returns true if the host string parses to an IP in any
// of the blocked ranges. Hostnames return false (caller does its own
// hostname checks first).
func IsPrivateIP(host string) bool {
	host = strings.Trim(host, "[]")
	ip := net.ParseIP(host)
	if ip == nil {
		return false
	}
	if ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() ||
		ip.IsPrivate() || ip.IsUnspecified() {
		return true
	}
	if v4 := ip.To4(); v4 != nil {
		for _, cidr := range ssrfBlockedV4 {
			if cidrContains(cidr, v4) {
				return true
			}
		}
		return false
	}
	for _, cidr := range ssrfBlockedV6 {
		if cidrContains(cidr, ip) {
			return true
		}
	}
	return false
}

func cidrContains(cidr string, ip net.IP) bool {
	_, network, err := net.ParseCIDR(cidr)
	if err != nil {
		return false
	}
	return network.Contains(ip)
}

// ValidateFetchURL is the WebFetch guard. Rejects:
//   - non-http(s) schemes
//   - bare "localhost" / "*.local" / "*.internal" hostnames
//   - IP literals in a blocked range
//   - hostnames that DNS-resolve to a private/loopback/metadata IP
//
// Returns the canonicalised URL on success.
//
// This rejects obvious SSRF at validation time, but is not by itself
// rebinding-proof: the address can change between this check and the socket
// connect. Callers that actually fetch must also pin the connection with a
// dialer that re-checks the resolved IP (see webfetch.go's safeDialer).
func ValidateFetchURL(rawURL string) (string, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return "", newSecurityError("Invalid URL", map[string]any{"rawUrl": rawURL})
	}
	switch strings.ToLower(u.Scheme) {
	case "http", "https":
	default:
		return "", newSecurityError(
			fmt.Sprintf("Blocked protocol: %s:", u.Scheme),
			map[string]any{"protocol": u.Scheme},
		)
	}
	host := u.Hostname()
	if host == "" {
		return "", newSecurityError("URL missing host", map[string]any{"rawUrl": rawURL})
	}
	hl := strings.ToLower(host)
	if hl == "localhost" || strings.HasSuffix(hl, ".local") || strings.HasSuffix(hl, ".internal") {
		return "", newSecurityError(
			"Blocked hostname: "+host,
			map[string]any{"hostname": host},
		)
	}
	if net.ParseIP(host) != nil {
		if IsPrivateIP(host) {
			return "", newSecurityError(
				"Blocked private IP: "+host,
				map[string]any{"hostname": host},
			)
		}
		return u.String(), nil
	}
	// Hostname: resolve and reject if any address is in a blocked range. A
	// lookup failure is non-fatal here — the host may be momentarily
	// unresolvable, and the rebinding-proof dialer (webfetch.go safeFetchClient)
	// re-checks the concrete IP at connect time regardless.
	ips, lerr := net.LookupIP(host)
	if lerr != nil {
		return u.String(), nil
	}
	for _, ip := range ips {
		if IsPrivateIP(ip.String()) {
			return "", newSecurityError(
				"Blocked: "+host+" resolves to private IP "+ip.String(),
				map[string]any{"hostname": host, "address": ip.String()},
			)
		}
	}
	return u.String(), nil
}

// ResolveSafePath is the Read/Write/Edit guard. Joins rawPath against
// cwd if relative, resolves symlinks, and confirms the result lives
// under cwd. The "/workspace/" prefix remap from the JS version is
// preserved — models hallucinate it from training data.
func ResolveSafePath(rawPath, cwd string) (string, error) {
	if rawPath == "" {
		return "", newSecurityError("Empty path", nil)
	}
	fp := rawPath
	if cwd != "" && !filepath.IsAbs(rawPath) {
		fp = filepath.Join(cwd, rawPath)
	}
	// Remap stale /workspace prefix.
	if cwd != "" && strings.HasPrefix(fp, "/workspace/") {
		if _, err := os.Stat("/workspace"); errors.Is(err, os.ErrNotExist) {
			fp = filepath.Join(cwd, strings.TrimPrefix(fp, "/workspace/"))
		}
	}
	resolved, err := filepath.Abs(fp)
	if err != nil {
		return "", newSecurityError("Cannot resolve path", map[string]any{"path": rawPath})
	}
	var safeBase string
	if cwd != "" {
		safeBase, _ = filepath.Abs(cwd)
	} else {
		safeBase = filepath.VolumeName(resolved)
		if safeBase == "" {
			safeBase = string(filepath.Separator)
		}
	}
	if resolved != safeBase && !strings.HasPrefix(resolved, safeBase+string(filepath.Separator)) {
		return "", newSecurityError(
			fmt.Sprintf(`Path traversal blocked: %q is outside allowed directory %q`, resolved, safeBase),
			map[string]any{"resolved": resolved, "safeBase": safeBase},
		)
	}
	// Symlink resolution: a symlink ANYWHERE in the path — the leaf or an
	// intermediate component, whether or not its target exists yet — can
	// redirect outside cwd. canonicalizePath follows every link (including
	// dangling ones, which filepath.EvalSymlinks alone refuses to resolve) so
	// the returned path reflects where the OS would actually read/write. The
	// non-existent tail of a Write target is reattached lexically.
	//
	// This generalises the earlier leaf-only dangling-symlink fix (commit
	// 0c78321): an intermediate dangling symlink (cwd/ln -> ../GONE, then
	// ln/x.txt) used to fall through to the lexical path and pass the prefix
	// check, escaping confinement.
	final, err := canonicalizePath(resolved, 0)
	if err != nil {
		return "", newSecurityError("Cannot resolve symlinks", map[string]any{"path": rawPath})
	}
	if final != safeBase && !strings.HasPrefix(final, safeBase+string(filepath.Separator)) {
		return "", newSecurityError(
			fmt.Sprintf(`Path traversal blocked: %q is outside allowed directory %q`, final, safeBase),
			map[string]any{"resolved": final, "safeBase": safeBase},
		)
	}
	return final, nil
}

// canonicalizePath resolves an absolute path to the location the OS would
// actually touch, following symlinks at every component — including dangling
// links whose target does not exist yet, which filepath.EvalSymlinks refuses
// to resolve. The path need not fully exist (Write creates new files): the
// longest existing prefix is resolved with EvalSymlinks and the missing tail
// is reattached lexically. depth bounds the symlink-chain recursion so a
// pathological dangling loop fails closed rather than recursing forever.
func canonicalizePath(abs string, depth int) (string, error) {
	const maxSymlinkDepth = 40
	if depth > maxSymlinkDepth {
		return "", errors.New("symlink resolution too deep")
	}
	// Fast path: the whole path exists. EvalSymlinks resolves every link and
	// detects loops in the existing portion (ELOOP is not IsNotExist).
	if resolved, err := filepath.EvalSymlinks(abs); err == nil {
		return resolved, nil
	} else if !os.IsNotExist(err) {
		return "", err
	}
	// abs does not fully exist. If abs itself is a (dangling) symlink, follow
	// its target and recurse. Reaching an intermediate dangling link via the
	// parent recursion below routes through here, which is what closes the
	// escape.
	if li, lerr := os.Lstat(abs); lerr == nil && li.Mode()&os.ModeSymlink != 0 {
		target, rerr := os.Readlink(abs)
		if rerr != nil {
			return "", rerr
		}
		switch {
		case filepath.IsAbs(target):
			target = filepath.Clean(target)
		case filepath.VolumeName(abs) != "" && len(target) > 0 && os.IsPathSeparator(target[0]):
			// Windows driveless-rooted target ("\etc\passwd"): anchor to the
			// link's volume so it resolves the way the OS does.
			target = filepath.Clean(filepath.VolumeName(abs) + target)
		default:
			target = filepath.Join(filepath.Dir(abs), target)
		}
		return canonicalizePath(target, depth+1)
	}
	// abs is a non-existent, non-symlink leaf. Resolve its parent (which may
	// itself be or sit behind a dangling symlink) and reattach the basename.
	parent := filepath.Dir(abs)
	if parent == abs {
		return abs, nil // reached the volume root
	}
	parentResolved, err := canonicalizePath(parent, depth+1)
	if err != nil {
		return "", err
	}
	return filepath.Join(parentResolved, filepath.Base(abs)), nil
}
