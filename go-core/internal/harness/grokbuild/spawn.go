package grokbuild

// spawn.go — subprocess spawn helpers (argv assembly lives in args.go).

import (
	"context"
	"os"
	"os/exec"
	"runtime"
	"strings"
)

// SpawnOpts is everything Streamer.Run needs to launch grok.
type SpawnOpts struct {
	// Binary is the absolute path to the grok executable, or just
	// "grok" if it should resolve via PATH.
	Binary string

	// CWD is forwarded to grok via --cwd AND set as the subprocess's
	// working directory.
	CWD string

	// Model is the grok model id (already stripped of any `grok/`
	// prefix). Forwarded as -m <model>.
	Model string

	// HomeDir, when non-empty, overrides HOME in the subprocess env.
	// Used to isolate multiple grok OAuth accounts on one box.
	HomeDir string

	// Prompt is the user prompt text. Passed via -p <prompt>.
	Prompt string

	// PromptFile, when non-empty, is passed via --prompt-file instead
	// of putting the full prompt on the process command line.
	PromptFile string

	// ResumeSessionID, when non-empty, is passed via --resume <id>.
	// This lets the grok CLI continue a prior headless session (its own
	// tool history, plans, compaction state) instead of a cold -p start.
	// The YHA-side adapter decides when to supply it (via harness.History
	// roundtrip of the sessionId returned on prior session.end).
	// When set, callers typically skip the manual text fold.
	ResumeSessionID string

	// Effort is one of low|medium|high|xhigh|max|"" (or "none"). Maps
	// directly to grok's --effort flag (same vocabulary as YHA's).
	Effort string

	// AllowedTools is the per-turn whitelist, already filtered to
	// grok-side names. Passed as --tools <comma-list>.
	AllowedTools []string

	// PresetText is the system-prompt preset content. When SystemMode
	// is "replace" we pass it as --system-prompt-override; otherwise
	// it rides through as --rules (additive).
	PresetText string

	// SystemMode is "replace" / "append" / "". Controls preset routing.
	SystemMode string
}

// spawnCmd builds the exec.Cmd. Argv lives in args.go. Stdin is left
// closed — grok takes the prompt as -p, not on stdin.
func spawnCmd(ctx context.Context, opts SpawnOpts) *exec.Cmd {
	bin := opts.Binary
	if bin == "" {
		bin = "grok"
	}
	args := buildArgs(opts)
	cmd := exec.CommandContext(ctx, bin, args...)
	if opts.CWD != "" {
		cmd.Dir = opts.CWD
	}
	cmd.Env = buildEnv(opts)
	return cmd
}

// buildEnv composes the subprocess env. Overlays HOME when a per-
// instance directory is configured; otherwise inherits unchanged.
func buildEnv(opts SpawnOpts) []string {
	base := os.Environ()
	if opts.HomeDir == "" {
		return base
	}
	out := make([]string, 0, len(base)+1)
	seen := false
	for _, kv := range base {
		eq := strings.IndexByte(kv, '=')
		if eq < 0 {
			out = append(out, kv)
			continue
		}
		key := kv[:eq]
		if key == "HOME" || (runtime.GOOS == "windows" && strings.EqualFold(key, "USERPROFILE")) {
			out = append(out, key+"="+opts.HomeDir)
			if key == "HOME" {
				seen = true
			}
			continue
		}
		out = append(out, kv)
	}
	if !seen {
		out = append(out, "HOME="+opts.HomeDir)
	}
	if runtime.GOOS == "windows" {
		hasUserProfile := false
		for _, kv := range out {
			if eq := strings.IndexByte(kv, '='); eq >= 0 && strings.EqualFold(kv[:eq], "USERPROFILE") {
				hasUserProfile = true
				break
			}
		}
		if !hasUserProfile {
			out = append(out, "USERPROFILE="+opts.HomeDir)
		}
	}
	return out
}
