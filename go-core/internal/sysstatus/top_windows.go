//go:build windows

package sysstatus

// SampleTop on Windows shells PowerShell `Get-Process | ConvertTo-Json`,
// sorts by CPU (cumulative seconds) and returns up to TopMaxRows.
// Note: CPU value is cumulative seconds since process start, NOT
// instantaneous %. Without sampling twice we cannot compute true %;
// this is the honest first approximation.

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"time"
)

// windowsProcRow matches the JSON shape we ask Get-Process to emit.
type windowsProcRow struct {
	Id          int     `json:"Id"`
	ProcessName string  `json:"ProcessName"`
	WS          int64   `json:"WS"`
	CPU         float64 `json:"CPU"`
	Path        string  `json:"Path"`
}

func SampleTop(pm2Procs []PM2Process) ([]TopProc, string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	psCmd := "Get-Process | Where-Object { $_.WS -gt 0 } | Sort-Object CPU -Descending | Select-Object -First 40 Id,ProcessName,WS,CPU,Path | ConvertTo-Json -Compress"
	out, err := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-Command", psCmd).Output()
	if err != nil {
		return nil, "Get-Process failed: " + err.Error()
	}
	if len(out) == 0 {
		return nil, ""
	}
	// ConvertTo-Json returns a single object when only one match — wrap if so.
	trimmed := strings.TrimSpace(string(out))
	if strings.HasPrefix(trimmed, "{") {
		trimmed = "[" + trimmed + "]"
	}
	var rows []windowsProcRow
	if err := json.Unmarshal([]byte(trimmed), &rows); err != nil {
		return nil, "parse Get-Process: " + err.Error()
	}

	yhaPIDs := make(map[int]bool, len(pm2Procs)+1)
	for _, p := range pm2Procs {
		if p.PID > 0 {
			yhaPIDs[p.PID] = true
		}
	}
	selfPID := os.Getpid()

	out2 := make([]TopProc, 0, TopMaxRows)
	for _, r := range rows {
		if r.Id == selfPID {
			continue
		}
		isYHA := yhaPIDs[r.Id]
		memMB := int(r.WS / (1024 * 1024))
		// Filter to "interesting": CPU seconds > 5 OR YHA-tagged with >=
		// 8MB working set. The Linux version uses CPU% which we don't have;
		// 5s of cumulative CPU is a reasonable "this has done some work"
		// threshold for a process listing refreshed every 5s.
		if r.CPU < 5 && !(isYHA && memMB >= 8) {
			continue
		}
		tag := ""
		if isYHA {
			tag = "yha"
		}
		args := ""
		if r.Path != "" {
			args = r.Path
		}
		out2 = append(out2, TopProc{
			PID:   r.Id,
			CPU:   r.CPU,
			MemMB: memMB,
			Cmd:   r.ProcessName,
			Args:  TrimArgs(args, r.ProcessName),
			Tag:   tag,
		})
		if len(out2) >= TopMaxRows {
			break
		}
	}
	return out2, ""
}
