// workflows-and-triggers — bridge module owning the trigger / workflow /
// workflow-runner trio.
//
// Files moved from bridge/features/:
//   triggers.ts         — Trigger persistence + heartbeats + SSE +
//                         /v1/triggers* routes; broadcasts events that
//                         drive the timer / new-data / event triggers.
//                         Other modules require it for `broadcastEvent`.
//   workflows.ts        — File-backed workflow graphs + /v1/workflows*
//                         routes; exposes `findWorkflow` for the runner.
//   workflow-runner.ts  — Headless server-side workflow execution. Topo
//                         sorts the graph and invokes hash-tools.
//
// Data dirs (live user state — files written mid-runtime):
//   bridge/triggers/*.md   — stays at bridge root; lib resolves it via
//                            `path.join(__dirname, '..', '..', 'triggers')`.
//   bridge/workflows/*.md  — same.
//
// External callers updated to require('../modules/workflows-and-triggers/triggers')
// instead of '../features/triggers':
//   - bridge/context/auto-title.ts
//   - bridge/context/categorizer/runner.ts
//   - bridge/context/file-categorizer/runner.ts
//   - bridge/context/sorter/runner.ts
//   - bridge/context/vault/sync-runner.ts
//   - bridge/modules/context/routes-sensitivity.ts
//   - bridge/server.ts (the require + register-call lines).
//
// Worker lifecycle: initTriggers() and initWorkflows() each start a
// fs.watch on their data dir + (for triggers) timer setIntervals.
// stopTriggers() / stopWorkflows() are registered via ctx.workers.add()
// so the loader calls them cleanly on deactivation or bridge shutdown.
//
// Routes mount on `ctx.app` (the global Express app) because the
// published /v1/triggers* and /v1/workflows* URLs can't move without
// breaking the frontend's Triggers + Workflow Picker panels.
'use strict';

const { init: initTriggers, stopTriggers, registerTriggerRoutes } = require('./triggers');
const { init: initWorkflows, stopWorkflows, registerWorkflowRoutes } = require('./workflows');

module.exports = function workflowsAndTriggersFactory() {
  return {
    activate(ctx: any) {
      registerTriggerRoutes(ctx.app);
      initTriggers();
      ctx.workers.add('triggers', stopTriggers);
      registerWorkflowRoutes(ctx.app);
      initWorkflows();
      ctx.workers.add('workflows', stopWorkflows);
      ctx.logger.info('mounted /v1/triggers* + /v1/workflows* on global app; watchers + timers running');
      return { name: ctx.name };
    },
    deactivate() {
      // Workers registered via ctx.workers.add() are called automatically
      // by the loader on deactivation. No-op here.
    },
  };
};
