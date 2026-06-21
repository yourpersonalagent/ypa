package stream

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// BuildCWDConstraint emits the long "WORKING DIRECTORY CONSTRAINT"
// system prompt addition. Byte-for-byte identical to the TS string
// (so any model fine-tuned on that prompt sees the same hash) — the
// claudebinary + claudesdk harness adapters import this so all three
// callers (the two harness spawn paths + the system-preview endpoint)
// stay in lockstep.
func BuildCWDConstraint(cwd string) string {
	if strings.TrimSpace(cwd) == "" {
		return ""
	}
	return fmt.Sprintf(
		"WORKING DIRECTORY CONSTRAINT: Your current working directory for this session is %q. "+
			"You MUST only read, write, create, or delete files inside %q. "+
			"Finding a matching file outside this directory via grep, find, or any search tool does NOT give you permission to touch it. "+
			"If you believe you need to modify a file outside %q, you MUST stop and ask the user for explicit permission BEFORE taking any action. "+
			"Never modify files outside %q on your own initiative, even if they appear related or similar. "+
			"When referencing files without absolute paths, always resolve them relative to %q. "+
			"OTHER USERS' DATA: This machine may be shared (e.g. family members on a household PC, separate user accounts on the same OS). "+
			"You MUST NOT read, list, browse, display, summarize, copy, or otherwise expose the contents of directories belonging to other users — "+
			"this includes sibling home folders, other accounts' working trees, their photos, videos, documents, downloads, mail, browser data, or any personal files — "+
			"even if the operating system's file permissions would technically allow access. "+
			"Treat anything outside this working directory as private to someone else unless the user explicitly references that exact path in their request. "+
			"If a tool result accidentally surfaces such content, do not relay or summarize it; tell the user and stop.",
		cwd, cwd, cwd, cwd, cwd,
	)
}

// BuildSkillsBlock returns the joined skill markdown that the claude
// harness adapters append via --append-system-prompt. Mirrors the loop
// in claudebinary/spawn.go:224 + claudesdk/spawn.go:172 so the preview
// endpoint can show byte-identical text. Empty input → "".
func BuildSkillsBlock(skills []SkillBlock) string {
	if len(skills) == 0 {
		return ""
	}
	var b strings.Builder
	for i, s := range skills {
		if i > 0 {
			b.WriteString("\n\n---\n\n")
		}
		b.WriteString("## Skill: ")
		b.WriteString(s.Name)
		b.WriteString("\n\n")
		b.WriteString(s.Content)
	}
	return b.String()
}

// BuildImportantFooter reads bridge/important-memory.json and returns
// the formatted "Important — shared memory across agents" footer
// block to append to the system prompt. Empty when no lines are
// configured (zero-token cost). Mirrors Node's
// bridge/context/global.ts:buildImportantFooter exactly so the
// footer appearing on every Go-served turn is byte-identical to the
// Node-served one.
//
// bridgeRoot should be the absolute path to bridge/. Empty input
// or unreadable file → "".
func BuildImportantFooter(bridgeRoot string) string {
	if bridgeRoot == "" {
		return ""
	}
	data, err := os.ReadFile(filepath.Join(bridgeRoot, "important-memory.json"))
	if err != nil {
		return ""
	}
	var probe struct {
		Lines []string `json:"lines"`
	}
	if err := json.Unmarshal(data, &probe); err != nil {
		return ""
	}
	if len(probe.Lines) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("---\n## Important — shared memory across agents\n")
	for _, l := range probe.Lines {
		b.WriteString("- ")
		b.WriteString(l)
		b.WriteByte('\n')
	}
	b.WriteString("\nThis is a small shared notepad visible to every agent and the user. You can edit it via the MCP tool `important` (read / set / add / remove). Keep entries short, keyword-style. Max 7 lines.")
	return b.String()
}

// BuildCwdContextFooter reads bridge/cwd-context-memory.json and
// returns the "## CWD context — only for working directory <cwd>"
// footer block for the given cwd. Empty when no lines are configured
// for that cwd. Mirrors Node's bridge/context/cwd.ts:
// buildCwdContextFooter.
func BuildCwdContextFooter(bridgeRoot, cwd string) string {
	cwd = strings.TrimSpace(cwd)
	if bridgeRoot == "" || cwd == "" {
		return ""
	}
	norm := normalizeCwd(cwd)
	if norm == "" {
		return ""
	}
	data, err := os.ReadFile(filepath.Join(bridgeRoot, "cwd-context-memory.json"))
	if err != nil {
		return ""
	}
	var probe map[string]struct {
		Lines []string `json:"lines"`
	}
	if err := json.Unmarshal(data, &probe); err != nil {
		return ""
	}
	entry, ok := probe[norm]
	if !ok || len(entry.Lines) == 0 {
		return ""
	}
	var b strings.Builder
	b.WriteString("---\n## CWD context — only for working directory ")
	b.WriteString(norm)
	b.WriteByte('\n')
	for _, l := range entry.Lines {
		b.WriteString("- ")
		b.WriteString(l)
		b.WriteByte('\n')
	}
	b.WriteString("\nThis note applies only to chats whose session working directory exactly matches this path. Keep entries short, keyword-style. Max 7 lines.")
	return b.String()
}

// normalizeCwd strips trailing slashes (except root). Mirrors Node's
// normalizeCwd in context/cwd.ts so a /tmp/x vs /tmp/x/ lookup hits
// the same entry.
func normalizeCwd(cwd string) string {
	cwd = strings.TrimSpace(cwd)
	if cwd == "" {
		return ""
	}
	if cwd == "/" {
		return cwd
	}
	return strings.TrimRight(cwd, "/")
}

// AppendSystemFooters folds the important + cwd-context footers onto
// an existing system prompt. Returns the system text unchanged when
// neither footer has content. The route handler calls this after the
// SystemMode replace/append fold, so both branches (preset-only and
// default+preset) pick up the footers consistently.
func AppendSystemFooters(system, bridgeRoot, cwd string) string {
	important := BuildImportantFooter(bridgeRoot)
	cwdCtx := BuildCwdContextFooter(bridgeRoot, cwd)
	if important == "" && cwdCtx == "" {
		return system
	}
	var b strings.Builder
	b.WriteString(system)
	if important != "" {
		if system != "" {
			b.WriteString("\n\n")
		}
		b.WriteString(important)
	}
	if cwdCtx != "" {
		if b.Len() > 0 {
			b.WriteString("\n\n")
		}
		b.WriteString(cwdCtx)
	}
	return b.String()
}
