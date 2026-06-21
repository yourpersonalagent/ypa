package tui

// security.go — Security tab. Passive read-only summary of signals
// the bridge already collects: recent auth events, spend anomalies,
// MCP child health, Tailscale exposed surface, secret-file mtimes,
// and basic process self-report.
//
// Polls GET /v1/security/overview every 5s (light enough that it
// doesn't burn the bridge under steady state, dense enough that an
// auth-failure spike or runaway cost is visible within ~10s). The
// renderer windows the auth-event list around the cursor so up/down
// keep the highlighted row in view — same pattern Notes uses.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
)

const (
	securityRefreshInterval = 5 * time.Second
)

// securityOverview mirrors the JSON shape produced by
// bridge/core/security.ts. Field names follow the JSON keys.
type securityOverview struct {
	Success     bool             `json:"success"`
	GeneratedAt string           `json:"generatedAt"`
	Auth        securityAuth     `json:"auth"`
	Spend       securitySpend    `json:"spend"`
	MCP         securityMCP      `json:"mcp"`
	Tailscale   securityTS       `json:"tailscale"`
	Files       []securityFile   `json:"files"`
	Process     securityProc     `json:"process"`
}

type securityAuthEvent struct {
	Ts      string `json:"ts"`
	Event   string `json:"event"`
	Email   string `json:"email,omitempty"`
	IP      string `json:"ip,omitempty"`
	Reason  string `json:"reason,omitempty"`
	Allowed string `json:"allowed,omitempty"`
}

type securityAuth struct {
	Successes          int                 `json:"successes"`
	Failures           int                 `json:"failures"`
	Logouts            int                 `json:"logouts"`
	LastSuccess        *securityAuthEvent  `json:"lastSuccess,omitempty"`
	RejectedAllowlist  []securityAuthEvent `json:"rejectedAllowlist,omitempty"`
	AllowlistSize      int                 `json:"allowlistSize"`
	AuthEnabled        bool                `json:"authEnabled"`
	LogPath            string              `json:"logPath"`
	LogExists          bool                `json:"logExists"`
	Recent             []securityAuthEvent `json:"recent"`
}

type securitySpendProvider struct {
	Provider string  `json:"provider"`
	Amount   float64 `json:"amount"`
}

type securitySpend struct {
	Today              float64                 `json:"today"`
	Yesterday          float64                 `json:"yesterday"`
	SevenDayAvg        float64                 `json:"sevenDayAvg"`
	AllTime            float64                 `json:"allTime"`
	Anomaly            bool                    `json:"anomaly"`
	AnomalyReason      string                  `json:"anomalyReason,omitempty"`
	TopProvidersToday  []securitySpendProvider `json:"topProvidersToday"`
}

type securityMCPServer struct {
	Name    string `json:"name"`
	Running bool   `json:"running"`
	OK      bool   `json:"ok"`
	Error   string `json:"error"`
}

type securityMCP struct {
	Total   int                  `json:"total"`
	Running int                  `json:"running"`
	Failed  int                  `json:"failed"`
	Servers []securityMCPServer  `json:"servers"`
}

type securityTSHost struct {
	Host           string `json:"host"`
	Proto          string `json:"proto"`
	Proxy          string `json:"proxy"`
	MatchesBridge  bool   `json:"matchesBridge"`
}

type securityTS struct {
	Available bool             `json:"available"`
	FunnelOn  bool             `json:"funnelOn"`
	Hosts     []securityTSHost `json:"hosts"`
	Error     string           `json:"error,omitempty"`
}

type securityFile struct {
	Label         string `json:"label"`
	Path          string `json:"path"`
	Exists        bool   `json:"exists"`
	Mtime         string `json:"mtime,omitempty"`
	AgeHuman      string `json:"ageHuman,omitempty"`
	Size          int64  `json:"size,omitempty"`
	Mode          string `json:"mode,omitempty"`
	WorldReadable bool   `json:"worldReadable,omitempty"`
}

type securityProc struct {
	PID         int     `json:"pid"`
	UptimeSec   int64   `json:"uptimeSec"`
	MemMb       float64 `json:"memMb"`
	NodeVersion string  `json:"nodeVersion"`
	LoadAvg1    float64 `json:"loadAvg1"`
}

