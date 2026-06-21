package tui

// loginflow.go — in-TUI link-login overlay.
//
// Companion to login.go's pre-tea bootstrap. Some users will already
// have launched the TUI before realising they need a different bridge,
// or want to refresh an expired token without quitting. This overlay
// runs the same /auth/tui-link/start + /v1/tui-link/poll flow live —
// the URL renders inside the alt-screen as a centred modal so the user
// can grab it with their terminal's mouse-copy or click-to-open and
// approve in the browser without losing TUI state.
//
// Triggered from:
//   * Chat composer: typing exactly "/login" submits this overlay
//     instead of sending the text to the LLM (so the chat composer is
//     the natural entry point the user looked for).
//   * Dashboard command bar: typing ":login" (or "login") opens this
//     overlay instead of dispatching a daemon command.
//   * Global Esc+L / Alt+L: open from any tab, mirrors the
//     Esc+m/e/c/n shortcuts.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// osc52Copy writes the OSC 52 escape sequence to stdout so the terminal
// emulator (NOT the remote shell) puts the value on the local clipboard.
// Works over SSH, VS Code terminal, iTerm2, kitty, alacritty, wezterm,
// modern xterm. Bubbletea's alt-screen does not eat OSC sequences; the
// terminal processes them on receipt, even if the alt-screen redraws
// over the bytes a millisecond later.
//
// Returns true if the write went out. Best-effort: if stdout is closed
// or the terminal ignores OSC52 (Apple Terminal needs an opt-in pref),
// the call silently no-ops from the user's perspective. We still tell
// the user "copied" because we can't observe the terminal's response.
func osc52Copy(s string) bool {
	enc := base64.StdEncoding.EncodeToString([]byte(s))
	// `c` = clipboard selection; BEL terminator is the most compatible.
	seq := "\x1b]52;c;" + enc + "\x07"
	_, err := os.Stdout.WriteString(seq)
	return err == nil
}

// loginStartedMsg lands when /auth/tui-link/start returns. err non-empty
// means the start itself failed — the overlay surfaces it so the user
// can retry without leaving.
type loginStartedMsg struct {
	linkID string
	url    string
	err    string
}

// loginPollMsg lands after a single /v1/tui-link/poll/<id> round-trip.
type loginPollMsg struct {
	linkID    string
	status    string // pending | approved | denied | expired
	token     string
	expiresAt int64
	err       string
}

// loginTickMsg is the 2s ticker that drives polling while the overlay
// is on "pending".
type loginTickMsg struct {
	linkID string
}

// loginCompletedMsg is dispatched by the picker on a successful
// approval so the root model can adopt the new token into m.opts.Token.
type loginCompletedMsg struct {
	token string
}

type loginPicker struct {
	open bool

	starting bool
	linkID   string
	url      string

	status    string // pending | approved | denied | expired | error
	statusErr string

	// Persistent message at the bottom of the modal — surfaces the
	// outcome ("✓ approved · token saved") or the most recent error.
	flash string
}

func newLoginPicker() loginPicker {
	return loginPicker{}
}

func (p *loginPicker) isOpen() bool { return p.open }

// activate opens the picker and returns a Cmd that kicks off
// /auth/tui-link/start. The view shows a "starting…" line until the
// loginStartedMsg lands.
func (p *loginPicker) activate(c *http.Client, base string) tea.Cmd {
	p.open = true
	p.starting = true
	p.linkID = ""
	p.url = ""
	p.status = ""
	p.statusErr = ""
	p.flash = ""
	return startLogin(c, base)
}

func (p *loginPicker) close() {
	p.open = false
	p.starting = false
}

// Update mirrors cwdPicker.Update — returns (handled, cmd). Caller must
// not also forward to other components when handled.
func (p *loginPicker) Update(msg tea.Msg, c *http.Client, base string) (bool, tea.Cmd) {
	switch msg := msg.(type) {
	case loginStartedMsg:
		p.starting = false
		if msg.err != "" {
			p.status = "error"
			p.statusErr = msg.err
			p.flash = "start failed — press r to retry"
			return true, nil
		}
		p.linkID = msg.linkID
		p.url = msg.url
		p.status = "pending"
		p.flash = "waiting for browser approval…"
		return true, pollLogin(c, base, msg.linkID)

	case loginPollMsg:
		// Discard responses meant for a previous link (user pressed `r`).
		if msg.linkID != p.linkID {
			return true, nil
		}
		if msg.err != "" {
			// Transient network error — keep polling.
			p.flash = "poll error: " + msg.err + "  (retrying)"
			return true, scheduleLoginTick(msg.linkID)
		}
		switch msg.status {
		case "approved":
			p.status = "approved"
			p.flash = "✓ approved — token saved"
			saveCachedToken(base, cachedTuiToken{
				Token:     msg.token,
				ExpiresAt: msg.expiresAt,
			})
			// Surface the token up to the root model so it can adopt it
			// into m.opts.Token immediately (no relaunch needed).
			cmd := func() tea.Msg {
				return loginCompletedMsg{token: msg.token}
			}
			return true, cmd
		case "denied":
			p.status = "denied"
			p.flash = "✗ denied in browser — press r to retry"
			return true, nil
		case "expired":
			p.status = "expired"
			p.flash = "link expired — press r to retry"
			return true, nil
		default:
			// pending — schedule the next tick.
			return true, scheduleLoginTick(msg.linkID)
		}

	case loginTickMsg:
		if msg.linkID != p.linkID || p.status != "pending" {
			return true, nil
		}
		return true, pollLogin(c, base, msg.linkID)

	case tea.KeyMsg:
		switch msg.String() {
		case "esc", "q":
			p.close()
			return true, nil
		case "r":
			// Retry from the start endpoint — useful after denied/expired.
			p.starting = true
			p.linkID = ""
			p.url = ""
			p.status = ""
			p.statusErr = ""
			p.flash = "starting new link…"
			return true, startLogin(c, base)
		case "c", "y":
			// Copy URL to clipboard via OSC52 — works through SSH, VS Code
			// terminal, etc. `y` mirrors the vim-style yank some users reach
			// for first.
			if p.url == "" {
				return true, nil
			}
			if osc52Copy(p.url) {
				p.flash = "✓ URL copied to clipboard (paste in your browser)"
			} else {
				p.flash = "copy failed — select the URL with Shift+drag instead"
			}
			return true, nil
		}
	}
	return true, nil
}

