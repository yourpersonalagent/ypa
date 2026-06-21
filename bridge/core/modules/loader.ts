// Module loader — reads `bridge/modules.json`, requires each enabled
// module, runs `activate(ctx)`, and mounts the module's sub-router at
// `/v1/<name>`.
//
// Failure isolation: an `activate()` throw is caught, the module is
// marked `failed`, the bridge keeps booting (plan §4.4). Today's
// monolith would crash on a single bad `register*Routes()` call; the
// loader fixes that for free.
'use strict';

const fs = require('fs');
const path = require('path');
const { validate: validateManifest } = require('./manifest-schema');
const { createContext } = require('./context');
const registry = require('./registry');
const { setModuleProvides } = require('../registers');
const rewind = require('../rewind');

// Working-directory the rewind store keys edit records against. The bridge
// always runs from the repo root, so process.cwd() is the same WD the
// frontend/agents target. If we ever spawn the bridge from elsewhere, this
// is the one knob to revisit.
const REWIND_WD = process.cwd();

const MODULES_DIR = path.resolve(__dirname, '..', '..', 'modules');
const MODULES_JSON = path.resolve(__dirname, '..', '..', 'modules.json');

// Per-module wrapper state — survives reloads. On first activate we mount a
// stable wrapper middleware at /v1/<name>; subsequent reloads swap the inner
// router via `innerRouters.set(name, newRouter)` instead of calling
// `app.use(...)` again (which would stack a second layer on top of the old
// one, leaving ghost routes from the previous activation).
const innerRouters = new Map<string, any>();
const activeRequests = new Map<string, number>();

function mountWrapperOnce(app: any, name: string): void {
  if (innerRouters.has(name)) return;
  innerRouters.set(name, null);
  activeRequests.set(name, 0);
  app.use(`/v1/${name}`, (req: any, res: any, next: any) => {
    // Track in-flight requests so reload-safety="idle-only" modules can know
    // when it's safe to swap. Increment on entry, decrement when the response
    // finishes OR the connection closes (covers aborted SSE streams).
    activeRequests.set(name, (activeRequests.get(name) || 0) + 1);
    let decremented = false;
    const done = () => {
      if (decremented) return;
      decremented = true;
      const cur = activeRequests.get(name) || 0;
      if (cur > 0) activeRequests.set(name, cur - 1);
    };
    res.on('finish', done);
    res.on('close', done);

    const inner = innerRouters.get(name);
    if (typeof inner === 'function') return inner(req, res, next);
    // No router currently mounted (module disabled or mid-reload) — fall
    // through; if no other handler matches, Express produces a 404.
    return next();
  });
}

function getActiveRequests(name: string): number {
  return activeRequests.get(name) || 0;
}

/**
 * Resolve the effective reload posture for a module.
 *
 *   1. If `lifecycle.reload` is explicitly set, that wins.
 *   2. Else if `lifecycle.hot === false`, treat as 'never' (legacy compat).
 *   3. Else default to 'idle-only'.
 *
 * Default of 'idle-only' (not 'safe') is deliberate: a new module with no
 * lifecycle declaration probably hasn't been audited for what happens when
 * activate() runs twice. Waiting for in-flight requests to drain catches
 * the most common "request handler captured a stale closure" foot-gun. A
 * module that *is* fully stateless can opt up to 'safe' explicitly.
 * See docs/Hot-Reload-Modules.md for the audit guidance.
 *
 * Both the file-watcher and the HTTP reload endpoint go through this so
 * the rules stay in one place.
 */
function getReloadPosture(manifest: import('./manifest-schema').Manifest | undefined): 'safe' | 'idle-only' | 'never' {
  const l = manifest?.lifecycle as { reload?: 'safe' | 'idle-only' | 'never'; hot?: boolean } | undefined;
  if (l?.reload) return l.reload;
  if (l?.hot === false) return 'never';
  return 'idle-only';
}

interface ModulesJsonEntry {
  name: string;
  enabled?: boolean;
  /** Pinned version; if missing, whatever the module's own manifest says. */
  version?: string;
  /** Per-module config blob, read by `activate(ctx)` via ctx.config later. */
  config?: Record<string, unknown>;
}

interface ModulesJson {
  modules: ModulesJsonEntry[];
}

