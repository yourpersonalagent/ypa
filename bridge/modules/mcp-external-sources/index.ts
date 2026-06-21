// mcp-external-sources — the external counterpart to mcp-servers.
//
// mcp-servers   = the shipped, YHA-owned internal MCP catalog (kind: 'internal').
// mcp-external-sources = user-added third-party / external MCP servers
//                        (kind: 'external'), stored in the gitignored
//                        bridge/mcp-external-sources.json.
//
// Division of labour with mcp-client (the host/gateway/transport):
//   • This module OWNS the external source definitions: CRUD + import +
//     (future) registry discovery, exposed at /v1/mcp/sources/*.
//   • mcp-client OWNS lifecycle + transport + the MCP-Tools aggregator. Its
//     readUpstreamRegistry() reads bridge/mcp-external-sources.json DIRECTLY
//     and merges it with the internal registry — so external sources get
//     start/stop, supervisor self-heal, audience filtering, and aggregation
//     into MCP-Tools for free, with no cross-module require here.
//
// Because the merge lives in mcp-client (not a register this module owns),
// disabling this module hides the /v1/mcp/sources/* CRUD UI but mcp-client
// still reads any sources already on disk — same "the file is the seam"
// contract mcp-servers documents for its legacy JSON path.
'use strict';

const { registerExternalSourceRoutes } = require('./lib/routes');
const store = require('./lib/store');

module.exports = function mcpExternalSourcesFactory() {
  return {
    activate(ctx: any) {
      registerExternalSourceRoutes(ctx.app);
      ctx.logger.info('mounted /v1/mcp/sources/* on global app');
      return {
        name: ctx.name,
        listSources: store.listSources,
        getSource: store.getSource,
        addSource: store.addSource,
        updateSource: store.updateSource,
        deleteSource: store.deleteSource,
        parseImport: store.parseImport,
      };
    },
    deactivate() {
      // No-op — Express has no built-in route-removal; ctx.app proxy splices
      // our layers out on dispose. lifecycle.reload=idle-only below.
    },
  };
};
