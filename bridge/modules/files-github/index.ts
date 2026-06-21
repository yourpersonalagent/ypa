// files-github — Git integration routes module.
//
// Owns /v1/git/* and /v1/github/* (status, stage/unstage, commit, push,
// PAT storage). Routes mount on `ctx.app` so the published URL prefixes
// stay byte-equivalent to the pre-modular routing.
'use strict';

const { registerGithubRoutes } = require('./lib');

module.exports = function filesGithubFactory() {
  return {
    activate(ctx: any) {
      registerGithubRoutes(ctx.app);
      ctx.logger.info('mounted /v1/git and /v1/github on global app');
      return { name: ctx.name };
    },
    deactivate() {
      // No-op — Express has no built-in route-removal.
      // lifecycle.hot=false in module.json.
    },
  };
};
