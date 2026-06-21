// link — LINK / Obsidian Sync routes + worker module.
//
// First real bridge-side module under the modular plan. Owns the five
// `/v1/config/link/*` routes (registerLinkRoutes) and — since the
// Phase-2 batch F context-generator move-out — the LINK *worker* too.
// The LINK worker is the final leg of the ContextGenerator pipeline
// (auto-title → categorizer → sorter → file-categorizer → LINK); the
// sorter chains in via `getModuleApi('link')?.kickLink()` against the
// API object returned from activate(), so a disabled-link bridge is
// a clean no-op rather than a swallowed require throw.
//
// Routes mount on `ctx.app` (the global Express app) instead of
// `ctx.routes` because the URL prefix `/v1/config/link/*` doesn't
// fit the loader's default `/v1/<modulename>` scope, and the
// published API can't move without breaking the frontend's LINK card.
//
// Worker registration goes through `ctx.workers.add()` so the loader
// can clear the 5-min watchdog interval cleanly on deactivate / hot
// reload. lifecycle.hot is still `false` in module.json because the
// route registrations (`ctx.app.get(...)`) cannot be unmounted.
'use strict';

const { registerLinkRoutes } = require('./routes');

interface LinkModuleApi {
  name: string;
  kickLink: () => void;
}

module.exports = function linkFactory() {
  return {
    async activate(ctx: any): Promise<LinkModuleApi> {
      // Routes first — preserves the legacy /v1/config/link/* surface.
      registerLinkRoutes(ctx.app);
      ctx.logger.info('mounted /v1/config/link/* on global app');

      // LINK worker — final leg of the context-generator pipeline.
      // The watchdog runs every 5 min by default; it no-ops if
      // `defaults.contextLink.enabled !== true` or if the adapter is
      // unconfigured. Stop counterpart added in the Phase-2 batch F
      // move so this module's deactivate clears the timer.
      const link = require('./vault/sync');
      link.startLinkWorker();
      ctx.workers.add('link', () => link.stopLinkWorker());

      // Expose kickLink on the module API so upstream pipeline legs
      // (sorter) can edge-trigger us through getModuleApi('link') rather
      // than reaching across module directories with a relative require.
      // When `link` is disabled, getModuleApi returns undefined and the
      // sorter's optional-chain becomes a silent no-op, observable as
      // a "module disabled" state in the registry diagnostics.
      return { name: ctx.name, kickLink: () => link.kickLink() };
    },
    async deactivate(): Promise<void> {
      // No-op — Express has no built-in route removal, so the
      // /v1/config/link/* handlers stay mounted until the bridge
      // restarts. The worker stop is handled via ctx.workers (added
      // in activate()), which the loader runs before this method.
    },
  };
};
