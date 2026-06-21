package tui

// sessions.go — Sessions tab. Lists sessions from /v1/sessions/, lets
// the user pick one, and exposes the picked id back to the root model
// so the chat tab can use it.
//
// We keep the rendering hand-rolled (no bubbles/list) because the
// session list is short, we want a custom info panel beside the list,
// and bubbles/list would add another layer of message routing for
// minimal benefit.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/textinput"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// sessionInfo mirrors the bridge's /v1/sessions/ list shape.
type sessionInfoTUI struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	MessageCount int    `json:"messageCount"`
	LastUsed     int64  `json:"lastUsed"`
	IsRunning    bool   `json:"isRunning"`
	WorkingDir   string `json:"workingDir"`
}

type sessionsLoadedMsg struct {
	sessions []sessionInfoTUI
	err      string
}

type sessionDetailMsg struct {
	id   string
	body string
	err  string
}

type sessionExportMsg struct {
	path string
	err  string
}

type sessionsModel struct {
	opts     Options
	styles   Styles
	httpC    *http.Client
	endpoint string

	width, height int

	loaded   bool
	loading  bool
	err      string
	sessions []sessionInfoTUI // raw list from /v1/sessions/
	visible  []int            // indices into sessions after filters
	cursor   int

	// busy is the live "currently streaming" set, keyed by session id,
	// pushed by the root model from the /v1/activity/stream feed (see
	// activity.go). It is the source of truth for the running marker —
	// the list's own IsRunning is only as fresh as the last load, which
	// is exactly the staleness the feed fixes. nil = no frame yet.
	busy map[string]activityMeta

	// search + filters
	searchInput textinput.Model
	searching   bool   // true while user is typing in the / prompt
	cwdFilter   string // when non-empty, hide rows whose workingDir != this

	// detail panel — lazy-fetched on cursor move.
	detail   viewport.Model
	detailID string

	// pickedSession is set when the user hits Enter; popPickedSession
	// drains it for the root model to push into the chat tab.
	pickedSession string

	// transient status line ("exported to /tmp/x.md", "filter active" …)
	flash string
}

// sessionsAuthHint inspects a session-load error string for known HTTP
// codes and returns an actionable hint.
func sessionsAuthHint(errMsg string) string {
	switch {
	case strings.Contains(errMsg, "401") || strings.Contains(errMsg, "Unauthorized"):
		return "set YHA_BEARER_TOKEN in bridge/.env (./yha.sh dev) and pass --token=$YHA_BEARER_TOKEN"
	case strings.Contains(errMsg, "403"):
		return "your email isn't on ALLOWED_EMAILS — log in via the browser first"
	}
	return ""
}

func newSessionsModel(opts Options, st Styles, c *http.Client, endpoint string) sessionsModel {
	vp := viewport.New(40, 10)
	si := textinput.New()
	si.Placeholder = "type to filter…"
	si.Prompt = "/ "
	si.CharLimit = 0
	return sessionsModel{
		opts:        opts,
		styles:      st,
		httpC:       c,
		endpoint:    endpoint,
		detail:      vp,
		searchInput: si,
		// loading must start false so the FIRST EnsureLoaded() call
		// actually fires loadSessions(). The earlier eager-load design
		// pre-set loading:true here; lazy-load flipped that into a bug —
		// EnsureLoaded short-circuits when loading is already true,
		// which left the tab stuck on "Loading sessions…" forever.
	}
}

// Init does NOT eagerly load the session list — that 401s loudly when
// no token is set, ambushing users who only wanted the chat tab. The
// list loads on first switch to the Sessions tab (or `r` to refresh).
func (m *sessionsModel) Init() tea.Cmd {
	return nil
}

// EnsureLoaded triggers a load if we haven't already pulled the list
// once. Called by the root model when the user switches to this tab.
func (m *sessionsModel) EnsureLoaded() tea.Cmd {
	if m.loaded || m.loading {
		return nil
	}
	m.loading = true
	return loadSessions(m.httpC, m.endpoint, m.opts)
}

