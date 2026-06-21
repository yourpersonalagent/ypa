// knowledge — placeholder bridge module.
//
// Today the *data* (knowledge bucket — dirs/, index.json) and the
// *consumer* (bridge/mcp/knowledge-server.js, an MCP stdio child) both
// live outside this module. The data root is resolved through
// bridge/core/paths.ts:knowledgeRoot, which routes per-user via the
// Q16 resolver — pre-migration it's bridge/knowledge/, post-migration
// bridge/users/<email>/knowledge/.
//
// This module exists so that:
//   1. modules.json reserves the `knowledge` slot — when Phase 2
//      relocates the MCP child into bridge/modules/mcp-servers/, both
//      the data and the consumer can move into bridge/modules/knowledge/
//      together without a second modules.json edit.
//   2. The loader's "kind=bridge with no routes + no workers" code
//      path is exercised, validating that behavior-less modules don't
//      break anything (failure-isolation test on the loader's
//      registry.set('active') branch).
'use strict';

module.exports = function knowledgeFactory() {
  return {
    activate(ctx: any) {
      ctx.logger.info('knowledge module active (placeholder — data at bridge/knowledge/)');
      return { name: ctx.name };
    },
    deactivate() {
      // No-op — nothing to tear down.
    },
  };
};
