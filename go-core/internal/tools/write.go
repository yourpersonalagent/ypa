// Write tool — Go port of the fs.writeFile branch from
// bridge/tools/exec.ts. Differences from the JS version:
//
//   - mkdir -p of the parent (matches the JS mkdir({recursive:true}))
//   - atomic write via temp file + rename, so a crash mid-write
//     doesn't leave a half-written file the model thinks succeeded
//   - 0644 perms on the final file, 0755 on created parent dirs
package tools

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
)

// writeRun writes content to file_path. Parent directories are
// created with 0755 permissions; the file itself lands at 0644 via
// an atomic temp+rename so a crash mid-write doesn't leave the
// destination half-written.
func (e *Executor) writeRun(ctx context.Context, args map[string]any) (*Result, error) {
	path := argString(args, "file_path", "")
	if path == "" {
		return &Result{OK: false, Error: "Write: missing file_path"}, nil
	}
	content := argString(args, "content", "")

	resolved, err := ResolveSafePath(path, e.CWD)
	if err != nil {
		return errResult(err), nil
	}
	if err := ctx.Err(); err != nil {
		return &Result{OK: false, Error: err.Error()}, nil
	}

	dir := filepath.Dir(resolved)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return &Result{OK: false, Error: "Write: mkdir: " + err.Error()}, nil
	}

	tmp, err := os.CreateTemp(dir, ".yha-write-*")
	if err != nil {
		return &Result{OK: false, Error: "Write: tempfile: " + err.Error()}, nil
	}
	tmpPath := tmp.Name()
	// Best-effort cleanup if anything below fails.
	defer func() {
		if _, statErr := os.Stat(tmpPath); statErr == nil {
			_ = os.Remove(tmpPath)
		}
	}()

	n, werr := tmp.WriteString(content)
	if cerr := tmp.Close(); cerr != nil && werr == nil {
		werr = cerr
	}
	if werr != nil {
		return &Result{OK: false, Error: "Write: " + werr.Error()}, nil
	}
	if err := os.Chmod(tmpPath, 0o644); err != nil {
		return &Result{OK: false, Error: "Write: chmod: " + err.Error()}, nil
	}
	if err := os.Rename(tmpPath, resolved); err != nil {
		return &Result{OK: false, Error: "Write: rename: " + err.Error()}, nil
	}

	return &Result{
		OK:      true,
		Content: fmt.Sprintf("wrote %d bytes to %s", n, resolved),
		Meta: map[string]any{
			"bytes_written": n,
			"path":          resolved,
		},
	}, nil
}
