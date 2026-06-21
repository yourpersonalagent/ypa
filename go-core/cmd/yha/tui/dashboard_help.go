package tui

// dashboard_help.go — Alt+C scrollable help modal for the Dashboard tab.
//
// Surfaces the full command catalogue (everything in tuid.Commands plus
// the TUI-owned :login) in a centred, scrollable box. Opens with Alt+C
// from the dashboard, closes on Esc or q. Arrow keys / PgUp / PgDn /
// Home / End scroll the content via the underlying viewport.

import (
	"strings"

	"github.com/charmbracelet/bubbles/viewport"
	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

type helpModal struct {
	open  bool
	vp    viewport.Model
	ready bool
}

func newHelpModal() helpModal { return helpModal{} }

func (h *helpModal) isOpen() bool { return h.open }

// boxDims returns the modal's outer width and height for the given body
// dimensions. The box never covers the whole body — we leave a margin so
// the user can still see they're on the Dashboard tab underneath.
func helpBoxDims(w, hgt int) (int, int) {
	boxW := w - 4
	if boxW > 86 {
		boxW = 86
	}
	if boxW < 40 {
		boxW = 40
	}
	boxH := hgt - 2
	if boxH < 8 {
		boxH = 8
	}
	return boxW, boxH
}

func (h *helpModal) SetSize(w, hgt int, st Styles) {
	boxW, boxH := helpBoxDims(w, hgt)
	innerW := boxW - 4
	innerH := boxH - 4
	if innerW < 10 {
		innerW = 10
	}
	if innerH < 3 {
		innerH = 3
	}
	if !h.ready {
		h.vp = viewport.New(innerW, innerH)
		h.ready = true
	} else {
		h.vp.Width = innerW
		h.vp.Height = innerH
	}
	h.vp.SetContent(helpContent(innerW, st))
}

func (h *helpModal) Open(w, hgt int, st Styles) {
	h.open = true
	h.SetSize(w, hgt, st)
	h.vp.GotoTop()
}

func (h *helpModal) Close() { h.open = false }

// Update returns (handled, cmd). When the modal is open it captures
// everything — even keys it does not act on — so they don't leak into
// the dashboard behind it. Tab / Shift+Tab still escape upward because
// the root model handles those before forwarding here.
func (h *helpModal) Update(msg tea.Msg) (bool, tea.Cmd) {
	if !h.open {
		return false, nil
	}
	if km, ok := msg.(tea.KeyMsg); ok {
		switch km.String() {
		case "esc", "q":
			h.Close()
			return true, nil
		}
	}
	var cmd tea.Cmd
	h.vp, cmd = h.vp.Update(msg)
	return true, cmd
}

func (h *helpModal) View(st Styles, w, hgt int) string {
	boxW, _ := helpBoxDims(w, hgt)
	title := lipgloss.NewStyle().
		Foreground(colorAccent).Bold(true).
		Render("  YHA · Dashboard command reference")
	footer := st.Hint.Render(
		"↑/↓ PgUp/PgDn Home/End scroll  ·  Esc or q close")

	frame := lipgloss.NewStyle().
		Border(lipgloss.RoundedBorder(), true).
		BorderForeground(colorAccent).
		Width(boxW - 2).
		Padding(0, 1).
		Render(lipgloss.JoinVertical(lipgloss.Left,
			title, "", h.vp.View(), "", footer))

	return lipgloss.Place(w, hgt, lipgloss.Center, lipgloss.Center, frame,
		lipgloss.WithWhitespaceChars(" "))
}

// helpContent builds the modal body. Width is the viewport's inner
// width so we can pad section dividers to fit. Styled segments use
// lipgloss; everything else is plain ASCII so the box-drawing reads
// the same on minimal terminals.
func helpContent(width int, st Styles) string {
	if width < 20 {
		width = 20
	}

	hdr := lipgloss.NewStyle().Foreground(colorAccent).Bold(true)
	cmd := lipgloss.NewStyle().Foreground(colorAccent).Bold(true)
	ok := lipgloss.NewStyle().Foreground(colorOk).Bold(true)
	dim := lipgloss.NewStyle().Foreground(colorMuted)

	rule := func(label string) string {
		left := "── " + label + " "
		rest := width - lipgloss.Width(left)
		if rest < 3 {
			rest = 3
		}
		return dim.Render(left + strings.Repeat("─", rest))
	}

	var b strings.Builder

	// ── Banner ────────────────────────────────────────────────────
	banner := []string{
		"╔" + strings.Repeat("═", width-2) + "╗",
		centerInBox("YHA  DASHBOARD  COMMAND  REFERENCE", width),
		"╚" + strings.Repeat("═", width-2) + "╝",
	}
	b.WriteString(hdr.Render(strings.Join(banner, "\n")))
	b.WriteString("\n\n")

	// ── Tutorial ──────────────────────────────────────────────────
	b.WriteString(rule("30-second tutorial"))
	b.WriteString("\n\n")
	tutorial := []string{
		"  1.  Press  " + cmd.Render(":") + "   (colon) to focus the command bar.",
		"  2.  Type a command name + flags, then press " + cmd.Render("Enter") + ".",
		"  3.  Press " + cmd.Render("Esc") + " to abandon a typed command without firing.",
		"  4.  Press " + cmd.Render("r") + "   to refresh services / git / jobs panels.",
		"  5.  Press " + cmd.Render("Tab") + " to cycle to the next tab (Chat, Sessions …).",
		"  6.  Press " + cmd.Render("Alt+C") + " any time to reopen this help screen.",
		"",
		"  Walk-through:",
		"    •  Open the bar with  " + cmd.Render(":"),
		"    •  Type   " + cmd.Render("restart"),
		"    •  Press  " + cmd.Render("Enter"),
		"    →  A new job appears in \"Recent jobs\" as",
		"       [running] then [done], usually within ~20 s.",
	}
	b.WriteString(strings.Join(tutorial, "\n"))
	b.WriteString("\n\n")

	// ── Lifecycle ─────────────────────────────────────────────────
	b.WriteString(rule("Lifecycle commands"))
	b.WriteString("\n\n")
	lifecycle := []string{
		cmd.Render("  :restart") + " " + dim.Render("[scope] [dev|build]"),
		"      Bounce a YHA service. Default scope is " + cmd.Render("bridge") + " (YHA-Bridge",
		"      only) — go-core, rewind, and tui-daemon keep running so any",
		"      in-flight chat stream survives the restart (go-core owns the",
		"      ring buffer that the bridge reattaches to).",
		"",
		"      Scope words: " + cmd.Render("bridge") + ", " + cmd.Render("core") + ", " + cmd.Render("rewind") + ", " + cmd.Render("tui-daemon") + ", " + cmd.Render("all") + ".",
		"      Mode words " + cmd.Render("dev") + "/" + cmd.Render("build") + " only matter for " + cmd.Render("bridge") + " and " + cmd.Render("all") + " —",
		"      the go binaries (core/rewind/tui-daemon) are always built",
		"      the same way (one source tree, no Vite/HMR distinction).",
		"",
		"        " + cmd.Render(":restart") + "                 bridge only · keep current mode",
		"        " + cmd.Render(":restart dev") + "             bridge → dev (Vite HMR + bun --watch)",
		"        " + cmd.Render(":restart build") + "           bridge → build (Vite build + dist/)",
		"        " + cmd.Render(":restart bridge dev") + "      same as above (explicit scope)",
		"        " + cmd.Render(":restart core") + "            bounce only YHA-Core",
		"        " + cmd.Render(":restart rewind") + "          bounce only YHA-Rewind",
		"        " + cmd.Render(":restart tui-daemon") + "      bounce only YHA-TUI-Daemon",
		"        " + cmd.Render(":restart all") + "             full bounce (legacy ./yha.sh build)",
		"        " + cmd.Render(":restart all dev") + "         full bounce in dev mode",
		"",
		"      Heads-up: " + cmd.Render(":restart all") + " is the only scope that takes out",
		"      go-core, which means any active chat stream is killed. Reach",
		"      for it when you've edited code under " + cmd.Render("go-core/**") + " AND",
		"      " + cmd.Render("bridge/core/**") + ", or when you need a true cold boot.",
		"",
		cmd.Render("  :start") + " " + dim.Render("[dev|build]") + "",
		"      Cold-start YHA. Maps to " + cmd.Render("./yha.sh <mode>") + ". Defaults",
		"      to " + cmd.Render("build") + " when no mode is supplied.",
		"",
		cmd.Render("  :stop"),
		"      Stop all YHA-* pm2 services. YHA-TUI-Daemon stays alive so",
		"      the command bar (and this help screen) keep working.",
		"",
		cmd.Render("  :mode dev") + "  |  " + cmd.Render(":mode build"),
		"      Switch the bridge between dev and build mode. Now equivalent",
		"      to " + cmd.Render(":restart bridge <mode>") + " — only YHA-Bridge bounces.",
		"      Go-core, rewind, and tui-daemon stay up.",
	}
	b.WriteString(strings.Join(lifecycle, "\n"))
	b.WriteString("\n\n")

	// ── Build ─────────────────────────────────────────────────────
	b.WriteString(rule("Build commands"))
	b.WriteString("\n\n")
	build := []string{
		cmd.Render("  :build") + " " + dim.Render("[--frontend | --go | --bridge]"),
		"      Rebuild a component without bouncing services.",
		"",
		"        (no flag)      " + cmd.Render("./yha.sh go-build") + "   rebuild yha-core",
		"        --frontend     " + cmd.Render("cd frontend && bun run build"),
		"        --go           alias of no-flag (go-core build)",
		"        --bridge       placeholder · no separate bridge build yet",
		"",
		cmd.Render("  :go-reload"),
		"      Zero-downtime swap of YHA-Core using SO_REUSEPORT. New",
		"      binary boots, old binary drains, no in-flight requests",
		"      dropped. Maps to " + cmd.Render("./yha.sh go-reload") + ".",
	}
	b.WriteString(strings.Join(build, "\n"))
	b.WriteString("\n\n")

	// ── Network ───────────────────────────────────────────────────
	b.WriteString(rule("Network & visibility"))
	b.WriteString("\n\n")
	network := []string{
		cmd.Render("  :share"),
		"      Re-enable Tailscale Funnel forwarding the public :8443",
		"      endpoint into 127.0.0.1:8443. Runs:",
		"        " + cmd.Render("sudo tailscale funnel --bg http://127.0.0.1:8443"),
	}
	b.WriteString(strings.Join(network, "\n"))
	b.WriteString("\n\n")

	// ── Inspection ────────────────────────────────────────────────
	b.WriteString(rule("Inspection commands"))
	b.WriteString("\n\n")
	inspection := []string{
		cmd.Render("  :logs") + " " + dim.Render("[service]"),
		"      Tail the last 100 pm2 log lines. Defaults to YHA-Bridge.",
		"        " + cmd.Render(":logs") + "                YHA-Bridge",
		"        " + cmd.Render(":logs YHA-Core"),
		"        " + cmd.Render(":logs YHA-Rewind"),
		"",
		cmd.Render("  :status"),
		"      One-shot " + cmd.Render("pm2 status") + " + " + cmd.Render("git status -sb") + " snapshot.",
		"      The live Services / Git panels above already poll this",
		"      every 3 s; use " + cmd.Render(":status") + " for a captured text dump.",
	}
	b.WriteString(strings.Join(inspection, "\n"))
	b.WriteString("\n\n")

	// ── Auth ──────────────────────────────────────────────────────
	b.WriteString(rule("Authentication"))
	b.WriteString("\n\n")
	auth := []string{
		cmd.Render("  :login"),
		"      Open the link-flow login overlay. Unlike every other",
		"      command, " + cmd.Render(":login") + " is owned by the TUI itself, not the",
		"      daemon — no job ID is created and nothing appears in the",
		"      \"Recent jobs\" panel.",
	}
	b.WriteString(strings.Join(auth, "\n"))
	b.WriteString("\n\n")

	// ── Stubs ─────────────────────────────────────────────────────
	b.WriteString(rule("Stubs (not yet implemented)"))
	b.WriteString("\n\n")
	stubs := []string{
		"  " + cmd.Render(":setup") + "        Reserved: first-time install + wizard.",
		"  " + cmd.Render(":repair") + "       Reserved: diagnose + repair install state.",
		"",
		"  " + dim.Render("(These print a placeholder line and exit 0 today.)"),
	}
	b.WriteString(strings.Join(stubs, "\n"))
	b.WriteString("\n\n")

	// ── Global keys ───────────────────────────────────────────────
	b.WriteString(rule("Global keys (no colon needed)"))
	b.WriteString("\n\n")
	globals := []string{
		"    " + cmd.Render(":") + "         focus the command bar",
		"    " + cmd.Render("r") + "         refresh services / top / git / jobs / tailscale",
		"    " + cmd.Render("Alt+C") + "     open this help screen",
		"    " + cmd.Render("Tab") + "       next tab        " + cmd.Render("Shift+Tab") + " previous tab",
		"    " + cmd.Render("Ctrl+C") + "    quit            " + cmd.Render("q") + " (when nothing focused) quit",
	}
	b.WriteString(strings.Join(globals, "\n"))
	b.WriteString("\n\n")

	// ── Polling ───────────────────────────────────────────────────
	b.WriteString(rule("How polling works"))
	b.WriteString("\n\n")
	polling := []string{
		"   • The dashboard talks to YHA-TUI-Daemon over a unix socket.",
		"   • Connected     polls every  " + cmd.Render("3 s") + ".",
		"   • Disconnected  re-dials every " + cmd.Render("5 s") + " with friendly text.",
		"   • \"Recent jobs\" keeps up to 8 entries, newest first.",
		"   • Each command you fire returns a job ID. Phases:",
		"",
		"        queued  →  " + ok.Render("running") + "  →  " + ok.Render("done") + "   (exit=0)",
		"                              →  " + st.ErrorText.Render("failed") + " (exit≠0)",
		"                              →  " + st.ErrorText.Render("orphaned-dead / orphaned-live"),
		"                                 (process gone, daemon caught up late)",
	}
	b.WriteString(strings.Join(polling, "\n"))
	b.WriteString("\n\n")

	// ── Mode pill cheat sheet ─────────────────────────────────────
	b.WriteString(rule("Mode pill cheat sheet"))
	b.WriteString("\n\n")
	modepill := []string{
		"      " + cmd.Render("⚙ dev") + "      bun --watch + Vite dev server (mutable)",
		"      " + ok.Render("⛁ build") + "    frontend dist/ served statically · prod path",
		"",
		"   A trailing " + cmd.Render("~") + " next to the pill means the daemon couldn't",
		"   read the bridge's live /proc env and inferred the mode — the",
		"   value may lag for one poll cycle.",
	}
	b.WriteString(strings.Join(modepill, "\n"))
	b.WriteString("\n\n")

	// Closing line — gives the viewport something to scroll to so the
	// user knows they've hit the end.
	b.WriteString(dim.Render("                          — end of reference —"))
	b.WriteString("\n")

	return b.String()
}

// centerInBox pads a single line of text to fit inside a double-border
// box of total `width` columns (so the closing "║" still lines up).
func centerInBox(label string, width int) string {
	inner := width - 2
	if inner < lipgloss.Width(label) {
		return "║" + label + "║"
	}
	left := (inner - lipgloss.Width(label)) / 2
	right := inner - left - lipgloss.Width(label)
	return "║" + strings.Repeat(" ", left) + label + strings.Repeat(" ", right) + "║"
}
