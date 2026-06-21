// mcp-client — the "client" half of the MCP cluster: registry, stdio
// protocol, discovery, materialize-into-harness-configs, and the
// MCP-Tools aggregator that re-exposes every running upstream MCP as
// one stdio server (via bridge/mcp/yha-bridge-stub.js → POST
// /proxy/mcp-bridge/rpc).
//
// Files moved from bridge/mcp-internal/ to bridge/modules/mcp-client/lib/:
//   state.ts        — readUpstreamRegistry + loadMcpState + externalSharing
//   protocol.ts     — startMcpServer / stopMcpServer / callMcpTool
//   discovery.ts    — buildToolGroups + getToolGroups + cache invalidation
//   routes.ts       — /v1/mcp/*, /v1/bash-console/*, /v1/knowledge/*, /v1/tools/*
//   bridge.ts       — /proxy/mcp-bridge/rpc + /proxy/tool aggregator
//   materialize.ts  — promoteMcpTools(): fan registry into harness configs
//   index.ts        — barrel re-export of state+protocol+discovery+routes
//
// User-state files (bridge/mcp-state.json, bridge/mcp-registry.json)
// stay at the bridge root — they are user intent / cross-restart prefs.
//
// Routes mount on `ctx.app` because the published URLs (/v1/mcp/*,
// /proxy/mcp-bridge/*) can't move without breaking the frontend MCP
// tab and every harness that already has the stub registered.
//
// Worker-stop: the upstream MCP children spawned by `startMcpServer`
// are tracked in `core/state.mcpConnections`. We register a single
// "mcp-children" worker whose stop() walks the map and SIGTERMs each
// process group. This is what `bridge/server.ts`'s graceful-shutdown
// already does inline; we simply expose the same logic via
// `ctx.workers.add()` so a future hot-reload kills children cleanly.
//
// Hook-inversion status (the deepest piece called out in the status
// doc): DEFERRED to Phase 3 (harnesses extraction). materialize.ts
// already iterates `config.defaults.{claudeInstances,codexInstances}`
// — it is data-driven via configDir on each instance, NOT hardcoded
// path lookups. The remaining "fan into the harness register" step
// is meaningful only after Phase 3 declares harness entries with
// their own mcpConfigPath. For now the existing data-driven shape
// is preserved byte-for-byte.
'use strict';

const mcpLib = require('./lib');
const { registerMcpRoutes } = mcpLib;
const { registerMcpBridgeRoutes } = require('./lib/bridge');
const { promoteMcpTools } = require('./lib/materialize');

interface McpClientApi {
  name: string;
  // Surface every cross-bridge call-site needs (server.ts boot,
  // config/handler.ts, tools/exec.ts, search/handler.ts,
  // skills-editor/routes.ts). The lib barrel re-exports all of
  // state.ts + protocol.ts + discovery.ts + routes.ts, so we forward
  // it wholesale and add `promoteMcpTools` from the sibling file.
  startMcpServer: typeof mcpLib.startMcpServer;
  stopMcpServer: typeof mcpLib.stopMcpServer;
  callMcpTool: typeof mcpLib.callMcpTool;
  loadMcpState: typeof mcpLib.loadMcpState;
  readUpstreamRegistry: typeof mcpLib.readUpstreamRegistry;
  invalidateToolGroupsCache: typeof mcpLib.invalidateToolGroupsCache;
  refreshMcpTools?: typeof mcpLib.refreshMcpTools;
  refreshMcpPrompts?: typeof mcpLib.refreshMcpPrompts;
  buildToolGroups: typeof mcpLib.buildToolGroups;
  getToolGroups: typeof mcpLib.getToolGroups;
  promoteMcpTools: typeof promoteMcpTools;
}

module.exports = function mcpClientFactory() {
  return {
    activate(ctx: any): McpClientApi {
      registerMcpRoutes(ctx.app);
      registerMcpBridgeRoutes(ctx.app);

      // Worker-stop: fire SIGTERM at every running upstream MCP child
      // process group so a deactivate / hot-reload doesn't leave
      // orphaned daemons. Mirrors the gracefulShutdown() handler in
      // bridge/server.ts.
      ctx.workers.add('mcp-children', () => {
        try {
          const { mcpConnections } = require('../../core/state');
          for (const [, conn] of mcpConnections) {
            if (!conn?.proc) continue;
            try { process.kill(-conn.proc.pid, 'SIGTERM'); }
            catch (_) {
              try { conn.proc.kill('SIGTERM'); } catch (_) {}
            }
          }
        } catch (e) {
          ctx.logger.warn('mcp-children stop threw:', (e as Error).message);
        }
      });

      // Phase 4 cutover: when YHA_GO_OWNS_MCP=1, mirror Go's MCP state
      // into mcpConnections so existing consumers (frontend MCP tab,
      // telemetry desc-hash lookups, etc.) see the right view. No-op
      // when the flag is unset.
      mcpLib.startGoStatePoller?.();
      ctx.workers.add('mcp-go-state-poller', () => {
        try { mcpLib.stopGoStatePoller?.(); }
        catch (e) { ctx.logger.warn('mcp-go-state-poller stop threw:', (e as Error).message); }
      });

      // Desired-state supervisor: in Node-owned mode (the default) periodically
      // restart any desired-ON MCP server that isn't alive — covers failed
      // startups, idle crashes, and partial reloads, so the declared run-state
      // is self-healing rather than only reconciled at boot. No-op when
      // YHA_GO_OWNS_MCP=1 (Go's own loop owns the pool then).
      mcpLib.startMcpSupervisor?.();
      ctx.workers.add('mcp-supervisor', () => {
        try { mcpLib.stopMcpSupervisor?.(); }
        catch (e) { ctx.logger.warn('mcp-supervisor stop threw:', (e as Error).message); }
      });

      ctx.logger.info('mounted /v1/mcp/*, /v1/bash-console/*, /v1/knowledge/*, /v1/tools/*, /proxy/mcp-bridge/*, /proxy/tool on global app');
      // The activate() return value is stored on the registry handle as
      // `api`. Many cross-bridge callers (server.ts boot,
      // config/handler.ts admin endpoints, tools/exec.ts dispatcher,
      // search/handler.ts surface picker, skills-editor/routes.ts
      // refresh-after-edit) use `getModuleApi('mcp-client')` instead of
      // require()ing './lib' / './lib/materialize' directly. The full
      // lib barrel is forwarded wholesale.
      return {
        name: ctx.name,
        ...mcpLib,
        promoteMcpTools,
      };
    },
    deactivate() {
      // No-op — Express has no built-in route-removal. lifecycle.hot=false
      // in module.json so the loader rejects a hot-reload attempt.
      // Worker-stop is invoked by ctx.dispose() before deactivate() returns.
    },
  };
};
