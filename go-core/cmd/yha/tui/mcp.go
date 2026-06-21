package tui

// mcp.go — MCP tab. Two-pane like the Sessions tab: server list on
// the left, tool/prompt/resource detail for the highlighted server on
// the right. Same `s`/`x` keybindings the web frontend's MCP page
// offers — start a stopped server, stop a running one. Lazy-loaded
// on first tab visit so a 401 doesn't ambush the user at startup.
//
// Bridge contract (verified live with curl):
//
//   GET  /v1/mcp/                  → {success, servers:[{
//                                       name, command, args,
//                                       running, ok, error,
//                                       tools:[{name, desc, …}],
//                                       prompts, resources}…]}
//   POST /v1/mcp/<name>/start      → kicks off the child process
//   POST /v1/mcp/<name>/stop       → SIGTERMs it and waits

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type mcpTool struct {
	Name string `json:"name"`
	Desc string `json:"desc"`
}

type mcpServer struct {
	Name      string    `json:"name"`
	Command   string    `json:"command"`
	Args      []string  `json:"args"`
	Running   bool      `json:"running"`
	OK        bool      `json:"ok"`
	Error     string    `json:"error"`
	Tools     []mcpTool `json:"tools"`
	Prompts   []any     `json:"prompts"`
	Resources []any     `json:"resources"`
}

type mcpServersMsg struct {
	servers []mcpServer
	err     string
}

type mcpControlMsg struct {
	server string
	action string // "start" or "stop"
	err    string
}

type mcpModel struct {
	opts     Options
	styles   Styles
	httpC    *http.Client
	endpoint string

	loading bool
	loaded  bool
	err     string
	servers []mcpServer
	cursor  int
	flash   string

	detail viewport.Model
	width  int
	height int
}

func newMcpModel(opts Options, st Styles, c *http.Client, endpoint string) mcpModel {
	vp := viewport.New(40, 10)
	return mcpModel{
		opts:     opts,
		styles:   st,
		httpC:    c,
		endpoint: endpoint,
		detail:   vp,
	}
}

func (m *mcpModel) Init() tea.Cmd { return nil }

// Headline returns the per-tab subheader components for the MCP tab.
// Surfaces running/total server counts so the user can see at a glance
// how many MCP backends are alive without scrolling the list.
func (m mcpModel) Headline() (string, []string, string) {
	bits := []string{}
	switch {
	case m.loading:
		bits = append(bits, "loading…")
	case m.err != "":
		bits = append(bits, "error")
	case !m.loaded:
		bits = append(bits, "(press Tab/r to load)")
	default:
		running := 0
		tools := 0
		for _, s := range m.servers {
			if s.Running {
				running++
			}
			tools += len(s.Tools)
		}
		bits = append(bits, fmt.Sprintf("%d/%d running", running, len(m.servers)))
		bits = append(bits, fmt.Sprintf("%d tool%s", tools, plural(tools)))
	}
	hint := "↑/↓ · s start · x stop · r reload"
	return "MCP", bits, hint
}

func (m *mcpModel) EnsureLoaded() tea.Cmd {
	if m.loaded || m.loading {
		return nil
	}
	m.loading = true
	return loadMcpServers(m.httpC, m.endpoint, m.opts)
}

func (m *mcpModel) SetSize(w, h int) {
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
	m.detail.Width = detailW - 2
	m.detail.Height = h - 2
	if m.detail.Height < 1 {
		m.detail.Height = 1
	}
	m.refreshDetail()
}

