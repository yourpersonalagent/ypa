package codex

// args.go owns the codex `exec` argv construction. It's split out of
// spawn.go so the argv shape can be unit-tested in isolation and so
// the wire-up step / future App-Server port can re-use the same rules
// without re-deriving them.
//
// argv mirrors bridge/providers/codex.ts:263-300:
//
//	codex exec --json --skip-git-repo-check \
//	    (--full-auto | --dangerously-bypass-approvals-and-sandbox) \
//	    [--cd <cwd>]  [--model <model>] \
//	    [-c reasoning_effort=<minimal|low|medium|high>] \
//	    [-c reasoning_summaries=detailed] \
//	    [-c instructions=<preset>] \
//	    [-c sandbox_mode=workspace-write] \
//	    [--allowed-tool <name> ...]
//
// The TS provider doesn't ship every flag above today — Phase 6 adds
// `reasoning_effort`, `reasoning_summaries`, `--allowed-tool`, and
// `instructions` to bring the harness up to the contract's surface
// (Skills, Effort, AllowedTools, Preset). The TS path will follow
// during the cutover.

import (
	"strings"
)

// codexToolNames is the canonical set of codex-side tool ids. Mirrors
// bridge/providers/codex.ts:11-26.
var codexToolNames = map[string]struct{}{
	"functions.exec_command":   {},
	"functions.apply_patch":    {},
	"functions.update_plan":    {},
	"functions.spawn_agent":    {},
	"functions.send_input":     {},
	"functions.wait_agent":     {},
	"functions.close_agent":    {},
	"web.search_query":         {},
	"web.open":                 {},
	"web.find":                 {},
	"web.click":                {},
	"web.finance":              {},
	"web.weather":              {},
	"multi_tool_use.parallel":  {},
}

// IsCodexToolName reports whether a tool id belongs in the codex
// argv (vs the claude binary's --allowedTools). Exported so the
// daemon's adapter wire-up can split FE-supplied AllowedTools into
// per-provider buckets — feeding `Bash` to codex or `functions.
// exec_command` to claude both produce upstream rejections. Mirrors
// Node providers/codex.ts:CODEX_TOOL_NAMES.
func IsCodexToolName(name string) bool {
	_, ok := codexToolNames[strings.TrimSpace(name)]
	return ok
}

// filterCodexAllowedTools keeps only the codex-side tool ids from a
// mixed allow-list. Mirrors splitAllowedToolsByProvider (codex.ts:32-41)
// — we only need the codex bucket here; the claude bucket is the
// claudebinary harness's concern.
//
// Order-preserving + de-dup so the argv stays deterministic across
// runs (snapshot-friendly).
func filterCodexAllowedTools(in []string) []string {
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
		if _, ok := codexToolNames[name]; !ok {
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

// buildToolPreamble mirrors codex.ts:43-57. When the request carries a
// non-empty AllowedTools list, prepend a text block that tells the
// model which tools it may use. Returns "" when the list is empty.
//
// This is a prompt-level guard — the binary also honours
// `--allowed-tool` argv flags (added in buildArgs below), but
// duplicating the constraint in natural language gives the model a
// chance to abort gracefully when it wants a tool that's not on the
// list.
func buildToolPreamble(allowed []string) string {
	names := filterCodexAllowedTools(allowed)
	if len(names) == 0 {
		return ""
	}
	return strings.Join([]string{
		"Tool availability for this run:",
		"Only use these Codex tools if tool use is necessary: " + strings.Join(names, ", "),
		"If you need a tool outside this list, stop and say which tool is missing instead of using it.",
	}, "\n")
}

// buildArgs returns the argv (excluding the binary name) for one
// codex exec invocation. The output is deterministic given the same
// SpawnOpts so tests can assert on it directly.
//
// Flag groups, in argv order:
//
//	1. exec + JSON output + skip-git-repo-check (constant)
//	2. exec mode: --full-auto or --dangerously-bypass-approvals-and-sandbox
//	3. --cd <cwd>  (when non-empty)
//	4. --model <model>  (when non-empty)
//	5. -c reasoning_effort=<v>  (when Effort non-empty)
//	6. -c reasoning_summaries=detailed  (when Effort non-empty AND not "none")
//	7. -c sandbox_mode=workspace-write  (always, matches Node default)
//	8. -c instructions=<preset>  (when PresetText non-empty)
//	9. --allowed-tool <name>  (one per allowed tool)
func buildArgs(opts SpawnOpts) []string {
	args := []string{"exec", "--json", "--skip-git-repo-check"}

	if opts.ExecMode == "full-auto" {
		args = append(args, "--full-auto")
	} else {
		args = append(args, "--dangerously-bypass-approvals-and-sandbox")
	}

	if opts.CWD != "" {
		args = append(args, "--cd", opts.CWD)
	}
	if opts.Model != "" {
		args = append(args, "--model", opts.Model)
	}

	if opts.Effort != "" {
		args = append(args, "-c", "reasoning_effort="+opts.Effort)
		if opts.Effort != "none" {
			args = append(args, "-c", "reasoning_summaries=detailed")
		}
	}

	args = append(args, "-c", "sandbox_mode=workspace-write")

	if preset := strings.TrimSpace(opts.PresetText); preset != "" {
		args = append(args, "-c", "instructions="+escapeConfigValue(preset))
	}

	for _, tool := range opts.AllowedTools {
		args = append(args, "--allowed-tool", tool)
	}

	return args
}

// escapeConfigValue lightly escapes a string before it's spliced into
// a `-c key=value` argv slot. codex's parser is TOML-ish; the simplest
// safe rule is: collapse newlines to spaces (the parser breaks on
// embedded line breaks) and trim. Quotes are passed through — argv is
// already nul-delimited at the kernel boundary so shell quoting
// doesn't apply.
//
// Codex's actual TOML escaping rules are richer (literal vs basic
// strings); we ship the conservative version here and revisit if a
// preset turns out to need a backslash sequence.
func escapeConfigValue(in string) string {
	s := strings.ReplaceAll(in, "\r\n", " ")
	s = strings.ReplaceAll(s, "\n", " ")
	s = strings.ReplaceAll(s, "\r", " ")
	return strings.TrimSpace(s)
}
