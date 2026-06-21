// preview.go — read-only "what the model actually sees" inspector.
//
// The /v1/stream-direct/ route assembles the model's system prompt from
// six layered sources (default preset, per-turn preset, important
// footer, cwd-context footer, working-directory constraint, skill
// blocks). The preview endpoint exposes the exact same assembly so the
// FE can render an "overview of every global / per-session context that
// reaches the model" panel without re-implementing the layering logic
// (and silently drifting from the spawn-side text).
//
// MCP servers are listed alongside as a tool-surface advisory — they
// don't appear in the system prompt itself, but they shape what the
// model can do, which is what the panel is trying to surface.
package stream

import (
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"strings"
)

// PreviewSource is one layer of the assembled system prompt.
//
// Kind is the stable machine identifier ("default-system", "preset",
// "important", "cwd-context", "cwd-constraint", "skills", "mcp"). The
// FE can pivot on it for icons / scope chips.
//
// Scope describes who edits this layer:
//
//	"global"   — applies to every chat (default preset, important
//	             footer, MCP server list).
//	"session"  — applies to this chat only (preset pick, skill pick,
//	             cwd constraint).
//	"cwd"      — applies to chats whose CWD matches this entry.
//
// Bytes is len(Text). When the layer is advisory (MCP), Bytes is 0 and
// Note carries the explanation string the FE shows underneath the row.
type PreviewSource struct {
	Kind  string `json:"kind"`
	Label string `json:"label"`
	Scope string `json:"scope"`
	Bytes int    `json:"bytes"`
	Text  string `json:"text"`
	Note  string `json:"note,omitempty"`
}

// SystemPreview is the body returned by GET /v1/system-preview. CWD is
// the working directory the route would have used for this turn (after
// the same fallback ladder /v1/stream-direct/ runs). Assembled is the
// literal text the harness lands on the model, byte-for-byte the
// concatenation of every Text in Sources (joined with "\n\n"). The FE
// uses Assembled for the "full prompt" disclosure and Sources for the
// per-layer breakdown.
type SystemPreview struct {
	CWD        string          `json:"cwd"`
	Assembled  string          `json:"assembled"`
	TotalBytes int             `json:"totalBytes"`
	Sources    []PreviewSource `json:"sources"`
}

// PreviewRequest mirrors the subset of streamRequest fields that the
// system-prompt assembly reads. Populated from query-string params on
// the GET endpoint so the FE can ship the same per-session state the
// stream POST would carry (sessionWorkingDir → CWD, currentPreset →
// Preset, sysPrompt.selection.mode → SystemMode, etc.).
type PreviewRequest struct {
	SessionID  string
	CWD        string
	Preset     string
	Presets    []string
	SystemMode string
	SkillSet   string
}

