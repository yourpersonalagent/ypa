package tui

// dashboard.go — Dashboard tab. The new "front door" pane: connects to
// YHA-TUI-Daemon and renders the m1 layout from the TUI replacement
// plan (docs/YHA-TUI-Replacement-Plan.md §2 row M):
//
//   ┌── Services ──────────────────────────────────────────┐
//   │ YHA-Bridge      ● online   up 3h12m   PID 1234        │
//   │ YHA-Rewind    ● online   up 3h12m   PID 1236        │
//   │ YHA-Core      ● online   up 3h12m   PID 1237        │
//   │ YHA-TUI-Daemon ● online  up 3h12m   PID 1235        │
//   └──────────────────────────────────────────────────────┘
//   ┌── Git ─────────────────────────┬─ Tailscale ─────────┐
//   │ branch  main · HEAD 9802cafb  │ funnel  off          │
//   │ staged  1   unstaged 23       │                      │
//   └────────────────────────────────┴──────────────────────┘
//   ┌── Recent jobs ────────────────────────────────────────┐
//   │ a8f7-…  restart   done    14:23   exit=0            │
//   │ b9c4-…  build     running 14:30                      │
//   └──────────────────────────────────────────────────────┘
//
// The pane polls the daemon every 3s. If the daemon socket is missing
// (daemon not running yet), it surfaces a clear "daemon offline" hint
// rather than retrying tight. Reconnect attempts back off to every 5s.

import (
	"context"
	"errors"
	"fmt"
	"net"
	"sort"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/textinput"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/yha/core/internal/tuid"
)

// dashboardConnMsg lands when a dial attempt against the daemon socket
// finishes. err is set iff dialling failed.
type dashboardConnMsg struct {
	client *tuid.Client
	err    string
}

// dashboardSnapMsg lands when a poll round finishes. Either field may
// be present alongside an error — the pane shows whatever it got.
type dashboardSnapMsg struct {
	snap *tuid.StatusSnap
	jobs []tuid.JobInfo
	err  string
}

// dashboardTickMsg fires on the polling cadence (refreshInterval) and
// during the reconnect backoff (reconnectInterval).
type dashboardTickMsg struct{}

// dashboardFireMsg lands when a command-bar dispatch finishes. jobID is
// populated on success; err carries the daemon's rejection otherwise.
type dashboardFireMsg struct {
	cmd   string
	jobID string
	err   string
}

const (
	dashboardRefreshInterval   = 3 * time.Second
	dashboardReconnectInterval = 5 * time.Second
	dashboardJobsCap           = 8
)

type dashboardModel struct {
	styles Styles
	width  int
	height int

	client    *tuid.Client
	connected bool
	connErr   string

	snap     *tuid.StatusSnap
	jobs     []tuid.JobInfo
	pollErr  string
	lastPoll time.Time

	viewport viewport.Model

	// Command bar: `cmdInput` consumes keys when `cmdFocused` is true.
	// `lastFire` is the persistent status-line summary of the most recent
	// dispatch (success or error).
	cmdInput   textinput.Model
	cmdFocused bool
	lastFire   dashboardFireMsg

	// loginRequested is set when the user typed ":login" (or "login")
	// into the command bar. Root model drains it via popLoginRequested
	// so the link-flow overlay opens — keeps this sub-model free of
	// references to the overlay type.
	loginRequested bool

	// help is the Alt+C scrollable command reference. Opens with Alt+C
	// (or the bare "?" hotkey), Esc/q closes it.
	help helpModal
}

func newDashboardModel(st Styles) dashboardModel {
	vp := viewport.New(80, 20)
	ti := textinput.New()
	ti.Prompt = ": "
	ti.Placeholder = "type a command (e.g. restart --keep-rewind)"
	ti.CharLimit = 256
	return dashboardModel{
		styles:   st,
		viewport: vp,
		cmdInput: ti,
		help:     newHelpModal(),
	}
}

func (m *dashboardModel) Init() tea.Cmd {
	return dialDaemon()
}

func (m *dashboardModel) SetSize(w, h int) {
	m.width = w
	m.height = h
	// Reserve room below the frame for: command legend (2 lines) +
	// command bar (1) + status (1). dashboardBottomReserve below.
	m.viewport.Width = w - 4
	m.viewport.Height = h - dashboardBottomReserve
	if m.viewport.Height < 1 {
		m.viewport.Height = 1
	}
	m.cmdInput.Width = w - 6
	if m.help.isOpen() {
		m.help.SetSize(w, h, m.styles)
	}
	m.refresh()
}

