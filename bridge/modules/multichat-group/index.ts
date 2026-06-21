// multichat-group — bridge module managing agentic multichat groups.
//
// A multichat group is N permanent sibling sessions sharing a turn cursor.
// Each slot owns its own member session; the orchestrator fans out inputs
// to all slots in parallel. Supports direct-execute and plan-mode (plan →
// decide → execute). Group records persist to bridge/sessions/groups/.
//
// No external process lifecycle (no subprocess to stop). lifecycle.hot=false
// because routes mount on ctx.app and runEmployeeInChain is required at
// request time from multichat-broadcast, which is not hot-reloadable.
'use strict';

const { registerGroupRoutes } = require('./routes');
const { loadGroupsFromDisk } = require('./groups');

module.exports = function multichatGroupFactory() {
  return {
    activate(ctx: any) {
      loadGroupsFromDisk();
      registerGroupRoutes(ctx.app);
      ctx.logger.info('multichat-group: routes mounted, groups loaded');
      return { name: ctx.name };
    },
    deactivate() {
      // No-op — Express has no built-in route-removal. lifecycle.hot=false.
    },
  };
};