type securityLoadedMsg struct {
	overview *securityOverview
	err      string
}

type securityTickMsg struct{}

type securityModel struct {
	opts     Options
	styles   Styles
	httpC    *http.Client
	endpoint string

	width   int
	height  int

	loading  bool
	loaded   bool
	err      string
	overview *securityOverview

	// scroll is the index of the first body line that's visible. Up/down
	// shifts it; pgup/pgdown jumps by viewport. We scroll the *whole*
	// rendered body (sections + events) rather than cursor-windowing one
	// list, because on short terminals the user couldn't otherwise see
	// past the first section. The body builder caches its output between
	// polls so scrolling doesn't re-render six sections per keystroke.
	scroll       int
	cachedLines  []string
	cachedFor    *securityOverview
	cachedWidth  int

	// Polling state — ticker fires every securityRefreshInterval once the
	// tab has been visited at least once. We don't pre-poll: lazy-load
	// keeps a misconfigured bridge from spamming errors at startup.
	started bool
}

func newSecurityModel(opts Options, st Styles, c *http.Client, endpoint string) securityModel {
	return securityModel{
		opts:     opts,
		styles:   st,
		httpC:    c,
		endpoint: endpoint,
	}
}

func (m *securityModel) Init() tea.Cmd { return nil }

func (m *securityModel) SetSize(w, h int) {
	m.width = w
	m.height = h
	// Rebuild on resize and re-clamp: line wrapping depends on width and
	// the scroll ceiling depends on height, so a shrink could otherwise
	// leave m.scroll past the new bottom.
	m.ensureLines()
	m.clampScroll()
}

// EnsureLoaded is called by the root model when the user first visits
// the Security tab. Fires the first poll and starts the ticker.
func (m *securityModel) EnsureLoaded() tea.Cmd {
	if m.started {
		return nil
	}
	m.started = true
	m.loading = true
	return tea.Batch(
		loadSecurityOverview(m.httpC, m.endpoint, m.opts),
		scheduleSecurityTick(),
	)
}

// Headline returns the per-tab subheader components for the Security tab.
func (m securityModel) Headline() (string, []string, string) {
	bits := []string{}
	if !m.loaded && !m.loading {
		bits = append(bits, "(press Tab/r to load)")
	} else if m.loading && m.overview == nil {
		bits = append(bits, "loading…")
	} else if m.err != "" {
		bits = append(bits, "error: "+truncate(m.err, 32))
	} else if m.overview != nil {
		ov := m.overview
		bits = append(bits,
			fmt.Sprintf("auth %d ok / %d fail", ov.Auth.Successes, ov.Auth.Failures),
			fmt.Sprintf("today $%.4f", ov.Spend.Today),
			fmt.Sprintf("mcp %d/%d", ov.MCP.Running, ov.MCP.Total),
		)
		if ov.Spend.Anomaly {
			bits = append(bits, "⚠ spend anomaly")
		}
		if ov.Tailscale.FunnelOn {
			bits = append(bits, fmt.Sprintf("funnel %d host%s", len(ov.Tailscale.Hosts), plural(len(ov.Tailscale.Hosts))))
		}
	}
	hint := "↑/↓ scroll · PgUp/PgDn page · r reload"
	return "Security", bits, hint
}

