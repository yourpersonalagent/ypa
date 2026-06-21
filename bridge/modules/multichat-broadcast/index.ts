// multichat-broadcast — bridge module owning the per-employee broadcast
// runner + the leading-@-mention forward chain.
//
// Files moved from bridge/routes/:
//   chat-broadcast.ts → runner.ts   (`runEmployeeInChain`)
//   chat-forward.ts   → forward.ts  (`runForwardMentionChain`)
//
// No Express routes — both helpers are pulled in at request time by
// bridge/routes/chat.ts (the POST /v1/stream handler). The require paths
// in chat.ts have been redirected to this module's files. activate() is
// informational only; the absence of routes means a disabled module
// silently breaks the group/forward branches of POST /v1/stream when
// chat.ts re-requires them via the new path. lifecycle.hot=false because
// chat.ts holds the require() ref on first hit and a hot reload wouldn't
// flush it.
//
// Sibling forward.ts requires runner.ts via './runner' so the two stay
// internally consistent regardless of repo layout.
'use strict';

module.exports = function multichatBroadcastFactory() {
  return {
    activate(ctx: any) {
      // Eager-load both files so a module-disabled state surfaces as a
      // load-time error in the bridge log instead of as a 500 the first
      // time a user starts a group chat.
      const { runEmployeeInChain } = require('./runner');
      const { runForwardMentionChain } = require('./forward');
      ctx.logger.info('multichat broadcast/forward helpers loaded (runEmployeeInChain, runForwardMentionChain)');
      // The activate() return value is stored on the registry handle as
      // `api`; core call-sites in `bridge/routes/chat.ts` look these up
      // via `getModuleApi('multichat-broadcast')` instead of
      // require()ing this file's siblings directly. Disabling this
      // module in modules.json yields `getModuleApi(...) === undefined`
      // so chat.ts can return a clear 501 instead of crashing.
      return {
        name: ctx.name,
        runEmployeeInChain,
        runForwardMentionChain,
      };
    },
    deactivate() {
      // No-op — register entries auto-removed by the loader. Hot
      // reload still requires every external caller to use the api
      // lookup (the migration is in progress; see YHA-modular-status.md).
    },
  };
};