// dashboardBottomReserve is the height (in screen rows) we hold back
// from the main viewport so the command legend + input + status fit
// without scrolling. Keep this in sync with View's JoinVertical block.
const dashboardBottomReserve = 7

// FocusCmd is called by the parent model when the dashboard tab gains
// focus, so the command bar can start consuming keys without the user
// pressing ':' first. (Not currently used; reserved for future UX.)
func (m *dashboardModel) FocusCmd() {
	m.cmdFocused = true
	m.cmdInput.Focus()
}

// inputFocused mirrors chatModel.inputFocused() so app.go can gate the
// bare-letter `q` quit shortcut while the user is typing a command —
// and, by extension, while the Alt+C help modal is up (the modal owns
// `q` as a close key, so bubbling it to the top-level quit would yank
// the help out from under the user).
func (m *dashboardModel) inputFocused() bool { return m.cmdFocused || m.help.isOpen() }

// popLoginRequested returns true exactly once after the user typed
// ":login" (or "login") in the command bar. Root model drains this
// to pop the login overlay without the dashboard sub-model needing
// to know about the overlay type.
func (m *dashboardModel) popLoginRequested() bool {
	v := m.loginRequested
	m.loginRequested = false
	return v
}

// Headline returns the per-tab subheader components for the Dashboard
// tab. The connection badge already lives at the top of the viewport,
// but the subheader gives a short at-a-glance line independent of any
// scrolling inside the viewport.
func (m dashboardModel) Headline() (string, []string, string) {
	bits := []string{}
	switch {
	case m.connected && m.pollErr == "":
		bits = append(bits, "daemon ●")
	case m.connected:
		bits = append(bits, "daemon ● (poll err)")
	case m.connErr != "":
		bits = append(bits, "daemon ✗")
	default:
		bits = append(bits, "connecting…")
	}
	if m.snap != nil && m.snap.Runtime != nil {
		mode := strings.ToLower(m.snap.Runtime.Mode)
		if mode != "" {
			label := mode
			if m.snap.Runtime.Backend != "" {
				label = mode + " (" + m.snap.Runtime.Backend + ")"
			}
			bits = append(bits, "mode "+label)
		}
	}
	if m.snap != nil {
		online := 0
		for _, p := range m.snap.PM2 {
			if strings.EqualFold(p.Status, "online") {
				online++
			}
		}
		bits = append(bits, fmt.Sprintf("%d/%d up", online, len(m.snap.PM2)))
	}
	hint := ": cmd · r refresh · Alt+C help · :restart (bridge only) · :restart all (full)"
	return "Dashboard", bits, hint
}

func (m *dashboardModel) blurCmd() {
	m.cmdFocused = false
	m.cmdInput.Blur()
	m.cmdInput.SetValue("")
}

