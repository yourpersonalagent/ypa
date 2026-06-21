package claudesdk

import (
	"path/filepath"
	"strings"
	"testing"
)

// TestBuildArgsAlwaysStreams — the SDK harness has no synchronous
// mode, so every BuildArgs call must include the stream-json flags
// plus the bypass-permissions / disallowedTools defaults.
func TestBuildArgsAlwaysStreams(t *testing.T) {
	bin, args := BuildArgs(SpawnOpts{})
	if bin != "claude" {
		t.Errorf("bin: want claude, got %q", bin)
	}
	mustContainSeq(t, args, "--print")
	mustContainSeq(t, args, "--verbose")
	mustContainSeq(t, args, "--output-format", "stream-json")
	mustContainSeq(t, args, "--input-format", "stream-json")
	mustContainFlag(t, args, "--dangerously-skip-permissions")
	mustContainSeq(t, args, "--disallowedTools", "AskUserQuestion")
}

// TestBuildArgsAllOpts — every knob landed; no --resume (SDK doesn't
// use it).
func TestBuildArgsAllOpts(t *testing.T) {
	_, args := BuildArgs(SpawnOpts{
		ClaudeBin:            "/usr/bin/claude",
		Model:                "claude-opus-4-7",
		Effort:               "high",
		Reasoning:            "enabled",
		Preset:               "be terse",
		SysMode:              "replace",
		Skills:               []Skill{{Name: "git", Content: "use porcelain"}},
		External:             true,
		ProxyURL:             "http://x/proxy/foo",
		MCPConfigPath:        "/tmp/mcp.json",
		WorkingDirConstraint: true,
		CWD:                  "/work",
	})
	mustContainSeq(t, args, "--model", "claude-opus-4-7")
	mustContainSeq(t, args, "--effort", "high")
	mustContainSeq(t, args, "--thinking-display", "summarized")
	mustContainSeq(t, args, "--system-prompt", "be terse")
	mustContainSeq(t, args, "--mcp-config", "/tmp/mcp.json")
	mustContainFlag(t, args, "--bare")
	// Should NOT contain --resume; SDK path doesn't carry session ids.
	for i, a := range args {
		if a == "--resume" {
			t.Errorf("unexpected --resume at index %d: %v", i, args)
		}
	}
	// Skill block must be in some --append-system-prompt entry.
	skillFound := false
	for i := 0; i < len(args)-1; i++ {
		if args[i] == "--append-system-prompt" && strings.Contains(args[i+1], "## Skill: git") {
			skillFound = true
			break
		}
	}
	if !skillFound {
		t.Errorf("skill block missing: %v", args)
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
		t.Errorf("WORKING DIRECTORY CONSTRAINT missing: %v", args)
	}
}

// TestBuildArgsAppendPresetWhenNotReplace — SysMode != "replace" routes
// the preset through --append-system-prompt.
func TestBuildArgsAppendPresetWhenNotReplace(t *testing.T) {
	_, args := BuildArgs(SpawnOpts{
		Preset:  "context note",
		SysMode: "append",
	})
	mustContainSeq(t, args, "--append-system-prompt", "context note")
	for _, a := range args {
		if a == "--system-prompt" {
			t.Errorf("unexpected --system-prompt with append mode: %v", args)
		}
	}
}

// TestBuildArgsReasoningEnablesThinkingWithoutEffort — Reasoning="enabled"
// alone (no Effort) still emits --thinking-display.
func TestBuildArgsReasoningEnablesThinking(t *testing.T) {
	_, args := BuildArgs(SpawnOpts{Reasoning: "enabled"})
	mustContainSeq(t, args, "--thinking-display", "summarized")
}

