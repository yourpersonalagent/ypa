// todos — per-WD task list module.
//
// Owns the /v1/todos* routes (was bridge/features/todos.ts) plus the
// readTodos/writeTodos/rememberLabel/listAllCwds library functions,
// which bridge/tools/exec.ts pulls in for the TodoWrite / TodoRead
// tool calls. Routes mount on `ctx.app` (the global Express app) so
// the published /v1/todos URL prefix stays byte-equivalent to the
// pre-modular routing — same exit-hatch reasoning as the link module.
//
// What is *not* in this module yet (deferred from registers-doc §6
// worked example):
//   - The session-picker `belowSessions` slot rewrite. Today's
//     ProjectsPanel.tsx renders todos inline via `useTodoStore`; the
//     store now lives in `frontend/src/modules/todos/todoStore.ts`
//     and ProjectsPanel imports from there. Turning that inline
//     render into a `<SessionPickerSlot region="belowSessions" />`
//     fill is the next batch (it touches ~70 LOC inside
//     ProjectsPanel and a slot host that doesn't exist yet).
//   - The CWD-dropdown `cwdDropdownEntries` register entry —
//     same shape as the slot rewrite; deferred together.
//   - The cwd-scoped MCP server (`todos.cwd-mcp` per registers-doc
//     §6). The MCP-Tools aggregator already exposes TodoWrite /
//     TodoRead through the bridge tool path, so a separate
//     per-CWD MCP server is additive — not blocking this lift.
'use strict';

const todosLib = require('./lib');
const { registerTodoRoutes, readTodos, writeTodos, rememberLabel, listAllCwds } = todosLib;

interface TodosModuleApi {
  /** For diagnostics / introspection only. */
  name: string;
  readTodos: typeof readTodos;
  writeTodos: typeof writeTodos;
  rememberLabel: typeof rememberLabel;
  listAllCwds: typeof listAllCwds;
}

module.exports = function todosFactory() {
  return {
    activate(ctx: any): TodosModuleApi {
      registerTodoRoutes(ctx.app);
      ctx.logger.info('mounted /v1/todos* on global app');
      // The activate() return value is stored on the registry handle as
      // `api`. Core call-sites in `bridge/tools/exec.ts` (the
      // TodoWrite/TodoRead tool dispatcher) use
      // `getModuleApi('todos')` instead of require()ing './lib'
      // directly. Disabling this module makes the TodoWrite/TodoRead
      // tools no-op gracefully.
      return {
        name: ctx.name,
        readTodos,
        writeTodos,
        rememberLabel,
        listAllCwds,
      };
    },
    deactivate() {
      // No-op — Express has no built-in route-removal; same constraint
      // as the link / welcome-messages modules. lifecycle.hot=false in
      // module.json so the loader rejects a hot-reload attempt.
    },
  };
};