function readModulesJson(): ModulesJson {
  if (!fs.existsSync(MODULES_JSON)) return { modules: [] };
  try {
    const raw = JSON.parse(fs.readFileSync(MODULES_JSON, 'utf8'));
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.modules)) {
      console.warn(`[loader] ${MODULES_JSON}: malformed (expected { modules: [] })`);
      return { modules: [] };
    }
    return raw;
  } catch (e) {
    console.warn(`[loader] ${MODULES_JSON}: parse failed: ${(e as Error).message}`);
    return { modules: [] };
  }
}

function readManifest(name: string): { ok: boolean; manifest?: import('./manifest-schema').Manifest; errors?: string[] } {
  const file = path.join(MODULES_DIR, name, 'module.json');
  if (!fs.existsSync(file)) return { ok: false, errors: [`${name}: module.json not found at ${file}`] };
  let raw: unknown;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return { ok: false, errors: [`${name}: module.json parse failed: ${(e as Error).message}`] }; }
  const v = validateManifest(raw, `modules/${name}/module.json`);
  if (!v.ok) return { ok: false, errors: v.errors };
  if (v.manifest.name !== name) {
    return { ok: false, errors: [`${name}: manifest.name="${v.manifest.name}" doesn't match directory name`] };
  }
  return { ok: true, manifest: v.manifest };
}

function topoSort(entries: ReadonlyArray<{ name: string; needs: string[] }>): string[] {
  const byName = new Map(entries.map((e) => [e.name, e] as const));
  const visited = new Set<string>();
  const stack = new Set<string>();
  const out: string[] = [];

  function visit(name: string, trail: string[]) {
    if (visited.has(name)) return;
    if (stack.has(name)) {
      console.warn(`[loader] dependency cycle: ${[...trail, name].join(' → ')} — keeping insertion order for the rest`);
      return;
    }
    const entry = byName.get(name);
    if (!entry) {
      console.warn(`[loader] missing dependency "${name}" — skipping`);
      return;
    }
    stack.add(name);
    for (const dep of entry.needs) visit(dep, [...trail, name]);
    stack.delete(name);
    visited.add(name);
    out.push(name);
  }

  for (const e of entries) visit(e.name, []);
  return out;
}

interface BootOptions {
  app: import('express').Application;
  logger?: { info?: Function; warn?: Function; error?: Function };
}

/**
 * Synchronous boot. Required because Express's error-handling
 * middleware only catches errors from routes registered BEFORE it —
 * so the loader has to mount every module's routes before
 * `bridge/server.ts` registers its global error handler.
 *
 * This means a module's `activate()` runs synchronously today: any
 * Promise it returns is awaited fire-and-forget after route mount.
 * Real async work (waiting on a child-process MCP server) belongs in
 * `ctx.workers.add()` so it doesn't block boot.
 */
function boot(opts: BootOptions): void {
  const { app, logger } = opts;
  const log = (level: 'info' | 'warn' | 'error', ...a: unknown[]) =>
    ((logger?.[level] as Function) || console[level])('[loader]', ...a);

  const cfg = readModulesJson();

  // Bare-core test gate. `YHA_BARE_CORE=1` (or `--bare-core` CLI
  // flag handled in yha.sh) disables every module without editing
  // modules.json — the user can flip it on/off per-run to reproduce
  // "feature disabled" behaviour, validate that core boots without
  // any module's contributions, and isolate which features depend
  // on which modules during development.
  //
  // The /v1/modules endpoint will report each module as state="disabled"
  // with reason="bare-core" (set below), so the FE shows them as
  // gated rather than missing.
  const bareCore = process.env.YHA_BARE_CORE === '1' || process.env.YHA_BARE_CORE === 'true';
  if (bareCore) {
    log('info', `YHA_BARE_CORE=1 — running in bare-core mode (no modules will be loaded; ${cfg.modules.length} would be enabled normally)`);
    for (const e of cfg.modules) {
      if (e.enabled === false) continue;
      registry.set({
        name: e.name,
        state: 'disabled',
        error: 'bare-core mode (YHA_BARE_CORE=1)',
        manifest: { name: e.name, version: '?', kind: 'bridge' } as never,
      });
    }
    return;
  }

  const enabled = cfg.modules.filter((m) => m.enabled !== false);
  if (enabled.length === 0) {
    log('info', `no modules enabled (modules.json has ${cfg.modules.length} entries)`);
    return;
  }

  // Read manifests up front so topo-sort has dependency info.
  const manifests: Array<{ name: string; manifest: import('./manifest-schema').Manifest; }> = [];
  for (const e of enabled) {
    const r = readManifest(e.name);
    if (!r.ok) {
      log('error', `module "${e.name}" disabled —`, (r.errors || []).join('; '));
      registry.set({ name: e.name, state: 'failed', error: (r.errors || []).join('; '), manifest: { name: e.name, version: '?', kind: 'bridge' } as never });
      continue;
    }
    manifests.push({ name: e.name, manifest: r.manifest! });
  }

  // Topo-sort by `needs`.
  const ordered = topoSort(manifests.map((m) => ({ name: m.name, needs: m.manifest.needs || [] })));

  for (const name of ordered) {
    const entry = manifests.find((m) => m.name === name);
    if (!entry) continue;
    activateOne(app, name, entry.manifest, log, 'boot');
  }
}

