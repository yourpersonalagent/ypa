// Manifest schema validator for `module.json`.
//
// The plan (`YHA-modular-plan.md` §2.2) pins the manifest shape; this
// file is the single point of truth for what a manifest may contain.
// Validation is intentionally permissive on optional sub-keys
// (provides, lifecycle.*) — strict checks live in the loader where
// they have context to give helpful errors.
'use strict';

interface ManifestProvides {
  routes?: string[];
  configKeys?: string[];
  bridgeRegisters?: string[];   // ids that activate() will write to
  frontendRegisters?: string[];
  mcpServers?: string[];
  tools?: string[];
  skills?: string[];
}

type ReloadPosture = 'safe' | 'idle-only' | 'never';
type StatePosture = 'ephemeral' | 'migrate' | 'opaque';
type LayerKind = 'frontend' | 'bun' | 'go-core';

interface ManifestLifecycle {
  /** Can be hot-loaded/unloaded without restart. Legacy; prefer `reload`. */
  hot?: boolean;
  /**
   * Reload posture — read by the file-watcher and POST /v1/modules/:name/reload.
   *
   *   'safe'       — reload at any time (default for modules with no
   *                  long-lived state, child processes, or open streams).
   *   'idle-only'  — refuse reload while there are in-flight requests on
   *                  /v1/<name>; the watcher will retry until the module
   *                  goes idle. Use for modules holding SSE/WebSocket
   *                  connections or async work whose closures would break
   *                  if re-created underfoot.
   *   'never'      — process restart required (e.g. core middleware, code
   *                  that mutates global state on activate). Equivalent to
   *                  the legacy `hot: false` and takes priority over it.
   *
   * If unset: defaults to 'never' when `hot === false`, otherwise 'safe'.
   */
  reload?: ReloadPosture;
  /** Grace period for in-flight requests on deactivate (ms). */
  drainTimeoutMs?: number;
  /**
   * State-handling posture across a hot-swap (grill-plan §4.1, 16.2).
   *
   *   'ephemeral' — no state survives a swap; the new instance starts
   *                 cold. Default.
   *   'migrate'   — module ships a migration script (see `migrate`) the
   *                 loader runs to translate the old version's state blob
   *                 into the new one. A failed migration aborts the swap
   *                 and the old instance is held.
   *   'opaque'    — state exists but the loader cannot reason about it
   *                 (foreign process, native handle). Swap requires a
   *                 full restart; hot reload refuses.
   */
  state?: StatePosture;
  /**
   * Which runtime layer hosts this module's code. Default is inferred
   * from `kind` (`frontend` → 'frontend', anything else → 'bun'). Used
   * by the supervisor/swap path to pick the right reload mechanism.
   */
  layer?: LayerKind;
  /**
   * Relative path inside the module dir to an optional state-migration
   * script. Loader invokes it when `state === 'migrate'` and a prior
   * version's state blob exists. Ignored otherwise.
   */
  migrate?: string;
}

export interface Manifest {
  name: string;
  version: string;
  kind: 'bridge' | 'frontend' | 'both' | 'mcp-server';
  /** Pinned core: cannot be unloaded; loader rejects an attempt. */
  core?: boolean;
  /** Module names this depends on (loaded first). */
  needs?: string[];
  provides?: ManifestProvides;
  lifecycle?: ManifestLifecycle;
  /** Soft permissions; not enforced today, recorded for future sandbox. */
  permissions?: string[];
  /** Free-form description shown in /v1/modules. */
  description?: string;
  /**
   * Optional grouping label used by the preferences Modules tab to bucket
   * related modules together (e.g. "files", "chat", "mcp"). Kebab-case is
   * conventional but not enforced. When absent, the UI falls back to the
   * module name's prefix before the first dash.
   */
  category?: string;
}

const KINDS = new Set(['bridge', 'frontend', 'both', 'mcp-server']);

function validate(manifest: unknown, source: string): { ok: true; manifest: Manifest } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!manifest || typeof manifest !== 'object') {
    return { ok: false, errors: [`${source}: manifest must be an object`] };
  }
  const m = manifest as Record<string, unknown>;

  if (typeof m.name !== 'string' || !m.name) errors.push(`${source}: "name" required (string)`);
  else if (!/^[a-z][a-z0-9-]*$/.test(m.name)) errors.push(`${source}: "name" must be kebab-case (got "${m.name}")`);

  if (typeof m.version !== 'string' || !m.version) errors.push(`${source}: "version" required (string)`);

  if (typeof m.kind !== 'string' || !KINDS.has(m.kind as string)) {
    errors.push(`${source}: "kind" must be one of ${[...KINDS].join('|')}`);
  }

  if (m.needs !== undefined) {
    if (!Array.isArray(m.needs) || (m.needs as unknown[]).some((n) => typeof n !== 'string')) {
      errors.push(`${source}: "needs" must be string[]`);
    }
  }

  if (m.category !== undefined && typeof m.category !== 'string') {
    errors.push(`${source}: "category" must be a string`);
  }

  if (m.lifecycle !== undefined) {
    const l = m.lifecycle as Record<string, unknown>;
    if (l.drainTimeoutMs !== undefined && (typeof l.drainTimeoutMs !== 'number' || l.drainTimeoutMs < 0)) {
      errors.push(`${source}: "lifecycle.drainTimeoutMs" must be a non-negative number`);
    }
    if (l.reload !== undefined && !['safe', 'idle-only', 'never'].includes(l.reload as string)) {
      errors.push(`${source}: "lifecycle.reload" must be one of safe|idle-only|never`);
    }
    if (l.state !== undefined && !['ephemeral', 'migrate', 'opaque'].includes(l.state as string)) {
      errors.push(`${source}: "lifecycle.state" must be one of ephemeral|migrate|opaque`);
    }
    if (l.layer !== undefined && !['frontend', 'bun', 'go-core'].includes(l.layer as string)) {
      errors.push(`${source}: "lifecycle.layer" must be one of frontend|bun|go-core`);
    }
    if (l.migrate !== undefined && (typeof l.migrate !== 'string' || !l.migrate)) {
      errors.push(`${source}: "lifecycle.migrate" must be a non-empty string`);
    }
    if (l.state === 'migrate' && (l.migrate === undefined || l.migrate === '')) {
      errors.push(`${source}: "lifecycle.state"="migrate" requires "lifecycle.migrate" path`);
    }
  }

  if (errors.length) return { ok: false, errors };
  return { ok: true, manifest: m as unknown as Manifest };
}

export { validate };
