package parsers

import "testing"

// Each parser gets a small smoke test. Goal: catch the boring breakage
// (regex compile, off-by-one in branch parsing) without trying to fully
// shadow the formats. Real-format diffing happens by hand against
// live YHA-on-Pi output when the parser changes.

func TestParseBunBuild_ok(t *testing.T) {
	raw := []byte(`vite v5.4.0 building for production...
transforming...
✓ 215 modules transformed.
dist/assets/main.js   1.23 kb │ gzip: 12.4 kb
dist/assets/vendor.js 4.56 kb │ gzip: 88.0 kb
✓ built in 1.42s
`)
	p := ParseBunBuild(raw)
	if got := p.Facts["errors"]; got != "0" {
		t.Errorf("errors = %q, want 0", got)
	}
	if got := p.Facts["warnings"]; got != "0" {
		t.Errorf("warnings = %q, want 0", got)
	}
	if got := p.Facts["elapsed"]; got != "1.42s" {
		t.Errorf("elapsed = %q, want 1.42s", got)
	}
	if got := p.Facts["modules"]; got != "215" {
		t.Errorf("modules = %q, want 215", got)
	}
	if p.Partial {
		t.Errorf("Partial = true, want false")
	}
	if p.Summary == "" {
		t.Errorf("Summary empty")
	}
}

func TestParseBunBuild_error(t *testing.T) {
	raw := []byte(`vite v5.4.0 building for production...
src/foo.ts:42:13: ERROR: Could not resolve "missing"
build failed
`)
	p := ParseBunBuild(raw)
	if got := p.Facts["errors"]; got == "0" {
		t.Errorf("errors = %q, want > 0", got)
	}
	if p.Summary == "" || p.Summary[:5] != "build" {
		t.Errorf("Summary = %q, want 'build …'", p.Summary)
	}
}

func TestParseGitStatus_short(t *testing.T) {
	raw := []byte(`## main...origin/main [ahead 1]
 M bridge/server.ts
 M frontend/src/foo.tsx
?? new-file.txt
`)
	p := ParseGitStatus(raw)
	if got := p.Facts["branch"]; got != "main" {
		t.Errorf("branch = %q, want main", got)
	}
	if got := p.Facts["unstaged"]; got != "2" {
		t.Errorf("unstaged = %q, want 2", got)
	}
	if got := p.Facts["untracked"]; got != "1" {
		t.Errorf("untracked = %q, want 1", got)
	}
	if got := p.Facts["ahead"]; got != "1" {
		t.Errorf("ahead = %q, want 1", got)
	}
}

func TestParseTailscale_on(t *testing.T) {
	raw := []byte(`# Funnel on:
#     - https://example.your-tailnet.ts.net (Funnel on)
#         |-- /  proxy http://127.0.0.1:8443
`)
	p := ParseTailscale(raw)
	if got := p.Facts["funnel"]; got != "on" {
		t.Errorf("funnel = %q, want on", got)
	}
	if got := p.Facts["target"]; got != "http://127.0.0.1:8443" {
		t.Errorf("target = %q", got)
	}
}

func TestParseTailscale_off(t *testing.T) {
	p := ParseTailscale([]byte("No Funnel configured.\n"))
	if got := p.Facts["funnel"]; got != "off" {
		t.Errorf("funnel = %q, want off", got)
	}
}

func TestParsePM2Status_table(t *testing.T) {
	raw := []byte(`┌─────┬────────────────┬─────────┬────────┬───────────┐
│ id  │ name           │ status  │ cpu    │ memory    │
├─────┼────────────────┼─────────┼────────┼───────────┤
│ 0   │ YHA-Bridge       │ default │ 0.0.1  │ fork      │ 12345  │ 1h     │ 0      │ online    │ 0%     │ 80.0mb    │
│ 1   │ YHA-Core       │ default │ 0.0.1  │ fork      │ 12346  │ 1h     │ 0      │ online    │ 0%     │ 80.0mb    │
│ 2   │ YHA-Rewind     │ default │ 0.0.1  │ fork      │ 12347  │ 1h     │ 0      │ stopped   │ 0%     │ 0b        │
└─────┴────────────────┴─────────┴────────┴───────────┘
`)
	p := ParsePM2Status(raw)
	if got := p.Facts["online"]; got != "2" {
		t.Errorf("online = %q, want 2", got)
	}
	if got := p.Facts["offline"]; got != "1" {
		t.Errorf("offline = %q, want 1", got)
	}
}

func TestFor_dispatch(t *testing.T) {
	if _, ok := For("build", []byte("✓ built in 1s\n")); !ok {
		t.Errorf("dispatch failed for build")
	}
	if _, ok := For("share", []byte("No Funnel configured.\n")); !ok {
		t.Errorf("dispatch failed for share")
	}
	if _, ok := For("status", []byte("│ 0 │ YHA-Bridge │ default │ 0.0.1 │ fork │ 1 │ 1h │ 0 │ online │ 0% │ 1mb │\n\n## main\n")); !ok {
		t.Errorf("dispatch failed for status")
	}
	if _, ok := For("unknown", nil); ok {
		t.Errorf("dispatch unexpectedly matched 'unknown'")
	}
}
