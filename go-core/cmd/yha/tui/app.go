package tui

// app.go — top-level bubbletea Model that owns the full screen.
//
// The Model composes two child sub-models (chatModel + sessionsModel)
// and dispatches Update calls to whichever tab is active. Window size
// changes propagate to both children so they can resize their viewports.
//
// Quit is bound to ctrl+c (always) and `q` (only when the chat input
// is unfocused — otherwise a literal `q` should be typeable into the
// prompt). Tab cycles tabActive forward; shift+tab cycles backward.

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"

	"github.com/yha/core/internal/ipc"
)

// Options carries TUI launch flags from the cmd/yha entry shim.
// Mirrors the subset of promptFlags the TUI actually uses, so the
// sub-package doesn't drag the whole flag struct across the boundary.
type Options struct {
	URL       string
	Token     string
	TokenFile string
	Socket    string
	Model     string
	Via       string // "direct" (default) → /v1/stream-direct/, "harness" → /v1/stream/ (Node-side route deleted in Phase 7; opt-in for legacy rollback only)
	Timeout   time.Duration
}

// Run is the public entry point. Returns the process exit code.
func Run(opts Options) int {
	if opts.Model == "" {
		opts.Model = "claude-opus-4-7"
	}
	// Phase 7: Node deleted /v1/stream/ (bridge/server.ts:124). Go's
	// /v1/stream-direct/ is the only live chat endpoint, so "direct" is
	// the default. We keep "harness" as an explicit opt-in for anyone
	// who has the Node route restored locally, but normalise everything
	// else (typos, empty string) to "direct" so the chat tab works on
	// first launch instead of 404-ing.
	if opts.Via != "harness" {
		opts.Via = "direct"
	}
	if opts.Timeout <= 0 {
		opts.Timeout = 10 * time.Minute
	}

	// Link-login bootstrap. Runs BEFORE tea.NewProgram so the URL prints
	// to plain stderr (with normal terminal scrollback) instead of being
	// fighting for screen space inside the alt-screen TUI. Skipped when
	// --token / --token-file is already set, when the bridge has auth
	// disabled, or when a live cached token from ~/.yha/tui-token.json
	// still works.
	if tok, err := EnsureAuthenticated(opts); err != nil {
		fmt.Fprintln(getStderr(), "yha tui: login failed:", err)
		return 1
	} else if tok != "" {
		opts.Token = tok
	}

	m := newModel(opts)
	p := tea.NewProgram(m, tea.WithAltScreen(), tea.WithMouseCellMotion())
	if _, err := p.Run(); err != nil {
		fmt.Fprintln(getStderr(), "yha tui:", err)
		return 1
	}
	return 0
}

// tabIndex distinguishes which panel currently has focus.
//
// Dashboard sits at index 0 because m1 of the TUI replacement plan
// (docs/YHA-TUI-Replacement-Plan.md §2) makes the service-status panel
// the default first screen for `./yha`.
type tabIndex int

const (
	tabDashboard tabIndex = iota
	tabChat
	tabSessions
	tabNotes
	tabRewind
	tabMCP // dim placeholder; inert in v1
	tabSecurity
)

const tabCount = 7

func (t tabIndex) Label() string {
	switch t {
	case tabDashboard:
		return "Dashboard"
	case tabChat:
		return "Chat"
	case tabSessions:
		return "Sessions"
	case tabNotes:
		return "Notes"
	case tabRewind:
		return "Rewind"
	case tabMCP:
		return "MCP"
	case tabSecurity:
		return "Security"
	}
	return "?"
}

// daemonStatus is the result of the startup /healthz probe.
type daemonStatus int

const (
	statusUnknown daemonStatus = iota
	statusOnline
	statusOffline
)

// healthMsg is dispatched after the startup probe finishes.
type healthMsg struct {
	status daemonStatus
	role   string // "native", "proxy", or ""
	err    string
}

// activeModelsMsg carries the bridge's current default-LLM choice so
// the TUI can sync with whatever the web frontend would use.
type activeModelsMsg struct {
	llmModel string
	err      string
}

// serverDefaultsMsg carries server-wide defaults the TUI wants to
// mirror (currently just defaultWorkingDir, the cwd the web frontend
// uses for fresh chats). Lifted from the GET /v1/sessions/ envelope.
type serverDefaultsMsg struct {
	defaultCwd string
	err        string
}

// Model is the root bubbletea model.
type Model struct {
	opts      Options
	styles    Styles
	width     int
	height    int
	tab       tabIndex
	dashboard dashboardModel
	chat      chatModel
	sessions  sessionsModel
	notes     notesModel
	rewind    rewindModel
	mcp       mcpModel
	security  securityModel
	picker    modelPicker
	cwdPicker cwdPicker
	login     loginPicker
	health    daemonStatus
	healthRl  string // headline role (dev/prod label) from X-Yha-Core
	httpC     *http.Client
	endpoint  string // base URL (or "http://yha-core" for unix)

	// bootRestoreDone gates the one-shot "restore last-used session
	// from disk" we run after the first serverDefaultsMsg lands. Don't
	// re-fire on later /v1/sessions/ refreshes — that would yank the
	// chat panel out from under the user.
	bootRestoreDone bool

	// activityCh is the live /v1/activity/stream feed channel. The pump
	// goroutine pushes activityBusyMsg frames here; Update re-issues
	// readActivity(activityCh) after each so the busy set stays current.
	// nil between a drop and the next reconnect. See activity.go.
	activityCh chan tea.Msg
}

