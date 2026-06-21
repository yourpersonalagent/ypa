#!/bin/bash

# =============================================
# YHA Start-Script
#
# Usage:
#   ./yha.sh [dev|build|go-build|go-reload|tui|restart-*] [node] [--owner] [--bare-core] [--skip-rewind]
#
# Backend modes (go is the default):
#   ./yha.sh dev          go-mode  (Go front-door :8443  →  Node :8442 upstream)
#   ./yha.sh dev node     legacy   (Node :8443, no Go)
#   ./yha.sh build        go-mode + production frontend
#   ./yha.sh build node   legacy + production frontend
#
# Either mode keeps Tailscale Funnel pointed at :8443 — go-mode puts Go
# behind it, node-mode puts Node behind it. Same public URL.
#
# Restart commands — precise scope, preserve in-flight chat streams:
#   restart-bridge [dev|build]   bounce ONLY YHA-Bridge (alias: restart-back).
#                                Go-core keeps streaming, rewind tab survives.
#                                No mode arg = keep current YHA_MODE.
#                                Mode arg = switch (re-runs vite build for "build").
#   restart-core                 bounce ONLY YHA-Core (always built, no mode).
#   restart-rewind               bounce ONLY YHA-Rewind (always built, no mode).
#   restart-tui-daemon           bounce ONLY YHA-TUI-Daemon (always built, no mode).
#   restart-all [dev|build]      full bounce, same as `./yha.sh build` (or dev).
#                                No mode arg = keep current YHA_MODE.
#
# Other commands:
#   go-build           rebuild Go binaries only, exit
#   go-reload          zero-downtime blue-green restart of YHA-Core (SO_REUSEPORT + SIGUSR2)
#   tui                open the operator TUI (./bin/yha tui) — builds the
#                      yha + yha-tui-daemon binaries if missing, then execs
#                      the viewer. Daemon must be running (start with
#                      ./yha.sh dev or build) for the dashboard to populate;
#                      otherwise the panel shows "daemon offline" + retries.
#
# Flags:
#   --owner           build Go core with owner-only features (or YHA_OWNER=true)
#   --bare-core       run with every TS module disabled (or YHA_BARE_CORE=1)
#
# Env overrides:
#   YHA_BACKEND=node  force legacy mode regardless of CLI args
# =============================================

# Keep one launcher portable across Linux and macOS. Non-interactive shells
# (including SSH commands and PM2) often skip ~/.zprofile / ~/.bashrc, so add
# the conventional install locations explicitly and load nvm when present.
setup_runtime_path() {
  # Vendor-native harness installers use these per-user locations:
  #   Claude/Codex -> ~/.local/bin, Grok Build -> ~/.grok/bin.
  # Include them before PM2 starts the bridge so runtime detection and spawned
  # harness sessions see the same binaries as an interactive login shell.
  local extra_path="$HOME/.local/bin:$HOME/.grok/bin:$HOME/.bun/bin:/usr/local/go/bin:/opt/homebrew/bin:/usr/local/bin"
  # The macOS App Store/GUI Tailscale package keeps its CLI inside the app
  # bundle unless the user separately installs a system-wide symlink.
  if [ -x "/Applications/Tailscale.app/Contents/MacOS/tailscale" ]; then
    extra_path="/Applications/Tailscale.app/Contents/MacOS:$extra_path"
  fi
  export PATH="$extra_path:$PATH"
  if [ -s "$HOME/.nvm/nvm.sh" ]; then
    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
    # nvm may print version-selection chatter; the launcher should stay quiet.
    . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1
  fi
}

# A dotenv file is not a shell script: unquoted spaces and JSON values are
# valid dotenv but become commands/syntax errors when sourced. Parse the
# simple KEY=VALUE format without eval so secrets and punctuation stay data.
load_dotenv() {
  local env_file="$1" line key value first last
  [ -f "$env_file" ] || return 0

  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    # Trim leading whitespace for comment/blank detection.
    line="${line#"${line%%[![:space:]]*}"}"
    case "$line" in
      ''|'#'*) continue ;;
      export[[:space:]]*) line="${line#export}" ;;
    esac
    case "$line" in
      *=*) ;;
      *) echo "⚠ Ignoring malformed dotenv line in $env_file" >&2; continue ;;
    esac

    key="${line%%=*}"
    value="${line#*=}"
    key="${key#"${key%%[![:space:]]*}"}"
    key="${key%"${key##*[![:space:]]}"}"
    if ! [[ "$key" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
      echo "⚠ Ignoring invalid dotenv key in $env_file" >&2
      continue
    fi

    value="${value#"${value%%[![:space:]]*}"}"
    value="${value%"${value##*[![:space:]]}"}"
    if [ ${#value} -ge 2 ]; then
      first="${value:0:1}"
      last="${value:${#value}-1:1}"
      if { [ "$first" = '"' ] && [ "$last" = '"' ]; } || \
         { [ "$first" = "'" ] && [ "$last" = "'" ]; }; then
        value="${value:1:${#value}-2}"
      fi
    fi
    export "$key=$value"
  done < "$env_file"
}

setup_runtime_path

MODE=${1:-build}
BACKEND_MODE="go"
OWNER_FLAG=false
BARE_CORE_FLAG=false
# --skip-rewind: leave the running YHA-Rewind pm2 entry untouched. Used when
# the rewind service itself triggers the restart (POST /api/yha-restart) so
# the recover page stays up through the bounce, keeps streaming top/pm2/
# sessions info, and the user doesn't lose the only diagnostic surface
# during the most fragile window of the restart.
SKIP_REWIND=false
for arg in "$@"; do
  case "$arg" in
    --owner)       OWNER_FLAG=true ;;
    --bare-core)   BARE_CORE_FLAG=true ;;
    --skip-rewind) SKIP_REWIND=true ;;
    node)          BACKEND_MODE="node" ;;
  esac
done
[[ "${YHA_OWNER:-false}" == "true" ]] && OWNER_FLAG=true
[[ "${YHA_BARE_CORE:-}" == "1" || "${YHA_BARE_CORE:-}" == "true" ]] && BARE_CORE_FLAG=true
[[ "${YHA_BACKEND:-}" == "node" ]] && BACKEND_MODE="node"

case "$MODE" in
  dev|build|go-build|go-reload|tui) ;;
  restart-bridge|restart-back|restart-core|restart-rewind|restart-tui-daemon|restart-all) ;;
  *)
    echo "Usage: ./yha.sh [dev|build|go-build|go-reload|tui|restart-bridge|restart-back|restart-core|restart-rewind|restart-tui-daemon|restart-all] [node] [--owner] [--bare-core] [--skip-rewind]"
    exit 1
    ;;
