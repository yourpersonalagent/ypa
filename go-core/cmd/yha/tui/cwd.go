package tui

// cwd.go — CWD picker overlay.
//
// Same shape as the model picker (modal box centered over the body)
// but holds a single text input pre-filled with the active session's
// working directory. Enter submits a PATCH /v1/sessions/<id>; success
// re-renders the chat status line with the new path. Failure surfaces
// the bridge's 400 message ("Not a directory", "ENOENT …") inline so
// the user can fix the typo and retry without leaving the overlay.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// cwdAppliedMsg is dispatched after the PATCH completes. Carries the
// server-canonicalised path on success or an error string on failure.
type cwdAppliedMsg struct {
	sessionID string
	cwd       string
	err       string
}

// cwdContextMsg carries the bridge's /v1/cwd-context response so the
// picker overlay can preview what's already known about a typed path
// before the user commits.
type cwdContextMsg struct {
	cwd   string
	notes []string
	err   string
}

type cwdPicker struct {
	open       bool
	submitting bool
	input      textinput.Model
	sessionID  string
	err        string

	// preview of /v1/cwd-context for the path currently in the input.
	// Refreshed on a 400ms debounce as the user types.
	previewFor   string
	previewNotes []string
	previewErr   string
}

func newCwdPicker() cwdPicker {
	ti := textinput.New()
	ti.Placeholder = "/absolute/path/to/dir"
	ti.Prompt = "cwd › "
	ti.CharLimit = 0
	return cwdPicker{input: ti}
}

func (p *cwdPicker) isOpen() bool { return p.open }

// activate opens the picker pre-filled with the session's current cwd
// (or "" when the user is on an ephemeral session — in that case Enter
// returns an error since there's no session id to PATCH).
func (p *cwdPicker) activate(sessionID, currentCwd string) {
	p.open = true
	p.submitting = false
	p.err = ""
	p.sessionID = sessionID
	p.input.SetValue(currentCwd)
	p.input.Focus()
	p.input.CursorEnd()
}

func (p *cwdPicker) close() {
	p.open = false
	p.input.Blur()
}

// Update mirrors modelPicker.Update — returns (handled, cmd). Caller
// should NOT forward the message to other components when handled.
func (p *cwdPicker) Update(msg tea.Msg, c *http.Client, base string, opts Options) (bool, tea.Cmd) {
	switch msg := msg.(type) {
	case cwdAppliedMsg:
		p.submitting = false
		if msg.err != "" {
			p.err = msg.err
			return true, nil
		}
		// Closed by the root model; it'll also pick up the result and
		// push it into the chat panel via setActiveCwd.
		p.close()
		return true, nil
	case cwdContextMsg:
		// Only adopt the preview when it matches what's currently typed
		// (the user may have kept editing while the request was in flight).
		if msg.cwd != strings.TrimSpace(p.input.Value()) {
			return true, nil
		}
		p.previewFor = msg.cwd
		p.previewNotes = msg.notes
		p.previewErr = msg.err
		return true, nil
	case tea.KeyMsg:
		switch msg.String() {
		case "esc":
			p.close()
			return true, nil
		case "enter":
			val := strings.TrimSpace(p.input.Value())
			if val == "" {
				p.err = "path required"
				return true, nil
			}
			if p.sessionID == "" {
				p.err = "no active session — pick or create one first"
				return true, nil
			}
			p.submitting = true
			p.err = ""
			return true, patchSessionCwd(c, base, opts, p.sessionID, val)
		}
	}
	var cmd tea.Cmd
	prev := p.input.Value()
	p.input, cmd = p.input.Update(msg)
	// On user typing, schedule a context-preview fetch. Cheap to fire
	// a fresh request per keystroke — the bridge endpoint is in-process
	// — and we filter stale responses in the cwdContextMsg handler.
	val := strings.TrimSpace(p.input.Value())
	if val != prev && val != "" {
		ctxCmd := loadCwdContext(c, base, opts, val)
		if cmd != nil {
			cmd = tea.Batch(cmd, ctxCmd)
		} else {
			cmd = ctxCmd
		}
	}
	return true, cmd
}

func (p *cwdPicker) View(st Styles, width, height int) string {
	popW := width * 3 / 5
	if popW < 50 {
		popW = 50
	}
	if popW > width-4 {
		popW = width - 4
	}

	var body strings.Builder
	body.WriteString(st.HeaderTitle.Render("Pick working directory"))
	body.WriteString("\n\n")
	body.WriteString(p.input.View())
	body.WriteString("\n\n")
	switch {
	case p.submitting:
		body.WriteString(st.SystemText.Render("Applying…"))
	case p.err != "":
		body.WriteString(st.ErrorText.Render("Error: " + p.err))
	default:
		body.WriteString(st.Hint.Render(
			"Absolute path. Server validates exists + is a directory."))
	}
	// Preview the bridge's per-cwd notes when we have them — same data
	// the web frontend's CWD context drawer shows.
	if p.previewFor != "" && p.previewFor == strings.TrimSpace(p.input.Value()) {
		body.WriteString("\n\n")
		body.WriteString(st.Hint.Render("─ context for this cwd ─"))
		body.WriteString("\n")
		switch {
		case p.previewErr != "":
			body.WriteString(st.SystemText.Render("(no preview: " + p.previewErr + ")"))
		case len(p.previewNotes) == 0:
			body.WriteString(st.SystemText.Render("(no notes)"))
		default:
			max := 5
			if len(p.previewNotes) < max {
				max = len(p.previewNotes)
			}
			for i := 0; i < max; i++ {
				body.WriteString("• " + truncate(p.previewNotes[i], 80) + "\n")
			}
			if len(p.previewNotes) > max {
				body.WriteString(st.Hint.Render(
					fmt.Sprintf("(+%d more)", len(p.previewNotes)-max)))
			}
		}
	}
	body.WriteString("\n\n")
	body.WriteString(st.Hint.Render("Enter apply · Esc cancel"))

	frame := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder(), true).
		BorderForeground(colorAccent).
		Width(popW).
		Padding(1, 2).
		Render(body.String())
	return lipgloss.Place(width, height, lipgloss.Center, lipgloss.Center, frame,
		lipgloss.WithWhitespaceChars(" "))
}

