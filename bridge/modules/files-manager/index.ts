// files-manager — File Manager destructive ops module.
//
// Owns the mutating /v1/files/* surface (mkdir, rename, move, delete,
// upload, trash). The read-only filepicker routes (/v1/files /read
// /write /exists) stay in core because the chat input depends on
// them. Routes mount on `ctx.app` to preserve the URL prefix.
'use strict';

const { registerFileManagerRoutes } = require('./lib');

module.exports = function filesManagerFactory() {
  return {
    activate(ctx: any) {
      registerFileManagerRoutes(ctx.app);
      ctx.logger.info('mounted file-manager mutating routes on global app');
      return { name: ctx.name };
    },
    deactivate() {
      // No-op — Express has no built-in route-removal.
      // lifecycle.hot=false in module.json.
    },
  };
};