func (m *sessionsModel) SetSize(w, h int) {
	m.width = w
	m.height = h
	listW := w / 3
	if listW < 30 {
		listW = 30
	}
	detailW := w - listW - 4
	if detailW < 20 {
		detailW = 20
	}
	// Detail viewport = panel content area. PanelBorder adds 2 lines
	// (top + bottom border). Panel total = h (full body), so the
	// content area is h-2. Width gets the same -2 for L/R padding.
	m.detail.Width = detailW - 2
	m.detail.Height = h - 2
	if m.detail.Height < 1 {
		m.detail.Height = 1
	}
}

// Headline returns the per-tab subheader components for the Sessions
// tab — total/visible count and filter state, plus key hints.
func (m sessionsModel) Headline() (string, []string, string) {
	bits := []string{}
	switch {
	case m.loading:
		bits = append(bits, "loading…")
	case m.err != "":
		bits = append(bits, "error")
	case !m.loaded:
		bits = append(bits, "(press Tab/r to load)")
	default:
		total := len(m.sessions)
		visible := len(m.visible)
		if visible == total {
			bits = append(bits, fmt.Sprintf("%d session%s", total, plural(total)))
		} else {
			bits = append(bits, fmt.Sprintf("%d/%d shown", visible, total))
		}
	}
	if n := len(m.busy); n > 0 {
		bits = append(bits, fmt.Sprintf("%d busy", n))
	}
	if m.cwdFilter != "" {
		bits = append(bits, "cwd "+shortenPath(m.cwdFilter, 28))
	}
	if q := strings.TrimSpace(m.searchInput.Value()); q != "" {
		bits = append(bits, "search "+truncate(q, 18))
	}
	hint := "↑/↓ Enter · / search · f same-cwd · F clear · e export · r reload"
	return "Sessions", bits, hint
}

// popPickedSession returns and clears the most recent Enter selection.
func (m *sessionsModel) popPickedSession() string {
	id := m.pickedSession
	m.pickedSession = ""
	return id
}

// setBusy replaces the live busy set. Called by the root model on every
// /v1/activity/stream frame; the frame is the complete set of streaming
// sessions, so a wholesale replace is correct (absence == idle).
func (m *sessionsModel) setBusy(busy map[string]activityMeta) {
	m.busy = busy
}

// isBusy reports whether a session is currently streaming, per the live
// feed. Membership only — we deliberately do NOT fall back to the row's
// IsRunning, which goes stale between list loads.
func (m sessionsModel) isBusy(id string) bool {
	if id == "" {
		return false
	}
	_, ok := m.busy[id]
	return ok
}