func (m dashboardModel) Update(msg tea.Msg) (dashboardModel, tea.Cmd) {
	switch msg := msg.(type) {
	case dashboardConnMsg:
		if msg.err != "" {
			m.connected = false
			m.connErr = msg.err
			m.refresh()
			return m, scheduleDashboardTick(dashboardReconnectInterval)
		}
		m.client = msg.client
		m.connected = true
		m.connErr = ""
		m.refresh()
		return m, pollDashboard(m.client)

	case dashboardSnapMsg:
		m.lastPoll = time.Now()
		if msg.err != "" {
			m.pollErr = msg.err
			// On a polling failure that looks like the connection died,
			// drop the client so the next tick re-dials.
			if isConnDead(msg.err) {
				m.connected = false
				if m.client != nil {
					_ = m.client.Close()
					m.client = nil
				}
			}
		} else {
			m.pollErr = ""
			if msg.snap != nil {
				m.snap = msg.snap
			}
			m.jobs = msg.jobs
		}
		m.refresh()
		return m, scheduleDashboardTick(dashboardRefreshInterval)

	case dashboardTickMsg:
		if !m.connected || m.client == nil {
			return m, dialDaemon()
		}
		return m, pollDashboard(m.client)

	case dashboardFireMsg:
		m.lastFire = msg
		// Force a poll so the new job shows up in the recent-jobs panel
		// without waiting for the 3s tick.
		m.refresh()
		if m.connected && m.client != nil {
			return m, pollDashboard(m.client)
		}
		return m, nil

	case tea.KeyMsg:
		// Help modal eats input first when it's up. Tab/Shift+Tab are
		// already trapped by the root model so the user can leave the
		// dashboard without dismissing the modal; everything else routes
		// through helpModal.Update for scrolling or closing.
		if m.help.isOpen() {
			handled, cmd := m.help.Update(msg)
			if handled {
				return m, cmd
			}
		}
		// Command-bar focused: every key feeds the textinput except the
		// shortcuts that close it.
		if m.cmdFocused {
			switch msg.String() {
			case "esc":
				m.blurCmd()
				m.refresh()
				return m, nil
			case "enter":
				raw := strings.TrimSpace(m.cmdInput.Value())
				if raw == "" {
					m.blurCmd()
					m.refresh()
					return m, nil
				}
				// "login" / ":login" never reaches the daemon — it's a TUI-
				// owned action, not a service command. Pop the link-flow
				// overlay instead of asking the daemon to dispatch an
				// unknown job. (Strip an optional leading colon so users
				// who type the bare prompt syntax both work.)
				if normalised := strings.TrimPrefix(raw, ":"); normalised == "login" {
					m.blurCmd()
					m.loginRequested = true
					m.lastFire = dashboardFireMsg{cmd: "login",
						err: "opening login overlay…"}
					m.refresh()
					return m, nil
				}
				m.blurCmd()
				m.refresh()
				return m, fireCommand(m.client, raw)
			}
			var cmd tea.Cmd
			m.cmdInput, cmd = m.cmdInput.Update(msg)
			m.refresh()
			return m, cmd
		}
		switch msg.String() {
		case "r":
			if m.connected && m.client != nil {
				return m, pollDashboard(m.client)
			}
			return m, dialDaemon()
		case ":":
			// vi-style prompt: focus the command bar.
			if m.connected && m.client != nil {
				m.cmdFocused = true
				m.cmdInput.Focus()
				m.refresh()
				return m, textinput.Blink
			}
			// No daemon → don't open the bar; surface the reason instead.
			m.lastFire = dashboardFireMsg{
				err: "command bar disabled — daemon offline",
			}
			m.refresh()
			return m, nil
		case "alt+c", "?":
			// Open the scrollable help modal. `?` is the secondary trigger
			// for terminals that don't pass Alt through cleanly; both land
			// here because the root model already routed the keystroke to
			// us (alt+c only opens the chat-tab cwd picker when tab=chat).
			m.help.Open(m.width, m.height, m.styles)
			return m, nil
		}

	case tea.MouseMsg:
		// When the help modal is open it owns the wheel (forwards to its
		// own viewport); otherwise fall through to the recent-jobs
		// viewport below so the wheel scrolls the job list.
		if m.help.isOpen() {
			handled, cmd := m.help.Update(msg)
			if handled {
				return m, cmd
			}
		}
	}
	var cmd tea.Cmd
	m.viewport, cmd = m.viewport.Update(msg)
	return m, cmd
}

// View returns the bordered viewport, a 2-line command legend (so
// `:restart` and friends are self-documenting), the command-bar strip,
// and the last-fire status line. Layout is intentionally split this
// way per the plan revision: no more redundant key-hint lines at head
// + bottom; the bottom area is where the command surface lives.
func (m dashboardModel) View(w, h int) string {
	// Help modal owns the whole body when open. We still keep the global
	// header/footer (rendered by the root model) visible underneath so
	// the user knows which tab they're on.
	if m.help.isOpen() {
		return m.help.View(m.styles, w, h)
	}
	frameH := h - dashboardBottomReserve + 2
	if frameH < 3 {
		frameH = 3
	}
	frame := m.styles.PanelBorder.
		Width(w - 2).
		Height(frameH - 2).
		MaxHeight(frameH).
		Render(m.viewport.View())

	legend := m.renderCmdLegend(w)

	// Command-bar input line (one line). When unfocused, render a hint.
	var bar string
	if m.cmdFocused {
		bar = m.cmdInput.View()
	} else {
		bar = m.styles.Hint.Render(": (press : to type a command · r refreshes · Alt+C for help · Tab switches tab)")
	}

	// Status line — the last-fire summary.
	status := m.styles.Hint.Render(m.statusLine())

	return lipgloss.JoinVertical(lipgloss.Left, frame, legend, bar, status)
}

