// In-memory registry of loaded modules.
//
// One source of truth used by the loader (to avoid double-load), the
// reload endpoint (to find the handle), and `/v1/modules` (to render
// the status payload).
'use strict';

interface ModuleHandle {
  name: string;
  state: 'pending' | 'active' | 'failed' | 'disabled';
  manifest: import('./manifest-schema').Manifest;
  /** Result of factory.activate(); preserved for diagnostics. */
  api?: unknown;
  /** Free disposer — called by lifecycle on deactivate. */
  dispose?: () => Promise<void>;
  /** Last error message if state === 'failed'. */
  error?: string;
  loadedAt?: number;
}

const handles = new Map<string, ModuleHandle>();

function set(h: ModuleHandle) { handles.set(h.name, h); }
function get(name: string): ModuleHandle | undefined { return handles.get(name); }
function remove(name: string): boolean { return handles.delete(name); }
function listAll(): ReadonlyArray<ModuleHandle> {
  return [...handles.values()].sort((a, b) => a.name.localeCompare(b.name));
}
function clear() { handles.clear(); }

module.exports = { set, get, remove, listAll, clear };
