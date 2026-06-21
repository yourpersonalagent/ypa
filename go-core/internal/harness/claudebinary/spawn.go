// Subprocess spawn helpers for the claude binary harness.
//
// This file owns the side-channel concerns of running the upstream
// `claude` CLI: env-var assembly, argument construction, nice-level
// hint, and the per-platform setpriority dance. The protocol-level
// parsing of the binary's stdout lives in events.go; the orchestration
// (lifecycle, fan-out, finalize) lives in claudebinary.go and run.go.
//
// Mirrors bridge/providers/claude-{run,stream}.ts at the spawn level —
// args/env semantics MUST stay in sync until Phase 6g cuts the Node
// path. Anything we deliberately drop (e.g. per-spawn mcp-bridge.json
// rewriting) is called out in a comment.
package claudebinary

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/yha/core/internal/stream"
)

// EffortLevels mirrors bridge/providers/core.ts:183 — the set of values
// the upstream binary accepts for --effort. We keep this hard-coded
// rather than wiring through Node because the binary's CLI surface
// changes infrequently and a stale list would silently swallow knobs.
var EffortLevels = map[string]struct{}{
	"low": {}, "medium": {}, "high": {}, "xhigh": {}, "max": {},
}

// PermDeniedPatterns mirrors PERM_DENIED_PATTERNS in providers/core.ts.
// Substrings that, when found in a tool_result content, indicate the
// binary refused to run a tool because permission was denied. The
// stream loop surfaces a permissionDenials chunk so the UI can prompt
// the user to expand the allow-list.
var PermDeniedPatterns = []string{
	"Claude requested permissions",
	"hasn't granted it yet",
	"requires approval",
	"This command requires approval",
	"permission denied",
	"Permission denied",
	"Bash command contains multiple operations",
}

// SpawnOpts is the per-call knob set the route handler hands down.
// Most fields are direct ports of the TS opts object; comments call
// out the mapping for anything non-obvious.
type SpawnOpts struct {
	// ClaudeBin is the path to the `claude` CLI. Empty falls back to
	// the literal "claude" — relying on PATH. Set by the daemon from
	// config.defaults.claudeBin (Node mirror: CLAUDE_BIN).
	ClaudeBin string

	// ConfigDir overrides CLAUDE_CONFIG_DIR — used by claude-instances
	// to isolate state. Empty = use the default ~/.claude.
	ConfigDir string

	// CWD is the working directory the binary runs in. Required —
	// missing CWD yields an empty Cmd.Dir and the binary inherits the
	// daemon's directory which is wrong for any tool-call.
	CWD string

	// Model — if non-empty AND different from the daemon's active
	// model, --model <Model> is appended. Mirrors the TS isExternal
	// check loosely; in Go we don't carry an activeModels singleton
	// so the caller passes Model verbatim.
	Model string

	// Effort is the --effort knob. Validated against EffortLevels.
	Effort string

	// Reasoning, when set to "enabled" (or any effort value), turns on
	// --thinking-display summarized so the binary surfaces plaintext
	// thinking on subscription/OAuth tier. Mirrors claude-stream.ts:69.
	Reasoning string

	// Preset + SysMode control whether the system prompt is replace-
	// ("--system-prompt") or append-mode ("--append-system-prompt").
	// SysMode "replace" with non-Claude model also triggers --bare.
	Preset  string
	SysMode string // "replace" | "append" | ""

	// Skills — each entry rendered as a "## Skill: <name>\n\n<content>"
	// block and joined with "\n\n---\n\n" then appended via
	// --append-system-prompt. Empty slice = no-op.
	Skills []Skill

	// ResumeSessionID is the Claude binary's session id (as returned
	// in `result.session_id`). When present, --resume <id> is added so
	// the binary continues the same conversation.
	ResumeSessionID string

	// IsInteractive determines the nice level: interactive (foreground
	// chat) runs at nice 0, background (Task agents etc.) at nice 10.
	// Mirrors getNiceness() in claude-run.ts.
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
	BridgeKey string

	// Subscription flips the env-cleanup branch — when true, any
	// ANTHROPIC_API_KEY inherited from os.Environ is wiped so the
	// binary's OAuth refresh path stays in charge.
	Subscription bool

	// SkipPermissions — appends --dangerously-skip-permissions when
	// true. Mirror of config.defaults.dangerously_skip_permissions
	// (default true if not configured otherwise). Streaming spawns
	// additionally pass --disallowedTools AskUserQuestion.
	SkipPermissions bool

	// AllowedTools is the explicit allow-list, used when
	// SkipPermissions is false. Joined with "," and passed as
	// --allowedTools.
	AllowedTools []string

	// PluginDirs is the list of installed plugin directories (mirror
	// of getInstalledPluginDirs in providers/core.ts). Each is
	// emitted as a separate --plugin-dir flag when External.
	PluginDirs []string

	// AgentsJSON — JSON-encoded agents.json content (mirror of
	// loadAgentsJson). When non-empty and External, the binary gets
	// --agents <json>. Empty string skips.
	AgentsJSON string

	// MCPConfigPath, when non-empty, is appended as --mcp-config <path>
	// so the binary loads MCP servers from that file. Mirror of the
	// per-spawn mcp-bridge.<sid>.json materialisation in TS.
	MCPConfigPath string

	// WorkingDirConstraint, when true, appends the boilerplate
	// "WORKING DIRECTORY CONSTRAINT" --append-system-prompt block.
	// Set true for both streaming and synchronous paths.
	WorkingDirConstraint bool

	// Stream — controls --output-format. When true, the args include
	// "--verbose --output-format stream-json --input-format stream-json"
	// (matches claude-stream.ts:52). When false, "--output-format json"
	// is used (claude-run.ts:45).
	Stream bool

	// HasImages — when true (and Stream is false), --input-format
	// stream-json is added so the run path can write a multi-block
	// user message. Stream mode always uses stream-json.
	HasImages bool

	// ExtraEnv overrides / adds env vars (e.g. tests inject
	// HOME=/tmp/.claude). Merged on top of the inherited environment.
	ExtraEnv map[string]string
}

