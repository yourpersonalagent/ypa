// observability-plus — cost / token / debug / telemetry bridge module.
//
// Files moved from bridge/observability/ (raw-logs.ts intentionally
// stays in core — see module.json description):
//   costs.ts      — recordCost + loadCosts + /v1/costs/* routes
//   tokens.ts     — recordTokens + loadTokens helpers
//   debug.ts      — debug snapshot generator + monitoring-log writer
//   telemetry.ts  — record() + lifetime counters + /v1/telemetry surface
//
// User-state files (bridge/costs.json, bridge/tokens.json,
// bridge/telemetry/, bridge/monitoring-log/, bridge/last-exit.json)
// stay outside the module dir so a disable-then-enable cycle preserves
// counters.
//
// External callers updated to require('../modules/observability-plus/…')
// instead of '../observability/…': tools/exec.ts, sessions-internal/streams.ts,
// routes/sessions.ts, providers/special.ts, meta/bridge.ts, context/global.ts,
// mcp-internal/protocol.ts, features/{todos,workflow-runner}.ts, server.ts.
//
// Routes mount on `ctx.app` (the global Express app) because
// /v1/costs/* and /v1/telemetry are published URLs that can't move.
'use strict';

const costsLib = require('./costs');
const tokensLib = require('./tokens');
const telemetryLib = require('./telemetry');
const debugLib = require('./debug');

module.exports = function observabilityPlusFactory() {
  return {
    activate(ctx: any) {
      costsLib.registerCostRoutes(ctx.app);
      ctx.logger.info('mounted /v1/costs/* on global app (telemetry + debug exposed via getModuleApi)');
      // The activate() return value is stored on the registry handle as
      // `api`. Core call-sites in `bridge/server.ts` (route-level
      // telemetry middleware + /v1/telemetry endpoints),
      // `bridge/sessions-internal/streams.ts` (recordCost/recordTokens),
      // `bridge/providers/special.ts` (debug command runner), and
      // `bridge/routes/sessions.ts` (debug registry) use
      // `getModuleApi('observability-plus')` instead of require()ing
      // `./modules/observability-plus/<file>` directly.
      //
      // Sub-namespaces match the per-file exports so call-site rewrites
      // are mechanical:
      //   require('../modules/observability-plus/telemetry').record(...)
      //     → getModuleApi('observability-plus')?.telemetry.record(...)
      return {
        name: ctx.name,
        recordCost: costsLib.recordCost,
        loadCosts: costsLib.loadCosts,
        clearCosts: costsLib.clearCosts,
        flushCosts: costsLib.flushPending,
        recordTokens: tokensLib.recordTokens,
        loadTokens: tokensLib.loadTokens,
        clearTokens: tokensLib.clearTokens,
        flushTokens: tokensLib.flushPending,
        telemetry: telemetryLib,
        debug: debugLib,
      };
    },
    deactivate() {
      // Flush any pending in-memory cost/token deltas before the module
      // unloads — the debounce timer holds them in RAM only.
      try { costsLib.flushPending?.(); } catch (_) {}
      try { tokensLib.flushPending?.(); } catch (_) {}
      // No-op for routes — Express has no built-in route-removal.
      // lifecycle.hot=false in module.json. Register entries (none here)
      // auto-removed by the loader. After the call-site migration
      // completes (Phase-6 follow-up), disabling this module will silence
      // the route-level telemetry middleware and 501 the /v1/telemetry
      // endpoints because server.ts will use getModuleApi() lookups.
    },
  };
};
