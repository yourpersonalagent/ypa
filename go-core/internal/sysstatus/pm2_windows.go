//go:build windows

package sysstatus

// Windows has no pm2. yha.ps1 maintains a JSON PID file at
// bridge/state/yha-tui/yha-windows.pids.json that records the four
// services it launches. SamplePM2 reads that file and confirms liveness
// via Get-Process, mirroring the shape Linux gets from `pm2 jlist`.

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"
	"unsafe"

	"github.com/yha/core/internal/paths"
	"golang.org/x/sys/windows"
)

// windowsPidRecord matches the shape yha.ps1 writes to
// bridge/state/yha-tui/yha-windows.pids.json.
type windowsPidRecord struct {
	PID      int    `json:"pid"`
	ProcName string `json:"proc_name"`
	Exe      string `json:"exe"`
	Args     string `json:"args"`
	Log      string `json:"log"`
	Started  string `json:"started"`
}

func SamplePM2() ([]PM2Process, string) {
	stateFile := filepath.Join(paths.TUIStateDir(), "yha-windows.pids.json")
	raw, err := os.ReadFile(stateFile)
	if err != nil {
		if os.IsNotExist(err) {
			// Not started via yha.ps1 yet — empty snapshot is the right
			// answer (matches "no pm2 processes" on Linux). Empty error
			// string so the dashboard doesn't show a scary "missing".
			return nil, ""
		}
		return nil, "read pid file: " + err.Error()
	}
	// Strip UTF-8 BOM (EF BB BF) if present. PowerShell 5.1's
	// `Set-Content -Encoding utf8` and Notepad both add one; Go's json
	// parser doesn't tolerate it and would error "invalid character 'ï'".
	if len(raw) >= 3 && raw[0] == 0xEF && raw[1] == 0xBB && raw[2] == 0xBF {
		raw = raw[3:]
	}
	var recs map[string]windowsPidRecord
	if err := json.Unmarshal(raw, &recs); err != nil {
		return nil, "parse pid file: " + err.Error()
	}

	now := time.Now()
	procs := make([]PM2Process, 0, len(recs))
	for name, rec := range recs {
		p := PM2Process{Name: name, PID: rec.PID, Status: "stopped"}
		if rec.PID > 0 {
			if alive, mem, cpu, started := getProcessInfo(rec.PID, rec.ProcName); alive {
				p.Status = "online"
				p.MemMB = int(mem / (1024 * 1024))
				p.CPU = int(cpu + 0.5)
				if !started.IsZero() {
					p.Uptime = now.Sub(started).Milliseconds()
				}
			}
		}
		procs = append(procs, p)
	}

	// YHA-TUI-Daemon special case: the launcher-maintained pidfile entry can
	// easily become stale (fast exit on AF_UNIX bind races during restart,
	// the "leave running" path in dev/restart-all, or the viewer doing
	// `yha tui` which starts the daemon out of band). The daemon itself
	// always writes/refresh daemon.pid after it successfully listens.
	// If the tracked entry is not live, or missing entirely, promote a live
	// PID from daemon.pid so TUI dashboard and rewind /api/pm2 report truth.
	{
		if alt := readTUIDaemonPID(); alt > 0 {
			// find if we already added a TUI row from the main recs
			found := -1
			for i := range procs {
				if procs[i].Name == "YHA-TUI-Daemon" {
					found = i
					break
				}
			}
			exp := "yha-tui-daemon"
			if rec, has := recs["YHA-TUI-Daemon"]; has && rec.ProcName != "" {
				exp = rec.ProcName
			}
			if alive, mem, cpu, started := getProcessInfo(alt, exp); alive {
				if found >= 0 {
					// override the (possibly dead/stale) tracked one
					procs[found].PID = alt
					procs[found].Status = "online"
					procs[found].MemMB = int(mem / (1024 * 1024))
					procs[found].CPU = int(cpu + 0.5)
					if !started.IsZero() {
						procs[found].Uptime = now.Sub(started).Milliseconds()
					}
				} else {
					// no launcher rec at all -- synthesize one
					p := PM2Process{
						Name:   "YHA-TUI-Daemon",
						PID:    alt,
						Status: "online",
						MemMB:  int(mem / (1024 * 1024)),
						CPU:    int(cpu + 0.5),
					}
					if !started.IsZero() {
						p.Uptime = now.Sub(started).Milliseconds()
					}
					procs = append(procs, p)
				}
			}
		}
	}

	sort.Slice(procs, func(i, j int) bool { return procs[i].Name < procs[j].Name })
	return procs, ""
}

