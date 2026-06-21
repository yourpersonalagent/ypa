package tui

// rewind.go — Rewind tab. TUI mirror of the inline /recover web page
// served by yha-rewind (go-core/cmd/yha-rewind/main.go recoverHTML):
// commit-anchored "packs" on the left, per-record diff on the right,
// restore (undo) on `a`, refresh on `r`, filter on `/`.
//
// The standalone yha-rewind service runs on a loopback port (default
// 127.0.0.1:8445, override via YHA_REWIND_URL). We talk to it directly
// instead of going through the bridge's /__rewind proxy — keeps the TUI
// usable even when the bridge is down, which is the whole point of the
// rewind safety net.

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

	"github.com/charmbracelet/bubbles/textinput"
	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

const rewindDefaultURL = "http://127.0.0.1:8445"

// ── wire shapes (matching yha-rewind JSON) ──────────────────────────────

type rewindFileEntry struct {
	Path string `json:"path"`
	Op   string `json:"op"`
}

type rewindRecord struct {
	ID          string            `json:"id"`
	TS          int64             `json:"ts"`
	Trigger     string            `json:"trigger"`
	Module      string            `json:"module"`
	AgentTurnID *string           `json:"agent_turn_id"`
	Files       []rewindFileEntry `json:"files"`
}

type rewindCommit struct {
	Hash string `json:"hash"`
	TS   int64  `json:"ts"`
}

type rewindPack struct {
	CommitFrom *rewindCommit  `json:"commit_from"`
	CommitTo   *rewindCommit  `json:"commit_to"`
	Working    bool           `json:"working"`
	EditCount  int            `json:"edit_count"`
	Edits      []rewindRecord `json:"edits,omitempty"`
}

type rewindPacksResp struct {
	Packs   []rewindPack   `json:"packs"`
	Commits []rewindCommit `json:"commits"`
}

type rewindDiffSide struct {
	Text   *string `json:"text,omitempty"`
	Binary bool    `json:"binary,omitempty"`
	Size   int     `json:"size,omitempty"`
}

type rewindDiffFile struct {
	Path   string         `json:"path"`
	Op     string         `json:"op"`
	Before rewindDiffSide `json:"before"`
	After  rewindDiffSide `json:"after"`
}

type rewindDiffResp struct {
	ID     string           `json:"id"`
	Module string           `json:"module"`
	Files  []rewindDiffFile `json:"files"`
}

type rewindRestoreResult struct {
	Path string `json:"path"`
	Op   string `json:"op"`
	OK   bool   `json:"ok"`
	Err  string `json:"err"`
}

type rewindRestoreResp struct {
	ID      string                `json:"id"`
	Results []rewindRestoreResult `json:"results"`
}

// ── tea messages ────────────────────────────────────────────────────────

type rewindPacksMsg struct {
	resp *rewindPacksResp
	err  string
}

type rewindDiffMsg struct {
	id   string
	diff *rewindDiffResp
	err  string
}

type rewindRestoreMsg struct {
	id   string
	resp *rewindRestoreResp
	err  string
}

// rewindRestartMsg is the result of POST /api/yha-restart — fires the
// flash line and clears the armed-restart state. The bridge will be
// going down a few hundred ms later (yha.sh spawn is detached), but
// because --skip-rewind is set this very page stays serving.
type rewindRestartMsg struct {
	mode    string
	backend string
	err     string
}

// ── row model (flattened for cursor traversal) ─────────────────────────

type rewindRowKind int

const (
	rowKindHeader rewindRowKind = iota // pack header — not selectable
	rowKindRecord                      // selectable record
	rowKindEmpty                       // "(empty pack)" filler — not selectable
)

type rewindRow struct {
	kind     rewindRowKind
	packIdx  int    // -1 for non-pack rows (none currently)
	recordID string // populated when kind == rowKindRecord
	label    string // rendered text (pre-styled)
}

// ── model ───────────────────────────────────────────────────────────────

