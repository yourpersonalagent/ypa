// mcp-servers — catalog of the YHA-owned stdio MCP servers (the .js
// files in bridge/mcp/) registered into the `mcpServers` register.
//
// Why the .js files don't move: absolute paths to bridge/mcp/<name>.js
// are baked into the user-state file bridge/mcp-registry.json. Moving
// them would require a registry rewrite + a coordinated user-config
// migration that's out of scope for this batch. Phase 3 (harnesses
// extraction) is the right time to fully relocate them.
//
// What this module DOES today:
//   - For every YHA-owned MCP server, add an `mcpServers` register
//     entry with id = registry name, command = "node", args = absolute
//     path to the .js. Same shape as mcp-registry.json's entries plus
//     a `kind: 'yha-owned'` tag so future readers can distinguish
//     YHA-owned servers from user-added external upstreams.
//   - Stops the registrations on deactivate via
//     ctx.registers.mcpServers (the loader auto-removes by module).
//
// What this module does NOT do today:
//   - Wire the register back into mcp-client's readUpstreamRegistry().
//     That function still reads bridge/mcp-registry.json directly,
//     which IS the user's source of truth for autostart + materialize.
//     A future patch can teach readUpstreamRegistry to overlay register
//     entries on top of the JSON file. Until then, disabling this
//     module hides the YHA-owned MCPs from any future register-based
//     consumer (none today) but the legacy JSON-based path still sees
//     them — same "atomic ship beats half-done" rule called out in the
//     batch instructions.
//
// MCP-Tools aggregator: the aggregator (modules/mcp-client/lib/bridge.ts)
// re-exposes whatever upstreams are LIVE (mcpConnections from core/state)
// regardless of what's in the register, so this module does not affect
// the aggregator's behaviour. Read-trace verified: bridge.ts iterates
// `mcpConnections` directly; no register lookup.
'use strict';

const path = require('path');

// Ternary audience scope for an MCP server:
//   'all'        — visible to both the main chat (and harnesses) and the pet.
//   'chat-only'  — visible to main / harnesses, hidden from the pet console.
//   'pet-only'   — visible to the pet console only; main / harnesses can't see it.
// The pet module owns the filtering policy in
// bridge/modules/pet/lib/mcp-audience.ts; resolution order at lookup time is
// user override (mcp-state.json) → this catalog's `audienceDefault` → the
// legacy `audience` field on mcp-registry.json → 'all'.
type AudienceDefault = 'all' | 'chat-only' | 'pet-only';

interface YhaMcpServer {
  id: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
  kind: 'yha-owned';
  /** Filename of the .js script (relative to bridge/mcp/), for diagnostics. */
  script: string;
  /** Default audience scope. The user can override per-server via the prefs
   *  MCP tab; that override lives in bridge/mcp-state.json. */
  audienceDefault?: AudienceDefault;
}

