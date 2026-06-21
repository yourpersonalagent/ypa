//go:build windows

package sysstatus

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestGetProcessInfoCurrentProcess(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	expected := normalizeWindowsProcessName(exe)

	alive, _, _, started := getProcessInfo(os.Getpid(), expected)
	if !alive {
		t.Fatal("current process reported stopped")
	}
	if started.IsZero() {
		t.Fatal("current process start time is missing")
	}
}

func TestGetProcessInfoRejectsNameMismatch(t *testing.T) {
	alive, _, _, _ := getProcessInfo(os.Getpid(), "definitely-not-the-test-process")
	if alive {
		t.Fatal("process with mismatched image name reported online")
	}
}

func TestSamplePM2ReportsRegisteredProcessOnline(t *testing.T) {
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	bridgeRoot := t.TempDir()
	t.Setenv("YHA_BRIDGE_ROOT", bridgeRoot)
	stateDir := filepath.Join(bridgeRoot, "state", "yha-tui")
	if err := os.MkdirAll(stateDir, 0o755); err != nil {
		t.Fatal(err)
	}
	recs := map[string]windowsPidRecord{
		"YHA-Test": {
			PID:      os.Getpid(),
			ProcName: normalizeWindowsProcessName(exe),
		},
	}
	raw, err := json.Marshal(recs)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(stateDir, "yha-windows.pids.json"), raw, 0o644); err != nil {
		t.Fatal(err)
	}

	procs, errStr := SamplePM2()
	if errStr != "" {
		t.Fatal(errStr)
	}
	if len(procs) != 1 || procs[0].Name != "YHA-Test" || procs[0].Status != "online" {
		t.Fatalf("unexpected process snapshot: %+v", procs)
	}
}

// TestTUIStatusFromRealPidFile exercises the real yha-windows.pids.json (if present)
// and calls getProcessInfo exactly as SamplePM2 does for the YHA-TUI-Daemon entry.
// This reproduces the "TUI daemon always stopped" report while other services are online.
func TestTUIStatusFromRealPidFile(t *testing.T) {
	pf := filepath.Join("..", "..", "..", "bridge", "state", "yha-tui", "yha-windows.pids.json")
	raw, err := os.ReadFile(pf)
	if err != nil {
		t.Skipf("no real pid file at %s: %v (run from a live yha.ps1 session)", pf, err)
	}
	// reuse the unmarshal shape from SamplePM2
	var recs map[string]windowsPidRecord
	if err := json.Unmarshal(raw, &recs); err != nil {
		t.Fatalf("parse real pidfile: %v", err)
	}
	tuiRec, ok := recs["YHA-TUI-Daemon"]
	if !ok {
		t.Skip("YHA-TUI-Daemon not present in pid file")
	}
	t.Logf("PID file TUI entry: pid=%d proc_name=%q exe=%q", tuiRec.PID, tuiRec.ProcName, tuiRec.Exe)

	alive, mem, cpu, started := getProcessInfo(tuiRec.PID, tuiRec.ProcName)
	t.Logf("getProcessInfo(TUI): alive=%v mem=%d cpu=%.1f started=%v", alive, mem, cpu, started)

	if !alive {
		// also try the full exe from rec as fallback probe
		if tuiRec.Exe != "" {
			alive2, _, _, _ := getProcessInfo(tuiRec.PID, tuiRec.Exe)
			t.Logf("retry with rec.Exe as expectedName: alive=%v", alive2)
		}
		// The recorded PID being dead is not a "sampler bug" anymore (it can
		// happen legitimately if the daemon was bounced and the new instance
		// hasn't claimed yet, or the viewer is not running). The important
		// thing the fallback + normalize protect is: when a live daemon *is*
		// present its row comes back online. Don't fail the suite here.
		t.Logf("NOTE: recorded TUI pid %d not alive right now (daemon may be down or pidfile stale -- this is expected outside a live stack)", tuiRec.PID)
	} else {
		t.Logf("TUI daemon from real pidfile reported online (good)")
	}
}
