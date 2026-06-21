// Package parsers turns raw stdout/stderr from known commands into
// structured "pretty" summaries the TUI can render in lieu of (or
// alongside) the raw bytes. Plan ref:
// docs/YHA-TUI-Replacement-Plan.md §2 row L + §7.
//
// Contract:
//   - Every parser is a pure function: (raw []byte) → Pretty.
//   - Parsing is best-effort. A parser that bails mid-way returns the
//     partial result it has so far; callers can detect with
//     pretty.Partial == true and fall back to raw if desired.
//   - The package is dependency-light on purpose: callers (the TUI's
//     log pane, the bridge HTTP shim) consume Pretty without dragging
//     anything else from internal/tuid in.
//
// The TUI v1 wires only the bun-build and tailscale parsers into job
// log panes. pm2 and git use the structured Sampler data on the
// dashboard, but the parsers are kept here so a future "yha logs
// <service>" pane (which runs `pm2 logs` raw) and offline yha-status
// dumps can format consistently.
package parsers

import "strings"

// Pretty is the output of every parser.
type Pretty struct {
	// Summary is a single-line headline (e.g. "build ok — 0 errors,
	// 3 warnings"). Always populated, even on parse failure.
	Summary string

	// Lines is the structured body. Empty slice means "no body —
	// caller should render raw instead".
	Lines []Line

	// Facts is a small key/value bag of extracted metadata. Used by
	// machine consumers (the HTTP shim, tests).
	Facts map[string]string

	// Partial signals the parser bailed early. Caller may want to
	// append a "[pretty parse incomplete, raw follows]" footer.
	Partial bool
}

// Line is one rendered row. Style is a token the renderer maps to a
// lipgloss style; an empty style means "default".
type Line struct {
	Style string
	Text  string
}

// Line style tokens. Renderers map these to lipgloss styles; unknown
// styles fall through to default.
const (
	StyleError = "error"
	StyleWarn  = "warn"
	StyleOK    = "ok"
	StyleMuted = "muted"
	StyleHead  = "head"
)

// For dispatches by canonical command name. Returns ok=false if no
// parser is registered — caller should fall back to raw output.
//
// Names match the command-table entries in tuid/commands.go. Variants
// with flag suffixes (e.g. "build --frontend") are best-effort
// alias-matched: the dispatcher checks longest-prefix-with-space first.
func For(name string, raw []byte) (Pretty, bool) {
	switch name {
	case "build":
		// Bun output looks like vite's even when run via yha.sh go-build,
		// so reuse the bun parser as a sensible default.
		return ParseBunBuild(raw), true
	case "share":
		return ParseTailscale(raw), true
	case "logs":
		// `pm2 logs` output isn't structured enough for line styling, but
		// the parser does flag obvious "[ERROR]" lines for readability.
		return ParsePM2Logs(raw), true
	case "status":
		// `yha status` shells to pm2 status + git status -sb. Two parsers
		// concatenated, separated by a blank-line marker the shell emits.
		return parseCombinedStatus(raw), true
	}
	return Pretty{}, false
}

// parseCombinedStatus splits the "status" job's output on the blank
// line we emit between pm2 and git in commands.go, then runs each
// half through its own parser. Returns a single Pretty with both
// summaries concatenated.
func parseCombinedStatus(raw []byte) Pretty {
	body := string(raw)
	// Best-effort split — first "\n\n" separates the pm2 block from
	// the git block; everything past the second "\n\n" is treated as
	// git too in case of trailing chatter.
	pm2Part, gitPart := body, ""
	if i := strings.Index(body, "\n\n"); i >= 0 {
		pm2Part = body[:i]
		gitPart = body[i+2:]
	}
	pm2 := ParsePM2Status([]byte(pm2Part))
	git := ParseGitStatus([]byte(gitPart))

	out := Pretty{
		Facts: mergeFacts(pm2.Facts, git.Facts),
	}
	switch {
	case pm2.Summary != "" && git.Summary != "":
		out.Summary = pm2.Summary + "  ·  " + git.Summary
	case pm2.Summary != "":
		out.Summary = pm2.Summary
	default:
		out.Summary = git.Summary
	}
	if len(pm2.Lines) > 0 {
		out.Lines = append(out.Lines, Line{Style: StyleHead, Text: "pm2"})
		out.Lines = append(out.Lines, pm2.Lines...)
	}
	if len(git.Lines) > 0 {
		if len(out.Lines) > 0 {
			out.Lines = append(out.Lines, Line{})
		}
		out.Lines = append(out.Lines, Line{Style: StyleHead, Text: "git"})
		out.Lines = append(out.Lines, git.Lines...)
	}
	out.Partial = pm2.Partial || git.Partial
	return out
}

func mergeFacts(a, b map[string]string) map[string]string {
	if len(a) == 0 && len(b) == 0 {
		return nil
	}
	out := make(map[string]string, len(a)+len(b))
	for k, v := range a {
		out["pm2."+k] = v
	}
	for k, v := range b {
		out["git."+k] = v
	}
	return out
}
