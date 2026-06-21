// cwd-manager — bridge module entry.
//
// activate() wires three things and returns a small api for other modules:
//   1. persistent per-CWD state in ctx.dataDir/state.json
//   2. the adaptive heartbeat scheduler (registered as a ctx worker so the
//      loader stops it on deactivate/hot-reload)
//   3. the /v1/cwd-manager/* routes on ctx.routes
//
// Programmatic ticks classify mode + whether an agent tick is warranted.
// LLM-backed manager ticks are implemented but explicitly opt-in per CWD via
// `agentEnabled`; worker-chat spawning remains a later phase.
'use strict';

const { createStore } = require('./state');
const { createScheduler } = require('./scheduler');
const { registerRoutes } = require('./routes');

interface CwdManagerApi {
  name: string;
  /** Wake one CWD with an immediate programmatic tick (e.g. after a todo edit). */
  wakeCwd(cwd: string): Promise<unknown>;
  /** Current snapshot for a CWD (default if not tracked). */
  getStatus(cwd: string): unknown;
  /** Soft hook other modules may call when a CWD's todos change. */
  onTodoChanged(cwd: string): void;
}

module.exports = function cwdManagerFactory() {
  return {
    activate(ctx: any): CwdManagerApi {
      const store = createStore(ctx.dataDir);
      const scheduler = createScheduler({ store, ctx });

      registerRoutes({ router: ctx.routes, store, scheduler, logger: ctx.logger });

      scheduler.start();
      ctx.workers.add('cwd-manager-scheduler', () => scheduler.stop());

      const monitored = store.list().filter((e: any) => e.enabled).length;
      ctx.logger.info(`mounted /v1/cwd-manager (${store.list().length} tracked, ${monitored} active)`);

      return {
        name: ctx.name,
        wakeCwd(cwd: string) {
          return scheduler.tickNow(cwd);
        },
        getStatus(cwd: string) {
          return store.ensure(cwd);
        },
        onTodoChanged(cwd: string) {
          // Fire-and-forget: a todo edit should bump the CWD promptly if tracked.
          const entry = store.get(cwd);
          if (entry?.enabled) scheduler.tickNow(cwd).catch(() => {});
        },
      };
    },
    deactivate() {
      // Scheduler is stopped via the registered ctx worker; routes are spliced
      // out of the Express stack by the context's dispose(). Nothing else to do.
    },
  };
};
