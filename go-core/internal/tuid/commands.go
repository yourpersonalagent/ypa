package tuid

// commands.go — the canonical mapping from command names to actual
// argv invocations. Single source of truth for both the in-TUI command
// bar and the external HTTP shim (bridge/routes/yha-tui.ts).
//
// New commands get added here; the daemon's dispatcher (daemon.go) is
// generic and routes through this table. Keeps the dispatcher
// agnostic about what `restart` actually means.
//
// In v1 most commands shell out to yha.sh — the script is still the
// authoritative install/build orchestration. As pieces migrate into Go
// (steps 9+ of §11 in docs/YHA-TUI-Replacement-Plan.md), individual
// entries here flip from shellOut() to native helpers.

import (
	"bytes"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
)

// CommandSpec describes how a command turns into a SpawnSpec.
type CommandSpec struct {
	Name    string
	Summary string
	// Build returns the argv (and optional working directory) for this
	// command. args are the user-supplied flags/positionals.
	Build func(args []string) (argv []string, dir string, err error)
	// Stub marks setup/repair-style commands that print a not-yet-
	// implemented message instead of spawning real work. Useful so the
	// command surface is complete even before the underlying logic
	// lands.
	Stub bool
}

// Commands is the registry. Indexed by canonical name.
var Commands = func() map[string]CommandSpec {
	// repoRoot used to be captured once at package init via
	// detectRepoRoot(); tests that override YHA_REPO_ROOT via t.Setenv
	// couldn't take effect because the closure had already frozen the
	// path. Resolving lazily inside the returned function lets each
	// dispatch see the current env without changing the public API.
	shell := func(name string) func([]string) ([]string, string, error) {
		return func(args []string) ([]string, string, error) {
			repoRoot := detectRepoRoot()
			prefix, scriptPath, err := launcherInvocation(repoRoot)
			if err != nil {
				return nil, "", err
			}
			if _, err := os.Stat(scriptPath); err != nil {
				return nil, "", fmt.Errorf("launcher not found at %s: %w", scriptPath, err)
			}
			argv := append(append([]string{}, prefix...), name)
			argv = append(argv, args...)
			return argv, repoRoot, nil
		}
	}
	stub := func(name string) func([]string) ([]string, string, error) {
		return func(args []string) ([]string, string, error) {
			argv := stubEchoCommand(fmt.Sprintf("yha %s: not yet implemented (stub) — see docs/YHA-TUI-Replacement-Plan.md §5", name))
			return argv, detectRepoRoot(), nil
		}
	}
	m := map[string]CommandSpec{
		"start": {
			Name:    "start",
			Summary: "Start YHA (today's ./yha.sh build|dev).",
			Build: func(args []string) ([]string, string, error) {
				// Default to build mode when caller passes nothing,
				// matching yha.sh's own default.
				mode := "build"
				rest := []string{}
				for _, a := range args {
					switch a {
					case "dev", "build":
						mode = a
					default:
						rest = append(rest, a)
					}
				}
				return shell(mode)(rest)
			},
		},
		"restart": {
			Name: "restart",
			Summary: "Bounce a YHA service. Default scope: bridge (YHA-Bridge only) — go-core, rewind, tui-daemon stay up so any chat stream survives. " +
				"`restart bridge dev|build` switches mode; `restart core|rewind|tui-daemon` targets one go binary; `restart all [dev|build]` bounces everything.",
			Build: func(args []string) ([]string, string, error) {
				// Vocabulary (introduced after the bridge-only restart
				// contract was clarified — see docs/restart-scopes.md):
				//   scope words:  bridge | core | rewind | tui-daemon |
				//                 tuid | all
				//   mode words:   dev | build   (only meaningful for
				//                                bridge + all scopes)
				//
				// Resolution rules:
				//   - First scope keyword wins. Default is "bridge" — the
				//     whole point of these subcommands is keeping the
				//     blast radius small unless the user opts in.
				//   - dev/build is the mode toggle. For "bridge" it
				//     switches YHA-Bridge to dev/build (re-runs vite build
				//     on the build side); for "all" it routes to the
				//     equivalent ./yha.sh <mode> full bounce.
				//   - core/rewind/tui-daemon never take dev/build — those
				//     go binaries are always built the same way (single
				//     source tree, no vite/HMR distinction).
				scope := ""
				mode := ""
				out := []string{}
				for _, a := range args {
					switch a {
					case "bridge":
						if scope == "" {
							scope = "bridge"
						}
					case "back":
						return nil, "", errors.New("restart: scope 'back' was renamed to 'bridge' (use: restart bridge)")
					case "core":
						if scope == "" {
							scope = "core"
						}
					case "rewind":
						if scope == "" {
							scope = "rewind"
						}
					case "tui-daemon", "tuid":
						if scope == "" {
							scope = "tui-daemon"
						}
					case "all":
						if scope == "" {
							scope = "all"
						}
					case "dev", "build":
						mode = a
					case "--keep-back":
						return nil, "", errors.New("restart: flag '--keep-back' was renamed to '--keep-bridge'")
					case "--keep-rewind", "--kill-rewind", "--keep-bridge":
						// Legacy v1 flags. Under the new vocab they're
						// no-ops: restart-bridge inherently keeps rewind,
						// restart-all is what asks for the full bounce.
						// Silently swallow so old muscle-memory still
						// works without surfacing a stale flag warning.
					default:
						out = append(out, a)
					}
				}
				if scope == "" {
					scope = "bridge"
				}
				switch scope {
				case "bridge":
					cmdArgs := []string{}
					if mode != "" {
						cmdArgs = append(cmdArgs, mode)
					}
					cmdArgs = append(cmdArgs, out...)
					return shell("restart-bridge")(cmdArgs)
				case "core":
					return shell("restart-core")(out)
				case "rewind":
					return shell("restart-rewind")(out)
				case "tui-daemon":
					return shell("restart-tui-daemon")(out)
				case "all":
					cmdArgs := []string{}
					if mode != "" {
						cmdArgs = append(cmdArgs, mode)
					}
					cmdArgs = append(cmdArgs, out...)
					return shell("restart-all")(cmdArgs)
				}
				return nil, "", fmt.Errorf("restart: unhandled scope %q", scope)
			},
		},
		"build": {
			Name:    "build",
			Summary: "Rebuild a component without restart.",
			Build: func(args []string) ([]string, string, error) {
				// --frontend → bun run build in frontend/
				// --go       → ./yha.sh go-build
				// --bridge   → no-op placeholder (planned)
				target := ""
				for _, a := range args {
					switch a {
					case "--frontend", "--go", "--bridge":
						target = a
					}
				}
				root := detectRepoRoot()
				switch target {
				case "--frontend":
					// Run bun directly with cwd=frontend — no shell wrapping
					// needed, works cross-platform (Linux and Windows have bun
					// on PATH after the standard install).
					argv := []string{"bun", "run", "build"}
					return argv, filepath.Join(root, "frontend"), nil
				case "--bridge":
					argv := stubEchoCommand("yha build --bridge: placeholder (no separate bridge build step today)")
					return argv, root, nil
				default:
					return shell("go-build")(nil)
				}
			},
		},
		"mode": {
			Name:    "mode",
			Summary: "Switch the bridge between dev and build mode. Maps to `restart-bridge <mode>` — only YHA-Bridge bounces, go-core / rewind / tui-daemon stay up.",
			Build: func(args []string) ([]string, string, error) {
				if len(args) == 0 {
					return nil, "", errors.New("mode: expected 'dev' or 'build'")
				}
				target := strings.ToLower(args[0])
				if target != "dev" && target != "build" {
					return nil, "", fmt.Errorf("mode: unknown target %q (want dev | build)", args[0])
				}
				// dev/build only meaningfully differ for the bridge (vite
				// HMR vs static dist). Go binaries are always built the
				// same way. So a "mode switch" is really a bridge-only
				// switch — route through restart-bridge so any in-flight
				// chat stream held by YHA-Core isn't dropped.
				cmdArgs := append([]string{target}, args[1:]...)
				return shell("restart-bridge")(cmdArgs)
			},
		},
		"go-reload": {
			Name:    "go-reload",
			Summary: "Zero-downtime blue-green restart of YHA-Core.",
			Build:   shell("go-reload"),
		},
		"share": {
			Name:    "share",
			Summary: "Re-enable tailscale funnel → http://127.0.0.1:8443.",
			Build: func(args []string) ([]string, string, error) {
				// tailscaleFunnelArgv is per-platform: prepends `sudo` on
				// unix (tailscaled is owned by root); on Windows the
				// SYSTEM-level tailscaled service accepts unprivileged
				// RPC from tailscale.exe so no elevation is needed.
				argv := tailscaleFunnelArgv("http://127.0.0.1:8443")
				return argv, detectRepoRoot(), nil
			},
		},
		"logs": {
			Name:    "logs",
			Summary: "Tail pm2 logs for a service (default: YHA-Bridge).",
			Build: func(args []string) ([]string, string, error) {
				svc := "YHA-Bridge"
				if len(args) > 0 {
					svc = args[0]
				}
				argv := []string{"pm2", "logs", svc, "--lines", "100", "--nostream"}
				return argv, detectRepoRoot(), nil
			},
		},
		"status": {
			Name:    "status",
			Summary: "pm2 + git + tailscale snapshot. Use the status snapshot op for structured data.",
			Build: func(args []string) ([]string, string, error) {
				root := detectRepoRoot()
				argv := []string{"/bin/sh", "-c", "pm2 status && echo && git -C " + root + " status -sb"}
				return argv, root, nil
			},
		},
		"stop": {
			Name:    "stop",
			Summary: "Stop all YHA-* pm2 services (except YHA-TUI-Daemon).",
			Build: func(args []string) ([]string, string, error) {
				argv := []string{"/bin/sh", "-c",
					"pm2 delete YHA-Bridge YHA-Core YHA-Rewind YHA-frontend 2>/dev/null; echo done"}
				return argv, detectRepoRoot(), nil
			},
		},
		// v1 stubs — present in the surface so future work just fills
		// in Build; nothing else changes for callers.
		"setup": {
			Name:    "setup",
			Summary: "First-time install + wizard (stub — not yet implemented).",
			Stub:    true,
			Build:   stub("setup"),
		},
		"repair": {
			Name:    "repair",
			Summary: "Diagnose + repair install state (stub — not yet implemented).",
			Stub:    true,
			Build:   stub("repair"),
		},
	}
	return m
}()