// TestBuildEnvProxyPathInjectsBridgeKey — External mode points
// ANTHROPIC_BASE_URL at the bridge shim and forces ANTHROPIC_API_KEY
// to BridgeKey (BRIDGE_INTERNAL_KEY mirror), overriding any inherited
// value. Mirrors agent.ts L99-101 behaviour.
func TestBuildEnvProxyPathInjectsBridgeKey(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "sk-inherited")
	env := BuildEnv(SpawnOpts{
		External:  true,
		ProxyURL:  "http://localhost:8442/proxy/gpt-4o",
		BridgeKey: "internal-xyz",
	})
	m := envToMap(env)
	if m["ANTHROPIC_BASE_URL"] != "http://localhost:8442/proxy/gpt-4o" {
		t.Errorf("ANTHROPIC_BASE_URL: %q", m["ANTHROPIC_BASE_URL"])
	}
	if m["ANTHROPIC_API_KEY"] != "internal-xyz" {
		t.Errorf("ANTHROPIC_API_KEY should be BridgeKey, got %q", m["ANTHROPIC_API_KEY"])
	}
}

// TestBuildEnvSubscriptionWipesAPIKey — Subscription mode strips
// ANTHROPIC_API_KEY so OAuth refresh wins (mirror of agent.ts L109).
func TestBuildEnvSubscriptionWipesAPIKey(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "sk-from-environ")
	env := BuildEnv(SpawnOpts{Subscription: true})
	m := envToMap(env)
	if v, ok := m["ANTHROPIC_API_KEY"]; ok {
		t.Errorf("subscription should wipe ANTHROPIC_API_KEY, got %q", v)
	}
}

// TestBuildEnvDirectAPI — non-External + non-Subscription with a
// direct API key wires ANTHROPIC_API_KEY through.
func TestBuildEnvDirectAPI(t *testing.T) {
	t.Setenv("ANTHROPIC_API_KEY", "sk-inherited")
	env := BuildEnv(SpawnOpts{AnthropicAPIKey: "sk-config"})
	m := envToMap(env)
	if m["ANTHROPIC_API_KEY"] != "sk-config" {
		t.Errorf("ANTHROPIC_API_KEY: want sk-config, got %q", m["ANTHROPIC_API_KEY"])
	}
}

// TestBuildEnvConfigDirIsolation — ConfigDir → CLAUDE_CONFIG_DIR +
// HOME flip + MCP_CONNECTION_NONBLOCKING=0.
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

// TestBuildEnvExtraEnvOverrides — ExtraEnv applies last so tests can
// pin specific values.
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

// TestBuildInitialStdin emits a single-line JSONL user envelope with
// the text content embedded.
func TestBuildInitialStdin(t *testing.T) {
	got, err := buildInitialStdin("hello world", nil)
	if err != nil {
		t.Fatalf("buildInitialStdin: %v", err)
	}
	s := string(got)
	if !strings.HasSuffix(s, "\n") {
		t.Errorf("expected trailing newline, got %q", s)
	}
	if !strings.Contains(s, `"type":"user"`) {
		t.Errorf("expected user envelope, got %q", s)
	}
	if !strings.Contains(s, `"text":"hello world"`) {
		t.Errorf("expected text payload, got %q", s)
	}
}

// TestBuildInitialStdinWithImages — image blocks appended after text.
func TestBuildInitialStdinWithImages(t *testing.T) {
	imgs := []map[string]any{{"type": "image", "source": map[string]any{"data": "..."}}}
	got, err := buildInitialStdin("look", imgs)
	if err != nil {
		t.Fatalf("buildInitialStdin: %v", err)
	}
	if !strings.Contains(string(got), `"type":"image"`) {
		t.Errorf("expected image block, got %q", string(got))
	}
}

// ── helpers ────────────────────────────────────────────────────────────────

func mustContainSeq(t *testing.T, haystack []string, needles ...string) {
	t.Helper()
	for i := 0; i <= len(haystack)-len(needles); i++ {
		ok := true
		for j, n := range needles {
			if haystack[i+j] != n {
				ok = false
				break
			}
		}
		if ok {
			return
		}
	}
	t.Errorf("missing sequence %v in %v", needles, haystack)
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