// Skill is one ad-hoc skill block rendered into the system prompt.
// Mirrors the TS opts.skills shape — array of {name, content}.
type Skill struct {
	Name    string
	Content string
}

// BuildArgs assembles the binary's CLI arguments per the SpawnOpts.
// Pure — no env or filesystem access. The leading arg is the binary
// path; the rest mirror the order the TS spawn site produces (so a
// side-by-side comparison stays readable).
//
// Returns (binPath, args). The caller passes the binPath through nice
// (if nice-prefixing is desired) via BuildNiceWrapper.
func BuildArgs(opts SpawnOpts) (binPath string, args []string) {
	binPath = opts.ClaudeBin
	if binPath == "" {
		binPath = "claude"
	}
	args = make([]string, 0, 32)
	args = append(args, "--print")
	if opts.Stream {
		// Streaming mode: verbose + stream-json input + output.
		args = append(args, "--verbose", "--output-format", "stream-json", "--input-format", "stream-json")
	} else {
		args = append(args, "--output-format", "json")
		if opts.HasImages {
			args = append(args, "--input-format", "stream-json")
		}
	}
	if opts.Model != "" {
		args = append(args, "--model", opts.Model)
	}
	if _, ok := EffortLevels[opts.Effort]; ok && opts.Effort != "" {
		args = append(args, "--effort", opts.Effort)
		// Stream-mode auto-enables thinking-display when effort is set
		// (TS: claude-stream.ts:69). Run-mode does not.
		if opts.Stream {
			args = append(args, "--thinking-display", "summarized")
		}
	} else if opts.Reasoning == "enabled" && opts.Stream {
		args = append(args, "--thinking-display", "summarized")
	}
	if opts.Preset != "" {
		if opts.SysMode == "replace" {
			args = append(args, "--system-prompt", opts.Preset)
		} else {
			// Default mode is "append" — anything not "replace" appends.
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
	if opts.ResumeSessionID != "" {
		args = append(args, "--resume", opts.ResumeSessionID)
	}
	if opts.MCPConfigPath != "" {
		args = append(args, "--mcp-config", opts.MCPConfigPath)
	}
	if opts.SkipPermissions {
		args = append(args, "--dangerously-skip-permissions")
	} else if len(opts.AllowedTools) > 0 {
		args = append(args, "--allowedTools", strings.Join(opts.AllowedTools, ","))
	}
	if opts.Stream {
		// AskUserQuestion has no IPC path back from --print mode; bridge
		// replaces it with mcp__MCP-Tools__bridge__AskUser. Mirrors TS.
		args = append(args, "--disallowedTools", "AskUserQuestion")
	}
	if opts.External {
		if opts.SysMode == "replace" {
			args = append(args, "--bare")
		}
		for _, dir := range opts.PluginDirs {
			args = append(args, "--plugin-dir", dir)
		}
		if opts.AgentsJSON != "" {
			args = append(args, "--agents", opts.AgentsJSON)
		}
	}
	if opts.WorkingDirConstraint && opts.CWD != "" {
		args = append(args, "--append-system-prompt", stream.BuildCWDConstraint(opts.CWD))
	}
	return binPath, args
}

// BuildEnv assembles the child process env per claude-{run,stream}.ts.
// Starts from os.Environ, overrides HOME / CLAUDE_CONFIG_DIR /
// ANTHROPIC_BASE_URL / ANTHROPIC_API_KEY / MCP_CONNECTION_NONBLOCKING
// as the opts dictate, then folds in opts.ExtraEnv. Returns an
// os/exec-shaped slice of "KEY=VALUE" strings.
func BuildEnv(opts SpawnOpts) []string {
	env := envToMap(os.Environ())

	// HOME hardening — TS rewrites /root → user homedir so libsecret /
	// fallback files don't end up in /root/.claude. We do the same.
	if h, ok := env["HOME"]; !ok || h == "" || h == "/root" {
		if u, err := os.UserHomeDir(); err == nil {
			env["HOME"] = u
		}
	}

	// ConfigDir → CLAUDE_CONFIG_DIR + matching HOME override (so per-
	// user state files Claude resolves from $HOME stay isolated). We
	// derive HOME = configDir-without-trailing-/.claude segment per the
	// TS deriveIsolatedHome helper.
	if opts.ConfigDir != "" {
		env["CLAUDE_CONFIG_DIR"] = opts.ConfigDir
		if h := deriveIsolatedHome(opts.ConfigDir); h != "" {
			env["HOME"] = h
		}
		// --print defaults to MCP_CONNECTION_NONBLOCKING=1 which makes
		// MCPs invisible to the model. Force blocking for the MCP
		// handshake (mirrors TS unconditional set).
		env["MCP_CONNECTION_NONBLOCKING"] = "0"
	}

	// API key / base URL routing.
	if opts.External {
		if opts.ProxyURL != "" {
			env["ANTHROPIC_BASE_URL"] = opts.ProxyURL
		}
		// External flows must always have *some* ANTHROPIC_API_KEY so
		// the binary doesn't 401 on the shim. Prefer the configured
		// Anthropic key (non-subscription); fall back to BridgeKey.
		if !opts.Subscription && opts.AnthropicAPIKey != "" {
			env["ANTHROPIC_API_KEY"] = opts.AnthropicAPIKey
		} else if env["ANTHROPIC_API_KEY"] == "" && opts.BridgeKey != "" {
			env["ANTHROPIC_API_KEY"] = opts.BridgeKey
		}
	} else if opts.Subscription {
		// Subscription path: wipe inherited ANTHROPIC_API_KEY so OAuth
		// refresh stays in charge. TS does `delete env.ANTHROPIC_API_KEY`.
		delete(env, "ANTHROPIC_API_KEY")
	} else if opts.AnthropicAPIKey != "" {
		env["ANTHROPIC_API_KEY"] = opts.AnthropicAPIKey
	}

	// Final fold in caller overrides (tests use this).
	for k, v := range opts.ExtraEnv {
		env[k] = v
	}

	return mapToEnv(env)
}

// envToMap turns os.Environ()'s ["KEY=VALUE", …] into a map. The first
// "=" splits; everything after is preserved (env values may contain
// "=").
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

// mapToEnv goes the other way. Stable-ish order isn't required by the
// child process but tests may want deterministic output — sort keys
// alphabetically.
func mapToEnv(m map[string]string) []string {
	out := make([]string, 0, len(m))
	for k, v := range m {
		out = append(out, k+"="+v)
	}
	// We don't bother sorting — the child reads each var individually.
	// Tests that need determinism build their own.
	return out
}

// deriveIsolatedHome mirrors bridge/chat/helpers.ts deriveIsolatedHome.
// configDir typically looks like "/home/user/.claude-instance-N/.claude" —
// strip the trailing ".claude" segment to get the per-instance HOME.
// When basename is ".claude" return the parent; otherwise return
// configDir itself (mirrors bridge/chat/helpers.ts deriveIsolatedHome).
func deriveIsolatedHome(configDir string) string {
	if configDir == "" {
		return ""
	}
	clean := filepath.Clean(configDir)
	dir, base := filepath.Split(clean)
	if base != ".claude" {
		return clean
	}
	// Trim any trailing separator that filepath.Split leaves.
	dir = strings.TrimRight(dir, string(filepath.Separator))
	if dir == "" {
		return ""
	}
	return dir
}

// SetNiceness sets the child process's priority via setpriority(2).
// IsInteractive=true → nice 0 (foreground); false → nice 10 (batch).
// Mirrors getNiceness() in claude-run.ts.
//
// Best-effort: on Linux this requires CAP_SYS_NICE only for negative
// niceness, which we never set, so the call should always succeed for
// the calling user's own PID. Errors are returned but the spawn loop
// treats them as non-fatal. Windows is a no-op (see platform_windows.go).
func SetNiceness(pid int, isInteractive bool) error {
	nice := 10
	if isInteractive {
		nice = 0
	}
	return setNicenessNative(pid, nice)
}

// BuildCmd assembles an *exec.Cmd with binary path, args, env, cwd
// applied. Niceness is NOT applied here — the caller calls
// SetNiceness(cmd.Process.Pid, opts.IsInteractive) AFTER Start so the
// PID exists. The caller also wires Stdin/Stdout/Stderr.
func BuildCmd(ctx context.Context, opts SpawnOpts) *exec.Cmd {
	binPath, args := BuildArgs(opts)
	cmd := exec.CommandContext(ctx, binPath, args...)
	cmd.Env = BuildEnv(opts)
	if opts.CWD != "" {
		cmd.Dir = opts.CWD
	}
	return cmd
}

// spawnProcess is the default ProcessSpawnFn — it runs the real
// `claude` binary via os/exec, wires stdin/stdout/stderr pipes, and
// returns handles the streamer can drive. The initial stdin payload
// is written + (in synchronous mode) closed before the function
// returns so a fast-exit binary still sees its input.
//
// Lifecycle:
//   - Pipes are owned by the returned handles. Caller closes Stdin
//     when /btw stops (or never, in synchronous mode where we close it
//     here). Stdout/Stderr close on process exit.
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
		// On Windows, "system cannot find the path specified" can mean the
		// binary lives under a OneDrive-virtualized directory (placeholder
		// reparse points that fail to materialise for some process
		// contexts even when Test-Path / Explorer show the file as
		// present). Hint at the workaround in the error so the user can
		// re-aim claudeBin without re-googling. Mirrors the discovery
		// debug session of 2026-05-24.
		_, statBinErr := os.Stat(cmd.Path)
		hint := ""
		if statBinErr != nil && strings.Contains(strings.ToLower(cmd.Path), `\appdata\`) {
			hint = "  [hint: bin lives under %APPDATA% which OneDrive may virtualize; copy claude.exe to a non-OneDrive path (e.g. C:\\Users\\<you>\\yha\\bin\\claude.exe) and update defaults.claudeBin in bridge/config.json]"
		}
		return ProcessHandles{}, fmt.Errorf("start: %w%s", err, hint)
	}

	// Write the initial stdin payload eagerly in a goroutine so the
	// process can proceed regardless of how much it reads in lockstep.
	// We DO NOT close stdin here — the streaming path may want to
	// keep it open for /btw. Synchronous Run closes via Wait's pipe
	// cleanup (StdinPipe's underlying pipe closes when cmd.Wait runs).
	go func() {
		if len(initialStdin) > 0 {
			_, werr := stdinW.Write(initialStdin)
			if werr != nil {
				// EPIPE is expected when the child exits before
				// reading; suppress.
				return
			}
		}
		if !opts.Stream {
			// Synchronous mode: close stdin so the child sees EOF and
			// emits its single result.
			_ = stdinW.Close()
		}
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
		// Best-effort close of stdin so the child sees EOF if it was
		// blocking on more input. Idempotent.
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

// buildInitialStdin renders the first user message in the shape the
// binary expects:
//   - Streaming mode + no images: a single JSONL line wrapping the
//     text in {type:"user", message:{role:"user", content:[...]}}.
//   - Streaming mode + images: same JSONL, content is multi-block
//     (text + each image block).
//   - Synchronous mode + no images: the raw prompt bytes (legacy
//     behaviour — claude --print accepts plain text on stdin).
//   - Synchronous mode + images: JSONL because --input-format=stream-json
//     was added in BuildArgs.
//
// Returns the bytes to write to stdin (no trailing newline added if
// it's the raw-text branch).
func buildInitialStdin(prompt string, imageBlocks []map[string]any, streamMode bool) ([]byte, error) {
	hasImages := len(imageBlocks) > 0
	if !streamMode && !hasImages {
		return []byte(prompt), nil
	}
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
		return nil, fmt.Errorf("marshal initial stdin: %w", err)
	}
	return append(enc, '\n'), nil
}

// readerFromString returns an io.Reader over the given string. Used by
// tests that need to inject scripted stdout/stderr fixtures.
func readerFromString(s string) io.Reader {
	return strings.NewReader(s)
}