// Update handles cursor movement, refresh, and session selection.
func (m sessionsModel) Update(msg tea.Msg) (sessionsModel, tea.Cmd) {
	switch msg := msg.(type) {
	case sessionsLoadedMsg:
		m.loading = false
		m.loaded = true
		if msg.err != "" {
			// Surface the same hint chat.go uses so the user knows what
			// to fix without leaving the TUI.
			m.err = msg.err
			if hint := sessionsAuthHint(msg.err); hint != "" {
				m.err = msg.err + "\n→ " + hint
			}
			return m, nil
		}
		m.err = ""
		m.sessions = msg.sessions
		sort.Slice(m.sessions, func(i, j int) bool {
			return m.sessions[i].LastUsed > m.sessions[j].LastUsed
		})
		m.refilter()
		// Auto-fetch detail for the highlighted entry.
		if len(m.visible) > 0 {
			id := m.sessions[m.visible[m.cursor]].ID
			return m, loadSessionDetail(m.httpC, m.endpoint, m.opts, id)
		}
		return m, nil

	case sessionDetailMsg:
		if msg.err != "" {
			m.detail.SetContent(m.styles.ErrorText.Render(msg.err))
		} else {
			m.detail.SetContent(formatSessionDetail(msg.body, m.styles))
		}
		m.detailID = msg.id
		return m, nil

	case sessionExportMsg:
		if msg.err != "" {
			m.flash = "export: " + msg.err
		} else {
			m.flash = "exported → " + msg.path
		}
		return m, nil

	case tea.KeyMsg:
		// Search-mode capture: while the / prompt is active, every key
		// goes into the textinput (with Enter/Esc as terminators).
		if m.searching {
			switch msg.String() {
			case "esc":
				m.searching = false
				m.searchInput.SetValue("")
				m.searchInput.Blur()
				m.refilter()
				return m, nil
			case "enter":
				m.searching = false
				m.searchInput.Blur()
				m.refilter()
				if len(m.visible) > 0 {
					return m, m.maybeLoadDetail()
				}
				return m, nil
			}
			var cmd tea.Cmd
			m.searchInput, cmd = m.searchInput.Update(msg)
			m.refilter()
			return m, cmd
		}
		switch msg.String() {
		case "up", "k":
			if m.cursor > 0 {
				m.cursor--
				return m, m.maybeLoadDetail()
			}
		case "down", "j":
			if m.cursor < len(m.visible)-1 {
				m.cursor++
				return m, m.maybeLoadDetail()
			}
		case "enter":
			if len(m.visible) > 0 {
				m.pickedSession = m.sessions[m.visible[m.cursor]].ID
			}
			return m, nil
		case "r":
			m.loading = true
			return m, loadSessions(m.httpC, m.endpoint, m.opts)
		case "/":
			m.searching = true
			m.searchInput.Focus()
			return m, textinput.Blink
		case "f":
			// Filter list to "sessions sharing the highlighted row's cwd".
			// Every session has a workingDir on the server, so we don't
			// need any chat-tab state — we just take the cwd from
			// whatever row the cursor is on right now.
			if len(m.visible) == 0 {
				m.flash = "no session highlighted to take cwd from"
				return m, nil
			}
			cwd := m.sessions[m.visible[m.cursor]].WorkingDir
			if cwd == "" {
				m.flash = "highlighted session has no cwd recorded"
				return m, nil
			}
			m.cwdFilter = cwd
			m.cursor = 0
			m.flash = "filtering to cwd: " + shortenPath(cwd, 60)
			m.refilter()
			return m, m.maybeLoadDetail()
		case "F":
			// Capital F clears the cwd filter — paired with 'f' so the
			// user can toggle off without leaving the tab.
			m.cwdFilter = ""
			m.flash = "cwd filter cleared"
			m.refilter()
			return m, m.maybeLoadDetail()
		case "e":
			if len(m.visible) == 0 {
				return m, nil
			}
			id := m.sessions[m.visible[m.cursor]].ID
			m.flash = "exporting " + id + "…"
			return m, exportSessionMarkdown(m.httpC, m.endpoint, m.opts, id)
		}

	case tea.MouseMsg:
		// Wheel moves the list cursor and triggers the same detail load
		// as the arrow keys; ignored while the search prompt is active.
		if m.searching || msg.Action != tea.MouseActionPress {
			return m, nil
		}
		switch msg.Button {
		case tea.MouseButtonWheelUp:
			if m.cursor > 0 {
				m.cursor -= 3
				if m.cursor < 0 {
					m.cursor = 0
				}
				return m, m.maybeLoadDetail()
			}
		case tea.MouseButtonWheelDown:
			if m.cursor < len(m.visible)-1 {
				m.cursor += 3
				if m.cursor > len(m.visible)-1 {
					m.cursor = len(m.visible) - 1
				}
				return m, m.maybeLoadDetail()
			}
		}
		return m, nil
	}
	return m, nil
}

// SetCwdFilter is called by the root model when the chat panel switches
// session, so 'f' on the Sessions tab can toggle "show only sessions
// with the same cwd as the currently-open chat".
func (m *sessionsModel) SetCwdFilter(cwd string) {
	if cwd == "" || cwd == m.cwdFilter {
		return
	}
	m.cwdFilter = cwd
}