func newModel(opts Options) Model {
	st := NewStyles()
	httpC, endpoint := buildClient(opts)
	dashboard := newDashboardModel(st)
	chat := newChatModel(opts, st, httpC, endpoint)
	sessions := newSessionsModel(opts, st, httpC, endpoint)
	notes := newNotesModel(opts, st, httpC, endpoint)
	rewind := newRewindModel(st)
	mcp := newMcpModel(opts, st, httpC, endpoint)
	security := newSecurityModel(opts, st, httpC, endpoint)
	return Model{
		opts:      opts,
		styles:    st,
		tab:       tabDashboard,
		dashboard: dashboard,
		chat:      chat,
		sessions:  sessions,
		notes:     notes,
		rewind:    rewind,
		mcp:       mcp,
		security:  security,
		picker:    newModelPicker(),
		cwdPicker: newCwdPicker(),
		login:     newLoginPicker(),
		health:    statusUnknown,
		httpC:     httpC,
		endpoint:  endpoint,
	}
}

// Init kicks off the startup probes and gives chat its initial focus.
// We pre-fetch:
//   * /healthz             daemon health badge
//   * /v1/active-models/   default LLM that the web frontend would use
//   * /v1/sessions/        envelope's defaultWorkingDir for new chats
// All in parallel so a slow fetch doesn't gate startup.
func (m Model) Init() tea.Cmd {
	return tea.Batch(
		m.dashboard.Init(),
		m.chat.Init(),
		m.sessions.Init(),
		probeHealth(m.httpC, m.endpoint, m.opts),
		loadActiveModels(m.httpC, m.endpoint, m.opts),
		loadServerDefaults(m.httpC, m.endpoint, m.opts),
		// Subscribe to the process-global busy feed so the Sessions list
		// shows live "running" state without a manual reload. Always-on
		// for the program lifetime — one SSE, pushed only on change.
		startActivity(m.httpC, m.endpoint, m.opts),
		// Eagerly load the full model catalogue so we can pre-populate
		// chatModel.selectedProvider with a subscription row before the
		// user opens the picker. Without this the first send hits the
		// paid-API path (Go's classifyRoute defaults to direct when
		// ANTHROPIC_API_KEY is set + no Provider hint).
		loadModels(m.httpC, m.endpoint, m.opts),
	)
}

