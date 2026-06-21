package tui

// models.go — Model picker overlay. Activated with `m` from the chat
// tab when the input is blurred. Reads /v1/models/ on first open and
// caches the result for the lifetime of the TUI process. Fuzzy filter
// via a textinput; Up/Down to navigate, Enter to select, Esc to close.

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"

	"github.com/charmbracelet/bubbles/textinput"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// modelEntry mirrors the relevant subset of /v1/models/ rows.
// We deliberately ignore pricing — the picker is about routing.
type modelEntry struct {
	Name      string `json:"name"`
	Provider  string `json:"provider"`
	Type      string `json:"type"`
	Vision    bool   `json:"vision"`
	Reasoning bool   `json:"reasoning"`
	Tools     bool   `json:"tools"`
}

// modelsLoadedMsg is dispatched after the first /v1/models/ fetch.
type modelsLoadedMsg struct {
	models []modelEntry
	err    string
}

type modelPicker struct {
	open    bool
	loaded  bool
	loading bool
	models  []modelEntry
	visible []int // indices into `models` after filtering
	cursor  int
	input   textinput.Model
	err     string

	// Capability filters — toggle on to restrict the list to models that
	// claim that capability. Multiple toggles AND together (matches the
	// web app: ticking [rsn] AND [tool] only shows models that do both).
	filterVis  bool
	filterRsn  bool
	filterTool bool
}

func newModelPicker() modelPicker {
	ti := textinput.New()
	ti.Placeholder = "filter (fuzzy)…"
	ti.Prompt = "/ "
	ti.CharLimit = 0
	return modelPicker{input: ti}
}

// activate opens the picker and (lazily) kicks the load.
// Returns a Cmd to schedule the network fetch when needed.
func (p *modelPicker) activate(c *http.Client, base string, opts Options) tea.Cmd {
	p.open = true
	p.input.Reset()
	p.input.Focus()
	p.cursor = 0
	p.refilter()
	if !p.loaded && !p.loading {
		p.loading = true
		return loadModels(c, base, opts)
	}
	return nil
}

// close hides the picker and releases textinput focus.
func (p *modelPicker) close() {
	p.open = false
	p.input.Blur()
}

// isOpen — convenience for the root model.
func (p *modelPicker) isOpen() bool { return p.open }

// pickedModel is what Update returns when the user accepts a row.
// We need both Name (to set the active model id) and Provider (so the
// bridge routes via Anthropic-SUBn / Codex-SUBn instead of falling
// through to the API-billed provider — which on $0-credit accounts
// returns a 400 invalid_request_error). Empty Name = no selection.
type pickedModel struct {
	Name     string
	Provider string
}