func (m securityModel) Update(msg tea.Msg) (securityModel, tea.Cmd) {
	switch msg := msg.(type) {
	case securityLoadedMsg:
		m.loading = false
		m.loaded = true
		if msg.err != "" {
			m.err = msg.err
			return m, nil
		}
		m.err = ""
		m.overview = msg.overview
		// Rebuild the cached body now, in this persisting context, rather
		// than deferring to View (whose value receiver can't save it).
		// ensureLines sees the new overview pointer and rebuilds; its
		// clampScroll keeps the scroll offset when the new content is at
		// least as tall.
		m.ensureLines()
		return m, nil
	case securityTickMsg:
		if !m.started {
			return m, nil
		}
		return m, tea.Batch(
			loadSecurityOverview(m.httpC, m.endpoint, m.opts),
			scheduleSecurityTick(),
		)
	case tea.KeyMsg:
		// Make sure the cached buffer reflects current data/width before we
		// clamp against its length — otherwise scrolling no-ops on the first
		// line. Cheap: ensureLines early-returns when the cache is valid.
		m.ensureLines()
		page := m.viewportRows()
		switch msg.String() {
		case "up", "k":
			m.scroll--
			m.clampScroll()
			return m, nil
		case "down", "j":
			m.scroll++
			m.clampScroll()
			return m, nil
		case "pgup":
			m.scroll -= page
			m.clampScroll()
			return m, nil
		case "pgdown", " ":
			m.scroll += page
			m.clampScroll()
			return m, nil
		case "home", "g":
			m.scroll = 0
			return m, nil
		case "end", "G":
			m.scroll = len(m.cachedLines)
			m.clampScroll()
			return m, nil
		case "r":
			m.loading = true
			return m, loadSecurityOverview(m.httpC, m.endpoint, m.opts)
		}

	case tea.MouseMsg:
		// Wheel scrolls the cached body by a few lines, mirroring up/down.
		if msg.Action != tea.MouseActionPress {
			return m, nil
		}
		m.ensureLines()
		switch msg.Button {
		case tea.MouseButtonWheelUp:
			m.scroll -= 3
			m.clampScroll()
		case tea.MouseButtonWheelDown:
			m.scroll += 3
			m.clampScroll()
		}
		return m, nil
	}
	return m, nil
}

// viewportRows returns the number of body rows we get to draw inside
// the panel border, minus 1 for the process footer that always pins
// the bottom of the body, minus 1 for the up/down overflow markers.
func (m securityModel) viewportRows() int {
	h := m.height - 4 // top header + subheader + footer (app) + panel border
	if h < 4 {
		h = 4
	}
	return h
}

func (m *securityModel) clampScroll() {
	max := len(m.cachedLines) - m.viewportRows()
	if max < 0 {
		max = 0
	}
	if m.scroll > max {
		m.scroll = max
	}
	if m.scroll < 0 {
		m.scroll = 0
	}
}

// innerWidth is the usable content width inside the panel border. It must
// match the formula View uses (its `w` arg is the same root width SetSize
// receives), so the cached buffer built here is valid for View to reuse
// without rebuilding.
func (m securityModel) innerWidth() int {
	innerW := m.width - 6
	if innerW < 20 {
		innerW = 20
	}
	return innerW
}

// ensureLines (re)builds the cached body buffer when the data or the
// available width has changed. It MUST be called from a context whose
// mutation persists — SetSize (pointer receiver) and Update (returns the
// model) — because View runs with a value receiver and can't save the
// cache it builds. If only View populated it, the persisted model's
// cachedLines stayed nil and clampScroll pinned scroll to 0 forever.
func (m *securityModel) ensureLines() {
	if m.overview == nil {
		m.cachedLines = nil
		m.cachedFor = nil
		return
	}
	innerW := m.innerWidth()
	if m.cachedLines != nil && m.cachedFor == m.overview && m.cachedWidth == innerW {
		return
	}
	m.cachedLines = m.buildLines(innerW)
	m.cachedFor = m.overview
	m.cachedWidth = innerW
	m.clampScroll()
}

// View renders the full Security panel inside the standard PanelBorder.
// All sections + the full recent-auth list are built into a single line
// buffer once per data refresh, then we slice it by m.scroll so up/down
// pages move the whole body, not just a cursor inside one list.
func (m securityModel) View(w, h int) string {
	innerW := w - 6
	if innerW < 20 {
		innerW = 20
	}
	contentH := h - 2
	if contentH < 3 {
		contentH = 3
	}

	// Special states that don't need the cached line buffer.
	var pre string
	switch {
	case m.loading && m.overview == nil:
		pre = m.styles.SystemText.Render(crop("Loading security overview…", innerW))
	case !m.loaded:
		pre = m.styles.SystemText.Render(crop("Press Tab/r to load security overview.", innerW))
	case m.err != "":
		pre = m.styles.ErrorText.Render(crop("Error: "+m.err, innerW)) + "\n" +
			m.styles.Hint.Render(crop("(check bridge log; r to retry)", innerW))
	case m.overview == nil:
		pre = m.styles.SystemText.Render(crop("No data yet.", innerW))
	}
	if pre != "" {
		return m.styles.PanelBorder.
			Width(w - 2).
			Height(contentH).
			MaxHeight(h).
			Render(pre)
	}

	// Reuse the cached buffer that Update/SetSize already built in a
	// persisting context. This call is a same-frame fallback only (View's
	// value receiver can't save what it builds); it early-returns when the
	// cache is already valid for the current data + width.
	m.ensureLines()

	// Window the cached lines. The viewport is contentH rows; we reserve
	// the last row for the process footer (always pinned) and one row at
	// top/bottom for overflow markers when applicable.
	footer := ""
	if m.overview != nil {
		footer = m.renderProcFooter(&m.overview.Process, m.overview.GeneratedAt, innerW)
	}
	body := m.windowLines(m.cachedLines, contentH-1, innerW)
	if footer != "" {
		body += "\n" + footer
	}

	return m.styles.PanelBorder.
		Width(w - 2).
		Height(contentH).
		MaxHeight(h).
		Render(body)
}