// renderCmdLegend draws a compact 2-line guide explaining what each
// command in the bar actually does. Pulled from a curated subset of
// tuid.Commands so the list stays small and stable; new entries land
// here by adding a row to cmdLegendEntries below.
func (m *dashboardModel) renderCmdLegend(w int) string {
	type entry struct {
		name string
		help string
	}
	rows := []entry{
		{"restart", "bridge only · keep mode · go-core/rewind stay (chat survives)"},
		{"restart dev", "bridge → dev mode (vite HMR + bun --watch) · go-core stays"},
		{"restart build", "bridge → build mode (vite build + serve dist/) · go-core stays"},
		{"restart core", "bounce only YHA-Core (rebuild if stale)"},
		{"restart all", "full bounce (legacy ./yha.sh build) · kills chat stream"},
		{"go-reload", "zero-downtime YHA-Core swap (SO_REUSEPORT)"},
		{"share", "re-enable tailscale funnel → :8443"},
		{"logs", "tail pm2 logs (default YHA-Bridge)"},
	}
	cmdStyle := lipgloss.NewStyle().Foreground(colorAccent).Bold(true)
	helpStyle := lipgloss.NewStyle().Foreground(colorMuted)
	rendered := make([]string, len(rows))
	for i, r := range rows {
		rendered[i] = cmdStyle.Render(":"+r.name) + " " + helpStyle.Render(r.help)
	}
	half := (len(rendered) + 1) / 2
	sep := helpStyle.Render("  ·  ")
	line1 := strings.Join(rendered[:half], sep)
	line2 := strings.Join(rendered[half:], sep)
	return line1 + "\n" + line2
}

func (m *dashboardModel) statusLine() string {
	if m.lastFire.jobID != "" {
		return fmt.Sprintf("last: %s → job %s fired",
			truncate(m.lastFire.cmd, 30), shortID(m.lastFire.jobID))
	}
	if m.lastFire.err != "" {
		return "last: " + m.lastFire.err
	}
	return ""
}

func (m *dashboardModel) refresh() {
	var b strings.Builder

	// Connection badge sits at the very top of the viewport — no more
	// redundant key-hint line. The command legend below the frame
	// explains what's typeable; global keys live in the footer.
	b.WriteString(m.connBadge())
	b.WriteString("\n\n")

	b.WriteString(m.renderServices())
	b.WriteString("\n")
	b.WriteString(m.renderURLs())
	b.WriteString("\n")
	b.WriteString(m.renderTop())
	b.WriteString("\n")
	b.WriteString(m.renderGitTailscale())
	b.WriteString("\n")
	b.WriteString(m.renderJobs())

	m.viewport.SetContent(b.String())
}

// connBadge renders the live daemon-link state plus the running mode
// (dev / build) so the user can see at a glance which yha.sh invocation
// is currently behind the bridge. Distinct from the upper-right
// "yha-core dot" — that one is for chat-route liveness.
func (m *dashboardModel) connBadge() string {
	mode := m.runtimeBadge()
	switch {
	case m.connected && m.pollErr == "":
		stamp := ""
		if !m.lastPoll.IsZero() {
			stamp = "  ·  last poll " + m.lastPoll.Format("15:04:05")
		}
		return m.styles.StatusOnline.Render("daemon ●") +
			mode +
			m.styles.Hint.Render(stamp)
	case m.connected && m.pollErr != "":
		return m.styles.StatusOnline.Render("daemon ●") +
			mode +
			m.styles.ErrorText.Render("  poll error: "+m.pollErr)
	case m.connErr != "":
		return m.styles.StatusOffline.Render("daemon ✗") +
			mode +
			m.styles.Hint.Render("  "+m.connErr)
	default:
		return m.styles.HeaderStatus.Render("connecting…") + mode
	}
}

