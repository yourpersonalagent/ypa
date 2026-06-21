#!/usr/bin/env bash
# Creates a timestamped zip of all chat session sources before import.
# Reads paths from environment (YHA_HOME, HOME); falls back to common defaults.

set -euo pipefail

# YHA install root — defaults to the script's parent project. Override with YHA_HOME=...
YHA_HOME="${YHA_HOME:-$(cd "$(dirname "$0")/.." && pwd)}"
HOME_DIR="${HOME:-$(getent passwd "$(id -un)" | cut -d: -f6)}"

# Per-user source locations — override per env if your layout differs.
CLAUDE_PROJECTS_DIR="${CLAUDE_PROJECTS_DIR:-$HOME_DIR/.claude/projects}"
CODEX_SESSIONS_DIR="${CODEX_SESSIONS_DIR:-$HOME_DIR/.codex-config/sessions}"
VSCODE_INSIDERS_DIR="${VSCODE_INSIDERS_DIR:-$HOME_DIR/.vscode-server-insiders/data/User/workspaceStorage}"

TIMESTAMP=$(date +%Y%m%d-%H%M%S)
OUTDIR="$YHA_HOME/bridge/backups"
OUTFILE="$OUTDIR/sessions-backup-$TIMESTAMP.zip"

mkdir -p "$OUTDIR"

echo "Backing up sessions → $OUTFILE"

COPILOT_FILES=""
if [ -d "$VSCODE_INSIDERS_DIR" ]; then
  COPILOT_FILES=$(find "$VSCODE_INSIDERS_DIR" \
    -path "*/GitHub.copilot-chat/transcripts/*.jsonl" 2>/dev/null || true)
fi

ZIP_INPUTS=()
[ -d "$CLAUDE_PROJECTS_DIR" ] && ZIP_INPUTS+=("$CLAUDE_PROJECTS_DIR")
[ -d "$CODEX_SESSIONS_DIR" ]  && ZIP_INPUTS+=("$CODEX_SESSIONS_DIR")
[ -d "$YHA_HOME/bridge/sessions" ] && ZIP_INPUTS+=("$YHA_HOME/bridge/sessions")

if [ ${#ZIP_INPUTS[@]} -eq 0 ]; then
  echo "No session sources found. Set YHA_HOME / CLAUDE_PROJECTS_DIR / CODEX_SESSIONS_DIR." >&2
  exit 1
fi

zip -r "$OUTFILE" "${ZIP_INPUTS[@]}" --quiet

if [ -n "$COPILOT_FILES" ]; then
  echo "$COPILOT_FILES" | zip "$OUTFILE" -@ --quiet
fi

SIZE=$(du -sh "$OUTFILE" | cut -f1)
echo "Done. Backup size: $SIZE"
echo "Restore: unzip -o $OUTFILE -d /"