// buildLines flattens every section into a single []string. The order
// is fixed (Auth → Spend → MCP → Tailscale → Files → Recent events),
// with one blank line between sections. The recent-events list is
// rendered in full — scrolling the body brings it into view.
func (m securityModel) buildLines(innerW int) []string {
	ov := m.overview
	if ov == nil {
		return nil
	}
	var lines []string

	lines = append(lines, m.sectionHeader("Auth · WorkOS", innerW))
	lines = append(lines, m.renderAuthSummary(&ov.Auth, innerW)...)
	lines = append(lines, "")

	lines = append(lines, m.sectionHeader("Spend · today vs 7-day avg", innerW))
	lines = append(lines, m.renderSpend(&ov.Spend, innerW)...)
	lines = append(lines, "")

	lines = append(lines, m.sectionHeader("MCP children", innerW))
	lines = append(lines, m.renderMCP(&ov.MCP, innerW)...)
	lines = append(lines, "")

	lines = append(lines, m.sectionHeader("Tailscale surface", innerW))
	lines = append(lines, m.renderTailscale(&ov.Tailscale, innerW)...)
	lines = append(lines, "")

	lines = append(lines, m.sectionHeader("Secret files", innerW))
	lines = append(lines, m.renderFiles(ov.Files, innerW)...)
	lines = append(lines, "")

	lines = append(lines, m.sectionHeader(fmt.Sprintf("Recent auth events (%d)", len(ov.Auth.Recent)), innerW))
	lines = append(lines, m.renderAuthEvents(ov.Auth.Recent, innerW)...)

	return lines
}

// windowLines slices m.cachedLines to a viewport of `rows` rows starting
// at m.scroll, replacing the first/last row with an overflow marker when
// content is hidden in that direction. Returns a single newline-joined
// string ready for the panel border.
func (m securityModel) windowLines(lines []string, rows, innerW int) string {
	if rows < 1 {
		rows = 1
	}
	n := len(lines)
	start := m.scroll
	if start < 0 {
		start = 0
	}
	if start > n {
		start = n
	}
	end := start + rows
	if end > n {
		end = n
	}
	visible := lines[start:end]

	out := make([]string, 0, rows)
	if start > 0 {
		out = append(out, m.styles.Hint.Render(crop(fmt.Sprintf("  ↑ %d more above", start), innerW)))
		if len(visible) > 0 {
			visible = visible[1:]
		}
	}
	hasBelow := end < n
	if hasBelow {
		// Reserve last row for the ↓ marker.
		if len(visible) > 0 {
			visible = visible[:len(visible)-1]
		}
	}
	out = append(out, visible...)
	if hasBelow {
		out = append(out, m.styles.Hint.Render(crop(fmt.Sprintf("  ↓ %d more below", n-end+1), innerW)))
	}
	return strings.Join(out, "\n")
}

func (m securityModel) sectionHeader(title string, innerW int) string {
	return m.styles.AssistantText.Render(crop("── "+title+" ──", innerW))
}