// runtimeBadge renders the dev/build pill. Build mode is the production
// path (frontend dist + watchers off); dev is the bun --watch + Vite
// path. Backend (go/node) tacked on next to it. Returns "" if no
// runtime info yet, so the connection badge stays uncluttered during
// the first ~3s after launch.
func (m *dashboardModel) runtimeBadge() string {
	if m.snap == nil || m.snap.Runtime == nil {
		return ""
	}
	r := m.snap.Runtime
	mode := strings.ToLower(r.Mode)
	if mode == "" {
		return ""
	}
	var pill string
	switch mode {
	case "dev":
		// Dev mode is a "this is mutable, hot-reloading" signal — use
		// the accent (blue) colour so it visually shouts at the user.
		pill = lipgloss.NewStyle().
			Foreground(colorAccent).Bold(true).
			Render(" ⚙ dev ")
	case "build":
		// Build mode is the production-shaped path — green to mirror
		// the "everything is wired the prod way" feel.
		pill = m.styles.StatusOnline.Render(" ⛁ build ")
	default:
		pill = m.styles.Hint.Render(" mode " + mode + " ")
	}
	suffix := ""
	if r.Backend != "" {
		suffix = m.styles.Hint.Render("(" + r.Backend + ")")
	}
	prov := ""
	if r.Source == "self-env" || r.Source == "inferred" {
		// Stale-ish snapshot — daemon couldn't read the bridge's proc
		// env. Mark it so the user knows the mode pill might lag.
		prov = m.styles.Hint.Render(" ~")
	}
	return "  " + pill + " " + suffix + prov
}

// renderURLs prints the user-facing endpoints. Localhost rows are always
// shown (the ports are well-known); the public funnel row only appears
// when tailscale reports an active funnel target. Useful so the operator
// doesn't have to remember which port reverse-proxies to which.
func (m *dashboardModel) renderURLs() string {
	header := m.styles.HeaderTitle.Render("URLs")
	var b strings.Builder
	b.WriteString(header)
	b.WriteByte('\n')

	row := func(label, url, note string) {
		// Two-column: label (10 wide) | URL (rest) | dim note
		b.WriteString("  ")
		b.WriteString(padRight(label, 10))
		b.WriteString(m.styles.StatusOnline.Render(url))
		if note != "" {
			b.WriteString("  ")
			b.WriteString(m.styles.Hint.Render(note))
		}
		b.WriteByte('\n')
	}

	row("app", "http://localhost:8443", "(go-core front door)")
	row("bun", "http://localhost:8442", "(internal upstream)")
	row("rewind", "http://localhost:8445/recover", "(safety net)")

	// Tailscale funnel public URL, if any. We append the path the funnel is
	// configured against (usually empty / "/") so the user can copy it
	// straight into a browser.
	if m.snap != nil && m.snap.Tailscale != nil && m.snap.Tailscale.FunnelOK && m.snap.Tailscale.FunnelURL != "" {
		note := ""
		if t := m.snap.Tailscale.FunnelTarget; t != "" {
			note = "(funnel → " + t + ")"
		} else {
			note = "(funnel on)"
		}
		row("public", m.snap.Tailscale.FunnelURL, note)
	}

	return strings.TrimRight(b.String(), "\n")
}

func (m *dashboardModel) renderServices() string {
	header := m.styles.HeaderTitle.Render("Services")
	if m.snap == nil {
		body := m.styles.SystemText.Render("(no data yet)")
		return header + "\n" + body
	}
	if m.snap.PM2Error != "" {
		body := m.styles.ErrorText.Render("pm2: " + m.snap.PM2Error)
		return header + "\n" + body
	}
	procs := append([]tuid.PM2Process(nil), m.snap.PM2...)
	sort.SliceStable(procs, func(i, j int) bool {
		return procs[i].Name < procs[j].Name
	})
	if len(procs) == 0 {
		body := m.styles.SystemText.Render("(no pm2 processes)")
		return header + "\n" + body
	}
	var b strings.Builder
	b.WriteString(header)
	b.WriteByte('\n')
	for _, p := range procs {
		b.WriteString(m.serviceRow(p))
		b.WriteByte('\n')
	}
	return strings.TrimRight(b.String(), "\n")
}

