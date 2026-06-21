// spawn.go — subprocess builder for the claude-sdk harness.
//
// Mirrors bridge/chat/agent.ts (runClaudeViaSdk / streamClaudeViaSdk)
// at the spawn level. The Node SDK wraps the `claude` binary and calls
// it via `query({...})`; under the hood it spawns the same `claude`
// executable with stream-json input/output. The Go port skips the SDK
// JS layer and goes straight to the binary with the equivalent CLI
// flags, plus a transient --mcp-config so the spawned agent picks up
// YHA's MCP pool the same way the SDK does.
//
// Key differences from the claudebinary harness:
//
//   - No --resume: the Node SDK path explicitly doesn't use binary
//     session-resume (it injects priorHistory into the prompt instead).
//   - bypassPermissions is implied: --dangerously-skip-permissions
//     is always added (the SDK passes
//     allowDangerouslySkipPermissions: true).
//   - --disallowedTools AskUserQuestion is always added (mirror of
//     the SDK's disallowedTools: ['AskUserQuestion']).
//   - --mcp-config <transient json>: when YHA_BRIDGE_STUB_PATH is set,
//     we materialise the MCP config on disk and point the binary at it.
//
// The args / env semantics MUST stay aligned with agent.ts until the
// Phase 6g cutover agent flips defaults. Anything intentionally
// dropped is called out in a comment.
package claudesdk

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strings"

	"github.com/yha/core/internal/stream"
)

// SpawnOpts is the per-call knob set the harness layer hands down.
// Most fields mirror claudebinary.SpawnOpts; differences are flagged
// in comments below.
type SpawnOpts struct {
	// ClaudeBin is the path to the `claude` CLI. Empty falls back to
	// the literal "claude" (PATH lookup). Set by the daemon from
	// config.defaults.claudeBin.
	ClaudeBin string

	// ConfigDir overrides CLAUDE_CONFIG_DIR — used by claude-instances
	// to isolate state. Empty = use the default ~/.claude.
	ConfigDir string

	// CWD is the working directory the binary runs in. Required —
	// missing CWD yields an empty Cmd.Dir and the binary inherits the
	// daemon's directory which is wrong for any tool-call.
	CWD string

	// Model — if non-empty, --model <Model> is appended. The Node SDK
	// always forwards a model id; we follow suit.
	Model string

	// Effort is the --effort knob. Validated against
	// claudebinary.EffortLevels (we don't re-export here; the caller
	// already validates against the canonical set).
	Effort string

	// Reasoning, when set to "enabled" or any effort value, turns on
	// --thinking-display summarized so the binary surfaces plaintext
	// thinking on subscription/OAuth tier. Mirror of claude-stream.ts.
	Reasoning string

	// Preset + SysMode control whether the system prompt is replace-
	// ("--system-prompt") or append-mode ("--append-system-prompt").
	// SysMode "replace" with a non-Anthropic model also triggers --bare.
	Preset  string
	SysMode string // "replace" | "append" | ""

	// Skills — each entry rendered as a "## Skill: <name>\n\n<content>"
	// block and joined with "\n\n---\n\n" then appended via
	// --append-system-prompt. Empty slice = no-op.
	Skills []Skill

	// IsInteractive determines the nice level: interactive (foreground
	// chat) runs at nice 0, background (Task agents etc.) at nice 10.
	// Mirror of getNiceness() in claude-run.ts.
	IsInteractive bool

	// External — when true, the binary is being driven against a
	// non-Anthropic model via the bridge's /proxy/* shim. The shim URL
	// is plumbed via ANTHROPIC_BASE_URL + ANTHROPIC_API_KEY.
	External bool

	// ProxyURL is the bridge's /proxy/<encodedModel> URL when External.
	// e.g. "http://localhost:8442/proxy/gpt-4o". Required when External.
	ProxyURL string

	// AnthropicAPIKey, when non-empty AND non-subscription, sets
	// ANTHROPIC_API_KEY in the child's env. Subscription routes leave
	// it unset so OAuth wins.
	AnthropicAPIKey string

	// BridgeKey is the shared YHA_BRIDGE_KEY fallback used as
	// ANTHROPIC_API_KEY when External and no direct key is configured.
	// In the SDK path this is the BRIDGE_INTERNAL_KEY mirror.
	BridgeKey string

	// Subscription flips the env-cleanup branch — when true, any
	// ANTHROPIC_API_KEY inherited from os.Environ is wiped so the
	// binary's OAuth refresh path stays in charge.
	Subscription bool

	// MCPConfigPath, when non-empty, is appended as --mcp-config <path>
	// so the binary loads MCP servers from that file. The harness sets
	// this from the materialised yha-bridge stub config.
	MCPConfigPath string

	// WorkingDirConstraint, when true, appends the boilerplate
	// "WORKING DIRECTORY CONSTRAINT" --append-system-prompt block.
	WorkingDirConstraint bool

	// ExtraEnv overrides / adds env vars (tests inject HOME=/tmp etc.).
	// Merged on top of the inherited environment.
	ExtraEnv map[string]string
}

