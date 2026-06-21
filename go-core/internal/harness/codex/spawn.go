package codex

import (
	"context"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
)

// SpawnOpts holds everything Streamer.Run needs to launch a codex
// subprocess. Most fields are forwarded straight to exec.Cmd; the
// only non-obvious one is ConfigDir, which sets CODEX_HOME +
// (optionally) a derived $HOME so multiple OAuth subscriptions can
// coexist on one box without one writing over the other's
// credentials file.
//
// Mirrors the env shape from bridge/providers/codex.ts:308-316.
type SpawnOpts struct {
	// Binary is the absolute path to the codex executable, or just
	// "codex" if it should be resolved via PATH. Empty defaults to
	// "codex".
	Binary string

	// CWD is the working directory passed to codex via --cd AND set
	// as the subprocess's working directory. The Node side uses
	// getSessionCwd(sessionId) for this; the Go route handler should
	// pass the request's CWD field through.
	CWD string

	// Model is forwarded as --model when non-empty. The Node side
	// strips a "codex/" prefix before this point; we do the same in
	// codex.go.
	Model string

	// ExecMode is either "" / "bypass" (default; --dangerously-bypass-approvals-and-sandbox)
	// or "full-auto" (--full-auto). Maps to config.defaults.codexExecMode
	// in the Node config; the route handler reads it and passes through.
	ExecMode string

	// OpenAIAPIKey is set into the subprocess env as OPENAI_API_KEY.
	// Empty disables API-mode auth — codex then falls back to its
	// OAuth flow (which requires ConfigDir to point at a real
	// .codex directory with valid credentials).
	OpenAIAPIKey string

	// Subscription is true for OpenAI-SUB* / OpenAI Subscription turns.
	// When set, any inherited OPENAI_API_KEY is stripped so OAuth
	// credentials in CODEX_HOME win (mirrors claude-binary subscription).
	Subscription bool

	// ConfigDir, if non-empty, becomes CODEX_HOME in the subprocess
	// env. When the directory's basename is ".codex" we also override
	// HOME to its parent — mirrors deriveIsolatedHome in
	// bridge/chat/helpers.ts. Without HOME-isolation, codex can
	// silently read /home/$user/.config/codex/auth.json from a
	// different subscription and the wrong account answers.
	ConfigDir string

	// Stdin is the bytes piped to codex's stdin (the prompt). codex
	// reads until EOF, so the caller closes the writer after the
	// final byte.
	Stdin string

	// Effort is the post-mapEffortToReasoning value, ready to be
	// passed as `-c reasoning_effort=<v>` (codex.ts:265 equivalent —
	// effort handling doesn't exist in the current TS provider but
	// the Codex CLI supports the flag, so Phase 6 adds it here per
	// the harness contract).
	Effort string

	// AllowedTools is the per-turn whitelist (already filtered to the
	// codex.* / web.* / functions.* / multi_tool_use.* names — call
	// filterCodexAllowedTools before populating). Each entry is added
	// as `--allowed-tool <name>` on the argv.
	AllowedTools []string

	// PresetText is the system-style preset content, passed via
	// `-c instructions=<text>` when non-empty. The harness escapes
	// the value before splicing it into argv.
	PresetText string
}

// spawnCmd builds the exec.Cmd. Separating this from the subprocess
// run lets unit tests assert on argv / env / cwd without actually
// launching codex. The returned cmd has Stdin/Stdout/Stderr unset —
// the loop wires those up via pipes.
//
// argv mirrors bridge/providers/codex.ts:263-267:
//
//	exec --json --skip-git-repo-check
//	    (--full-auto | --dangerously-bypass-approvals-and-sandbox)
//	    --cd <cwd>
//	    [--model <model>]
//
// Note: `exec` is codex's "one-shot" mode — no interactive prompt,
// reads from stdin, writes JSON-Lines events to stdout, terminates
// on turn-end. Phase 6b only supports this; the App Server protocol
// (bidirectional JSON-RPC) is a separate phase.
func spawnCmd(ctx context.Context, opts SpawnOpts) *exec.Cmd {
	bin := resolveCodexBinary(opts.Binary)

	args := buildArgs(opts)

	cmd := exec.CommandContext(ctx, bin, args...)
	if opts.CWD != "" {
		cmd.Dir = opts.CWD
	}
	cmd.Env = buildEnv(opts)
	return cmd
}

// buildEnv composes the subprocess env. Order of precedence:
//  1. Inherit os.Environ()
//  2. Overlay OPENAI_API_KEY when configured (env-injected creds beat
//     anything codex would find in ~/.config/codex/auth.json — same
//     behaviour as the Node side)
//  3. Overlay CODEX_HOME + (optionally) HOME when ConfigDir is set
//
// Sealed off from spawnCmd so a future App-Server port can reuse the
// same env-building rules without re-deriving them.
func buildEnv(opts SpawnOpts) []string {
	base := os.Environ()
	overrides := map[string]string{}

	if !opts.Subscription && opts.OpenAIAPIKey != "" {
		overrides["OPENAI_API_KEY"] = opts.OpenAIAPIKey
	}
	if opts.ConfigDir != "" {
		overrides["CODEX_HOME"] = opts.ConfigDir
		if isolated := deriveIsolatedHome(opts.ConfigDir); isolated != "" {
			overrides["HOME"] = isolated
		}
	}

	if len(overrides) == 0 {
		return base
	}

	// Walk base once, swapping in overrides; append any keys that
	// weren't already present.
	out := make([]string, 0, len(base)+len(overrides))
	seen := make(map[string]bool, len(overrides))
	for _, kv := range base {
		eq := strings.IndexByte(kv, '=')
		if eq < 0 {
			out = append(out, kv)
			continue
		}
		key := kv[:eq]
		if opts.Subscription && key == "OPENAI_API_KEY" {
			continue
		}
		if v, ok := overrides[key]; ok {
			out = append(out, key+"="+v)
			seen[key] = true
			continue
		}
		out = append(out, kv)
	}
	for k, v := range overrides {
		if !seen[k] {
			out = append(out, k+"="+v)
		}
	}
	return out
}

