package sysstatus

import "testing"

func TestTrimArgs(t *testing.T) {
	cases := []struct {
		name, args, comm, want string
	}{
		{"empty", "", "node", ""},
		{"strip path drop matching comm", "/usr/bin/node /opt/pm2/Daemon.js", "node", "/opt/pm2/Daemon.js"},
		{"strip path keep non-matching head", "/usr/bin/python3 server.py", "python", "python3 server.py"},
		{"bare exe matches comm", "/usr/bin/bun", "bun", ""},
		{"bare exe no match", "/opt/foo/runner", "node", "runner"},
		{"no path with args", "bun run dev", "bun", "run dev"},
		{"no path bare matches", "node", "node", ""},
		{"truncation", "node " + longArg(80), "node", longArg(60) + "…"},
	}
	for _, c := range cases {
		got := TrimArgs(c.args, c.comm)
		if got != c.want {
			t.Errorf("%s: TrimArgs(%q,%q) = %q, want %q", c.name, c.args, c.comm, got, c.want)
		}
	}
}

func longArg(n int) string {
	b := make([]byte, n)
	for i := range b {
		b[i] = 'x'
	}
	return string(b)
}
