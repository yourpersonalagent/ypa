// multichat-personnel — bridge module owning the internal-employee
// roster: /v1/employees/* routes, the in-memory employee map, and the
// on-disk bridge/employees/<id>.md persistence.
//
// Files moved from bridge/features/:
//   employees.ts — CRUD + raw-MD-edit routes, frontmatter parser,
//                  loadFromDisk(), seeds standard `ceodave` on first
//                  boot.
//
// Data dir (live user state — files written mid-runtime):
//   bridge/employees/<id>.md — stays at bridge root; resolved via
//   path.join(__dirname, '..', '..', 'employees') so the location is
//   independent of the module's own folder.
//
// External callers updated to require('../modules/multichat-personnel/employees')
// instead of '../features/employees':
//   - bridge/server.ts
//   - bridge/routes/sessions.ts
//   - bridge/chat/helpers.ts
//
// participantKinds register: declares the `employee` kind with a
// resolve(id) → employee record + a send() shim that errors out
// (actual send goes through chat-broadcast's runEmployeeInChain — the
// register entry exists so consumers can list which kinds are live).
// Loader auto-removes the entry on deactivate.
//
// Worker lifecycle: init() does loadFromDisk() — synchronous, no
// timers/watchers. There's nothing to stop. lifecycle.hot=false anyway
// because Express has no route-removal and other modules
// (chat/helpers.ts, sessions.ts, multichat-broadcast/runner.ts) hold
// require() refs into ./employees that survive a reload.
'use strict';

const employeesLib = require('./employees');
const {
  init: initEmployees,
  registerEmployeeRoutes,
  getEmployee,
  getAllEmployees,
} = employeesLib;
const { registerAgentToolsRoutes } = require('./agent-tools');
const orgLib = require('./org');
const { init: initOrg, registerOrgRoutes, getOrg } = orgLib;

module.exports = function multichatPersonnelFactory() {
  return {
    activate(ctx: any) {
      registerEmployeeRoutes(ctx.app);
      // Mount /proxy/agent-tools/* — the stdio MCP server in
      // bridge/mcp/agent-tools-server.js calls these to list and invoke
      // employees/partners flagged with exposeAsAgent: true.
      registerAgentToolsRoutes(ctx.app);
      // Mount /v1/org/* — department→team org chart backing the grouped
      // Personnel dropdown and the recruit-team skill / MCP org tools.
      registerOrgRoutes(ctx.app);
      initEmployees();
      initOrg();

      // Register the `employee` participant kind. Per
      // YHA-modular-registers.md §2 the entry shape is
      // { kind, resolve(id) → persona, send(callDescriptor) → Promise }.
      // The `send` shim is intentionally a stub: real broadcast
      // dispatch lives in multichat-broadcast/runner.ts, called
      // directly by bridge/routes/chat.ts. The register entry exists
      // so future register-based consumers (and the FE
      // participantKinds.list() lookup powering the
      // [unloaded participant] fallback — Phase 5 follow-up) can see
      // that employees are active when this module is loaded.
      ctx.registers.participantKinds.add({
        id: 'employee',
        kind: 'employee',
        resolve(id: string) {
          return getEmployee(id);
        },
        send(_callDescriptor: any) {
          throw new Error('multichat-personnel: send() handled by multichat-broadcast.runEmployeeInChain — not via the register');
        },
      }, ctx.name);

      ctx.logger.info('mounted /v1/employees/* on global app; participantKinds:employee registered');
      // The activate() return value is stored on the registry handle as
      // `api`; core call-sites in `bridge/routes/sessions.ts` and
      // `bridge/chat/helpers.ts` use `getModuleApi('multichat-personnel')`
      // instead of require()ing './employees' directly. Disabling this
      // module yields `getModuleApi(...) === undefined` so callers can
      // gracefully degrade (e.g. participant lookups return null).
      return {
        name: ctx.name,
        getEmployee,
        getAllEmployees,
        getOrg,
        org: orgLib,
      };
    },
    deactivate() {
      // No-op — Express has no built-in route-removal. The register
      // entry is auto-removed by the loader's removeAllByModule() in
      // ctx.dispose(). lifecycle.hot=false in module.json so the loader
      // rejects a hot-reload attempt.
    },
  };
};
