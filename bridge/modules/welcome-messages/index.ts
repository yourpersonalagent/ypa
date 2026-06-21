// welcome-messages — bridge half of the holiday/themed greeting
// system. Loads the .md banks under data/ once at activate-time and
// serves them at /v1/greetings (read-only) + /v1/greetings/reload
// (cache-bust for mid-runtime edits). Routes mount on `ctx.app`
// because the published `/v1/greetings` URL prefix can't move
// without breaking the frontend's empty-chat fetch.
'use strict';

const { loadGreetings, registerGreetingsRoutes } = require('./lib');

module.exports = function welcomeMessagesFactory() {
  return {
    activate(ctx: any) {
      // loadGreetings() is normally called inside registerGreetingsRoutes()
      // on first request, but doing it here makes the boot log line
      // ("[greetings] loaded N generic banks, M themed dates …") fire
      // at module-activate time so an empty data/ folder produces an
      // immediate "0 generic banks" warning instead of a silent
      // fallback on first GET.
      loadGreetings();
      registerGreetingsRoutes(ctx.app);
      ctx.logger.info('mounted /v1/greetings and /v1/greetings/reload on global app');
      return { name: ctx.name };
    },
    deactivate() {
      // No-op for the same reason as the link module: Express has
      // no built-in route-removal. lifecycle.hot=false in
      // module.json so the loader rejects a hot-reload attempt.
    },
  };
};