function activateOne(
  app: import('express').Application,
  name: string,
  manifest: import('./manifest-schema').Manifest,
  log: (level: 'info' | 'warn' | 'error', ...a: unknown[]) => void,
  trigger: 'boot' | 'reload' | 'enable',
): void {
  // Pure frontend modules have no bridge half — there's nothing to require()
  // or activate() server-side. Just register the manifest so /v1/modules
  // surfaces the entry (with description, version, needs, etc.) and the
  // FE host activates the module from its own enabled-modules.ts.
  if (manifest.kind === 'frontend') {
    registry.set({ name, state: 'active', manifest, loadedAt: Date.now() });
    log('info', `registered frontend-only module "${name}" v${manifest.version}`);
    // Frontend-only modules have no bridge-side files to observe in Phase A.
    // Frontend edit tracking is planned for Phase D (grill-plan §5).
    return;
  }

  const moduleDir = path.join(MODULES_DIR, name);
  const indexCandidates = ['index.ts', 'index.js'];
  const indexFile = indexCandidates.map((f) => path.join(moduleDir, f)).find((p) => fs.existsSync(p));
  if (!indexFile) {
    log('error', `module "${name}" disabled — no index.ts/index.js`);
    registry.set({ name, state: 'failed', error: 'no index.ts/index.js', manifest });
    return;
  }

  // Record the module's declared `provides.bridgeRegisters` so Register.add
  // can detect when this module writes to a register it didn't promise (see
  // bridge-modules-system/F-002). `provides` undefined = permissive; `provides`
  // declared but `bridgeRegisters` absent = treated as empty (strict).
  const providesDeclared = manifest.provides !== undefined;
  const declaredBridgeRegisters = providesDeclared
    ? (Array.isArray(manifest.provides?.bridgeRegisters) ? manifest.provides.bridgeRegisters : [])
    : null;
  setModuleProvides(name, declaredBridgeRegisters);

  const { ctx, router, dispose: ctxDispose } = createContext({ name, moduleDir, app });

  try {
    let mod: unknown;
    try { mod = require(indexFile); }
    catch (e) {
      log('error', `module "${name}" require() failed: ${(e as Error).message}`);
      registry.set({ name, state: 'failed', error: (e as Error).message, manifest });
      return;
    }

    const factory =
      typeof mod === 'function' ? mod
      : typeof (mod as { default?: unknown })?.default === 'function' ? (mod as { default: Function }).default
      : (mod as { activate?: Function });

    let factoryResult: unknown;
    if (typeof factory === 'function') {
      factoryResult = factory();
    } else if (typeof (factory as { activate?: unknown })?.activate === 'function') {
      factoryResult = factory;
    } else {
      log('error', `module "${name}" disabled — index does not export an activate() factory`);
      registry.set({ name, state: 'failed', error: 'no activate() exported', manifest });
      return;
    }

    const activated: { activate?: Function; deactivate?: Function } = factoryResult as never;
    if (typeof activated?.activate !== 'function') {
      log('error', `module "${name}" disabled — factory result missing activate()`);
      registry.set({ name, state: 'failed', error: 'no activate() in factory result', manifest });
      return;
    }

    // Modules' activate() is allowed to be async, but we don't block
    // on it here — Express needs every route mounted synchronously
    // before the global error handler is registered. A module that
    // returns a Promise is responsible for finishing its async work
    // *without* registering more routes after the resolution.
    const apiOrPromise = activated.activate(ctx);
    let api: unknown = apiOrPromise;
    if (apiOrPromise && typeof (apiOrPromise as Promise<unknown>).then === 'function') {
      api = undefined;
      (apiOrPromise as Promise<unknown>).catch((e) =>
        log('warn', `module "${name}" activate() Promise rejected: ${(e as Error).message}`),
      );
    }

    // Mount the stable wrapper at /v1/<name> on first activate; on reload
    // the wrapper stays mounted and we just swap the inner router. This
    // avoids the "stacked middleware" bug where calling app.use(...) twice
    // for the same path leaves ghost routes from the previous activation in
    // the Express stack.
    mountWrapperOnce(app, name);
    innerRouters.set(name, router);

    registry.set({
      name,
      state: 'active',
      manifest,
      api,
      loadedAt: Date.now(),
      dispose: async () => {
        try {
          if (typeof activated.deactivate === 'function') {
            await activated.deactivate();
          }
        } catch (e) {
          log('warn', `module "${name}" deactivate() threw: ${(e as Error).message}`);
        }
        await ctxDispose();
      },
    });

    // Rewind safety-net: seed baseline on boot, diff-and-record on later
    // hot activations. Errors are swallowed inside rewind.* — a degraded
    // safety net must not block a working module load.
    try {
      if (trigger === 'boot') {
        const recId = rewind.seedBaselineWithBlobs(name, moduleDir, {
          wd: REWIND_WD,
          agentTurnId: null,
        });
        if (recId) log('info', `rewind: recorded boot-diff ${recId} for "${name}"`);
      } else {
        const recId = rewind.observeActivation(name, moduleDir, {
          wd: REWIND_WD,
          trigger,
          agentTurnId: null,
        });
        if (recId) log('info', `rewind: recorded edit ${recId} for "${name}" (${trigger})`);
      }
    } catch (e) {
      log('warn', `rewind hook threw for "${name}": ${(e as Error).message}`);
    }

    log('info', `loaded "${name}" v${manifest.version} (${manifest.kind})`);
  } catch (e) {
    log('error', `module "${name}" activate() threw: ${(e as Error).message}`);
    // fire-and-forget: activateOne stays sync (boot() requires sync); the
    // failed-state record is what callers observe.
    ctxDispose().catch(() => { /* swallow */ });
    registry.set({ name, state: 'failed', error: (e as Error).message, manifest });
  }
}