// refilter rebuilds m.visible from m.sessions using the search query
// AND the cwd filter (when active).
func (m *sessionsModel) refilter() {
	q := strings.ToLower(strings.TrimSpace(m.searchInput.Value()))
	m.visible = m.visible[:0]
	for i, s := range m.sessions {
		if m.cwdFilter != "" && s.WorkingDir != m.cwdFilter {
			continue
		}
		if q != "" {
			hay := strings.ToLower(s.Name + " " + s.ID)
			if !subseq(hay, q) {
				continue
			}
		}
		m.visible = append(m.visible, i)
	}
	if m.cursor >= len(m.visible) {
		m.cursor = 0
	}
}

func (m sessionsModel) maybeLoadDetail() tea.Cmd {
	if len(m.visible) == 0 {
		return nil
	}
	id := m.sessions[m.visible[m.cursor]].ID
	if id == m.detailID {
		return nil
	}
	return loadSessionDetail(m.httpC, m.endpoint, m.opts, id)
}

// View renders the two-pane sessions layout.
//
// Each panel is hard-capped at exactly h rows. We compute the inner
// content width (panel width - border - padding) so session rows
// don't soft-wrap into a second line, then let PanelBorder.MaxHeight
// crop anything that still overflows. Don't trust lipgloss .Height()
// — it's a *minimum*, not a maximum, so an over-long content string
// pushes the footer off-screen and the terminal scrolls the top of
// the view out of sight (the bug the user reported as "I only see
// the bottom of the list").
func (m sessionsModel) View(w, h int) string {
	listW := w / 3
	if listW < 30 {
		listW = 30
	}
	if listW > w-20 {
		listW = w - 20
	}
	if listW < 20 {
		listW = 20
	}
	detailW := w - listW
	if detailW < 20 {
		detailW = 20
	}

	// Inner content width = panel width - 2 border - 2 panel padding - 2
	// row-style padding. The row styles (Hint, ListItem, SelectedItem) each
	// add Padding(0, 1) which lipgloss appends *before* the PanelBorder
	// wraps, so cropping at listW-4 still produces lines listW-2 wide and
	// every row gets soft-wrapped to 2 visual rows. Crop at listW-6 so
	// styled rows render single-line and fit inside the panel.
	listInnerW := listW - 6
	detailInnerW := detailW - 4
	contentH := h - 2
	if contentH < 3 {
		contentH = 3
	}

	// Trailing newlines inflate the content height by one row in lipgloss
	// (`Count(s, "\n") + 1`), which makes MaxHeight crop the bottom border
	// off the panel. Same fix as rewind/mcp tabs.
	listContent := strings.TrimRight(m.renderListBody(contentH, listInnerW), "\n")
	detailContent := strings.TrimRight(m.detailBody(detailInnerW), "\n")

	// Height(contentH) pads short content up to contentH lines; MaxHeight(h)
	// crops the FULL rendered output (incl. border) at h. The pair gives
	// us "exactly h rows", which neither alone provides.
	listPanel := m.styles.PanelBorder.
		Width(listW - 2).
		Height(contentH).
		MaxHeight(h).
		Render(listContent)
	detailPanel := m.styles.PanelBorder.
		Width(detailW - 2).
		Height(contentH).
		MaxHeight(h).
		Render(detailContent)
	return lipgloss.JoinHorizontal(lipgloss.Top, listPanel, detailPanel)
}

