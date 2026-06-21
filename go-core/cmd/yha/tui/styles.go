package tui

// styles.go — lipgloss style sheet for the YHA TUI.
//
// Everything is built on lipgloss.AdaptiveColor so the same palette
// works on both light and dark terminals. Colours are intentionally
// muted — the TUI talks to live AI streams, the eye-catching part is
// the content, not the chrome.

import "github.com/charmbracelet/lipgloss"

// Palette — paired light/dark hex pairs. Using AdaptiveColor lets
// lipgloss probe the terminal background once and pick the right side.
var (
	colorAccent     = lipgloss.AdaptiveColor{Light: "#005FAF", Dark: "#5FAFFF"}
	colorMuted      = lipgloss.AdaptiveColor{Light: "#666666", Dark: "#999999"}
	colorSubtle     = lipgloss.AdaptiveColor{Light: "#AAAAAA", Dark: "#5C5C5C"}
	colorAssistant  = lipgloss.AdaptiveColor{Light: "#005F00", Dark: "#5FD75F"}
	colorUser       = lipgloss.AdaptiveColor{Light: "#5F00AF", Dark: "#AF87FF"}
	colorTool       = lipgloss.AdaptiveColor{Light: "#AF5F00", Dark: "#FFAF5F"}
	colorErr        = lipgloss.AdaptiveColor{Light: "#AF0000", Dark: "#FF5F5F"}
	colorOk         = lipgloss.AdaptiveColor{Light: "#005F00", Dark: "#87FF87"}
	colorPanelEdge  = lipgloss.AdaptiveColor{Light: "#999999", Dark: "#444444"}
	colorTabBarLine = lipgloss.AdaptiveColor{Light: "#CCCCCC", Dark: "#333333"}
)

// Styles bundles every named style the TUI uses. We expose a struct so
// callers can pass it around (and mock it in tests if ever needed)
// instead of reaching into a swarm of free-floating package vars.
type Styles struct {
	HeaderTitle   lipgloss.Style
	HeaderStatus  lipgloss.Style
	TabActive     lipgloss.Style
	TabInactive   lipgloss.Style
	TabDim        lipgloss.Style
	TabBar        lipgloss.Style
	AssistantText lipgloss.Style
	UserText      lipgloss.Style
	ToolBlock     lipgloss.Style
	ToolResultOK  lipgloss.Style
	ToolResultBad lipgloss.Style
	ReasoningText lipgloss.Style
	ErrorText     lipgloss.Style
	SystemText    lipgloss.Style
	PanelBorder   lipgloss.Style
	InputBorder   lipgloss.Style
	Hint          lipgloss.Style
	StatusOnline  lipgloss.Style
	StatusOffline lipgloss.Style
	SelectedItem  lipgloss.Style
	ListItem      lipgloss.Style
	BusyItem      lipgloss.Style
}

// NewStyles builds the default style set. Idempotent and cheap; the
// app rebuilds once at startup and stashes the result on the model.
func NewStyles() Styles {
	border := lipgloss.NewStyle().Foreground(colorPanelEdge)
	return Styles{
		HeaderTitle: lipgloss.NewStyle().
			Foreground(colorAccent).Bold(true).Padding(0, 1),
		HeaderStatus: lipgloss.NewStyle().
			Foreground(colorMuted).Padding(0, 1),
		TabActive: lipgloss.NewStyle().
			Foreground(colorAccent).Bold(true).Underline(true).Padding(0, 1),
		TabInactive: lipgloss.NewStyle().
			Foreground(colorMuted).Padding(0, 1),
		TabDim: lipgloss.NewStyle().
			Foreground(colorSubtle).Padding(0, 1),
		TabBar: lipgloss.NewStyle().
			Border(lipgloss.NormalBorder(), false, false, true, false).
			BorderForeground(colorTabBarLine),
		AssistantText: lipgloss.NewStyle().Foreground(colorAssistant),
		UserText:      lipgloss.NewStyle().Foreground(colorUser).Bold(true),
		ToolBlock: lipgloss.NewStyle().
			Foreground(colorTool).
			Border(lipgloss.RoundedBorder(), true, true, true, true).
			BorderForeground(colorTool).
			Padding(0, 1),
		ToolResultOK:  lipgloss.NewStyle().Foreground(colorOk),
		ToolResultBad: lipgloss.NewStyle().Foreground(colorErr),
		ReasoningText: lipgloss.NewStyle().Foreground(colorMuted).Italic(true),
		ErrorText:     lipgloss.NewStyle().Foreground(colorErr).Bold(true),
		SystemText:    lipgloss.NewStyle().Foreground(colorMuted).Italic(true),
		PanelBorder: border.
			Border(lipgloss.RoundedBorder(), true, true, true, true).
			Padding(0, 1),
		InputBorder: border.
			Border(lipgloss.RoundedBorder(), true, true, true, true).
			Padding(0, 1),
		Hint: lipgloss.NewStyle().Foreground(colorMuted).
			Padding(0, 1),
		StatusOnline:  lipgloss.NewStyle().Foreground(colorOk).Bold(true),
		StatusOffline: lipgloss.NewStyle().Foreground(colorErr).Bold(true),
		SelectedItem: lipgloss.NewStyle().
			Foreground(colorAccent).Bold(true).Reverse(true).Padding(0, 1),
		ListItem: lipgloss.NewStyle().Padding(0, 1),
		BusyItem: lipgloss.NewStyle().Foreground(colorOk).Padding(0, 1),
	}
}
