package tui

import (
	"strings"
	"testing"

	"github.com/charmbracelet/lipgloss"
)

// stripANSI removes the SGR escape sequences lipgloss embeds, so we can
// count actual cell rows/cols deterministically across both light/dark
// terminals.
func stripANSI(s string) string {
	var b strings.Builder
	in := false
	for _, r := range s {
		if in {
			if (r >= 0x40 && r <= 0x7E) {
				in = false
			}
			continue
		}
		if r == 0x1b {
			in = true
			continue
		}
		b.WriteRune(r)
	}
	return b.String()
}

// TestRewindViewDimensions checks the new sizing math: for any (w, h)
// the rendered rewind View never exceeds h rows and stays close to w
// cols. Mirrors the bug class from the screenshot the user flagged
// (panel was rendering h+1 rows tall + 8 cols too narrow on the right).
func TestRewindViewDimensions(t *testing.T) {
	st := NewStyles()
	cases := [][2]int{
		{120, 30}, {80, 24}, {200, 50}, {60, 20},
	}
	// Three representative model states: lazy-load (not loaded yet),
	// loaded with no records, and loaded with packs+records. Each one
	// hits a different View branch.
	stateBuilders := []struct {
		name  string
		setup func(*rewindModel)
	}{
		{"lazy-load", func(m *rewindModel) {}},
		{"loaded-empty", func(m *rewindModel) { m.loaded = true }},
		{"loaded-populated", func(m *rewindModel) {
			m.loaded = true
			m.packs = []rewindPack{
				{
					Working:   true,
					EditCount: 2,
					Edits: []rewindRecord{
						{ID: "abc12345-aaaa", TS: 1700000000000, Module: "demo", Trigger: "manual",
							Files: []rewindFileEntry{{Path: "a.txt", Op: "modify"}}},
						{ID: "def67890-bbbb", TS: 1700000010000, Module: "demo", Trigger: "auto",
							Files: []rewindFileEntry{{Path: "b.txt", Op: "create"}}},
					},
				},
			}
			m.rebuildRows()
		}},
		{"loaded-many-records", func(m *rewindModel) {
			// 50 records across 5 packs — the case the user flagged as
			// "list gets higher than the rest of interface". The window
			// must clip the body to h rows even when the input list is
			// far larger than the visible area.
			m.loaded = true
			for p := 0; p < 5; p++ {
				edits := make([]rewindRecord, 0, 10)
				for r := 0; r < 10; r++ {
					id := "row" + string(rune('a'+r)) + string(rune('A'+p))
					edits = append(edits, rewindRecord{
						ID: id, TS: 1700000000000 + int64(p*1000+r),
						Module:  "demo",
						Trigger: "manual",
						Files:   []rewindFileEntry{{Path: "f.txt", Op: "modify"}},
					})
				}
				m.packs = append(m.packs, rewindPack{
					Working: p == 0, EditCount: len(edits), Edits: edits,
				})
			}
			m.rebuildRows()
			// Park the cursor in the middle so the scroll window must
			// shift; previous overflow surfaced specifically when the
			// cursor moved past the natural top-of-list window.
			m.cursor = len(m.rows) / 2
		}},
	}
	for _, sb := range stateBuilders {
		for _, c := range cases {
			w, h := c[0], c[1]
			m := newRewindModel(st)
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
			// Regression: the bottom panel border must survive the
			// MaxHeight crop. If row-style padding pushed inner content
			// past the panel's wrap target, lipgloss would soft-wrap
			// each row and the bottom-border row gets eaten — the user
			// reported this as "list grows above the rest of interface,
			// bottom not visible". Assert the last visible row carries
			// the rounded-corner glyphs.
			last := strings.TrimRight(lines[len(lines)-1], " ")
			if !strings.Contains(last, "╰") && !strings.Contains(last, "╯") {
				t.Errorf("%s %dx%d → bottom border missing (last row: %q)",
					sb.name, w, h, last)
			}
		}
	}
}