// The canonical YHA-owned MCP catalog. Keys MUST match the names in
// bridge/mcp-registry.json so any code that cross-references by id
// (the aggregator's `<server>__<tool>` namespacing, mcp-state.json's
// `running` array, etc.) keeps working.
//
// audienceDefault buckets out of the box:
//   • pet-only — pet-internal (the pet's own world view).
//   • all      — useful to both pet and chat (search, memory, recall).
//   • chat-only — heavy / chat-shaped tools that would just be noise for
//                 the pet's quick-chat. User can flip any of these to
//                 'all' or 'pet-only' from the prefs MCP tab.
const YHA_OWNED_SERVERS: ReadonlyArray<{ id: string; script: string; audienceDefault: AudienceDefault }> = [
  { id: 'media-gen',         script: 'media-server.js',          audienceDefault: 'chat-only' },
  { id: 'code-exec',         script: 'code-server.js',           audienceDefault: 'chat-only' },
  { id: 'playwright-mcp',    script: 'playwright-server.js',     audienceDefault: 'chat-only' },
  { id: 'web',               script: 'desktop-browser-server.js',audienceDefault: 'chat-only' },
  { id: 'notebooklm',        script: 'notebooklm-server.js',     audienceDefault: 'chat-only' },
  { id: 'bash-console',      script: 'bash-console-server.js',   audienceDefault: 'chat-only' },
  { id: 'knowledge-memory',  script: 'knowledge-server.js',      audienceDefault: 'chat-only' },
  { id: 'rclone',            script: 'rclone-server.js',         audienceDefault: 'chat-only' },
  { id: 'data-access',       script: 'data-server.js',           audienceDefault: 'chat-only' },
  { id: 'flat-data',         script: 'flatdata-server.js',       audienceDefault: 'chat-only' },
  { id: 'hermes-skills',     script: 'hermes-skills-server.js',  audienceDefault: 'chat-only' },
  { id: 'websearch',         script: 'websearch-server.js',      audienceDefault: 'all' },
  { id: 'meta-bridge',       script: 'meta-bridge-server.js',    audienceDefault: 'chat-only' },
  { id: 'important',         script: 'important-server.js',      audienceDefault: 'all' },
  { id: 'agent-multichat',   script: 'agent-multichat-server.js',audienceDefault: 'chat-only' },
  { id: 'agent-tools',       script: 'agent-tools-server.js',    audienceDefault: 'chat-only' },
  { id: 'chat-history',      script: 'chat-history-server.js',   audienceDefault: 'all' },
  { id: 'pet-vision',        script: 'pet-vision-server.js',     audienceDefault: 'pet-only' },
];

// Lookup used by bridge/modules/pet/lib/mcp-audience.ts. Returns undefined
// for servers that aren't catalogued (the resolver then falls back to the
// mcp-registry.json `audience` tag or finally 'all').
function getAudienceDefault(serverName: string): AudienceDefault | undefined {
  for (const row of YHA_OWNED_SERVERS) {
    if (row.id === serverName) return row.audienceDefault;
  }
  return undefined;
}

interface McpServersApi {
  name: string;
  registered: number;
}

module.exports = function mcpServersFactory() {
  return {
    activate(ctx: any): McpServersApi {
      // bridge/mcp/ lives at the repo's bridge root: __dirname here is
      // bridge/modules/mcp-servers, so go up two levels to reach bridge/.
      const mcpDir = path.resolve(__dirname, '..', '..', 'mcp');
      let registered = 0;
      const isWindows = process.platform === 'win32';
      for (const { id, script, audienceDefault } of YHA_OWNED_SERVERS) {
        // The desktop-browser MCP has a Windows-specific sibling that runs
        // headed Chromium via Playwright + a CDP screencast (no Docker /
        // KasmVNC). The Linux script also detects the platform at top of
        // file and delegates to the .win variant, so mcp-registry.json can
        // stay platform-agnostic — this picks the right path for the
        // in-memory metadata register, which the prefs UI reads.
        let effectiveScript = script;
        if (isWindows && id === 'web' && script === 'desktop-browser-server.js') {
          effectiveScript = 'desktop-browser-server.win.js';
        }
        const entry: YhaMcpServer = {
          id,
          command: 'node',
          args: [path.join(mcpDir, effectiveScript)],
          kind: 'yha-owned',
          script: effectiveScript,
          audienceDefault,
        };
        ctx.registers.mcpServers.add(entry, ctx.name);
        registered++;
      }
      ctx.logger.info(`registered ${registered} YHA-owned MCP server entries (.js files at ${mcpDir})`);
      return { name: ctx.name, registered };
    },
    deactivate() {
      // Register entries are auto-removed by the loader's
      // removeAllByModule() in ctx.dispose(). lifecycle.hot=false so
      // a hot-reload attempt is rejected — same constraint as the
      // other current modules (Express has no route-removal even
      // though we don't mount routes here, several callers still
      // hold require() refs into bridge/mcp/ scripts).
    },
  };
};

// Attach the audience lookup as a property on the factory export so other
// bridge code can read the catalog defaults without going through the
// module loader registry. The pet audience resolver consults this.
(module.exports as any).getAudienceDefault = getAudienceDefault;