// processMemoryCounters is PROCESS_MEMORY_COUNTERS from psapi.h. Keep this
// local so service liveness does not require starting PowerShell, which can
// take several seconds on constrained Windows hosts.
type processMemoryCounters struct {
	CB                         uint32
	PageFaultCount             uint32
	PeakWorkingSetSize         uintptr
	WorkingSetSize             uintptr
	QuotaPeakPagedPoolUsage    uintptr
	QuotaPagedPoolUsage        uintptr
	QuotaPeakNonPagedPoolUsage uintptr
	QuotaNonPagedPoolUsage     uintptr
	PagefileUsage              uintptr
	PeakPagefileUsage          uintptr
}

var getProcessMemoryInfoProc = windows.NewLazySystemDLL("psapi.dll").NewProc("GetProcessMemoryInfo")

// getProcessInfo queries Win32 directly for one PID. Returns (alive,
// wsBytes, cpuSeconds, startTime). A missing PID or image-name mismatch is
// reported as not alive; optional metric failures do not turn a live service
// into a stopped one.
func getProcessInfo(pid int, expectedName string) (bool, int64, float64, time.Time) {
	if pid <= 0 {
		return false, 0, 0, time.Time{}
	}
	h, err := windows.OpenProcess(
		windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.PROCESS_VM_READ,
		false,
		uint32(pid),
	)
	if err != nil {
		return false, 0, 0, time.Time{}
	}
	defer windows.CloseHandle(h)

	buf := make([]uint16, windows.MAX_LONG_PATH)
	size := uint32(len(buf))
	if err := windows.QueryFullProcessImageName(h, 0, &buf[0], &size); err != nil {
		return false, 0, 0, time.Time{}
	}
	imageName := normalizeWindowsProcessName(windows.UTF16ToString(buf[:size]))
	expectedName = normalizeWindowsProcessName(expectedName)
	if expectedName != "" && !strings.EqualFold(imageName, expectedName) {
		return false, 0, 0, time.Time{}
	}

	start := time.Time{}
	cpuSeconds := float64(0)
	var creation, exit, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(h, &creation, &exit, &kernel, &user); err == nil {
		start = time.Unix(0, creation.Nanoseconds())
		cpuTicks := uint64(kernel.HighDateTime)<<32 | uint64(kernel.LowDateTime)
		cpuTicks += uint64(user.HighDateTime)<<32 | uint64(user.LowDateTime)
		cpuSeconds = float64(cpuTicks) / 10_000_000
	}

	mem := processMemoryCounters{CB: uint32(unsafe.Sizeof(processMemoryCounters{}))}
	wsBytes := int64(0)
	if ok, _, _ := getProcessMemoryInfoProc.Call(
		uintptr(h),
		uintptr(unsafe.Pointer(&mem)),
		uintptr(mem.CB),
	); ok != 0 {
		wsBytes = int64(mem.WorkingSetSize)
	}

	return true, wsBytes, cpuSeconds, start
}

func normalizeWindowsProcessName(name string) string {
	name = filepath.Base(name)
	// Strip .exe (case-insensitive) and common backup/temp variants that can
	// appear for long-lived processes (e.g. yha-tui-daemon.exe~ when the
	// daemon was left running across a rebuild that wrote a fresh .exe).
	// This keeps the PID-reuse defense while tolerating real-world build
	// artifacts and editor/rename leftovers. The recorded proc_name from the
	// launcher (Get-Process.ProcessName) is always the clean stem.
	lname := strings.ToLower(name)
	if strings.HasSuffix(lname, ".exe~") {
		name = name[:len(name)-len(".exe~")]
	} else if strings.EqualFold(filepath.Ext(name), ".exe") {
		name = name[:len(name)-len(filepath.Ext(name))]
	}
	// Also drop a bare trailing ~ (e.g. "foo~") if present after ext stripping.
	name = strings.TrimSuffix(name, "~")
	return name
}

func readTUIDaemonPID() int {
	p := filepath.Join(paths.TUIStateDir(), "daemon.pid")
	raw, err := os.ReadFile(p)
	if err != nil {
		return 0
	}
	s := strings.TrimSpace(string(raw))
	pid, _ := strconv.Atoi(s)
	return pid
}
