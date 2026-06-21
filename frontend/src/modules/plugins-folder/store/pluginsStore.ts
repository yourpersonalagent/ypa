// plugins-folder zustand store.
//
// `activations` is plugin-keyed: the user toggles a plugin on/off and *all*
// of its tiles render together. We migrate any legacy tileKey entries
// (`plugin/tile`) by collapsing them to their plugin name on load.

import { create } from 'zustand';
import type { PluginManifest, ScanResult } from '../bridge/api.js';

const LS_KEY = 'yha.plugins.activations.v1';
const LS_TRUST_KEY = 'yha.plugins.trust.v1';
const LS_ORDER_KEY = 'yha.plugins.order.v1';

type PerCwd = Record<string, string[]>;
type TrustState = Record<string, 'allow' | 'deny'>;

function loadActivations(): PerCwd {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: PerCwd = {};
    for (const [cwd, keys] of Object.entries(parsed)) {
      if (typeof cwd !== 'string' || !Array.isArray(keys)) continue;
      const seen = new Set<string>();
      const list: string[] = [];
      for (const k of keys) {
        if (typeof k !== 'string') continue;
        const plugin = k.includes('/') ? k.split('/', 1)[0] : k;
        if (!plugin || seen.has(plugin)) continue;
        seen.add(plugin);
        list.push(plugin);
      }
      out[cwd] = list;
    }
    return out;
  } catch {
    return {};
  }
}

function saveActivations(state: PerCwd): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch { /* quota */ }
}

