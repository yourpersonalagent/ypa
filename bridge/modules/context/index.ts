// context — bridge module owning the /v1/context/* read + sensitivity surface.
//
// Files moved from bridge/routes/:
//   routes-items.ts        — /v1/context/items + /v1/context/file (read side)
//   routes-sensitivity.ts  — /v1/context/items/:id/sensitivity, confirm/whitelist
//
// User-state files (bridge/important-memory.json, bridge/cwd-context-memory.json)
// stay at the bridge root — they're owned by registerImportantRoutes /
// registerCwdContextRoutes (routes/important.ts + routes/cwd-context.ts),
// backed by bridge/context/global.ts + bridge/context/cwd.ts. This module
// only owns the /v1/context/* read + override surface.
//
// REPO_ROOT in routes-items.ts is anchored via __dirname; the move from
// bridge/routes/ → bridge/modules/context/ added one level so the resolve()
// climbs three '..' instead of two. Cross-module requires (core/state,
// sessions-internal/persistence, features/triggers, context-generator/sensitivity,
// context-generator/sorter) get one extra '..' for the same reason.
//
// Routes mount on `ctx.app` (the global Express app) because the published
// /v1/context/* URLs can't move without breaking the QuickContextPicker +
// ContextHub frontend. Same migration-exit-hatch reasoning as link / todos.
'use strict';

const { registerContextItemRoutes } = require('./routes-items');
const { registerContextSensitivityRoutes } = require('./routes-sensitivity');

module.exports = function contextFactory() {
  return {
    activate(ctx: any) {
      registerContextItemRoutes(ctx.app);
      registerContextSensitivityRoutes(ctx.app);
      ctx.logger.info('mounted /v1/context/* (items + file + sensitivity) on global app');
      return { name: ctx.name };
    },
    deactivate() {
      // No-op — Express has no built-in route-removal. lifecycle.hot=false
      // in module.json so the loader rejects a hot-reload attempt.
    },
  };
};
