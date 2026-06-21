// files-ftp — FTP routes module.
//
// Owns /v1/ftp/* (connections CRUD, dir mappings, import-ini, sync, browse,
// test-connection). Routes mount on `ctx.app` because the URL prefix can't
// move without breaking the frontend's RcloneModal FTP half.
//
// initFtp() loads connections + dir mappings from disk; it's a one-shot
// fire-and-forget call with no associated stop counterpart, so we don't
// register a worker.
'use strict';

const { registerFtpRoutes, initFtp } = require('./lib');

module.exports = function filesFtpFactory() {
  return {
    activate(ctx: any) {
      registerFtpRoutes(ctx.app);
      initFtp();
      ctx.logger.info('mounted /v1/ftp/* on global app');
      return { name: ctx.name };
    },
    deactivate() {
      // No-op — Express has no built-in route-removal and initFtp() has no
      // open handles to close. lifecycle.hot=false in module.json so the
      // loader rejects a hot-reload attempt.
    },
  };
};
