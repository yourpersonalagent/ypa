# AGENTS.md

Structural guide for coding agents and contributors working in this repo. For
the product story and feature tour, see [README.md](README.md). This file is
about *where things live*, *the conventions to follow*, and *the rules that are
easy to get wrong*.

## Repo layout

A Bun workspace (`package.json` → `workspaces: ["bridge", "frontend"]`) plus a
Go module.

| Path | Runtime | Role |
|---|---|---|
| `go-core/` | Go 1.25 | Front door + supervisor. `cmd/yha-core` (`:8443`, the URL you open), `cmd/yha-rewind` (`:8445`), `cmd/yha-tui-daemon`, `cmd/yha` (CLI). |
| `bridge/` | Bun 1.2 | Hot-swappable service hub (`:8442`). Express app in `server.ts`; core routes in `routes/`; reloadable features in `modules/`. CommonJS (`require`). |
| `frontend/` | Vite + React 19 + TS | SPA, built to `dist/` and served by the bridge. |
| `tools/` | Bun / shell / Python | Repo tooling and maintenance helpers (e.g. `bump-version.mjs`). |
| `VERSION` | — | **Canonical project version.** Single source of truth. |

go-core is the public port; it proxies any route it doesn't handle natively
through to the bridge. So a new `bridge` route is reachable at the same path on
`:8443` as long as its prefix isn't claimed by go-core's native mux.

## Runtime ownership (Go ⇄ Node)

go-core is ~mid-migration absorbing the bridge's responsibilities. The full
current/target ownership map, env-flag catalog, and cutover runbook live in
[GO-Ownership-Plan.md](GO-Ownership-Plan.md). Default-config summary: **Go** owns
live streaming, metrics, rate-limiting, and auth (when WorkOS env is set);
**Node** still owns the session list, the MCP pool, tool discovery + module
tools, and module hot-reload; **persistence is co-written** by both.

Two things that are easy to break:

- **MCP autostart flags flip in lockstep.** Set `YHA_MCP_AUTOSTART=1` (Go) and
  `YHA_GO_OWNS_MCP=1` (Node) together or neither — one without the other either
  double-spawns every server in `mcp-state.json` or starts none.
- **Turn-finalize writes `sessions.db` from both runtimes** (Go's
  `SQLiteFinalizer` then Node's `finalizeLiveMsg`), coordinated by `live_token` +
  a CAS. Safe today, but don't add a third writer or reorder the hop without
  reading the plan.

## Versioning — the one rule

**`/VERSION` (repo root) is the single source of truth.** A plain `x.y.z`
semver + trailing newline. Everything else reads from it; never hard-code a
version anywhere else.

How it flows:

- **Frontend** — `frontend/vite.config.js` reads `../VERSION` at build time and
  bakes it in as the `__APP_VERSION__` define.
- **Bridge** — `bridge/routes/system.ts` reads `VERSION` for `/health` and
  serves `GET /v1/version` (build identity), `POST /v1/version/check` (compare
  HEAD vs upstream), `POST /v1/version/apply` (guarded fast-forward).
- **Go** — `cmd/yha-core` has `var version = "dev"`, overridden at build time by
  the launchers via `-ldflags "-X main.version=$VERSION"`. `yha-core --version`
  prints it.
- **package.json files** — `frontend`, `bridge`, and `bridge/mcp` track it,
  synced by the bump script.

To change the version, edit **only** `VERSION` — use the script:

```
bun run release            # bump patch
bun run release minor      # or: major | patch | 2.4.0
bun run version:show       # print current, change nothing
```

It rewrites `VERSION` + the three `package.json`s and prints the git
commit/tag/push commands (it does not run them — releases stay reviewable).

## Conventions

**Bridge core routes** live in `bridge/routes/*.ts` and are registered from
`server.ts` via `registerXxxRoutes(app)`. They mount on the shared Express app.
Use the path convention `/v1/<domain>/<resource>` (e.g. `/v1/version/check`).

**Bridge modules** live in `bridge/modules/<name>/` and are activated via
`bridge/modules.json` + the loader. A module exports `activate(ctx)` and mounts
its routes on `ctx.app`; it can be hot-swapped while chat streams (idle-drain).
Prefer a module over a core route when the feature is optional/disable-able;
prefer a core route when it must always exist.

**Frontend prefs tabs** register through the `prefsTabs` register. Core tabs are
added in `frontend/src/host/bootstrap-core-prefs-tabs.ts`:

```ts
registers.prefsTabs.add({ id, order, label, simpleMode, component, core: true }, '<core>');
```

`order` sets visual position; `simpleMode` is `'all' | 'partial' | null` (null =
advanced-only). Modules add their own tabs from `activate()` with the module
name as the owner key. Tabs talk to the bridge via `api.config.baseUrl` + `fetch`.

## Build & verify

```
bun run verify        # typecheck (all workspaces) + go build ./... + go vet ./...
bun run typecheck     # TS only
```

Run the full stack with the launcher — **`yha.ps1`** on Windows, **`yha.sh`**
on Linux/macOS/Pi:

```
.\yha.ps1 build        # production frontend + 4 Go binaries, all services
.\yha.ps1 dev          # hot-reload (bun --watch + live go-core)
.\yha.ps1 restart-bridge   # bounce only the bun bridge; go-core keeps the stream alive
```

Both launchers read `VERSION` and inject it into the `yha-core` build.

## Naming

**YPA** is the user-facing product name — use it in UI copy and anything an
end user reads. **YHA** is the backend/host/internal name — binaries, services
(`YHA-Back`, `YHA-Core`), env vars, internal code.

## Before you edit

- The working directory is the security boundary; agents read/write only within
  the CWD they're pointed at.
- This is a live tree — concurrent uncommitted edits are common. Check
  `git status` before large multi-file refactors so you don't clobber in-flight
  work, and keep changes scoped.
