package tui

// notes.go — Notes tab. Mirrors the web frontend's NotePanel
// (frontend/src/NotePanel.tsx): a global list of every `#note`
// message across all sessions, fetched via GET /v1/sessions/notes
// (with optional ?q= for substring search).
//
// Enter on a hit jumps the chat panel to that note's source session
// — same affordance as clicking a note in the web popover. We don't
// reproduce the web's per-message scroll-flash; instead we just load
// the session and surface a system message identifying which note
// the user picked.
//
// We do NOT use /v1/important — that's the per-user "important
// notepad" widget, a different feature that lives in the web app's
// header. Confusingly named; nothing to do with chat #notes.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
)

// noteHit mirrors one entry returned by /v1/sessions/notes.
type noteHit struct {
	Text        string `json:"text"`
	Ts          int64  `json:"ts"`
	SessionID   string `json:"sessionId"`
	SessionName string `json:"sessionName"`
	MsgIdx      int    `json:"msgIdx"`
}

type notesLoadedMsg struct {
	notes []noteHit
	query string
	err   string
}

// notesPickedMsg is what the root model intercepts when the user hits
// Enter on a note — chat tab takes the sessionID and loads it, same
// flow as picking from the Sessions tab.
type notesPickedMsg struct {
	sessionID string
	noteText  string
	noteWhen  int64
}

type notesModel struct {
	opts     Options
	styles   Styles
	httpC    *http.Client
	endpoint string

	loading bool
	loaded  bool
	err     string
	notes   []noteHit
	cursor  int

	searchInput textinput.Model
	searching   bool
	lastQuery   string

	width  int
	height int

	pickedSession string
	pickedNote    string
}

func newNotesModel(opts Options, st Styles, c *http.Client, endpoint string) notesModel {
	si := textinput.New()
	si.Placeholder = "search notes…"
	si.Prompt = "/ "
	si.CharLimit = 0
	return notesModel{
		opts:        opts,
		styles:      st,
		httpC:       c,
		endpoint:    endpoint,
		searchInput: si,
	}
}

func (m *notesModel) Init() tea.Cmd { return nil }

func (m *notesModel) EnsureLoaded() tea.Cmd {
	if m.loaded || m.loading {
		return nil
	}
	m.loading = true
	return loadSessionNotes(m.httpC, m.endpoint, m.opts, "")
}

func (m *notesModel) SetSize(w, h int) {
	m.width = w
	m.height = h
}

// Headline returns the per-tab subheader components for the Notes tab.
func (m notesModel) Headline() (string, []string, string) {
	bits := []string{}
	switch {
	case m.loading:
		bits = append(bits, "loading…")
	case m.err != "":
		bits = append(bits, "error")
	case !m.loaded:
		bits = append(bits, "(press Tab/r to load)")
	default:
		bits = append(bits, fmt.Sprintf("%d note%s", len(m.notes), plural(len(m.notes))))
	}
	if m.lastQuery != "" {
		bits = append(bits, "query "+truncate(m.lastQuery, 24))
	}
	hint := "↑/↓ Enter open · / search · r reload"
	return "Notes", bits, hint
}

// popPickedSession returns and clears the most recent Enter-on-note
// selection so the root model can route the session into chat.
func (m *notesModel) popPickedSession() (string, string) {
	id, note := m.pickedSession, m.pickedNote
	m.pickedSession, m.pickedNote = "", ""
	return id, note
}