/**
 * Hot-disable a module without restarting the bridge.
 *
 * Guards: refuses core modules and modules declaring lifecycle.reload="never".
 * For idle-only modules with in-flight requests, returns reason="busy" so the
 * caller can choose to fall back to "restart required" rather than tearing
 * down an active stream.
 *
 * Side effects on success:
 *   - inner router is detached (any new request to /v1/<name> falls through
 *     to a 404 from Express's default handler).
 *   - the module's dispose() runs (stops workers, releases registers).
 *   - the registry entry transitions to state="disabled" but keeps the
 *     manifest so /v1/modules still reports description/category/etc.
 */
async function unload(
  name: string,
  _app: import('express').Application,
): Promise<{ ok: boolean; error?: string; reason?: 'never' | 'busy' | 'core' }> {
  const handle = registry.get(name);
  if (!handle) return { ok: true };
  if (handle.manifest?.core === true) {
    return { ok: false, error: 'core modules cannot be disabled at runtime', reason: 'core' };
  }
  if (handle.state !== 'active') {
    // Already disabled or failed — make sure the registry reflects "disabled"
    // so the UI shows a consistent state after the modules.json flip.
    registry.set({ name, state: 'disabled', manifest: handle.manifest });
    return { ok: true };
  }
  const posture = getReloadPosture(handle.manifest);
  if (posture === 'never') {
    return { ok: false, error: 'module declares lifecycle.reload="never"; restart required', reason: 'never' };
  }
  if (posture === 'idle-only' && getActiveRequests(name) > 0) {
    // Honor manifest.lifecycle.drainTimeoutMs (capped at 30 s) — give the
    // module's in-flight requests a chance to finish before refusing the
    // unload. The schema has carried this field for a while but nothing
    // read it; long-lived SSE modules that declared a grace period got the
    // same instant-refuse behavior as everything else. We detach the inner
    // router immediately so no NEW requests can land while we wait, then
    // poll the in-flight counter on 100 ms ticks.
    const drainBudgetMs = Math.min(
      30_000,
      Math.max(0, Number(handle.manifest?.lifecycle?.drainTimeoutMs) || 0),
    );
    if (drainBudgetMs > 0) {
      if (innerRouters.has(name)) innerRouters.set(name, null);
      const deadline = Date.now() + drainBudgetMs;
      while (Date.now() < deadline && getActiveRequests(name) > 0) {
        await new Promise((r) => setTimeout(r, 100));
      }
      if (getActiveRequests(name) > 0) {
        return { ok: false, error: `module still busy after drainTimeoutMs=${drainBudgetMs} (${getActiveRequests(name)} in-flight)`, reason: 'busy' };
      }
      // Drained cleanly — fall through to dispose without re-detaching the
      // router (already cleared above).
    } else {
      return { ok: false, error: `module is idle-only with ${getActiveRequests(name)} in-flight request(s)`, reason: 'busy' };
    }
  }
  if (innerRouters.has(name)) innerRouters.set(name, null);
  if (handle.dispose) {
    try { await handle.dispose(); }
    catch (e) { return { ok: false, error: `dispose() threw: ${(e as Error).message}` }; }
  }
  registry.set({ name, state: 'disabled', manifest: handle.manifest });
  return { ok: true };
}