// Skill is one ad-hoc skill block rendered into the system prompt.
// Mirrors the FE's SkillSet entries. Kept as a local type so callers
// don't depend on claudebinary.
type Skill struct {
	Name    string
	Content string
}

// BuildArgs assembles the binary's CLI arguments per the SpawnOpts.
// Pure — no env or filesystem access. The leading arg is the binary
// path; the rest mirror the order agent.ts produces (so a side-by-side
// diff stays readable).
//
// Returns (binPath, args). Always emits the stream-json format pair so
// the SDK-style event parser can consume the output.
func BuildArgs(opts SpawnOpts) (binPath string, args []string) {
	binPath = opts.ClaudeBin
	if binPath == "" {
		binPath = "claude"
	}
	args = make([]string, 0, 32)
	// SDK harness is always streaming — there's no synchronous variant.
	args = append(args,
		"--print",
		"--verbose",
		"--output-format", "stream-json",
		"--input-format", "stream-json",
	)
	if opts.Model != "" {
		args = append(args, "--model", opts.Model)
	}
	if _, ok := validEffortLevels[opts.Effort]; ok && opts.Effort != "" {
		args = append(args, "--effort", opts.Effort)
		// Effort always implies thinking-display in the SDK path
		// (mirror of agent.ts's effort: opts.effort wiring + the
		// downstream binary's auto-enable).
		args = append(args, "--thinking-display", "summarized")
	} else if opts.Reasoning == "enabled" {
		args = append(args, "--thinking-display", "summarized")
	}
	if opts.Preset != "" {
		if opts.SysMode == "replace" {
			args = append(args, "--system-prompt", opts.Preset)
		} else {
			args = append(args, "--append-system-prompt", opts.Preset)
		}
	}
	if len(opts.Skills) > 0 {
		blocks := make([]stream.SkillBlock, len(opts.Skills))
		for i, s := range opts.Skills {
			blocks[i] = stream.SkillBlock{Name: s.Name, Content: s.Content}
		}
		args = append(args, "--append-system-prompt", stream.BuildSkillsBlock(blocks))
	}
	if opts.MCPConfigPath != "" {
		args = append(args, "--mcp-config", opts.MCPConfigPath)
	}
	// SDK path always bypasses permissions (mirror of
	// allowDangerouslySkipPermissions: true).
	args = append(args, "--dangerously-skip-permissions")
	// Same AskUserQuestion replacement as claudebinary — the built-in
	// has no IPC path back; we route through mcp__MCP-Tools__bridge__AskUser.
	args = append(args, "--disallowedTools", "AskUserQuestion")
	if opts.External && opts.SysMode == "replace" {
		args = append(args, "--bare")
	}
	if opts.WorkingDirConstraint && opts.CWD != "" {
		args = append(args, "--append-system-prompt", stream.BuildCWDConstraint(opts.CWD))
	}
	return binPath, args
}

// validEffortLevels is the local mirror of claudebinary.EffortLevels.
// We duplicate the set (5 strings) so this package doesn't take a
// build-level dependency on claudebinary just for a constant.
var validEffortLevels = map[string]struct{}{
	"low": {}, "medium": {}, "high": {}, "xhigh": {}, "max": {},
}