func (m *dashboardModel) serviceRow(p tuid.PM2Process) string {
	var dot string
	switch strings.ToLower(p.Status) {
	case "online", "launching":
		dot = m.styles.StatusOnline.Render("●")
	case "stopped", "errored", "stopping":
		dot = m.styles.StatusOffline.Render("●")
	default:
		dot = m.styles.HeaderStatus.Render("●")
	}
	name := padRight(p.Name, 18)
	status := padRight(strings.ToLower(p.Status), 8)
	uptime := padRight(humanDuration(time.Duration(p.Uptime)*time.Millisecond), 10)
	pid := ""
	if p.PID > 0 {
		pid = fmt.Sprintf("PID %d", p.PID)
	}
	cpu := ""
	if p.CPU > 0 {
		cpu = fmt.Sprintf("%d%%", p.CPU)
	}
	mem := ""
	if p.MemMB > 0 {
		mem = fmt.Sprintf("%dMB", p.MemMB)
	}
	restarts := ""
	if p.Restarts > 0 {
		restarts = fmt.Sprintf("↻%d", p.Restarts)
	}
	right := strings.Join(trimEmpty([]string{padRight(pid, 12), padRight(cpu, 5), padRight(mem, 7), restarts}), " ")
	return "  " + dot + " " + name + " " + status + " " + uptime + " " + right
}

// renderTop draws the "what's actually running" panel — the top entries
// of a `top`-style snapshot. Picks up bun/vite/node children that pm2's
// own list misses (they're spawned inside YHA-Bridge, not managed by pm2).
// Rows tagged "yha" get the accent colour so the YHA process tree pops
// out from the rest of the box.
func (m *dashboardModel) renderTop() string {
	header := m.styles.HeaderTitle.Render("Top processes")
	if m.snap == nil {
		return header + "\n" + m.styles.SystemText.Render("  (no data yet)")
	}
	if m.snap.TopError != "" {
		return header + "\n" + m.styles.ErrorText.Render("  "+m.snap.TopError)
	}
	if len(m.snap.Top) == 0 {
		return header + "\n" + m.styles.SystemText.Render("  (everything idle)")
	}
	var b strings.Builder
	b.WriteString(header)
	b.WriteByte('\n')
	for _, p := range m.snap.Top {
		b.WriteString(m.topRow(p))
		b.WriteByte('\n')
	}
	return strings.TrimRight(b.String(), "\n")
}

func (m *dashboardModel) topRow(p tuid.TopProc) string {
	pid := padRight(fmt.Sprintf("%d", p.PID), 6)
	cpu := padRight(fmt.Sprintf("%.1f%%", p.CPU), 6)
	mem := padRight(fmt.Sprintf("%dMB", p.MemMB), 7)
	cmd := padRight(truncate(p.Cmd, 10), 10)
	args := p.Args
	// Right-edge truncate to the remaining viewport width so the row
	// doesn't wrap. 6+6+7+10 + ~6 separators = ~35; reserve a bit more.
	maxArgs := m.viewport.Width - 40
	if maxArgs < 10 {
		maxArgs = 10
	}
	args = truncate(args, maxArgs)
	tag := "  "
	if p.Tag == "yha" {
		tag = m.styles.StatusOnline.Render("●")
		// We rendered a styled char + space externally; offset doesn't
		// need a separate pad because lipgloss styles consume their own
		// visible width correctly. Keep raw layout simple.
		tag = tag + " "
	}
	cmdStyled := cmd
	if p.Tag == "yha" {
		cmdStyled = lipgloss.NewStyle().Foreground(colorAccent).Render(cmd)
	}
	return "  " + tag + pid + " " + cpu + " " + mem + " " + cmdStyled + " " +
		m.styles.Hint.Render(args)
}

func (m *dashboardModel) renderGitTailscale() string {
	gitHeader := m.styles.HeaderTitle.Render("Git")
	tsHeader := m.styles.HeaderTitle.Render("Tailscale")

	gitBody := m.renderGitBody()
	tsBody := m.renderTailscaleBody()

	gitCol := gitHeader + "\n" + gitBody
	tsCol := tsHeader + "\n" + tsBody

	// Two columns side by side. The viewport handles wrapping if the
	// terminal is too narrow.
	colWidth := (m.viewport.Width - 4) / 2
	if colWidth < 30 {
		// Stack vertically on narrow terminals.
		return gitCol + "\n" + tsCol
	}
	gitStyled := lipgloss.NewStyle().Width(colWidth).Render(gitCol)
	tsStyled := lipgloss.NewStyle().Width(colWidth).Render(tsCol)
	return lipgloss.JoinHorizontal(lipgloss.Top, gitStyled, tsStyled)
}

