// Package sysstatus provides cross-platform PM2 + top-process samplers
// used by both the TUI daemon (internal/tuid) and the standalone rewind
// service (cmd/yha-rewind). Each sampler has Linux/macOS and Windows
// build-tagged variants, so callers get the right behaviour for free
// without re-implementing the platform branch in every consumer.
package sysstatus

import "strings"

// TopMaxRows caps the number of rows SampleTop returns. The dashboards
// that render this only have room for a handful, and bounding it here
// keeps the wire payload small.
const TopMaxRows = 7

// PM2Process is one row of the pm2-like service table. On Linux/macOS
// it comes straight from `pm2 jlist`; on Windows it comes from the JSON
// PID file yha.ps1 writes (bridge/state/yha-tui/yha-windows.pids.json)
// enriched with Get-Process liveness/WS/CPU.
type PM2Process struct {
	Name     string `json:"name"`
	PID      int    `json:"pid,omitempty"`
	Status   string `json:"status"`
	Uptime   int64  `json:"uptime_ms,omitempty"`
	Restarts int    `json:"restarts,omitempty"`
	CPU      int    `json:"cpu,omitempty"`
	MemMB    int    `json:"mem_mb,omitempty"`
}

// TopProc is one row of the "what's actually running" panel — the
// top-by-CPU process snapshot. Surfaces bun/vite/node children that
// pm2's own jlist misses (because they're spawned *inside* YHA-Bridge,
// not managed by pm2).
type TopProc struct {
	PID   int     `json:"pid"`
	CPU   float64 `json:"cpu"`            // % CPU on Linux (ps pcpu); cumulative seconds on Windows
	MemMB int     `json:"mem_mb"`         // RSS in MiB
	Cmd   string  `json:"cmd"`            // short comm name (bun, node, go, …)
	Args  string  `json:"args,omitempty"` // best-effort full command line, trimmed
	Tag   string  `json:"tag,omitempty"`  // "yha" if this is a YHA-tracked tree, "" otherwise
}

// TrimArgs shortens a full command line for compact dashboard rendering.
// ps `args` typically starts with the executable's absolute path; we render
// `comm` in its own column, so we strip both the path and (if it matches)
// the executable's basename — otherwise rows render as `node | node /opt/...`.
func TrimArgs(s, comm string) string {
	if s == "" {
		return ""
	}
	if sp := strings.IndexByte(s, ' '); sp > 0 {
		head := s[:sp]
		if slash := strings.LastIndexByte(head, '/'); slash >= 0 {
			head = head[slash+1:]
		}
		rest := s[sp+1:]
		if comm != "" && head == comm {
			s = rest
		} else {
			s = head + " " + rest
		}
	} else if slash := strings.LastIndexByte(s, '/'); slash >= 0 {
		base := s[slash+1:]
		if comm != "" && base == comm {
			s = ""
		} else {
			s = base
		}
	} else if comm != "" && s == comm {
		s = ""
	}
	const cap = 60
	if len(s) > cap {
		s = s[:cap] + "…"
	}
	return s
}
