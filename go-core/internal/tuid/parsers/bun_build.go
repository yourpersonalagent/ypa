package parsers

// bun_build.go — parser for `bun run build` output. Vite-style ESM
// build: prints a per-file table, then a summary block with elapsed
// time and gzipped sizes; bun layers its own "✓ N modules transformed"
// line on top.
//
// We don't try to reproduce the table — that's what raw mode is for.
// What the operator actually wants in pretty mode is:
//
//   build ok — 0 errors, 2 warnings, 1.42s, 412kb total
//
// Error and warning detection is a heuristic line scan: any line with
// "error" or "ERROR" or "ERR!" gets flagged red; any line with "warn"
// or "WARN" gets flagged yellow. We deliberately keep this simple — a
// real LSP-style parser is overkill for an operator dashboard.

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
)

// Compiled once at package init so the parser is cheap to call
// repeatedly (e.g. on every log-chunk update).
var (
	reBuildOk      = regexp.MustCompile(`(?i)\bbuilt in (\d+(?:\.\d+)?)s\b`)
	reViteOk       = regexp.MustCompile(`(?i)✓ built in (\d+(?:\.\d+)?)\s*(?:s|ms)`)
	reBundleSize   = regexp.MustCompile(`(?i)\b(\d+(?:\.\d+)?)\s*(?:kb|kib|mb|mib)\s*(?:│|│)?\s*gzip`)
	reErrorLine    = regexp.MustCompile(`(?i)\b(?:error|ERR!)\b`)
	reWarnLine     = regexp.MustCompile(`(?i)\b(?:warn|warning)\b`)
	reModulesXform = regexp.MustCompile(`(?i)(\d+)\s+modules transformed`)
)

// ParseBunBuild scans a `bun run build` job log.
func ParseBunBuild(raw []byte) Pretty {
	body := string(raw)
	lines := strings.Split(body, "\n")

	var errors, warnings int
	var styled []Line
	for _, l := range lines {
		trim := strings.TrimSpace(l)
		if trim == "" {
			continue
		}
		switch {
		case reErrorLine.MatchString(trim):
			errors++
			styled = append(styled, Line{Style: StyleError, Text: trim})
		case reWarnLine.MatchString(trim):
			warnings++
			styled = append(styled, Line{Style: StyleWarn, Text: trim})
		}
	}

	out := Pretty{
		Facts: map[string]string{},
	}

	elapsed := ""
	if m := reViteOk.FindStringSubmatch(body); len(m) == 2 {
		elapsed = m[1] + "s"
	} else if m := reBuildOk.FindStringSubmatch(body); len(m) == 2 {
		elapsed = m[1] + "s"
	}
	if elapsed != "" {
		out.Facts["elapsed"] = elapsed
	}

	if m := reModulesXform.FindStringSubmatch(body); len(m) == 2 {
		out.Facts["modules"] = m[1]
	}

	// Sum the gzipped sizes mentioned in vite's per-file table. Rough
	// but informative: "412kb total" cues "this build emitted a lot".
	totalKB := 0.0
	for _, m := range reBundleSize.FindAllStringSubmatch(body, -1) {
		if v, err := strconv.ParseFloat(m[1], 64); err == nil {
			totalKB += v
		}
	}
	if totalKB > 0 {
		out.Facts["gzip_total_kb"] = fmt.Sprintf("%.1f", totalKB)
	}

	out.Facts["errors"] = strconv.Itoa(errors)
	out.Facts["warnings"] = strconv.Itoa(warnings)

	ok := errors == 0 && (elapsed != "" || strings.Contains(body, "✓") || totalKB > 0)
	switch {
	case errors > 0:
		out.Summary = fmt.Sprintf("build failed — %d error%s, %d warning%s",
			errors, plural(errors), warnings, plural(warnings))
	case ok:
		bits := []string{fmt.Sprintf("%d warning%s", warnings, plural(warnings))}
		if elapsed != "" {
			bits = append(bits, elapsed)
		}
		if totalKB > 0 {
			bits = append(bits, fmt.Sprintf("%.1fkb gzip", totalKB))
		}
		out.Summary = "build ok — " + strings.Join(bits, ", ")
	default:
		out.Summary = "build incomplete (no terminator seen)"
		out.Partial = true
	}

	out.Lines = styled
	return out
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}
