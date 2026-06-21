package tui

import (
	"fmt"
	"strings"
	"testing"

	"github.com/charmbracelet/lipgloss"
)

// TestNotesViewDimensions guards the same overflow class as rewind/mcp:
// the Notes panel must fit inside the body's row budget for every state,
// and the bottom border must survive when the list is longer than the
// visible window. The earlier viewport-based path failed silently — the
// cursor walked off the bottom because the viewport stayed at scroll
// offset 0 — and this test would have caught the row-budget cases.
func TestNotesViewDimensions(t *testing.T) {
	st := NewStyles()
	cases := [][2]int{
		{120, 30}, {80, 24}, {200, 50}, {60, 20},
	}
	states := []struct {
		name  string
		setup func(*notesModel)
	}{
		{"loading", func(m *notesModel) { m.loading = true }},
		{"loaded-empty", func(m *notesModel) { m.loaded = true }},
		{"loaded-populated", func(m *notesModel) {
			m.loaded = true
			for i := 0; i < 3; i++ {
				m.notes = append(m.notes, noteHit{
					Text:        fmt.Sprintf("note %d text", i),
					Ts:          1700000000000,
					SessionID:   fmt.Sprintf("s%d", i),
					SessionName: fmt.Sprintf("session-%d", i),
				})
			}
		}},
		{"loaded-many-cursor-mid", func(m *notesModel) {
			m.loaded = true
			for i := 0; i < 80; i++ {
				m.notes = append(m.notes, noteHit{
					Text: fmt.Sprintf(
						"note %02d — some text that is moderately long to exercise crop",
						i),
					Ts:          1700000000000,
					SessionID:   fmt.Sprintf("s%02d", i),
					SessionName: fmt.Sprintf("session-named-%02d", i),
				})
			}
			m.cursor = 40
		}},
		{"loaded-many-cursor-end", func(m *notesModel) {
			m.loaded = true
			for i := 0; i < 80; i++ {
				m.notes = append(m.notes, noteHit{
					Text:        "x",
					Ts:          1700000000000,
					SessionID:   fmt.Sprintf("s%02d", i),
					SessionName: "s",
				})
			}
			m.cursor = 79
		}},
	}
	for _, sb := range states {
		for _, c := range cases {
			w, h := c[0], c[1]
			m := newNotesModel(Options{}, st, nil, "")
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
			last := strings.TrimRight(lines[len(lines)-1], " ")
			if !strings.Contains(last, "╰") && !strings.Contains(last, "╯") {
				t.Errorf("%s %dx%d → bottom border missing (last row: %q)",
					sb.name, w, h, last)
			}
		}
	}
}

// TestNotesCursorTracksWindow asserts the visible slice always includes
// the cursor index — the regression the user reported as "cursor walks
// off the bottom of the screen". We render at a moderate size with a
// big-enough list to force scrolling, walk the cursor across the list,
// and check that each rendered frame contains the marker glyph "> ".
func TestNotesCursorTracksWindow(t *testing.T) {
	st := NewStyles()
	m := newNotesModel(Options{}, st, nil, "")
	m.SetSize(80, 20)
	m.loaded = true
	for i := 0; i < 50; i++ {
		m.notes = append(m.notes, noteHit{
			Text:        fmt.Sprintf("note-%02d", i),
			Ts:          1700000000000,
			SessionID:   fmt.Sprintf("s%02d", i),
			SessionName: fmt.Sprintf("ses-%02d", i),
		})
	}
	for _, c := range []int{0, 10, 25, 49} {
		m.cursor = c
		out := stripANSI(m.View(80, 20))
		want := fmt.Sprintf("> note-%02d", c)
		if !strings.Contains(out, want) {
			t.Errorf("cursor=%d: rendered frame missing %q\n%s", c, want, out)
		}
	}
}