// Update handles picker-specific input. Caller must guard on isOpen()
// because the root model still owns global keys (Tab/Quit/etc).
//
// Returns (handled, picked, cmd). When handled is true, the root
// model should NOT forward the message to other components. When
// picked.Name is non-empty, the chat model takes it and the picker has
// already closed itself.
func (p *modelPicker) Update(msg tea.Msg) (bool, pickedModel, tea.Cmd) {
	switch msg := msg.(type) {
	case modelsLoadedMsg:
		p.loading = false
		p.loaded = true
		if msg.err != "" {
			p.err = msg.err
			return true, pickedModel{}, nil
		}
		p.err = ""
		p.models = msg.models
		// Sort: subscription-instance rows first (Anthropic-SUB* /
		// OpenAI-SUB*), then alphabetical by provider, then by model
		// name. Subscription routes don't burn API credit so they
		// belong at the top — alphabetic sort would otherwise put
		// "Anthropic API" ahead of "Anthropic-SUB" (space < dash in
		// ASCII), which steers the user toward the paid row.
		sort.SliceStable(p.models, func(i, j int) bool {
			si := isSubscriptionProviderName(p.models[i].Provider)
			sj := isSubscriptionProviderName(p.models[j].Provider)
			if si != sj {
				return si
			}
			if p.models[i].Provider != p.models[j].Provider {
				return p.models[i].Provider < p.models[j].Provider
			}
			return p.models[i].Name < p.models[j].Name
		})
		p.refilter()
		return true, pickedModel{}, nil
	case tea.KeyMsg:
		switch msg.String() {
		case "esc":
			p.close()
			return true, pickedModel{}, nil
		case "up", "ctrl+p":
			if p.cursor > 0 {
				p.cursor--
			}
			return true, pickedModel{}, nil
		case "down", "ctrl+n":
			if p.cursor < len(p.visible)-1 {
				p.cursor++
			}
			return true, pickedModel{}, nil
		case "enter":
			if len(p.visible) == 0 {
				return true, pickedModel{}, nil
			}
			m := p.models[p.visible[p.cursor]]
			p.close()
			return true, pickedModel{Name: m.Name, Provider: m.Provider}, nil
		// Capability-filter toggles. We use ctrl+ keys because the
		// textinput swallows printable letters (the user can type a
		// fuzzy filter alongside these toggles). ctrl+i is Tab in
		// terminals so we can't use it for img — pick ctrl+g (gambar /
		// graphics, freed up by textinput).
		case "ctrl+g":
			p.filterVis = !p.filterVis
			p.cursor = 0
			p.refilter()
			return true, pickedModel{}, nil
		case "ctrl+r":
			p.filterRsn = !p.filterRsn
			p.cursor = 0
			p.refilter()
			return true, pickedModel{}, nil
		case "ctrl+t":
			p.filterTool = !p.filterTool
			p.cursor = 0
			p.refilter()
			return true, pickedModel{}, nil
		}

	case tea.MouseMsg:
		// Wheel moves the model-list cursor.
		if msg.Action != tea.MouseActionPress {
			return true, pickedModel{}, nil
		}
		switch msg.Button {
		case tea.MouseButtonWheelUp:
			p.cursor -= 3
			if p.cursor < 0 {
				p.cursor = 0
			}
		case tea.MouseButtonWheelDown:
			p.cursor += 3
			if p.cursor > len(p.visible)-1 {
				p.cursor = len(p.visible) - 1
			}
			if p.cursor < 0 {
				p.cursor = 0
			}
		}
		return true, pickedModel{}, nil
	}
	// Forward to the textinput — typing updates the filter string.
	var cmd tea.Cmd
	prev := p.input.Value()
	p.input, cmd = p.input.Update(msg)
	if p.input.Value() != prev {
		p.cursor = 0
		p.refilter()
	}
	return true, pickedModel{}, cmd
}

// refilter rebuilds p.visible from the current input value and active
// capability toggles. Empty query → all rows pass the text filter.
// Non-empty → simple subsequence fuzzy match against "<provider>/<name>"
// (case-insensitive). Capability toggles AND together: e.g. filterRsn
// alone restricts to reasoning models; filterRsn + filterTool restricts
// to models that do both.
func (p *modelPicker) refilter() {
	q := strings.ToLower(strings.TrimSpace(p.input.Value()))
	p.visible = p.visible[:0]
	for i, m := range p.models {
		if m.Type != "" && m.Type != "llm" {
			// Image / video / audio models would clutter the chat picker.
			continue
		}
		if p.filterVis && !m.Vision {
			continue
		}
		if p.filterRsn && !m.Reasoning {
			continue
		}
		if p.filterTool && !m.Tools {
			continue
		}
		if q != "" {
			hay := strings.ToLower(m.Provider + "/" + m.Name)
			if !subseq(hay, q) {
				continue
			}
		}
		p.visible = append(p.visible, i)
	}
	if p.cursor >= len(p.visible) {
		p.cursor = 0
	}
}

// subseq returns true when `needle` appears as a subsequence of `hay`.
// Cheap and good enough for a couple-hundred-row picker — every char
// of needle must appear in hay in order, but not necessarily contiguous.
func subseq(hay, needle string) bool {
	if needle == "" {
		return true
	}
	hi, ni := 0, 0
	for hi < len(hay) && ni < len(needle) {
		if hay[hi] == needle[ni] {
			ni++
		}
		hi++
	}
	return ni == len(needle)
}

