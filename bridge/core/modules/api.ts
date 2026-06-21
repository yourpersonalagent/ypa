// Cross-module API lookup helper.
//
// The plan's Phase-6 follow-up identified that core call-sites which
// hard-`require('../modules/X/Y')` defeat hot-reload AND make
// "disable a module" unsafe (the require path 404s if the module
// directory is the only home for the function, and the require-cache
// pins the implementation across reloads).
//
// The fix is that every module's `activate(ctx)` returns a public API
// object, the loader stores it on the registry handle, and core
// callers look it up by module name through this helper. The lookup
// returns `undefined` if the module isn't loaded — callers decide
// whether that's a 501-style soft-fail or an outright throw.
//
// Usage:
//   const broadcast = getModuleApi<BroadcastApi>('multichat-broadcast');
//   if (!broadcast) {
//     return res.status(501).json({ error: 'multichat-broadcast disabled' });
//   }
//   await broadcast.runEmployeeInChain(...);
//
//   // Or, when the module is required for the call-site to function:
//   const search = requireModuleApi<SearchApi>('search');
//   const hits = await search.orchestrator.runQuery(q);
//
// Why a tiny dedicated helper instead of importing `registry` directly:
//   - Centralises the "module disabled" diagnostic: one console warning
//     format, one place to attach typing later.
//   - Hides the registry handle's internal shape from call-sites; the
//     handle has bookkeeping fields (state, error, dispose) that core
//     consumers shouldn't reach into.
//   - Lets us add a bare-core test mode that returns `undefined` for
//     every lookup without modules.json edits, by short-circuiting
//     here rather than at every call-site.
'use strict';

const registry = require('./registry');

interface ModuleHandleLike {
  state: 'pending' | 'active' | 'failed' | 'disabled';
  api?: unknown;
  error?: string;
}

/**
 * Returns the activate()-returned api for `name` if the module is
 * active, else `undefined`. Never throws.
 *
 * Use this when the call-site can degrade gracefully (e.g. an HTTP
 * route returning 501, a chat dispatcher falling back to a default
 * harness, an optional sidebar contribution).
 */
function getModuleApi<T = unknown>(name: string): T | undefined {
  const h = registry.get(name) as ModuleHandleLike | undefined;
  if (!h) return undefined;
  if (h.state !== 'active') return undefined;
  return h.api as T | undefined;
}

/**
 * Returns the activate()-returned api for `name`, or throws a clear
 * error if the module is disabled or failed to load.
 *
 * Use this when the call-site cannot function without the module
 * (e.g. an /v1/employees handler reaching multichat-personnel).
 *
 * The thrown error includes the module's failure reason if known so
 * the bridge log shows why an enabled-but-broken module is missing.
 */
function requireModuleApi<T = unknown>(name: string): T {
  const h = registry.get(name) as ModuleHandleLike | undefined;
  if (!h) {
    throw new Error(
      `[modules] required module "${name}" is not loaded. ` +
      `Enable it in bridge/modules.json or check the loader log.`,
    );
  }
  if (h.state !== 'active') {
    const reason = h.error ? `: ${h.error}` : '';
    throw new Error(
      `[modules] required module "${name}" is in state="${h.state}"${reason}. ` +
      `The call-site cannot proceed without it.`,
    );
  }
  return h.api as T;
}

/**
 * Predicate: is the named module currently active?
 *
 * Cheaper than getModuleApi for "should I render this slot" checks
 * that don't need the api itself (the register-entry filtering does
 * that already; this is for legacy callers that need a yes/no).
 */
function isModuleActive(name: string): boolean {
  const h = registry.get(name) as ModuleHandleLike | undefined;
  return !!h && h.state === 'active';
}

module.exports = { getModuleApi, requireModuleApi, isModuleActive };
