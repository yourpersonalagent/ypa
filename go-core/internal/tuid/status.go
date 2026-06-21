package tuid

// status.go — the periodic status sampler. Caches an up-to-date
// snapshot of pm2 + git + tailscale state so OpStatus requests are
// cheap; refreshed every refreshInterval. The sampler is intentionally
// best-effort — every probe falls back to a zero value + Error string
// rather than failing the whole snapshot.

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/yha/core/internal/paths"
	"github.com/yha/core/internal/sysstatus"
)

const statusRefreshInterval = 5 * time.Second

// Sampler refreshes the StatusSnap on a ticker. Safe to call Get() at
// any time; returns the latest cached value.
type Sampler struct {
	mu        sync.RWMutex
	snap      StatusSnap
	startedAt int64
	stopCh    chan struct{}
	stopped   atomic.Bool
}

// NewSampler returns a sampler that has *not* started yet. Call Start.
func NewSampler() *Sampler {
	return &Sampler{
		startedAt: time.Now().UnixMilli(),
		stopCh:    make(chan struct{}),
	}
}

// Start kicks off the background refresh goroutine. Idempotent.
func (s *Sampler) Start() {
	if s.stopped.Load() {
		return
	}
	go s.loop()
}

// Stop terminates the refresh goroutine. Idempotent.
func (s *Sampler) Stop() {
	if s.stopped.CompareAndSwap(false, true) {
		close(s.stopCh)
	}
}

// Get returns the current snapshot (a copy). Safe to call concurrently.
func (s *Sampler) Get(jobsKnown int, daemonPID int) StatusSnap {
	s.mu.RLock()
	out := s.snap
	s.mu.RUnlock()
	out.Daemon = DaemonSelfStats{
		PID:       daemonPID,
		StartedAt: s.startedAt,
		Uptime:    time.Now().UnixMilli() - s.startedAt,
		Jobs:      jobsKnown,
	}
	return out
}

func (s *Sampler) loop() {
	s.refresh() // immediate sample
	t := time.NewTicker(statusRefreshInterval)
	defer t.Stop()
	for {
		select {
		case <-s.stopCh:
			return
		case <-t.C:
			s.refresh()
		}
	}
}

func (s *Sampler) refresh() {
	snap := StatusSnap{SampledAt: time.Now().UnixMilli()}
	snap.PM2, snap.PM2Error = sysstatus.SamplePM2()
	snap.Git = sampleGit()
	snap.Tailscale = sampleTailscale()
	snap.Runtime = sampleRuntime(snap.PM2)
	snap.Top, snap.TopError = sysstatus.SampleTop(snap.PM2)
	s.mu.Lock()
	s.snap = snap
	s.mu.Unlock()
}

// ── pm2 ────────────────────────────────────────────────────────────────
//
// PM2/top sampling lives in internal/sysstatus so the standalone rewind
// service (cmd/yha-rewind) can call the same code we do — Linux shells
// `pm2 jlist`/`ps`, Windows reads yha.ps1's pid file and Get-Process.

// ── git ────────────────────────────────────────────────────────────────

func sampleGit() *GitSnap {
	repo := filepath.Dir(paths.BridgeRoot())
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "git", "-C", repo, "status", "--porcelain=v2", "--branch").Output()
	if err != nil {
		return nil
	}
	snap := &GitSnap{}
	for _, ln := range strings.Split(string(out), "\n") {
		if ln == "" {
			continue
		}
		switch {
		case strings.HasPrefix(ln, "# branch.head "):
			snap.Branch = strings.TrimPrefix(ln, "# branch.head ")
		case strings.HasPrefix(ln, "# branch.oid "):
			h := strings.TrimPrefix(ln, "# branch.oid ")
			if len(h) > 8 {
				h = h[:8]
			}
			snap.Head = h
		case strings.HasPrefix(ln, "# branch.ab "):
			// "# branch.ab +N -M"
			parts := strings.Fields(strings.TrimPrefix(ln, "# branch.ab "))
			if len(parts) >= 2 {
				snap.Ahead, _ = strconv.Atoi(strings.TrimPrefix(parts[0], "+"))
				snap.Behind, _ = strconv.Atoi(strings.TrimPrefix(parts[1], "-"))
			}
		case strings.HasPrefix(ln, "1 ") || strings.HasPrefix(ln, "2 "):
			// "1 XY ..." or "2 XY ..." where XY[0] = staged, XY[1] = unstaged.
			fields := strings.Fields(ln)
			if len(fields) >= 2 && len(fields[1]) == 2 {
				if fields[1][0] != '.' {
					snap.Staged++
				}
				if fields[1][1] != '.' {
					snap.Unstaged++
				}
			}
		case strings.HasPrefix(ln, "? "):
			snap.Untracked++
		}
	}
	snap.Dirty = snap.Staged > 0 || snap.Unstaged > 0 || snap.Untracked > 0
	return snap
}

// ── tailscale ──────────────────────────────────────────────────────────