type rewindModel struct {
	styles   Styles
	httpC    *http.Client
	baseURL  string
	endpoint string // future use; baseURL takes precedence today

	width, height int

	loaded  bool
	loading bool
	err     string

	packs    []rewindPack
	commits  []rewindCommit
	rows     []rewindRow
	cursor   int // index into rows; always lands on a selectable row when possible

	// Detail view (right pane) — diff for the highlighted record.
	detail   viewport.Model
	detailID string

	// Confirm state for the `a` apply key. Two-key safety: `a` once asks
	// "press y to confirm", another `a` cancels.
	confirmingApply bool

	// Two-step confirm for the `R` restart key. `R` arms; then `d`
	// chooses dev, `b` chooses build, `y` keeps the current mode. Any
	// other key cancels. We always pass --skip-rewind to the spawned
	// yha.sh so this very page (and our tab) survives the bounce.
	confirmingRestart bool

	// Filter (path/module). `/` enters search mode; Esc clears.
	searchInput textinput.Model
	searching   bool
	filter      string

	// Transient status line ("restored 3 OK", "filter active", …).
	flash string
}

func newRewindModel(st Styles) rewindModel {
	si := textinput.New()
	si.Prompt = "/ "
	si.Placeholder = "filter by path or module…"
	si.CharLimit = 0
	return rewindModel{
		styles:      st,
		httpC:       &http.Client{Timeout: 8 * time.Second},
		baseURL:     resolveRewindBaseURL(),
		detail:      viewport.New(60, 10),
		searchInput: si,
	}
}

// resolveRewindBaseURL mirrors the precedence used by `yha rewind`:
// $YHA_REWIND_URL > default loopback. Trimmed of trailing slash.
func resolveRewindBaseURL() string {
	if v := strings.TrimRight(os.Getenv("YHA_REWIND_URL"), "/"); v != "" {
		return v
	}
	return rewindDefaultURL
}

func (m *rewindModel) Init() tea.Cmd { return nil }

// EnsureLoaded triggers a one-time load when the user first switches to
// the tab — matches the sessions tab's lazy-load pattern.
func (m *rewindModel) EnsureLoaded() tea.Cmd {
	if m.loaded || m.loading {
		return nil
	}
	m.loading = true
	return loadRewindPacks(m.httpC, m.baseURL)
}

func (m *rewindModel) SetSize(w, h int) {
	m.width = w
	m.height = h
	// Mirrors sessionsModel.SetSize so the bordered list/detail panels
	// fill the full body without overflowing the footer. Earlier numbers
	// (detailW = w-listW-4 + Height(h-2) with no MaxHeight) left 8 cols
	// dead on the right and rendered a panel 1 row too tall.
	_, detailW := rewindSplit(w)
	contentH := h - 2
	if contentH < 1 {
		contentH = 1
	}
	m.detail.Width = detailW - 2
	m.detail.Height = contentH
}

// rewindSplit returns the (list, detail) panel widths for the current
// body width. Clamped the same way sessions clamps so the list stays
// usable on narrow terminals without starving the diff pane.
func rewindSplit(w int) (int, int) {
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
	return listW, detailW
}

// inputFocused returns true when a key (especially `q`) should not be
// treated as a global quit. The search filter has obvious focus; the
// confirm prompts (apply, restart) also need to absorb keys because
// 'y' / 'd' / 'b' otherwise have no defined meaning at the app level
// but should be intercepted here for the active prompt.
func (m *rewindModel) inputFocused() bool {
	return m.searching || m.confirmingApply || m.confirmingRestart
}

// Headline returns the per-tab subheader components for the Rewind tab.
// Surfaces pack/record counts, filter state, and any active confirm
// prompt so the user can see what mode they're in without scanning the
// detail pane for the warning banner.
func (m rewindModel) Headline() (string, []string, string) {
	bits := []string{}
	switch {
	case m.loading:
		bits = append(bits, "loading…")
	case m.err != "":
		bits = append(bits, "error")
	case !m.loaded:
		bits = append(bits, "(press Tab/r to load)")
	default:
		records := 0
		for _, p := range m.packs {
			records += p.EditCount
		}
		bits = append(bits, fmt.Sprintf("%d pack%s", len(m.packs), plural(len(m.packs))))
		bits = append(bits, fmt.Sprintf("%d edit%s", records, plural(records)))
	}
	if m.filter != "" {
		bits = append(bits, "filter "+truncate(m.filter, 20))
	}
	if m.confirmingRestart {
		bits = append(bits, "⚠ RESTART armed")
	} else if m.confirmingApply {
		bits = append(bits, "⚠ RESTORE armed")
	}
	hint := "↑/↓ a restore · R restart · / filter · r refresh"
	return "Rewind", bits, hint
}