esac

# ── TUI shortcut ─────────────────────────────────────────────────────────────
# `./yha.sh tui` is a thin entry point to the operator console (./bin/yha tui).
# Lives here so users get a one-step way into the new UI without learning the
# bin/ paths. The full slim-down of yha.sh (per docs/YHA-TUI-Replacement-Plan.md
# §9) is deferred until the TUI handles every responsibility this script does
# today — for now we just ensure the binaries exist, then exec.
if [ "$MODE" = "tui" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  GO_CORE_SRC="$SCRIPT_DIR/go-core"
  GO_CLI_BIN="$SCRIPT_DIR/bin/yha"
  TUI_DAEMON_BIN="$SCRIPT_DIR/bin/yha-tui-daemon"

  # Always run `go build` for both binaries — Go's incremental cache
  # makes this a no-op (<300ms) when nothing changed, but it guarantees
  # the user sees the latest source on every `./yha.sh tui` call. Without
  # this, an edited dashboard.go could ship to the running daemon while
  # the CLI stayed stale (or vice versa), and the symptom would be
  # confusing "I just fixed this!" cycles. Per the user's request:
  # rebuild client + daemon, then restart the daemon, before exec'ing.
  echo "→ Rebuilding yha CLI…"
  (cd "$GO_CORE_SRC" && go build -o "$GO_CLI_BIN" ./cmd/yha) || {
    echo "❌ yha build failed — see above"; exit 1; }
  echo "→ Rebuilding yha-tui-daemon…"
  (cd "$GO_CORE_SRC" && go build -o "$TUI_DAEMON_BIN" ./cmd/yha-tui-daemon) || {
    echo "❌ yha-tui-daemon build failed — see above"; exit 1; }

  # Restart the daemon so the live process matches the binary we just
  # built. The previous logic only bounced pm2 when staleness flipped,
  # which left a window where the user saw a freshly-built CLI talking
  # to a stale daemon socket. If pm2 isn't aware of the daemon yet,
  # start it; otherwise restart in place.
  if command -v pm2 >/dev/null 2>&1; then
    if pm2 jlist 2>/dev/null | grep -q '"name":"YHA-TUI-Daemon"'; then
      echo "→ pm2 restart YHA-TUI-Daemon (binary refreshed)"
      pm2 restart YHA-TUI-Daemon --update-env >/dev/null 2>&1 || true
    else
      echo "→ pm2 start YHA-TUI-Daemon"
      pm2 start "$TUI_DAEMON_BIN" --name "YHA-TUI-Daemon" --update-env --cwd "$SCRIPT_DIR" >/dev/null 2>&1 || {
        echo "⚠ YHA-TUI-Daemon failed to start — TUI will fall back to direct mode."
      }
    fi
  else
    echo "❌ pm2 is required to run YHA-TUI-Daemon. Install it with: npm install -g pm2"
    exit 1
  fi

  shift  # drop the 'tui' arg so anything after passes to the viewer
  exec "$GO_CLI_BIN" tui "$@"
fi

if [ "$BARE_CORE_FLAG" = "true" ]; then
  export YHA_BARE_CORE=1
  echo "→ BARE-CORE mode: every module in modules.json will be skipped."
fi

# ── Paths ─────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
GO_CORE_SRC="$SCRIPT_DIR/go-core"
GO_CORE_BIN="$SCRIPT_DIR/bin/yha-core"
GO_CLI_BIN="$SCRIPT_DIR/bin/yha"
REWIND_BIN="$SCRIPT_DIR/bin/yha-rewind"
TUI_DAEMON_BIN="$SCRIPT_DIR/bin/yha-tui-daemon"

# Canonical project version — single source of truth at the repo root.
# Injected into yha-core via -ldflags so `yha-core --version` and the
# /v1/version endpoint report the real build. See AGENTS.md.
VERSION_FILE="$SCRIPT_DIR/VERSION"
APP_VERSION="dev"
[ -f "$VERSION_FILE" ] && APP_VERSION="$(tr -d '[:space:]' < "$VERSION_FILE")"
[ -n "$APP_VERSION" ] || APP_VERSION="dev"

BUN="$(command -v bun 2>/dev/null || true)"
PM2="$(command -v pm2 2>/dev/null || true)"

# ── Port plan (go-mode vs node-mode) ─────────────────────────────────────────
# In go-mode the public port (Tailscale Funnel target) is 8443 and Go
# listens there; Node moves to 8442. In node-mode Node owns 8443 like
# before and Go isn't started.
PUBLIC_PORT=8443
if [ "$BACKEND_MODE" = "go" ]; then
  NODE_PORT=8442
  GO_PORT=$PUBLIC_PORT
else
  NODE_PORT=$PUBLIC_PORT
fi
# Rewind safety-net service. Standalone so it survives a broken bridge —
# overriding YHA_REWIND_PORT lets a second yha checkout coexist.
# 8444 is taken by the bridge's loopback OpenAI-compat endpoint; 8445 is the
# next free port in the same neighbourhood. Override with YHA_REWIND_PORT.
REWIND_PORT=${YHA_REWIND_PORT:-8445}
export YHA_REWIND_PORT="$REWIND_PORT"

# ── Shared bridge key ────────────────────────────────────────────────────────
# Generate a shared bridge key if missing. Both Node (bridge/core/state.ts)
# and Go (go-core/internal/state/state.go) read YHA_BRIDGE_KEY from env;
# without it, /proxy/tool cross-process callbacks fail with 401.
ENV_FILE="$SCRIPT_DIR/bridge/.env"
if [ -f "$ENV_FILE" ] && grep -q '^YHA_BRIDGE_KEY=' "$ENV_FILE"; then
  : # already present
else
  KEY=$(openssl rand -hex 32)
  echo "" >> "$ENV_FILE"
  echo "# Shared bridge key for cross-process callbacks (generated $(date -u '+%Y-%m-%dT%H:%M:%SZ'))" >> "$ENV_FILE"
  echo "YHA_BRIDGE_KEY=$KEY" >> "$ENV_FILE"
  echo "→ Generated shared YHA_BRIDGE_KEY (written to bridge/.env)"
fi
# Lock down .env — it holds the shared bridge key (and typically provider API
# keys + SESSION_SECRET). A world/group-readable .env leaks those secrets to
# any other local user. Re-applied every run in case it was created 0644.
[ -f "$ENV_FILE" ] && chmod 600 "$ENV_FILE" 2>/dev/null || true
# Export so child processes inherit it (Node's IIFE reads .env into process.env;
# Go reads os.Getenv directly — both need it in the script's environment).
export YHA_BRIDGE_KEY=$(grep '^YHA_BRIDGE_KEY=' "$ENV_FILE" | head -1 | cut -d= -f2-)

# ── Go core build helper ─────────────────────────────────────────────────────
ensure_go_core() {
  [ -d "$GO_CORE_SRC" ] || return 0

  local build_tags=""
  [ "$OWNER_FLAG" = "true" ] && build_tags="-tags owner"

  local needs_build=false
  if [ ! -f "$GO_CORE_BIN" ] || [ ! -f "$GO_CLI_BIN" ]; then
    needs_build=true
  elif find "$GO_CORE_SRC" -name "*.go" -newer "$GO_CORE_BIN" | grep -q .; then
    needs_build=true
  elif find "$GO_CORE_SRC" -name "*.go" -newer "$GO_CLI_BIN" | grep -q .; then
    needs_build=true
  fi

  if [ "$needs_build" = "true" ]; then
    local tag_label=""
    [ "$OWNER_FLAG" = "true" ] && tag_label=" (owner build)"
    echo "→ Building Go core${tag_label}..."
    mkdir -p "$SCRIPT_DIR/bin"
    (cd "$GO_CORE_SRC" && go build $build_tags -ldflags "-X main.version=$APP_VERSION" -o "$GO_CORE_BIN" ./cmd/yha-core) || {
      echo "❌ Go core build failed — see above"
      exit 1
    }
    (cd "$GO_CORE_SRC" && go build $build_tags -o "$GO_CLI_BIN" ./cmd/yha) || {
      echo "❌ Go CLI build failed — see above"
      exit 1
    }
    echo "→ Go core + CLI built."
  else
    echo "→ Go core up to date."
  fi
}

# ── TUI daemon build helper ──────────────────────────────────────────────────
# yha-tui-daemon (YHA-TUI-Daemon pm2 service) is the new operator-console
# host introduced by docs/YHA-TUI-Replacement-Plan.md. Staleness check
# matches the rewind helper — editing its sources triggers a rebuild
# without forcing a full Go-core rebuild.
ensure_yha_tui_daemon() {
  [ -d "$GO_CORE_SRC" ] || return 0

  local needs_build=false
  if [ ! -f "$TUI_DAEMON_BIN" ]; then
    needs_build=true
  elif find "$GO_CORE_SRC/cmd/yha-tui-daemon" -name "*.go" -newer "$TUI_DAEMON_BIN" 2>/dev/null | grep -q .; then
    needs_build=true
  elif find "$GO_CORE_SRC/internal/tuid" -name "*.go" -newer "$TUI_DAEMON_BIN" 2>/dev/null | grep -q .; then
    needs_build=true
  elif find "$GO_CORE_SRC/internal/sysstatus" -name "*.go" -newer "$TUI_DAEMON_BIN" 2>/dev/null | grep -q .; then
    needs_build=true
  elif find "$GO_CORE_SRC/internal/paths" -name "*.go" -newer "$TUI_DAEMON_BIN" 2>/dev/null | grep -q .; then
    needs_build=true
  fi

  if [ "$needs_build" = "true" ]; then
    echo "→ Building yha-tui-daemon..."
    mkdir -p "$SCRIPT_DIR/bin"
    (cd "$GO_CORE_SRC" && go build -o "$TUI_DAEMON_BIN" ./cmd/yha-tui-daemon) || {
      echo "❌ yha-tui-daemon build failed — see above"
      exit 1
    }
    echo "→ yha-tui-daemon built."
  else
    echo "→ yha-tui-daemon up to date."
  fi
}

# ── Rewind service build helper ──────────────────────────────────────────────
# Standalone safety-net process. Same staleness check as ensure_go_core so
# editing its main.go alone triggers a rebuild without forcing a full
# Go-core rebuild.
ensure_yha_rewind() {
  [ -d "$GO_CORE_SRC" ] || return 0

  local needs_build=false
  if [ ! -f "$REWIND_BIN" ]; then
    needs_build=true
  elif find "$GO_CORE_SRC/cmd/yha-rewind" -name "*.go" -newer "$REWIND_BIN" 2>/dev/null | grep -q .; then
    needs_build=true
  elif find "$GO_CORE_SRC/internal/logger" -name "*.go" -newer "$REWIND_BIN" 2>/dev/null | grep -q .; then
    needs_build=true
  fi

  if [ "$needs_build" = "true" ]; then
    echo "→ Building yha-rewind..."
    mkdir -p "$SCRIPT_DIR/bin"
    (cd "$GO_CORE_SRC" && go build -o "$REWIND_BIN" ./cmd/yha-rewind) || {
      echo "❌ yha-rewind build failed — see above"
      exit 1
    }
    echo "→ yha-rewind built."
  else
    echo "→ yha-rewind up to date."
  fi
}

# ── restart-* helpers ────────────────────────────────────────────────────────
# Shared between the restart-bridge / restart-core / restart-rewind /
# restart-tui-daemon / restart-all branches below. The whole point of these
# subcommands is precise scope — bouncing one pm2 entry without taking out
# YHA-Core (which owns the streaming ring buffer that keeps the user's chat
# alive across bridge edits). See docs/restart-scopes.md for the rationale.

# detect_current_mode reads YHA_MODE from PM2's saved process environment for
# YHA-Bridge / YHA-Core / YHA-TUI-Daemon — whichever is up — falling back to
# "build" if nothing usable is found. Mirrors detectCurrentMode in
# go-core/internal/tuid/commands.go so the TUI and shell agree on what
# "same mode" means for bare ./yha.sh restart-bridge calls.
detect_current_mode() {
  local svc mode
  for svc in YHA-Bridge YHA-Core YHA-TUI-Daemon; do
    mode=$($PM2 jlist 2>/dev/null \
      | python3 -c "
import json, sys
try:
  for p in json.load(sys.stdin):
    if p.get('name') == '$svc':
      pm = p.get('pm2_env', {})
      env = pm.get('env', {}) or pm
      print(env.get('YHA_MODE', pm.get('YHA_MODE', '')))
      break
except Exception:
  pass" 2>/dev/null)
    mode=$(printf '%s' "$mode" | tr '[:upper:]' '[:lower:]')
    if [ "$mode" = "dev" ] || [ "$mode" = "build" ]; then
      echo "$mode"
      return
    fi
  done
  echo "build"
}

# detect_current_backend mirrors the mode detection but for YHA_BACKEND.
# Used by restart-bridge during a mode-switch so the new YHA-Bridge lands on
# the same port-plan (NODE_PORT=8442 when YHA-Core fronts, 8443 otherwise).
detect_current_backend() {
  local svc backend
  for svc in YHA-Bridge YHA-Core YHA-TUI-Daemon; do
    backend=$($PM2 jlist 2>/dev/null \
      | python3 -c "
import json, sys
try:
  for p in json.load(sys.stdin):
    if p.get('name') == '$svc':
      pm = p.get('pm2_env', {})
      env = pm.get('env', {}) or pm
      print(env.get('YHA_BACKEND', pm.get('YHA_BACKEND', '')))
      break
except Exception:
  pass" 2>/dev/null)
    backend=$(printf '%s' "$backend" | tr '[:upper:]' '[:lower:]')
    if [ "$backend" = "go" ] || [ "$backend" = "node" ]; then
      echo "$backend"
      return
    fi
  done
  echo "go"
}

# release_port_if_bound is the early-script-safe twin of release_port (which
# lives inside the normal-startup block). Restart subcommands run before
# that helper is defined, so we inline the same logic here.
release_port_if_bound() {
  local p=$1
  local pids=""
  if command -v lsof >/dev/null 2>&1; then
    pids=$(lsof -tiTCP:"$p" -sTCP:LISTEN 2>/dev/null || true)
  elif command -v ss >/dev/null 2>&1 && ss -tlnp 2>/dev/null | grep -q ":${p} "; then
    command -v fuser >/dev/null 2>&1 && pids=$(fuser "${p}/tcp" 2>/dev/null || true)
  fi
  if [ -n "$pids" ]; then
    echo "→ Port ${p} still bound — forcing release..."
    kill $pids 2>/dev/null || true
    sleep 1
  fi
}

# ── restart-bridge / restart-back: bounce ONLY YHA-Bridge ──────────────────────
# The whole reason these subcommands exist: editing TS modules under bridge/
# used to require `./yha.sh build`, which tore down YHA-Core (the ring-buffer
# survival layer) and killed any in-flight chat stream. This path leaves
# YHA-Core, YHA-Rewind, and YHA-TUI-Daemon untouched.
#
# Mode handling:
#   no mode arg                  → pm2 restart YHA-Bridge in place (env preserved)
#   dev|build same as current    → pm2 restart YHA-Bridge (no env change needed)
#   dev|build switching          → delete + start with new YHA_MODE/YHA_USE_DIST
if [[ "$MODE" == "restart-bridge" || "$MODE" == "restart-back" ]]; then
  if [ -z "$PM2" ]; then
    echo "❌ pm2 not found in PATH"
    exit 1
  fi
  if ! $PM2 jlist 2>/dev/null | grep -q '"name":"YHA-Bridge"'; then
    echo "❌ YHA-Bridge is not registered with pm2 — start it first with ./yha.sh build (or dev)."
    exit 1
  fi

  target_mode=""
  for arg in "$@"; do
    case "$arg" in
      dev|build) target_mode="$arg" ;;
    esac
  done

  current_mode=$(detect_current_mode)
  current_backend=$(detect_current_backend)

  if [ -z "$target_mode" ] || [ "$target_mode" = "$current_mode" ]; then
    echo "→ Restarting YHA-Bridge ($current_mode mode, env preserved)..."
    $PM2 restart YHA-Bridge
    $PM2 save --force >/dev/null
    echo ""
    echo "✅ YHA-Bridge bounced — YHA-Core, YHA-Rewind, YHA-TUI-Daemon untouched."
    exit 0
  fi

  echo "→ Switching YHA-Bridge from $current_mode → $target_mode..."
  if [ -f "$SCRIPT_DIR/bridge/.env" ]; then
    load_dotenv "$SCRIPT_DIR/bridge/.env"
  fi
  # Mirror the port plan from the normal-startup branch: go-mode keeps Node
  # on :8442 (behind YHA-Core on :8443); node-mode puts Node directly on :8443.
  if [ "$current_backend" = "go" ]; then
    export PORT=8442
  else
    export PORT=8443
  fi
  export USE_HTTP=true
  export YHA_MODE="$target_mode"
  export YHA_BACKEND="$current_backend"

  if [ "$target_mode" = "dev" ]; then
    export YHA_USE_DIST=false
    $PM2 delete YHA-Bridge 2>/dev/null || true
    release_port_if_bound "$PORT"
    echo "→ Starting bridge in dev mode (bun --watch + embedded Vite) on :${PORT}..."
    $PM2 start "$BUN" --name "YHA-Bridge" --update-env --cwd "$SCRIPT_DIR/bridge" -- run dev
  else
    echo "→ Building frontend with Vite..."
    (cd "$SCRIPT_DIR/frontend" && "$BUN" run build) || {
      echo "❌ Vite build failed"
      exit 1
    }
    export YHA_USE_DIST=true
    $PM2 delete YHA-Bridge 2>/dev/null || true
    release_port_if_bound "$PORT"
    echo "→ Starting bridge (production) on :${PORT}..."
    $PM2 start "$BUN" --name "YHA-Bridge" --update-env --cwd "$SCRIPT_DIR/bridge" -- run start
  fi
  $PM2 save --force >/dev/null
  echo ""
  echo "✅ YHA-Bridge restarted in $target_mode mode — YHA-Core, YHA-Rewind, YHA-TUI-Daemon untouched."
  exit 0
fi

# ── restart-core / restart-rewind / restart-tui-daemon ───────────────────────
# Go binaries don't have a dev/build distinction — there's one source tree,
# one binary, and pm2 owns the run loop. Each handler rebuilds the binary
# (cheap no-op if cache hit) and restarts the single pm2 entry.
if [[ "$MODE" == "restart-core" ]]; then
  if [ ! -d "$GO_CORE_SRC" ]; then
    echo "❌ No Go source found at $GO_CORE_SRC"
    exit 1
  fi
  if [ -z "$PM2" ]; then
    echo "❌ pm2 not found in PATH"
    exit 1
  fi
  ensure_go_core
  if ! $PM2 jlist 2>/dev/null | grep -q '"name":"YHA-Core"'; then
    echo "❌ YHA-Core is not registered with pm2 — start it first with ./yha.sh build."
    exit 1
  fi
  echo "→ Restarting YHA-Core (binary refreshed if stale)..."
  $PM2 restart YHA-Core --update-env
  $PM2 save --force >/dev/null
  echo ""
  echo "✅ YHA-Core restarted — YHA-Bridge, YHA-Rewind, YHA-TUI-Daemon untouched."
  exit 0
fi

if [[ "$MODE" == "restart-rewind" ]]; then
  if [ ! -d "$GO_CORE_SRC" ]; then
    echo "❌ No Go source found at $GO_CORE_SRC"
    exit 1
  fi
  if [ -z "$PM2" ]; then
    echo "❌ pm2 not found in PATH"
    exit 1
  fi
  ensure_yha_rewind
  if ! $PM2 jlist 2>/dev/null | grep -q '"name":"YHA-Rewind"'; then
    echo "❌ YHA-Rewind is not registered with pm2 — start it first with ./yha.sh build."
    exit 1
  fi
  echo "→ Restarting YHA-Rewind (binary refreshed if stale)..."
  $PM2 restart YHA-Rewind --update-env
  $PM2 save --force >/dev/null
  echo ""
  echo "✅ YHA-Rewind restarted — YHA-Bridge, YHA-Core, YHA-TUI-Daemon untouched."
  exit 0
fi

if [[ "$MODE" == "restart-tui-daemon" ]]; then
  if [ ! -d "$GO_CORE_SRC" ]; then
    echo "❌ No Go source found at $GO_CORE_SRC"
    exit 1
  fi
  if [ -z "$PM2" ]; then
    echo "❌ pm2 not found in PATH"
    exit 1
  fi
  ensure_yha_tui_daemon
  if $PM2 jlist 2>/dev/null | grep -q '"name":"YHA-TUI-Daemon"'; then
    echo "→ Restarting YHA-TUI-Daemon (binary refreshed if stale)..."
    $PM2 restart YHA-TUI-Daemon --update-env
  else
    echo "→ YHA-TUI-Daemon not registered — starting it..."
    $PM2 start "$TUI_DAEMON_BIN" --name "YHA-TUI-Daemon" --update-env --cwd "$SCRIPT_DIR" || {
      echo "❌ YHA-TUI-Daemon failed to start."
      exit 1
    }
  fi
  $PM2 save --force >/dev/null
  echo ""
  echo "✅ YHA-TUI-Daemon restarted — YHA-Bridge, YHA-Core, YHA-Rewind untouched."
  exit 0
fi

# ── restart-all: full bounce, equivalent to the legacy `./yha.sh build` ──────
# Resolves the target mode (explicit arg > detected > "build") and rewrites
# $MODE so the normal-startup section below runs end-to-end exactly as if
# the user had typed `./yha.sh <mode>` directly. The bridge's /v1/restart
# and the rewind page's R key still reach this path via --skip-rewind when
# the rewind tab needs to survive the bounce.
if [[ "$MODE" == "restart-all" ]]; then
  target_mode=""
  for arg in "$@"; do
    case "$arg" in
      dev|build) target_mode="$arg" ;;
    esac
  done
  if [ -z "$target_mode" ]; then
    target_mode=$(detect_current_mode)
  fi
  echo "→ restart-all: full bounce, mode=$target_mode (falling through to normal startup)…"
  MODE="$target_mode"
fi

# ── go-build mode: rebuild Go and exit ────────────────────────────────────────
if [[ "$MODE" == "go-build" ]]; then
  if [ ! -d "$GO_CORE_SRC" ]; then
    echo "❌ No Go source found at $GO_CORE_SRC"
    exit 1
  fi
  rm -f "$GO_CORE_BIN" "$GO_CLI_BIN" "$REWIND_BIN" "$TUI_DAEMON_BIN"
  ensure_go_core
  ensure_yha_rewind
  ensure_yha_tui_daemon
  echo ""
  [ "$OWNER_FLAG" = "true" ] \
    && echo "✅ Owner build complete (rebuild module included)" \
    || echo "✅ Public build complete"
  exit 0
fi

# ── go-reload mode: zero-downtime blue-green restart ─────────────────────────
# Mechanism (the simple "pm2 reload + SO_REUSEPORT + SIGUSR2 drain" path):
#
#   1. Verify YHA_REUSEPORT=1 is in the live YHA-Core env. Without it the
#      kernel won't let the new process bind the port and we'd get the
#      same ~1s outage we're trying to eliminate.
#   2. Rebuild the binary if stale (./yha.sh go-build).
#   3. `pm2 reload YHA-Core`. pm2 sends SIGUSR2 to the running process
#      and forks a replacement; both share :8443 via SO_REUSEPORT, so the
#      kernel keeps load-balancing connections through the swap. The old
#      process drains in-flight requests (up to YHA_DRAIN_TIMEOUT_SECONDS,
#      default 30s) and exits 0.
#   4. Health-check the result by hitting /healthz and reading
#      X-Yha-Core-Pid: it must NOT match the pid we recorded before the
#      reload. (kernel may load-balance — we retry a few times.)
#
# pm2 reload was preferred over a custom orchestration (manual fork +
# rename) because rename via `pm2 restart Foo --name Bar` is fragile
# across pm2 versions and a single-process reload is sufficient — the
# kernel does the hard part.
if [[ "$MODE" == "go-reload" ]]; then
  if [ ! -d "$GO_CORE_SRC" ]; then
    echo "❌ No Go source found at $GO_CORE_SRC"
    exit 1
  fi

  # Resolve PM2 if not already set (header didn't run all the way).
  PM2=${PM2:-$(command -v pm2)}
  if [ -z "$PM2" ]; then
    echo "❌ pm2 not found in PATH"
    exit 1
  fi

  # Verify YHA-Core is currently running under pm2.
  if ! $PM2 jlist 2>/dev/null | grep -q '"name":"YHA-Core"'; then
    echo "❌ YHA-Core is not running under pm2 — start it first with ./yha.sh build"
    exit 1
  fi

  # Verify YHA_REUSEPORT=1 in the running process's env. Without it the
  # new process can't bind the port without a stop-the-world gap.
  RUNNING_REUSEPORT=$($PM2 jlist 2>/dev/null \
    | python3 -c 'import json,sys
try:
  for p in json.load(sys.stdin):
    if p.get("name") == "YHA-Core":
      env = p.get("pm2_env", {}).get("env", {}) or p.get("pm2_env", {})
      print(env.get("YHA_REUSEPORT", ""))
      break
except Exception:
  pass' 2>/dev/null)
  if [ "$RUNNING_REUSEPORT" != "1" ]; then
    echo "❌ Live YHA-Core was not started with YHA_REUSEPORT=1."
    echo "   Add it to bridge/.env (or export before launching) and run a"
    echo "   normal ./yha.sh build once. After that, ./yha.sh go-reload"
    echo "   will work for every subsequent deploy with no public-port outage."
    exit 1
  fi

  # Rebuild if stale.
  ensure_go_core
  if [ ! -f "$GO_CORE_BIN" ]; then
    echo "❌ Build did not produce $GO_CORE_BIN"
    exit 1
  fi

  # Snapshot the old PID so we can verify the swap actually happened.
  OLD_PID=$($PM2 jlist 2>/dev/null \
    | python3 -c 'import json,sys
try:
  for p in json.load(sys.stdin):
    if p.get("name") == "YHA-Core":
      print(p.get("pid",""))
      break
except Exception:
  pass' 2>/dev/null)
  echo "→ Old YHA-Core pid: ${OLD_PID:-<unknown>}"

  echo "→ Issuing pm2 reload YHA-Core (SIGUSR2 + SO_REUSEPORT handoff)..."
  if ! $PM2 reload YHA-Core; then
    echo "❌ pm2 reload failed — falling back to a hard restart."
    $PM2 restart YHA-Core || true
    exit 1
  fi

  # Health-check the new process. /healthz advertises X-Yha-Core-Pid;
  # the kernel load-balances under SO_REUSEPORT so a single probe might
  # still hit the draining old process. We poll for up to 30s and accept
  # success once we see ANY response with a pid different from $OLD_PID.
  echo "→ Polling /healthz for the new pid..."
  HEALTH_OK=false
  for i in $(seq 1 30); do
    NEW_PID=$(curl -fsS -m 2 -D - "http://127.0.0.1:${PUBLIC_PORT:-8443}/healthz" 2>/dev/null \
      | awk -F': *' 'tolower($1) == "x-yha-core-pid" {gsub(/[\r\n]/,"",$2); print $2; exit}')
    if [ -n "$NEW_PID" ] && [ "$NEW_PID" != "$OLD_PID" ]; then
      echo "→ New YHA-Core pid: $NEW_PID (after ${i}s)."
      HEALTH_OK=true
      break
    fi
    sleep 1
  done
  if [ "$HEALTH_OK" != "true" ]; then
    echo "⚠ Could not confirm pid swap within 30s. The reload may still be in"
    echo "   progress — check 'pm2 status' and 'curl /healthz -i'."
  fi

  $PM2 save --force >/dev/null
  echo ""
  echo "✅ go-reload complete — public port :${PUBLIC_PORT:-8443} stayed up."
  exit 0
fi

# ── Normal startup (dev / build) ─────────────────────────────────────────────
echo "Starting YHA (mode: $MODE, backend: $BACKEND_MODE, public: $PUBLIC_PORT, node: $NODE_PORT)..."

if [ -z "$BUN" ]; then
  echo "❌ bun not found. Install Bun or add it to PATH (expected: $HOME/.bun/bin/bun)."
  exit 1
fi
if [ -z "$PM2" ]; then
  echo "❌ pm2 not found. Install it with: npm install -g pm2"
  exit 1
fi

# Load env (SESSION_SECRET, WORKOS_*, ANTHROPIC_API_KEY, etc.)
if [ -f "$SCRIPT_DIR/bridge/.env" ]; then
  echo "→ Loading bridge/.env..."
  load_dotenv "$SCRIPT_DIR/bridge/.env"
fi

# Force Node to listen on the right port — overrides whatever bridge/.env says.
export PORT=$NODE_PORT
# Tailscale funnel terminates TLS — backend must be plain HTTP.
export USE_HTTP=true
# Surface the chosen mode + backend to the bridge so /v1/restart can default
# to "same mode I was started in" instead of always falling back to build.
export YHA_MODE="$MODE"
export YHA_BACKEND="$BACKEND_MODE"
# In go-mode the Node bridge sits on :$NODE_PORT behind the Go front door,
# which dials it over loopback. Bind loopback so :$NODE_PORT isn't reachable
# off-host. node-mode leaves this unset → bridge is the front door (0.0.0.0).
if [ "$BACKEND_MODE" = "go" ]; then
  export YHA_BIND_HOST=127.0.0.1
fi

# Build Go core if source exists and stale (only if we're going to need it)
if [ "$BACKEND_MODE" = "go" ]; then
  ensure_go_core
fi
# Rewind service builds in both modes — it reads bridge/rewind/ regardless
# of which front door is up, and is the only thing that can serve recovery
# UI if the bridge itself crashes.
ensure_yha_rewind
# TUI daemon builds in both modes too — it's the operator console host and
# survives across restarts so the user's session reattaches.
ensure_yha_tui_daemon

# Remove old pm2 entries
echo "→ Removing existing YHA processes..."
$PM2 delete YHA 2>/dev/null || true
$PM2 delete YHA-Bridge 2>/dev/null || true
$PM2 delete YHA-Core 2>/dev/null || true
[ "$SKIP_REWIND" = "true" ] || $PM2 delete YHA-Rewind 2>/dev/null || true
$PM2 delete YHA-frontend 2>/dev/null || true

# Kill orphans — scoped to THIS install only.
# `bun server.ts` / `vite` command lines are relative (see bridge/package.json),
# so a bare `pkill -f "bun.*server\.ts"` would also kill unrelated projects on
# the machine — and the old `sudo pkill` did it across every user. Instead we
# confirm each candidate process's working directory is this install's before
# killing it. (Ports are freed precisely by release_port() below regardless.)
kill_orphans_by_cwd() {
  local pattern="$1" want_cwd="$2" pid cwd
  for pid in $(pgrep -f "$pattern" 2>/dev/null); do
    if [ -e "/proc/$pid/cwd" ]; then
      cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null)" || continue
    elif command -v lsof >/dev/null 2>&1; then
      cwd="$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)"
    else
      continue
    fi
    [ "$cwd" = "$want_cwd" ] && kill "$pid" 2>/dev/null || true
  done
}
echo "→ Killing orphaned server processes (this install only)..."
kill_orphans_by_cwd "bun .*server\.ts" "$SCRIPT_DIR/bridge"
kill_orphans_by_cwd "vite" "$SCRIPT_DIR/frontend"
# yha-core is started from its absolute install path, so match that directly.
pkill -f "$SCRIPT_DIR/bin/yha-core" 2>/dev/null || true

# Release the ports we'll need
release_port() {
  local p=$1
  local pids=""
  if command -v lsof >/dev/null 2>&1; then
    pids=$(lsof -tiTCP:"$p" -sTCP:LISTEN 2>/dev/null || true)
  elif command -v ss >/dev/null 2>&1 && ss -tlnp 2>/dev/null | grep -q ":${p} "; then
    command -v fuser >/dev/null 2>&1 && pids=$(fuser "${p}/tcp" 2>/dev/null || true)
  fi
  if [ -n "$pids" ]; then
    echo "→ Port ${p} still bound — forcing release..."
    kill $pids 2>/dev/null || true
    sleep 1
  fi
}
release_port "$PUBLIC_PORT"
[ "$BACKEND_MODE" = "go" ] && release_port "$NODE_PORT"
release_port "$REWIND_PORT"

VITE_PORT=${VITE_PORT:-5173}
export VITE_PORT
if [ "$MODE" = "dev" ]; then
  release_port "$VITE_PORT"
fi

# ── Start frontend + Node bridge ─────────────────────────────────────────────
if [ "$MODE" = "dev" ]; then
  export YHA_USE_DIST=false
  # Single-port dev: the bridge embeds Vite in middleware mode (see
  # bridge/server.ts initViteMiddleware). No separate "YHA" Vite PM2 process
  # is started — that legacy two-port layout had the browser jump from
  # :8443 to :5173 and required Vite to proxy /v1/* back to the bridge,
  # which loops infinitely when both run side-by-side.
  echo "→ Starting bridge in dev mode (bun --watch + embedded Vite) on :${NODE_PORT}..."
  $PM2 start "$BUN" --name "YHA-Bridge" --update-env --cwd "$SCRIPT_DIR/bridge" -- run dev
else
  echo "→ Building frontend with Vite..."
  (cd "$SCRIPT_DIR/frontend" && "$BUN" run build) || {
    echo "❌ Vite build failed"
    exit 1
  }
  echo "→ Frontend build complete."
  export YHA_USE_DIST=true
  echo "→ Starting bridge (production) on :${NODE_PORT}..."
  $PM2 start "$BUN" --name "YHA-Bridge" --update-env --cwd "$SCRIPT_DIR/bridge" -- run start
fi

# ── Start Go core in go-mode ──────────────────────────────────────────────────
if [ "$BACKEND_MODE" = "go" ] && [ -f "$GO_CORE_BIN" ]; then
  # Wait for Node to actually bind :$NODE_PORT before bringing the Go front
  # door up. Node's listen() runs after all synchronous module init, which
  # can take ~15-25s; without this wait, the first browser hit lands in a
  # window where Go is up but Node isn't and the user sees "upstream
  # unavailable". Cap the wait at 60s so a wedged Node still surfaces.
  echo "→ Waiting for Node bridge on :${NODE_PORT}..."
  for i in $(seq 1 60); do
    if curl -fsS -o /dev/null --max-time 1 "http://127.0.0.1:${NODE_PORT}/" 2>/dev/null; then
      echo "→ Node bridge ready after ${i}s."
      break
    fi
    sleep 1
    if [ "$i" = "60" ]; then
      echo "⚠ Node bridge still not responding on :${NODE_PORT} after 60s — starting Go anyway."
    fi
  done

  # Default-on SO_REUSEPORT so `./yha.sh go-reload` works without a
  # separate cold start later. Override with YHA_REUSEPORT=0 if you
  # need to debug a port-binding issue on a stripped kernel.
  : "${YHA_REUSEPORT:=1}"
  export YHA_REUSEPORT

  echo "→ Starting Go core on :${GO_PORT} (proxy → Node :${NODE_PORT}, SO_REUSEPORT=${YHA_REUSEPORT})..."
  $PM2 start "$GO_CORE_BIN" --name "YHA-Core" --update-env -- \
    --port="$GO_PORT" \
    --node-url="http://127.0.0.1:${NODE_PORT}"
elif [ "$BACKEND_MODE" = "go" ]; then
  echo "⚠ go-mode requested but $GO_CORE_BIN not built — falling back to Node-only."
  BACKEND_MODE="node"
fi

# ── Start rewind service ─────────────────────────────────────────────────────
# Independent process, runs in either mode. Lives or dies on its own —
# pm2 will auto-restart it. Reads bridge/rewind/ directly (no HTTP
# dependency on the bridge) so it remains usable when the bridge is down.
# When --skip-rewind is set we leave the already-running instance alone so
# the recover page survives the restart that the rewind service itself
# triggered.
if [ "$SKIP_REWIND" = "true" ]; then
  echo "→ --skip-rewind set, leaving existing YHA-Rewind in place."
elif [ -f "$REWIND_BIN" ]; then
  echo "→ Starting yha-rewind on :${REWIND_PORT}..."
  $PM2 start "$REWIND_BIN" --name "YHA-Rewind" --update-env --cwd "$SCRIPT_DIR" -- \
    --port="$REWIND_PORT" \
    --rewind-dir="$SCRIPT_DIR/bridge/rewind" \
    --repo-root="$SCRIPT_DIR"
else
  echo "⚠ $REWIND_BIN not built — recovery service unavailable."
fi

# ── Start TUI daemon ──────────────────────────────────────────────────────────
# YHA-TUI-Daemon owns the operator console (unix socket at
# bridge/state/yha-tui/daemon.sock) and is intentionally NOT torn down
# in the "Remove old pm2 entries" step above — restarting it would drop
# the user's in-progress jobs and log subscriptions, which is the
# opposite of the "survives SSH disconnects" property the TUI is built
# around. We only (re)start it when missing OR when the binary is newer
# than the running pm2 entry.
if [ -f "$TUI_DAEMON_BIN" ]; then
  if $PM2 jlist 2>/dev/null | grep -q '"name":"YHA-TUI-Daemon"'; then
    echo "→ YHA-TUI-Daemon already registered with pm2 — leaving it running."
  else
    echo "→ Starting YHA-TUI-Daemon..."
    $PM2 start "$TUI_DAEMON_BIN" --name "YHA-TUI-Daemon" --update-env --cwd "$SCRIPT_DIR" || {
      echo "⚠ YHA-TUI-Daemon failed to start — operator-console commands will fall back to error."
    }
  fi
else
  echo "⚠ $TUI_DAEMON_BIN not built — operator-console commands unavailable."
fi

$PM2 save --force >/dev/null

echo ""
if [ "$BACKEND_MODE" = "go" ]; then
  echo "✅ YHA ($MODE, go-mode) — Go on :${PUBLIC_PORT}, Node on :${NODE_PORT}"
else
  echo "✅ YHA ($MODE, node-mode) — Node on :${PUBLIC_PORT}"
fi
echo ""
$PM2 status
$PM2 logs YHA-Bridge --nostream

echo ""
if [ "$MODE" = "dev" ]; then
  echo "============================================="
  echo " DEV mode  —  Live reload active"
  echo "============================================="
  echo "  Live updates (no restart needed):"
  echo "    • frontend/src/**/*  (Vite HMR im Browser, instant)"
  echo "    • bridge/**/*.ts     (bun --watch, Server startet ~1–2s neu)"
  echo ""
  if [ "$BACKEND_MODE" = "go" ]; then
    echo "  Go core: rebuilt automatically when .go files change. Restart:"
    echo "    ./yha.sh restart-core                           # bounce only YHA-Core"
    echo "    ./yha.sh go-reload                              # zero-downtime (blue-green)"
    echo ""
  fi
  echo "  Restart bridge only:   ./yha.sh restart-bridge       # keeps go-core alive (chat survives)"
  echo "  Restart everything:    ./yha.sh restart-all          # full bounce (legacy ./yha.sh dev)"
  echo "  Fall back to legacy:   ./yha.sh dev node"
else
  echo "============================================="
  echo " BUILD mode  —  keine Live-Updates"
  echo "============================================="
  echo "  Frontend wird aus dist/ ausgeliefert (statisch)."
  echo "  Restart bridge only:   ./yha.sh restart-bridge       # keeps go-core alive (chat survives)"
  echo "  Restart everything:    ./yha.sh restart-all          # full bounce (legacy ./yha.sh build)"
  echo "  Fall back to legacy:   ./yha.sh build node"
  if [ "$BACKEND_MODE" = "go" ]; then
    echo "  Restart go-core only:  ./yha.sh restart-core"
    echo "  Force Go rebuild:      ./yha.sh go-build"
    echo "  Zero-downtime reload:  ./yha.sh go-reload"
    [ "$OWNER_FLAG" = "true" ] && echo "  Owner build:           ./yha.sh go-build --owner"
  fi
fi
echo ""
# Tailscale funnel publishes this instance to the PUBLIC INTERNET. Never do
# that implicitly — a first-run contributor running ./yha.sh would otherwise
# expose their local stack (and, if auth is unconfigured, an open bridge).
# Opt in explicitly with YHA_ENABLE_FUNNEL=1.
if [ "${YHA_ENABLE_FUNNEL:-0}" = "1" ]; then
  echo "→ Enabling Tailscale funnel → http://127.0.0.1:${PUBLIC_PORT}..."
  if [ "$(uname -s)" = "Darwin" ]; then
    tailscale funnel --bg "http://127.0.0.1:${PUBLIC_PORT}"
  else
    sudo tailscale funnel --bg "http://127.0.0.1:${PUBLIC_PORT}"
  fi
else
  echo "→ Tailscale funnel NOT enabled (instance is local-only)."
  echo "  To publish this instance to the public internet, re-run with:"
  echo "    YHA_ENABLE_FUNNEL=1 ./yha.sh ${1:-dev}"
fi