// deriveIsolatedHome mirrors deriveIsolatedHome in
// bridge/chat/helpers.ts (the ".codex" branch). When configDir ends
// in ".codex" we use its parent as HOME so the binary doesn't fall
// back to the shared user $HOME and accidentally read a different
// subscription's credentials. Other configDir shapes return ""
// (caller leaves HOME untouched).
func deriveIsolatedHome(configDir string) string {
	if configDir == "" {
		return ""
	}
	base := filepath.Base(configDir)
	if base == ".codex" {
		return filepath.Dir(configDir)
	}
	return configDir
}

// resolveCodexBinary picks the codex executable to spawn. When the
// caller passed an explicit path (config.defaults.codexBin or a per-
// instance override), use it verbatim. Otherwise:
//   - Linux/macOS: fall back to bare "codex" (PATH lookup) — matches
//     the historical behaviour and the bridge-side findCodexBin's
//     POSIX branch.
//   - Windows: scan the standard install locations because OpenAI's
//     Codex installer drops codex.exe under a hashed subdir inside
//     %LOCALAPPDATA%\OpenAI\Codex\bin that is NOT on PATH. Falling
//     through to bare "codex" there produces the
//     `exec: "codex": executable file not found in %PATH%` error.
func resolveCodexBinary(configured string) string {
	if configured != "" {
		return configured
	}
	if runtime.GOOS == "windows" {
		if found := findCodexBinaryWindows(); found != "" {
			return found
		}
	}
	return "codex"
}

// findCodexBinaryWindows mirrors the bridge-side findCodexBin scan for
// Windows install locations. Returns "" when no candidate exists; the
// caller falls back to bare "codex" (which exec.LookPath then tries
// against %PATH%, matching the old behaviour).
//
// Rootcandidates ordering — install dirs first (deterministic), then
// package-manager bin dirs. Each root is scanned both directly and
// one level deep (versioned/hashed subdirs, newest-first by lex sort)
// so the OpenAI installer's bin/<hash>/codex.exe layout is found.
func findCodexBinaryWindows() string {
	if v := os.Getenv("CODEX_BIN"); v != "" {
		return v
	}
	roots := []string{
		filepath.Join(os.Getenv("LOCALAPPDATA"), "OpenAI", "Codex", "bin"),
		filepath.Join(os.Getenv("APPDATA"), "npm"),
		filepath.Join(os.Getenv("USERPROFILE"), ".bun", "bin"),
		filepath.Join(os.Getenv("APPDATA"), "codex"),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "codex"),
	}
	exts := windowsPathExts()
	for _, root := range roots {
		if root == "" {
			continue
		}
		info, err := os.Stat(root)
		if err != nil || !info.IsDir() {
			continue
		}
		for _, ext := range exts {
			full := filepath.Join(root, "codex"+ext)
			if fi, err := os.Stat(full); err == nil && !fi.IsDir() {
				return full
			}
		}
		entries, err := os.ReadDir(root)
		if err != nil {
			continue
		}
		names := make([]string, 0, len(entries))
		for _, e := range entries {
			if e.IsDir() {
				names = append(names, e.Name())
			}
		}
		sort.Sort(sort.Reverse(sort.StringSlice(names)))
		for _, sub := range names {
			for _, ext := range exts {
				full := filepath.Join(root, sub, "codex"+ext)
				if fi, err := os.Stat(full); err == nil && !fi.IsDir() {
					return full
				}
			}
		}
	}
	return ""
}

func windowsPathExts() []string {
	raw := os.Getenv("PATHEXT")
	if raw == "" {
		return []string{".exe", ".cmd", ".bat", ".com"}
	}
	parts := strings.Split(raw, ";")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(strings.ToLower(p))
		if p == "" {
			continue
		}
		if !strings.HasPrefix(p, ".") {
			p = "." + p
		}
		out = append(out, p)
	}
	if len(out) == 0 {
		return []string{".exe", ".cmd", ".bat", ".com"}
	}
	return out
}

// writePromptThenClose streams prompt onto stdin then closes it.
// Codex's `exec` mode reads stdin until EOF and only THEN starts
// emitting; writing+closing in a goroutine lets the parser loop
// start reading stdout immediately.
//
// Returns the first error from Write or Close — typically a broken
// pipe when the subprocess dies before consuming the prompt.
func writePromptThenClose(stdin io.WriteCloser, prompt string) error {
	defer stdin.Close()
	if prompt == "" {
		return nil
	}
	_, err := io.WriteString(stdin, prompt)
	return err
}
