// files-rclone — general rclone routes module.
//
// Owns /v1/rclone/* (remotes CRUD, browse, sync). Routes mount on
// `ctx.app` because the URL prefix can't move without breaking the
// frontend's RcloneModal rclone half.
'use strict';

const { registerRcloneRoutes } = require('./lib');

module.exports = function filesRcloneFactory() {
  return {
    activate(ctx: any) {
      registerRcloneRoutes(ctx.app);
      ctx.logger.info('mounted /v1/rclone/* on global app');
      return { name: ctx.name };
    },
    deactivate() {
      // No-op — Express has no built-in route-removal.
      // lifecycle.hot=false in module.json.
    },
  };
};
