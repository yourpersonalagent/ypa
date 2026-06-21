package mcp

import "testing"

func TestFirstPartyMCP(t *testing.T) {
	cases := []struct {
		name string
		args []string
		want bool
	}{
		{"relative shipped script", []string{"./mcp/bash-console-server.js"}, true},
		{"bare mcp-rooted path", []string{"mcp/important-server.js"}, true},
		{"mjs shipped script", []string{"./mcp/foo.mjs"}, true},
		{"non-mcp relative", []string{"./tools/foo.js"}, false},
		{"absolute path that merely ends in /mcp", []string{"/tmp/attacker/mcp/evil.js"}, false},
		{"relative escape into a /mcp dir", []string{"../../tmp/mcp/evil.js"}, false},
		{"nested non-root mcp dir", []string{"./vendor/mcp/evil.js"}, false},
		{"npx third-party", []string{"-y", "some-mcp-package"}, false},
		{"no script arg", []string{"docker", "run", "img"}, false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := firstPartyMCP(tc.args); got != tc.want {
				t.Fatalf("firstPartyMCP(%v) = %v, want %v", tc.args, got, tc.want)
			}
		})
	}
}

func TestFilterBridgeSecrets(t *testing.T) {
	in := []string{"PATH=/usr/bin", "YHA_BRIDGE_KEY=secret", "BRIDGE_INTERNAL_KEY=secret", "FOO=bar"}
	out := filterBridgeSecrets(in)
	for _, kv := range out {
		if kv == "YHA_BRIDGE_KEY=secret" || kv == "BRIDGE_INTERNAL_KEY=secret" {
			t.Fatalf("bridge secret leaked through filter: %q", kv)
		}
	}
	if len(out) != 2 {
		t.Fatalf("expected 2 surviving vars, got %d: %v", len(out), out)
	}
}
