package codex

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

// spawnCmd is the env+argv shaper. We don't run the subprocess in
// these tests — we just assert on the exec.Cmd shape so future env
// regressions (e.g. accidentally dropping OPENAI_API_KEY) get
// caught by `go test`.

func TestSpawnCmdArgs(t *testing.T) {
	cmd := spawnCmd(context.Background(), SpawnOpts{
		Binary:   "/path/codex",
		CWD:      "/work",
		Model:    "gpt-5.3-codex",
		ExecMode: "full-auto",
	})

	got := strings.Join(cmd.Args, " ")
	wantContains := []string{
		"/path/codex",
		"exec", "--json", "--skip-git-repo-check",
		"--full-auto",
		"--cd", "/work",
		"--model", "gpt-5.3-codex",
	}
	for _, w := range wantContains {
		if !strings.Contains(got, w) {
			t.Errorf("expected %q in args, got %q", w, got)
		}
	}
	if strings.Contains(got, "--dangerously-bypass-approvals-and-sandbox") {
		t.Errorf("full-auto should not include bypass flag, got %q", got)
	}
	if cmd.Dir != "/work" {
		t.Errorf("expected Dir=/work, got %q", cmd.Dir)
	}
}

func TestSpawnCmdDefaultBypass(t *testing.T) {
	cmd := spawnCmd(context.Background(), SpawnOpts{Binary: "codex"})
	got := strings.Join(cmd.Args, " ")
	if !strings.Contains(got, "--dangerously-bypass-approvals-and-sandbox") {
		t.Errorf("default exec mode should bypass approvals, got %q", got)
	}
	if strings.Contains(got, "--full-auto") {
		t.Errorf("default should not be full-auto, got %q", got)
	}
}

func TestSpawnCmdNoModelOmitsFlag(t *testing.T) {
	cmd := spawnCmd(context.Background(), SpawnOpts{Binary: "codex"})
	for _, a := range cmd.Args {
		if a == "--model" {
			t.Errorf("expected no --model when not specified, got %v", cmd.Args)
		}
	}
}

func TestBuildEnvSetsAPIKey(t *testing.T) {
	env := buildEnv(SpawnOpts{OpenAIAPIKey: "sk-test"})
	if !containsEnv(env, "OPENAI_API_KEY=sk-test") {
		t.Errorf("expected OPENAI_API_KEY=sk-test in env, got: %v", filterFor(env, "OPENAI_"))
	}
}

func TestBuildEnvSubscriptionStripsAPIKey(t *testing.T) {
	t.Setenv("OPENAI_API_KEY", "sk-leaked")
	env := buildEnv(SpawnOpts{
		OpenAIAPIKey: "sk-config",
		Subscription: true,
		ConfigDir:    "/some/account/.codex",
	})
	if containsEnv(env, "OPENAI_API_KEY=") {
		t.Errorf("subscription must not inject or inherit OPENAI_API_KEY, got: %v", filterFor(env, "OPENAI_"))
	}
}

func TestBuildEnvSetsCodexHomeAndIsolatedHome(t *testing.T) {
	env := buildEnv(SpawnOpts{ConfigDir: "/some/account/.codex"})
	if !containsEnv(env, "CODEX_HOME=/some/account/.codex") {
		t.Errorf("expected CODEX_HOME, got: %v", filterFor(env, "CODEX_"))
	}
	if !containsEnv(env, "HOME="+filepath.FromSlash("/some/account")) {
		t.Errorf("expected derived HOME=/some/account, got: %v", filterFor(env, "HOME="))
	}
}

func TestBuildEnvNonStandardConfigDirKeepsItAsHome(t *testing.T) {
	// When configDir basename is NOT ".codex" we use the dir itself
	// as HOME (mirrors deriveIsolatedHome's else branch).
	env := buildEnv(SpawnOpts{ConfigDir: "/some/account/custom"})
	if !containsEnv(env, "HOME=/some/account/custom") {
		t.Errorf("expected HOME=configDir when basename != .codex, got: %v", filterFor(env, "HOME="))
	}
}

func TestBuildEnvNoOverridesPassesBaseThrough(t *testing.T) {
	env := buildEnv(SpawnOpts{})
	if containsEnv(env, "CODEX_HOME=") {
		t.Errorf("no ConfigDir should leave CODEX_HOME unset; got: %v", filterFor(env, "CODEX_HOME"))
	}
}

func TestDeriveIsolatedHome(t *testing.T) {
	for in, want := range map[string]string{
		"":                      "",
		"/a/b/.codex":           "/a/b",
		"/a/b/custom":           "/a/b/custom",
		"/home/x/.config/codex": "/home/x/.config/codex", // not ".codex"
	} {
		if got := deriveIsolatedHome(in); filepath.ToSlash(got) != want {
			t.Errorf("deriveIsolatedHome(%q)=%q want %q", in, got, want)
		}
	}
}

// containsEnv reports whether kv appears verbatim in env.
func containsEnv(env []string, kv string) bool {
	for _, e := range env {
		if e == kv {
			return true
		}
	}
	return false
}

// filterFor returns env entries that start with prefix — for
// diagnostic output when an assertion fails.
func filterFor(env []string, prefix string) []string {
	var out []string
	for _, e := range env {
		if strings.HasPrefix(e, prefix) {
			out = append(out, e)
		}
	}
	return out
}
