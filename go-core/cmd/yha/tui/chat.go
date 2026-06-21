package tui

// chat.go — chat panel: viewport for transcript, textinput for the
// composer line. Submitting POSTs to either /v1/stream/ (default,
// harness path so the user's Claude Code subscription is billed
// instead of API credit) or /v1/stream-direct/ when --via=direct is
// passed. Pumps SSE chunks back into the bubbletea event loop as
// chunkMsg events.

import (
	"context"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/charmbracelet/bubbles/textinput"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// chunkMsg is one SSE event delivered into the bubbletea loop.
type chunkMsg struct {
	streamID  int  // identifies which stream this belongs to
	chunk     ssEChunk
	end       bool // sentinel: stream ended (peer or transport)
	transport string // non-empty when the failure was at the HTTP layer
}

// chatSessionLoadedMsg is dispatched by loadChatSession after the
// /v1/sessions/<id> fetch completes. It carries the bits we need to
// repopulate the chat transcript and status bar.
type chatSessionLoadedMsg struct {
	id         string
	name       string
	workingDir string
	turns      []turn
	err        string
}

// ssEChunk mirrors stream.Chunk on the wire — lowercase camelCase keys.
// We accept both "tool_use" and "toolUse" types for forward-compat.
//
// Heads-up: /v1/stream/ on the Node bridge doesn't always send a `type`
// field. Instead it broadcasts loose chunks that carry one or more of
// {text, delta, reasoning, toolUse, toolResult, error}. applyChunk
// below treats the absence of `type` as "infer from which field is
// populated". `_hb` heartbeat pings and the literal `[DONE]` sentinel
// are filtered out at the SSE pump layer.
type ssEChunk struct {
	Type       string         `json:"type,omitempty"`
	Text       string         `json:"text,omitempty"`
	Delta      string         `json:"delta,omitempty"`
	Reasoning  string         `json:"reasoning,omitempty"`
	ToolUse    map[string]any `json:"toolUse,omitempty"`
	ToolResult map[string]any `json:"toolResult,omitempty"`
	Error      string         `json:"error,omitempty"`
	DoneReason string         `json:"doneReason,omitempty"`
	Provider   string         `json:"provider,omitempty"`
	// Bridge-only field. _hb is the periodic heartbeat stamp the Node
	// side emits every 10 s on /v1/stream/. We check it != 0 to detect
	// a heartbeat-only frame and drop it from the transcript.
	HB int64 `json:"_hb,omitempty"`
	// _seq is the resume cursor. When the transport drops mid-stream we
	// re-attach via GET /v1/sessions/<id>/stream?since=<lastSeq> instead
	// of losing the in-flight assistant turn entirely.
	Seq int64 `json:"_seq,omitempty"`
}

// chatModel is the per-tab sub-model owned by the root Model.
type chatModel struct {
	opts     Options
	styles   Styles
	httpC    *http.Client
	endpoint string

	viewport viewport.Model
	input    textinput.Model

	// turns is the chat history. renderTranscript rebuilds the whole
	// string view from it, which re-runs lipgloss over every turn — so
	// the streaming path coalesces renders (transcriptCoalesceWindow) and
	// the root model skips them entirely while the chat tab is off-screen
	// instead of repainting on every SSE delta.
	turns []turn

	// activeSession is the SessionId we'll attach to the next stream-direct
	// POST. Empty means ephemeral. Set when the user picks one in the
	// Sessions tab.
	activeSession string

	// activeName / activeCwd come from the session detail fetch when the
	// user switches sessions. They power the status bar above the input
	// so the working directory is always visible — the web frontend
	// surfaces cwd prominently and the user wants TUI parity.
	activeName string
	activeCwd  string

	// serverDefaultCwd is whatever the bridge calls "defaultWorkingDir"
	// in the GET /v1/sessions/ envelope — same value the web frontend
	// uses when starting a new chat. We fetch it once at startup and
	// pre-fill activeCwd from it on `n` so a new session shows the
	// real cwd immediately instead of an empty status line.
	serverDefaultCwd string

	// Per-process synthetic SessionId seed (millis since epoch) used
	// when the user hasn't picked one — the bridge requires a SessionId
	// on /v1/stream/ posts so we coin one at chat-init time.
	sessionSeed string

	// selectedModel overrides opts.Model on the next send when non-empty.
	// Driven by the model picker overlay.
	selectedModel string

	// selectedProvider goes on the wire as `Provider` so the bridge
	// routes to the right row when a model has multiple (Anthropic-SUB
	// vs Anthropic-SUB2 vs Anthropic API). Without it the bridge falls
	// through to whichever provider findProvider() picks first — which
	// for Claude models with an ANTHROPIC_API_KEY set means the paid
	// API row, returning a 400 invalid_request_error on $0-credit keys.
	selectedProvider string

	// effort is the reasoning effort dial — empty / "low" / "medium" /
	// "high" / "max". Empty means "don't send Effort" (bridge default).
	effort string

	// Streaming state.
	streaming   bool
	streamID    int
	streamChan  chan chunkMsg
	cancelFunc  context.CancelFunc
	currentTurn int // index into turns of the in-flight assistant turn

	// lastSeq tracks the resume cursor (server-side _seq id). On a
	// transport drop mid-stream we GET /v1/sessions/<id>/stream?since=…
	// to pick up where we left off instead of losing the turn.
	lastSeq       int64
	resumeTries   int // bounded retry counter to avoid infinite loops
	resumePending bool

	// turnLines is the line-offset (within the rendered transcript) of
	// each entry in m.turns. Populated by refreshTranscript so Alt+Home
	// / Alt+End can step the viewport to the previous / next turn
	// boundary without re-counting newlines on every keystroke.
	turnLines []int

	// Render-coalescing state. visible mirrors whether the chat tab is the
	// active view (set by the root model on tab switch); dirty means turns
	// changed since the last render; lastRender + renderScheduled drive the
	// per-chunk coalescing window so a fast stream repaints at most once
	// per window while a paused or off-screen stream still keeps its turns
	// up to date and flushes on the next render. See renderTranscript.
	visible         bool
	dirty           bool
	lastRender      time.Time
	renderScheduled bool

	// width/height the panel was sized to.
	width, height int

	// liveErr surfaces the most recent transport failure so the user
	// sees something even if the stream never even started.
	liveErr string

	// loginRequested is set when the user typed exactly "/login" into
	// the composer. The root model drains it via popLoginRequested() so
	// it can pop the link-flow overlay — keeps the chat sub-model free
	// of references to the overlay package surface.
	loginRequested bool

	// cachedModels stashes the /v1/models/ rows so adoptDefaultProvider
	// can re-run when the active model id arrives (the loadModels and
	// loadActiveModels Cmds race at startup — whichever lands second
	// re-evaluates the provider so the chosen row matches whatever
	// model.activeModel() now returns).
	cachedModels []modelEntry
}

// turn is one rendered exchange or fragment in the transcript. We
// allow finer-grained types (toolUse, toolResult, error) so the
// renderer can stylise each one differently.
type turn struct {
	role    string // "user", "assistant", "tool", "tool_result", "reasoning", "error", "system"
	text    string
	toolID  string // for tool / tool_result
	toolOK  bool
	toolErr string
}

func newChatModel(opts Options, st Styles, c *http.Client, endpoint string) chatModel {
	ti := textinput.New()
	ti.Placeholder = "Type a message and press Enter…"
	ti.Prompt = "▶ "
	ti.CharLimit = 0
	ti.Focus()

	vp := viewport.New(80, 20)
	vp.SetContent("")

	welcome := "Welcome to YHA TUI. Type a message and press Enter."
	if opts.Via == "harness" {
		welcome += " (route: harness — uses Claude Code subscription, --via=direct to switch)"
	} else {
		welcome += " (route: direct API — burns provider credit)"
	}

	return chatModel{
		opts:        opts,
		styles:      st,
		httpC:       c,
		endpoint:    endpoint,
		viewport:    vp,
		input:       ti,
		sessionSeed: strconv.FormatInt(time.Now().UnixNano()/1e6, 10),
		turns: []turn{
			{role: "system", text: welcome},
		},
	}
}

func (m *chatModel) Init() tea.Cmd { return textinput.Blink }

// SetSize is called by the root model on WindowSizeMsg. Layout is:
//   viewport + 2 (panel border)
//   status line (1) — always reserved, painted with "(ephemeral)" when
//     no session is active so layout stays stable across session picks
//   input + 2 (input border, content + extra liveErr line if any)
//
// Input width math: the InputBorder panel takes (w-2) cols rendered;
// inside that, lipgloss subtracts 2 for the border and 2 for padding,
// leaving (w-6) cols of content area. textinput.View() emits
// `prompt + visible-value + cursor`, where the cursor consumes 1 cell
// when blink is on and 0 cells when off. We must size for the worst
// case (cursor visible) — otherwise the line wraps to a 2nd row only
// during the cursor's "on" half of the blink cycle, causing the
// jumping-input bug. So input.Width = content - prompt - 1(cursor).
func (m *chatModel) SetSize(w, h int) {
	m.width = w
	m.height = h
	inputBoxH := 3
	if h-inputBoxH < 5 {
		inputBoxH = 0
	}
	const statusH = 1
	vpH := h - inputBoxH - statusH - 2
	if vpH < 3 {
		vpH = 3
	}
	m.viewport.Width = w - 2
	m.viewport.Height = vpH
	promptW := lipgloss.Width(m.input.Prompt)
	inputW := w - 6 - promptW - 1
	if inputW < 10 {
		inputW = 10
	}
	m.input.Width = inputW
	m.refreshTranscript()
}

func (m *chatModel) inputFocused() bool { return m.input.Focused() }
func (m *chatModel) focus()             { m.input.Focus() }
func (m *chatModel) blur()              { m.input.Blur() }

// Headline returns the per-tab subheader components (title, contextual
// state bits, key hints). Rendered by the root model in the strip between
// the global tab bar and the tab body.
func (m chatModel) Headline() (string, []string, string) {
	bits := []string{}
	if name := m.activeSessionName(); name != "" {
		bits = append(bits, "● "+truncate(name, 28))
	} else {
		bits = append(bits, "(ephemeral)")
	}
	model := m.activeModel()
	if model == "" {
		model = "(default)"
	}
	bits = append(bits, "model "+truncate(model, 22))
	if prov := m.activeProvider(); prov != "" {
		bits = append(bits, "via "+truncate(prov, 18))
	}
	if m.effort != "" {
		bits = append(bits, "effort "+m.effort)
	}
	if m.streaming {
		bits = append(bits, "streaming…")
	}
	if n := len(m.turns); n > 0 {
		bits = append(bits, fmt.Sprintf("%d turn%s", n, plural(n)))
	}
	hint := "Esc: m model · e effort · c cwd · n new · i focus"
	return "Chat", bits, hint
}

// activeModel returns the model id we'll send on the next request.
// Picker overrides flag default; flag default overrides built-in.
func (m *chatModel) activeModel() string {
	if m.selectedModel != "" {
		return m.selectedModel
	}
	return m.opts.Model
}

// activeEffort returns the current reasoning-effort dial.
func (m *chatModel) activeEffort() string { return m.effort }

// cycleEffort advances the dial low → medium → high → max → low. The
// bridge accepts {low, medium, high, xhigh, max} (providers/core.ts);
// we expose the four most common settings here, skipping xhigh because
// most users want either a small bump or all-in. Cycling is always safe
// — non-reasoning models silently ignore Effort. A blank starting state
// maps to "low".
//
// We surface a system message after the change so the user gets visible
// confirmation regardless of whether the header re-renders or whether
// their terminal even delivered the alt+e keystroke at all.
func (m *chatModel) cycleEffort() {
	switch m.effort {
	case "":
		m.effort = "low"
	case "low":
		m.effort = "medium"
	case "medium":
		m.effort = "high"
	case "high":
		m.effort = "max"
	default:
		m.effort = "low"
	}
	m.appendSystem(fmt.Sprintf("effort → %s", m.effort))
}

// setSelectedModel is called by the model picker overlay on Enter.
// provider is the row's Provider column (e.g. "Anthropic-SUB2" or
// "Anthropic API") — needed so the bridge routes to the right billing
// path, not just the first row that has this model name.
func (m *chatModel) setSelectedModel(id, provider string) {
	m.selectedModel = id
	m.selectedProvider = provider
	if provider != "" {
		m.appendSystem(fmt.Sprintf("model → %s  (%s)", id, provider))
	} else {
		m.appendSystem(fmt.Sprintf("model → %s", id))
	}
}

// activeProvider returns the provider hint to attach to the next
// send. Empty means "let the bridge auto-resolve".
func (m *chatModel) activeProvider() string { return m.selectedProvider }

// adoptDefaultProvider sets selectedProvider from the /v1/models/ rows
// when the user hasn't explicitly picked one yet. Goal: avoid the
// paid-API path on first send for users who have a Claude Code
// subscription configured. We pick the first row whose Name matches
// the active model and whose Provider is a subscription instance
// (Anthropic-SUB[n] / OpenAI-SUB[n]); we only fall back to a non-SUB
// row if no subscription row exists. activeModel() returns the picker
// override when set or the flag/server default — so we look that up
// once and run the scan over the catalogue.
//
// No-op when m.selectedProvider is already set (picker selection wins).
func (m *chatModel) adoptDefaultProvider(models []modelEntry) {
	if len(models) > 0 {
		m.cachedModels = models
	}
	if m.selectedProvider != "" {
		return
	}
	want := m.activeModel()
	if want == "" {
		return
	}
	if len(models) == 0 {
		models = m.cachedModels
	}
	var subRow, fallbackRow *modelEntry
	for i := range models {
		if models[i].Name != want {
			continue
		}
		if isSubscriptionProviderName(models[i].Provider) {
			if subRow == nil {
				subRow = &models[i]
			}
			continue
		}
		if fallbackRow == nil {
			fallbackRow = &models[i]
		}
	}
	pick := subRow
	if pick == nil {
		pick = fallbackRow
	}
	if pick == nil {
		return
	}
	m.selectedProvider = pick.Provider
	m.appendSystem(fmt.Sprintf("auto-selected provider → %s (saves API credit)", pick.Provider))
}

// isSubscriptionProviderName reports whether the provider label refers
// to a Claude / OpenAI subscription instance (Anthropic-SUB,
// Anthropic-SUB2, OpenAI-SUB, OpenAI-SUB3, etc.). Mirrors the regex
// in bridge/providers/core.ts and go-core/internal/stream/route_proxy.go
// but inlined here so chat.go doesn't pick up a cross-module dep.
func isSubscriptionProviderName(p string) bool {
	if strings.HasPrefix(p, "Anthropic-SUB") {
		rest := p[len("Anthropic-SUB"):]
		return rest == "" || allDigits(rest)
	}
	if strings.HasPrefix(p, "OpenAI-SUB") {
		rest := p[len("OpenAI-SUB"):]
		return rest == "" || allDigits(rest)
	}
	return false
}

func allDigits(s string) bool {
	for _, r := range s {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// popLoginRequested returns true exactly once after the user typed
// "/login" in the composer. Root model uses it to pop the login
// overlay without the chat sub-model needing to know the overlay
// type. Self-clearing so a stale request doesn't fire twice.
func (m *chatModel) popLoginRequested() bool {
	v := m.loginRequested
	m.loginRequested = false
	return v
}

// setActiveSession swaps the chat panel to the picked session. It
// returns a tea.Cmd that fetches the full session detail so we can
// render the existing message history and pick up the working
// directory the server has on file. The web frontend does the
// equivalent on session click — this keeps TUI parity.
//
// We persist the id so the next TUI boot restores the same session
// (mirroring web's localStorage `currentSession`).
func (m *chatModel) setActiveSession(id string) tea.Cmd {
	m.activeSession = id
	m.activeName = ""
	m.activeCwd = ""
	m.turns = []turn{{role: "system", text: fmt.Sprintf("Loading session %s…", id)}}
	m.refreshTranscript()
	saveLastSessionID(id)
	return loadChatSession(m.httpC, m.endpoint, m.opts, id)
}

func (m *chatModel) resetForNewSession() {
	if m.streaming {
		m.cancelStream()
	}
	m.activeSession = ""
	m.activeName = ""
	m.activeCwd = ""
	m.turns = []turn{{role: "system", text: "New chat session (ephemeral)."}}
	m.input.Reset()
	m.refreshTranscript()
}

// activeSessionInfo returns the bits the root model paints in the
// status bar / header. Empty strings = unset.
func (m *chatModel) activeCwdPath() string { return m.activeCwd }
func (m *chatModel) activeSessionName() string {
	if m.activeName != "" {
		return m.activeName
	}
	return m.activeSession
}

// setCwd is called by the root model after the cwd picker successfully
// PATCH'd the session. We just stash the new value so the status line
// re-renders; the bridge owns the canonical value.
func (m *chatModel) setCwd(p string) {
	m.activeCwd = p
	m.appendSystem("cwd → " + p)
}

// startNewSession swaps the active session for a freshly synthesised
// id. The bridge persists sessions lazily on first POST /v1/stream/,
// so until the user types a message there's nothing to GET — we just
// set up a clean transcript locally and let the first send create the
// record server-side. cwd is pre-filled from serverDefaultCwd so the
// status line matches what the web frontend would show for a fresh
// chat (the bridge's defaultWorkingDir from GET /v1/sessions/).
func (m *chatModel) startNewSession() {
	if m.streaming {
		m.cancelStream()
	}
	m.activeSession = fmt.Sprintf("tui-%d", time.Now().UnixNano()/1e6)
	m.activeName = "new chat"
	m.activeCwd = m.serverDefaultCwd
	m.turns = []turn{
		{role: "system", text: "New session: " + m.activeSession},
	}
	if m.activeCwd != "" {
		m.turns = append(m.turns, turn{role: "system",
			text: "cwd (default): " + m.activeCwd + "  ·  press 'c' to change"})
	} else {
		m.turns = append(m.turns, turn{role: "system",
			text: "Type a message to materialise it on the server. Press 'c' to set cwd."})
	}
	m.input.Reset()
	m.refreshTranscript()
	saveLastSessionID(m.activeSession)
}

// setServerDefaultCwd is called by the root model after it fetches
// GET /v1/sessions/ and extracts the defaultWorkingDir field.
func (m *chatModel) setServerDefaultCwd(p string) {
	m.serverDefaultCwd = p
}

func (m *chatModel) cancelStream() {
	if m.cancelFunc != nil {
		m.cancelFunc()
	}
	m.streaming = false
	m.cancelFunc = nil
	m.streamChan = nil
}

// jumpToTurn moves the viewport's YOffset to the previous (dir = -1) or
// next (dir = +1) turn boundary relative to the current scroll position.
// turnLines is sorted ascending (refreshTranscript appends in order),
// so a linear scan is fine — the transcript fits in memory and scroll
// keys are not hot.
func (m *chatModel) jumpToTurn(dir int) {
	if len(m.turnLines) == 0 {
		return
	}
	cur := m.viewport.YOffset
	if dir < 0 {
		// Largest turn-start strictly less than the current position.
		// "Strictly less" so repeated Alt+Home actually steps back —
		// landing on the same row would feel like the key did nothing.
		target := 0
		for _, line := range m.turnLines {
			if line >= cur {
				break
			}
			target = line
		}
		m.viewport.SetYOffset(target)
		return
	}
	// dir > 0 — smallest turn-start strictly greater than current.
	for _, line := range m.turnLines {
		if line > cur {
			m.viewport.SetYOffset(line)
			return
		}
	}
	// Past the last turn boundary → snap to bottom so the user lands at
	// the most recent message instead of getting stuck.
	m.viewport.GotoBottom()
}

// Update handles per-tab key events + chunkMsg fanout.
func (m chatModel) Update(msg tea.Msg) (chatModel, tea.Cmd) {
	var cmds []tea.Cmd

	switch msg := msg.(type) {
	case tea.KeyMsg:
		switch msg.String() {
		case "enter":
			text := strings.TrimSpace(m.input.Value())
			if text == "" {
				break
			}
			// /login is intercepted BEFORE the message goes anywhere near
			// the LLM — otherwise the harness path interprets it as
			// Claude Code's own /login slash command and triggers an
			// unrelated browser flow. The root model drains
			// loginRequested and opens the link-flow overlay; we just
			// flag the request and consume the Enter key here.
			if text == "/login" {
				m.input.Reset()
				m.loginRequested = true
				m.appendSystem("(opening YHA TUI login overlay…)")
				return m, nil
			}
			// Mid-stream interjection: prefix "#btw " sends a btw message
			// to the bridge so the assistant can react without us having
			// to wait for the stream to finish. Web frontend has the
			// same affordance.
			if m.streaming && strings.HasPrefix(text, "#btw ") {
				body := strings.TrimSpace(strings.TrimPrefix(text, "#btw "))
				if body == "" {
					break
				}
				m.input.Reset()
				m.turns = append(m.turns, turn{role: "system", text: "↪ btw: " + body})
				m.refreshTranscript()
				cmds = append(cmds, sendBtw(m.httpC, m.endpoint, m.opts, m.activeSession, body))
				return m, tea.Batch(cmds...)
			}
			if m.streaming {
				break
			}
			m.input.Reset()
			m.turns = append(m.turns, turn{role: "user", text: text})
			m.turns = append(m.turns, turn{role: "assistant", text: ""})
			m.currentTurn = len(m.turns) - 1
			m.refreshTranscript()
			cmds = append(cmds, m.startStream(text))
			return m, tea.Batch(cmds...)
		case "esc":
			if m.streaming {
				m.cancelStream()
				m.appendSystem("(stream cancelled)")
				return m, nil
			}
			// Blur the composer so global keys (m, e, q) work without
			// `i` first; the user can press `i` or any printable key to
			// refocus.
			m.input.Blur()
			return m, nil
		case "pgup":
			m.viewport.HalfViewUp()
			return m, nil
		case "pgdown":
			m.viewport.HalfViewDown()
			return m, nil
		case "home":
			// Home: scroll to the very top of the transcript. Only
			// captured here when the input is unfocused or empty —
			// otherwise the textinput's own Home (cursor-to-start)
			// keeps working as a user expects.
			if m.input.Focused() && m.input.Value() != "" {
				break
			}
			m.viewport.GotoTop()
			return m, nil
		case "end":
			if m.input.Focused() && m.input.Value() != "" {
				break
			}
			m.viewport.GotoBottom()
			return m, nil
		case "alt+home":
			// Step backward to the previous turn boundary, regardless
			// of input focus — Alt+Home isn't a normal textinput key.
			m.jumpToTurn(-1)
			return m, nil
		case "alt+end":
			m.jumpToTurn(+1)
			return m, nil
		case "i":
			// vi-style: refocus the composer when input was blurred via
			// Esc. When already focused this falls through to textinput
			// which appends the literal `i`.
			if !m.input.Focused() {
				m.input.Focus()
				return m, textinput.Blink
			}
		}

	case chunkMsg:
		// Discard chunks belonging to an aborted earlier stream.
		if msg.streamID != m.streamID {
			return m, nil
		}
		if msg.transport != "" {
			// Try to resume if we have a session id + a known cursor.
			// At most one resume attempt — beyond that we surface the
			// error so the user can re-send manually.
			if m.activeSession != "" && m.lastSeq > 0 && m.resumeTries < 1 {
				m.resumeTries++
				m.resumePending = true
				m.appendSystem(fmt.Sprintf("↺ resuming from #%d after: %s", m.lastSeq, msg.transport))
				return m, m.resumeStream()
			}
			m.appendError("transport: " + msg.transport)
			m.streaming = false
			m.refreshTranscript()
			return m, nil
		}
		if msg.chunk.Seq > m.lastSeq {
			m.lastSeq = msg.chunk.Seq
		}
		m.applyChunk(msg.chunk)
		if msg.end {
			// Terminal chunk: force a full, immediate render so the
			// completed transcript is never left a frame behind by
			// coalescing.
			m.refreshTranscript()
			m.streaming = false
			m.cancelFunc = nil
			m.resumeTries = 0
			m.resumePending = false
			return m, nil
		}
		// Keep pumping chunks, but repaint at most once per coalesce
		// window (see transcriptCoalesceWindow) — scheduleTranscriptRender
		// renders now or returns a trailing flush Cmd.
		next := readNextChunk(m.streamChan)
		if flush := m.scheduleTranscriptRender(); flush != nil {
			return m, tea.Batch(next, flush)
		}
		return m, next

	case transcriptFlushMsg:
		// Trailing-edge flush for a coalesced streaming render. Repaint
		// the pending update if the tab is still visible; a flush left
		// over from a finished stream or a tab the user switched away from
		// is a harmless no-op.
		m.renderScheduled = false
		if m.dirty && m.visible {
			m.renderTranscript()
		}
		return m, nil

	case chatSessionLoadedMsg:
		// Ignore stale loads (user picked another session before this
		// fetch landed).
		if msg.id != m.activeSession {
			return m, nil
		}
		// Also stash for the root model's "push cwd into sessions filter"
		// path (we can't reach across sub-models from here).
		if msg.err != "" {
			// Saved-session restore lands here when the persisted id was
			// deleted server-side since the last TUI run. Treat as "no
			// previous session" and start fresh, the same way the web
			// would silently land on a fresh `s<timestamp>` if its
			// localStorage id had been cleared.
			if strings.Contains(msg.err, "404") || strings.Contains(msg.err, "not found") {
				m.startNewSession()
				m.appendSystem("(previous session no longer exists — started new)")
				return m, nil
			}
			m.turns = []turn{{role: "error", text: "session load: " + msg.err}}
			m.refreshTranscript()
			return m, nil
		}
		m.activeName = msg.name
		m.activeCwd = msg.workingDir
		// Replace the transcript with the loaded history. Keep a single
		// system header so the user knows what they're looking at.
		m.turns = m.turns[:0]
		header := "Session: " + msg.name
		if msg.id != "" {
			header += "  (" + msg.id + ")"
		}
		m.turns = append(m.turns, turn{role: "system", text: header})
		if msg.workingDir != "" {
			m.turns = append(m.turns, turn{role: "system", text: "cwd: " + msg.workingDir})
		}
		m.turns = append(m.turns, msg.turns...)
		m.refreshTranscript()
		// Land at the bottom — that's where the most recent messages
		// live and where the user will continue typing.
		m.viewport.GotoBottom()
		return m, nil
	}

	// Forward to inner components when not handled above.
	if m.input.Focused() {
		var cmd tea.Cmd
		m.input, cmd = m.input.Update(msg)
		if cmd != nil {
			cmds = append(cmds, cmd)
		}
	}
	var cmd tea.Cmd
	m.viewport, cmd = m.viewport.Update(msg)
	if cmd != nil {
		cmds = append(cmds, cmd)
	}
	return m, tea.Batch(cmds...)
}

// View renders the chat panel — viewport on top, status line, framed
// input below. Sizing is handled by SetSize from the root model on
// WindowSizeMsg; View only paints what's already laid out.
//
// Status bar shows session name + working directory so the user always
// sees which session and which cwd a stream POST will target — same
// affordance the web frontend gives in its session header.
func (m chatModel) View(w, h int) string {
	vp := m.styles.PanelBorder.Width(w - 2).Render(m.viewport.View())
	status := m.renderStatus(w)
	inputLine := m.input.View()
	if m.streaming {
		inputLine = m.styles.SystemText.Render("[streaming...] ") + inputLine
	}
	if m.liveErr != "" {
		inputLine = m.styles.ErrorText.Render(m.liveErr) + "\n" + inputLine
	}
	in := m.styles.InputBorder.Width(w - 2).Render(inputLine)
	return lipgloss.JoinVertical(lipgloss.Left, vp, status, in)
}

// renderStatus paints the "● <session>  ·  cwd: <path>" line between
// the transcript and the input. Always returns one line so SetSize's
// reserved row never goes unused — when no session is active we show
// "(ephemeral session — no cwd, no history)" so the user understands
// why the chat panel is empty.
func (m chatModel) renderStatus(w int) string {
	if m.activeSession == "" && m.activeCwd == "" {
		return m.styles.Hint.Width(w).
			Render("(ephemeral session — pick one in the Sessions tab to load cwd + history)")
	}
	var bits []string
	if name := m.activeSessionName(); name != "" {
		bits = append(bits, "● "+truncate(name, 30))
	}
	if cwd := m.activeCwd; cwd != "" {
		// Show the right-most segment of the path when the panel is
		// narrow — that's the most informative part (e.g. "yha-modular"
		// is more useful than "/home/user/yha").
		display := cwd
		max := w - 30
		if max < 20 {
			max = 20
		}
		if len(display) > max {
			display = "…" + display[len(display)-max+1:]
		}
		bits = append(bits, "cwd: "+display)
	}
	return m.styles.Hint.Width(w).Render(strings.Join(bits, "  ·  "))
}

// applyChunk merges one SSE chunk into the running transcript.
//
// /v1/stream-direct/ tags every chunk with a `type`; /v1/stream/ on the
// Node bridge usually doesn't and instead puts the payload directly on
// {text|delta|reasoning|toolUse|toolResult|error}. We fall through the
// switch when type is empty and check the fields below.
func (m *chatModel) applyChunk(c ssEChunk) {
	// Harness-path inference: a chunk without an explicit `type` carries
	// its meaning in whichever field is populated. Multiple fields can be
	// set on one chunk (e.g. delta + reasoning) so we handle each.
	if c.Type == "" {
		if c.Reasoning != "" {
			m.turns = append(m.turns, turn{role: "reasoning", text: c.Reasoning})
			m.turns = append(m.turns, turn{role: "assistant", text: ""})
			m.currentTurn = len(m.turns) - 1
		}
		if c.ToolUse != nil {
			m.applyToolUse(c.ToolUse)
		}
		if c.ToolResult != nil {
			m.applyToolResult(c.ToolResult)
		}
		if c.Error != "" {
			m.appendError(c.Error)
		}
		if c.Text != "" || c.Delta != "" {
			tx := c.Text
			if tx == "" {
				tx = c.Delta
			}
			if m.currentTurn >= 0 && m.currentTurn < len(m.turns) {
				m.turns[m.currentTurn].text += tx
			}
		}
		return
	}
	switch c.Type {
	case "delta":
		if m.currentTurn >= 0 && m.currentTurn < len(m.turns) {
			m.turns[m.currentTurn].text += c.Delta
		}
	case "text":
		if m.currentTurn >= 0 && m.currentTurn < len(m.turns) {
			m.turns[m.currentTurn].text += c.Text
		}
	case "reasoning":
		// Append as separate styled turn so it stays visually distinct.
		m.turns = append(m.turns, turn{role: "reasoning", text: c.Reasoning})
		// Open a fresh assistant turn for any subsequent deltas.
		m.turns = append(m.turns, turn{role: "assistant", text: ""})
		m.currentTurn = len(m.turns) - 1
	case "tool_use", "toolUse":
		m.applyToolUse(c.ToolUse)
	case "tool_result", "toolResult":
		m.applyToolResult(c.ToolResult)
	case "error":
		m.appendError(c.Error)
	case "done":
		// nothing — the end-flag in chunkMsg drives stream termination.
	}
}

// applyToolUse renders one toolUse chunk. Shared by the typed and
// harness-inferred branches of applyChunk.
func (m *chatModel) applyToolUse(tu map[string]any) {
	if tu == nil {
		return
	}
	name := ""
	args := ""
	id := ""
	if v, ok := tu["name"].(string); ok {
		name = v
	}
	if v, ok := tu["id"].(string); ok {
		id = v
	}
	if input, ok := tu["input"].(map[string]any); ok {
		args = summariseToolArgs(input)
	}
	m.turns = append(m.turns, turn{
		role:   "tool",
		text:   fmt.Sprintf("[tool: %s] %s", name, args),
		toolID: id,
	})
	m.turns = append(m.turns, turn{role: "assistant", text: ""})
	m.currentTurn = len(m.turns) - 1
}

// applyToolResult renders one toolResult chunk.
//
// Bridge contract (bridge/tools/stream.ts:339-343): a toolResult chunk
// is only emitted when the tool *succeeded*. Failures travel as
// {error: …} chunks, never as toolResult. So absence of an explicit
// `ok` flag must be read as success — defaulting to false here was a
// bug that painted every successful tool call as "✗ tool failed".
func (m *chatModel) applyToolResult(tr map[string]any) {
	if tr == nil {
		return
	}
	ok := true
	content := ""
	errStr := ""
	id := ""
	if v, vok := tr["ok"].(bool); vok {
		ok = v
	}
	if v, vok := tr["content"].(string); vok {
		content = v
	}
	if v, vok := tr["error"].(string); vok {
		errStr = v
		ok = false
	}
	if v, vok := tr["id"].(string); vok {
		id = v
	}
	m.turns = append(m.turns, turn{
		role:    "tool_result",
		text:    content,
		toolID:  id,
		toolOK:  ok,
		toolErr: errStr,
	})
}

func (m *chatModel) appendError(e string) {
	if e == "" {
		e = "stream error"
	}
	m.turns = append(m.turns, turn{role: "error", text: e})
}

func (m *chatModel) appendSystem(s string) {
	m.turns = append(m.turns, turn{role: "system", text: s})
	m.refreshTranscript()
}

// transcriptCoalesceWindow caps how often the streaming transcript is
// repainted. SSE deltas arrive far faster than a terminal can usefully
// redraw, and renderTranscript re-runs lipgloss over every turn
// (O(turns)), so without coalescing a long conversation streaming
// quickly burns CPU re-styling history on every token. We render at most
// once per window; the terminal chunk always forces a final render so
// the completed transcript is never left behind, and a stream that goes
// quiet mid-window flushes its tail via transcriptFlushMsg.
const transcriptCoalesceWindow = 60 * time.Millisecond

// transcriptFlushMsg is the trailing-edge flush for coalesced renders:
// scheduleTranscriptRender fires one (via tea.Tick) when it skips a
// render so the last tokens before a stream pause still land within
// transcriptCoalesceWindow instead of waiting for the next chunk.
type transcriptFlushMsg struct{}

// refreshTranscript renders the transcript when the chat tab is visible,
// otherwise just flags it dirty so show() rebuilds it on the next switch
// to the chat tab. Every one-shot caller (session load, system notes,
// resize, new/active session) funnels through here; only the hot
// per-chunk path uses scheduleTranscriptRender for time-coalescing.
func (m *chatModel) refreshTranscript() {
	if !m.visible {
		m.dirty = true
		return
	}
	m.renderTranscript()
}

// show marks the chat tab as the active view and flushes any render
// deferred while it was hidden. Called by the root model's refocus when
// m.tab becomes tabChat.
func (m *chatModel) show() {
	m.visible = true
	if m.dirty {
		m.renderTranscript()
	}
}

// hide marks the chat tab off-screen so refreshTranscript and the
// per-chunk path stop running lipgloss for a panel nobody is looking at.
// Streamed chunks still accumulate into m.turns; only the render is
// deferred until the next show().
func (m *chatModel) hide() {
	m.visible = false
}

// scheduleTranscriptRender is the per-chunk render gate. It renders
// immediately when the coalesce window has elapsed (and the tab is
// visible); otherwise it marks the transcript dirty and returns a Cmd
// that flushes the pending render after the window so a stream that
// pauses still shows its latest tokens. Returns nil when nothing needs
// scheduling (rendered now, off-screen, or a flush already pending).
func (m *chatModel) scheduleTranscriptRender() tea.Cmd {
	if !m.visible {
		m.dirty = true
		return nil
	}
	if time.Since(m.lastRender) >= transcriptCoalesceWindow {
		m.renderTranscript()
		return nil
	}
	m.dirty = true
	if m.renderScheduled {
		return nil
	}
	m.renderScheduled = true
	return tea.Tick(transcriptCoalesceWindow, func(time.Time) tea.Msg {
		return transcriptFlushMsg{}
	})
}

// renderTranscript re-renders the transcript into the viewport and
// records each turn's line offset in m.turnLines so Alt+Home / Alt+End
// can step turn-by-turn without rescanning. Only user messages and
// non-empty assistant replies are added to turnLines — tool calls,
// tool results, reasoning, system + error markers are intentionally
// skipped so the turn-nav keys feel like "previous/next message"
// rather than "previous/next event".
//
// This is the unconditional "rebuild now" primitive: it clears dirty and
// stamps lastRender. Callers should prefer refreshTranscript (visibility
// gated) or scheduleTranscriptRender (coalesced) on the hot path.
func (m *chatModel) renderTranscript() {
	var b strings.Builder
	m.turnLines = m.turnLines[:0]
	line := 0
	for _, t := range m.turns {
		// Empty in-flight assistant placeholder: don't render and don't
		// burn a turn-nav slot.
		if t.role == "assistant" && t.text == "" {
			continue
		}
		startLen := b.Len()
		// Only user + assistant turns count as jump targets. Recording
		// happens BEFORE writing so the offset points at the first row
		// of the turn.
		if t.role == "user" || t.role == "assistant" {
			m.turnLines = append(m.turnLines, line)
		}
		switch t.role {
		case "user":
			b.WriteString(m.styles.UserText.Render("You:") + " " + t.text)
		case "assistant":
			b.WriteString(m.styles.AssistantText.Render("Assistant:") + " " + t.text)
		case "reasoning":
			b.WriteString(m.styles.ReasoningText.Render("[thinking] " + truncate(t.text, 400)))
		case "tool":
			b.WriteString(m.styles.ToolBlock.Render(t.text))
		case "tool_result":
			label := m.styles.ToolResultOK.Render("✓ tool ok")
			if !t.toolOK {
				label = m.styles.ToolResultBad.Render("✗ tool failed")
			}
			body := truncate(strings.TrimSpace(t.text+t.toolErr), 200)
			if body != "" {
				body = "\n  " + body
			}
			b.WriteString(label + body)
		case "error":
			b.WriteString(m.styles.ErrorText.Render("Error: " + t.text))
		case "system":
			b.WriteString(m.styles.SystemText.Render(t.text))
		}
		b.WriteString("\n\n")
		// Count newlines added for this entry (including the trailing \n\n).
		line += strings.Count(b.String()[startLen:], "\n")
	}
	m.viewport.SetContent(b.String())
	m.viewport.GotoBottom()
	m.dirty = false
	m.lastRender = time.Now()
}

// resumeStream re-attaches to an interrupted SSE stream by GET'ing
// /v1/sessions/<id>/stream?since=<lastSeq>. Same chunk pump as
// startStream — the channel funnels chunkMsg events back into Update,
// where lastSeq tracking + applyChunk continue as if nothing happened.
func (m *chatModel) resumeStream() tea.Cmd {
	m.streamID++
	id := m.streamID
	ch := make(chan chunkMsg, 64)
	m.streamChan = ch
	m.streaming = true

	resp, cancel, err := getStream(m.httpC, m.endpoint, m.opts,
		fmt.Sprintf("/v1/sessions/%s/stream?since=%d", m.activeSession, m.lastSeq))
	if err != nil {
		m.streaming = false
		go func() {
			ch <- chunkMsg{streamID: id, transport: "resume: " + err.Error(), end: true}
			close(ch)
		}()
		return readNextChunk(ch)
	}
	m.cancelFunc = cancel
	go pumpSSE(resp, id, ch)
	return readNextChunk(ch)
}

// startStream kicks off the SSE request in a goroutine and returns the
// initial Cmd that pulls the first chunkMsg off the channel.
func (m *chatModel) startStream(text string) tea.Cmd {
	m.streamID++
	id := m.streamID
	ch := make(chan chunkMsg, 64)
	m.streamChan = ch
	m.streaming = true
	m.liveErr = ""

	via := m.opts.Via
	sid := m.activeSession
	if via != "direct" {
		sid = finalSessionID(m.activeSession, m.sessionSeed)
	}
	body := buildSendBody(via, text, m.activeModel(), sid, m.effort, m.activeProvider())

	resp, cancel, err := jsonPOSTStream(m.httpC, m.endpoint, streamPath(via), m.opts, body)
	if err != nil {
		m.streaming = false
		m.liveErr = err.Error()
		// Surface the error inline as one transcript chunk + finalise.
		go func() {
			ch <- chunkMsg{streamID: id, transport: err.Error(), end: true}
			close(ch)
		}()
		return readNextChunk(ch)
	}
	m.cancelFunc = cancel

	go pumpSSE(resp, id, ch)
	return readNextChunk(ch)
}

// readNextChunk / pumpSSE / authHint / summariseToolArgs / truncate live
// in wire.go alongside the body builders so the chat-loop file stays
// focused on bubbletea Update/View plumbing.
