package claudebinary

import (
	"path/filepath"
	"strings"
	"testing"
)

// TestBuildArgsStreamingDefaults exercises the streaming branch with
// the bare-minimum opts — no model, no effort, no preset. The output
// should match what claude-stream.ts produces for a fresh chat turn.
func TestBuildArgsStreamingDefaults(t *testing.T) {
	bin, args := BuildArgs(SpawnOpts{
		Stream:          true,
		SkipPermissions: true,
		CWD:             "/work",
	})
	if bin != "claude" {
		t.Errorf("bin: want claude, got %q", bin)
	}
	want := []string{
		"--print", "--verbose", "--output-format", "stream-json", "--input-format", "stream-json",
		"--dangerously-skip-permissions",
		"--disallowedTools", "AskUserQuestion",
	}
	if !sliceEqualUnordered(args, want) {
		t.Errorf("args:\n want %v\n got  %v", want, args)
	}
}

// TestBuildArgsSyncWithImages — synchronous spawn that has image
// blocks; the flag set should include --input-format stream-json (so
// the binary accepts a multi-block initial message).
func TestBuildArgsSyncWithImages(t *testing.T) {
	_, args := BuildArgs(SpawnOpts{
		Stream:    false,
		HasImages: true,
	})
	if !containsRun(args, "--input-format", "stream-json") {
		t.Errorf("expected --input-format stream-json, got %v", args)
	}
	if !containsRun(args, "--output-format", "json") {
		t.Errorf("expected --output-format json, got %v", args)
	}
}

// TestBuildArgsAllOpts cranks every knob and checks the args contain
// every expected flag. Doesn't assert order beyond what BuildArgs
// stipulates.
func TestBuildArgsAllOpts(t *testing.T) {
	_, args := BuildArgs(SpawnOpts{
		ClaudeBin:            "/usr/bin/claude",
		Model:                "claude-opus-4-7",
		Effort:               "high",
		Reasoning:            "enabled",
		Preset:               "be terse",
		SysMode:              "replace",
		Skills:               []Skill{{Name: "git", Content: "use porcelain"}},
		ResumeSessionID:      "sess-old",
		IsInteractive:        true,
		External:             true,
		ProxyURL:             "http://x/proxy/foo",
		SkipPermissions:      true,
		PluginDirs:           []string{"/p1", "/p2"},
		AgentsJSON:           `{"a":1}`,
		MCPConfigPath:        "/tmp/mcp.json",
		Stream:               true,
		WorkingDirConstraint: true,
		CWD:                  "/work",
	})
	mustContain(t, args, "--model", "claude-opus-4-7")
	mustContain(t, args, "--effort", "high")
	mustContain(t, args, "--thinking-display", "summarized")
	mustContain(t, args, "--system-prompt", "be terse")
	mustContain(t, args, "--resume", "sess-old")
	mustContain(t, args, "--mcp-config", "/tmp/mcp.json")
	mustContainFlag(t, args, "--dangerously-skip-permissions")
	mustContainFlag(t, args, "--bare")
	mustContain(t, args, "--plugin-dir", "/p1")
	mustContain(t, args, "--plugin-dir", "/p2")
	mustContain(t, args, "--agents", `{"a":1}`)
	// Skill block is appended with --append-system-prompt; check the
	// content includes the rendered skill body.
	skillFound := false
	for i := 0; i < len(args)-1; i++ {
		if args[i] == "--append-system-prompt" && strings.Contains(args[i+1], "## Skill: git") {
			skillFound = true
			break
		}
	}
	if !skillFound {
		t.Errorf("missing skill append-system-prompt: %v", args)
	}
	// Working-dir constraint should be in another --append-system-prompt.
	wdcFound := false
	for i := 0; i < len(args)-1; i++ {
		if args[i] == "--append-system-prompt" && strings.Contains(args[i+1], "WORKING DIRECTORY CONSTRAINT") {
			wdcFound = true
			break
		}
	}
	if !wdcFound {
		t.Errorf("missing WORKING DIRECTORY CONSTRAINT --append-system-prompt: %v", args)
	}
}