func (m notesModel) Update(msg tea.Msg) (notesModel, tea.Cmd) {
	switch msg := msg.(type) {
	case notesLoadedMsg:
		// Discard responses from a stale query (user kept typing).
		if msg.query != m.lastQuery {
			return m, nil
		}
		m.loading = false
		m.loaded = true
		if msg.err != "" {
			m.err = msg.err
			return m, nil
		}
		m.err = ""
		m.notes = msg.notes
		if m.cursor >= len(m.notes) {
			m.cursor = 0
		}
		return m, nil
	case tea.KeyMsg:
		// While searching, every key goes into the textinput; Enter
		// commits, Esc cancels.
		if m.searching {
			switch msg.String() {
			case "esc":
				m.searching = false
				m.searchInput.SetValue("")
				m.searchInput.Blur()
				m.lastQuery = ""
				m.loading = true
				return m, loadSessionNotes(m.httpC, m.endpoint, m.opts, "")
			case "enter":
				m.searching = false
				m.searchInput.Blur()
				q := strings.TrimSpace(m.searchInput.Value())
				m.lastQuery = q
				m.loading = true
				return m, loadSessionNotes(m.httpC, m.endpoint, m.opts, q)
			}
			var cmd tea.Cmd
			m.searchInput, cmd = m.searchInput.Update(msg)
			return m, cmd
		}
		switch msg.String() {
		case "up", "k":
			if m.cursor > 0 {
				m.cursor--
			}
			return m, nil
		case "down", "j":
			if m.cursor < len(m.notes)-1 {
				m.cursor++
			}
			return m, nil
		case "pgup":
			m.cursor -= 5
			if m.cursor < 0 {
				m.cursor = 0
			}
			return m, nil
		case "pgdown":
			m.cursor += 5
			if m.cursor >= len(m.notes) {
				m.cursor = len(m.notes) - 1
				if m.cursor < 0 {
					m.cursor = 0
				}
			}
			return m, nil
		case "home", "g":
			m.cursor = 0
			return m, nil
		case "end", "G":
			m.cursor = len(m.notes) - 1
			if m.cursor < 0 {
				m.cursor = 0
			}
			return m, nil
		case "enter":
			if m.cursor < len(m.notes) {
				h := m.notes[m.cursor]
				m.pickedSession = h.SessionID
				m.pickedNote = fmt.Sprintf("note from %s · %s",
					h.SessionName, time.UnixMilli(h.Ts).Format("2006-01-02 15:04"))
			}
			return m, nil
		case "/":
			m.searching = true
			m.searchInput.Focus()
			return m, textinput.Blink
		case "r":
			m.loading = true
			return m, loadSessionNotes(m.httpC, m.endpoint, m.opts, m.lastQuery)
		}

	case tea.MouseMsg:
		// Wheel moves the list cursor; ignored while the search prompt is active.
		if m.searching || msg.Action != tea.MouseActionPress {
			return m, nil
		}
		switch msg.Button {
		case tea.MouseButtonWheelUp:
			m.cursor -= 3
			if m.cursor < 0 {
				m.cursor = 0
			}
		case tea.MouseButtonWheelDown:
			m.cursor += 3
			if m.cursor >= len(m.notes) {
				m.cursor = len(m.notes) - 1
			}
			if m.cursor < 0 {
				m.cursor = 0
			}
		}
		return m, nil
	}
	return m, nil
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}

// View renders the Notes list inside the standard PanelBorder, mirroring
// the sessions tab's sizing trick (Height pads + MaxHeight crops). The
// list windows around the cursor so up/down navigation always keeps the
// highlighted row in view — earlier the viewport-based path stayed at
// scroll offset 0 and the cursor walked off the bottom of the panel.
func (m notesModel) View(w, h int) string {
	innerW := w - 6
	if innerW < 20 {
		innerW = 20
	}
	contentH := h - 2
	if contentH < 3 {
		contentH = 3
	}

	// TrimRight to keep lipgloss from counting a trailing newline as an
	// extra content row (same fix as rewind/mcp/sessions).
	body := strings.TrimRight(m.renderListBody(contentH, innerW), "\n")
	return m.styles.PanelBorder.
		Width(w - 2).
		Height(contentH).
		MaxHeight(h).
		Render(body)
}

