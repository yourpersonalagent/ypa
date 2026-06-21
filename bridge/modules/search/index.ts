// search — bridge-only module owning /v1/search/* routes.
//
// Files moved from bridge/search/ wholesale:
//   handler.ts        — express routes
//   orchestrator.js   — provider-walk logic (also required by
//                       bridge/tools/exec.ts and
//                       bridge/mcp/websearch-server.js — both updated to
//                       require('bridge/modules/search/orchestrator')).
//   search-config.js  — config load/save (path patched to keep
//                       user state file at bridge/search-config.json).
//   search-usage.js   — per-provider counters (same path patch).
//   providers/*.js    — eight provider adapters.
//
// User-state JSON files (search-config.json, search-usage.json) deliberately
// stay at bridge/<file>.json so disabling/re-enabling the module doesn't
// shuffle a user's quota counters.
//
// Routes are mounted on `ctx.app` (the global Express app) instead of
// `ctx.routes` because the published `/v1/search/*` URLs can't move
// without breaking the frontend's Search-tab API client.
'use strict';

const { registerSearchRoutes } = require('./handler');
const orchestrator = require('./orchestrator');
const searchConfig = require('./search-config');
const searchUsage = require('./search-usage');

module.exports = function searchFactory() {
  return {
    activate(ctx: any) {
      registerSearchRoutes(ctx.app);
      ctx.logger.info('mounted /v1/search/* on global app');
      // The activate() return value is stored on the registry handle as
      // `api`. Core call-sites in `bridge/tools/exec.ts` (the WebSearch
      // tool dispatcher) and `bridge/server.ts` (the autostart-MCP
      // search-config probe) use `getModuleApi('search')` instead of
      // require()ing `./orchestrator` / `./search-config` directly.
      // The mcp/websearch-server.js script ALSO requires orchestrator,
      // but that's a child-process script — it stays a direct require
      // because the spawn-by-mcp-client gate already implies search is
      // running.
      return {
        name: ctx.name,
        orchestrator,
        searchConfig,
        searchUsage,
      };
    },
    deactivate() {
      // No-op — Express has no built-in route-removal. lifecycle.hot=false
      // in module.json so the loader rejects a hot-reload attempt.
    },
  };
};