// patchSessionCwd POSTs PATCH /v1/sessions/<id> with {workingDir: …}.
// On success it returns the server-canonicalised path; on 400 it
// surfaces the bridge's error string ("Not a directory", "ENOENT …").
func patchSessionCwd(c *http.Client, base string, opts Options, id, cwd string) tea.Cmd {
	return func() tea.Msg {
		bodyJSON, _ := json.Marshal(map[string]string{"workingDir": cwd})
		ctx, cancel := context.WithTimeout(context.Background(), 8*1e9) // 8 s
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, "PATCH",
			base+"/v1/sessions/"+id, bytes.NewReader(bodyJSON))
		if err != nil {
			return cwdAppliedMsg{sessionID: id, err: err.Error()}
		}
		req.Header.Set("Content-Type", "application/json")
		authHeader(req, opts)
		resp, err := c.Do(req)
		if err != nil {
			return cwdAppliedMsg{sessionID: id, err: err.Error()}
		}
		defer resp.Body.Close()
		raw, _ := readAll(resp)
		if resp.StatusCode >= 300 {
			// Bridge returns {success:false, error:"..."}; surface the
			// inner message so the user sees "Not a directory" rather
			// than "HTTP 400".
			var p struct {
				Error string `json:"error"`
			}
			if jerr := json.Unmarshal(raw, &p); jerr == nil && p.Error != "" {
				return cwdAppliedMsg{sessionID: id, err: p.Error}
			}
			return cwdAppliedMsg{sessionID: id,
				err: fmt.Sprintf("HTTP %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))}
		}
		var ok struct {
			WorkingDir string `json:"workingDir"`
		}
		_ = json.Unmarshal(raw, &ok)
		applied := ok.WorkingDir
		if applied == "" {
			applied = cwd
		}
		return cwdAppliedMsg{sessionID: id, cwd: applied}
	}
}

// loadCwdContext GETs /v1/cwd-context?cwd=<path> for the typed path
// and dispatches a cwdContextMsg with the bridge's per-cwd notes.
func loadCwdContext(c *http.Client, base string, opts Options, cwd string) tea.Cmd {
	return func() tea.Msg {
		listOpts := opts
		listOpts.Timeout = 4 * 1e9 // 4s
		body, status, err := jsonGET(c, base, "/v1/cwd-context?cwd="+urlEncode(cwd), listOpts)
		if err != nil {
			return cwdContextMsg{cwd: cwd, err: err.Error()}
		}
		if status >= 300 {
			return cwdContextMsg{cwd: cwd, err: fmt.Sprintf("HTTP %d", status)}
		}
		// Bridge shape: {notes:[{text:"…"}, …]} — fall back to a top-level
		// array of strings if that's what the implementation returns.
		var p struct {
			Notes []struct {
				Text string `json:"text"`
			} `json:"notes"`
		}
		if jerr := json.Unmarshal(body, &p); jerr == nil && len(p.Notes) > 0 {
			out := make([]string, 0, len(p.Notes))
			for _, n := range p.Notes {
				if t := strings.TrimSpace(n.Text); t != "" {
					out = append(out, t)
				}
			}
			return cwdContextMsg{cwd: cwd, notes: out}
		}
		var arr []string
		_ = json.Unmarshal(body, &arr)
		return cwdContextMsg{cwd: cwd, notes: arr}
	}
}

// urlEncode is a thin helper to escape the cwd query parameter without
// pulling net/url into a tight scope.
func urlEncode(s string) string {
	// Simple percent-encoding for the bytes that matter — the path
	// component is the most likely to contain spaces/specials.
	out := make([]byte, 0, len(s))
	for i := 0; i < len(s); i++ {
		b := s[i]
		switch {
		case (b >= 'a' && b <= 'z') || (b >= 'A' && b <= 'Z') ||
			(b >= '0' && b <= '9') || b == '-' || b == '_' || b == '.' || b == '~' || b == '/':
			out = append(out, b)
		default:
			out = append(out, '%',
				"0123456789ABCDEF"[b>>4],
				"0123456789ABCDEF"[b&0x0f])
		}
	}
	return string(out)
}

// readAll is a small helper around io.ReadAll that doesn't pull in
// extra imports at every callsite.
func readAll(r *http.Response) ([]byte, error) {
	const cap = 1 << 16 // 64 KiB ceiling — error responses are tiny
	buf := make([]byte, 0, 1024)
	tmp := make([]byte, 1024)
	for len(buf) < cap {
		n, err := r.Body.Read(tmp)
		if n > 0 {
			buf = append(buf, tmp[:n]...)
		}
		if err != nil {
			break
		}
	}
	return buf, nil
}