func (m rewindModel) Update(msg tea.Msg) (rewindModel, tea.Cmd) {
	switch msg := msg.(type) {
	case rewindPacksMsg:
		m.loading = false
		m.loaded = true
		if msg.err != "" {
			m.err = msg.err
			return m, nil
		}
		m.err = ""
		m.packs = nil
		m.commits = nil
		if msg.resp != nil {
			m.packs = msg.resp.Packs
			m.commits = msg.resp.Commits
		}
		m.rebuildRows()
		if id := m.currentRecordID(); id != "" {
			return m, loadRewindDiff(m.httpC, m.baseURL, id)
		}
		return m, nil

	case rewindDiffMsg:
		if msg.err != "" {
			m.detail.SetContent(m.styles.ErrorText.Render(msg.err))
		} else if msg.diff != nil {
			m.detail.SetContent(m.renderDiff(msg.diff))
		}
		m.detailID = msg.id
		return m, nil

	case rewindRestoreMsg:
		m.confirmingApply = false
		if msg.err != "" {
			m.flash = "restore failed: " + msg.err
			return m, nil
		}
		if msg.resp == nil {
			m.flash = "restore: empty response"
			return m, nil
		}
		ok, fail := 0, 0
		for _, r := range msg.resp.Results {
			if r.OK {
				ok++
			} else {
				fail++
			}
		}
		if fail == 0 {
			m.flash = fmt.Sprintf("restored %s: %d OK", shortID(msg.resp.ID), ok)
		} else {
			m.flash = fmt.Sprintf("restored %s: %d OK, %d failed",
				shortID(msg.resp.ID), ok, fail)
		}
		// Re-pull packs so a Create-undo (which deletes the file) clears
		// from the listing and the diff updates to "(no data)".
		m.loading = true
		return m, loadRewindPacks(m.httpC, m.baseURL)

	case rewindRestartMsg:
		m.confirmingRestart = false
		if msg.err != "" {
			m.flash = "restart failed: " + msg.err
			return m, nil
		}
		label := msg.mode
		if msg.backend != "" {
			label += " (" + msg.backend + ")"
		}
		m.flash = "yha.sh " + label + " spawned · keeping rewind alive · refresh packs in ~10s"
		return m, nil

	case tea.KeyMsg:
		// Filter-mode capture.
		if m.searching {
			switch msg.String() {
			case "esc":
				m.searching = false
				m.searchInput.Blur()
				m.searchInput.SetValue("")
				m.filter = ""
				m.rebuildRows()
				return m, nil
			case "enter":
				m.searching = false
				m.searchInput.Blur()
				m.filter = strings.TrimSpace(m.searchInput.Value())
				m.rebuildRows()
				if id := m.currentRecordID(); id != "" {
					return m, loadRewindDiff(m.httpC, m.baseURL, id)
				}
				return m, nil
			}
			var cmd tea.Cmd
			m.searchInput, cmd = m.searchInput.Update(msg)
			return m, cmd
		}

		switch msg.String() {
		case "up", "k":
			m.moveCursor(-1)
			return m, m.maybeLoadDiff()
		case "down", "j":
			m.moveCursor(+1)
			return m, m.maybeLoadDiff()
		case "pgup":
			m.moveCursor(-10)
			return m, m.maybeLoadDiff()
		case "pgdown":
			m.moveCursor(+10)
			return m, m.maybeLoadDiff()
		case "home", "g":
			m.cursor = 0
			m.snapToSelectable(+1)
			return m, m.maybeLoadDiff()
		case "end", "G":
			m.cursor = len(m.rows) - 1
			m.snapToSelectable(-1)
			return m, m.maybeLoadDiff()
		case "r":
			m.loading = true
			m.flash = "refreshing…"
			return m, loadRewindPacks(m.httpC, m.baseURL)
		case "/":
			m.searching = true
			m.searchInput.SetValue(m.filter)
			m.searchInput.Focus()
			return m, textinput.Blink
		case "a":
			// Two-step confirm: first `a` arms, second key chooses.
			id := m.currentRecordID()
			if id == "" {
				m.flash = "no record highlighted"
				return m, nil
			}
			if !m.confirmingApply {
				m.confirmingApply = true
				m.flash = "press y to restore " + shortID(id) + " (any other key cancels)"
				return m, nil
			}
			// Pressing `a` again while armed acts as cancel.
			m.confirmingApply = false
			m.flash = "restore cancelled"
			return m, nil
		case "y", "Y":
			// Two contexts: restart-confirm (highest priority) and apply-confirm.
			if m.confirmingRestart {
				m.confirmingRestart = false
				m.flash = "restarting YHA in current mode (keeps rewind)…"
				return m, requestRewindRestart(m.httpC, m.baseURL, "")
			}
			if !m.confirmingApply {
				return m, nil
			}
			id := m.currentRecordID()
			m.confirmingApply = false
			if id == "" {
				m.flash = "no record highlighted"
				return m, nil
			}
			m.flash = "restoring " + shortID(id) + "…"
			return m, applyRewindRestore(m.httpC, m.baseURL, id)
		case "R":
			// `R` arms the restart. Capital so the lowercase refresh stays
			// the single-key default and an accidental Shift doesn't bounce
			// anything mid-typing.
			if m.confirmingRestart {
				m.confirmingRestart = false
				m.flash = "restart cancelled"
				return m, nil
			}
			m.confirmingRestart = true
			m.flash = "press d=dev · b=build · y=current · any other key cancels"
			return m, nil
		case "d", "D":
			if m.confirmingRestart {
				m.confirmingRestart = false
				m.flash = "restarting YHA in dev mode (keeps rewind)…"
				return m, requestRewindRestart(m.httpC, m.baseURL, "dev")
			}
		case "b", "B":
			if m.confirmingRestart {
				m.confirmingRestart = false
				m.flash = "restarting YHA in build mode (keeps rewind)…"
				return m, requestRewindRestart(m.httpC, m.baseURL, "build")
			}
		case "esc":
			if m.confirmingRestart {
				m.confirmingRestart = false
				m.flash = "restart cancelled"
				return m, nil
			}
			if m.confirmingApply {
				m.confirmingApply = false
				m.flash = "restore cancelled"
				return m, nil
			}
			if m.filter != "" {
				m.filter = ""
				m.searchInput.SetValue("")
				m.rebuildRows()
				m.flash = "filter cleared"
				return m, m.maybeLoadDiff()
			}
		default:
			// Any other key while armed cancels the prompt without running
			// anything destructive.
			if m.confirmingRestart {
				m.confirmingRestart = false
				m.flash = "restart cancelled"
				return m, nil
			}
			if m.confirmingApply {
				m.confirmingApply = false
				m.flash = "restore cancelled"
				return m, nil
			}
		}

	case tea.MouseMsg:
		// Wheel moves the list cursor (auto-loading the diff like the
		// arrow keys); ignored while the filter prompt is active.
		if m.searching || msg.Action != tea.MouseActionPress {
			return m, nil
		}
		switch msg.Button {
		case tea.MouseButtonWheelUp:
			m.moveCursor(-3)
			return m, m.maybeLoadDiff()
		case tea.MouseButtonWheelDown:
			m.moveCursor(+3)
			return m, m.maybeLoadDiff()
		}
		return m, nil
	}
	// Forward to detail viewport for scrolling.
	var cmd tea.Cmd
	m.detail, cmd = m.detail.Update(msg)
	return m, cmd
}

