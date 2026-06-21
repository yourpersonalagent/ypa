package claudesdk

import (
	"path/filepath"
	"testing"
)

// TestDeriveIsolatedHome matches the TS bridge/chat/helpers.ts
// deriveIsolatedHome behaviour: the trailing ".claude" segment is
// stripped to yield the per-instance HOME; anything else returns
// the empty string (TS returns null, which we map to "").
func TestDeriveIsolatedHome(t *testing.T) {
	cases := map[string]string{
		"/home/alice/.claude":                  "/home/alice",
		"/home/alice/.claude-instance/.claude": "/home/alice/.claude-instance",
		"/.claude":                             "",
		"":                                     "",
		"/home/alice/notclaude":                "",
		"/var/.claude/":                        "/var", // trailing slash tolerated
	}
	for in, want := range cases {
		got := deriveIsolatedHome(in)
		if filepath.ToSlash(got) != want {
			t.Errorf("deriveIsolatedHome(%q): want %q, got %q", in, want, got)
		}
	}
}

// TestIsolatedHomeMarkerStable guards against an accidental rename of
// the public constant — downstream packages may reuse it.
func TestIsolatedHomeMarkerStable(t *testing.T) {
	if IsolatedHomeMarker != ".claude" {
		t.Errorf("IsolatedHomeMarker drift: got %q, want %q", IsolatedHomeMarker, ".claude")
	}
}