// Update is the central dispatch. Global keys (tab nav, quit) are
// handled here; everything else is forwarded to the active sub-model.
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	// Activity feed handling sits ABOVE the overlay short-circuits: those
	// branches return early without re-issuing readActivity, so handling
	// the feed below them would stall the busy set whenever a picker is
	// open. These messages never need to reach a child tab.
	switch msg := msg.(type) {
	case activityReadyMsg:
		m.activityCh = msg.ch
		return m, readActivity(msg.ch)
	case activityBusyMsg:
		m.sessions.setBusy(msg.busy)
		if m.activityCh == nil {
			return m, nil
		}
		return m, readActivity(m.activityCh)
	case activityClosedMsg:
		m.activityCh = nil
		c, base, opts := m.httpC, m.endpoint, m.opts
		return m, tea.Tick(activityReconnectDelay, func(time.Time) tea.Msg {
			return startActivity(c, base, opts)()
		})
	}

	// Login picker short-circuits ABOVE the cwd/model overlays — the user
	// can pop it from anywhere and we don't want a stale cwd-picker focus
	// to swallow the keys.
	if m.login.isOpen() {
		switch msg := msg.(type) {
		case tea.WindowSizeMsg:
			m.width = msg.Width
			m.height = msg.Height
			bodyW, bodyH := m.bodyDims()
			m.dashboard.SetSize(bodyW, bodyH)
			m.chat.SetSize(bodyW, bodyH)
			m.sessions.SetSize(bodyW, bodyH)
			m.notes.SetSize(bodyW, bodyH)
			m.rewind.SetSize(bodyW, bodyH)
			m.mcp.SetSize(bodyW, bodyH)
			m.security.SetSize(bodyW, bodyH)
			return m, nil
		case tea.KeyMsg:
			if msg.String() == "ctrl+c" {
				return m, tea.Quit
			}
		case loginCompletedMsg:
			// Root-level: adopt the new token, close the picker, and tell
			// chat so it surfaces a confirmation in the transcript.
			m.opts.Token = msg.token
			m.chat.opts.Token = msg.token
			m.sessions.opts.Token = msg.token
			m.notes.opts.Token = msg.token
			m.mcp.opts.Token = msg.token
			m.security.opts.Token = msg.token
			m.login.close()
			m.chat.appendSystem("✓ TUI authenticated · token saved to ~/.yha/tui-token.json")
			m = m.refocus()
			return m, nil
		}
		handled, cmd := m.login.Update(msg, m.httpC, m.endpoint)
		if handled {
			return m, cmd
		}
		return m, nil
	}

	// CWD picker short-circuits — it owns input focus while open and
	// the result message lands here too so we can push it into chat.
	if m.cwdPicker.isOpen() {
		switch msg := msg.(type) {
		case tea.WindowSizeMsg:
			m.width = msg.Width
			m.height = msg.Height
			bodyW, bodyH := m.bodyDims()
			m.dashboard.SetSize(bodyW, bodyH)
			m.chat.SetSize(bodyW, bodyH)
			m.sessions.SetSize(bodyW, bodyH)
			m.notes.SetSize(bodyW, bodyH)
			m.rewind.SetSize(bodyW, bodyH)
			m.mcp.SetSize(bodyW, bodyH)
			m.security.SetSize(bodyW, bodyH)
			return m, nil
		case tea.KeyMsg:
			if msg.String() == "ctrl+c" {
				return m, tea.Quit
			}
		case cwdAppliedMsg:
			handled, cmd := m.cwdPicker.Update(msg, m.httpC, m.endpoint, m.opts)
			if msg.err == "" {
				m.chat.setCwd(msg.cwd)
				m.sessions.SetCwdFilter(msg.cwd)
			}
			if handled {
				return m, cmd
			}
		}
		handled, cmd := m.cwdPicker.Update(msg, m.httpC, m.endpoint, m.opts)
		if handled {
			return m, cmd
		}
		return m, nil
	}

	// Model picker overlay short-circuits everything except resize / health.
	// It owns input focus while open so typing doesn't bleed into the
	// chat composer behind it.
	if m.picker.isOpen() {
		switch msg := msg.(type) {
		case tea.WindowSizeMsg:
			m.width = msg.Width
			m.height = msg.Height
			bodyW, bodyH := m.bodyDims()
			m.dashboard.SetSize(bodyW, bodyH)
			m.chat.SetSize(bodyW, bodyH)
			m.sessions.SetSize(bodyW, bodyH)
			m.notes.SetSize(bodyW, bodyH)
			m.rewind.SetSize(bodyW, bodyH)
			m.mcp.SetSize(bodyW, bodyH)
			m.security.SetSize(bodyW, bodyH)
			return m, nil
		case healthMsg:
			m.health = msg.status
			m.healthRl = msg.role
			return m, nil
		case tea.KeyMsg:
			if msg.String() == "ctrl+c" {
				return m, tea.Quit
			}
		}
		handled, picked, cmd := m.picker.Update(msg)
		if picked.Name != "" {
			m.chat.setSelectedModel(picked.Name, picked.Provider)
			// Picker has already closed itself; restore chat focus.
			m = m.refocus()
		}
		if handled {
			return m, cmd
		}
		return m, nil
	}

	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		bodyW, bodyH := m.bodyDims()
		m.dashboard.SetSize(bodyW, bodyH)
		m.chat.SetSize(bodyW, bodyH)
		m.sessions.SetSize(bodyW, bodyH)
		m.notes.SetSize(bodyW, bodyH)
		m.rewind.SetSize(bodyW, bodyH)
		m.mcp.SetSize(bodyW, bodyH)
		m.security.SetSize(bodyW, bodyH)
		return m, nil

	case healthMsg:
		m.health = msg.status
		m.healthRl = msg.role
		return m, nil

	case activeModelsMsg:
		if msg.err == "" && msg.llmModel != "" && m.chat.selectedModel == "" {
			// Only adopt when the user hasn't explicitly picked anything
			// yet — picker selection should always win over server default.
			m.chat.opts.Model = msg.llmModel
			// Re-evaluate the auto-provider now that the active model id
			// is final. No-op if models haven't arrived yet (cached on
			// the chat model) or if selectedProvider is already set.
			m.chat.adoptDefaultProvider(nil)
		}
		return m, nil

	case serverDefaultsMsg:
		if msg.err == "" && msg.defaultCwd != "" {
			m.chat.setServerDefaultCwd(msg.defaultCwd)
		}
		// Boot-time session restore — mirrors the web frontend, which
		// reads `currentSession` from localStorage on startup. We've
		// just confirmed the daemon is reachable (the defaults probe
		// landed), so this is a safe moment to attempt the load.
		// Only fire on the first probe so re-fetches later don't keep
		// hijacking the active session.
		if !m.bootRestoreDone {
			m.bootRestoreDone = true
			if saved := loadLastSessionID(); saved != "" && m.chat.activeSession == "" {
				return m, m.chat.setActiveSession(saved)
			}
		}
		return m, nil

	case modelsLoadedMsg:
		// In case the load fires after the picker has been closed (rare,
		// but possible if the user dismissed mid-fetch) we still want to
		// stash the result so the next open is instant.
		_, _, cmd := m.picker.Update(msg)
		// Also pre-populate the chat sub-model's provider from the rows.
		// Picks a subscription row (Anthropic-SUB / OpenAI-SUB) over the
		// paid-API row for the active model so the first send doesn't
		// burn API credit — see chat.adoptDefaultProvider for the rule.
		if msg.err == "" {
			m.chat.adoptDefaultProvider(msg.models)
		}
		return m, cmd

	case dashboardConnMsg, dashboardSnapMsg, dashboardTickMsg, dashboardFireMsg:
		// Dashboard owns its polling lifecycle; route directly regardless
		// of which tab has focus so the panel keeps refreshing in the
		// background.
		var cmd tea.Cmd
		m.dashboard, cmd = m.dashboard.Update(msg)
		return m, cmd

	case tea.KeyMsg:
		switch msg.String() {
		case "ctrl+c":
			return m, tea.Quit
		case "tab":
			m.tab = (m.tab + 1) % tabIndex(tabCount)
			m = m.refocus()
			// Evaluate the lazy-load BEFORE the return so the
			// pointer-receiver mutation it does on m.sessions.loading
			// is observable in the returned model. With `return m,
			// m.maybeLazyLoad()` Go's evaluation order is unspecified
			// for non-function operands, which left the View showing
			// "Loading…" forever after the message handler raced past.
			cmd := m.maybeLazyLoad()
			return m, cmd
		case "shift+tab":
			m.tab = (m.tab + tabIndex(tabCount) - 1) % tabIndex(tabCount)
			m = m.refocus()
			cmd := m.maybeLazyLoad()
			return m, cmd
		case "q":
			// Only quit on bare 'q' when no input is focused — otherwise
			// typing the letter q would close the app while the user is
			// typing into a prompt or the dashboard command bar.
			if !m.chat.inputFocused() && !m.dashboard.inputFocused() && !m.rewind.inputFocused() {
				return m, tea.Quit
			}
		case "ctrl+n":
			// Clear active session id and chat history so the user is
			// effectively in a fresh context.
			m.chat.resetForNewSession()
			return m, nil
		case "m", "alt+m":
			// Open the model picker. The `alt+m` alias catches the case
			// where the user pressed Esc-then-m fast: bubbletea reads
			// the ESC byte + next byte as a single Alt-modified key
			// within the terminal's escape-sequence timeout (~100ms).
			// Without this alias, fast Esc+m falls through into the
			// blurred composer and the picker never opens — the same
			// flavour of "frozen UI" Esc+e produced before this fix.
			//
			// `alt+m` always opens (input might still be focused at the
			// instant alt+m fires, since Esc+m fires before our blur
			// settles); bare `m` only opens when the input is unfocused
			// so a literal `m` types into the prompt as expected.
			openOK := msg.String() == "alt+m" ||
				(m.tab == tabChat && !m.chat.inputFocused())
			if openOK && m.tab == tabChat {
				cmd := m.picker.activate(m.httpC, m.endpoint, m.opts)
				m.chat.blur()
				return m, cmd
			}
		case "e", "alt+e":
			// Effort cycle, with the same Esc-timing alias as `m`.
			cycleOK := msg.String() == "alt+e" ||
				(m.tab == tabChat && !m.chat.inputFocused())
			if cycleOK && m.tab == tabChat {
				m.chat.cycleEffort()
				return m, nil
			}
		case "i", "alt+i":
			// Refocus the composer (vi-style). bare `i` is also handled
			// by chat.go when input is unfocused; we add it here so that
			// the `alt+i` Esc-timing alias works the same way.
			if msg.String() == "alt+i" && m.tab == tabChat {
				m.chat.focus()
				return m, nil
			}
		case "c", "alt+c":
			// Open CWD picker. Same Esc-timing alias as `m`/`e`.
			openOK := msg.String() == "alt+c" ||
				(m.tab == tabChat && !m.chat.inputFocused())
			if openOK && m.tab == tabChat {
				m.cwdPicker.activate(m.chat.activeSession, m.chat.activeCwd)
				m.chat.blur()
				return m, nil
			}
		case "n", "alt+n":
			// New session: synthesise a fresh SessionId, reset the chat
			// transcript, leave activeCwd unset so the bridge falls back
			// to its default. The session record materialises server-
			// side on the first POST /v1/stream/.
			openOK := msg.String() == "alt+n" ||
				(m.tab == tabChat && !m.chat.inputFocused())
			if openOK && m.tab == tabChat {
				m.chat.startNewSession()
				return m, nil
			}
		case "L", "alt+L", "alt+l":
			// Open the login overlay. Works from any tab; the chat
			// composer's bare 'L' should still type the letter so we only
			// honour the keystroke when no input is currently focused (or
			// the user explicitly modifiered it with Alt).
			openOK := msg.String() == "alt+l" || msg.String() == "alt+L" ||
				(!m.chat.inputFocused() && !m.dashboard.inputFocused() &&
					!m.rewind.inputFocused())
			if openOK {
				cmd := m.login.activate(m.httpC, m.endpoint)
				m.chat.blur()
				return m, cmd
			}
		}
		// Forward to the active tab.
		var cmd tea.Cmd
		switch m.tab {
		case tabDashboard:
			m.dashboard, cmd = m.dashboard.Update(msg)
			if m.dashboard.popLoginRequested() {
				loginCmd := m.login.activate(m.httpC, m.endpoint)
				if loginCmd != nil {
					if cmd != nil {
						cmd = tea.Batch(cmd, loginCmd)
					} else {
						cmd = loginCmd
					}
				}
			}
		case tabChat:
			m.chat, cmd = m.chat.Update(msg)
			if m.chat.popLoginRequested() {
				loginCmd := m.login.activate(m.httpC, m.endpoint)
				m.chat.blur()
				if loginCmd != nil {
					if cmd != nil {
						cmd = tea.Batch(cmd, loginCmd)
					} else {
						cmd = loginCmd
					}
				}
			}
		case tabSessions:
			m.sessions, cmd = m.sessions.Update(msg)
			// Sessions tab can request a session-pick → push into chat,
			// and trigger the history+cwd load so the chat panel matches
			// the web app's "click session, see full transcript" UX.
			if id := m.sessions.popPickedSession(); id != "" {
				loadCmd := m.chat.setActiveSession(id)
				m.tab = tabChat
				m = m.refocus()
				if loadCmd != nil {
					if cmd != nil {
						cmd = tea.Batch(cmd, loadCmd)
					} else {
						cmd = loadCmd
					}
				}
			}
		case tabNotes:
			m.notes, cmd = m.notes.Update(msg)
			// Notes tab can request a session-pick on Enter — same
			// flow as the Sessions tab. Push it into chat and surface
			// which note the user picked as a transient marker.
			if id, note := m.notes.popPickedSession(); id != "" {
				loadCmd := m.chat.setActiveSession(id)
				m.chat.appendSystem("via " + note)
				m.tab = tabChat
				m = m.refocus()
				if loadCmd != nil {
					if cmd != nil {
						cmd = tea.Batch(cmd, loadCmd)
					} else {
						cmd = loadCmd
					}
				}
			}
		case tabRewind:
			m.rewind, cmd = m.rewind.Update(msg)
		case tabMCP:
			m.mcp, cmd = m.mcp.Update(msg)
		case tabSecurity:
			m.security, cmd = m.security.Update(msg)
		}
		return m, cmd

	case tea.MouseMsg:
		// Mouse-wheel scroll routes ONLY to the active tab. Left in the
		// default fan-out below it would (a) scroll every tab's viewport
		// and cursor at once and (b) never reach the dashboard, which the
		// fan-out deliberately skips. Mirrors the KeyMsg active-tab
		// dispatch above, minus the global shortcuts (wheel carries none).
		var cmd tea.Cmd
		switch m.tab {
		case tabDashboard:
			m.dashboard, cmd = m.dashboard.Update(msg)
		case tabChat:
			m.chat, cmd = m.chat.Update(msg)
		case tabSessions:
			m.sessions, cmd = m.sessions.Update(msg)
		case tabNotes:
			m.notes, cmd = m.notes.Update(msg)
		case tabRewind:
			m.rewind, cmd = m.rewind.Update(msg)
		case tabMCP:
			m.mcp, cmd = m.mcp.Update(msg)
		case tabSecurity:
			m.security, cmd = m.security.Update(msg)
		}
		return m, cmd

	default:
		// Non-key messages fan out to both children; both ignore what
		// they don't recognise. This keeps streaming chunks and timer
		// ticks landing in the right place.
		var cmds []tea.Cmd
		var cmd tea.Cmd
		m.chat, cmd = m.chat.Update(msg)
		if cmd != nil {
			cmds = append(cmds, cmd)
		}
		// After chat may have updated activeCwd from a session load,
		// push it into the sessions tab so 'f' (filter to same cwd)
		// works without manual cwd entry.
		if cwd := m.chat.activeCwd; cwd != "" {
			m.sessions.SetCwdFilter(cwd)
		}
		m.sessions, cmd = m.sessions.Update(msg)
		if cmd != nil {
			cmds = append(cmds, cmd)
		}
		m.notes, cmd = m.notes.Update(msg)
		if cmd != nil {
			cmds = append(cmds, cmd)
		}
		m.rewind, cmd = m.rewind.Update(msg)
		if cmd != nil {
			cmds = append(cmds, cmd)
		}
		m.mcp, cmd = m.mcp.Update(msg)
		if cmd != nil {
			cmds = append(cmds, cmd)
		}
		m.security, cmd = m.security.Update(msg)
		if cmd != nil {
			cmds = append(cmds, cmd)
		}
		// Sessions tab may have just picked a session for chat.
		if id := m.sessions.popPickedSession(); id != "" {
			if loadCmd := m.chat.setActiveSession(id); loadCmd != nil {
				cmds = append(cmds, loadCmd)
			}
		}
		// Notes tab too — Enter on a note also asks for a session jump.
		if id, note := m.notes.popPickedSession(); id != "" {
			if loadCmd := m.chat.setActiveSession(id); loadCmd != nil {
				cmds = append(cmds, loadCmd)
			}
			m.chat.appendSystem("via " + note)
		}
		return m, tea.Batch(cmds...)
	}
}