/**
 * Hot-enable a module without restarting the bridge.
 *
 * Reads the manifest fresh from disk and runs activateOne, which mounts the
 * inner router (or swaps into the existing wrapper if the module was hot-
 * disabled earlier in this process). No-op if the module is already active.
 *
 * Note for kind="frontend"/"both": only the bridge half is hot-mounted here.
 * The FE host (`frontend/src/host/enabled-modules.ts`) reads the enable bit
 * at boot, so the FE surface won't appear until the next page reload.
 */
async function enable(
  name: string,
  app: import('express').Application,
): Promise<{ ok: boolean; error?: string }> {
  const existing = registry.get(name);
  if (existing && existing.state === 'active') return { ok: true };
  const r = readManifest(name);
  if (!r.ok) return { ok: false, error: (r.errors || []).join('; ') };
  activateOne(app, name, r.manifest!, (lvl, ...a) => (console[lvl] as Function)('[loader]', ...a), 'enable');
  const after = registry.get(name);
  if (after?.state !== 'active') return { ok: false, error: after?.error || 'unknown' };
  return { ok: true };
}

async function reload(name: string, app: import('express').Application): Promise<{ ok: boolean; error?: string }> {
  const handle = registry.get(name);
  const moduleDir = path.join(MODULES_DIR, name);

  // ── Pre-flight (non-destructive) ──────────────────────────────────────────
  // Validate that the edited version can LOAD before we tear down the running
  // one. In a system whose chats edit module source then reload, the two most
  // common bad-edit failures are an invalid manifest and a syntax/import error;
  // catching them here means we abort with the previous version still serving
  // instead of disposing it and leaving the slot as a 404. (Full rollback after
  // a *successful* load whose activate() then throws is NOT handled — re-running
  // the old activate() would collide with the new one's shared-register/worker
  // side effects; that deeper guarantee is deliberately deferred.)
  const r = readManifest(name);
  if (!r.ok) return { ok: false, error: (r.errors || []).join('; ') };

  if (r.manifest!.kind !== 'frontend') {
    const indexFile = ['index.ts', 'index.js']
      .map((f) => path.join(moduleDir, f))
      .find((p) => fs.existsSync(p));
    if (!indexFile) return { ok: false, error: 'no index.ts/index.js' };
    // Bust require.cache for everything under modules/<name>/ so the probe
    // require() reads the edited source. Busting the cache does NOT disturb the
    // old router still mounted in innerRouters (it holds already-resolved
    // closures), so a probe failure leaves the live module fully intact. On
    // success the warm cache is reused by activateOne below — top-level code
    // runs once, not twice.
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(moduleDir + path.sep) || key === moduleDir) {
        delete require.cache[key];
      }
    }
    try {
      require(indexFile);
    } catch (e) {
      return { ok: false, error: `reload aborted (load failed); previous version still active: ${(e as Error).message}` };
    }
  }

  // ── Commit ────────────────────────────────────────────────────────────────
  // Detach the inner router so any request landing during the dispose+activate
  // window doesn't hit a half-disposed module (Express 404s / falls through in
  // that gap); the new router is installed at the end of activateOne below.
  if (innerRouters.has(name)) innerRouters.set(name, null);
  if (handle?.dispose) {
    try { await handle.dispose(); }
    catch (e) { return { ok: false, error: (e as Error).message }; }
  }
  activateOne(app, name, r.manifest!, (lvl, ...a) => (console[lvl] as Function)('[loader]', ...a), 'reload');
  const after = registry.get(name);
  if (after?.state !== 'active') return { ok: false, error: after?.error || 'unknown' };
  return { ok: true };
}

module.exports = { boot, reload, unload, enable, getActiveRequests, getReloadPosture, MODULES_JSON, MODULES_DIR };
