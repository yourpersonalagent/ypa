---
name: yha-reload
category: yha
description: "Inspect and hot-reload YHA bridge modules without restarting the bridge. Use after editing files under bridge/modules/<name>/** to make the changes take effect, or to learn which modules need a full bridge restart instead."
version: 1.0.0
metadata:
  hermes:
    tags: [YHA, hot-reload, modules, bridge, development]
---

# YHA Module Reload

The YHA bridge is split into a stable **core** (auth, MCP, streaming pipe — never reloads at runtime, restart kills the conversation) and **modules** under `bridge/modules/<name>/` that CAN be hot-reloaded while the bridge keeps running.

**This skill is what you reach for after editing a module file — to confirm the edit took effect, or to find out whether the module you want to edit can even be reloaded live.**

## When to use this skill

- After editing any file under `bridge/modules/<name>/**`, to check the reload landed.
- BEFORE editing a module, to find out if reload is safe or if a restart is required.
- When the user asks "is the bridge using my latest code?".
- When you suspect a module is in a broken state and you want to retry activation.

Edits to `frontend/src/modules/<name>/**` don't need this skill — Vite's HMR handles them automatically.

## The reload posture (read this before editing)

Every module's `module.json` declares a `lifecycle.reload` value. Read it before assuming an edit is safe to make live.

| Posture | Meaning |
|---|---|
| `safe` | Reload anytime. File-watcher auto-reloads on edit. |
| `idle-only` | Reload only when no requests are in flight on `/v1/<name>`. Watcher retries every 2 s while busy. |
| `never` | Cannot be hot-reloaded. Edit takes effect only after a bridge restart. Use `./yha.sh restart-bridge` — that bounces ONLY YHA-Back and leaves YHA-Core's ring buffer alive, so the chat you're in **survives the restart**. Do NOT use `./yha.sh build` or `pm2 restart YHA-Back` directly; those kill go-core too (or skip the rebuild step) and drop the chat mid-stream. |

The current classification (16 idle-only, 8 safe, 6 never) is in `docs/Hot-Reload-Modules.md`. Modules with `reload: never` include `mcp-client`, `multichat-partners`, `workflows-and-triggers`, `context-generator`, `observability-plus`, `link` — these own child processes, background workers, or external persistent state that doesn't survive a reactivation.

## Tools you'll use

### List modules and their reload state

Hit the bridge's local API. The `/v1/modules` endpoint has a loopback bypass for auth so this works from any local process:

```bash
curl -s http://localhost:8442/v1/modules | jq '.modules[] | {name, state, reload, activeRequests}'
```

Replace `8442` with whatever port the bridge is on (`8443` if running without go-core in front). Look at the `reload` field for each module — that's the posture.

Tighter: just check one module before you edit it:

```bash
curl -s http://localhost:8442/v1/modules | jq '.modules[] | select(.name=="todos") | {reload, activeRequests}'
```

### Trigger an explicit reload

The file-watcher auto-reloads `safe` and `idle-only` modules within ~250 ms of an edit, so usually you don't have to call this. But if you want to confirm or force:

```bash
curl -s -X POST http://localhost:8442/v1/modules/<name>/reload
```

Response shapes:

- `200 {"success": true, "reload": "safe"}` → reloaded successfully.
- `409 {"success": false, "error": "...", "reload": "never"}` → module is `never`-class, requires bridge restart.
- `409 {"success": false, "error": "...idle-only...", "activeRequests": N}` → module is busy. Wait and retry. Pass `?force=1` to override **only if the user explicitly approves dropping those in-flight requests**.

### Restart bridge (safe for active chats — go-core keeps streaming)

For `never`-class module edits or for changes to `bridge/core/**` / `bridge/server.ts`:

```bash
./yha.sh restart-bridge        # bounce YHA-Back; YHA-Core/Rewind/TUI-Daemon stay up
```

This bounces ONLY YHA-Back. YHA-Core, YHA-Rewind, and YHA-TUI-Daemon keep
running, which means **any chat stream in flight survives the restart** — the
ring buffer lives in YHA-Core, and the bridge re-attaches to it once it
comes back up. Pre-Q22 the only option was a full bounce (which dropped
streams mid-token); reach for `restart-bridge` unless you really need the
heavier scope.

