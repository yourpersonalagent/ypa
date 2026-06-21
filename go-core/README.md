# yha-core (Go)

Compiled core for YHA. See [`../GO-Ownership-Plan.md`](../GO-Ownership-Plan.md)
for the authoritative Go ⇄ Node ownership map, env-flag catalog, and cutover
runbook. The phase-by-phase history lives in the "Phase N" code comments (anchors
listed in that doc).

This directory holds two binaries:

| Binary | Purpose |
|---|---|
| `cmd/yha-core/` | Long-running daemon. HTTP front door on `:8443` in go-mode (Tailscale Funnel target). Owns auth, state, MCP pool (opt-in), tool executor, native provider streaming, and metrics; reverse-proxies anything not yet absorbed to the Node bridge on `:8442`. |
| `cmd/yha/` | CLI + bubbletea TUI. Talks to `yha-core` over HTTP (loopback or remote `YHA_TOKEN`). Subcommands: `prompt`, `mcp`, `session`, `cost`, `status`, `logs`, `tui`, `localdev`. |

## Build

`./yha.sh go-build` builds both binaries to `bin/yha-core` and `bin/yha` at the repo root.
The script checks `.go` mtimes and rebuilds only when stale.

`./yha.sh go-build --owner` enables the owner overlay (Phase 4+; not present yet).

Direct: `cd go-core && go build -o ../bin/yha-core ./cmd/yha-core && go build -o ../bin/yha ./cmd/yha`

## Layout

```
cmd/
  yha-core/        daemon
  yha/             cli + tui
    tui/           bubbletea app (chat, sessions, notes, mcp, models, cwd)
internal/
  server/          net/http router, reverse proxy, SO_REUSEPORT listener
  ipc/             Unix-socket dial/listen helpers
  logger/          structured JSON logging
  errors/          error hierarchy (BridgeError equivalents)
  paths/           filesystem path constants
  registers/       generic Register[T] (mirrors bridge/core/registers/)
  auth/            WorkOS OAuth, sessions, cookies, allowlist, /v1/me
  state/           config.json store, BRIDGE_INTERNAL_KEY, in-memory maps
  rate/            per-provider token-bucket limiter (429-aware)
  mcp/             process pool, JSON-RPC protocol, /v1/mcp/* routes (opt-in)
  tools/           Bash / Read / Write / Glob / Grep / WebFetch + sandbox
  stream/          /v1/stream-direct/ — Anthropic / OpenAI / Gemini native streaming
  metrics/         in-process collector + /internal/metrics endpoint
```

## Status

| Phase | Description | State |
|---|---|---|
| 0 | Skeleton compiles, dirs exist | done |
| 1 | Reverse proxy: Go listens, forwards to Node | done (cmd/yha-core/main.go + internal/server/proxy.go) |
| 2a | State store + rate limiter native in Go | done (internal/state, internal/rate) |
| 2b | MCP process pool native in Go | done — opt-in via `YHA_MCP_AUTOSTART=1` (Node still owns MCP by default to avoid double-spawning; flip planned for Phase 2d) |
| 2c | Tool executor native in Go (`/v1/tools/*`) | done (internal/tools) |
| 2c-stream | Direct provider streaming native in Go (`/v1/stream-direct/`) | done — Anthropic, OpenAI, Gemini (internal/stream) |
| 2d | Auth: WorkOS, sessions, cookies, `/v1/me`, `/auth/*` | done (internal/auth); falls back to Node `/internal/whoami` lookup when SESSION_SECRET / WorkOS env are missing |
| 3 | CLI surface (`yha prompt`, `yha mcp`, `yha session`, `yha cost`, `yha status`, `yha logs`, `yha localdev`) | done (cmd/yha) |
| 4 | Metrics + zero-downtime reload | partial — metrics collector + `/internal/metrics` and `metrics/stream` done; SO_REUSEPORT + SIGUSR2 graceful drain done (`./yha.sh go-reload`); locked binary / `-tags owner` rebuild module not yet |
| 5 | bubbletea TUI | partial — chat, sessions, notes, mcp, models, cwd panes shipped (cmd/yha/tui); feature-parity with the web UI is the open scope |
| 6 | Per-module hot reload coordinated by Go | not started |

## Auth modes

The daemon picks one of three auth modes at boot, in order of preference:

1. **Native (Phase 2d)** — `SESSION_SECRET` + `WORKOS_API_KEY` + `WORKOS_CLIENT_ID` set. Go owns the OAuth flow, session cookies, and `/v1/me`. WorkOS callbacks land on the Go core.
2. **Advisory (Phase 2b fallback)** — auth env partially missing. Go's `auth.Gate` classifies every request and stamps `X-Yha-Auth` headers but does not reject; Node bridge still does the real auth check on the proxied request. Set `YHA_GO_AUTH_ENFORCE=1` to flip into enforcing mode.
3. **Pass-through** — `auth.Gate` not wired. Pure reverse proxy; Node owns everything.

## MCP ownership

`/v1/mcp/*` is dual-mode by env:

- **`YHA_MCP_AUTOSTART=1`** — Go spawns every server in `bridge/mcp-state.json` on boot, registers `/v1/mcp/*` natively, hooks pool metrics into the collector. Node bridge should be configured to skip its own autostart in this mode (otherwise both spawn).
- **default (unset)** — Go pool is constructed but idle. `/v1/mcp/*` reverse-proxies to Node, which still owns the registry. The frontend MCP buttons keep working through the proxy. Phase 2d flips the default once Node hands MCP ownership over.

## Running locally

```bash
./yha.sh dev         # default = go-mode  (Go on :8443, Node on :8442)
./yha.sh dev node    # legacy   (Node on :8443, no Go)
./yha.sh build       # production frontend + go-mode
./yha.sh go-reload   # zero-downtime rebuild + restart of YHA-Core
```

`yha.sh` handles the build automatically — `ensure_go_core()` rebuilds when any `.go` file
is newer than `bin/yha-core` or `bin/yha`. No manual `go build` step needed in the normal flow.

## Env vars worth knowing

| Var | Default | Effect |
|---|---|---|
| `YHA_CORE_PORT` | `8443` | Port the daemon listens on |
| `YHA_NODE_URL` | `http://127.0.0.1:8442` | Node bridge upstream for proxied routes |
| `YHA_CORE_SOCKET` | unset | Optional Unix socket override (replaces `--port`) |
| `YHA_MCP_AUTOSTART` | unset | `1` lets Go own the MCP pool; otherwise Node does |
| `YHA_GO_AUTH_ENFORCE` | unset | `1` makes the advisory auth gate reject unauthenticated requests |
| `YHA_REUSEPORT` | unset | `1` enables `SO_REUSEPORT` — required for `./yha.sh go-reload` |
| `YHA_DRAIN_TIMEOUT_SECONDS` | `30` | Max time SIGUSR2 path waits for in-flight requests before forced shutdown |
| `SESSION_SECRET` | unset | Required for Phase-2d native auth — same secret Express uses |
| `YHA_INTERNAL_KEY` | unset | Required for advisory auth's Node `/internal/whoami` lookup |
