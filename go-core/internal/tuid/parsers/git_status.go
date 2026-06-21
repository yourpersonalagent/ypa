package parsers

// git_status.go — parser for `git status -sb` (short format) and
// `git status --porcelain=v2 --branch`.
//
// We accept both; the short format is what `yha status` runs (cheap,
// readable), the v2 format is what the Sampler uses for the structured
// snapshot path. Both reduce to a per-file "<XY> path" row.

import (
	"fmt"
	"strconv"
	"strings"
)

// ParseGitStatus walks the input line by line, accumulating staged /
// unstaged / untracked counts and surfacing the branch line.
func ParseGitStatus(raw []byte) Pretty {
	body := string(raw)
	out := Pretty{Facts: map[string]string{}}

	var branch string
	var ahead, behind int
	var staged, unstaged, untracked int
	var dirtyLines []Line

	for _, l := range strings.Split(body, "\n") {
		if l == "" {
			continue
		}
		switch {
		case strings.HasPrefix(l, "## "):
			// short-format branch line: "## main...origin/main [ahead 1, behind 2]"
			rest := strings.TrimPrefix(l, "## ")
			branch, ahead, behind = parseShortBranchLine(rest)
		case strings.HasPrefix(l, "# branch.head "):
			branch = strings.TrimPrefix(l, "# branch.head ")
		case strings.HasPrefix(l, "# branch.ab "):
			parts := strings.Fields(strings.TrimPrefix(l, "# branch.ab "))
			if len(parts) >= 2 {
				ahead, _ = strconv.Atoi(strings.TrimPrefix(parts[0], "+"))
				behind, _ = strconv.Atoi(strings.TrimPrefix(parts[1], "-"))
			}
		case strings.HasPrefix(l, "?? "):
			untracked++
			dirtyLines = append(dirtyLines, Line{Style: StyleMuted, Text: l})
		case strings.HasPrefix(l, "1 ") || strings.HasPrefix(l, "2 "):
			// porcelain v2: "1 XY ..." or "2 XY ..."
			fs := strings.Fields(l)
			if len(fs) >= 2 && len(fs[1]) == 2 {
				if fs[1][0] != '.' {
					staged++
				}
				if fs[1][1] != '.' {
					unstaged++
				}
			}
			dirtyLines = append(dirtyLines, Line{Text: l})
		default:
			// Short format file line: "XY path". X = staged, Y = unstaged.
			// "?? path" already handled above.
			if len(l) >= 3 && (l[2] == ' ' || l[2] == '\t') {
				switch {
				case l[0] == '?' && l[1] == '?':
					untracked++
				default:
					if l[0] != ' ' && l[0] != '?' {
						staged++
					}
					if l[1] != ' ' && l[1] != '?' {
						unstaged++
					}
				}
				dirtyLines = append(dirtyLines, Line{Text: l})
			}
		}
	}

	out.Facts["branch"] = branch
	out.Facts["ahead"] = strconv.Itoa(ahead)
	out.Facts["behind"] = strconv.Itoa(behind)
	out.Facts["staged"] = strconv.Itoa(staged)
	out.Facts["unstaged"] = strconv.Itoa(unstaged)
	out.Facts["untracked"] = strconv.Itoa(untracked)
	dirty := staged+unstaged+untracked > 0

	switch {
	case branch == "" && len(dirtyLines) == 0:
		out.Summary = "git: no status parsed"
		out.Partial = true
	case !dirty:
		out.Summary = fmt.Sprintf("git: %s (clean)", safeBranch(branch))
	default:
		out.Summary = fmt.Sprintf("git: %s · staged %d  unstaged %d  untracked %d",
			safeBranch(branch), staged, unstaged, untracked)
		if ahead+behind > 0 {
			out.Summary += fmt.Sprintf("  (↑%d ↓%d)", ahead, behind)
		}
	}
	out.Lines = dirtyLines
	return out
}

func safeBranch(b string) string {
	if b == "" {
		return "(detached)"
	}
	return b
}

// parseShortBranchLine handles the "## main...origin/main [ahead 1, behind 2]"
// shape from `git status -sb`. Returns branch name + ahead + behind.
func parseShortBranchLine(rest string) (branch string, ahead, behind int) {
	// Split off the optional "[ahead N, behind M]" suffix.
	tail := ""
	if i := strings.Index(rest, " ["); i >= 0 {
		tail = rest[i+2:]
		rest = rest[:i]
	}
	// rest is now "main" or "main...origin/main"
	if i := strings.Index(rest, "..."); i >= 0 {
		branch = rest[:i]
	} else {
		branch = rest
	}
	// tail looks like "ahead 1, behind 2]" — robustly extract digits.
	for _, chunk := range strings.Split(strings.TrimSuffix(tail, "]"), ",") {
		chunk = strings.TrimSpace(chunk)
		switch {
		case strings.HasPrefix(chunk, "ahead "):
			ahead, _ = strconv.Atoi(strings.TrimPrefix(chunk, "ahead "))
		case strings.HasPrefix(chunk, "behind "):
			behind, _ = strconv.Atoi(strings.TrimPrefix(chunk, "behind "))
		}
	}
	return branch, ahead, behind
}
