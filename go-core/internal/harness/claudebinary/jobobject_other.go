//go:build !windows

package claudebinary

// assignChildToParentLifetime ties a spawned harness child's lifetime to
// this process so it cannot outlive a crash of the parent. It is a no-op
// on non-Windows builds.
//
// The orphan problem this guards against is Windows-specific in practice
// for the YHA deployment (the live box is Windows; see
// jobobject_windows.go for the full rationale and the Job Object fix).
// The Unix equivalent — prctl(PR_SET_PDEATHSIG) on Linux, or spawning
// into a dedicated process group and signalling it — has to be wired
// through cmd.SysProcAttr BEFORE Start and is out of scope here. Keeping
// this a nil-returning stub lets the spawn path stay identical across
// platforms without #ifdef noise at the call sites.
func assignChildToParentLifetime(pid int) error {
	return nil
}
