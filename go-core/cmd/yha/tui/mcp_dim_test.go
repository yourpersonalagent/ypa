package tui

import (
	"fmt"
	"strings"
	"testing"

	"github.com/charmbracelet/lipgloss"
)

// TestMcpViewDimensions asserts the MCP tab's list panel can't grow
// past the body's row budget for any state — loading, empty, populated,
// and the "more servers than fit" case the user flagged as overflowing
// into the footer. Mirrors the rewind dim test's coverage.
func TestMcpViewDimensions(t *testing.T) {
	st := NewStyles()
	cases := [][2]int{
		{120, 30}, {80, 24}, {200, 50}, {60, 20},
	}
	states := []struct {
		name  string
		setup func(*mcpModel)
	}{
		{"loading", func(m *mcpModel) { m.loading = true }},
		{"loaded-empty", func(m *mcpModel) { m.loaded = true }},
		{"loaded-populated", func(m *mcpModel) {
			m.loaded = true
			for i := 0; i < 3; i++ {
				m.servers = append(m.servers, mcpServer{
					Name:    fmt.Sprintf("server-%d", i),
					Running: i%2 == 0,
					Tools:   []mcpTool{{Name: "t"}, {Name: "t2"}},
				})
			}
		}},
		{"loaded-many-servers", func(m *mcpModel) {
			m.loaded = true
			for i := 0; i < 40; i++ {
				m.servers = append(m.servers, mcpServer{
					Name:    fmt.Sprintf("srv-%02d", i),
					Running: i%3 == 0,
					Tools:   []mcpTool{{Name: "t"}, {Name: "t2"}},
				})
			}
			// Park cursor mid-list so the scroll window must shift.
			m.cursor = 20
		}},
	}
	for _, sb := range states {
		for _, c := range cases {
			w, h := c[0], c[1]
			m := newMcpModel(Options{}, st, nil, "")
			m.SetSize(w, h)
			sb.setup(&m)
			out := m.View(w, h)
			plain := stripANSI(out)
			lines := strings.Split(plain, "\n")
			if len(lines) > h {
				t.Errorf("%s %dx%d → %d lines (> h=%d)",
					sb.name, w, h, len(lines), h)
			}
			maxCol := lipgloss.Width(plain)
			if maxCol > w {
				t.Errorf("%s %dx%d → max col %d (> w=%d)",
					sb.name, w, h, maxCol, w)
			}
			// Bottom border must survive the MaxHeight crop. If row-style
			// padding pushes a styled row past the panel's wrap target,
			// lipgloss soft-wraps and the corner glyphs get cropped — the
			// "list grows higher than the interface, bottom not visible"
			// regression.
			last := strings.TrimRight(lines[len(lines)-1], " ")
			if !strings.Contains(last, "╰") && !strings.Contains(last, "╯") {
				t.Errorf("%s %dx%d → bottom border missing (last row: %q)",
					sb.name, w, h, last)
			}
		}
	}
}
