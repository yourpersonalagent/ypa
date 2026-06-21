// Grep tool — fast file content search.
//
// When ripgrep (`rg`) is on $PATH we shell out to it via `rg --json`
// and convert the structured output back into the Result shape callers
// expect. When `rg` is missing we fall through to a pure-Go regexp
// walk so the binary still works on hosts without ripgrep installed.
//
// Both paths default-skip the noisy directories that dominate a
// session-heavy repo (.git, node_modules, .venv, dist, build) on top
// of any caller-supplied glob filter.
//
// Output modes:
//   - "content"             (default): "<path>:<lineno>:<match>"
//   - "files_with_matches":           "<path>" once per file
//   - "count":                          "<path>:<count>" per file
package tools

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

const (
	grepDefaultHeadLimit = 250
	// grepMaxPatternLen is a sanity cap on user-supplied regex length.
	// `rg` itself happily handles much longer, but a multi-MiB pattern
	// is almost always abuse — bail before we spawn anything.
	grepMaxPatternLen = 8 * 1024
)

// defaultSkipDirs are directory basenames we never descend into,
// regardless of the user's glob filter. Mirrors the .gitignore-style
// defaults a developer using grep/rg on a JS+Python repo would expect.
var defaultSkipDirs = []string{
	".git",
	"node_modules",
	".venv",
	"dist",
	"build",
}

// rgPath holds the absolute path to `rg` if it was found at package
// init, or "" if not. Tests may override this to force the pure-Go
// fallback path even on hosts that have ripgrep installed.
var rgPath = func() string {
	p, err := exec.LookPath("rg")
	if err != nil {
		return ""
	}
	return p
}()

// grepRun searches args["path"] (default: executor cwd) for lines
// matching args["pattern"]. Prefers ripgrep when available; falls
// back to a pure-Go walker otherwise.
func (e *Executor) grepRun(ctx context.Context, args map[string]any) (*Result, error) {
	patternStr := argString(args, "pattern", "")
	if patternStr == "" {
		return &Result{OK: false, Error: "Grep: missing pattern"}, nil
	}
	if len(patternStr) > grepMaxPatternLen {
		return &Result{OK: false, Error: "Grep: pattern too long"}, nil
	}

	base := argString(args, "path", e.CWD)
	if base == "" {
		base = "."
	}
	resolvedBase, err := ResolveSafePath(base, e.CWD)
	if err != nil {
		return errResult(err), nil
	}

	mode := argString(args, "output_mode", "content")
	switch mode {
	case "content", "files_with_matches", "count":
	default:
		mode = "content"
	}

	headLimit := argInt(args, "head_limit", grepDefaultHeadLimit)
	if headLimit < 1 {
		headLimit = grepDefaultHeadLimit
	}

	if rgPath != "" {
		return e.grepWithRipgrep(ctx, args, resolvedBase, patternStr, mode, headLimit)
	}
	return e.grepWithWalker(ctx, args, resolvedBase, patternStr, mode, headLimit)
}