// ── runtime mode (dev / build) ─────────────────────────────────────────
//
// The TUI daemon is long-lived (it survives `./yha.sh dev|build` so the
// operator's job stream doesn't drop), which means *its own* env is
// frozen at the time it was first registered with pm2. Truth lives in
// the bridge process (YHA-Bridge) — it gets re-exec'd on every mode flip
// and yha.sh exports YHA_MODE/YHA_BACKEND/YHA_USE_DIST into its env.
//
// So we read /proc/<bridge-pid>/environ. No HTTP, no auth, always
// current. Falls back to the daemon's own env (then to YHA_USE_DIST
// heuristic) when pm2 didn't surface the bridge or /proc is unreadable.

func sampleRuntime(procs []PM2Process) *RuntimeSnap {
	pid := 0
	for _, p := range procs {
		if p.Name == "YHA-Bridge" && p.PID > 0 {
			pid = p.PID
			break
		}
	}
	if pid > 0 {
		env, err := sysstatus.ReadProcEnviron(pid)
		if err == nil {
			return runtimeFromEnv(env, "proc-env")
		}
		// fall through with err noted
		snap := runtimeFromEnv(envFromOS(), "self-env")
		snap.Error = "proc/" + strconv.Itoa(pid) + ": " + err.Error()
		return snap
	}
	return runtimeFromEnv(envFromOS(), "self-env")
}

func envFromOS() map[string]string {
	out := map[string]string{}
	for _, kv := range os.Environ() {
		if i := strings.IndexByte(kv, '='); i > 0 {
			out[kv[:i]] = kv[i+1:]
		}
	}
	return out
}

// runtimeFromEnv builds a RuntimeSnap from a KEY→VAL map. Source is the
// label propagated back so the dashboard can hint at provenance when the
// answer is ambiguous (e.g. "self-env" means the bridge env wasn't
// reachable, snap reflects daemon-start time and may be stale).
func runtimeFromEnv(env map[string]string, source string) *RuntimeSnap {
	snap := &RuntimeSnap{Source: source}
	mode := strings.ToLower(env["YHA_MODE"])
	useDist := strings.ToLower(env["YHA_USE_DIST"]) == "true"
	snap.UseDist = useDist
	switch mode {
	case "dev", "build":
		snap.Mode = mode
	default:
		// Infer from YHA_USE_DIST when YHA_MODE wasn't surfaced (older
		// yha.sh launches, or daemon started outside the script).
		if useDist {
			snap.Mode = "build"
		} else {
			snap.Mode = "dev"
		}
		if snap.Source == "proc-env" {
			snap.Source = "inferred"
		}
	}
	backend := strings.ToLower(env["YHA_BACKEND"])
	switch backend {
	case "go", "node":
		snap.Backend = backend
	default:
		// Heuristic: PORT=8442 means Node is behind Go (go-mode);
		// otherwise default to go (today's default).
		if env["PORT"] == "8442" {
			snap.Backend = "go"
		} else {
			snap.Backend = "go"
		}
	}
	return snap
}

// ── top processes (what's actually running) ────────────────────────────
//
// pm2 only sees what pm2 spawns. The interesting cost in YHA is usually
// somewhere in YHA-Bridge's child tree (bun running vite/tsx, dist watchers,
// claude streams) — none of which appear in `pm2 jlist`. The sampling lives
// in internal/sysstatus (Linux: ps -eo …; Windows: Get-Process via
// PowerShell), so both this daemon and cmd/yha-rewind read the same data.

// tsPublicURLRe captures the public funnel URL out of `tailscale funnel
// status` output. Matches https://<anything-but-whitespace>.ts.net plus
// optional trailing path. Works for both stock tailnets (host.ts.net)
// and named tailnets (host.tail-name.ts.net).
var tsPublicURLRe = regexp.MustCompile(`https://[^\s]+\.ts\.net[^\s]*`)

// tsLocalTargetRe captures the local proxy target. We support both
// 127.0.0.1:N and localhost:N — Windows tailscale sometimes prints the
// hostname form even when the funnel was configured with the IP.
var tsLocalTargetRe = regexp.MustCompile(`http://(?:127\.0\.0\.1|localhost):\d+`)

func sampleTailscale() *TailscaleSnap {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "tailscale", "funnel", "status").Output()
	if err != nil {
		return &TailscaleSnap{Error: err.Error()}
	}
	body := string(out)
	snap := &TailscaleSnap{FunnelOK: false}
	// The presence of "→" / "->" / "Funnel on" all signal an active funnel
	// — but for simplicity we treat "found a public URL" as the canonical
	// "funnel is on" signal. False positives are extremely unlikely
	// (the URL only appears in the active-config section).
	if pub := tsPublicURLRe.FindString(body); pub != "" {
		snap.FunnelURL = pub
		snap.FunnelOK = true
	}
	if tgt := tsLocalTargetRe.FindString(body); tgt != "" {
		snap.FunnelTarget = tgt
	}
	return snap
}
