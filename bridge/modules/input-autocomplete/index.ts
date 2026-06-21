// input-autocomplete — bridge module owning /v1/input-autocomplete/* routes.
//
// Mirrors chat-extras: routes mount on the global Express app (the URL prefix
// is published to the frontend module). Disabling this module 404s the
// suggest endpoint; the frontend hook fails its fetch silently and clears
// the ghost overlay.
'use strict';

const { registerRoutes } = require('./handler');

module.exports = function inputAutocompleteFactory() {
  return {
    activate(ctx: any) {
      registerRoutes(ctx.app);
      ctx.logger.info('mounted /v1/input-autocomplete/* on global app');
      return { name: ctx.name };
    },
    deactivate() {
      // No-op — Express has no built-in route-removal. lifecycle.hot=false
      // in module.json so the loader rejects a hot-reload attempt.
    },
  };
};