// BuildEnv assembles the child process env per agent.ts. Starts from
// os.Environ, overrides HOME / CLAUDE_CONFIG_DIR / ANTHROPIC_BASE_URL /
// ANTHROPIC_API_KEY / MCP_CONNECTION_NONBLOCKING as the opts dictate,
// then folds in opts.ExtraEnv.
//
// The function returns an os/exec-shaped slice of "KEY=VALUE" strings.
func BuildEnv(opts SpawnOpts) []string {
	env := envToMap(os.Environ())

	// HOME hardening — /root → user homedir so libsecret / fallback
	// files don't end up in /root/.claude. Matches the claudebinary
	// behaviour and the TS spawn site's expectation.
	if h, ok := env["HOME"]; !ok || h == "" || h == "/root" {
		if u, err := os.UserHomeDir(); err == nil {
			env["HOME"] = u
		}
	}

	// ConfigDir → CLAUDE_CONFIG_DIR + matching HOME override (per
	// agent.ts L91-97). Without this, multiple subscription instances
	// stomp on each other's credential files / libsecret entries.
	if opts.ConfigDir != "" {
		env["CLAUDE_CONFIG_DIR"] = opts.ConfigDir
		if h := deriveIsolatedHome(opts.ConfigDir); h != "" {
			env["HOME"] = h
		}
		// SDK path also wants blocking MCP startup so the agent waits
		// for handshakes before the first turn. Mirror of the
		// claudebinary harness (which sets this for the bare-binary
		// path) — the SDK does the same internally.
		env["MCP_CONNECTION_NONBLOCKING"] = "0"
	}

	// API key / base URL routing — mirror of agent.ts L99-L111.
	if opts.External {
		if opts.ProxyURL != "" {
			env["ANTHROPIC_BASE_URL"] = opts.ProxyURL
		}
		// External flows must always have *some* ANTHROPIC_API_KEY so
		// the SDK doesn't 401 on the shim. Prefer the configured
		// Anthropic key (non-subscription); fall back to BridgeKey.
		if !opts.Subscription && opts.AnthropicAPIKey != "" {
			env["ANTHROPIC_API_KEY"] = opts.AnthropicAPIKey
		} else if opts.BridgeKey != "" {
			// SDK path always sets ANTHROPIC_API_KEY = BRIDGE_INTERNAL_KEY
			// when proxy-routed (agent.ts L100-101), overriding any
			// inherited value. Mirror that.
			env["ANTHROPIC_API_KEY"] = opts.BridgeKey
		}
	} else if opts.Subscription {
		// Subscription path: wipe inherited ANTHROPIC_API_KEY so OAuth
		// refresh stays in charge. agent.ts L109 does `delete env.X`.
		delete(env, "ANTHROPIC_API_KEY")
	} else if opts.AnthropicAPIKey != "" {
		env["ANTHROPIC_API_KEY"] = opts.AnthropicAPIKey
	}

	for k, v := range opts.ExtraEnv {
		env[k] = v
	}

	return mapToEnv(env)
}

// envToMap turns os.Environ()'s ["KEY=VALUE", …] into a map. First "="
// splits; everything after is preserved (env values may contain "=").
func envToMap(envSlice []string) map[string]string {
	m := make(map[string]string, len(envSlice))
	for _, kv := range envSlice {
		i := strings.IndexByte(kv, '=')
		if i < 0 {
			m[kv] = ""
			continue
		}
		m[kv[:i]] = kv[i+1:]
	}
	return m
}

// mapToEnv goes the other way. Order isn't important to the child,
// but tests sometimes want deterministic output; the caller can sort
// the returned slice if needed.
func mapToEnv(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k, v := range m {
		out = append(out, k+"="+v)
	}
	return out
}

// SetNiceness sets the child process priority. Linux/macOS use
// setpriority(2) via setNicenessNative; Windows is a no-op (we don't
// wire the Windows priority class API). Best-effort — error is
// returned but the spawn loop treats it as non-fatal.
func SetNiceness(pid int, isInteractive bool) error {
	nice := 10
	if isInteractive {
		nice = 0
	}
	return setNicenessNative(pid, nice)
}

// BuildCmd assembles an *exec.Cmd with binary path, args, env, cwd
// applied. Niceness is NOT applied here — the caller calls SetNiceness
// after Start so the PID exists. The caller wires Stdin/Stdout/Stderr.
func BuildCmd(ctx context.Context, opts SpawnOpts) *exec.Cmd {
	binPath, args := BuildArgs(opts)
	cmd := exec.CommandContext(ctx, binPath, args...)
	cmd.Env = BuildEnv(opts)
	if opts.CWD != "" {
		cmd.Dir = opts.CWD
	}
	return cmd
}