// refocus tells children to focus/blur their inputs based on m.tab, and
// flips the chat panel's visibility so it only re-renders the transcript
// while it's the active view (show() flushes any render deferred while
// hidden; hide() stops the per-chunk lipgloss work for an off-screen
// stream — chunks still accumulate, only the repaint is deferred).
func (m Model) refocus() Model {
	if m.tab == tabChat {
		m.chat.focus()
		m.chat.show()
	} else {
		m.chat.blur()
		m.chat.hide()
	}
	return m
}

// maybeLazyLoad triggers per-tab one-time loads when the user first
// visits a tab. Sessions, Notes, and MCP defer their fetches until
// this fires so a 401 doesn't show up at startup before the user
// knows what's wrong.
func (m *Model) maybeLazyLoad() tea.Cmd {
	switch m.tab {
	case tabSessions:
		return m.sessions.EnsureLoaded()
	case tabNotes:
		return m.notes.EnsureLoaded()
	case tabRewind:
		return m.rewind.EnsureLoaded()
	case tabMCP:
		return m.mcp.EnsureLoaded()
	case tabSecurity:
		return m.security.EnsureLoaded()
	}
	return nil
}

// View composes the header + per-tab subheader + active tab body + footer hint
// into one fixed-size string, padded to the current terminal dimensions.
func (m Model) View() string {
	if m.width == 0 || m.height == 0 {
		return "loading…"
	}
	header := m.renderHeader()
	subheader := m.renderTabSubheader()
	footer := m.renderFooter()
	bodyW, bodyH := m.bodyDims()
	var body string
	switch m.tab {
	case tabDashboard:
		body = m.dashboard.View(bodyW, bodyH)
	case tabChat:
		body = m.chat.View(bodyW, bodyH)
	case tabSessions:
		body = m.sessions.View(bodyW, bodyH)
	case tabNotes:
		body = m.notes.View(bodyW, bodyH)
	case tabRewind:
		body = m.rewind.View(bodyW, bodyH)
	case tabMCP:
		body = m.mcp.View(bodyW, bodyH)
	case tabSecurity:
		body = m.security.View(bodyW, bodyH)
	}
	main := lipgloss.JoinVertical(lipgloss.Left, header, subheader, body, footer)
	// Overlays repaint the whole frame so we don't have to deal with
	// layered terminals. Login picker outranks the cwd/model overlays —
	// the user can pop it from anywhere and the auth status matters more
	// than whatever lower picker happens to be lying around.
	if m.login.isOpen() {
		return m.login.View(m.styles, m.width, m.height)
	}
	if m.cwdPicker.isOpen() {
		return m.cwdPicker.View(m.styles, m.width, m.height)
	}
	if m.picker.isOpen() {
		return m.picker.View(m.styles, m.width, m.height)
	}
	return main
}

