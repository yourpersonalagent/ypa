// context-generator — chained background workers (auto-title →
// categorizer → sorter → file-categorizer) that build the searchable
// context graph used by the picker, system-prompt budget, and
// (downstream) Obsidian sync.
//
// Phase-2 batch F. The previous bootstrap chain lived in
// `bridge/core/bootstrap-workers.ts` as fire-and-forget
// `start*Worker()` calls — no lifecycle, no way to disable cleanly.
// This module owns all four start/stop pairs and registers each via
// `ctx.workers.add(name, stop)` so the loader's deactivate path can
// clear every interval without leaking timers.
//
// What is *not* in this module:
//   - `bridge/modules/context/` owns the `/v1/context/*` HTTP surface
//     (read-side picker, sensitivity confirm). That module imports
//     `../context-generator/sensitivity` for the detection helpers.
//   - The LINK / vault-sync worker (final pipeline leg) lives in the
//     `link` module because it shares lifecycle with the link routes
//     module (already shipped). The sorter chains into it via
//     `getModuleApi('link')?.kickLink()` against the module registry,
//     so a disabled-link bridge degrades cleanly to a no-op.
//
// Routes for /v1/config/{auto-title,context-categorizer,sorter,
// file-categorizer}/* still mount from `bridge/config/handler.ts`
// (which now `require()`s these modules' libraries). Lifting those
// routes into `ctx.routes` is a follow-up — the URL prefixes are
// published and would need a frontend client adjustment.
//
// `lifecycle.hot=false` in module.json: the `_isRunning` while-loops
// inside each runner re-read `config.defaults.<flag>.enabled` per
// iteration so they wind down on disable, but a *hot* reload would
// also need to bust `require.cache` for `auto-title.ts` / etc., which
// external callers (`bridge/config/handler.ts`, `bridge/routes/chat.ts`,
// `bridge/routes/context-items.ts`) are still pinned to. Phase 6 work.
'use strict';

interface ContextGeneratorApi {
  name: string;
  /** Side-effect hook: nudge the auto-title queue for a session. */
  enqueueForAutoTitle: (sessionId: string) => void;
  /**
   * Each leg is forwarded as a sub-namespace so cross-bridge callers
   * (config/handler.ts admin endpoints, routes/chat.ts auto-title kick)
   * can do `cg.autoTitle.runNow()` etc. without knowing the internal
   * file layout. The shapes are intentionally `any` because the legs
   * are CommonJS modules whose exports aren't typed at this seam yet.
   */
  autoTitle: any;
  contextRag: any;
  categorizer: any;
  sorter: any;
  fileCategorizer: any;
}

module.exports = function contextGeneratorFactory() {
  return {
    activate(ctx: any): ContextGeneratorApi {
      const autoTitle       = require('./auto-title');
      const contextRag      = require('./context-rag');
      const categorizer     = require('./categorizer');
      const sorter          = require('./sorter');
      const fileCategorizer = require('./file-categorizer');

      // Auto-title — leg 1. Watchdog every 3 min; sessions get a
      // title shortly after their first assistant message lands.
      autoTitle.startAutoTitleWorker();
      ctx.workers.add('auto-title', () => autoTitle.stopAutoTitleWorker());
      autoTitle.scanAndEnqueueOnStartup();

      // Context-RAG — leg 2. Vector-DB ingest for sessions / files /
      // knowledge. Reads its own queue (queue.ts); enqueues come from
      // auto-title's end-of-loop chain handoff and from the boot scan.
      // Does NOT gate the categorizer — embedding is a parallel pipeline
      // that just happens to share the LLM rate-budget at runtime.
      contextRag.startContextRagWorker();
      ctx.workers.add('context-rag', () => contextRag.stopContextRagWorker());
      contextRag.scanAndEnqueueOnStartup();

      // Categorizer — leg 3. Chains off auto-title.isClear() — same gate
      // as before. The context-rag leg is parallel, not in series.
      categorizer.startContextCategorizerWorker();
      ctx.workers.add('context-categorizer', () => categorizer.stopContextCategorizerWorker());
      categorizer.scanAndEnqueueOnStartup();

      // Sorter — leg 3. Writes Obsidian-flavoured Markdown into
      // `bridge/users/<email>/docs/generated/` for every categorized session,
      // then chains into LINK (which lives in the link module).
      sorter.startContextSorterWorker();
      ctx.workers.add('context-sorter', () => sorter.stopContextSorterWorker());
      sorter.scanAndEnqueueOnStartup();

      // File-categorizer — leg 4. Sister-process to the session
      // categorizer for imported keep-notes and any future vault
      // folder. Gated behind the session categorizer for LLM
      // rate-budget reasons (its own runner enforces the gate).
      fileCategorizer.startFileCategorizerWorker();
      ctx.workers.add('file-categorizer', () => fileCategorizer.stopFileCategorizerWorker());
      fileCategorizer.scanAndEnqueueOnStartup();

      ctx.logger.info('context-generator workers started (auto-title, context-rag, categorizer, sorter, file-categorizer)');
      // The activate() return value is stored on the registry handle as
      // `api`. Core call-sites in `bridge/routes/chat.ts` (the
      // enqueue-after-stream side-effect) and `bridge/config/handler.ts`
      // (~25 administrative POST endpoints for the four pipeline legs)
      // use `getModuleApi('context-generator')` instead of require()ing
      // these files directly. Disabling this module makes the admin
      // routes 501 cleanly and silences the auto-title enqueue.
      //
      // Each leg is exposed as its own sub-namespace so the typing
      // matches the today's call-site shape (`leg.runNow`, `leg.skipStuck`,
      // `leg.getDebugInfo`, etc.) and migration is mechanical:
      //   require('../modules/context-generator/auto-title').runNow
      //     → getModuleApi('context-generator')?.autoTitle.runNow
      return {
        name: ctx.name,
        enqueueForAutoTitle: autoTitle.enqueueForAutoTitle,
        autoTitle,
        contextRag,
        categorizer,
        sorter,
        fileCategorizer,
      };
    },
    async deactivate(): Promise<void> {
      // No-op — every worker registered a stop via ctx.workers.add(),
      // and the loader runs those in reverse order on disable. The
      // module's external callers (config/handler.ts requires) keep
      // working at module level because the libraries themselves
      // remain in require.cache; only their watchdog timers stop.
    },
  };
};