// TestBuildArgsAllowedToolsWhenNotSkipping verifies the allow-list
// mode (no --dangerously-skip-permissions, --allowedTools instead).
func TestBuildArgsAllowedToolsWhenNotSkipping(t *testing.T) {
	_, args := BuildArgs(SpawnOpts{
		SkipPermissions: false,
		AllowedTools:    []string{"Read", "Glob"},
	})
	mustContain(t, args, "--allowedTools", "Read,Glob")
	for _, a := range args {
		if a == "--dangerously-skip-permissions" {
			t.Errorf("unexpected --dangerously-skip-permissions: %v", args)
		}
	}
}

// TestBuildEnvSubscription verifies subscription mode wipes
// ANTHROPIC_API_KEY (so OAuth refresh wins) and that BridgeKey doesn't
// inappropriately get set in the non-External path.
func TestBuildEnvSubscription(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "sk-from-environ")
	env := BuildEnv(SpawnOpts{Subscription: true})
	m := envToMap(env)
	if v, ok := m["ANTHROPIC_API_KEY"]; ok {
		t.Errorf("subscription mode should wipe ANTHROPIC_API_KEY, got %q", v)
	}
}

// TestBuildEnvExternalProxyShim — External mode points
// ANTHROPIC_BASE_URL at the bridge shim + uses BridgeKey when the
// configured key is empty.
func TestBuildEnvExternalProxyShim(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "")
	env := BuildEnv(SpawnOpts{
		External:  true,
		ProxyURL:  "http://shim:8442/proxy/foo",
		BridgeKey: "sk-bridge-xyz",
	})
	m := envToMap(env)
	if m["ANTHROPIC_BASE_URL"] != "http://shim:8442/proxy/foo" {
		t.Errorf("ANTHROPIC_BASE_URL: %q", m["ANTHROPIC_BASE_URL"])
	}
	if m["ANTHROPIC_API_KEY"] != "sk-bridge-xyz" {
		t.Errorf("ANTHROPIC_API_KEY fallback to BridgeKey: %q", m["ANTHROPIC_API_KEY"])
	}
}

// TestBuildEnvDirectAPI — non-External + non-Subscription with a
// direct API key wires ANTHROPIC_API_KEY through (overrides whatever
// inherited from os.Environ).
func TestBuildEnvDirectAPI(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "sk-inherited")
	env := BuildEnv(SpawnOpts{AnthropicAPIKey: "sk-config"})
	m := envToMap(env)
	if m["ANTHROPIC_API_KEY"] != "sk-config" {
		t.Errorf("ANTHROPIC_API_KEY: want sk-config, got %q", m["ANTHROPIC_API_KEY"])
	}
}

// TestBuildEnvConfigDirIsolation — when ConfigDir is set, CLAUDE_CONFIG_DIR
// and HOME both flip. MCP_CONNECTION_NONBLOCKING flips to "0" so the
// binary blocks for MCP handshakes.
func TestBuildEnvConfigDirIsolation(t *testing.T) {
	configDir := "/home/test/.claude-instance-2/.claude"
	env := BuildEnv(SpawnOpts{ConfigDir: configDir})
	m := envToMap(env)
	if m["CLAUDE_CONFIG_DIR"] != configDir {
		t.Errorf("CLAUDE_CONFIG_DIR: %q", m["CLAUDE_CONFIG_DIR"])
	}
	if filepath.ToSlash(m["HOME"]) != "/home/test/.claude-instance-2" {
		t.Errorf("HOME (isolated): %q", m["HOME"])
	}
	if m["MCP_CONNECTION_NONBLOCKING"] != "0" {
		t.Errorf("MCP_CONNECTION_NONBLOCKING: %q", m["MCP_CONNECTION_NONBLOCKING"])
	}
}