// renderHeader builds the top line:
//
//   YHA  [Chat] Sessions MCP   model: …  ·  effort: …    · dev●
//
// The middle "info" cluster shows the model and effort dial so the user
// can see what the next /v1/stream/ POST will use without opening any
// overlay. Status badge stays right-aligned.
func (m Model) renderHeader() string {
	title := m.styles.HeaderTitle.Render("YHA")
	statusStr := m.styles.HeaderStatus.Render(m.statusBadge())
	tabs := []string{}
	for i := tabDashboard; i <= tabSecurity; i++ {
		var s lipgloss.Style
		if i == m.tab {
			s = m.styles.TabActive
		} else {
			s = m.styles.TabInactive
		}
		label := i.Label()
		if i == m.tab {
			label = "[" + label + "]"
		}
		tabs = append(tabs, s.Render(label))
	}
	tabStrip := strings.Join(tabs, " ")

	model := m.chat.activeModel()
	if model == "" {
		model = "(default)"
	}
	effort := m.chat.activeEffort()
	if effort == "" {
		effort = "-"
	}
	via := m.opts.Via
	infoBits := []string{
		"model: " + model,
		"effort: " + effort,
		"via: " + via,
	}
	info := m.styles.HeaderStatus.Render("   " + strings.Join(infoBits, "  ·  ") + "   ")

	// Tab visibility is non-negotiable: if the joined title + tabs +
	// info + status would exceed m.width, lipgloss truncates from the
	// right and the user loses "Rewind" / "MCP" labels. So we measure
	// first and drop the info cluster when the tabs need the room.
	// (The same info is still discoverable: model/effort live in the
	// chat-tab footer hints and the model picker.)
	used := lipgloss.Width(title) + lipgloss.Width(tabStrip) +
		lipgloss.Width(info) + lipgloss.Width(statusStr)
	var top string
	if m.width > 0 && used > m.width {
		top = lipgloss.JoinHorizontal(lipgloss.Top, title, tabStrip, statusStr)
	} else {
		top = lipgloss.JoinHorizontal(lipgloss.Top, title, tabStrip, info, statusStr)
	}
	return m.styles.TabBar.Width(m.width).Render(top)
}

