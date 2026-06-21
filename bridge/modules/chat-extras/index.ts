// chat-extras — slimmed bridge module owning drafts + input-history.
//
// Files moved from bridge/routes/ wholesale:
//   drafts.ts         — /v1/drafts/current GET/PUT/DELETE (server-side
//                       autosave for the chat input textarea)
//   input-history.ts  — /v1/input-history GET/POST/DELETE/merge
//                       (the up-arrow recall stack)
//
// User-state JSON files stay outside the module dir so a disable-then-enable
// cycle preserves them. Drafts are still legacy bridge/draft.json; input
// history is request-scoped under bridge/users/<email>/input-history.json
// (with bridge/input-history.json read only as a migration seed).
//
// Routes mount on `ctx.app` (the global Express app) because the
// published `/v1/drafts/*` and `/v1/input-history/*` URLs can't move
// without breaking the frontend's chat-input client.
//
// Per registers-doc §4 this module is "drafts + input-history only" —
// welcome-messages, todos, pet-console all moved to their own modules
// in earlier rounds.
'use strict';

const { registerDraftRoutes } = require('./drafts');
const { registerInputHistoryRoutes } = require('./input-history');

module.exports = function chatExtrasFactory() {
  return {
    activate(ctx: any) {
      registerDraftRoutes(ctx.app);
      registerInputHistoryRoutes(ctx.app);
      ctx.logger.info('mounted /v1/drafts/* and /v1/input-history/* on global app');
      return { name: ctx.name };
    },
    deactivate() {
      // No-op — Express has no built-in route-removal. lifecycle.hot=false
      // in module.json so the loader rejects a hot-reload attempt.
    },
  };
};