// BuildSpawn turns a command name + args into a SpawnSpec ready for
// Registry.Spawn. Origin is informational only — carried through to
// JobInfo.Origin so the TUI can render `[external: rewind-ui]`.
func BuildSpawn(cmd string, args []string, origin string) (SpawnSpec, error) {
	c, ok := Commands[cmd]
	if !ok {
		return SpawnSpec{}, fmt.Errorf("unknown command: %s", cmd)
	}
	argv, dir, err := c.Build(args)
	if err != nil {
		return SpawnSpec{}, err
	}
	if len(argv) == 0 {
		return SpawnSpec{}, errors.New("command produced empty argv")
	}
	return SpawnSpec{
		Cmd:    cmd,
		Args:   args,
		Origin: origin,
		Argv:   argv,
		Dir:    dir,
		Env:    os.Environ(),
	}, nil
}

// detectCurrentMode returns "dev" or "build" based on the actual env of
// the live bridge process (YHA-Bridge / YHA-Core / YHA-TUI-Daemon —
// whichever responds first via /proc/<pid>/environ). Falls back to "build"
// if nothing usable is found, matching yha.sh's own default. Used by
// :restart and :mode so a bare `:restart` keeps the user in the same mode
// they're currently running in instead of accidentally flipping to build.
func detectCurrentMode() string {
	for _, name := range []string{"YHA-Bridge", "YHA-Core", "YHA-TUI-Daemon"} {
		pid := pidOfPM2(name)
		if pid <= 0 {
			continue
		}
		raw, err := os.ReadFile("/proc/" + fmt.Sprintf("%d", pid) + "/environ")
		if err != nil {
			continue
		}
		for _, kv := range strings.Split(string(raw), "\x00") {
			if strings.HasPrefix(kv, "YHA_MODE=") {
				m := strings.ToLower(strings.TrimPrefix(kv, "YHA_MODE="))
				if m == "dev" || m == "build" {
					return m
				}
			}
		}
	}
	return "build"
}