func (m securityModel) renderAuthSummary(a *securityAuth, innerW int) []string {
	var lines []string
	state := "DISABLED"
	if a.AuthEnabled {
		state = "ENABLED"
	}
	lines = append(lines, m.styles.Hint.Render(crop(
		fmt.Sprintf("WorkOS %s · allowlist %d emails · %d ok / %d fail / %d logout",
			state, a.AllowlistSize, a.Successes, a.Failures, a.Logouts), innerW)))
	if a.LastSuccess != nil {
		lines = append(lines, m.styles.Hint.Render(crop(
			fmt.Sprintf("last success %s from %s @ %s",
				safe(a.LastSuccess.Email, "(unknown)"), safe(a.LastSuccess.IP, "?"), shortTs(a.LastSuccess.Ts)), innerW)))
	}
	if len(a.RejectedAllowlist) > 0 {
		// This is the big one: someone got through WorkOS but their email
		// isn't on the allowlist. Real-world this is rare — surface loud.
		lines = append(lines, m.styles.ErrorText.Render(crop(
			fmt.Sprintf("⚠ %d successful login(s) outside allowlist — investigate", len(a.RejectedAllowlist)), innerW)))
		for _, e := range a.RejectedAllowlist {
			lines = append(lines, m.styles.ErrorText.Render(crop(
				"  "+safe(e.Email, "(unknown)")+" @ "+shortTs(e.Ts)+" from "+safe(e.IP, "?"), innerW)))
		}
	}
	if !a.LogExists {
		lines = append(lines, m.styles.Hint.Render(crop(
			"no auth log yet at "+a.LogPath, innerW)))
	}
	return lines
}

func (m securityModel) renderSpend(s *securitySpend, innerW int) []string {
	var lines []string
	style := m.styles.Hint
	if s.Anomaly {
		style = m.styles.ErrorText
	}
	lines = append(lines, style.Render(crop(
		fmt.Sprintf("today $%.4f  ·  yesterday $%.4f  ·  7-day avg $%.4f  ·  lifetime $%.4f",
			s.Today, s.Yesterday, s.SevenDayAvg, s.AllTime), innerW)))
	if s.AnomalyReason != "" {
		lines = append(lines, m.styles.ErrorText.Render(crop("⚠ "+s.AnomalyReason, innerW)))
	}
	if len(s.TopProvidersToday) > 0 {
		parts := []string{}
		for _, p := range s.TopProvidersToday {
			parts = append(parts, fmt.Sprintf("%s $%.4f", p.Provider, p.Amount))
		}
		lines = append(lines, m.styles.Hint.Render(crop("today by provider: "+strings.Join(parts, "  ·  "), innerW)))
	}
	return lines
}

func (m securityModel) renderMCP(mc *securityMCP, innerW int) []string {
	var lines []string
	lines = append(lines, m.styles.Hint.Render(crop(
		fmt.Sprintf("%d total · %d running · %d with error", mc.Total, mc.Running, mc.Failed), innerW)))
	// Show only the broken / first few — keep the section under ~5 lines.
	shown := 0
	for _, s := range mc.Servers {
		if shown >= 4 {
			lines = append(lines, m.styles.Hint.Render(crop(
				fmt.Sprintf("  …%d more", len(mc.Servers)-shown), innerW)))
			break
		}
		marker := "  ●"
		style := m.styles.Hint
		if !s.Running {
			marker = "  ○"
		} else if !s.OK || s.Error != "" {
			marker = "  ⚠"
			style = m.styles.ErrorText
		}
		row := marker + " " + s.Name
		if s.Error != "" {
			row += " — " + s.Error
		}
		lines = append(lines, style.Render(crop(row, innerW)))
		shown++
	}
	return lines
}

func (m securityModel) renderTailscale(t *securityTS, innerW int) []string {
	var lines []string
	if !t.Available {
		hint := "tailscale not available locally"
		if t.Error != "" {
			hint += " (" + t.Error + ")"
		}
		lines = append(lines, m.styles.Hint.Render(crop(hint, innerW)))
		return lines
	}
	if !t.FunnelOn {
		lines = append(lines, m.styles.Hint.Render(crop("no funnel / serve configured", innerW)))
		return lines
	}
	for _, h := range t.Hosts {
		marker := "  •"
		if h.MatchesBridge {
			marker = "  ★"
		}
		row := fmt.Sprintf("%s %s://%s  →  %s", marker, h.Proto, h.Host, h.Proxy)
		lines = append(lines, m.styles.Hint.Render(crop(row, innerW)))
	}
	return lines
}

