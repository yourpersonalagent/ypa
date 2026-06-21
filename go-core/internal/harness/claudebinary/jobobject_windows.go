//go:build windows

package claudebinary

// Windows orphan-prevention for harness children.
//
// THE PROBLEM. On Windows a child process is NOT terminated when its
// parent dies — there is no POSIX-style process-group cascade. go-core
// spawns the upstream `claude` CLI via exec.CommandContext, which only
// kills the child when go-core is still alive to cancel the context.
// But go-core is stopped on Windows with `Stop-Process -Force` /
// `taskkill /F` (see yha.ps1) — a hard TerminateProcess that delivers
// NO signal, so signal.NotifyContext(SIGINT/SIGTERM) never fires and
// the context is never cancelled. The same is true of an outright
// crash. In every one of those cases the claude.exe child is orphaned:
// it lingers holding ~50–320MB RSS, an OAuth/subscription session slot,
// open file handles and the session cwd, until it happens to notice its
// broken stdio pipe and exit on its own (observed: 1–2h later, if ever).
// On the 8GB deployment box a few of these compound into real memory
// pressure and feed the very instability we are chasing.
//
// An in-process kill registry (harness.ActiveProcesses) cannot solve
// this: it lives in go-core's memory and dies with go-core, so after a
// crash there is nothing left to do the reaping.
//
// THE FIX. A Windows Job Object configured with
// JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE. Every harness child we spawn is
// assigned to this one job. go-core holds the only handle to it for the
// process's entire lifetime and deliberately NEVER closes it. When
// go-core exits for ANY reason — clean shutdown, panic, or a hard
// TerminateProcess — the kernel closes that last handle, which trips
// KILL_ON_JOB_CLOSE and terminates every claude.exe still inside the
// job. The OS itself becomes the reaper, so the guarantee holds even
// when no Go code gets to run. This is the same mechanism Chromium and
// VS Code use to guarantee child cleanup on Windows.
//
// Membership is not handle ownership: the child is a member of the job
// but does not hold a handle to it, so a living child does not keep the
// job open. Only go-core's handle does. Nested jobs (a child that
// creates its own job) are permitted on Windows 8+ which is the
// deployment target, so assignment does not fail there.
//
// This is layer 1 of a two-layer defence. Layer 2 is the path-scoped
// Kill-OrphanHarness reaper in yha.ps1, which cleans up orphans from
// go-core binaries that predate this fix, from the legacy bun spawn
// path, and from the rare case where assignment below fails.

import (
	"fmt"
	"sync"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	killJob     windows.Handle
	killJobOnce sync.Once
	killJobErr  error
)

// ensureKillJob lazily creates the process-wide kill-on-close job and
// returns its handle. The handle is cached for the lifetime of the
// process and is intentionally never closed here — see the package
// comment: process exit closing it is precisely what triggers the
// cleanup. Concurrency-safe via sync.Once; repeat callers get the
// cached handle (or the cached creation error).
func ensureKillJob() (windows.Handle, error) {
	killJobOnce.Do(func() {
		h, err := windows.CreateJobObject(nil, nil)
		if err != nil {
			killJobErr = fmt.Errorf("CreateJobObject: %w", err)
			return
		}
		var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
		info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
		if _, err := windows.SetInformationJobObject(
			h,
			windows.JobObjectExtendedLimitInformation,
			uintptr(unsafe.Pointer(&info)),
			uint32(unsafe.Sizeof(info)),
		); err != nil {
			_ = windows.CloseHandle(h)
			killJobErr = fmt.Errorf("SetInformationJobObject: %w", err)
			return
		}
		killJob = h
	})
	return killJob, killJobErr
}

// assignChildToParentLifetime places pid into the kill-on-close job so
// the child cannot outlive go-core. Best-effort: callers log the error
// but never abort the spawn — the yha.ps1 Kill-OrphanHarness reaper is
// the backstop for anything that escapes the job.
func assignChildToParentLifetime(pid int) error {
	job, err := ensureKillJob()
	if err != nil {
		return err
	}
	// PROCESS_SET_QUOTA and PROCESS_TERMINATE are the access rights
	// AssignProcessToJobObject requires on the target process.
	const access = windows.PROCESS_SET_QUOTA | windows.PROCESS_TERMINATE
	ph, err := windows.OpenProcess(access, false, uint32(pid))
	if err != nil {
		return fmt.Errorf("OpenProcess(%d): %w", pid, err)
	}
	defer windows.CloseHandle(ph)
	if err := windows.AssignProcessToJobObject(job, ph); err != nil {
		return fmt.Errorf("AssignProcessToJobObject(%d): %w", pid, err)
	}
	return nil
}