For changes to `go-core/**`, hit only that binary:

```bash
./yha.sh restart-core          # bounce YHA-Core; bridge/rewind/tui-daemon stay
./yha.sh go-reload             # zero-downtime variant (SO_REUSEPORT swap)
```

`./yha.sh go-reload` is the lossless variant if you want zero outage on
the public port. Both keep the bridge alive.

Full bounce (`./yha.sh restart-all`, or the legacy `./yha.sh build`) is
the only option that kills go-core. Reach for it only when:

- You've edited `go-core/**` AND `bridge/core/**` AND need a coherent boot.
- The bridge is in a broken state that survives a `restart-bridge`.
- Explicit user request.

NEVER use `./yha.sh build` mid-conversation as a "restart the bridge"
shortcut. It still works, but it tears down go-core and the user's chat
goes with it. The whole reason `restart-bridge` exists is to avoid this
class of mistake.

Other targeted restarts:

```bash
./yha.sh restart-rewind        # only YHA-Rewind (recover page service)
./yha.sh restart-tui-daemon    # only YHA-TUI-Daemon (operator console)
./yha.sh restart-all [dev|build]  # full bounce (kills chat — explicit consent only)
```

The TUI mirrors these as `:restart bridge`, `:restart core`, `:restart all`,
etc. — same scope semantics.

## Decision tree

```
Edit file under bridge/modules/<name>/**
  │
  ├─ Module's reload is "safe" → just edit. Watcher auto-reloads. Optionally
  │     confirm with POST /v1/modules/<name>/reload.
  │
  ├─ Module's reload is "idle-only" → check activeRequests first. If 0, edit
  │     and let watcher reload. If >0, finish the open requests first OR
  │     warn the user before passing ?force=1.
  │
  └─ Module's reload is "never" → run `./yha.sh restart-bridge`. Chat survives
       (go-core's ring buffer keeps the stream). No user warning needed unless
       the module owns external persistent state (mcp-client child processes,
       link sync handles) that won't recover.

Edit file under frontend/src/modules/<name>/** → Vite HMR handles it. No action.

Edit file under bridge/core/** or bridge/server.ts → run `./yha.sh restart-bridge`.
  Chat survives (go-core stays up). No user warning needed.

Edit file under go-core/** → run `./yha.sh restart-core` (or `./yha.sh go-reload`
  for zero-downtime). Bridge stays up, but chat-stream reattachment depends on
  whether the new go-core has the ring buffer warm; warn the user if active.

Edit affecting BOTH bridge/core/** AND go-core/** → `./yha.sh restart-all`.
  This is the only path that kills go-core's ring buffer, which means chat
  stream dies mid-token. Warn the user and get explicit consent first.
```

## Common patterns

**You changed a route handler in `bridge/modules/todos/routes.ts`.** Posture is `idle-only`. The file-watcher auto-reloads within ~250 ms. You can confirm with `curl http://localhost:8442/v1/modules | jq '.modules[] | select(.name=="todos")'` and check `loadedAt` updated.

**You want to ensure `mcp-client` picks up a config change.** It's `never` — explain to the user that a bridge restart is required and ask first. There's no hot-reload path.

**You see a 409 "idle-only with N in-flight" response.** Don't force-reload silently. The N in-flight requests will be cut. Either wait for them or get explicit user approval.

**You don't know what port the bridge is on.** Check `pm2 status YHA-Back` or look at the .env file's `PORT` setting. In go-mode it's 8442; in node-mode it's 8443.

## Where the underlying code lives

For deeper troubleshooting (not for routine use):

- File-watcher: `bridge/core/modules/watcher.ts` (debounce 250 ms, honors `lifecycle.reload`, disabled with `YHA_NO_WATCH=1`).
- Reload mechanism: `bridge/core/modules/loader.ts` — `reload(name, app)` busts `require.cache` and re-runs `activate(ctx)`.
- HTTP routes: `bridge/core/modules/routes.ts` — `GET /v1/modules`, `POST /v1/modules/:name/reload`.
- Manifest schema: `bridge/core/modules/manifest-schema.ts` — defines `lifecycle.reload`.
- Per-module audit: `docs/Hot-Reload-Modules.md`.
