// Background worker bootstrap.
//
// Phase 0 of the modular migration extracted six `start*Worker()`
// calls out of inline `server.ts` blob. Phase-2 batch F (this round)
// moved five of them into modules:
//
//   • auto-title, categorizer, sorter, file-categorizer →
//     `bridge/modules/context-generator/index.ts:activate(ctx)`,
//     each registered via `ctx.workers.add(name, stop)` so the loader
//     teardown clears every interval cleanly.
//   • LINK / vault-sync → `bridge/modules/link/index.ts:activate(ctx)`,
//     same `ctx.workers.add()` lifecycle. The sorter chains into it
//     via cross-module require.
//
// What is left here is the one worker that genuinely belongs to core
// (it cleans in-memory session state for every harness, regardless of
// which modules are loaded): `startSessionCleanupInterval`. Once an
// owning module exists for sessions cleanup it can move out too; for
// now it stays so the loader keeps booting in the same order.
'use strict';

interface BootstrapDeps {
  /** Optional logger; falls back to `console`. */
  logger?: { info?: (...a: any[]) => void; warn?: (...a: any[]) => void };
}

/**
 * Start the core background workers (today: just sessions cleanup).
 * Called exactly once after `server.listen()`. Idempotent at the
 * function-call level — each underlying worker guards its own
 * `setInterval`.
 */
function startBackgroundWorkers(_deps: BootstrapDeps = {}): void {
  // Sessions cleanup — runs every 60s, no-ops if nothing to clean.
  const { startSessionCleanupInterval } = require('../sessions-internal');
  startSessionCleanupInterval();
}

module.exports = { startBackgroundWorkers };
