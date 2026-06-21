package tools

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestIsPrivateIP(t *testing.T) {
	cases := map[string]bool{
		"127.0.0.1":       true,
		"127.10.20.30":    true,
		"10.0.0.1":        true,
		"172.16.0.1":      true,
		"172.31.255.255":  true,
		"192.168.1.1":     true,
		"169.254.0.1":     true,
		"0.0.0.0":         true,
		"::1":             true,
		"fe80::1":         true,
		"fc00::1":         true,
		"8.8.8.8":         false,
		"1.2.3.4":         false,
		"2001:4860:4860::8888": false,
		"172.32.0.1":      false, // outside 172.16.0.0/12
	}
	for host, want := range cases {
		if got := IsPrivateIP(host); got != want {
			t.Errorf("IsPrivateIP(%q) = %v, want %v", host, got, want)
		}
	}
}

func TestValidateFetchURLAcceptsHTTPS(t *testing.T) {
	u, err := ValidateFetchURL("https://example.com/foo?bar=baz")
	if err != nil {
		t.Fatalf("rejected valid URL: %v", err)
	}
	if u == "" {
		t.Error("returned empty URL")
	}
}

func TestValidateFetchURLBlocksProtocol(t *testing.T) {
	for _, raw := range []string{"file:///etc/passwd", "ftp://x", "data:text/html,hi"} {
		_, err := ValidateFetchURL(raw)
		if err == nil {
			t.Errorf("expected error for %q", raw)
		}
	}
}

func TestValidateFetchURLBlocksLocalhost(t *testing.T) {
	for _, raw := range []string{"http://localhost/foo", "http://my.local/x"} {
		_, err := ValidateFetchURL(raw)
		if err == nil {
			t.Errorf("expected error for %q", raw)
		}
	}
}

func TestValidateFetchURLBlocksPrivateIP(t *testing.T) {
	for _, raw := range []string{
		"http://127.0.0.1/foo",
		"http://10.0.0.1/x",
		"http://192.168.1.1/x",
		"http://[::1]/x",
	} {
		_, err := ValidateFetchURL(raw)
		if err == nil {
			t.Errorf("expected error for %q", raw)
		}
	}
}

func TestResolveSafePathInsideCwd(t *testing.T) {
	cwd := t.TempDir()
	p, err := ResolveSafePath("foo/bar.txt", cwd)
	if err != nil {
		t.Fatalf("rejected valid path: %v", err)
	}
	want, _ := filepath.Abs(filepath.Join(cwd, "foo/bar.txt"))
	if p != want {
		t.Errorf("got %q, want %q", p, want)
	}
}

func TestResolveSafePathBlocksTraversal(t *testing.T) {
	cwd := t.TempDir()
	cases := []string{"../etc/passwd", "../../etc/passwd", "foo/../../etc/passwd"}
	for _, c := range cases {
		_, err := ResolveSafePath(c, cwd)
		if err == nil {
			t.Errorf("expected traversal block for %q", c)
		}
	}
}

func TestResolveSafePathAcceptsCwdItself(t *testing.T) {
	cwd := t.TempDir()
	p, err := ResolveSafePath(".", cwd)
	if err != nil {
		t.Fatalf("cwd should be reachable: %v", err)
	}
	if p != cwd {
		t.Errorf("got %q, want %q", p, cwd)
	}
}

func TestResolveSafePathRejectsEmpty(t *testing.T) {
	_, err := ResolveSafePath("", t.TempDir())
	if err == nil {
		t.Error("empty path should be rejected")
	}
}

func TestResolveSafePathErrorMessageHidesInputPathPlainText(t *testing.T) {
	// We don't strictly hide the resolved path, but the error must mention
	// "blocked" somewhere so the model can detect the failure.
	_, err := ResolveSafePath("../../../etc/passwd", t.TempDir())
	if err == nil {
		t.Fatal("expected error")
	}
	if !strings.Contains(err.Error(), "blocked") && !strings.Contains(err.Error(), "Blocked") {
		t.Errorf("error message should signal block: %v", err)
	}
}

// resolveTempDir returns t.TempDir() with symlinks already resolved so
// comparisons against EvalSymlinks output are stable on platforms where
// the temp root itself sits behind a symlink (macOS /var → /private/var).
func resolveTempDir(t *testing.T) string {
	t.Helper()
	cwd := t.TempDir()
	resolved, err := filepath.EvalSymlinks(cwd)
	if err != nil {
		t.Fatalf("EvalSymlinks(%q): %v", cwd, err)
	}
	return resolved
}

