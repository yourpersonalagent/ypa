// `/v1/modules` — read + reload control surface.
//
// GET   /v1/modules           list all known modules + state (+ enabled flag from modules.json)
// GET   /v1/modules/:name     one module's manifest + state
// PATCH /v1/modules/:name     flip { enabled } in modules.json and apply
//                              the change live when the module's lifecycle
//                              allows it; otherwise fall back to restartRequired
// POST  /v1/modules/:name/reload   hot reload (admin auth)
// GET   /v1/registers         list of declared registers + entry counts
'use strict';

const fs = require('fs');
const registry = require('./registry');
const { reload, unload, enable, getActiveRequests, getReloadPosture, MODULES_JSON } = require('./loader');
const { listRegisters, getRegister } = require('../registers');

interface ModulesJsonEntry {
  name: string;
  enabled?: boolean;
  version?: string;
  config?: Record<string, unknown>;
}

function readModulesJsonSafe(): { modules: ModulesJsonEntry[] } {
  try {
    const raw = JSON.parse(fs.readFileSync(MODULES_JSON, 'utf8'));
    if (raw && Array.isArray(raw.modules)) return raw;
  } catch { /* ignore */ }
  return { modules: [] };
}

function writeModulesJson(next: { modules: ModulesJsonEntry[] }): void {
  // Preserve top-level $schema / _doc keys if present.
  let preserved: Record<string, unknown> = {};
  try {
    const raw = JSON.parse(fs.readFileSync(MODULES_JSON, 'utf8'));
    if (raw && typeof raw === 'object') {
      for (const k of Object.keys(raw)) if (k !== 'modules') preserved[k] = raw[k];
    }
  } catch { /* ignore */ }
  const out = { ...preserved, modules: next.modules };
  fs.writeFileSync(MODULES_JSON, JSON.stringify(out, null, 2) + '\n', 'utf8');
}