// ── view ────────────────────────────────────────────────────────────────

func (m rewindModel) View(w, h int) string {
	if !m.loaded && !m.loading {
		// Lazy-load hint when we haven't tried yet (Tab switch lands here).
		body := m.styles.SystemText.Render(
			"Switch to this tab loads recent edits from " + m.baseURL + ".")
		return m.styles.PanelBorder.
			Width(w - 2).
			Height(h - 2).
			MaxHeight(h).
			Render(body)
	}

	listW, detailW := rewindSplit(w)
	// Inner content cols: panel-border + panel-padding take 4; the row
	// styles (Hint / ListItem / SelectedItem / HeaderTitle) each add another
	// 2 cols of horizontal padding on top of whatever we crop to, so the
	// effective crop budget for row content is listW - 6. Without that
	// extra slack lipgloss soft-wraps each row to 2 visual lines and the
	// MaxHeight crop eats the bottom of the list (and the bottom panel
	// border with it) — the symptom the user reported as "list grows
	// taller than the rest of the interface, bottom not visible".
	listInnerW := listW - 6
	if listInnerW < 10 {
		listInnerW = 10
	}
	contentH := h - 2
	if contentH < 3 {
		contentH = 3
	}

	// Trailing newlines are load-bearing: lipgloss measures content height
	// as `strings.Count(s, "\n") + 1`, so a final `\n` makes the panel
	// think the inner content is one row taller than it really is. With
	// MaxHeight(h) capping the rendered output, the bottom border gets
	// cropped — exactly the "list grows past the interface, bottom not
	// visible" symptom the user reported. Strip the trailing newline so
	// the measured height matches the displayed height.
	listContent := strings.TrimRight(m.renderListBody(contentH, listInnerW), "\n")
	detailContent := strings.TrimRight(m.renderDetailBody(), "\n")

	// Height(contentH) + MaxHeight(h) is the sessions.go trick: pad short
	// content up to contentH inner rows, then crop the FULL rendered
	// output (incl. border) at h — neither alone fits the body exactly.
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
// contentH rows × innerW cols. Pre-cropping every line keeps lipgloss
// from soft-wrapping rows into multiple visual lines, which would push
// real content out of the visible window.
func (m rewindModel) renderListBody(contentH, innerW int) string {
	var b strings.Builder

	// First line: search input when active, otherwise a hint that adapts
	// to the available width. Keeps the visible affordances at the top so
	// the bottom-cropping window doesn't hide them.
	headerLines := 1
	if m.searching {
		b.WriteString(m.styles.SystemText.Render(crop(m.searchInput.View(), innerW)))
	} else {
		hint := rewindHintFor(innerW)
		if m.filter != "" {
			hint = "filter: " + truncate(m.filter, innerW-18) + "   (Esc clears)"
		}
		b.WriteString(m.styles.Hint.Render(crop(hint, innerW)))
	}
	b.WriteByte('\n')

	if m.flash != "" {
		b.WriteString(m.styles.SystemText.Render(crop(m.flash, innerW)))
		b.WriteByte('\n')
		headerLines++
	}
	if m.err != "" {
		b.WriteString(m.styles.ErrorText.Render(crop(m.err, innerW)))
		b.WriteByte('\n')
		headerLines++
	}

	if m.loading {
		b.WriteString(m.styles.SystemText.Render(crop("Loading…", innerW)))
		return b.String()
	}
	if len(m.rows) == 0 {
		if m.filter != "" {
			b.WriteString(m.styles.SystemText.Render(crop("(no matches)", innerW)))
		} else {
			b.WriteString(m.styles.SystemText.Render(crop("(no edit records)", innerW)))
		}
		return b.String()
	}

	visible := contentH - headerLines
	if visible < 1 {
		visible = 1
	}
	// Reserve 2 rows for the ↑/↓ scroll markers when the list overflows
	// the visible window — matches the sessions tab's affordance.
	if len(m.rows) > visible {
		visible -= 2
		if visible < 1 {
			visible = 1
		}
	}

	start := m.scrollStart(visible)
	end := start + visible
	if end > len(m.rows) {
		end = len(m.rows)
	}

	if start > 0 {
		b.WriteString(m.styles.Hint.Render(crop("  ↑ more above", innerW)))
		b.WriteByte('\n')
	}
	rowsRendered := 0
	for i := start; i < end; i++ {
		b.WriteString(m.renderRowCropped(i, innerW))
		b.WriteByte('\n')
		rowsRendered++
		// Defence in depth: even with the window math the body must
		// never exceed contentH inner rows minus the trailing marker.
		// The earlier overflow class came from edge cases where the
		// scroll window slipped past the budget (e.g. when a packed
		// rebuildRows produced more rows than visible could absorb).
		// Hard-stop here so the panel can't grow taller than the body.
		if headerLines+rowsRendered+2 >= contentH {
			break
		}
	}
	if end < len(m.rows) {
		b.WriteString(m.styles.Hint.Render(crop("  ↓ more below", innerW)))
		b.WriteByte('\n')
	}
	return b.String()
}

func (m rewindModel) renderRowCropped(i, innerW int) string {
	row := m.rows[i]
	cropped := crop(row.label, innerW)
	if i == m.cursor && row.kind == rowKindRecord {
		return m.styles.SelectedItem.Render(cropped)
	}
	switch row.kind {
	case rowKindHeader:
		return m.styles.HeaderTitle.Render(cropped)
	case rowKindEmpty:
		return m.styles.SystemText.Render(cropped)
	default:
		return m.styles.ListItem.Render(cropped)
	}
}

// renderDetailBody returns the right-pane content. The diff viewport
// already encodes its module/files header in renderDiff's output, so we
// don't add a second redundant title row (which was the source of the
// old "1 row too tall" bug). When the apply confirm is armed, prepend a
// loud warning so the user can't miss it on the diff side either.
func (m rewindModel) renderDetailBody() string {
	id := m.currentRecordID()
	if id == "" {
		if m.confirmingRestart {
			return m.styles.ToolResultBad.Render(
				"RESTART YHA  —  d=dev · b=build · y=current mode · any other key cancels")
		}
		return m.styles.Hint.Render("(no record highlighted — move with j/k · press R to restart YHA)")
	}
	if m.confirmingRestart {
		warn := m.styles.ToolResultBad.Render(
			"RESTART YHA  —  d=dev · b=build · y=current mode · any other key cancels")
		return warn + "\n" + m.detail.View()
	}
	if m.confirmingApply {
		warn := m.styles.ToolResultBad.Render(
			"PRESS Y TO RESTORE " + shortID(id) + " — any other key cancels")
		return warn + "\n" + m.detail.View()
	}
	return m.detail.View()
}

// rewindHintFor adapts the key-hint line to the available list width so
// short panes don't overflow with the full version of the legend.
func rewindHintFor(innerW int) string {
	switch {
	case innerW >= 80:
		return "j/k move · a restore · R restart YHA · / filter · r refresh"
	case innerW >= 60:
		return "j/k · a restore · R restart · / filter · r refresh"
	case innerW >= 40:
		return "j/k · a · R · / · r"
	case innerW >= 24:
		return "j/k a R / r"
	default:
		return "jk a R /"
	}
}

// renderDiff turns a diff response into a side-by-side text rendering
// that fits a single viewport pane. Mirrors the structure of the web
// modal but flattens it for a terminal: per-file BEFORE on top, AFTER
// below, with --- separators. Side-by-side would need careful column
// management and the user can still see the difference at a glance.
func (m rewindModel) renderDiff(d *rewindDiffResp) string {
	if d == nil || len(d.Files) == 0 {
		return m.styles.SystemText.Render("(no files in this record)")
	}
	var b strings.Builder
	fmt.Fprintf(&b, "module: %s\n", safe(d.Module, "-"))
	fmt.Fprintf(&b, "files:  %d\n\n", len(d.Files))
	for i, f := range d.Files {
		if i > 0 {
			b.WriteString("\n")
		}
		hdr := fmt.Sprintf("── %s  (%s) ──", f.Path, f.Op)
		b.WriteString(m.styles.HeaderTitle.Render(hdr))
		b.WriteByte('\n')

		b.WriteString(m.styles.SystemText.Render("  --- before ---"))
		b.WriteByte('\n')
		b.WriteString(renderDiffSide(f.Before))
		b.WriteString("\n")

		b.WriteString(m.styles.SystemText.Render("  --- after ---"))
		b.WriteByte('\n')
		b.WriteString(renderDiffSide(f.After))
		b.WriteString("\n")
	}
	return b.String()
}

func renderDiffSide(s rewindDiffSide) string {
	if s.Binary {
		return fmt.Sprintf("  (binary, %d bytes)\n", s.Size)
	}
	if s.Text == nil {
		return "  (empty)\n"
	}
	// Indent every line by two spaces so the panel chrome doesn't bleed.
	lines := strings.Split(*s.Text, "\n")
	for i, ln := range lines {
		lines[i] = "  " + ln
	}
	return strings.Join(lines, "\n")
}

// ── row plumbing ────────────────────────────────────────────────────────

// rebuildRows flattens packs+edits into a linear sequence of rows so a
// single cursor index drives both navigation and selection. Headers
// (commit/working markers) are non-selectable; cursor skips over them.
func (m *rewindModel) rebuildRows() {
	m.rows = m.rows[:0]
	prevSelected := ""
	if m.cursor < len(m.rows) {
		// no-op; just defensive
	}
	if old := m.currentRecordID(); old != "" {
		prevSelected = old
	}

	filter := strings.ToLower(m.filter)
	for pi, p := range m.packs {
		hdr := packHeader(p, m.commits)
		// Only emit packs that have at least one visible record under the
		// current filter — keeps the list compact when filtering.
		visibleEdits := make([]rewindRecord, 0, len(p.Edits))
		for _, e := range p.Edits {
			if filter != "" && !recordMatches(e, filter) {
				continue
			}
			visibleEdits = append(visibleEdits, e)
		}
		if len(visibleEdits) == 0 && filter != "" {
			continue
		}
		m.rows = append(m.rows, rewindRow{
			kind:    rowKindHeader,
			packIdx: pi,
			label:   hdr,
		})
		if len(visibleEdits) == 0 {
			m.rows = append(m.rows, rewindRow{
				kind:    rowKindEmpty,
				packIdx: pi,
				label:   "(no recorded edits in this pack)",
			})
			continue
		}
		for _, e := range visibleEdits {
			m.rows = append(m.rows, rewindRow{
				kind:     rowKindRecord,
				packIdx:  pi,
				recordID: e.ID,
				label:    recordLabel(e),
			})
		}
	}

	// Try to keep the previously-selected record highlighted across a
	// rebuild (e.g. after refresh).
	if prevSelected != "" {
		for i, r := range m.rows {
			if r.kind == rowKindRecord && r.recordID == prevSelected {
				m.cursor = i
				return
			}
		}
	}
	// Default cursor: first selectable row.
	m.cursor = 0
	m.snapToSelectable(+1)
}

func packHeader(p rewindPack, commits []rewindCommit) string {
	if p.Working {
		return fmt.Sprintf("◇ working pack — %d edit(s) since HEAD", p.EditCount)
	}
	to := "-"
	if p.CommitTo != nil {
		to = shortHash(p.CommitTo.Hash)
	}
	from := "?"
	if p.CommitFrom != nil {
		from = shortHash(p.CommitFrom.Hash)
	}
	return fmt.Sprintf("● commit %s..%s — %d edit(s)", from, to, p.EditCount)
}

func recordLabel(e rewindRecord) string {
	when := time.UnixMilli(e.TS).Format("01-02 15:04:05")
	mod := truncate(safe(e.Module, "-"), 20)
	trig := truncate(safe(e.Trigger, "-"), 8)
	return fmt.Sprintf("  %s  %s  %s  %-20s  %s  files=%d",
		shortID(e.ID), when, padRight(trig, 8), mod,
		padRight("", 0), len(e.Files))
}

func recordMatches(e rewindRecord, lower string) bool {
	if strings.Contains(strings.ToLower(e.Module), lower) {
		return true
	}
	if strings.Contains(strings.ToLower(e.Trigger), lower) {
		return true
	}
	if strings.Contains(strings.ToLower(e.ID), lower) {
		return true
	}
	for _, f := range e.Files {
		if strings.Contains(strings.ToLower(f.Path), lower) {
			return true
		}
	}
	return false
}

func shortHash(h string) string {
	if len(h) <= 8 {
		return h
	}
	return h[:8]
}

func (m *rewindModel) currentRecordID() string {
	if m.cursor < 0 || m.cursor >= len(m.rows) {
		return ""
	}
	r := m.rows[m.cursor]
	if r.kind != rowKindRecord {
		return ""
	}
	return r.recordID
}

// moveCursor walks delta selectable rows from the current position.
// Headers/empty rows are skipped; cursor stops at first/last selectable.
func (m *rewindModel) moveCursor(delta int) {
	if len(m.rows) == 0 {
		return
	}
	step := 1
	if delta < 0 {
		step = -1
		delta = -delta
	}
	for delta > 0 {
		next := m.cursor + step
		if next < 0 || next >= len(m.rows) {
			break
		}
		m.cursor = next
		if m.rows[m.cursor].kind == rowKindRecord {
			delta--
		}
	}
	// If we landed on a non-selectable row (no selectable in that
	// direction), snap to the closest selectable.
	if m.rows[m.cursor].kind != rowKindRecord {
		m.snapToSelectable(step)
	}
}

func (m *rewindModel) snapToSelectable(dir int) {
	if len(m.rows) == 0 {
		return
	}
	if dir == 0 {
		dir = +1
	}
	// Walk forward (or backward) until we hit a selectable row.
	for i := 0; i < len(m.rows); i++ {
		idx := m.cursor + dir*i
		if idx < 0 || idx >= len(m.rows) {
			break
		}
		if m.rows[idx].kind == rowKindRecord {
			m.cursor = idx
			return
		}
	}
	// Try the opposite direction.
	for i := 0; i < len(m.rows); i++ {
		idx := m.cursor - dir*i
		if idx < 0 || idx >= len(m.rows) {
			break
		}
		if m.rows[idx].kind == rowKindRecord {
			m.cursor = idx
			return
		}
	}
}

func (m *rewindModel) scrollStart(visible int) int {
	if m.cursor < visible {
		return 0
	}
	max := len(m.rows) - visible
	if max < 0 {
		max = 0
	}
	half := visible / 2
	start := m.cursor - half
	if start < 0 {
		start = 0
	}
	if start > max {
		start = max
	}
	return start
}

func (m rewindModel) maybeLoadDiff() tea.Cmd {
	id := m.currentRecordID()
	if id == "" || id == m.detailID {
		return nil
	}
	return loadRewindDiff(m.httpC, m.baseURL, id)
}

// ── HTTP loaders (tea.Cmd factories) ────────────────────────────────────

func loadRewindPacks(c *http.Client, base string) tea.Cmd {
	return func() tea.Msg {
		body, err := rewindHTTP(c, http.MethodGet, base+"/api/packs?with_edits=1", nil)
		if err != nil {
			return rewindPacksMsg{err: err.Error()}
		}
		var resp rewindPacksResp
		if err := json.Unmarshal(body, &resp); err != nil {
			return rewindPacksMsg{err: "parse packs: " + err.Error()}
		}
		return rewindPacksMsg{resp: &resp}
	}
}

func loadRewindDiff(c *http.Client, base, id string) tea.Cmd {
	return func() tea.Msg {
		body, err := rewindHTTP(c, http.MethodGet, base+"/api/diff/"+id, nil)
		if err != nil {
			return rewindDiffMsg{id: id, err: err.Error()}
		}
		var resp rewindDiffResp
		if err := json.Unmarshal(body, &resp); err != nil {
			return rewindDiffMsg{id: id, err: "parse diff: " + err.Error()}
		}
		return rewindDiffMsg{id: id, diff: &resp}
	}
}

func applyRewindRestore(c *http.Client, base, id string) tea.Cmd {
	return func() tea.Msg {
		body, err := rewindHTTP(c, http.MethodPost, base+"/api/restore/"+id, nil)
		if err != nil {
			return rewindRestoreMsg{id: id, err: err.Error()}
		}
		var resp rewindRestoreResp
		if err := json.Unmarshal(body, &resp); err != nil {
			return rewindRestoreMsg{id: id, err: "parse restore: " + err.Error()}
		}
		return rewindRestoreMsg{id: id, resp: &resp}
	}
}

// requestRewindRestart POSTs to /api/yha-restart on the rewind service.
// mode is "dev" | "build" | "" (empty = let the server pick the current
// mode by reading a live sibling's /proc env). The endpoint always
// passes --skip-rewind to the spawned yha.sh, so our session survives.
func requestRewindRestart(c *http.Client, base, mode string) tea.Cmd {
	return func() tea.Msg {
		payload := map[string]string{}
		if mode != "" {
			payload["mode"] = mode
		}
		buf, _ := json.Marshal(payload)
		body, err := rewindHTTP(c, http.MethodPost, base+"/api/yha-restart", strings.NewReader(string(buf)))
		if err != nil {
			return rewindRestartMsg{mode: mode, err: err.Error()}
		}
		var resp struct {
			OK      bool   `json:"ok"`
			Mode    string `json:"mode"`
			Backend string `json:"backend"`
		}
		if err := json.Unmarshal(body, &resp); err != nil {
			return rewindRestartMsg{mode: mode, err: "parse restart: " + err.Error()}
		}
		if !resp.OK {
			return rewindRestartMsg{mode: mode, err: "rewind service refused restart"}
		}
		return rewindRestartMsg{mode: resp.Mode, backend: resp.Backend}
	}
}

func rewindHTTP(c *http.Client, method, url string, body io.Reader) ([]byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, method, url, body)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	buf, _ := io.ReadAll(resp.Body)
	if resp.StatusCode >= 300 {
		// Trim long server bodies — the recoverable info fits in one line.
		excerpt := strings.TrimSpace(string(buf))
		if len(excerpt) > 160 {
			excerpt = excerpt[:160] + "…"
		}
		return buf, fmt.Errorf("HTTP %d %s — %s", resp.StatusCode, resp.Status, excerpt)
	}
	return buf, nil
}

// Reserved for a future POST shape (e.g. ?forward=1 redo); kept so the
// non-GET helper has a callsite that the linter can see.
var _ = bytes.NewReader
