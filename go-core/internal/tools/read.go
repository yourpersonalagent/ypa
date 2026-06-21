// Read tool — Go port of the fs.readFile branch from
// bridge/tools/exec.ts. Adds Claude-Code-style cat -n line numbering,
// offset/limit windowing, and binary-file detection (returns a hex
// preview rather than gibberish).
package tools

import (
	"bufio"
	"context"
	"encoding/hex"
	"fmt"
	"io"
	"os"
	"strings"
)

const (
	defaultReadLimit  = 2000  // lines
	binarySniffBytes  = 512   // bytes to scan for null when sniffing
	maxBinaryPreview  = 256   // bytes shown in hex preview
)

// readRun reads file_path with optional offset/limit windowing.
// offset is 1-indexed (matches Claude Code's Read tool); limit
// defaults to 2000 lines.
func (e *Executor) readRun(ctx context.Context, args map[string]any) (*Result, error) {
	path := argString(args, "file_path", "")
	if path == "" {
		return &Result{OK: false, Error: "Read: missing file_path"}, nil
	}
	resolved, err := ResolveSafePath(path, e.CWD)
	if err != nil {
		return errResult(err), nil
	}

	// Honour ctx cancellation between large reads.
	if err := ctx.Err(); err != nil {
		return &Result{OK: false, Error: err.Error()}, nil
	}

	f, err := os.Open(resolved)
	if err != nil {
		return &Result{OK: false, Error: "Read: " + err.Error()}, nil
	}
	defer f.Close()

	// Sniff first chunk for binary heuristic. Reading into a bounded
	// buffer keeps us out of the way of huge files.
	sniff := make([]byte, binarySniffBytes)
	n, _ := io.ReadFull(f, sniff)
	if n == 0 {
		// Empty file — return empty content, total_lines=0.
		return &Result{
			OK:      true,
			Content: "",
			Meta: map[string]any{
				"bytes_read":  0,
				"total_lines": 0,
				"truncated":   false,
			},
		}, nil
	}
	sniff = sniff[:n]

	if isBinary(sniff) {
		preview := sniff
		if len(preview) > maxBinaryPreview {
			preview = preview[:maxBinaryPreview]
		}
		return &Result{
			OK:      true,
			Content: fmt.Sprintf("(binary file, hex preview)\n%s", hex.EncodeToString(preview)),
			Meta: map[string]any{
				"bytes_read":  n,
				"total_lines": 0,
				"truncated":   true,
				"binary":      true,
			},
		}, nil
	}

	// Rewind so we can re-read line-oriented from the top.
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return &Result{OK: false, Error: "Read: " + err.Error()}, nil
	}

	offset := argInt(args, "offset", 1)
	if offset < 1 {
		offset = 1
	}
	limit := argInt(args, "limit", defaultReadLimit)
	if limit < 1 {
		limit = defaultReadLimit
	}

	scanner := bufio.NewScanner(f)
	// Default 64 KiB token cap is too small for some configs / minified
	// JS; bump to 1 MiB.
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)

	var (
		out       strings.Builder
		lineNum   = 0
		emitted   = 0
		bytesRead = 0
	)
	for scanner.Scan() {
		lineNum++
		line := scanner.Text()
		bytesRead += len(line) + 1 // +1 for the newline scanner stripped
		if lineNum < offset {
			continue
		}
		if emitted >= limit {
			// Keep counting total_lines but stop emitting.
			continue
		}
		// cat -n style: right-aligned 6-wide line number, tab, content.
		out.WriteString(fmt.Sprintf("%6d\t%s\n", lineNum, line))
		emitted++
	}
	if err := scanner.Err(); err != nil {
		return &Result{OK: false, Error: "Read: " + err.Error()}, nil
	}

	truncated := emitted < (lineNum - offset + 1)
	if truncated && emitted >= limit {
		out.WriteString(fmt.Sprintf("... (truncated at %d lines, file has %d total)\n", limit, lineNum))
	}

	return &Result{
		OK:      true,
		Content: out.String(),
		Meta: map[string]any{
			"bytes_read":  bytesRead,
			"total_lines": lineNum,
			"truncated":   truncated,
		},
	}, nil
}

// isBinary returns true if any byte in p is null. Mirrors the cheap
// heuristic used by GNU diff and similar tools — works well enough
// for the "render hex preview vs. text" decision.
func isBinary(p []byte) bool {
	for _, b := range p {
		if b == 0 {
			return true
		}
	}
	return false
}