function loadTrust(): TrustState {
  try {
    const raw = localStorage.getItem(LS_TRUST_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: TrustState = {};
    for (const [cwd, val] of Object.entries(parsed)) {
      if (typeof cwd !== 'string') continue;
      if (val === 'allow' || val === 'deny') out[cwd] = val;
    }
    return out;
  } catch {
    return {};
  }
}

function saveTrust(state: TrustState): void {
  try { localStorage.setItem(LS_TRUST_KEY, JSON.stringify(state)); } catch { /* quota */ }
}

function loadOrder(): PerCwd {
  try {
    const raw = localStorage.getItem(LS_ORDER_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const out: PerCwd = {};
    for (const [cwd, names] of Object.entries(parsed)) {
      if (typeof cwd !== 'string' || !Array.isArray(names)) continue;
      out[cwd] = names.filter((n) => typeof n === 'string');
    }
    return out;
  } catch {
    return {};
  }
}

function saveOrder(state: PerCwd): void {
  try { localStorage.setItem(LS_ORDER_KEY, JSON.stringify(state)); } catch { /* quota */ }
}

interface PluginsStoreState {
  cwd: string | null;
  manifest: ScanResult | null;
  loading: boolean;
  error: string | null;
  dropdownOpen: boolean;
  activations: PerCwd;
  trust: TrustState;
  /** Per-CWD plugin name ordering. Names absent from the list fall through to
   *  manifest order (appended). Updated whenever the user reorders. */
  pluginOrder: PerCwd;
  /** Reload tick per `cwd|plugin|tile`. Bumped by the tile's reload button so
   *  every consumer of that tile's data (the tile itself, the header quickinfo,
   *  any future widget) re-fetches in lockstep. Not persisted. */
  tileReloadTicks: Record<string, number>;

  setCwd: (cwd: string | null) => void;
  setManifest: (m: ScanResult | null) => void;
  setLoading: (b: boolean) => void;
  setError: (e: string | null) => void;
  setDropdownOpen: (b: boolean) => void;
  toggleDropdown: () => void;
  /** Toggle a plugin's activation. When on, every tile in the plugin renders. */
  togglePluginActivation: (cwd: string, plugin: string) => void;
  isPluginActive: (cwd: string | null, plugin: string) => boolean;
  /** Force a plugin into the active set (idempotent). Used by command-palette
   *  entry points so opening a tile auto-activates its plugin. */
  activatePlugin: (cwd: string, plugin: string) => void;
  /** "allow"/"deny" once decided; undefined means undecided → show prompt. */
  trustFor: (cwd: string | null) => 'allow' | 'deny' | undefined;
  setTrust: (cwd: string, value: 'allow' | 'deny') => void;
  clearTrust: (cwd: string) => void;
  /** Move plugin `name` up or down in the CWD-scoped order. The full plugin
   *  list at the time of the call seeds the order when none has been set. */
  movePlugin: (cwd: string, name: string, dir: -1 | 1, all: string[]) => void;
  /** Bump the reload tick for one tile so every subscriber re-fetches. */
  bumpTileReload: (cwd: string, plugin: string, tile: string) => void;
}

export function tileReloadKey(cwd: string, plugin: string, tile: string): string {
  return `${cwd}|${plugin}|${tile}`;
}

export const usePluginsStore = create<PluginsStoreState>((set, get) => ({
  cwd: null,
  manifest: null,
  loading: false,
  error: null,
  dropdownOpen: false,
  activations: loadActivations(),
  trust: loadTrust(),
  pluginOrder: loadOrder(),
  tileReloadTicks: {},

  setCwd: (cwd) => set({ cwd }),
  setManifest: (m) => set({ manifest: m }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  setDropdownOpen: (b) => set({ dropdownOpen: b }),
  toggleDropdown: () => set({ dropdownOpen: !get().dropdownOpen }),

  togglePluginActivation: (cwd, plugin) => {
    const cur = new Set(get().activations[cwd] || []);
    if (cur.has(plugin)) cur.delete(plugin); else cur.add(plugin);
    const next = { ...get().activations, [cwd]: [...cur] };
    saveActivations(next);
    set({ activations: next });
  },

  isPluginActive: (cwd, plugin) => {
    if (!cwd) return false;
    const list = get().activations[cwd];
    return !!list && list.includes(plugin);
  },

  activatePlugin: (cwd, plugin) => {
    const cur = new Set(get().activations[cwd] || []);
    if (cur.has(plugin)) return;
    cur.add(plugin);
    const next = { ...get().activations, [cwd]: [...cur] };
    saveActivations(next);
    set({ activations: next });
  },

  trustFor: (cwd) => (cwd ? get().trust[cwd] : undefined),
  setTrust: (cwd, value) => {
    const next = { ...get().trust, [cwd]: value };
    saveTrust(next);
    set({ trust: next });
  },
  clearTrust: (cwd) => {
    const next = { ...get().trust };
    delete next[cwd];
    saveTrust(next);
    set({ trust: next });
  },

  bumpTileReload: (cwd, plugin, tile) => {
    const key = tileReloadKey(cwd, plugin, tile);
    const cur = get().tileReloadTicks[key] || 0;
    set({ tileReloadTicks: { ...get().tileReloadTicks, [key]: cur + 1 } });
  },

  movePlugin: (cwd, name, dir, all) => {
    const seed = get().pluginOrder[cwd];
    // Seed with manifest order; append any names not yet present.
    const base = seed && seed.length ? [...seed] : [];
    for (const n of all) if (!base.includes(n)) base.push(n);
    const idx = base.indexOf(name);
    if (idx < 0) return;
    const swap = idx + dir;
    if (swap < 0 || swap >= base.length) return;
    [base[idx], base[swap]] = [base[swap], base[idx]];
    const next = { ...get().pluginOrder, [cwd]: base };
    saveOrder(next);
    set({ pluginOrder: next });
  },
}));

export function tileKey(plugin: string, tile: string): string {
  return `${plugin}/${tile}`;
}

/** Order plugins by the user's per-CWD ordering. Plugins not yet present in
 *  the stored order are appended in manifest order. Stable for plugins that
 *  appear/disappear between manifest scans. */
export function getOrderedPlugins(
  plugins: PluginManifest[],
  order: string[] | undefined,
): PluginManifest[] {
  if (!order || order.length === 0) return plugins;
  const byName = new Map(plugins.map((p) => [p.name, p]));
  const seen = new Set<string>();
  const out: PluginManifest[] = [];
  for (const name of order) {
    const p = byName.get(name);
    if (p && !seen.has(name)) { out.push(p); seen.add(name); }
  }
  for (const p of plugins) if (!seen.has(p.name)) out.push(p);
  return out;
}
