package tui

import (
	"strings"
	"testing"
)

// TestRewindNarrowOverflow forces the case the user reported: a narrow
// terminal (w=60) with many long-label edit records. Two bugs surfaced
// together — (1) row-style Padding(0, 1) pushing content past the
// PanelBorder wrap target so every row soft-wrapped to 2 visual lines,
// and (2) a trailing `\n` from the row loop inflating lipgloss's
// measured content height by one row. Either one alone would crop the
// bottom border off the left panel via MaxHeight. The test asserts the
// left panel terminates in a `╰` corner in the last visual row.
func TestRewindNarrowOverflow(t *testing.T) {
	st := NewStyles()
	m := newRewindModel(st)
	m.SetSize(60, 20)
	m.loaded = true
	for p := 0; p < 3; p++ {
		edits := make([]rewindRecord, 0, 10)
		for r := 0; r < 10; r++ {
			edits = append(edits, rewindRecord{
				ID: "abc-" + string(rune('a'+r)) + "-" + string(rune('A'+p)),
				TS: 1700000000000, Module: "long-module-name-here",
				Trigger: "manual-trig",
				Files:   []rewindFileEntry{{Path: "f.txt", Op: "modify"}},
			})
		}
		m.packs = append(m.packs, rewindPack{Working: p == 0, EditCount: len(edits), Edits: edits})
	}
	m.rebuildRows()
	m.cursor = len(m.rows) / 2
	out := m.View(60, 20)
	plain := stripANSI(out)
	lines := strings.Split(plain, "\n")
	last := lines[len(lines)-1]
	// JoinHorizontal pastes the two panels side-by-side. The left panel
	// owns the first ~listW cols (~30 for w=60). The bottom-border crop
	// bug surfaces as a non-corner char in the left half of the last row
	// even though the right half still terminates in `╯`. Check the
	// leading slice specifically so the right panel's corner can't mask
	// a missing left-panel corner.
	leftSlice := last
	if len(leftSlice) > 30 {
		leftSlice = leftSlice[:30]
	}
	if !strings.Contains(leftSlice, "╰") {
		t.Errorf("LEFT panel bottom border missing — leftSlice=%q full=%q", leftSlice, last)
	}
}