// renderFooter is one line of key hints. The "Esc, then …" framing is
// deliberate: chat-tab shortcuts (m / e / c / n) only fire when the
// composer is blurred — typing those letters into a prompt has to keep
// working. Esc blurs first, then the bare-letter shortcut fires;
// alt+m / alt+e / alt+c / alt+n also work for users on terminals that
// emit Alt as a modifier.
func (m Model) renderFooter() string {
	hints := "Esc, then m: model · e: effort · c: cwd · n: new · i: focus · L: login · Tab: switch · Ctrl+C/q: quit"
	switch m.tab {
	case tabDashboard:
		// Dashboard renders its own command legend; the footer
		// just carries the global navigation keys so we don't
		// repeat ":" / "r" hints in two places.
		hints = "Tab: switch tab  ·  Ctrl+C/q: quit"
	case tabSessions:
		hints = "↑/↓: move  ·  Enter: open  ·  Tab: back to chat  ·  Ctrl+C: quit"
	case tabRewind:
		hints = "↑/↓ move  ·  a: restore  ·  /: filter  ·  r: refresh  ·  Tab: switch  ·  Ctrl+C/q: quit"
	case tabSecurity:
		hints = "↑/↓ scroll  ·  PgUp/PgDn page  ·  g/G top/bot  ·  r refresh  ·  Tab switch  ·  Ctrl+C/q quit"
	}
	return m.styles.Hint.Width(m.width).Render(hints)
}