// grepWithRipgrep shells out to `rg --json` and converts the streamed
// records into the same Result shape grepWithWalker produces.
func (e *Executor) grepWithRipgrep(
	ctx context.Context,
	args map[string]any,
	resolvedBase, patternStr, mode string,
	headLimit int,
) (*Result, error) {
	rgArgs := []string{}

	// Default skip globs — applied in both content and files_with_matches/count modes.
	for _, d := range defaultSkipDirs {
		rgArgs = append(rgArgs, "--glob", "!"+d)
		rgArgs = append(rgArgs, "--glob", "!**/"+d+"/**")
	}

	if argBool(args, "-i", false) {
		rgArgs = append(rgArgs, "--ignore-case")
	}
	if globFilter := argString(args, "glob", ""); globFilter != "" {
		rgArgs = append(rgArgs, "--glob", globFilter)
	}
	if typ := argString(args, "type", ""); typ != "" {
		rgArgs = append(rgArgs, "--type", typ)
	}
	if argBool(args, "multiline", false) {
		rgArgs = append(rgArgs, "--multiline", "--multiline-dotall")
	}

	// Output-mode-specific flags.
	switch mode {
	case "files_with_matches":
		rgArgs = append(rgArgs, "--files-with-matches")
	case "count":
		rgArgs = append(rgArgs, "--count")
	default: // content
		// Context flags only apply in content mode.
		if n := argInt(args, "-A", 0); n > 0 {
			rgArgs = append(rgArgs, "--after-context", fmt.Sprintf("%d", n))
		}
		if n := argInt(args, "-B", 0); n > 0 {
			rgArgs = append(rgArgs, "--before-context", fmt.Sprintf("%d", n))
		}
		if n := argInt(args, "-C", 0); n > 0 {
			rgArgs = append(rgArgs, "--context", fmt.Sprintf("%d", n))
		}
		rgArgs = append(rgArgs, "--json")
	}

	// Terminator + positional args. `--` prevents a leading-dash pattern
	// from being parsed as a flag.
	rgArgs = append(rgArgs, "--", patternStr, resolvedBase)

	cmd := exec.CommandContext(ctx, rgPath, rgArgs...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return &Result{OK: false, Error: "Grep: " + err.Error()}, nil
	}
	// Drain stderr but don't surface it unless rg exited with an error
	// we couldn't interpret from stdout. rg writes nothing to stderr on
	// success or "no matches".
	var stderrBuf strings.Builder
	cmd.Stderr = &cappedStringBuilder{b: &stderrBuf, cap: 4096}

	if err := cmd.Start(); err != nil {
		return &Result{OK: false, Error: "Grep: " + err.Error()}, nil
	}

	var (
		lines         []string
		filesMatched  = map[string]struct{}{}
		truncated     bool
		stopReading   bool
		emittedFiles  int
	)

	scanner := bufio.NewScanner(stdout)
	scanner.Buffer(make([]byte, 64*1024), 4*1024*1024)

	switch mode {
	case "files_with_matches":
		for scanner.Scan() {
			if cerr := ctx.Err(); cerr != nil {
				stopReading = true
				break
			}
			p := strings.TrimRight(scanner.Text(), "\r\n")
			if p == "" {
				continue
			}
			if emittedFiles >= headLimit {
				truncated = true
				stopReading = true
				break
			}
			lines = append(lines, p)
			filesMatched[p] = struct{}{}
			emittedFiles++
		}
	case "count":
		for scanner.Scan() {
			if cerr := ctx.Err(); cerr != nil {
				stopReading = true
				break
			}
			ln := strings.TrimRight(scanner.Text(), "\r\n")
			if ln == "" {
				continue
			}
			if emittedFiles >= headLimit {
				truncated = true
				stopReading = true
				break
			}
			lines = append(lines, ln)
			// ln is "<path>:<count>" — record just the path.
			if i := strings.LastIndexByte(ln, ':'); i > 0 {
				filesMatched[ln[:i]] = struct{}{}
			}
			emittedFiles++
		}
	default: // content
		showLineNo := argBool(args, "-n", false)
		var (
			currentFile string
			emitted     int
		)
		for scanner.Scan() {
			if cerr := ctx.Err(); cerr != nil {
				stopReading = true
				break
			}
			raw := scanner.Bytes()
			if len(raw) == 0 {
				continue
			}
			var rec rgRecord
			if err := json.Unmarshal(raw, &rec); err != nil {
				continue
			}
			switch rec.Type {
			case "begin":
				currentFile = rec.Data.Path.Text
				filesMatched[currentFile] = struct{}{}
			case "match", "context":
				if currentFile == "" {
					currentFile = rec.Data.Path.Text
				}
				if emitted >= headLimit {
					truncated = true
					stopReading = true
					break
				}
				lineText := strings.TrimRight(rec.Data.Lines.Text, "\r\n")
				out := rec.Data.Path.Text + ":"
				if showLineNo {
					out += fmt.Sprintf("%d:", rec.Data.LineNumber)
				}
				out += lineText
				lines = append(lines, out)
				emitted++
			case "end":
				currentFile = ""
			}
			if stopReading {
				break
			}
		}
	}

	// Drain any remaining stdout so rg doesn't block on a full pipe
	// when we stopped reading early. Closing the pipe is preferable
	// but exec.Cmd doesn't expose that directly — killing the process
	// via context cancellation is the cleanest option.
	if stopReading {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
	}
	waitErr := cmd.Wait()

	if err := scanner.Err(); err != nil && !stopReading {
		// Scanner errors are rare (only on truly malformed I/O); surface
		// them rather than silently truncating.
		return &Result{OK: false, Error: "Grep: " + err.Error()}, nil
	}

	// rg exit codes: 0 = matches, 1 = no matches, 2 = error (bad regex,
	// fatal I/O). Treat 2 as a tool error so callers see the same
	// "bad regex" surface they'd get from the pure-Go path. We can't
	// distinguish a kill from a real error via ExitCode alone, so skip
	// this check when we deliberately killed the process.
	if !stopReading && waitErr != nil {
		if ee, ok := waitErr.(*exec.ExitError); ok && ee.ExitCode() == 2 {
			msg := strings.TrimSpace(stderrBuf.String())
			if msg == "" {
				msg = "ripgrep error"
			}
			return &Result{OK: false, Error: "Grep: " + msg}, nil
		}
	}

	// Stable sort for output_mode != content (rg already gives us
	// deterministic ordering by walk order, but the pure-Go fallback
	// sorts alphabetically — match that).
	if mode == "files_with_matches" || mode == "count" {
		sort.Strings(lines)
	}

	return renderGrepResult(lines, filesMatched, mode, headLimit, truncated), nil
}

// rgRecord is the minimal shape we read from `rg --json` output.
// Fields we don't consume are intentionally omitted.
type rgRecord struct {
	Type string `json:"type"`
	Data struct {
		Path struct {
			Text string `json:"text"`
		} `json:"path"`
		Lines struct {
			Text string `json:"text"`
		} `json:"lines"`
		LineNumber int `json:"line_number"`
	} `json:"data"`
}