// pidOfPM2 — minimal shell-out to `pm2 jlist` to find a process PID by
// name. Returns 0 on any failure so callers can fall through.
func pidOfPM2(name string) int {
	out, err := exec.Command("pm2", "jlist").Output()
	if err != nil {
		return 0
	}
	// Lightweight scan — full JSON parse isn't worth the dependency
	// surface for a 1-field lookup. The shape is stable enough that
	// matching the name + the nearest pid field is robust.
	needle := []byte(`"name":"` + name + `"`)
	idx := bytes.Index(out, needle)
	if idx < 0 {
		return 0
	}
	// Look for "pid":<number> near the name match (pm2 emits pid before
	// or after name depending on version; scan a 1KB window both ways).
	window := out
	start := idx - 1024
	if start < 0 {
		start = 0
	}
	end := idx + 1024
	if end > len(window) {
		end = len(window)
	}
	window = window[start:end]
	pidKey := []byte(`"pid":`)
	pi := bytes.Index(window, pidKey)
	if pi < 0 {
		return 0
	}
	rest := window[pi+len(pidKey):]
	n := 0
	for n < len(rest) && rest[n] >= '0' && rest[n] <= '9' {
		n++
	}
	if n == 0 {
		return 0
	}
	pid, err := strconv.Atoi(string(rest[:n]))
	if err != nil {
		return 0
	}
	return pid
}

// detectRepoRoot mirrors paths.BridgeRoot's heuristic but returns the
// *repo* root (the parent of bridge/). yha.sh lives at the repo root.
func detectRepoRoot() string {
	if v := os.Getenv("YHA_REPO_ROOT"); v != "" {
		return v
	}
	exe, err := os.Executable()
	if err == nil {
		// Repo layout: <repo>/bin/yha-tui-daemon → <repo>
		return filepath.Dir(filepath.Dir(exe))
	}
	cwd, _ := os.Getwd()
	return cwd
}