// View renders the picker as a centered overlay. Caller composes it
// over the main body. `width`/`height` are the full screen dims;
// the popup occupies a centered band roughly 60% wide / 60% tall.
func (p *modelPicker) View(st Styles, width, height int) string {
	popW := width * 3 / 5
	if popW < 40 {
		popW = 40
	}
	if popW > width-4 {
		popW = width - 4
	}
	popH := height * 3 / 5
	if popH < 12 {
		popH = 12
	}
	if popH > height-4 {
		popH = height - 4
	}

	var body strings.Builder
	body.WriteString(st.HeaderTitle.Render("Model picker"))
	body.WriteString("  ")
	body.WriteString(p.renderFilterChips(st))
	body.WriteString("\n")
	body.WriteString(p.input.View())
	body.WriteString("\n\n")

	switch {
	case p.loading:
		body.WriteString(st.SystemText.Render("Loading models…"))
	case p.err != "":
		body.WriteString(st.ErrorText.Render("Error: " + p.err))
	case len(p.visible) == 0:
		body.WriteString(st.SystemText.Render("No matches."))
	default:
		// Show a window of rows around the cursor. We have popH-6 rows
		// to play with (header + input + spacer + footer hint).
		windowRows := popH - 7
		if windowRows < 4 {
			windowRows = 4
		}
		start := p.cursor - windowRows/2
		if start < 0 {
			start = 0
		}
		end := start + windowRows
		if end > len(p.visible) {
			end = len(p.visible)
			if end-windowRows > 0 {
				start = end - windowRows
			} else {
				start = 0
			}
		}
		for i := start; i < end; i++ {
			m := p.models[p.visible[i]]
			line := formatModelRow(m, popW-6)
			if i == p.cursor {
				body.WriteString(st.SelectedItem.Render(line))
			} else {
				body.WriteString(st.ListItem.Render(line))
			}
			body.WriteString("\n")
		}
	}
	body.WriteString("\n")
	body.WriteString(st.Hint.Render("↑/↓ move · Enter pick · Esc cancel · type to filter · ^G img · ^R rsn · ^T tool"))

	frame := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder(), true).
		BorderForeground(colorAccent).
		Width(popW).
		Padding(1, 2).
		Render(body.String())

	// lipgloss.Place centers the popup on the full screen. We pad with
	// transparent runes so the underlying view still shows through the
	// gaps — bubbletea repaints the whole frame anyway.
	return lipgloss.Place(width, height, lipgloss.Center, lipgloss.Center, frame,
		lipgloss.WithWhitespaceChars(" "))
}

// renderFilterChips renders the three capability filters as toggleable
// chips. Active chips are highlighted (selected style) so the user can
// see at a glance which filters are restricting the visible list.
func (p *modelPicker) renderFilterChips(st Styles) string {
	chip := func(label string, active bool) string {
		text := "[" + label + "]"
		if active {
			return st.SelectedItem.Render(text)
		}
		return st.ListItem.Render(text)
	}
	return strings.Join([]string{
		chip("img", p.filterVis),
		chip("rsn", p.filterRsn),
		chip("tool", p.filterTool),
	}, " ")
}

// formatModelRow renders one entry for the list. Capability badges are
// `[txt]` (always for LLMs), `[img]` for vision, `[rsn]` for reasoning,
// `[tool]` for tool-use. Width-aware so long ids don't break the layout.
func formatModelRow(m modelEntry, width int) string {
	caps := "[txt]"
	if m.Vision {
		caps += " [img]"
	}
	if m.Reasoning {
		caps += " [rsn]"
	}
	if m.Tools {
		caps += " [tool]"
	}
	prov := m.Provider
	if prov == "" {
		prov = "?"
	}
	left := fmt.Sprintf("%s  %s", m.Name, caps)
	right := prov
	pad := width - len(left) - len(right)
	if pad < 1 {
		pad = 1
	}
	return left + strings.Repeat(" ", pad) + right
}

// loadModels GETs /v1/models/ and dispatches a modelsLoadedMsg.
func loadModels(c *http.Client, base string, opts Options) tea.Cmd {
	return func() tea.Msg {
		listOpts := opts
		listOpts.Timeout = shortListTimeout
		body, status, err := jsonGET(c, base, "/v1/models/", listOpts)
		if err != nil {
			return modelsLoadedMsg{err: err.Error()}
		}
		if status >= 300 {
			return modelsLoadedMsg{err: fmt.Sprintf("HTTP %d: %s", status, strings.TrimSpace(string(body)))}
		}
		var parsed struct {
			Models []modelEntry `json:"models"`
		}
		if err := json.Unmarshal(body, &parsed); err != nil {
			return modelsLoadedMsg{err: "parse: " + err.Error()}
		}
		return modelsLoadedMsg{models: parsed.Models}
	}
}
