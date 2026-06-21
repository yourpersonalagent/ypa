// pet — bridge half of the YHA pet module.
//
// Ships in this batch:
//   - the quick-chat console (`lib/console.ts` + `routes/console.ts`,
//     was `bridge/features/pet-console.ts` + `bridge/routes/pet-console.ts`)
//   - the hatch wizard upload endpoints (`lib/hatch.ts`, was
//     `bridge/features/pet-hatch.ts`)
//
// Routes mount on `ctx.app` (the global Express app) so the published
// /v1/pet-console/* and /v1/pets/* prefixes stay byte-equivalent —
// same exit-hatch reasoning as link / welcome-messages / todos.
//
// What is *not* in this module yet:
//   - The frontend half: `frontend/src/pet/*`, `components/FloatingPet.tsx`,
//     `components/PetHeaderButton.tsx`, `components/PetQuickChat.tsx`,
//     `components/hatch/*`, `stores/petStore.ts`. Those involve ~40
//     import-site rewrites across `frontend/src/` (FloatingPet alone has
//     12 internal imports of pet/* siblings; petStore re-exports types
//     from `pet/petStoreTypes.ts`; ChatInput.tsx + chat.ts pull
//     `pet/localSlash.ts`). Atomic-ship discipline: the bridge half is
//     small, isolated, and shippable today; the FE move belongs in its
//     own batch with TypeScript guiding the 40-line import audit.
//   - The PetHeaderButton register migration (it's already a
//     `headerIconButtons` entry under `host/bootstrap-core-icons.ts`,
//     but core's `bootstrap-core-icons.ts` is the registrant — when
//     the FE half lands here, that registration moves into this
//     module's frontend `activate()`).
//   - `petActions` + `petBubbleProviders` registers (declared in the
//     plan §2.2 catalog, not yet declared in `frontend/src/host/keys.ts`).
'use strict';

const { registerPetConsoleRoutes } = require('./routes/console');
const { registerPetHatchRoutes } = require('./lib/hatch');
const { registerPetVisionRoutes } = require('./routes/vision');

interface PetModuleApi {
  /** For diagnostics / introspection only. */
  name: string;
}

module.exports = function petFactory() {
  return {
    activate(ctx: any): PetModuleApi {
      registerPetConsoleRoutes(ctx.app);
      registerPetHatchRoutes(ctx.app);
      registerPetVisionRoutes(ctx.app);
      ctx.logger.info('mounted /v1/pet-console/*, /v1/pets/*, /v1/pet-vision/* on global app');
      return { name: ctx.name };
    },
    deactivate() {
      // No-op — Express has no built-in route-removal; same constraint
      // as the link / welcome-messages / todos modules. lifecycle.hot=false
      // in module.json so the loader rejects a hot-reload attempt.
    },
  };
};