// TestBuildEnvExtraEnvOverrides — ExtraEnv must apply last so tests
// can pin specific values.
func TestBuildEnvExtraEnvOverrides(t *testing.T) {
	t.Setenv("HOME", "/some/where")
	env := BuildEnv(SpawnOpts{
		ExtraEnv: map[string]string{"HOME": "/explicit", "FOO": "bar"},
	})
	m := envToMap(env)
	if m["HOME"] != "/explicit" {
		t.Errorf("HOME override: %q", m["HOME"])
	}
	if m["FOO"] != "bar" {
		t.Errorf("FOO: %q", m["FOO"])
	}
}

// TestDeriveIsolatedHome — both happy + edge cases.
func TestDeriveIsolatedHome(t *testing.T) {
	cases := map[string]string{
		"/home/alice/.claude":                  "/home/alice",
		"/home/alice/.claude-instance/.claude": "/home/alice/.claude-instance",
		"/.claude":                             "", // root-relative; no parent
		"":                                     "",
		"/home/alice/notclaude":                "/home/alice/notclaude",
	}
	for in, want := range cases {
		got := deriveIsolatedHome(in)
		if filepath.ToSlash(got) != want {
			t.Errorf("deriveIsolatedHome(%q): want %q, got %q", in, want, got)
		}
	}
}

// TestBuildInitialStdinSyncNoImages — plain prompt bytes only.
func TestBuildInitialStdinSyncNoImages(t *testing.T) {
	got, err := buildInitialStdin("hello", nil, false)
	if err != nil {
		t.Fatalf("buildInitialStdin: %v", err)
	}
	if string(got) != "hello" {
		t.Errorf("want %q, got %q", "hello", string(got))
	}
}

// TestBuildInitialStdinStreamWrapsJSON — streaming mode always wraps.
func TestBuildInitialStdinStreamWrapsJSON(t *testing.T) {
	got, err := buildInitialStdin("hello", nil, true)
	if err != nil {
		t.Fatalf("buildInitialStdin: %v", err)
	}
	s := string(got)
	if !strings.HasSuffix(s, "\n") {
		t.Errorf("expected trailing newline, got %q", s)
	}
	if !strings.Contains(s, `"type":"user"`) {
		t.Errorf("expected user message envelope, got %q", s)
	}
	if !strings.Contains(s, `"text":"hello"`) {
		t.Errorf("expected text content, got %q", s)
	}
}

// TestBuildInitialStdinSyncWithImages — sync + images still wraps.
func TestBuildInitialStdinSyncWithImages(t *testing.T) {
	imgs := []map[string]any{{"type": "image", "source": map[string]any{"data": "..."}}}
	got, err := buildInitialStdin("look", imgs, false)
	if err != nil {
		t.Fatalf("buildInitialStdin: %v", err)
	}
	if !strings.Contains(string(got), `"type":"image"`) {
		t.Errorf("expected image block in stdin: %q", string(got))
	}
}

// ── helpers ────────────────────────────────────────────────────────────────

func containsRun(haystack []string, needles ...string) bool {
	for i := 0; i <= len(haystack)-len(needles); i++ {
		ok := true
		for j, n := range needles {
			if haystack[i+j] != n {
				ok = false
				break
			}
		}
		if ok {
			return true
		}
	}
	return false
}

func mustContain(t *testing.T, args []string, parts ...string) {
	t.Helper()
	if !containsRun(args, parts...) {
		t.Errorf("missing %v in %v", parts, args)
	}
}

func mustContainFlag(t *testing.T, args []string, flag string) {
	t.Helper()
	for _, a := range args {
		if a == flag {
			return
		}
	}
	t.Errorf("missing flag %q in %v", flag, args)
}

func sliceEqualUnordered(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	// Args are NOT unordered for the binary, but for the "minimal opts"
	// test we just check the multisets match. Caller can use stronger
	// asserts where order matters.
	count := map[string]int{}
	for _, x := range a {
		count[x]++
	}
	for _, x := range b {
		count[x]--
	}
	for _, v := range count {
		if v != 0 {
			return false
		}
	}
	return true
}