func (m *dashboardModel) renderGitBody() string {
	if m.snap == nil || m.snap.Git == nil {
		return m.styles.SystemText.Render("  (no data)")
	}
	g := m.snap.Git
	head := g.Head
	if len(head) > 10 {
		head = head[:10]
	}
	dirty := m.styles.SystemText.Render("clean")
	if g.Dirty {
		dirty = m.styles.ToolResultBad.Render("dirty")
	}
	var b strings.Builder
	fmt.Fprintf(&b, "  branch  %s  ·  HEAD  %s  ·  %s\n",
		safe(g.Branch, "-"), safe(head, "-"), dirty)
	fmt.Fprintf(&b, "  staged %d   unstaged %d   untracked %d\n",
		g.Staged, g.Unstaged, g.Untracked)
	if g.Ahead > 0 || g.Behind > 0 {
		fmt.Fprintf(&b, "  ahead %d   behind %d\n", g.Ahead, g.Behind)
	}
	return strings.TrimRight(b.String(), "\n")
}

func (m *dashboardModel) renderTailscaleBody() string {
	if m.snap == nil || m.snap.Tailscale == nil {
		return m.styles.SystemText.Render("  (no data)")
	}
	t := m.snap.Tailscale
	if t.Error != "" {
		return m.styles.ErrorText.Render("  " + t.Error)
	}
	if !t.FunnelOK {
		return m.styles.SystemText.Render("  funnel  off")
	}
	target := t.FunnelTarget
	if target == "" {
		target = "(unknown target)"
	}
	return "  " + m.styles.StatusOnline.Render("funnel  on") +
		"  " + m.styles.Hint.Render(target)
}

func (m *dashboardModel) renderJobs() string {
	header := m.styles.HeaderTitle.Render("Recent jobs")
	if len(m.jobs) == 0 {
		body := m.styles.SystemText.Render("  (none)")
		return header + "\n" + body
	}
	// Newest first; cap to dashboardJobsCap so the pane stays compact.
	jobs := append([]tuid.JobInfo(nil), m.jobs...)
	sort.SliceStable(jobs, func(i, j int) bool {
		return jobs[i].StartedAt > jobs[j].StartedAt
	})
	if len(jobs) > dashboardJobsCap {
		jobs = jobs[:dashboardJobsCap]
	}
	var b strings.Builder
	b.WriteString(header)
	b.WriteByte('\n')
	for _, j := range jobs {
		b.WriteString(m.jobRow(j))
		b.WriteByte('\n')
	}
	return strings.TrimRight(b.String(), "\n")
}

func (m *dashboardModel) jobRow(j tuid.JobInfo) string {
	id := j.JobID
	if len(id) > 12 {
		id = id[:8] + "…"
	}
	id = padRight(id, 10)
	cmd := padRight(truncate(j.Cmd, 14), 14)
	status := padRight(j.Status, 14)
	switch j.Status {
	case tuid.JobDone:
		status = m.styles.StatusOnline.Render(padRight(j.Status, 14))
	case tuid.JobRunning:
		status = m.styles.ToolResultOK.Render(padRight(j.Status, 14))
	case tuid.JobFailed, tuid.JobOrphanedDead, tuid.JobOrphanedLive:
		status = m.styles.StatusOffline.Render(padRight(j.Status, 14))
	}
	when := time.UnixMilli(j.StartedAt).Format("15:04:05")
	tail := ""
	if j.ExitCode != nil {
		tail = fmt.Sprintf("exit=%d", *j.ExitCode)
	}
	origin := ""
	if j.Origin != "" {
		origin = m.styles.Hint.Render("  [" + j.Origin + "]")
	}
	return "  " + id + " " + cmd + " " + status + " " + when + "   " + tail + origin
}

// ── helpers ─────────────────────────────────────────────────────────────

func padRight(s string, n int) string {
	if len(s) >= n {
		return s
	}
	return s + strings.Repeat(" ", n-len(s))
}

func trimEmpty(xs []string) []string {
	out := xs[:0]
	for _, s := range xs {
		if strings.TrimSpace(s) != "" {
			out = append(out, s)
		}
	}
	return out
}