// ProcessSpawnFn is the test seam — a function that, given the spawn
// opts + initial stdin payload, returns the stdout/stderr readers, a
// Kill func, a Wait func, and the PID (for nice-level adjustment).
type ProcessSpawnFn func(ctx context.Context, opts SpawnOpts, initialStdin []byte) (ProcessHandles, error)

// ProcessHandles bundles what a ProcessSpawnFn returns. Same shape as
// claudebinary.ProcessHandles, kept local so the SDK harness's seam
// stays under our control.
type ProcessHandles struct {
	Stdout io.Reader
	Stderr io.Reader
	Stdin  io.WriteCloser
	Kill   func() error
	Wait   func() error
	PID    int
}

// spawnProcess is the default ProcessSpawnFn — it runs the real
// `claude` binary via os/exec, wires stdin/stdout/stderr pipes, and
// returns handles the streamer can drive.
//
// Lifecycle:
//   - Pipes are owned by the returned handles. Caller closes Stdin
//     when the prompt is fully written. Stdout/Stderr close on exit.
//   - Kill is idempotent; safe to call multiple times.
//   - Wait blocks for the process; returns its exit error (nil on 0).
//   - PID is filled iff Start succeeded.
func spawnProcess(ctx context.Context, opts SpawnOpts, initialStdin []byte) (ProcessHandles, error) {
	cmd := BuildCmd(ctx, opts)
	stdoutR, err := cmd.StdoutPipe()
	if err != nil {
		return ProcessHandles{}, fmt.Errorf("stdout pipe: %w", err)
	}
	stderrR, err := cmd.StderrPipe()
	if err != nil {
		return ProcessHandles{}, fmt.Errorf("stderr pipe: %w", err)
	}
	stdinW, err := cmd.StdinPipe()
	if err != nil {
		return ProcessHandles{}, fmt.Errorf("stdin pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		return ProcessHandles{}, fmt.Errorf("start: %w", err)
	}

	// Write the initial stdin payload eagerly. The SDK harness writes
	// exactly one JSONL user message and closes stdin (no /btw
	// mid-turn writes — the Node SDK's query() iterator doesn't expose
	// stdin appends either).
	go func() {
		if len(initialStdin) > 0 {
			if _, werr := stdinW.Write(initialStdin); werr != nil {
				return
			}
		}
		_ = stdinW.Close()
	}()

	pid := cmd.Process.Pid
	killed := make(chan struct{})
	killFn := func() error {
		select {
		case <-killed:
			return nil
		default:
		}
		close(killed)
		if cmd.Process != nil {
			_ = sendTermSignal(cmd.Process)
		}
		return nil
	}
	waitFn := func() error {
		_ = stdinW.Close()
		return cmd.Wait()
	}

	return ProcessHandles{
		Stdout: stdoutR,
		Stderr: stderrR,
		Stdin:  stdinW,
		Kill:   killFn,
		Wait:   waitFn,
		PID:    pid,
	}, nil
}

// buildInitialStdin renders the first user message in the streaming
// JSONL shape the binary expects:
//
//	{type:"user", message:{role:"user", content:[{type:"text", text:...}]}}
//
// imageBlocks are appended after the text block. The SDK harness
// always streams (no synchronous path), so we don't need the plain-
// text branch the claudebinary buildInitialStdin keeps for sync mode.
func buildInitialStdin(prompt string, imageBlocks []map[string]any) ([]byte, error) {
	content := make([]map[string]any, 0, 1+len(imageBlocks))
	if strings.TrimSpace(prompt) != "" {
		content = append(content, map[string]any{
			"type": "text",
			"text": prompt,
		})
	}
	for _, img := range imageBlocks {
		content = append(content, img)
	}
	msg := map[string]any{
		"type": "user",
		"message": map[string]any{
			"role":    "user",
			"content": content,
		},
	}
	enc, err := json.Marshal(msg)
	if err != nil {
		return nil, fmt.Errorf("claudesdk.buildInitialStdin: marshal: %w", err)
	}
	return append(enc, '\n'), nil
}
