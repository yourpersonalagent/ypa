#!/bin/bash
# =============================================
# Knowledge Memory MCP — one-shot installer
# Adds a hybrid (code-graph + synthesis) MCP
# server to YHA. Idempotent — safe to re-run.
# =============================================
set -e
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# Resolve node when run via sudo
if ! command -v node &>/dev/null; then
  export PATH="/home/user/.nvm/versions/node/v24.15.0/bin:$PATH"
fi

echo "→ Installing dependency-cruiser in bridge/mcp..."
( cd bridge/mcp && npm install ) | tail -3

echo "→ Creating bridge/knowledge skeleton..."
mkdir -p bridge/knowledge/graph
mkdir -p bridge/knowledge/synthesis/{concepts,decisions,summaries}
[ -f bridge/knowledge/synthesis/index.md ] || cat > bridge/knowledge/synthesis/index.md <<'EOF'
# Knowledge Index

Catalog of pages in the YHA synthesis memory. Updated by the LLM on every ingest.

## Concepts

## Decisions

## Summaries
EOF
[ -f bridge/knowledge/synthesis/log.md ] || cat > bridge/knowledge/synthesis/log.md <<'EOF'
# Activity Log

Append-only timeline of ingests, queries, lints, decisions.
Entries follow `## [YYYY-MM-DD] <kind> | <title>` so `grep "^## \[" log.md` lists them.
EOF

echo "→ Registering MCP server in ~/.claude/settings.json..."
SERVER_PATH="$SCRIPT_DIR/bridge/mcp/knowledge-server.js"
node - "$SERVER_PATH" <<'NODE'
const fs = require('fs'), path = require('path');
const SET = path.join(process.env.HOME, '.claude', 'settings.json');
const cfg = fs.existsSync(SET) ? JSON.parse(fs.readFileSync(SET, 'utf8')) : {};
cfg.mcpServers = cfg.mcpServers || {};
cfg.mcpServers['knowledge-memory'] = { command: 'node', args: [process.argv[2]] };
fs.mkdirSync(path.dirname(SET), { recursive: true });
fs.writeFileSync(SET, JSON.stringify(cfg, null, 2));
console.log('  registered:', cfg.mcpServers['knowledge-memory'].args[0]);
NODE

echo "→ Building first code graph (this may take ~10-20s)..."
DEPCRUISE="$SCRIPT_DIR/bridge/mcp/node_modules/.bin/depcruise"
if [ -x "$DEPCRUISE" ]; then
  "$DEPCRUISE" --config .dependency-cruiser.cjs --output-type json \
    bridge/server.ts frontend/src/app.ts \
    > bridge/knowledge/graph/graph.json 2> bridge/knowledge/graph/build.log \
    && echo "  graph: $(wc -c < bridge/knowledge/graph/graph.json) bytes" \
    || echo "  (graph build failed — see bridge/knowledge/graph/build.log; you can retry via build_code_graph from Claude)"
else
  echo "  (depcruise not found — run npm install in bridge/mcp first)"
fi

echo ""
echo "✓ Knowledge Memory MCP installed."
echo "  Restart YHA so the bridge picks it up:  ./yha.sh build"
echo "  Then from Claude: query_code_graph mode=hubs limit=10"