func TestResolveSafePathBlocksSymlinkEscape(t *testing.T) {
	cwd := resolveTempDir(t)
	// Create a symlink inside cwd that points to /etc/passwd (or any
	// path outside cwd). ResolveSafePath must reject it after
	// EvalSymlinks resolution, even though the link itself sits inside.
	linkPath := filepath.Join(cwd, "evil")
	if err := os.Symlink("/etc/passwd", linkPath); err != nil {
		t.Skipf("symlink creation not supported: %v", err)
	}
	_, err := ResolveSafePath("evil", cwd)
	if err == nil {
		t.Fatal("expected symlink-escape block, got nil")
	}
	if !strings.Contains(err.Error(), "blocked") && !strings.Contains(err.Error(), "Blocked") {
		t.Errorf("error should signal block: %v", err)
	}
}

func TestResolveSafePathAcceptsInternalSymlink(t *testing.T) {
	cwd := resolveTempDir(t)
	// Create a regular file inside cwd, then a symlink also inside cwd
	// pointing at it. ResolveSafePath should accept the link and return
	// the target's resolved path.
	target := filepath.Join(cwd, "real.txt")
	if err := os.WriteFile(target, []byte("hi"), 0o644); err != nil {
		t.Fatalf("WriteFile: %v", err)
	}
	link := filepath.Join(cwd, "ptr.txt")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlink creation not supported: %v", err)
	}
	got, err := ResolveSafePath("ptr.txt", cwd)
	if err != nil {
		t.Fatalf("rejected internal symlink: %v", err)
	}
	if got != target {
		t.Errorf("got %q, want resolved target %q", got, target)
	}
}

func TestResolveSafePathAcceptsNonExistentInsideCwd(t *testing.T) {
	cwd := resolveTempDir(t)
	// Write tool calls ResolveSafePath before creating the file. Path
	// must resolve cleanly even though it doesn't exist yet.
	got, err := ResolveSafePath("subdir/new.txt", cwd)
	if err != nil {
		t.Fatalf("rejected non-existent path: %v", err)
	}
	want := filepath.Join(cwd, "subdir/new.txt")
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestResolveSafePathBlocksDanglingParentSymlinkEscape(t *testing.T) {
	cwd := resolveTempDir(t)
	// An *intermediate* component is a dangling symlink pointing OUTSIDE cwd
	// (its target does not exist). Writing through it (ln/x.txt) would land at
	// <outside>/x.txt once the OS follows the link. The leaf-only dangling fix
	// does not cover an intermediate dangling link, so the guard must catch it
	// here by resolving the link target and re-confining.
	outside := filepath.Join(filepath.Dir(cwd), "ESCAPE-TARGET") // sibling of cwd, absent
	link := filepath.Join(cwd, "ln")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlink creation not supported: %v", err)
	}
	got, err := ResolveSafePath("ln/x.txt", cwd)
	if err == nil {
		t.Fatalf("expected escape block for dangling parent symlink, got path %q", got)
	}
	if !strings.Contains(err.Error(), "blocked") && !strings.Contains(err.Error(), "Blocked") {
		t.Errorf("error should signal block: %v", err)
	}
}

func TestResolveSafePathBlocksDanglingLeafSymlinkEscape(t *testing.T) {
	cwd := resolveTempDir(t)
	// The leaf itself is a dangling symlink to outside cwd (regression guard
	// for commit 0c78321 — kept passing by the rewrite).
	outside := filepath.Join(filepath.Dir(cwd), "GONE-LEAF")
	link := filepath.Join(cwd, "leaf")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlink creation not supported: %v", err)
	}
	if _, err := ResolveSafePath("leaf", cwd); err == nil {
		t.Fatal("expected escape block for dangling leaf symlink, got nil")
	}
}

func TestResolveSafePathNonExistentThroughSymlinkedParent(t *testing.T) {
	cwd := resolveTempDir(t)
	// Make a real directory outside cwd's tree (but a sibling under the
	// temp root won't do — it must still resolve under cwd). Instead:
	// create a directory inside cwd and a symlink-dir also inside cwd
	// pointing at it, then write a non-existent path through the link.
	realDir := filepath.Join(cwd, "real-dir")
	if err := os.Mkdir(realDir, 0o755); err != nil {
		t.Fatalf("Mkdir: %v", err)
	}
	linkDir := filepath.Join(cwd, "link-dir")
	if err := os.Symlink(realDir, linkDir); err != nil {
		t.Skipf("symlink creation not supported: %v", err)
	}
	got, err := ResolveSafePath("link-dir/newfile.txt", cwd)
	if err != nil {
		t.Fatalf("rejected non-existent path through symlinked parent: %v", err)
	}
	want := filepath.Join(realDir, "newfile.txt")
	if got != want {
		t.Errorf("got %q, want %q (parent resolved through symlink)", got, want)
	}
}
