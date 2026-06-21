//go:build !windows

package sysstatus

import (
	"context"
	"encoding/json"
	"os/exec"
	"time"
)

type pm2Raw struct {
	Name   string `json:"name"`
	PID    int    `json:"pid"`
	PM2Env struct {
		Status      string `json:"status"`
		PMUptime    int64  `json:"pm_uptime"`
		RestartTime int    `json:"restart_time"`
	} `json:"pm2_env"`
	Monit struct {
		Memory int64   `json:"memory"`
		CPU    float64 `json:"cpu"`
	} `json:"monit"`
}

// SamplePM2 shells `pm2 jlist` and parses the result. Returns (procs,
// error-string). On error the slice is nil and the second return carries
// a human-readable description for the dashboard to surface.
func SamplePM2() ([]PM2Process, string) {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "pm2", "jlist")
	out, err := cmd.Output()
	if err != nil {
		return nil, err.Error()
	}
	var raws []pm2Raw
	if err := json.Unmarshal(out, &raws); err != nil {
		return nil, "parse: " + err.Error()
	}
	now := time.Now().UnixMilli()
	procs := make([]PM2Process, 0, len(raws))
	for _, r := range raws {
		uptime := int64(0)
		if r.PM2Env.PMUptime > 0 && r.PM2Env.Status == "online" {
			uptime = now - r.PM2Env.PMUptime
		}
		procs = append(procs, PM2Process{
			Name:     r.Name,
			PID:      r.PID,
			Status:   r.PM2Env.Status,
			Uptime:   uptime,
			Restarts: r.PM2Env.RestartTime,
			CPU:      int(r.Monit.CPU + 0.5),
			MemMB:    int(r.Monit.Memory / (1024 * 1024)),
		})
	}
	return procs, ""
}
