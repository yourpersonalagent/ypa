//go:build !windows

package sysstatus

// SampleTop runs ps with the platform's supported flags, takes the
// highest-CPU rows, and tags any process whose
// PID or ancestor matches a tracked YHA pm2 process. We deliberately do
// not call `top -bn1` — it's slow (≥1s on a Pi) and ps gives us PPID
// which we need for the YHA-tag heuristic.

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

func SampleTop(pm2Procs []PM2Process) ([]TopProc, string) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	var cmd *exec.Cmd
	isDarwin := runtime.GOOS == "darwin"
	if isDarwin {
		// macOS ships BSD ps: GNU's --no-headers and --sort options are
		// rejected. -r sorts by current CPU usage. Fetch args without comm:
		// BSD ps renders comm as a fixed-width field, so executable paths
		// containing spaces cannot be parsed reliably from the same row.
		cmd = exec.CommandContext(ctx, "ps", "-A", "-r",
			"-o", "pid=", "-o", "ppid=", "-o", "%cpu=", "-o", "rss=",
			"-o", "args=")
	} else {
		cmd = exec.CommandContext(ctx, "ps", "-eo", "pid,ppid,pcpu,rss,comm,args", "--no-headers", "--sort=-pcpu")
	}
	out, err := cmd.Output()
	if err != nil {
		return nil, "ps failed: " + err.Error()
	}
	var darwinCommands map[int]string
	if isDarwin {
		darwinCommands = sampleDarwinCommands(ctx)
	}

	yhaPIDs := make(map[int]bool, len(pm2Procs)+1)
	for _, p := range pm2Procs {
		if p.PID > 0 {
			yhaPIDs[p.PID] = true
		}
	}

	type psRow struct {
		pid, ppid int
		cpu       float64
		rssKB     int
		comm      string
		args      string
	}
	var rows []psRow
	selfPID := os.Getpid()
	for _, raw := range strings.Split(string(out), "\n") {
		if raw == "" {
			continue
		}
		fields := strings.Fields(raw)
		minFields := 6
		if isDarwin {
			minFields = 5
		}
		if len(fields) < minFields {
			continue
		}
		pid, _ := strconv.Atoi(fields[0])
		ppid, _ := strconv.Atoi(fields[1])
		cpu, _ := strconv.ParseFloat(fields[2], 64)
		rss, _ := strconv.Atoi(fields[3])
		comm := fields[4]
		argsStart := 5
		if isDarwin {
			if commPath := darwinCommands[pid]; commPath != "" {
				comm = filepath.Base(commPath)
			} else {
				comm = filepath.Base(fields[4])
			}
			argsStart = 4
		}
		if pid == selfPID || comm == "ps" {
			continue
		}
		args := strings.Join(fields[argsStart:], " ")
		rows = append(rows, psRow{pid: pid, ppid: ppid, cpu: cpu, rssKB: rss, comm: comm, args: args})
	}

	parentOf := make(map[int]int, len(rows))
	for _, r := range rows {
		parentOf[r.pid] = r.ppid
	}
	tagged := func(pid int) bool {
		for i := 0; i < 4 && pid > 1; i++ {
			if yhaPIDs[pid] {
				return true
			}
			pid = parentOf[pid]
			if pid == 0 {
				return false
			}
		}
		return false
	}

	out2 := make([]TopProc, 0, TopMaxRows)
	for _, r := range rows {
		isYHA := tagged(r.pid)
		if r.cpu < 0.5 && !(isYHA && r.rssKB >= 8*1024) {
			continue
		}
		tag := ""
		if isYHA {
			tag = "yha"
		}
		out2 = append(out2, TopProc{
			PID:   r.pid,
			CPU:   r.cpu,
			MemMB: r.rssKB / 1024,
			Cmd:   r.comm,
			Args:  TrimArgs(r.args, r.comm),
			Tag:   tag,
		})
		if len(out2) >= TopMaxRows {
			break
		}
	}
	return out2, ""
}

// sampleDarwinCommands obtains pid + comm separately so the remainder of each
// line is unambiguously the executable path, even when it contains spaces.
func sampleDarwinCommands(ctx context.Context) map[int]string {
	commands := make(map[int]string)
	out, err := exec.CommandContext(ctx, "ps", "-A", "-o", "pid=", "-o", "comm=").Output()
	if err != nil {
		return commands
	}
	for _, raw := range strings.Split(string(out), "\n") {
		line := strings.TrimSpace(raw)
		if line == "" {
			continue
		}
		space := strings.IndexAny(line, " \t")
		if space < 0 {
			continue
		}
		pid, err := strconv.Atoi(line[:space])
		if err != nil {
			continue
		}
		commands[pid] = strings.TrimSpace(line[space:])
	}
	return commands
}