// renderListBody draws the inner left-pane content, sized to fit
// `contentH` rows and `innerW` columns (so individual rows don't soft-
// wrap when lipgloss measures them).
func (m sessionsModel) renderListBody(contentH, innerW int) string {
	if innerW < 10 {
		innerW = 10
	}
	switch {
	case m.loading:
		return m.styles.SystemText.Render(crop("Loading sessions…", innerW))
	case m.err != "":
		return m.styles.ErrorText.Render(crop("Error: "+m.err, innerW)) + "\n" +
			m.styles.Hint.Render(crop("Press 'r' to retry.", innerW))
	case len(m.sessions) == 0:
		return m.styles.SystemText.Render(crop("No sessions yet.", innerW))
	}
	var b strings.Builder
	// Hint goes FIRST so it's always visible — fitToHeight crops from
	// the bottom, so anything appended after the session rows can get
	// chopped off when there are many entries. Putting the hint at the
	// top keeps the f/F/r/e affordances permanently in the user's eye.
	b.WriteString(m.styles.Hint.Render(crop(sessionsHintFor(innerW), innerW)))
	b.WriteString("\n")
	headerLines := 1
	if m.searching || m.searchInput.Value() != "" {
		b.WriteString(m.styles.SystemText.Render(crop(m.searchInput.View(), innerW)))
		b.WriteString("\n")
		headerLines++
	}
	if m.cwdFilter != "" {
		short := m.cwdFilter
		if len(short) > innerW-10 {
			short = "…" + short[len(short)-(innerW-10)+1:]
		}
		b.WriteString(m.styles.SystemText.Render(crop("cwd filter: "+short, innerW)))
		b.WriteString("\n")
		headerLines++
	}
	if m.flash != "" {
		b.WriteString(m.styles.Hint.Render(crop(m.flash, innerW)))
		b.WriteString("\n")
		headerLines++
	}
	// Reserve nothing at the bottom — the hint moved to the top above.
	visibleRows := contentH - headerLines
	if visibleRows < 1 {
		visibleRows = 1
	}
	if len(m.visible) > visibleRows {
		// Make room for the up/down scroll markers when the list overflows.
		visibleRows -= 2
		if visibleRows < 1 {
			visibleRows = 1
		}
	}
	if len(m.visible) == 0 {
		b.WriteString(m.styles.SystemText.Render(crop("(no matches)", innerW)))
		return b.String()
	}
	start, end := windowAroundCursor(len(m.visible), m.cursor, visibleRows)
	now := time.Now()
	if start > 0 {
		b.WriteString(m.styles.Hint.Render(crop("  ↑ more above", innerW)))
		b.WriteString("\n")
	}
	// Reserve two extra columns (vs the old 21) for the busy cell that
	// sits between the cursor marker and the name.
	nameW := innerW - 23
	if nameW < 6 {
		nameW = 6
	}
	for i := start; i < end; i++ {
		s := m.sessions[m.visible[i]]
		label := s.Name
		if label == "" {
			label = "(unnamed)"
		}
		if len(label) > nameW {
			label = label[:nameW-3] + "..."
		}
		marker := "  "
		if i == m.cursor {
			marker = "> "
		}
		// Busy cell: a filled dot for streaming sessions, blank otherwise,
		// kept inside the cropped plain text so width math (and the panel
		// crop) stay correct. Colour comes from the row style below.
		busy := m.isBusy(s.ID)
		busyCell := "  "
		if busy {
			busyCell = "● "
		}
		line := crop(fmt.Sprintf("%s%s%-*s %3d msgs %s",
			marker, busyCell, nameW, label, s.MessageCount, humanAgoTUI(s.LastUsed, now)), innerW)
		switch {
		case i == m.cursor:
			b.WriteString(m.styles.SelectedItem.Render(line))
		case busy:
			b.WriteString(m.styles.BusyItem.Render(line))
		default:
			b.WriteString(m.styles.ListItem.Render(line))
		}
		b.WriteString("\n")
	}
	if end < len(m.visible) {
		b.WriteString(m.styles.Hint.Render(crop("  ↓ more below", innerW)))
		b.WriteString("\n")
	}
	return b.String()
}

func sessionsHintFor(innerW int) string {
	switch {
	case innerW >= 90:
		return "↑/↓ move · Enter open · / search · f same-cwd-as-row · F clear · e export · r reload"
	case innerW >= 70:
		return "↑/↓ Enter · / search · f same-cwd · F clear · e export · r reload"
	case innerW >= 40:
		return "↑/↓ Enter / f F e r"
	default:
		return "↑/↓ Enter / f"
	}
}

// detailBody returns the right-pane content. Falls back to a hint
// while the first fetch is in flight so the user doesn't see a blank
// rectangle next to the populated list. detailID is the canonical
// "have we received a sessionDetailMsg yet?" flag — viewport.View()
// always returns whitespace-padded lines so it can't double as a
// "is this empty?" probe.
func (m sessionsModel) detailBody(innerW int) string {
	if m.detailID == "" {
		if len(m.sessions) == 0 {
			return m.styles.Hint.Render(crop("Sessions appear here.", innerW))
		}
		return m.styles.Hint.Render(crop("Loading session…", innerW))
	}
	return m.detail.View()
}

