// plugins-folder — bridge half of the CWD-scoped visual plugins system.
//
// Discovers <cwd>/.yha-plugins/<plugin>/{plugin.json, tiles/<tile>/...}
// and exposes:
//   GET /v1/plugins?cwd=<path>                       — manifest tree
//   GET /v1/plugins/asset?cwd=&plugin=&tile=&path=   — sandboxed asset bytes
//
// The frontend `plugins-folder` module is the loader; it diffs scan results
// on CWD change and mounts each tile in a sandboxed iframe inside the new
// header section (between cwd and personnel). Hot-swap via filesystem
// watcher + SSE is a follow-up cut — v1 is "refetch on CWD change".
'use strict';

const { registerPluginsRoutes } = require('./routes');

module.exports = function pluginsFolderFactory() {
  return {
    activate(ctx: any) {
      registerPluginsRoutes(ctx.app);
      ctx.logger.info('mounted /v1/plugins and /v1/plugins/asset on global app');
      return { name: ctx.name };
    },
    deactivate() {
      // No-op — Express has no built-in route-removal; same constraint
      // as link / welcome-messages / files-manager. lifecycle.reload=idle-only.
    },
  };
};
