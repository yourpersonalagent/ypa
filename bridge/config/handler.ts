// ── Config route orchestrator ────────────────────────────────────────────────
// registerConfigRoutes wires the per-area route modules in a fixed order.
// Overlapping Express patterns (e.g. GET /v1/config/skills/ vs the provider
// CRUD's /v1/config/providers/:name, and the various /:name vs literal paths)
// make registration order load-bearing — keep these calls in this sequence.
// Each registerXxxRoutes module owns its own imports + helpers; this file only
// composes them. See ./config-core-routes, ./presets-routes, ./files-routes,
// ./harness-routes, ./pricing-routes, ./prefs-routes.
//
// registerHarnessRoutes also attaches app._initHarnessAutoFix, which server.ts
// invokes immediately after registerConfigRoutes returns, so it must run
// synchronously from here (it does).
'use strict';

const { registerFilesRoutes } = require('./files-routes');
const { registerConfigCoreRoutes } = require('./config-core-routes');
const { registerPresetsRoutes } = require('./presets-routes');
const { registerHarnessRoutes } = require('./harness-routes');
const { registerPricingRoutes } = require('./pricing-routes');
const { registerPrefsRoutes } = require('./prefs-routes');
const { registerNetRoutes } = require('./net-routes');

function registerConfigRoutes(app) {
  registerFilesRoutes(app);
  registerConfigCoreRoutes(app);
  registerPresetsRoutes(app);
  registerHarnessRoutes(app);
  registerPricingRoutes(app);
  registerPrefsRoutes(app);
  // /v1/net/* — node identity; no path overlap with the config patterns above,
  // so it's safe at the end of the sequence.
  registerNetRoutes(app);
}

module.exports = { registerConfigRoutes };
