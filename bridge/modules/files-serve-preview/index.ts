// files-serve-preview — REST routes for the per-CWD live-preview tool.
//
// Owns /v1/serve/*. The runtime library (`bridge/files/serve.ts`) stays
// in core because its proxy middleware, WS-upgrade hook, and shutdown
// drain are wired directly into server.ts and can't move without
// breaking the /proxy/serve/:id reverse proxy. This module is the
// REST surface only — same split pattern as the LINK module
// (routes here, worker stays in core).
'use strict';

const { registerServeRoutes } = require('./routes');

module.exports = function filesServePreviewFactory() {
  return {
    activate(ctx: any) {
      registerServeRoutes(ctx.app);
      ctx.logger.info('mounted /v1/serve/* on global app');
      return { name: ctx.name };
    },
    deactivate() {
      // No-op — Express has no built-in route-removal.
      // lifecycle.hot=false in module.json.
    },
  };
};
