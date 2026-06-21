// store.ts — server-backed user settings store.
// Replaces direct localStorage reads/writes for all persisted preferences.
//
// Usage:
//   store.get('colorTheme')               → value from cache (LS fallback)
//   store.set('colorTheme', 'ocean-dark') → writes cache + LS + debounced save
//   await store.load()                    → fetch server prefs, update cache/LS/appStore
//
// localStorage acts as a write-through cache: instant paint on reload, correct
// values on new devices after first load.

import { useAppStore } from './stores/index.js';
import type { AppState } from './stores/index.js';
import { api } from './api.js';

export const store = (() => {
  const DEFAULTS: Record<string, unknown> = {
    colorTheme: 'default-dark',
    designTheme: 'console',
    layoutMode: 'full',
    viewMode: 'split',
    viewSplit: 0.5,
    viewOrient: 'h',
    viewSwap: false,
    headerOpen: true,
    overlayPos: 'bottom',
    effort: null,
    recordChat: 'all',
    harnessInstance: '',
    codexInstance: '',
    sysPrompt: { mode: 'off', preset: '' },
    model: null,
    favoriteModels: [],
    hiddenModels: [],
    skillSet: '',
    workflows: {},
    wfBindings: {},
    lastGraph: { nodes: [], links: [] },
    apiBase: '',
    prefsView: 'simple',
    prefsTab: 'stats',
    bgTheme: 'yha',
    serveProfiles: {} as Record<string, { profile: string; cmdLine?: string; keepAlive?: boolean }>,
    enterToSend: true,
    // YHA Net node registry. Each entry is one logical node addressable by
    // several identities (OS hostname / Tailscale MagicDNS / web URL) but keyed
    // by a stable `id`, so a chat scope can later be pinned to (node id +
    // absolute path) regardless of which address reaches it. See the yha-net
    // module (TabNodes.tsx) for the entry shape.
    yhaNetNodes: [] as unknown[],
  };

  // Legacy localStorage keys — used for migration and write-through cache
  const LS_MAP: Record<string, string> = {
    colorTheme: 'yha.colorTheme',
    designTheme: 'yha.designTheme',
    layoutMode: 'yha.layoutMode',
    viewMode: 'yha.viewMode',
    viewSplit: 'yha.viewSplit',
    viewOrient: 'yha.viewOrient',
    viewSwap: 'yha.viewSwap',
    headerOpen: 'yha.headerOpen',
    overlayPos: 'yha.overlayPos',
    effort: 'yha.effort',
    recordChat: 'yha.recordChat',
    harnessInstance: 'yha.harnessInstance',
    codexInstance: 'yha.codexInstance',
    sysPrompt: 'yha.sysPrompt',
    model: 'yha.model',
    favoriteModels: 'yha.favoriteModels',
    hiddenModels: 'yha.hiddenModels',
    skillSet: 'yha.skillSet',
    workflows: 'yha.workflows',
    wfBindings: 'yha.wf-bindings',
    lastGraph: 'yha.lastGraph',
    apiBase: 'yha.apiBase',
    prefsView: 'yha.prefsView',
    prefsTab: 'yha.prefsTab',
    bgTheme: 'yha.bgTheme',
    serveProfiles: 'yha.serveProfiles',
    enterToSend: 'yha.enterToSend',
    yhaNetNodes: 'yha.yhaNetNodes',
  };

  let _cache: Record<string, unknown> = {};
  let _dirty: Record<string, unknown> = {};
  let _saveTimer: ReturnType<typeof setTimeout> | null = null;

  function _lsRead(key: string): unknown {
    const lsKey = LS_MAP[key];
    if (!lsKey) return undefined;
    const raw = localStorage.getItem(lsKey);
    if (raw === null) return undefined;
    if (raw === 'true') return true;
    if (raw === 'false') return false;
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }

  function _lsWrite(key: string, val: unknown): void {
    const lsKey = LS_MAP[key];
    if (!lsKey) return;
    if (val === null || val === undefined) localStorage.removeItem(lsKey);
    else if (typeof val === 'object') localStorage.setItem(lsKey, JSON.stringify(val));
    else localStorage.setItem(lsKey, String(val));
  }

  // Seed cache from localStorage for instant paint (synchronous)
  function _initFromLS(): void {
    for (const key of Object.keys(DEFAULTS)) {
      const v = _lsRead(key);
      _cache[key] = v !== undefined ? v : DEFAULTS[key];
    }
    // Legacy migration: `yha.theme` predates the colorTheme rename. If the
    // new key is missing but the old one is set, adopt it. One-shot — once
    // `yha.colorTheme` is written by setColorTheme, this branch is dormant.
    if (_cache.colorTheme === DEFAULTS.colorTheme) {
      const legacy = localStorage.getItem('yha.theme');
      if (legacy) {
        _cache.colorTheme = legacy;
        _lsWrite('colorTheme', legacy);
        localStorage.removeItem('yha.theme');
      }
    }
  }

  // Fetch server prefs, merge into cache, write back to LS, update app.state.
  // Awaited in boot before any module init() runs.
  async function load(): Promise<Record<string, unknown>> {
    _initFromLS();
    try {
      const baseUrl = api.deriveBaseUrl() || window.location.origin;
      const res = await fetch(baseUrl + '/v1/prefs/');
      if (res.ok) {
        const data = (await res.json()) as { prefs?: Record<string, unknown> };
        if (data.prefs && typeof data.prefs === 'object') {
          for (const [key, val] of Object.entries(data.prefs)) {
            // Cache every server pref — filtering by DEFAULTS would silently
            // drop newly-introduced keys when an old bundle is still in use.
            _cache[key] = val;
            if (LS_MAP[key]) _lsWrite(key, val); // keep LS in sync for legacy reads
          }
          // Server-side legacy migration: prefer new `colorTheme` key; if the
          // server still holds the pre-rename `theme` key and the new one
          // isn't set, adopt the legacy value. Persisting under `colorTheme`
          // happens lazily on next setColorTheme.
          const prefs = data.prefs as Record<string, unknown>;
          if (prefs.theme && _cache.colorTheme === DEFAULTS.colorTheme && !prefs.colorTheme) {
            _cache.colorTheme = prefs.theme;
            _lsWrite('colorTheme', prefs.theme);
          }
          // Drop the legacy `theme` key so _applyToState doesn't re-apply it
          // after `colorTheme` and clobber the user's choice on every reload.
          delete _cache.theme;
        }
      }
    } catch (e) {
      console.warn('[store] load failed, using local cache:', (e as Error).message);
    }
    _applyToState();
    return _cache;
  }

  // Map a single key/value into the Zustand appStore (called lazily so the
  // store is always initialized before we touch it).
  function _pushKey(key: string, val: unknown): void {
    const a = useAppStore.getState();
    switch (key) {
      case 'colorTheme':      a.setColorTheme(val as AppState['colorTheme']); break;
      case 'designTheme':     a.setDesignTheme(val as AppState['designTheme']); break;
      case 'layoutMode':      a.setLayoutMode(val as AppState['layoutMode']); break;
      // Legacy: server pref `theme` predates the colorTheme rename. Adopt
      // the value through the new action so the canonical write path runs.
      case 'theme':           a.setColorTheme(val as AppState['colorTheme']); break;
      case 'viewMode':        a.setViewMode(val as AppState['viewMode']); break;
      case 'viewSplit':       a.setViewSplit(val as number); break;
      case 'viewOrient':      a.setViewOrient(val as 'h' | 'v'); break;
      case 'viewSwap':        a.setViewSwap(val as boolean); break;
      case 'headerOpen':      a.setHeaderOpen(val as boolean); break;
      case 'overlayPos':      a.setOverlayPos(val as string); break;
      case 'effort':          a.setEffort(val as string | null); break;
      case 'recordChat':      a.setRecordChat(val as AppState['recordChat']); break;
      case 'harnessInstance': a.setHarnessInstance(val as string); break;
      case 'codexInstance':   a.setCodexInstance(val as string); break;
      case 'sysPrompt':       a.setSysPrompt(val as AppState['sysPrompt']['selection']); break;
      case 'skillSet':        a.setSkillSet(val as string); break;
      case 'model':           if (val) a.setCurrentModel(val as AppState['currentModel']); break;
      case 'bgTheme':
        // bg.ts imports store.ts so we can't import it here — dispatch an event
        // instead. bg.ts.init() wires this listener so server prefs override LS.
        try { window.dispatchEvent(new CustomEvent('yha:store-bgtheme', { detail: { id: val } })); } catch { /* ignore */ }
        break;
      case 'enterToSend': a.setEnterToSend(val as boolean); break;
      // Other keys (workflows, wfBindings, lastGraph, apiBase, favoriteModels,
      // hiddenModels) have no corresponding appStore action.
    }
  }

  // Push current cache values into the Zustand appStore so init() functions
  // get server-loaded values.
  function _applyToState(): void {
    for (const key of Object.keys(_cache)) {
      if (_cache[key] !== undefined) _pushKey(key, _cache[key]);
    }
    api.config.baseUrl = api.deriveBaseUrl() || window.location.origin;
  }

  function get(key: string, fallback?: unknown): unknown {
    if (key in _cache) return _cache[key];
    return fallback !== undefined ? fallback : DEFAULTS[key];
  }

  function set(key: string, val: unknown): void {
    _cache[key] = val;
    _lsWrite(key, val);
    // Immediately push to Zustand so React subscribers get the value.
    _pushKey(key, val);
    _dirty[key] = val;
    if (_saveTimer !== null) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(_flush, 400);
  }

  // Serialize PATCH writes: a 400 ms-debounced flush is already in place,
  // but two flushes can still overlap when rapid edits (typing into a node
  // field, dragging a workflow link) keep firing set() during an in-flight
  // PATCH. The server applies overlapping PATCHes in arrival order, so the
  // later flush could overwrite the earlier one out-of-order. The chain
  // below makes each flush await the previous one before dispatching, so
  // dispatch order = completion order.
  let _flushChain: Promise<void> = Promise.resolve();

  async function _flush(): Promise<void> {
    const next = _flushChain.then(async () => {
      if (!Object.keys(_dirty).length) return;
      const patch = { ..._dirty };
      _dirty = {};
      try {
        const baseUrl =
          api.config.baseUrl ||
          api.deriveBaseUrl() ||
          window.location.origin;
        await fetch(baseUrl + '/v1/prefs/', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
      } catch (e) {
        console.warn('[store] save failed:', (e as Error).message);
      }
    });
    // Swallow rejection on the chain Promise so one failing flush doesn't
    // poison subsequent ones. Direct callers still see errors through
    // `next` itself (we return it below).
    _flushChain = next.catch(() => {});
    return next;
  }

  // Seed synchronously so store.get() is correct before load() resolves.
  // React effects (BgEffect, etc.) run before the async boot() await, so
  // without this the cache is empty and every get() falls back to DEFAULTS.
  _initFromLS();

  // Expose for immediate saves (e.g. before page unload)
  return { load, get, set, flush: _flush };
})();
