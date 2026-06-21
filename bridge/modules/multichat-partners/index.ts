// multichat-partners — bridge module owning the external partner-agent
// cluster: Hermes (local tui_gateway subprocess) + OpenClaw (remote WS
// gateways) + the /v1/partners* REST surface.
//
// Files moved from bridge/partners-internal/:
//   routes.ts   — /v1/partners* CRUD + dropdown + system-prompt routes,
//                 partner record list (loaded from bridge/partners.json),
//                 initPartners() that auto-starts the Hermes subprocess
//                 for any enabled+installed partner record.
//   hermes.ts   — Hermes gateway adapter (singleton subprocess + per-
//                 session JSON-RPC). Required at request time by chat.ts
//                 and multichat-broadcast/runner.ts via the new path.
//   openclaw.ts — Per-partner WS-RPC client. Required at request time
//                 by chat.ts via the new path.
//
// Data files (live user state — files written mid-runtime):
//   bridge/partners.json    — record list. Stays at bridge root;
//                             routes.ts resolves it via path.join(
//                             __dirname, '..', '..', 'partners.json').
//   bridge/partners/*.md    — per-partner system prompts.
//
// External callers updated:
//   - bridge/server.ts (the require + register-call lines)
//   - bridge/routes/chat.ts (hermes + openclaw lazy requires)
//   - bridge/modules/multichat-broadcast/runner.ts (hermes lazy require)
//   - bridge/modules/multichat-personnel/employees.ts
//     (`getEnabledPartnerEmployees` lookup for the @-picker)
//
// participantKinds register: declares the `partner` kind so future
// register-based participant resolvers can list partners only when
// this module is active.
//
// Worker lifecycle: initPartners() may start the Hermes subprocess.
// gateway.stop() + dropAllClients() are registered with ctx.workers so
// the loader can cleanly shut them down on bridge exit or deactivate.
// External require() refs in chat.ts/multichat-broadcast mean route
// handlers survive a deactivate; lifecycle.hot=false in module.json.
'use strict';

const partnerRoutes = require('./routes');
const { gateway } = require('./hermes');
const { dropAllClients } = require('./openclaw');

module.exports = function multichatPartnersFactory() {
  return {
    activate(ctx: any) {
      partnerRoutes.registerPartnerRoutes(ctx.app);
      partnerRoutes.initPartners();
      ctx.workers.add('hermes-gateway', () => gateway.stop());
      ctx.workers.add('openclaw-clients', dropAllClients);

      // Register the `partner` participant kind. The send() shim is
      // intentionally a stub: real broadcast dispatch lives in
      // multichat-broadcast/runner.ts (`emp.partnerType === 'hermes'`
      // branch) and bridge/routes/chat.ts (the openclaw branch); both
      // require ./hermes and ./openclaw directly. The register entry
      // exists so future register-based consumers (and the FE
      // participant-fallback follow-up) can see that partners are
      // active when this module is loaded.
      ctx.registers.participantKinds.add({
        id: 'partner',
        kind: 'partner',
        resolve(id: string) {
          // Search the enabled partner roster — same source as the
          // @-picker uses via multichat-personnel.
          try {
            const list = partnerRoutes.getEnabledPartnerEmployees();
            return list.find((p: any) => p.id === id) || null;
          } catch (_) {
            return null;
          }
        },
        send(_callDescriptor: any) {
          throw new Error('multichat-partners: send() handled by multichat-broadcast.runEmployeeInChain (hermes) or chat.ts openclaw branch — not via the register');
        },
      }, ctx.name);

      ctx.logger.info('mounted /v1/partners* on global app; participantKinds:partner registered; Hermes auto-start eval ran');
      // The activate() return value is stored on the registry handle as
      // `api`; core call-sites in `bridge/routes/chat.ts` use
      // `getModuleApi('multichat-partners')?.hermesGateway` instead of
      // require()ing './hermes' directly, and the openclaw branch uses
      // `getOpenClawClient`. multichat-broadcast's runner uses the same
      // lookup for its hermes path.
      const { getClient: getOpenClawClient } = require('./openclaw');
      return {
        name: ctx.name,
        hermesGateway: gateway,
        getOpenClawClient,
        getEnabledPartnerEmployees: partnerRoutes.getEnabledPartnerEmployees,
      };
    },
    deactivate() {
      // ctx.workers handles gateway.stop() + dropAllClients() automatically.
      // Express route-removal is not possible; register entries are
      // auto-removed by the loader's removeAllByModule().
    },
  };
};