func (m mcpModel) Update(msg tea.Msg) (mcpModel, tea.Cmd) {
	switch msg := msg.(type) {
	case mcpServersMsg:
		m.loading = false
		m.loaded = true
		if msg.err != "" {
			m.err = msg.err
			return m, nil
		}
		m.err = ""
		m.servers = msg.servers
		// Sort: running first, then by name. The web app does the same.
		sort.Slice(m.servers, func(i, j int) bool {
			if m.servers[i].Running != m.servers[j].Running {
				return m.servers[i].Running
			}
			return m.servers[i].Name < m.servers[j].Name
		})
		if m.cursor >= len(m.servers) {
			m.cursor = 0
		}
		m.refreshDetail()
		return m, nil
	case mcpControlMsg:
		if msg.err != "" {
			m.flash = msg.action + " " + msg.server + ": " + msg.err
		} else {
			m.flash = msg.action + " " + msg.server + " ok"
		}
		// Reload after a small delay so the bridge has time to reflect
		// the running/ok flag change.
		m.loading = true
		return m, tea.Tick(700*time.Millisecond, func(time.Time) tea.Msg {
			return mcpReloadMsg{}
		})
	case mcpReloadMsg:
		return m, loadMcpServers(m.httpC, m.endpoint, m.opts)
	case tea.KeyMsg:
		switch msg.String() {
		case "up", "k":
			if m.cursor > 0 {
				m.cursor--
				m.refreshDetail()
			}
			return m, nil
		case "down", "j":
			if m.cursor < len(m.servers)-1 {
				m.cursor++
				m.refreshDetail()
			}
			return m, nil
		case "r":
			m.loading = true
			return m, loadMcpServers(m.httpC, m.endpoint, m.opts)
		case "s":
			if len(m.servers) == 0 {
				return m, nil
			}
			s := m.servers[m.cursor]
			if s.Running {
				m.flash = s.Name + " already running"
				return m, nil
			}
			m.flash = "starting " + s.Name + "…"
			return m, controlMcp(m.httpC, m.endpoint, m.opts, s.Name, "start")
		case "x":
			if len(m.servers) == 0 {
				return m, nil
			}
			s := m.servers[m.cursor]
			if !s.Running {
				m.flash = s.Name + " not running"
				return m, nil
			}
			m.flash = "stopping " + s.Name + "…"
			return m, controlMcp(m.httpC, m.endpoint, m.opts, s.Name, "stop")
		}

	case tea.MouseMsg:
		// Wheel moves the server-list cursor and refreshes the detail pane.
		if msg.Action != tea.MouseActionPress {
			return m, nil
		}
		switch msg.Button {
		case tea.MouseButtonWheelUp:
			if m.cursor > 0 {
				m.cursor -= 3
				if m.cursor < 0 {
					m.cursor = 0
				}
				m.refreshDetail()
			}
		case tea.MouseButtonWheelDown:
			if m.cursor < len(m.servers)-1 {
				m.cursor += 3
				if m.cursor > len(m.servers)-1 {
					m.cursor = len(m.servers) - 1
				}
				m.refreshDetail()
			}
		}
		return m, nil
	}
	return m, nil
}

type mcpReloadMsg struct{}

func (m *mcpModel) refreshDetail() {
	if len(m.servers) == 0 || m.cursor >= len(m.servers) {
		m.detail.SetContent(m.styles.Hint.Render("(no servers — press 'r' to reload)"))
		return
	}
	s := m.servers[m.cursor]
	var b strings.Builder
	b.WriteString(m.styles.HeaderTitle.Render(s.Name))
	b.WriteString("\n")
	if s.Running {
		b.WriteString(m.styles.StatusOnline.Render("● running"))
	} else {
		b.WriteString(m.styles.StatusOffline.Render("○ stopped"))
	}
	if !s.OK && s.Error != "" {
		b.WriteString("  ")
		b.WriteString(m.styles.ErrorText.Render(s.Error))
	}
	b.WriteString("\n\n")
	if s.Command != "" {
		b.WriteString(m.styles.Hint.Render("command: "+s.Command) + "\n")
	}
	if len(s.Args) > 0 {
		b.WriteString(m.styles.Hint.Render("args: "+strings.Join(s.Args, " ")) + "\n")
	}
	b.WriteString("\n")
	if len(s.Tools) == 0 {
		b.WriteString(m.styles.SystemText.Render("no tools advertised"))
	} else {
		b.WriteString(m.styles.HeaderTitle.Render(fmt.Sprintf("tools (%d)", len(s.Tools))))
		b.WriteString("\n\n")
		for _, t := range s.Tools {
			b.WriteString("• ")
			b.WriteString(m.styles.UserText.Render(t.Name))
			b.WriteString("\n  ")
			desc := strings.ReplaceAll(t.Desc, "\n", " ")
			if len(desc) > 200 {
				desc = desc[:197] + "..."
			}
			b.WriteString(m.styles.Hint.Render(desc))
			b.WriteString("\n\n")
		}
	}
	m.detail.SetContent(b.String())
}

