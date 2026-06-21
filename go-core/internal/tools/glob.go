// Glob tool — Go-native replacement for the spawn('find', …) branch
// in bridge/tools/exec.ts. Pure stdlib: filepath.Walk + a small
// custom matcher that handles `**` (recursive segment) on top of
// stdlib path/filepath.Match.
//
// Behaviour:
//   - Default search root is executor.CWD; explicit `path` arg is
//     resolved through security.ResolveSafePath
//   - Results sorted by mtime descending (most recent first)
//   - Capped at 100 entries; surplus reported in Meta.truncated
package tools

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

const globMaxResults = 100

// globRun finds files under args["path"] (default: executor cwd)
// that match args["pattern"]. The pattern can include `**` to mean
// "any number of nested dirs".
func (e *Executor) globRun(ctx context.Context, args map[string]any) (*Result, error) {
	pattern := argString(args, "pattern", "")
	if pattern == "" {
		return &Result{OK: false, Error: "Glob: missing pattern"}, nil
	}
	base := argString(args, "path", e.CWD)
	if base == "" {
		base = "."
	}
	resolvedBase, err := ResolveSafePath(base, e.CWD)
	if err != nil {
		return errResult(err), nil
	}

	type hit struct {
		path  string
		mtime int64
	}
	var hits []hit

	walkErr := filepath.Walk(resolvedBase, func(p string, info os.FileInfo, err error) error {
		if err != nil {
			// Don't bubble individual errors (permission denied on a
			// subdir shouldn't abort the whole walk).
			return nil
		}
		// Honour ctx cancellation cheaply.
		if cerr := ctx.Err(); cerr != nil {
			return cerr
		}
		if info.IsDir() {
			return nil
		}
		// Match against the path relative to the search base — this is
		// what the user's pattern is expected to apply to.
		rel, relErr := filepath.Rel(resolvedBase, p)
		if relErr != nil {
			rel = p
		}
		if globMatch(pattern, rel) {
			hits = append(hits, hit{path: p, mtime: info.ModTime().UnixNano()})
		}
		return nil
	})
	if walkErr != nil && walkErr != context.Canceled && walkErr != context.DeadlineExceeded {
		return &Result{OK: false, Error: "Glob: " + walkErr.Error()}, nil
	}

	// Sort by mtime descending (most recent first).
	sort.Slice(hits, func(i, j int) bool { return hits[i].mtime > hits[j].mtime })

	truncated := false
	if len(hits) > globMaxResults {
		hits = hits[:globMaxResults]
		truncated = true
	}

	var b strings.Builder
	for _, h := range hits {
		b.WriteString(h.path)
		b.WriteByte('\n')
	}
	content := strings.TrimRight(b.String(), "\n")
	if content == "" {
		content = "(no files found)"
	} else if truncated {
		content += fmt.Sprintf("\n... (truncated at %d entries)", globMaxResults)
	}

	return &Result{
		OK:      true,
		Content: content,
		Meta: map[string]any{
			"matched":   len(hits),
			"truncated": truncated,
		},
	}, nil
}

// globMatch matches `pattern` against `name` with `**` recursion
// support. Without `**`, falls back to stdlib path/filepath.Match.
//
// Algorithm:
//   - Split pattern and name on `/`
//   - Walk both in lockstep; a `**` segment matches zero or more
//     name segments
//   - Other segments use path.Match for `?` / `[abc]` / `*`
func globMatch(pattern, name string) bool {
	// Normalise separators to forward slashes — Match accepts both
	// but our split needs consistency.
	pattern = filepath.ToSlash(pattern)
	name = filepath.ToSlash(name)

	if !strings.Contains(pattern, "**") {
		// Simple path: try Match against the full name. Also try
		// against just the base — bare patterns like "*.go" should
		// match any file with that extension regardless of depth.
		if m, _ := filepath.Match(pattern, name); m {
			return true
		}
		if !strings.Contains(pattern, "/") {
			if m, _ := filepath.Match(pattern, filepath.Base(name)); m {
				return true
			}
		}
		return false
	}

	pp := strings.Split(pattern, "/")
	nn := strings.Split(name, "/")
	return matchSegments(pp, nn)
}

// matchSegments is the recursive matcher for **-aware globs.
func matchSegments(pp, nn []string) bool {
	for {
		if len(pp) == 0 {
			return len(nn) == 0
		}
		head := pp[0]
		if head == "**" {
			// `**` followed by nothing matches everything remaining.
			if len(pp) == 1 {
				return true
			}
			// Try to match the rest against every suffix of nn.
			for i := 0; i <= len(nn); i++ {
				if matchSegments(pp[1:], nn[i:]) {
					return true
				}
			}
			return false
		}
		if len(nn) == 0 {
			return false
		}
		ok, err := filepath.Match(head, nn[0])
		if err != nil || !ok {
			return false
		}
		pp = pp[1:]
		nn = nn[1:]
	}
}
