package main

// cmd.go — `yha cmd <name> [args...]` — non-interactive command form.
// The single dispatcher path shared by:
//
//   - shell scripts that want to drive the daemon
//   - the bridge HTTP shim's fallback (when forwarding via socket fails)
//   - power users who don't want the TUI
//
// Talks to YHA-TUI-Daemon over its unix socket, spawns the requested
// job, then streams the job's stdout/stderr to this process's stdout
// (and the exit code becomes this process's exit code).
//
// Flags:
//   --origin=cli           label that appears in [external: <origin>]
//   --no-wait              spawn and exit (prints job_id, exit 0)
//   --socket=PATH          override daemon socket path
//   --timeout=DUR          overall timeout (default 30m)

import (
	"context"
	"flag"
	"fmt"
	"io"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/yha/core/internal/tuid"
)

func runCmd(args []string) int {
	if len(args) == 0 || args[0] == "help" || args[0] == "--help" || args[0] == "-h" {
		printCmdHelp(os.Stdout)
		return 0
	}

	// Pull recognised flags out of args; rest pass through to the command.
	fs := flag.NewFlagSet("cmd", flag.ContinueOnError)
	fs.SetOutput(io.Discard) // we report errors ourselves
	socket := fs.String("socket", "", "daemon socket path")
	origin := fs.String("origin", "cli", "label for [external: <origin>] annotations")
	noWait := fs.Bool("no-wait", false, "spawn and exit without streaming output")
	timeout := fs.Duration("timeout", 30*time.Minute, "overall timeout")
	listCmds := fs.Bool("list", false, "list available commands and exit")

	// Split args at the first non-flag token so all subsequent args are
	// treated as command args. flag.Parse stops at the first non-flag
	// already, which is exactly the behaviour we want.
	if err := fs.Parse(args); err != nil {
		fmt.Fprintln(os.Stderr, "yha cmd:", err)
		return 2
	}

	if *listCmds {
		printCmdList(os.Stdout)
		return 0
	}

	rest := fs.Args()
	if len(rest) == 0 {
		fmt.Fprintln(os.Stderr, "yha cmd: command name required")
		printCmdHelp(os.Stderr)
		return 2
	}

	cmdName := rest[0]
	cmdArgs := rest[1:]

	if _, ok := tuid.Commands[cmdName]; !ok {
		fmt.Fprintf(os.Stderr, "yha cmd: unknown command %q\n", cmdName)
		printCmdList(os.Stderr)
		return 2
	}

	ctx, cancel := signal.NotifyContext(context.Background(),
		syscall.SIGINT, syscall.SIGTERM)
	defer cancel()
	ctx, cancelT := context.WithTimeout(ctx, *timeout)
	defer cancelT()

	client, err := tuid.Dial(*socket)
	if err != nil {
		fmt.Fprintln(os.Stderr, "yha cmd: cannot reach daemon:", err)
		fmt.Fprintln(os.Stderr, "  Is YHA-TUI-Daemon running? Try: pm2 status YHA-TUI-Daemon")
		return 1
	}
	defer client.Close()

	jobID, err := client.RunCommand(ctx, cmdName, cmdArgs, *origin)
	if err != nil {
		fmt.Fprintln(os.Stderr, "yha cmd:", err)
		return 1
	}

	if *noWait {
		fmt.Println(jobID)
		return 0
	}

	// Subscribe + stream output to our stdout, exit when job-ended.
	sub, unsub, err := client.SubscribeJob(ctx, jobID, 0)
	if err != nil {
		fmt.Fprintln(os.Stderr, "yha cmd: subscribe:", err)
		return 1
	}
	defer unsub()

	for {
		select {
		case env, ok := <-sub:
			if !ok {
				return 1
			}
			switch env.Op {
			case tuid.OpLogChunk:
				_, _ = io.WriteString(os.Stdout, env.Data)
			case tuid.OpJobEnded:
				exit := 0
				if env.ExitCode != nil {
					exit = *env.ExitCode
				}
				return exit
			}
		case <-ctx.Done():
			fmt.Fprintln(os.Stderr, "yha cmd: timeout / signal")
			return 1
		}
	}
}

func printCmdHelp(w io.Writer) {
	fmt.Fprintln(w, `yha cmd — run a daemon command non-interactively

Usage:
  yha cmd [flags] <command> [command-args...]

Flags:
  --origin=LABEL    annotate as [external: <LABEL>] in viewer
  --no-wait         spawn and exit (prints job_id)
  --socket=PATH     daemon socket path (default: discovered)
  --timeout=DUR     overall timeout (default 30m)
  --list            list available commands and exit

The daemon must be running (pm2 service YHA-TUI-Daemon).`)
}

func printCmdList(w io.Writer) {
	fmt.Fprintln(w, "Available commands:")
	// Print in a stable order — the map iteration order is random.
	names := make([]string, 0, len(tuid.Commands))
	for n := range tuid.Commands {
		names = append(names, n)
	}
	// Simple insertion sort — fewer than a dozen entries.
	for i := 1; i < len(names); i++ {
		for j := i; j > 0 && names[j] < names[j-1]; j-- {
			names[j], names[j-1] = names[j-1], names[j]
		}
	}
	for _, n := range names {
		c := tuid.Commands[n]
		marker := "  "
		if c.Stub {
			marker = "* "
		}
		fmt.Fprintf(w, "%s%-12s %s\n", marker, n, c.Summary)
	}
	fmt.Fprintln(w, "  (* = stub, not yet implemented)")
}

// ── setup / repair stubs ────────────────────────────────────────────────
// Top-level convenience subcommands that just delegate to `yha cmd
// setup` / `yha cmd repair`. Documented in the root help so the surface
// is visible even before the underlying logic lands.

func runSetup(args []string) int {
	// Forward straight to runCmd with the command name prepended.
	return runCmd(append([]string{"setup"}, normalizeStubArgs(args)...))
}

func runRepair(args []string) int {
	return runCmd(append([]string{"repair"}, normalizeStubArgs(args)...))
}

func normalizeStubArgs(args []string) []string {
	// Strip "help" or "--help" so the stub prints its rote message
	// instead of yha cmd's help.
	out := make([]string, 0, len(args))
	for _, a := range args {
		if a == "help" || a == "--help" || a == "-h" {
			continue
		}
		out = append(out, a)
	}
	if len(out) == 0 {
		return nil
	}
	if strings.HasPrefix(out[0], "-") {
		// Recognised yha cmd flags pass through (--socket, --origin, etc.).
		return out
	}
	return out
}
