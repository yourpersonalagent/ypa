// ModuleContext factory.
//
// Every module's `activate(ctx)` receives one of these. It's the only
// surface a module is allowed to reach into core through (plan §2.3:
// "all shared state via ctx, never via top-level imports"). That's
// what makes hot reload safe — busting `require.cache` for the
// module's own files leaves no dangling references because all the
// dangling-reference candidates (logger, sessions, registers) are
// proxied through `ctx`.
'use strict';

const path = require('path');
const express = require('express');
const { bridgeRegisters } = require('../registers/keys');
const PATHS = require('../paths');

interface BridgeAppLike {
  use: (...args: unknown[]) => unknown;
}

interface WorkerHandle {
  name: string;
  stop: () => void | Promise<void>;
}

interface ModuleContext {
  /** Module's own kebab-case name. */
  name: string;
  /** Absolute path to the module's directory (`bridge/modules/<name>`). */
  moduleDir: string;
  /** Per-module state directory under `bridge/data/modules/<name>/`. */
  dataDir: string;
  /** Module-scoped logger child. */
  logger: { info: (...a: unknown[]) => void; warn: (...a: unknown[]) => void; error: (...a: unknown[]) => void };
  /** Sub-router scoped to `/v1/<name>/...`. Mounted by the loader. */
  routes: import('express').Router;
  /**
   * Migration exit hatch — direct access to the global Express app.
   * Use for modules that own published URLs core users already
   * depend on (e.g. `/v1/config/link/*`). New modules should prefer
   * `ctx.routes`, which the loader mounts at `/v1/<name>`.
   *
   * Routes registered through ctx.app ARE cleaned up on dispose: the
   * context hands the module a proxied app that records every layer it
   * appends, then splices exactly those layers out of the Express
   * router stack on deactivate. Without this a hot reload re-registers
   * the module's handlers on top of the old ones and — because Express
   * matches the FIRST layer in the stack — the STALE handler keeps
   * winning. (Express exposes no public route-removal primitive, so the
   * splice reaches into Express 4 internals; it's feature-detected and
   * degrades to a warning if the internal shape ever changes.)
   */
  app: import('express').Application;
  /** All bridge-side registers (typed in keys.ts). */
  registers: typeof bridgeRegisters;
  /** Long-running tasks. The loader stops these on deactivate. */
  workers: {
    add(name: string, stop: () => void | Promise<void>): void;
    list(): ReadonlyArray<WorkerHandle>;
  };
  /**
   * Tracked timers — same signatures as the Node globals, but every handle
   * is remembered and cleared on dispose, so a module that schedules work
   * through ctx can never leak an interval/timeout (or fire it against a
   * stale closure) across a hot reload. Prefer these over the global
   * setInterval/setTimeout.
   */
  setInterval: (handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => ReturnType<typeof setInterval>;
  clearInterval: (handle: ReturnType<typeof setInterval> | undefined) => void;
  setTimeout: (handler: (...args: unknown[]) => void, ms?: number, ...args: unknown[]) => ReturnType<typeof setTimeout>;
  clearTimeout: (handle: ReturnType<typeof setTimeout> | undefined) => void;
  /** Convenience: read raw config (keys live in `bridge/config/`).
   *  Untyped because `core/state.ts` is CommonJS — properly typing
   *  the config shape is a Phase-7 cleanup. */
  config: Record<string, unknown>;
}

interface CreatedContext {
  ctx: ModuleContext;
  router: import('express').Router;
  /** Called by lifecycle.ts after deactivate to free everything. */
  dispose: () => Promise<void>;
}

function createContext(args: {
  name: string;
  moduleDir: string;
  app: import('express').Application;
  rootLogger?: { info?: Function; warn?: Function; error?: Function };
}): CreatedContext {
  const { name, moduleDir, app, rootLogger } = args;
  const router = express.Router();
  const dataDir = path.join(PATHS.dataRoot, 'modules', name);

  const logger = {
    info:  (...a: unknown[]) => (rootLogger?.info  || console.log )(`[mod:${name}]`, ...a),
    warn:  (...a: unknown[]) => (rootLogger?.warn  || console.warn)(`[mod:${name}]`, ...a),
    error: (...a: unknown[]) => (rootLogger?.error || console.error)(`[mod:${name}]`, ...a),
  };

  const workerList: WorkerHandle[] = [];
  const workers = {
    add(workerName: string, stop: () => void | Promise<void>) {
      workerList.push({ name: workerName, stop });
    },
    list(): ReadonlyArray<WorkerHandle> { return workerList.slice(); },
  };

  const { config } = require('../state');

  // Per-module wrapper around bridgeRegisters. Each register's `add` is
  // proxied to auto-pass the calling module name, so the registry's
  // provides-enforcement check (see bridge/core/registers/index.ts —
  // _checkProvides) can fire without every module having to remember to
  // pass ctx.name. list/listAll/on/etc. pass through unchanged.
  const wrappedRegisters: Record<string, unknown> = {};
  for (const [key, reg] of Object.entries(bridgeRegisters as Record<string, any>)) {
    if (!reg || typeof reg !== 'object') {
      wrappedRegisters[key] = reg;
      continue;
    }
    wrappedRegisters[key] = new Proxy(reg, {
      get(target, prop, receiver) {
        if (prop === 'add' && typeof target.add === 'function') {
          return function add(entry: unknown, callerModule?: string): unknown {
            return target.add(entry, callerModule || name);
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  // ── Tracked timers ─────────────────────────────────────────────────────────
  // Every handle is remembered so dispose() can clear whatever is still live.
  // setTimeout drops its own handle when it fires (a fired timeout doesn't need
  // clearing); intervals stay tracked until dispose or an explicit clear.
  const liveIntervals = new Set<ReturnType<typeof setInterval>>();
  const liveTimeouts = new Set<ReturnType<typeof setTimeout>>();
  function ctxSetInterval(fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]): ReturnType<typeof setInterval> {
    const h = setInterval(fn as (...a: unknown[]) => void, ms, ...args);
    liveIntervals.add(h);
    return h;
  }
  function ctxClearInterval(h: ReturnType<typeof setInterval> | undefined): void {
    if (h === undefined) return;
    liveIntervals.delete(h);
    clearInterval(h);
  }
  function ctxSetTimeout(fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]): ReturnType<typeof setTimeout> {
    let h: ReturnType<typeof setTimeout>;
    const wrapped = (...a: unknown[]) => { liveTimeouts.delete(h); fn(...a); };
    h = setTimeout(wrapped as (...a: unknown[]) => void, ms, ...args);
    liveTimeouts.add(h);
    return h;
  }
  function ctxClearTimeout(h: ReturnType<typeof setTimeout> | undefined): void {
    if (h === undefined) return;
    liveTimeouts.delete(h);
    clearTimeout(h);
  }

  // ── Route tracking for the ctx.app migration hatch ───────────────────────────
  // Express has no public "remove route" primitive, so we wrap the app and
  // record every layer a module appends to app._router.stack through the verb
  // methods. dispose() splices exactly those layers back out (by identity, so
  // interleaved registrations from other code are never touched). Feature-
  // detected against Express 4 internals — see the ctx.app doc above.
  const trackedRouteMethods = new Set(['get', 'post', 'put', 'delete', 'patch', 'all', 'options', 'head', 'use']);
  const addedRouteLayers: Array<{ stack: unknown[]; layer: unknown }> = [];
  function routerStack(): unknown[] | null {
    const r = (app as unknown as { _router?: { stack?: unknown[] } })._router;
    return r && Array.isArray(r.stack) ? r.stack : null;
  }
  const appProxy = new Proxy(app, {
    get(target, prop) {
      if (typeof prop === 'string' && trackedRouteMethods.has(prop)) {
        const orig = (target as unknown as Record<string, unknown>)[prop];
        if (typeof orig === 'function') {
          return function trackedRegister(...regArgs: unknown[]): unknown {
            const before = routerStack()?.length ?? 0;
            const result = (orig as (...a: unknown[]) => unknown).apply(target, regArgs);
            const stack = routerStack();
            if (stack) {
              for (let i = before; i < stack.length; i++) addedRouteLayers.push({ stack, layer: stack[i] });
            }
            return result;
          };
        }
      }
      const v = (target as unknown as Record<string, unknown>)[prop as string];
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });

  const ctx: ModuleContext = {
    name,
    moduleDir,
    dataDir,
    logger,
    routes: router,
    app: appProxy,
    registers: wrappedRegisters as typeof bridgeRegisters,
    workers,
    config,
    setInterval: ctxSetInterval,
    clearInterval: ctxClearInterval,
    setTimeout: ctxSetTimeout,
    clearTimeout: ctxClearTimeout,
  };

  async function dispose() {
    for (const w of workerList.slice().reverse()) {
      try {
        const r = w.stop();
        if (r && typeof (r as Promise<unknown>).then === 'function') await r;
      } catch (e) {
        logger.warn(`worker.stop("${w.name}") threw:`, (e as Error).message);
      }
    }
    workerList.length = 0;

    // Clear timers scheduled through ctx — an orphaned interval would keep
    // firing against the disposed module's (now stale) closures after reload.
    for (const h of liveIntervals) clearInterval(h);
    liveIntervals.clear();
    for (const h of liveTimeouts) clearTimeout(h);
    liveTimeouts.clear();

    // Splice out every Express layer the module registered through ctx.app so a
    // re-activation's fresh handlers aren't shadowed by the stale ones.
    if (addedRouteLayers.length) {
      let removed = 0;
      let missed = 0;
      for (const { stack, layer } of addedRouteLayers) {
        const idx = stack.indexOf(layer);
        if (idx >= 0) { stack.splice(idx, 1); removed++; } else { missed++; }
      }
      addedRouteLayers.length = 0;
      if (missed) logger.warn(`ctx.app route cleanup: removed ${removed}, ${missed} layer(s) not found (Express internals may have changed)`);
      else if (removed) logger.info(`ctx.app route cleanup: removed ${removed} layer(s)`);
    }

    // Remove every register entry the module added.
    const { removeModuleEverywhere } = require('../registers');
    const removed = removeModuleEverywhere(name);
    logger.info(`disposed (removed ${removed} register entries)`);
  }

  return { ctx, router, dispose };
}

module.exports = { createContext };