// statusBadge formats the daemon dot.
func (m Model) statusBadge() string {
	switch m.health {
	case statusOnline:
		role := "dev"
		if m.healthRl == "proxy" {
			role = "prod"
		}
		return m.styles.StatusOnline.Render(role + " ●")
	case statusOffline:
		return m.styles.StatusOffline.Render("offline ✗")
	default:
		return m.styles.HeaderStatus.Render("…")
	}
}

// bodyDims subtracts header (2) + subheader (1) + footer (1) from the
// screen height. The subheader is the per-tab contextual strip rendered
// between the global tab bar and the tab body — added in m2 of the TUI
// refresh so every tab announces its purpose and live state.
func (m Model) bodyDims() (int, int) {
	w := m.width
	h := m.height - 4
	if h < 5 {
		h = 5
	}
	return w, h
}

// renderTabSubheader produces the one-line strip rendered between the
// global tab bar and the active tab body. Title left, state bits in the
// middle (live counts, mode, cwd), key hints right. Every tab routes
// through here so the chrome is consistent — earlier only Dashboard and
// Sessions surfaced any contextual info inside the panel itself, which
// left Chat/Notes/Rewind/MCP feeling rudderless.
func (m Model) renderTabSubheader() string {
	title, bits, hints := m.tabHeadline()
	titleS := lipgloss.NewStyle().Foreground(colorAccent).Bold(true).Render(title)
	bitS := strings.Join(bits, "  ·  ")
	if bitS != "" {
		bitS = lipgloss.NewStyle().Foreground(colorMuted).Render("  ·  " + bitS)
	}
	hintS := ""
	if hints != "" {
		hintS = lipgloss.NewStyle().Foreground(colorMuted).Italic(true).Render(hints)
	}
	// Right-align the hints by padding the middle. If the line would
	// overflow, drop the hint cluster first (the footer also carries
	// global keys, so per-tab hints are nice-to-have, not load-bearing).
	leftRendered := titleS + bitS
	used := lipgloss.Width(leftRendered) + lipgloss.Width(hintS)
	if m.width > 0 && used+2 > m.width {
		// No room — keep title+state, drop hints.
		return lipgloss.NewStyle().Width(m.width).Padding(0, 1).Render(leftRendered)
	}
	gap := m.width - used - 2
	if gap < 1 {
		gap = 1
	}
	line := leftRendered + strings.Repeat(" ", gap) + hintS
	return lipgloss.NewStyle().Width(m.width).Padding(0, 1).Render(line)
}

// tabHeadline returns the per-tab subheader components for the active
// tab. Each tab knows its own live state — we just ask it.
func (m Model) tabHeadline() (title string, bits []string, hints string) {
	switch m.tab {
	case tabDashboard:
		return m.dashboard.Headline()
	case tabChat:
		return m.chat.Headline()
	case tabSessions:
		return m.sessions.Headline()
	case tabNotes:
		return m.notes.Headline()
	case tabRewind:
		return m.rewind.Headline()
	case tabMCP:
		return m.mcp.Headline()
	case tabSecurity:
		return m.security.Headline()
	}
	return "", nil, ""
}

// ── HTTP plumbing ──────────────────────────────────────────────────────────