func (m securityModel) renderFiles(files []securityFile, innerW int) []string {
	var lines []string
	for _, f := range files {
		if !f.Exists {
			lines = append(lines, m.styles.Hint.Render(crop(
				fmt.Sprintf("  ○ %-16s  (missing)", f.Label), innerW)))
			continue
		}
		style := m.styles.Hint
		warn := ""
		if f.WorldReadable {
			style = m.styles.ErrorText
			warn = "  ⚠ world-readable"
		}
		row := fmt.Sprintf("  ● %-16s  mode %s  %s%s",
			f.Label, f.Mode, f.AgeHuman, warn)
		lines = append(lines, style.Render(crop(row, innerW)))
	}
	return lines
}

func (m securityModel) renderAuthEvents(events []securityAuthEvent, innerW int) []string {
	if len(events) == 0 {
		return []string{m.styles.SystemText.Render(crop(
			"(no auth events yet — nothing has hit /auth/* since the log started)", innerW))}
	}
	lines := make([]string, 0, len(events))
	for _, ev := range events {
		row := fmt.Sprintf("  %s  %-14s  %s",
			shortTs(ev.Ts), ev.Event, formatAuthDetails(ev))
		style := m.styles.ListItem
		if ev.Event == "login_failed" {
			style = m.styles.ErrorText
		} else if ev.Allowed == "false" && ev.Event == "login_success" {
			// successful login from a NOT-on-allowlist email — highlight
			style = m.styles.ErrorText
		}
		lines = append(lines, style.Render(crop(row, innerW)))
	}
	return lines
}

func formatAuthDetails(ev securityAuthEvent) string {
	parts := []string{}
	if ev.Email != "" {
		parts = append(parts, ev.Email)
	}
	if ev.IP != "" {
		parts = append(parts, "from "+ev.IP)
	}
	if ev.Reason != "" {
		parts = append(parts, "reason="+truncate(ev.Reason, 40))
	}
	if ev.Allowed == "false" {
		parts = append(parts, "NOT on allowlist")
	}
	return strings.Join(parts, " · ")
}

func (m securityModel) renderProcFooter(p *securityProc, generatedAt string, innerW int) string {
	up := time.Duration(p.UptimeSec) * time.Second
	row := fmt.Sprintf("bridge pid %d · up %s · rss %.1fMb · load1 %.2f · refreshed %s",
		p.PID, shortDur(up), p.MemMb, p.LoadAvg1, shortTs(generatedAt))
	return m.styles.Hint.Render(crop(row, innerW))
}


func shortTs(iso string) string {
	if iso == "" {
		return "?"
	}
	t, err := time.Parse(time.RFC3339Nano, iso)
	if err != nil {
		t, err = time.Parse(time.RFC3339, iso)
	}
	if err != nil {
		return iso
	}
	return t.Local().Format("01-02 15:04:05")
}

func shortDur(d time.Duration) string {
	if d < time.Minute {
		return fmt.Sprintf("%ds", int(d.Seconds()))
	}
	if d < time.Hour {
		return fmt.Sprintf("%dm", int(d.Minutes()))
	}
	if d < 48*time.Hour {
		return fmt.Sprintf("%dh%dm", int(d.Hours()), int(d.Minutes())%60)
	}
	return fmt.Sprintf("%dd", int(d.Hours()/24))
}

func scheduleSecurityTick() tea.Cmd {
	return tea.Tick(securityRefreshInterval, func(time.Time) tea.Msg {
		return securityTickMsg{}
	})
}

func loadSecurityOverview(c *http.Client, base string, opts Options) tea.Cmd {
	return func() tea.Msg {
		listOpts := opts
		listOpts.Timeout = 8 * time.Second
		body, status, err := jsonGET(c, base, "/v1/security/overview", listOpts)
		if err != nil {
			return securityLoadedMsg{err: err.Error()}
		}
		if status >= 300 {
			return securityLoadedMsg{err: fmt.Sprintf("HTTP %d", status)}
		}
		var ov securityOverview
		if err := json.Unmarshal(body, &ov); err != nil {
			return securityLoadedMsg{err: "parse: " + err.Error()}
		}
		return securityLoadedMsg{overview: &ov}
	}
}
