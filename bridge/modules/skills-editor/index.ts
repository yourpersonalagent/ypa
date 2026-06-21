// skills-editor — bridge module owning the SKILL.md editor + persistence
// half of the meta-bridge feature.
//
// Files moved from bridge/meta/:
//   lib.js          — storage layout, frontmatter parsing, mount-state.
//                     Still consumed by
//                     bridge/modules/observability-plus/debug.ts and by
//                     bridge/mcp/meta-bridge-server.js (the MCP child),
//                     both updated to require the new path.
//   routes.ts       — /v1/meta/* Express routes (was bridge/meta/bridge.ts).
//   _state.json     — `{ mounted: { skills, tools }, version }` per-install
//                     state. Lives next to lib.js because META_DIR =
//                     __dirname; the file moves with the module.
//   bridge/skills/  — google-workspace, hermeshub, … one dir per SKILL.md
//                     (shared across users; the 2026-05-25 migration
//                     consolidated all per-user copies here).
//
// The MCP-server side (bridge/mcp/meta-bridge-server.js) stays in
// bridge/mcp/ for now and just gets its require path updated. It moves
// into the future `mcp-servers` module in a follow-up batch.
//
// Routes mount on `ctx.app` (the global Express app) because the
// published /v1/meta/* URLs are consumed by the prefs UI's skills tab
// and can't move without a frontend change.
'use strict';

const meta = require('./lib');
const { registerMetaBridgeRoutes } = require('./routes');

module.exports = function skillsEditorFactory() {
  return {
    activate(ctx: any) {
      registerMetaBridgeRoutes(ctx.app);
      ctx.logger.info('mounted /v1/meta/* on global app');
      // The activate() return value is stored on the registry handle
      // as `api`. observability-plus/debug.ts uses
      // `getModuleApi('skills-editor')?.lib` to enrich its diagnostic
      // dumps; mcp/meta-bridge-server.js continues to require ./lib
      // directly because it's a child-process script (out-of-band of
      // the loader).
      return {
        name: ctx.name,
        lib: meta,
      };
    },
    deactivate() {
      // No-op — Express has no built-in route-removal. lifecycle.hot=false
      // in module.json so the loader rejects a hot-reload attempt. Other
      // bridge files (observability-plus/debug.ts, mcp/meta-bridge-server.js)
      // hold require() refs into ./lib that survive a reload regardless.
    },
  };
};
