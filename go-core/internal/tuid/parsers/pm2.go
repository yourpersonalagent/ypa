package parsers

// pm2.go — parsers for `pm2 status` (ASCII-art table) and `pm2 logs`
// (the streaming log dump).
//
// `pm2 jlist` is the canonical machine-readable form and is already
// consumed by tuid/status.go's Sampler. The parsers here exist for
// **job log** consumption: when the operator runs `yha status` or
// `yha logs <svc>` through the daemon, the captured stdout is the
// ASCII table or the log stream. We extract the bits worth highlighting.

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

var (
	// One row of `pm2 status` looks like:
	//   │ id │ YHA-Bridge        │ default     │ 0.0.1   │ fork    │ 31416    │ 12h    │ 2    │ online    │ 0%       │ 88.3mb   │ admin    │ disabled │
	// We don't insist on every column; just the bits the dashboard
	// header line needs.
	rePM2Row = regexp.MustCompile(`(?m)^\s*│\s*\d+\s*│\s*(\S+)\s*│.+?│\s*(online|stopped|errored|launching|stopping)\s*│`)
)

// ParsePM2Status extracts (name, status) tuples from a `pm2 status`
// ASCII table. Caller gets a one-liner summary and a per-process
// table-like list. Falls through to raw on non-table output.
func ParsePM2Status(raw []byte) Pretty {
	matches := rePM2Row.FindAllStringSubmatch(string(raw), -1)
	out := Pretty{Facts: map[string]string{}}
	online, off := 0, 0
	for _, m := range matches {
		name, status := m[1], strings.ToLower(m[2])
		style := StyleOK
		if status != "online" {
			style = StyleError
			off++
		} else {
			online++
		}
		out.Lines = append(out.Lines, Line{
			Style: style,
			Text:  fmt.Sprintf("%-18s %s", name, status),
		})
	}
	out.Facts["online"] = strconv.Itoa(online)
	out.Facts["offline"] = strconv.Itoa(off)
	switch {
	case len(matches) == 0:
		out.Summary = "pm2: no processes parsed"
		out.Partial = true
	case off == 0:
		out.Summary = fmt.Sprintf("pm2: %d online", online)
	default:
		out.Summary = fmt.Sprintf("pm2: %d online, %d offline", online, off)
	}
	return out
}

// ParsePM2Logs scans `pm2 logs <svc>` output. The line format is:
//   <name>            | <timestamp>: <body>
// We pass non-empty body lines through as plain text, but flag any
// line containing "[ERROR]" / "ERR!" / "error" in red, and "[WARN]" /
// "warn" in yellow.
func ParsePM2Logs(raw []byte) Pretty {
	body := string(raw)
	lines := strings.Split(body, "\n")
	var styled []Line
	var errs, warns int
	for _, l := range lines {
		trim := strings.TrimSpace(l)
		if trim == "" {
			continue
		}
		switch {
		case reErrorLine.MatchString(trim):
			errs++
			styled = append(styled, Line{Style: StyleError, Text: trim})
		case reWarnLine.MatchString(trim):
			warns++
			styled = append(styled, Line{Style: StyleWarn, Text: trim})
		default:
			styled = append(styled, Line{Text: trim})
		}
	}
	out := Pretty{
		Lines: styled,
		Facts: map[string]string{
			"errors":   strconv.Itoa(errs),
			"warnings": strconv.Itoa(warns),
		},
	}
	switch {
	case errs > 0:
		out.Summary = fmt.Sprintf("logs: %d error%s, %d warning%s",
			errs, plural(errs), warns, plural(warns))
	case warns > 0:
		out.Summary = fmt.Sprintf("logs: %d warning%s", warns, plural(warns))
	default:
		out.Summary = fmt.Sprintf("logs: %d lines, no errors", len(styled))
	}
	return out
}
