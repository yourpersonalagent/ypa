package tuid

import (
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// repoRootForTest returns the repo root by walking up from this source
// file. Without this, detectRepoRoot() picks up the test binary's temp
// directory and the shell() helper's stat of yha.sh fails.
func repoRootForTest(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	// file = .../go-core/internal/tuid/restart_dispatch_test.go
	// repo root is four levels up.
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", ".."))
}

// TestRestartDispatch locks in the bridge-only-by-default contract:
// `:restart`, `:restart dev`, `:restart build`, and the explicit
// `:restart bridge …` routes through `./yha.sh restart-bridge`. Subcommand scopes (core/rewind/tui-daemon)
// must hit their own ./yha.sh entrypoint. `:restart all` is the only
// path that still triggers a full bounce. `:mode` rides on top of
// restart-bridge.
func TestRestartDispatch(t *testing.T) {
	t.Setenv("YHA_REPO_ROOT", repoRootForTest(t))
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"default", "restart", "restart-bridge"},
		{"dev", "restart dev", "restart-bridge dev"},
		{"build", "restart build", "restart-bridge build"},
		{"bridge", "restart bridge", "restart-bridge"},
		{"bridge dev", "restart bridge dev", "restart-bridge dev"},
		{"core", "restart core", "restart-core"},
		{"rewind", "restart rewind", "restart-rewind"},
		{"tui-daemon", "restart tui-daemon", "restart-tui-daemon"},
		{"tuid alias", "restart tuid", "restart-tui-daemon"},
		{"all", "restart all", "restart-all"},
		{"all dev", "restart all dev", "restart-all dev"},
		{"all build", "restart all build", "restart-all build"},
		{"legacy keep-rewind swallowed", "restart --keep-rewind", "restart-bridge"},
		{"legacy kill-rewind swallowed", "restart dev --kill-rewind", "restart-bridge dev"},
		{"mode dev", "mode dev", "restart-bridge dev"},
		{"mode build", "mode build", "restart-bridge build"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			fields := strings.Fields(c.in)
			spec, err := BuildSpawn(fields[0], fields[1:], "test")
			if err != nil {
				t.Fatalf("BuildSpawn(%q): %v", c.in, err)
			}
			// The launcher prefix is OS-dependent: 1 element on Unix
			// (./yha.sh) vs 6 on Windows (powershell -NoProfile
			// -ExecutionPolicy Bypass -File yha.ps1). Assert the
			// subcommand is the suffix of Argv rather than assuming
			// Argv[1:], so the routing contract holds on both.
			wantFields := strings.Fields(c.want)
			if len(spec.Argv) < len(wantFields) {
				t.Fatalf("argv too short: %v", spec.Argv)
			}
			tail := strings.Join(spec.Argv[len(spec.Argv)-len(wantFields):], " ")
			if tail != c.want {
				t.Fatalf("argv mismatch\n  input: %q\n  got:   %q\n  want:  %q", c.in, tail, c.want)
			}
		})
	}
}

func TestRestartBackNameRejected(t *testing.T) {
	t.Setenv("YHA_REPO_ROOT", repoRootForTest(t))
	_, err := BuildSpawn("restart", []string{"back"}, "test")
	if err == nil || !strings.Contains(err.Error(), "renamed to 'bridge'") {
		t.Fatalf("expected back rename error, got %v", err)
	}
	_, err = BuildSpawn("restart", []string{"--keep-back"}, "test")
	if err == nil || !strings.Contains(err.Error(), "renamed to '--keep-bridge'") {
		t.Fatalf("expected --keep-back rename error, got %v", err)
	}
}