func safe(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

// humanDuration prints "1d2h", "3h12m", "45m", "12s" etc. — short
// enough to fit the row formatter without juggling units. Returns "-"
// for zero/negative durations.
func humanDuration(d time.Duration) string {
	if d <= 0 {
		return "-"
	}
	day := 24 * time.Hour
	switch {
	case d >= day:
		return fmt.Sprintf("%dd%dh", int(d/day), int((d%day)/time.Hour))
	case d >= time.Hour:
		return fmt.Sprintf("%dh%dm", int(d/time.Hour), int((d%time.Hour)/time.Minute))
	case d >= time.Minute:
		return fmt.Sprintf("%dm%ds", int(d/time.Minute), int((d%time.Minute)/time.Second))
	default:
		return fmt.Sprintf("%ds", int(d/time.Second))
	}
}

// isConnDead is a best-effort check on whether a polling error means
// the daemon connection is gone (so we should re-dial). Looks for the
// strings the daemon client surfaces when its readLoop ends.
func isConnDead(s string) bool {
	if s == "" {
		return false
	}
	for _, m := range []string{"closed", "broken pipe", "EOF", "use of closed"} {
		if strings.Contains(s, m) {
			return true
		}
	}
	return false
}

// ── tea.Cmd factories ───────────────────────────────────────────────────

func dialDaemon() tea.Cmd {
	return func() tea.Msg {
		// Cheap pre-flight: if the socket file isn't there, surface a
		// distinct hint instead of the generic "no such file or directory".
		// We still attempt to dial so the daemon can race ahead of us.
		c, err := tuid.Dial("")
		if err != nil {
			if _, sErr := net.Dial("unix", ""); sErr != nil {
				// Ignore — only used to differentiate; we already have err.
				_ = sErr
			}
			return dashboardConnMsg{err: friendlyDialErr(err)}
		}
		// Validate liveness right away so a stale socket gets demoted to
		// "offline" rather than "online but every status fails".
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		if pErr := c.Ping(ctx); pErr != nil {
			_ = c.Close()
			return dashboardConnMsg{err: friendlyDialErr(pErr)}
		}
		return dashboardConnMsg{client: c}
	}
}

// fireCommand parses a raw "cmd arg1 arg2…" line and dispatches it
// through the daemon. Returns a tea.Cmd that ultimately yields a
// dashboardFireMsg.
func fireCommand(c *tuid.Client, raw string) tea.Cmd {
	return func() tea.Msg {
		if c == nil {
			return dashboardFireMsg{err: "no daemon connection"}
		}
		fields := strings.Fields(raw)
		if len(fields) == 0 {
			return dashboardFireMsg{err: "empty command"}
		}
		name := fields[0]
		args := fields[1:]
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		jobID, err := c.RunCommand(ctx, name, args, "tui")
		if err != nil {
			return dashboardFireMsg{cmd: name, err: err.Error()}
		}
		return dashboardFireMsg{cmd: name, jobID: jobID}
	}
}

func shortID(id string) string {
	if len(id) <= 10 {
		return id
	}
	return id[:8] + "…"
}

func pollDashboard(c *tuid.Client) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		snap, err := c.Status(ctx)
		if err != nil {
			return dashboardSnapMsg{err: err.Error()}
		}
		jobs, jerr := c.ListJobs(ctx)
		if jerr != nil {
			// Status worked; surface the jobs error inline but keep the
			// snapshot so the panel doesn't blank.
			return dashboardSnapMsg{snap: snap, err: "jobs: " + jerr.Error()}
		}
		return dashboardSnapMsg{snap: snap, jobs: jobs}
	}
}

func scheduleDashboardTick(after time.Duration) tea.Cmd {
	return tea.Tick(after, func(time.Time) tea.Msg {
		return dashboardTickMsg{}
	})
}

func friendlyDialErr(err error) string {
	if err == nil {
		return ""
	}
	s := err.Error()
	// "dial unix /…/daemon.sock: connect: no such file or directory"
	if strings.Contains(s, "no such file") || errors.Is(err, errors.ErrUnsupported) {
		return "daemon socket not found — is YHA-TUI-Daemon running?"
	}
	if strings.Contains(s, "connection refused") {
		return "daemon socket present but not accepting (just restarted?)"
	}
	return s
}