// cappedStringBuilder is a minimal io.Writer that drops bytes past
// `cap`. Used for rg's stderr — we don't need every line, just the
// first few if rg actually crashed.
type cappedStringBuilder struct {
	b   *strings.Builder
	cap int
}

func (w *cappedStringBuilder) Write(p []byte) (int, error) {
	remaining := w.cap - w.b.Len()
	if remaining <= 0 {
		return len(p), nil
	}
	if len(p) > remaining {
		w.b.Write(p[:remaining])
		return len(p), nil
	}
	return w.b.Write(p)
}

// grepWithWalker is the pure-Go fallback used when `rg` is not
// available. Walks resolvedBase with filepath.WalkDir, skipping the
// default-skip basenames before descending.
func (e *Executor) grepWithWalker(
	ctx context.Context,
	args map[string]any,
	resolvedBase, patternStr, mode string,
	headLimit int,
) (*Result, error) {
	if argBool(args, "-i", false) {
		patternStr = "(?i)" + patternStr
	}
	re, err := regexp.Compile(patternStr)
	if err != nil {
		return &Result{OK: false, Error: "Grep: bad regex: " + err.Error()}, nil
	}

	globFilter := argString(args, "glob", "")
	showLineNo := argBool(args, "-n", false)

	type fileStat struct {
		path    string
		count   int
		samples []string
	}
	stats := map[string]*fileStat{}

	var emittedContent int

	walkErr := filepath.WalkDir(resolvedBase, func(p string, d os.DirEntry, err error) error {
		if err != nil {
			return nil
		}
		if cerr := ctx.Err(); cerr != nil {
			return cerr
		}
		// Skip the canonical noisy directories before recursing.
		if d.IsDir() {
			if p != resolvedBase && isDefaultSkipDir(filepath.Base(p)) {
				return filepath.SkipDir
			}
			return nil
		}
		if globFilter != "" {
			rel, relErr := filepath.Rel(resolvedBase, p)
			if relErr != nil {
				rel = p
			}
			if !globMatch(globFilter, rel) {
				return nil
			}
		}
		if mode == "content" && emittedContent >= headLimit {
			return filepath.SkipDir // stop once we have enough
		}
		f, ferr := os.Open(p)
		if ferr != nil {
			return nil
		}
		st := &fileStat{path: p}
		scanner := bufio.NewScanner(f)
		scanner.Buffer(make([]byte, 64*1024), 1024*1024)
		lineNum := 0
		for scanner.Scan() {
			lineNum++
			line := scanner.Text()
			if !re.MatchString(line) {
				continue
			}
			st.count++
			if mode == "content" && emittedContent < headLimit {
				rendered := p + ":"
				if showLineNo {
					rendered += fmt.Sprintf("%d:", lineNum)
				}
				rendered += line
				st.samples = append(st.samples, rendered)
				emittedContent++
			}
		}
		_ = f.Close()
		_ = scanner.Err()
		if st.count > 0 {
			stats[p] = st
		}
		return nil
	})
	if walkErr != nil && walkErr != context.Canceled && walkErr != context.DeadlineExceeded {
		return &Result{OK: false, Error: "Grep: " + walkErr.Error()}, nil
	}

	keys := make([]string, 0, len(stats))
	for k := range stats {
		keys = append(keys, k)
	}
	sort.Strings(keys)

	var lines []string
	filesMatched := map[string]struct{}{}
	switch mode {
	case "files_with_matches":
		for _, k := range keys {
			lines = append(lines, k)
			filesMatched[k] = struct{}{}
		}
	case "count":
		for _, k := range keys {
			lines = append(lines, fmt.Sprintf("%s:%d", k, stats[k].count))
			filesMatched[k] = struct{}{}
		}
	default: // content
		for _, k := range keys {
			lines = append(lines, stats[k].samples...)
			filesMatched[k] = struct{}{}
		}
	}

	truncated := false
	if len(lines) > headLimit {
		lines = lines[:headLimit]
		truncated = true
	}

	return renderGrepResult(lines, filesMatched, mode, headLimit, truncated), nil
}

// renderGrepResult assembles the final Result from a flat slice of
// rendered output lines. Shared by both ripgrep and pure-Go paths so
// callers see a uniform shape.
func renderGrepResult(lines []string, filesMatched map[string]struct{}, mode string, headLimit int, truncated bool) *Result {
	content := strings.Join(lines, "\n")
	if content == "" {
		content = "(no matches)"
	} else if truncated {
		content += fmt.Sprintf("\n... (truncated at %d entries)", headLimit)
	}
	return &Result{
		OK:      true,
		Content: content,
		Meta: map[string]any{
			"files_matched": len(filesMatched),
			"mode":          mode,
			"truncated":     truncated,
		},
	}
}

// isDefaultSkipDir returns true if base matches one of the canonical
// noise directories we never descend into.
func isDefaultSkipDir(base string) bool {
	for _, d := range defaultSkipDirs {
		if base == d {
			return true
		}
	}
	return false
}
