// Bash tool — Go port of the spawn('/bin/sh', ['-c', cmd]) branch
// from bridge/tools/exec.ts. Adds a hard 8000-byte cap on stdout
// AND stderr separately, kills the process if either is exceeded,
// and reports an honest exit code via Result.Meta.
package tools

import (
	"bytes"
	"context"
	"errors"
	"os/exec"
	"sync"
	"time"
)

// outBufCap is the per-stream byte cap for stdout/stderr. JS version
// kills when "out.length > 8000" — match exactly.
const outBufCap = 8000

// graceOnTimeout is how long we wait between SIGTERM and SIGKILL when
// the context fires. Keeps tests fast; production sees this only on
// runaway commands.
const graceOnTimeout = 200 * time.Millisecond

// bashRun executes args["command"] under /bin/sh -c with the
// executor's CWD (or args["cwd"] if provided and safe).
//
// Caps each output stream at outBufCap bytes; once a cap trips, we
// SIGTERM the process group and let the close handler return what
// we have so far.
func (e *Executor) bashRun(ctx context.Context, args map[string]any) (*Result, error) {
	cmd := argString(args, "command", "")
	if cmd == "" {
		return &Result{OK: false, Error: "Bash: missing command"}, nil
	}
	cwd := argString(args, "cwd", e.CWD)
	// If the caller supplied a cwd, sanity-check it via the security
	// helper. ResolveSafePath errors only on traversal/empty — for an
	// absolute path equal to cwd it's a no-op, which is what we want.
	if cwd != "" {
		safe, err := ResolveSafePath(cwd, e.CWD)
		if err != nil {
			return errResult(err), nil
		}
		cwd = safe
	}

	t0 := time.Now()
	shell, shellArgs := bashShell()
	c := exec.CommandContext(ctx, shell, append(shellArgs, cmd)...)
	c.Dir = cwd
	// Process group so we can kill children too (no-op on Windows).
	setBashProcAttr(c)

	var (
		mu        sync.Mutex
		stdoutBuf bytes.Buffer
		stderrBuf bytes.Buffer
		killed    bool
	)
	stdoutW := &capWriter{buf: &stdoutBuf, mu: &mu, cap: outBufCap, onCap: func() {
		mu.Lock()
		killed = true
		mu.Unlock()
		_ = killProcessGroup(c)
	}}
	stderrW := &capWriter{buf: &stderrBuf, mu: &mu, cap: outBufCap, onCap: func() {
		mu.Lock()
		killed = true
		mu.Unlock()
		_ = killProcessGroup(c)
	}}
	c.Stdout = stdoutW
	c.Stderr = stderrW

	if err := c.Start(); err != nil {
		return &Result{OK: false, Error: "Bash: " + err.Error()}, nil
	}

	// Watch the context: when it fires, SIGTERM then SIGKILL after a
	// short grace.
	doneCh := make(chan struct{})
	go func() {
		select {
		case <-ctx.Done():
			mu.Lock()
			killed = true
			mu.Unlock()
			_ = killProcessGroup(c)
			time.Sleep(graceOnTimeout)
			if c.Process != nil {
				_ = c.Process.Kill()
			}
		case <-doneCh:
		}
	}()

	waitErr := c.Wait()
	close(doneCh)
	dur := time.Since(t0)

	exitCode := 0
	if waitErr != nil {
		var ee *exec.ExitError
		if errors.As(waitErr, &ee) {
			exitCode = ee.ExitCode()
		} else {
			exitCode = -1
		}
	}

	mu.Lock()
	out := stdoutBuf.String()
	errOut := stderrBuf.String()
	wasKilled := killed
	mu.Unlock()

	combined := out
	if errOut != "" {
		if combined != "" {
			combined += "\n"
		}
		combined += errOut
	}
	if combined == "" && wasKilled {
		combined = "(killed)"
	}

	return &Result{
		OK:      !wasKilled && exitCode == 0,
		Content: combined,
		Meta: map[string]any{
			"exit_code":   exitCode,
			"duration_ms": dur.Milliseconds(),
			"killed":      wasKilled,
		},
	}, nil
}

// capWriter caps a *bytes.Buffer at `cap` bytes. Once filled, further
// writes are silently dropped and onCap fires once. Mutex protects
// concurrent writes from stdout vs. stderr goroutines.
type capWriter struct {
	buf    *bytes.Buffer
	mu     *sync.Mutex
	cap    int
	onCap  func()
	tripped bool
}

func (w *capWriter) Write(p []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	remaining := w.cap - w.buf.Len()
	if remaining <= 0 {
		if !w.tripped {
			w.tripped = true
			if w.onCap != nil {
				go w.onCap()
			}
		}
		return len(p), nil // silently drop
	}
	if len(p) > remaining {
		w.buf.Write(p[:remaining])
		if !w.tripped {
			w.tripped = true
			if w.onCap != nil {
				go w.onCap()
			}
		}
		return len(p), nil
	}
	return w.buf.Write(p)
}

// killProcessGroup is defined per-platform in bash_unix.go /
// bash_windows.go. On unix it sends SIGTERM to the process group leader
// (-pid) so child shells go down with the parent. On Windows it just
// kills the immediate process.