// View renders the centred modal.
func (p *loginPicker) View(st Styles, width, height int) string {
	popW := width * 3 / 4
	if popW < 60 {
		popW = 60
	}
	if popW > width-4 {
		popW = width - 4
	}

	var body strings.Builder
	body.WriteString(st.HeaderTitle.Render("YHA TUI — Browser approval"))
	body.WriteString("\n\n")

	switch {
	case p.starting:
		body.WriteString(st.SystemText.Render("Asking the bridge for a fresh link…"))
	case p.status == "error":
		body.WriteString(st.ErrorText.Render("Start failed: " + p.statusErr))
		body.WriteString("\n\n")
		body.WriteString(st.Hint.Render("r retry · Esc cancel"))
	case p.url != "":
		body.WriteString("Open this URL in a browser where you're already logged in to YHA:")
		body.WriteString("\n\n")
		// Render the URL on its own line, styled — easier to grab with
		// mouse-select and obviously "this is the thing to copy".
		urlStyle := lipgloss.NewStyle().
			Foreground(colorAccent).
			Bold(true).
			Padding(0, 1)
		body.WriteString("  " + urlStyle.Render(p.url))
		body.WriteString("\n\n")
		body.WriteString(st.Hint.Render(
			"Press c to copy · or Shift+drag to select with the mouse"))
		body.WriteString("\n")
		body.WriteString(st.Hint.Render(
			"Pick a token lifetime in the browser (12h / 1d / 7d / 30d)."))
		body.WriteString("\n")

		// Status line — colour-coded by phase.
		switch p.status {
		case "pending":
			body.WriteString(st.SystemText.Render("◌ " + p.flash))
		case "approved":
			body.WriteString(st.StatusOnline.Render("● " + p.flash))
		case "denied", "expired":
			body.WriteString(st.ErrorText.Render("✗ " + p.flash))
		default:
			body.WriteString(st.Hint.Render(p.flash))
		}
		body.WriteString("\n\n")
		body.WriteString(st.Hint.Render(
			"c copy URL · r restart link · Esc close (token persists across restarts)"))
	}

	frame := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder(), true).
		BorderForeground(colorAccent).
		Width(popW).
		Padding(1, 2).
		Render(body.String())
	return lipgloss.Place(width, height, lipgloss.Center, lipgloss.Center, frame,
		lipgloss.WithWhitespaceChars(" "))
}

// ── network glue ───────────────────────────────────────────────────────────

func startLogin(c *http.Client, base string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
		defer cancel()
		payload, _ := json.Marshal(map[string]string{"label": "yha-tui"})
		req, err := http.NewRequestWithContext(ctx, "POST",
			base+"/auth/tui-link/start", bytes.NewReader(payload))
		if err != nil {
			return loginStartedMsg{err: err.Error()}
		}
		req.Header.Set("Content-Type", "application/json")
		resp, err := c.Do(req)
		if err != nil {
			return loginStartedMsg{err: err.Error()}
		}
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		if resp.StatusCode != 200 {
			return loginStartedMsg{err: fmt.Sprintf("HTTP %d: %s",
				resp.StatusCode, strings.TrimSpace(string(raw)))}
		}
		var out linkStartResp
		if jerr := json.Unmarshal(raw, &out); jerr != nil {
			return loginStartedMsg{err: jerr.Error()}
		}
		if out.LinkID == "" || out.URL == "" {
			return loginStartedMsg{err: "empty response from /auth/tui-link/start"}
		}
		return loginStartedMsg{linkID: out.LinkID, url: out.URL}
	}
}

func pollLogin(c *http.Client, base, linkID string) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 6*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, "GET",
			base+"/v1/tui-link/poll/"+linkID, nil)
		if err != nil {
			return loginPollMsg{linkID: linkID, err: err.Error()}
		}
		resp, err := c.Do(req)
		if err != nil {
			return loginPollMsg{linkID: linkID, err: err.Error()}
		}
		defer resp.Body.Close()
		raw, _ := io.ReadAll(resp.Body)
		if resp.StatusCode == 404 {
			return loginPollMsg{linkID: linkID, status: "expired"}
		}
		if resp.StatusCode != 200 {
			return loginPollMsg{linkID: linkID,
				err: fmt.Sprintf("HTTP %d", resp.StatusCode)}
		}
		var out linkPollResp
		if jerr := json.Unmarshal(raw, &out); jerr != nil {
			return loginPollMsg{linkID: linkID, err: jerr.Error()}
		}
		return loginPollMsg{
			linkID:    linkID,
			status:    out.Status,
			token:     out.Token,
			expiresAt: out.ExpiresAt,
		}
	}
}

func scheduleLoginTick(linkID string) tea.Cmd {
	return tea.Tick(2*time.Second, func(time.Time) tea.Msg {
		return loginTickMsg{linkID: linkID}
	})
}
