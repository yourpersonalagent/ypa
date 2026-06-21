// yha-tui-daemon is the long-running operator-console process — the
// "YHA-TUI-Daemon" pm2 service from docs/YHA-TUI-Replacement-Plan.md.
//
// It owns:
//   - the unix socket at bridge/state/yha-tui/daemon.sock
//   - the job registry (start/stop/status of every operator command)
//   - the cached pm2 / git / tailscale snapshot
//
// Clients are: (a) the `yha` TUI viewer, (b) the bridge HTTP shim at
// /__yha/api/*, (c) any future scripting use via `yha cmd <name>`.
//
// Lifecycle: started by yha.sh / pm2. Reconciles orphaned jobs from
// the previous run on boot, then accepts connections until SIGTERM.
package main

import (
	"context"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/yha/core/internal/tuid"
)

func main() {
	fs := flag.NewFlagSet("yha-tui-daemon", flag.ExitOnError)
	showVersion := fs.Bool("version", false, "print version and exit")
	_ = fs.Parse(os.Args[1:])

	if *showVersion {
		fmt.Println("yha-tui-daemon 0.1.0")
		return
	}

	d, err := tuid.New()
	if err != nil {
		fmt.Fprintln(os.Stderr, "yha-tui-daemon: init:", err)
		os.Exit(1)
	}

	ctx, cancel := signal.NotifyContext(context.Background(),
		syscall.SIGINT, syscall.SIGTERM)
	defer cancel()

	fmt.Fprintf(os.Stderr, "yha-tui-daemon: listening on %s (pid %d)\n",
		d.SocketPath(), os.Getpid())

	if err := d.Serve(ctx); err != nil {
		fmt.Fprintln(os.Stderr, "yha-tui-daemon: serve:", err)
		_ = d.Close()
		os.Exit(1)
	}
	_ = d.Close()
}
