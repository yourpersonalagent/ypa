package tui

import (
	"strings"
	"testing"
)

func TestSessionsViewHeight(t *testing.T) {
	cases := []struct {
		name    string
		w, h    int
		nSess   int
		loading bool
		errStr  string
	}{
		{"loaded 8 sessions, 35x120", 120, 30, 8, false, ""},
		{"loading state", 120, 30, 0, true, ""},
		{"err state", 120, 30, 0, false, "boom"},
		{"empty list", 120, 30, 0, false, ""},
		{"tiny terminal 50x10", 50, 8, 8, false, ""},
		{"big list 30 sessions", 120, 30, 30, false, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			m := newSessionsModel(Options{}, NewStyles(), nil, "")
			m.loading = tc.loading
			m.err = tc.errStr
			m.loaded = !tc.loading
			for i := 0; i < tc.nSess; i++ {
				m.sessions = append(m.sessions, sessionInfoTUI{
					ID:           "id" + string(rune('a'+i%26)),
					Name:         "name",
					MessageCount: i,
					LastUsed:     0,
				})
			}
			m.SetSize(tc.w, tc.h)
			out := m.View(tc.w, tc.h)
			lines := strings.Split(out, "\n")
			if len(lines) != tc.h {
				t.Errorf("got %d lines, want %d (h=%d)\n=== output ===\n%s\n===",
					len(lines), tc.h, tc.h, out)
			}
			if testing.Verbose() {
				t.Logf("=== %s ===\n%s\n===", tc.name, out)
			}
		})
	}
}