// fitToHeight pads short content with blank lines and crops over-long
// content from the bottom so the result has exactly h rows. Used by
// any tab that builds string content for a fixed-height panel.
func fitToHeight(s string, h int) string {
	if h <= 0 {
		return ""
	}
	lines := strings.Split(s, "\n")
	if len(lines) > h {
		lines = lines[:h]
	} else {
		for len(lines) < h {
			lines = append(lines, "")
		}
	}
	return strings.Join(lines, "\n")
}

// shortenPath collapses a long absolute path to fit n columns by keeping
// the trailing segment intact and prefixing with "…". The leading dirs
// are usually stable across sessions (e.g. /home/user/yha);
// the tail is the discriminator the user actually cares about.
func shortenPath(p string, n int) string {
	if len(p) <= n {
		return p
	}
	if n <= 1 {
		return p[:n]
	}
	return "…" + p[len(p)-n+1:]
}

// crop hard-truncates a single-line string to at most n display columns
// using rune count (good enough for the ASCII labels we render). Avoids
// lipgloss soft-wrapping a long row into two visible lines, which would
// blow the panel's row budget.
func crop(s string, n int) string {
	if n <= 0 {
		return ""
	}
	r := []rune(s)
	if len(r) <= n {
		return s
	}
	if n <= 1 {
		return string(r[:n])
	}
	return string(r[:n-1]) + "…"
}

// windowAroundCursor returns [start, end) row indices to render so the
// cursor stays roughly centred in a window of `visible` rows. Edge
// cases: short lists collapse to [0, n); cursor near the top/bottom
// snaps the window so we never draw past the array bounds.
func windowAroundCursor(n, cursor, visible int) (int, int) {
	if visible >= n {
		return 0, n
	}
	start := cursor - visible/2
	if start < 0 {
		start = 0
	}
	end := start + visible
	if end > n {
		end = n
		start = end - visible
		if start < 0 {
			start = 0
		}
	}
	return start, end
}

// ── network glue ───────────────────────────────────────────────────────────

// shortListTimeout caps the sessions GET so a stuck daemon doesn't leave
// the Sessions tab on "Loading…" forever — the chat-stream timeout
// (Options.Timeout, default 10 min) is way too long for a small JSON
// listing. 8s is plenty for a healthy daemon and short enough to surface
// 'timeout' as an error before the user gives up.
const shortListTimeout = 8 * time.Second

func loadSessions(c *http.Client, base string, opts Options) tea.Cmd {
	return func() tea.Msg {
		listOpts := opts
		listOpts.Timeout = shortListTimeout
		body, status, err := jsonGET(c, base, "/v1/sessions/", listOpts)
		if err != nil {
			return sessionsLoadedMsg{err: err.Error()}
		}
		if status >= 300 {
			return sessionsLoadedMsg{err: fmt.Sprintf("HTTP %d: %s", status, strings.TrimSpace(string(body)))}
		}
		var parsed struct {
			Sessions []sessionInfoTUI `json:"sessions"`
		}
		if err := json.Unmarshal(body, &parsed); err != nil {
			return sessionsLoadedMsg{err: "parse: " + err.Error()}
		}
		return sessionsLoadedMsg{sessions: parsed.Sessions}
	}
}

// exportSessionMarkdown GETs /v1/sessions/<id>/export.md and writes it
// to ~/Downloads/yha-<id>.md (or /tmp/ as fallback).
func exportSessionMarkdown(c *http.Client, base string, opts Options, id string) tea.Cmd {
	return func() tea.Msg {
		listOpts := opts
		listOpts.Timeout = 30 * time.Second
		body, status, err := jsonGET(c, base, "/v1/sessions/"+id+"/export.md", listOpts)
		if err != nil {
			return sessionExportMsg{err: err.Error()}
		}
		if status >= 300 {
			return sessionExportMsg{err: fmt.Sprintf("HTTP %d", status)}
		}
		dir := exportTargetDir()
		path := filepath.Join(dir, "yha-"+id+".md")
		if werr := os.WriteFile(path, body, 0o644); werr != nil {
			return sessionExportMsg{err: werr.Error()}
		}
		return sessionExportMsg{path: path}
	}
}