// BuildSystemPreview replays the exact assembly /v1/stream-direct/
// performs against the deps closures, then itemises each layer. Pure —
// no HTTP, no side effects. Tests drive it with synthetic RouteDeps.
//
// CWD resolution mirrors the route's stale-cwd guard: FE-supplied CWD
// (trusted as-is) → SQLite session pin (stat-checked) → JSON pin
// (stat-checked) → DefaultCWD. An empty result is allowed (the FE just
// shows "no CWD" and the cwd-constraint / cwd-context rows omit).
func BuildSystemPreview(deps RouteDeps, req PreviewRequest) SystemPreview {
	cwd := strings.TrimSpace(req.CWD)
	if cwd == "" {
		if deps.SQLiteFinalizer != nil && req.SessionID != "" {
			if pinned, ok := deps.SQLiteFinalizer.SessionWorkingDir(req.SessionID); ok && pinned != "" {
				if _, err := os.Stat(pinned); err == nil {
					cwd = pinned
				}
			}
		}
		if cwd == "" && deps.SessionsDir != "" && req.SessionID != "" {
			pinned := LoadSessionWorkingDir(deps.SessionsDir, req.SessionID)
			if pinned != "" {
				if _, err := os.Stat(pinned); err == nil {
					cwd = pinned
				}
			}
		}
		if cwd == "" {
			cwd = strings.TrimSpace(deps.DefaultCWD)
		}
	}

	sources := make([]PreviewSource, 0, 7)

	// 1. Default system prompt (global, replace-mode hides it).
	defaultSys := ""
	if deps.DefaultSystemPrompt != nil {
		defaultSys = strings.TrimSpace(deps.DefaultSystemPrompt())
	}
	mode := strings.ToLower(strings.TrimSpace(req.SystemMode))

	// 2. Resolved preset body.
	rawPreset := strings.TrimSpace(req.Preset)
	resolvedPreset := rawPreset
	if len(req.Presets) > 0 {
		parts := make([]string, 0, len(req.Presets))
		labels := make([]string, 0, len(req.Presets))
		seen := map[string]bool{}
		for _, name := range req.Presets {
			name = strings.TrimSpace(name)
			if name == "" || seen[name] {
				continue
			}
			seen[name] = true
			labels = append(labels, name)
			if deps.ResolvePreset != nil {
				name = deps.ResolvePreset(name)
			}
			if trimmed := strings.TrimSpace(name); trimmed != "" {
				parts = append(parts, trimmed)
			}
		}
		rawPreset = strings.Join(labels, ", ")
		resolvedPreset = strings.Join(parts, "\n\n")
	} else if rawPreset != "" && deps.ResolvePreset != nil {
		resolvedPreset = strings.TrimSpace(deps.ResolvePreset(rawPreset))
	}

	switch {
	case mode == "replace":
		if resolvedPreset != "" {
			sources = append(sources, PreviewSource{
				Kind:  "preset",
				Label: presetLabel(rawPreset, "replace"),
				Scope: "session",
				Bytes: len(resolvedPreset),
				Text:  resolvedPreset,
				Note:  "SystemMode=replace — the default system prompt is dropped for this turn.",
			})
		}
	default:
		if defaultSys != "" {
			sources = append(sources, PreviewSource{
				Kind:  "default-system",
				Label: "Default system prompt",
				Scope: "global",
				Bytes: len(defaultSys),
				Text:  defaultSys,
				Note:  "From config.defaults.preset → config.presets[name]. Override per chat with SystemMode=replace.",
			})
		}
		if resolvedPreset != "" {
			sources = append(sources, PreviewSource{
				Kind:  "preset",
				Label: presetLabel(rawPreset, "append"),
				Scope: "session",
				Bytes: len(resolvedPreset),
				Text:  resolvedPreset,
			})
		}
	}

	// 3. Important footer (global notepad).
	if deps.BridgeRoot != "" {
		if footer := BuildImportantFooter(deps.BridgeRoot); footer != "" {
			lines := countMarkdownBullets(footer)
			label := "Important — shared memory across agents"
			if lines > 0 {
				label = label + " (" + plural(lines, "line", "lines") + ")"
			}
			sources = append(sources, PreviewSource{
				Kind:  "important",
				Label: label,
				Scope: "global",
				Bytes: len(footer),
				Text:  footer,
				Note:  "Edited via the `important` MCP tool or the Global Context panel above.",
			})
		}
	}

	// 4. CWD-context footer (per-CWD notepad).
	if deps.BridgeRoot != "" && cwd != "" {
		if footer := BuildCwdContextFooter(deps.BridgeRoot, cwd); footer != "" {
			sources = append(sources, PreviewSource{
				Kind:  "cwd-context",
				Label: "CWD context for " + cwd,
				Scope: "cwd",
				Bytes: len(footer),
				Text:  footer,
				Note:  "Only injected when the session CWD exactly matches this path. Edited via the `cwd-context` MCP tool.",
			})
		}
	}

	// 5. Working-directory constraint (harness --append-system-prompt).
	if cwd != "" {
		constraint := BuildCWDConstraint(cwd)
		sources = append(sources, PreviewSource{
			Kind:  "cwd-constraint",
			Label: "WORKING DIRECTORY CONSTRAINT",
			Scope: "session",
			Bytes: len(constraint),
			Text:  constraint,
			Note:  "Appended by the claude harness so the model treats CWD as the only legal write target.",
		})
	}

	// 6. Skills (harness --append-system-prompt).
	if strings.TrimSpace(req.SkillSet) != "" && deps.ResolveSkills != nil {
		blocks := deps.ResolveSkills(req.SkillSet)
		if len(blocks) > 0 {
			combined := BuildSkillsBlock(blocks)
			names := make([]string, 0, len(blocks))
			for _, b := range blocks {
				names = append(names, b.Name)
			}
			sources = append(sources, PreviewSource{
				Kind:  "skills",
				Label: "Skills: " + strings.Join(names, ", "),
				Scope: "session",
				Bytes: len(combined),
				Text:  combined,
				Note:  "Each skill is one --append-system-prompt block, separated by \\n\\n---\\n\\n.",
			})
		}
	}

	// 7. MCP servers (tool surface, not prompt text).
	if deps.BridgeRoot != "" {
		mcpRow := buildMCPSource(deps.BridgeRoot)
		if mcpRow.Label != "" {
			sources = append(sources, mcpRow)
		}
	}

	// Assemble the literal text. We mirror the route's ordering: the
	// stream POST sets req.System = default+preset+footers, then the
	// claude harness appends cwd-constraint + skills via separate
	// --append-system-prompt args. The model receives all of them
	// concatenated, so the preview's Assembled does the same — minus
	// the MCP advisory row, which never enters the prompt.
	var b strings.Builder
	for _, s := range sources {
		if s.Kind == "mcp" || s.Text == "" {
			continue
		}
		if b.Len() > 0 {
			b.WriteString("\n\n")
		}
		b.WriteString(s.Text)
	}
	assembled := b.String()
	return SystemPreview{
		CWD:        cwd,
		Assembled:  assembled,
		TotalBytes: len(assembled),
		Sources:    sources,
	}
}

