package grokbuild

// args.go — grok argv construction + tool filtering.
//
// Reference (grok --help, 0.2.x / 2026+):
//
//	grok -p <PROMPT> --output-format streaming-json
//	grok --prompt-file <PATH> --output-format streaming-json
//	    [-m <MODEL>]
//	    [--cwd <CWD>]
//	    [--effort <LEVEL>]
//	    [--allow <RULE>]                 (repeatable permission allow rule)
//	    [--rules <RULES>]                (append to system prompt)
//	    [--system-prompt-override <PROMPT>]  (replace system prompt)
//	    [--always-approve]               (skip tool-use approvals)
//	    [--no-alt-screen] [--no-auto-update] (script/daemon friendly)
//	    [--resume <ID>]                  (or -r/--session-id; resume prior headless sess for full context)
//	    [-s/--session-id <ID>]           (create or resume named session)

import "strings"

// grokToolNames is the canonical set of grok-side built-in tool ids.
// The wire-up is conservative — we forward only ids we recognize; any
// claude-/codex-shaped tool names are dropped before they hit grok's
// --tools flag (mismatched ids would surface as a CLI error).
//
// Names mirror the grok 0.2.x built-in catalog. Extend as new tools
// land in the CLI.
var grokToolNames = map[string]struct{}{
	"Bash":      {},
	"Edit":      {},
	"Read":      {},
	"Write":     {},
	"Glob":      {},
	"Grep":      {},
	"WebFetch":  {},
	"WebSearch": {},
	"Task":      {},
	"TodoWrite": {},
}

// IsGrokToolName reports whether a tool id belongs in the grok argv.
// Exported so the wire-up step can split FE-supplied AllowedTools into
// per-provider buckets.
func IsGrokToolName(name string) bool {
	_, ok := grokToolNames[strings.TrimSpace(name)]
	return ok
}

// filterGrokAllowedTools keeps only the grok-side ids from a mixed
// allow-list. Order-preserving + de-dup.
func filterGrokAllowedTools(in []string) []string {
	if len(in) == 0 {
		return nil
	}
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, raw := range in {
		name := strings.TrimSpace(raw)
		if name == "" {
			continue
		}
		if _, ok := grokToolNames[name]; !ok {
			continue
		}
		if _, dup := seen[name]; dup {
			continue
		}
		seen[name] = struct{}{}
		out = append(out, name)
	}
	return out
}

// buildToolPreamble — when the request carries a non-empty AllowedTools
// list, prepend a short prompt-level guard so the model has a chance
// to abort gracefully when it wants a tool not on the list. Mirrors
// the codex preamble.
func buildToolPreamble(allowed []string) string {
	names := filterGrokAllowedTools(allowed)
	if len(names) == 0 {
		return ""
	}
	return strings.Join([]string{
		"Tool availability for this run:",
		"Only use these Grok tools if tool use is necessary: " + strings.Join(names, ", "),
		"If you need a tool outside this list, stop and say which tool is missing instead of using it.",
	}, "\n")
}

// buildArgs returns the argv (excluding the binary name) for one grok
// invocation. Deterministic given the same SpawnOpts.
func buildArgs(opts SpawnOpts) []string {
	args := []string{}
	if strings.TrimSpace(opts.PromptFile) != "" {
		args = append(args, "--prompt-file", opts.PromptFile)
	} else {
		args = append(args, "-p", opts.Prompt)
	}
	args = append(args,
		"--output-format", "streaming-json",
		// Keep daemon/headless spawns script-safe. xAI docs recommend
		// --no-auto-update for automated headless/ACP integrations, and
		// --no-alt-screen prevents accidental TUI takeover if a CLI build
		// regresses around -p handling.
		"--no-auto-update",
		"--no-alt-screen",
		// --always-approve so headless runs don't block on
		// interactive tool prompts. Matches codex's bypass posture.
		"--always-approve",
	)

	// Resume support (Claude Code parity): when the adapter supplies a
	// prior grok session id (round-tripped via harness.History), pass
	// --resume so the CLI continues with its full internal state
	// (tool calls, edits, plans, compaction) instead of a lossy text fold.
	if strings.TrimSpace(opts.ResumeSessionID) != "" {
		args = append(args, "--resume", opts.ResumeSessionID)
	}

	if opts.Model != "" {
		args = append(args, "-m", opts.Model)
	}
	if opts.CWD != "" {
		args = append(args, "--cwd", opts.CWD)
	}
	if opts.Effort != "" && opts.Effort != "none" {
		args = append(args, "--effort", opts.Effort)
	}

	preset := strings.TrimSpace(opts.PresetText)
	if preset != "" {
		flag := "--rules"
		if strings.EqualFold(opts.SystemMode, "replace") {
			flag = "--system-prompt-override"
		}
		args = append(args, flag, preset)
	}

	if len(opts.AllowedTools) > 0 {
		for _, name := range filterGrokAllowedTools(opts.AllowedTools) {
			// Current Grok Build exposes permission rules as repeatable
			// --allow flags (Claude Code: --allowedTools). Older docs/builds
			// had a --tools comma-list; avoid the stale flag so non-empty
			// YHA allow-lists don't make grok fail before streaming starts.
			args = append(args, "--allow", name)
		}
	}

	return args
}

// mapEffort normalises a YHA effort level for grok's --effort flag.
// Grok already accepts low|medium|high|xhigh|max so most levels pass
// through unchanged; "none"/"off" return "none" so buildArgs omits the
// flag, and unknown values return "" (defensive).
func mapEffort(effort string) string {
	switch strings.ToLower(strings.TrimSpace(effort)) {
	case "":
		return ""
	case "none", "off":
		return "none"
	case "low", "medium", "high", "xhigh", "max":
		return strings.ToLower(strings.TrimSpace(effort))
	}
	return ""
}