function registerModuleRoutes(app: import('express').Application): void {
  app.get('/v1/modules', (_req: any, res: any) => {
    const cfg = readModulesJsonSafe();
    const enabledByName = new Map(cfg.modules.map((m) => [m.name, m.enabled !== false] as const));
    res.json({
      success: true,
      modules: registry.listAll().map((h: any) => ({
        name: h.name,
        state: h.state,
        version: h.manifest?.version,
        kind: h.manifest?.kind,
        core: h.manifest?.core === true,
        needs: h.manifest?.needs || [],
        description: h.manifest?.description || '',
        category: h.manifest?.category || '',
        loadedAt: h.loadedAt || null,
        error: h.error || null,
        enabled: enabledByName.has(h.name) ? enabledByName.get(h.name) : true,
        // Reload posture — read by the file-watcher and yha-reload skill so
        // the model knows what's safe to edit live vs what needs a restart.
        reload: getReloadPosture(h.manifest),
        activeRequests: getActiveRequests(h.name),
      })),
      // Also surface modules.json entries that failed to load AND aren't in the registry.
      configured: cfg.modules.map((m) => ({ name: m.name, enabled: m.enabled !== false })),
    });
  });

  app.get('/v1/modules/:name', (req: any, res: any) => {
    const h = registry.get(req.params.name);
    if (!h) return res.status(404).json({ success: false, error: 'not found' });
    res.json({
      success: true,
      module: {
        name: h.name,
        state: h.state,
        manifest: h.manifest,
        loadedAt: h.loadedAt || null,
        error: h.error || null,
      },
    });
  });

  app.patch('/v1/modules/:name', async (req: any, res: any) => {
    const name = String(req.params.name || '');
    const body = (req.body || {}) as { enabled?: unknown };
    if (typeof body.enabled !== 'boolean') {
      return res.status(400).json({ success: false, error: 'body must be { enabled: boolean }' });
    }
    const next = body.enabled;
    const handle = registry.get(name);
    if (handle?.manifest?.core === true) {
      return res.status(409).json({ success: false, error: 'core modules cannot be disabled' });
    }
    const cfg = readModulesJsonSafe();
    const idx = cfg.modules.findIndex((m) => m.name === name);
    if (idx < 0) {
      return res.status(404).json({ success: false, error: `"${name}" not in modules.json` });
    }
    cfg.modules[idx] = { ...cfg.modules[idx], enabled: next };
    try { writeModulesJson(cfg); }
    catch (e) { return res.status(500).json({ success: false, error: (e as Error).message }); }

    // Attempt the live transition. If anything refuses the hot path
    // (lifecycle.reload="never", busy idle-only module, kind has a static FE
    // half) we still leave the modules.json change in place and tell the
    // caller a restart is required to fully apply.
    //
    // Kind notes:
    //   - bridge / mcp-server: hot toggle is fully effective.
    //   - both: bridge half hot-toggles; the FE half is gated by the boot-
    //     time read in frontend/src/host/enabled-modules.ts, so the FE
    //     surface won't change until the user reloads the page.
    //   - frontend: nothing to do on the bridge; the FE half is static.
    let hot = false;
    let hotError: string | undefined;
    const kind = handle?.manifest?.kind;
    const feOnly = kind === 'frontend';
    if (next === false) {
      if (!handle || handle.state !== 'active') {
        hot = true;
      } else if (feOnly) {
        // Pure-FE module has no bridge surface to detach — flipping the
        // registry chip is the entirety of what the bridge can do. From the
        // bridge's perspective this is "fully applied"; the FE side is
        // handled by feReloadRequired below.
        registry.set({ name, state: 'disabled', manifest: handle.manifest });
        hot = true;
      } else {
        const r = await unload(name, app);
        hot = r.ok;
        if (!r.ok) hotError = r.error;
      }
    } else {
      if (handle && handle.state === 'active') {
        hot = true;
      } else if (feOnly) {
        // Same as disable: nothing to do on bridge. Re-mark the registry
        // entry active if we still have its manifest.
        if (handle) registry.set({ name, state: 'active', manifest: handle.manifest });
        hot = true;
      } else {
        const r = await enable(name, app);
        hot = r.ok;
        if (!r.ok) hotError = r.error;
      }
    }

    res.json({
      success: true,
      name,
      enabled: next,
      hot,
      restartRequired: !hot,
      hotError: hotError || null,
      // FE half is statically imported; signal to the UI that a page reload
      // (not a bridge restart) is needed to update the FE surface.
      feReloadRequired: kind === 'frontend' || kind === 'both',
    });
  });

  app.post('/v1/modules/:name/reload', async (req: any, res: any) => {
    const h = registry.get(req.params.name);
    if (!h) return res.status(404).json({ success: false, error: 'not found' });
    const posture = getReloadPosture(h.manifest);
    if (posture === 'never') {
      return res.status(409).json({
        success: false,
        error: 'module declares lifecycle.reload="never"; restart required',
        reload: posture,
      });
    }
    // ?force=1 lets the model override the idle check after explicit user
    // approval. Without it, idle-only modules with in-flight requests get a
    // soft 409 with a retry hint instead of breaking those requests.
    const force = String(req.query?.force || '') === '1';
    if (posture === 'idle-only' && !force) {
      const active = getActiveRequests(req.params.name);
      if (active > 0) {
        return res.status(409).json({
          success: false,
          error: `module is idle-only with ${active} in-flight request(s); retry when idle or pass ?force=1`,
          reload: posture,
          activeRequests: active,
        });
      }
    }
    const result = await reload(req.params.name, app);
    if (!result.ok) return res.status(500).json({ success: false, error: result.error });
    res.json({ success: true, reload: posture });
  });

  app.get('/v1/registers', (_req: any, res: any) => {
    const ids = listRegisters();
    res.json({
      success: true,
      registers: ids.map((id: string) => {
        const r = getRegister(id);
        return { id, size: r ? r.size() : 0 };
      }),
    });
  });
}

module.exports = { registerModuleRoutes };