// RegisterPreviewRoute mounts GET /v1/system-preview on mux. Returns
// the JSON-encoded SystemPreview for the requested per-session params.
//
// Query string:
//
//	session     optional — session id (resolves pinned CWD when CWD unset)
//	cwd         optional — FE working-directory override
//	preset      optional — per-turn preset name (the FE's sysPrompt.selection.preset)
//	mode        optional — SystemMode: "append" (default) or "replace"
//	skillSet    optional — skill set name
//
// Errors are non-fatal: the response always 200s with a SystemPreview
// body. Missing data (no CWD configured, no preset selected) just
// omits the corresponding source rows.
func RegisterPreviewRoute(mux *http.ServeMux, deps RouteDeps) {
	mux.HandleFunc("/v1/system-preview", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			w.Header().Set("Allow", "GET")
			http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
			return
		}
		q := r.URL.Query()
		req := PreviewRequest{
			SessionID:  strings.TrimSpace(q.Get("session")),
			CWD:        strings.TrimSpace(q.Get("cwd")),
			Preset:     strings.TrimSpace(q.Get("preset")),
			Presets:    q["presets"],
			SystemMode: strings.TrimSpace(q.Get("mode")),
			SkillSet:   strings.TrimSpace(q.Get("skillSet")),
		}
		preview := BuildSystemPreview(deps, req)
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Cache-Control", "no-store")
		_ = json.NewEncoder(w).Encode(preview)
	})
}

func presetLabel(name, mode string) string {
	switch {
	case name == "" && mode == "replace":
		return "Preset (replace)"
	case name == "":
		return "Preset"
	case mode == "replace":
		return "Preset: " + name + " (replace)"
	default:
		return "Preset: " + name
	}
}

func countMarkdownBullets(s string) int {
	n := 0
	for _, line := range strings.Split(s, "\n") {
		if strings.HasPrefix(line, "- ") {
			n++
		}
	}
	return n
}

func plural(n int, singular, pluralForm string) string {
	if n == 1 {
		return itoa(n) + " " + singular
	}
	return itoa(n) + " " + pluralForm
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	neg := false
	if n < 0 {
		neg = true
		n = -n
	}
	var buf [20]byte
	i := len(buf)
	for n > 0 {
		i--
		buf[i] = byte('0' + n%10)
		n /= 10
	}
	if neg {
		i--
		buf[i] = '-'
	}
	return string(buf[i:])
}

// buildMCPSource reads bridge/mcp-state.json and returns a one-row
// summary of the configured MCP servers. The text body is a compact
// list of "server: command (N args)" lines so the FE can render it
// without a second fetch. Servers without `command` are listed as
// stub-only entries. Missing / unreadable file returns a zero source.
func buildMCPSource(bridgeRoot string) PreviewSource {
	data, err := os.ReadFile(filepath.Join(bridgeRoot, "mcp-state.json"))
	if err != nil {
		return PreviewSource{}
	}
	var probe struct {
		Servers map[string]struct {
			Command string   `json:"command"`
			Args    []string `json:"args"`
			Enabled *bool    `json:"enabled,omitempty"`
		} `json:"servers"`
	}
	if err := json.Unmarshal(data, &probe); err != nil {
		return PreviewSource{}
	}
	if len(probe.Servers) == 0 {
		return PreviewSource{}
	}
	var lines []string
	enabledCount := 0
	for name, srv := range probe.Servers {
		on := srv.Enabled == nil || *srv.Enabled
		if on {
			enabledCount++
		}
		cmd := srv.Command
		if cmd == "" {
			cmd = "(stub)"
		}
		flag := "on"
		if !on {
			flag = "off"
		}
		lines = append(lines, "- "+name+" ["+flag+"] — "+cmd)
	}
	text := "MCP servers configured for this YHA install. Tools listed by the model come from servers marked [on].\n\n" +
		strings.Join(lines, "\n")
	label := "MCP servers: " + plural(enabledCount, "enabled", "enabled") + " / " + plural(len(probe.Servers), "total", "total")
	return PreviewSource{
		Kind:  "mcp",
		Label: label,
		Scope: "global",
		Bytes: 0,
		Text:  text,
		Note:  "Tool surface, not prompt text — these expand the model's available actions rather than its system prompt.",
	}
}