func (m mcpModel) View(w, h int) string {
	listW := w / 3
	if listW < 30 {
		listW = 30
	}
	detailW := w - listW
	if detailW < 20 {
		detailW = 20
	}
	contentH := h - 2
	if contentH < 3 {
		contentH = 3
	}
	// Inner crop budget: panel border+padding eats 4; each row style
	// (Hint, ListItem, SelectedItem) adds another 2 cols of horizontal
	// padding via Padding(0, 1). If we crop to listW-4 the rendered row
	// is listW-2 wide, which exceeds the PanelBorder wrap target of
	// listW-4 and lipgloss splits every row into 2 visual lines — the
	// list then overflows past the body and MaxHeight crops the bottom
	// border (the "list grows above interface, bottom not visible" bug).
	listInner := listW - 6
	if listInner < 10 {
		listInner = 10
	}

	// Strip the trailing newline that the row-by-row loop leaves behind:
	// lipgloss measures content height as `Count(s, "\n") + 1`, so a final
	// `\n` makes the panel one logical row too tall, MaxHeight then crops
	// the bottom border off (the "list overflows the panel" symptom).
	listContent := strings.TrimRight(m.renderListBody(contentH, listInner), "\n")
	detailContent := fitToHeight(m.detail.View(), contentH)
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

// renderListBody draws the inner left-pane content with a cursor-centred
// scroll window so a long server list doesn't overflow the panel — the
// earlier "loop every server" path produced the bug where the highlighted
// row could vanish off the bottom when more servers than visible rows
// were registered. Mirrors the sessions/rewind pattern: header at top
// (hint + flash + error), then a windowed slice of the list, with ↑/↓
// scroll markers when more entries exist outside the window.
func (m mcpModel) renderListBody(contentH, innerW int) string {
	var b strings.Builder
	headerLines := 1
	b.WriteString(m.styles.Hint.Render(crop(mcpHintFor(innerW), innerW)))
	b.WriteByte('\n')
	if m.flash != "" {
		b.WriteString(m.styles.SystemText.Render(crop(m.flash, innerW)))
		b.WriteByte('\n')
		headerLines++
	}

	switch {
	case m.loading:
		b.WriteString(m.styles.SystemText.Render(crop("Loading MCP servers…", innerW)))
		return b.String()
	case m.err != "":
		b.WriteString(m.styles.ErrorText.Render(crop("Error: "+m.err, innerW)))
		b.WriteByte('\n')
		b.WriteString(m.styles.Hint.Render(crop("Press 'r' to retry.", innerW)))
		return b.String()
	case len(m.servers) == 0:
		b.WriteString(m.styles.SystemText.Render(crop("No MCP servers configured.", innerW)))
		return b.String()
	}

	visible := contentH - headerLines
	if visible < 1 {
		visible = 1
	}
	// Reserve 2 rows for ↑/↓ markers when the list overflows the window.
	if len(m.servers) > visible {
		visible -= 2
		if visible < 1 {
			visible = 1
		}
	}
	start, end := windowAroundCursor(len(m.servers), m.cursor, visible)
	nameW := innerW - 12
	if nameW < 6 {
		nameW = 6
	}
	if start > 0 {
		b.WriteString(m.styles.Hint.Render(crop("  ↑ more above", innerW)))
		b.WriteByte('\n')
	}
	for i := start; i < end; i++ {
		s := m.servers[i]
		marker := "  "
		if i == m.cursor {
			marker = "> "
		}
		label := s.Name
		if len(label) > nameW {
			label = label[:nameW-3] + "..."
		}
		status := "○"
		if s.Running {
			status = "●"
		}
		line := crop(fmt.Sprintf("%s%s %-*s %2d tools",
			marker, status, nameW, label, len(s.Tools)), innerW)
		if i == m.cursor {
			b.WriteString(m.styles.SelectedItem.Render(line))
		} else {
			b.WriteString(m.styles.ListItem.Render(line))
		}
		b.WriteByte('\n')
	}
	if end < len(m.servers) {
		b.WriteString(m.styles.Hint.Render(crop("  ↓ more below", innerW)))
		b.WriteByte('\n')
	}
	return b.String()
}

func mcpHintFor(innerW int) string {
	switch {
	case innerW >= 50:
		return "↑/↓ move · s start · x stop · r reload"
	case innerW >= 30:
		return "↑/↓ s x r"
	default:
		return "↑/↓"
	}
}

// loadMcpServers GETs /v1/mcp/ and dispatches an mcpServersMsg.
func loadMcpServers(c *http.Client, base string, opts Options) tea.Cmd {
	return func() tea.Msg {
		listOpts := opts
		listOpts.Timeout = 8 * time.Second
		body, status, err := jsonGET(c, base, "/v1/mcp/", listOpts)
		if err != nil {
			return mcpServersMsg{err: err.Error()}
		}
		if status >= 300 {
			return mcpServersMsg{err: fmt.Sprintf("HTTP %d", status)}
		}
		var p struct {
			Servers []mcpServer `json:"servers"`
		}
		if err := json.Unmarshal(body, &p); err != nil {
			return mcpServersMsg{err: "parse: " + err.Error()}
		}
		return mcpServersMsg{servers: p.Servers}
	}
}

// controlMcp POSTs /v1/mcp/<name>/{start,stop}.
func controlMcp(c *http.Client, base string, opts Options, name, action string) tea.Cmd {
	return func() tea.Msg {
		req, err := http.NewRequest("POST",
			base+"/v1/mcp/"+name+"/"+action, bytes.NewReader([]byte("{}")))
		if err != nil {
			return mcpControlMsg{server: name, action: action, err: err.Error()}
		}
		req.Header.Set("Content-Type", "application/json")
		authHeader(req, opts)
		resp, err := c.Do(req)
		if err != nil {
			return mcpControlMsg{server: name, action: action, err: err.Error()}
		}
		defer resp.Body.Close()
		if resp.StatusCode >= 300 {
			return mcpControlMsg{server: name, action: action,
				err: fmt.Sprintf("HTTP %d", resp.StatusCode)}
		}
		return mcpControlMsg{server: name, action: action}
	}
}