// renderListBody draws the inner notes-list content sized to fit contentH
// rows × innerW cols. Pre-cropping every line keeps lipgloss from soft-
// wrapping rows into multiple visual lines (which would blow the row
// budget and push the cursor off-screen). Window math snaps the visible
// slice around m.cursor so navigation always keeps the highlighted note
// inside the frame.
func (m notesModel) renderListBody(contentH, innerW int) string {
	var b strings.Builder

	// Top hint / search input — always one row reserved.
	headerLines := 1
	if m.searching {
		b.WriteString(m.styles.SystemText.Render(crop(m.searchInput.View(), innerW)))
	} else {
		hint := "↑/↓ move · Enter open · / search · r reload"
		if m.lastQuery != "" {
			hint = fmt.Sprintf("query: %s   (Esc clears)", truncate(m.lastQuery, innerW-20))
		}
		b.WriteString(m.styles.Hint.Render(crop(hint, innerW)))
	}
	b.WriteByte('\n')

	if m.err != "" {
		b.WriteString(m.styles.ErrorText.Render(crop("Error: "+m.err, innerW)))
		b.WriteByte('\n')
		headerLines++
	}

	if m.loading {
		b.WriteString(m.styles.SystemText.Render(crop("Loading notes…", innerW)))
		return b.String()
	}
	if !m.loaded {
		b.WriteString(m.styles.SystemText.Render(crop("Press Tab/r to load notes.", innerW)))
		return b.String()
	}
	if len(m.notes) == 0 {
		if m.lastQuery != "" {
			b.WriteString(m.styles.SystemText.Render(
				crop(fmt.Sprintf("No #note messages match %q.", m.lastQuery), innerW)))
		} else {
			b.WriteString(m.styles.SystemText.Render(
				crop("No #note messages yet — type `#note <text>` in any chat.", innerW)))
		}
		return b.String()
	}

	// Each note row spans two lines (text + meta). Compute how many notes
	// fit inside the remaining body, leaving 2 rows for the ↑/↓ markers.
	const rowsPerNote = 2
	bodyRows := contentH - headerLines
	if bodyRows < rowsPerNote {
		bodyRows = rowsPerNote
	}
	visibleNotes := bodyRows / rowsPerNote
	if len(m.notes) > visibleNotes {
		// Reserve one row each for ↑/↓ markers when overflowing.
		visibleNotes = (bodyRows - 2) / rowsPerNote
		if visibleNotes < 1 {
			visibleNotes = 1
		}
	}

	start, end := windowAroundCursor(len(m.notes), m.cursor, visibleNotes)

	if start > 0 {
		b.WriteString(m.styles.Hint.Render(crop("  ↑ more above", innerW)))
		b.WriteByte('\n')
	}
	for i := start; i < end; i++ {
		h := m.notes[i]
		marker := "  "
		if i == m.cursor {
			marker = "> "
		}
		text := strings.ReplaceAll(strings.TrimSpace(h.Text), "\n", " ")
		// Crop the text line first by rune count so the row styles
		// (+padding 0,1) don't push us past innerW.
		line := crop(marker+text, innerW)
		if i == m.cursor {
			b.WriteString(m.styles.SelectedItem.Render(line))
		} else {
			b.WriteString(m.styles.ListItem.Render(line))
		}
		b.WriteByte('\n')
		meta := fmt.Sprintf("    %s · %s", h.SessionName,
			time.UnixMilli(h.Ts).Format("2006-01-02 15:04"))
		b.WriteString(m.styles.Hint.Render(crop(meta, innerW)))
		b.WriteByte('\n')
	}
	if end < len(m.notes) {
		b.WriteString(m.styles.Hint.Render(crop("  ↓ more below", innerW)))
		b.WriteByte('\n')
	}
	return b.String()
}

// loadSessionNotes GETs /v1/sessions/notes?q=<query> and dispatches a
// notesLoadedMsg. Mirrors the web NotePanel's fetch.
func loadSessionNotes(c *http.Client, base string, opts Options, query string) tea.Cmd {
	return func() tea.Msg {
		listOpts := opts
		listOpts.Timeout = 10 * time.Second
		path := "/v1/sessions/notes"
		if query != "" {
			path += "?q=" + urlEncode(query)
		}
		body, status, err := jsonGET(c, base, path, listOpts)
		if err != nil {
			return notesLoadedMsg{query: query, err: err.Error()}
		}
		if status >= 300 {
			return notesLoadedMsg{query: query, err: fmt.Sprintf("HTTP %d", status)}
		}
		var p struct {
			Notes []noteHit `json:"notes"`
		}
		if err := json.Unmarshal(body, &p); err != nil {
			return notesLoadedMsg{query: query, err: "parse: " + err.Error()}
		}
		return notesLoadedMsg{notes: p.Notes, query: query}
	}
}