// buildClient picks between Unix-socket and TCP/HTTPS based on opts.
// Stays self-contained so this sub-package can be imported without
// dragging the whole cmd/yha namespace along.
func buildClient(opts Options) (*http.Client, string) {
	if opts.URL != "" {
		return &http.Client{Timeout: opts.Timeout}, strings.TrimRight(opts.URL, "/")
	}
	socket := opts.Socket
	if socket == "" {
		socket = ipc.DefaultSocketPath()
	}
	return ipc.HTTPClientFor(socket), "http://yha-core"
}

// authHeader applies the bearer token when --url is in use.
func authHeader(req *http.Request, opts Options) {
	if t := tokenFromOpts(opts); t != "" {
		req.Header.Set("Authorization", "Bearer "+t)
	}
}

func tokenFromOpts(opts Options) string {
	if opts.Token != "" {
		return opts.Token
	}
	if opts.TokenFile != "" {
		if b, err := os.ReadFile(opts.TokenFile); err == nil {
			return strings.TrimSpace(string(b))
		}
	}
	return ""
}

func getStderr() io.Writer { return os.Stderr }

// loadServerDefaults GETs /v1/sessions/ and lifts the
// `defaultWorkingDir` field from the envelope so the chat panel can
// pre-populate the cwd for new sessions with the same value the web
// frontend uses. The session list itself is ignored here — the
// Sessions tab still does its own lazy fetch when first visited.
func loadServerDefaults(c *http.Client, base string, opts Options) tea.Cmd {
	return func() tea.Msg {
		listOpts := opts
		listOpts.Timeout = 5 * time.Second
		body, status, err := jsonGET(c, base, "/v1/sessions/", listOpts)
		if err != nil {
			return serverDefaultsMsg{err: err.Error()}
		}
		if status >= 300 {
			return serverDefaultsMsg{err: fmt.Sprintf("HTTP %d", status)}
		}
		var p struct {
			DefaultWorkingDir string `json:"defaultWorkingDir"`
		}
		if err := json.Unmarshal(body, &p); err != nil {
			return serverDefaultsMsg{err: err.Error()}
		}
		return serverDefaultsMsg{defaultCwd: p.DefaultWorkingDir}
	}
}

// loadActiveModels GETs /v1/active-models/ and dispatches an
// activeModelsMsg with the LLM model id (other categories — image,
// video, audio — aren't surfaced in the TUI yet).
func loadActiveModels(c *http.Client, base string, opts Options) tea.Cmd {
	return func() tea.Msg {
		listOpts := opts
		listOpts.Timeout = 5 * time.Second
		body, status, err := jsonGET(c, base, "/v1/active-models/", listOpts)
		if err != nil {
			return activeModelsMsg{err: err.Error()}
		}
		if status >= 300 {
			return activeModelsMsg{err: fmt.Sprintf("HTTP %d", status)}
		}
		var p struct {
			LLM struct {
				Model string `json:"model"`
			} `json:"llm"`
		}
		if err := json.Unmarshal(body, &p); err != nil {
			return activeModelsMsg{err: err.Error()}
		}
		return activeModelsMsg{llmModel: p.LLM.Model}
	}
}

// probeHealth pings /healthz once at startup.
func probeHealth(c *http.Client, base string, opts Options) tea.Cmd {
	return func() tea.Msg {
		ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
		defer cancel()
		req, err := http.NewRequestWithContext(ctx, "GET", base+"/healthz", nil)
		if err != nil {
			return healthMsg{status: statusOffline, err: err.Error()}
		}
		authHeader(req, opts)
		resp, err := c.Do(req)
		if err != nil {
			return healthMsg{status: statusOffline, err: err.Error()}
		}
		defer resp.Body.Close()
		_, _ = io.Copy(io.Discard, resp.Body)
		if resp.StatusCode >= 300 {
			return healthMsg{status: statusOffline, err: fmt.Sprintf("HTTP %d", resp.StatusCode)}
		}
		return healthMsg{
			status: statusOnline,
			role:   resp.Header.Get("X-Yha-Core"),
		}
	}
}

// jsonGET / jsonPOST helpers shared by chat + sessions models.

func jsonGET(c *http.Client, base, path string, opts Options) ([]byte, int, error) {
	ctx, cancel := context.WithTimeout(context.Background(), opts.Timeout)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, "GET", base+path, nil)
	if err != nil {
		return nil, 0, err
	}
	authHeader(req, opts)
	resp, err := c.Do(req)
	if err != nil {
		return nil, 0, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	return body, resp.StatusCode, err
}

// jsonPOSTStream POSTs and returns the live response without a body
// timeout — caller is responsible for closing resp.Body when the
// stream ends. Used by chat.go to consume SSE.
func jsonPOSTStream(c *http.Client, base, path string, opts Options, body any) (*http.Response, context.CancelFunc, error) {
	buf, err := json.Marshal(body)
	if err != nil {
		return nil, nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	req, err := http.NewRequestWithContext(ctx, "POST", base+path, bytes.NewReader(buf))
	if err != nil {
		cancel()
		return nil, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "text/event-stream, application/json")
	authHeader(req, opts)
	resp, err := c.Do(req)
	if err != nil {
		cancel()
		return nil, nil, err
	}
	return resp, cancel, nil
}