// exportTargetDir picks the first writable candidate.
func exportTargetDir() string {
	candidates := []string{}
	if home, err := os.UserHomeDir(); err == nil {
		candidates = append(candidates, filepath.Join(home, "Downloads"))
	}
	candidates = append(candidates, "/tmp")
	for _, c := range candidates {
		if st, err := os.Stat(c); err == nil && st.IsDir() {
			return c
		}
	}
	return "/tmp"
}

func loadSessionDetail(c *http.Client, base string, opts Options, id string) tea.Cmd {
	return func() tea.Msg {
		detailOpts := opts
		detailOpts.Timeout = shortListTimeout
		body, status, err := jsonGET(c, base, "/v1/sessions/"+id, detailOpts)
		if err != nil {
			return sessionDetailMsg{id: id, err: err.Error()}
		}
		if status >= 300 {
			return sessionDetailMsg{id: id, err: fmt.Sprintf("HTTP %d", status)}
		}
		return sessionDetailMsg{id: id, body: string(body)}
	}
}

// formatSessionDetail extracts the bits we want to show in the side
// panel out of the full session JSON. Lenient: missing fields just
// don't appear.
func formatSessionDetail(raw string, st Styles) string {
	var parsed struct {
		Session struct {
			ID, Name, WorkingDir string
			MessageCount         int
			CreatedAt, LastUsed  int64
			IsRunning            bool
			Messages             []struct {
				Role string
				Text any
			}
		} `json:"session"`
	}
	if err := json.Unmarshal([]byte(raw), &parsed); err != nil {
		return st.ErrorText.Render("parse: " + err.Error())
	}
	s := parsed.Session
	var b strings.Builder
	b.WriteString(st.HeaderTitle.Render(orFallback(s.Name, s.ID)))
	b.WriteString("\n\n")
	fmt.Fprintf(&b, "id:        %s\n", s.ID)
	fmt.Fprintf(&b, "messages:  %d\n", s.MessageCount)
	fmt.Fprintf(&b, "created:   %s\n", fmtMillisTUI(s.CreatedAt))
	fmt.Fprintf(&b, "last used: %s\n", fmtMillisTUI(s.LastUsed))
	if s.WorkingDir != "" {
		fmt.Fprintf(&b, "cwd:       %s\n", s.WorkingDir)
	}
	if s.IsRunning {
		b.WriteString(st.StatusOnline.Render("running"))
		b.WriteString("\n")
	}
	if n := len(s.Messages); n > 0 {
		b.WriteString("\n")
		b.WriteString(st.SystemText.Render("recent:"))
		b.WriteString("\n")
		start := 0
		if n > 5 {
			start = n - 5
		}
		for _, mm := range s.Messages[start:] {
			text := ""
			if t, ok := mm.Text.(string); ok {
				text = t
			}
			text = strings.ReplaceAll(text, "\n", " ")
			if len(text) > 80 {
				text = text[:77] + "..."
			}
			fmt.Fprintf(&b, "  [%s] %s\n", mm.Role, text)
		}
	}
	b.WriteString("\n")
	b.WriteString(st.Hint.Render("Enter to use this session in chat."))
	return b.String()
}

func humanAgoTUI(ms int64, now time.Time) string {
	if ms <= 0 {
		return "-"
	}
	d := now.Sub(time.UnixMilli(ms))
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	}
}

func fmtMillisTUI(ms int64) string {
	if ms <= 0 {
		return "-"
	}
	return time.UnixMilli(ms).Format("2006-01-02 15:04:05")
}

func orFallback(a, b string) string {
	if a != "" {
		return a
	}
	return b
}
