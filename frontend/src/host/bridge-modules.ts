// Bridge module enablement state for the FE.
//
// `bridge/modules.json` is the source of truth for which bridge-side
// modules load. The bridge exposes that list (plus live registry state)
// at `GET /v1/modules`. The FE needs to read it for two reasons:
//
//   1. Frontend modules with a bridge counterpart (pet, todos,
//      welcome-messages) shouldn't activate their FE half if the
//      bridge half is disabled — otherwise the floating pet still
//      appears, etc., even though every API call 404s.
//
//   2. Non-modular FE features that depend on a bridge module
//      (workflow editor, triggers panel, debug modal, …) should be
//      hidden when their backing module is disabled.
//
// During loading and on fetch failure we fail OPEN — every module
// reports as enabled. That avoids hiding the entire UI while the
// fetch resolves (or if /v1/modules itself is broken / 401).
//
// Once the bridge responds, components subscribed via the hook
// re-render and gated features either appear or disappear.

import { create } from 'zustand';

type LoadState = 'unknown' | 'loaded' | 'error';

interface BridgeModulesState {
  loadState: LoadState;
  /** name → enabled (only present once loaded). Names not in the map
   *  are treated as "unknown to the bridge" and pass through enabled. */
  byName: Map<string, boolean>;
}

interface BridgeModulesActions {
  setLoaded: (entries: Array<{ name: string; enabled: boolean }>) => void;
  setError: () => void;
}

type Store = BridgeModulesState & BridgeModulesActions;

export const useBridgeModulesStore = create<Store>()((set) => ({
  loadState: 'unknown',
  byName: new Map(),
  setLoaded: (entries) => {
    const m = new Map<string, boolean>();
    for (const e of entries) m.set(e.name, e.enabled !== false);
    set({ loadState: 'loaded', byName: m });
  },
  setError: () => set({ loadState: 'error' }),
}));

interface ModulesResponse {
  modules?: Array<{ name: string; enabled?: boolean }>;
  configured?: Array<{ name: string; enabled?: boolean }>;
}

let inFlight: Promise<void> | null = null;

/**
 * Fetch /v1/modules once and populate the store. Subsequent calls
 * return the same in-flight promise (so module activation and main.ts
 * boot both await the same fetch). Safe on 401 — falls through as
 * "error" and the fail-open policy kicks in.
 */
// One-shot dedupe so a transient outage on boot doesn't spam the log /
// surface multiple toasts. Cleared if a later fetch succeeds, so a brief
// bridge restart later in the same session can re-trip a fresh warning.
let _fetchFailureWarned = false;

const MODULES_FETCH_TIMEOUT_MS = 2500;

function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit = {}, timeoutMs = MODULES_FETCH_TIMEOUT_MS): Promise<Response> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), timeoutMs);
  return fetch(input, { ...init, signal: ctrl.signal })
    .finally(() => window.clearTimeout(timer));
}

export function fetchBridgeModulesOnce(): Promise<void> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    let surfacedError: string | null = null;
    try {
      const r = await fetchWithTimeout('/v1/modules', { credentials: 'same-origin' });
      if (!r.ok) {
        useBridgeModulesStore.getState().setError();
        surfacedError = `HTTP ${r.status}`;
        return;
      }
      const d = (await r.json()) as ModulesResponse;
      // Prefer the registry view (`modules`) when present — it carries
      // the actual loaded state. Fall back to `configured` for entries
      // that didn't make it into the registry. The two lists overlap
      // for modules in modules.json; we de-dupe by name.
      const merged = new Map<string, boolean>();
      for (const c of d.configured || []) merged.set(c.name, c.enabled !== false);
      for (const m of d.modules || []) merged.set(m.name, m.enabled !== false);
      useBridgeModulesStore.getState().setLoaded(
        [...merged.entries()].map(([name, enabled]) => ({ name, enabled })),
      );
      _fetchFailureWarned = false; // success — re-arm so a later outage can re-toast
    } catch (e) {
      useBridgeModulesStore.getState().setError();
      surfacedError = e instanceof Error ? e.message : String(e);
    } finally {
      // Fail-open behaviour stays — `isBridgeModuleEnabled` still returns
      // true on error so modules don't disappear behind a network blip.
      // But a silent fail-open hides bridge outages from the user, so
      // surface the first failure per process via console.warn + a toast.
      if (surfacedError && !_fetchFailureWarned) {
        _fetchFailureWarned = true;
        console.warn('[bridge-modules] /v1/modules fetch failed — fail-open:', surfacedError);
        try {
          const { getToastActions } = await import('../stores/toastStore.js');
          getToastActions().show(
            'Bridge offline — module gating disabled until reconnect.',
            'warning',
            { duration: 8000 },
          );
        } catch (_) { /* toast store may not be ready on early-boot races */ }
      }
      // Do not permanently pin the tab to the first failed /v1/modules
      // attempt. On boot races, auth redirects, bridge restarts, or a busy
      // stream pipeline, the original promise can fail/timeout before the
      // bridge is actually usable. Clearing it lets later callers retry and
      // lets dynamic module surfaces (prefs tabs, GitHub modal, etc.) recover
      // without a hard reload.
      if (surfacedError) inFlight = null;
    }
  })();
  return inFlight;
}

// One-shot dedupe for the "called during loading" warning so a poll loop
// doesn't spam the console. Keyed by module name — each name warns at most
// once per process lifetime.
const _failOpenLeakWarned = new Set<string>();

/**
 * Sync check used in non-React paths (boot scripts, init() calls).
 * Fails OPEN while loading or on error so we don't accidentally hide
 * the whole UI behind a network failure.
 *
 * IMPORTANT: this is intentionally permissive during the unknown→loaded
 * window. Callers that gate heavy init / network fetches against a
 * specific BRIDGE_LINKED module should use `isBridgeModuleEnabledStrict`
 * (sync, fail-closed) or `whenBridgeModuleEnabled` (deferred-once-loaded)
 * instead, otherwise the work fires before we know whether the bridge
 * half is actually enabled. A one-shot console.warn surfaces here when
 * the loading-window path is hit so the leak is visible during dev.
 */
export function isBridgeModuleEnabled(name: string): boolean {
  const s = useBridgeModulesStore.getState();
  if (s.loadState !== 'loaded') {
    if (!_failOpenLeakWarned.has(name)) {
      _failOpenLeakWarned.add(name);
      console.warn(
        `[bridge-modules] isBridgeModuleEnabled("${name}") called before /v1/modules resolved — returning true (fail-open). ` +
        `If this gates init work, switch to isBridgeModuleEnabledStrict() or whenBridgeModuleEnabled().`,
      );
    }
    return true;
  }
  if (!s.byName.has(name)) return true;
  return s.byName.get(name) === true;
}

/**
 * React hook — re-renders when the store transitions
 * unknown→loaded or when /v1/modules is re-fetched.
 */
export function useBridgeModuleEnabled(name: string): boolean {
  return useBridgeModulesStore((s) => {
    if (s.loadState !== 'loaded') return true;
    if (!s.byName.has(name)) return true;
    return s.byName.get(name) === true;
  });
}

/**
 * Like useBridgeModuleEnabled but fail-CLOSED while the store is loading.
 * Use this to gate network fetches against module-specific endpoints — the
 * fail-open default would briefly fire 404s for disabled modules during the
 * unknown→loaded transition. Returns false until /v1/modules has resolved.
 */
export function useBridgeModuleEnabledStrict(name: string): boolean {
  return useBridgeModulesStore((s) => {
    if (s.loadState !== 'loaded') return false;
    if (!s.byName.has(name)) return false;
    return s.byName.get(name) === true;
  });
}

/**
 * Sync, fail-CLOSED variant of `isBridgeModuleEnabled`. Returns false while
 * the store is still loading. Use inside fetch callbacks (poll loops,
 * one-shot fetches) so disabled modules never produce 404s during the
 * unknown→loaded transition.
 */
export function isBridgeModuleEnabledStrict(name: string): boolean {
  const s = useBridgeModulesStore.getState();
  if (s.loadState !== 'loaded') return false;
  if (!s.byName.has(name)) return false;
  return s.byName.get(name) === true;
}

/**
 * Run `fn()` once, deferred until /v1/modules has resolved AND `name` is
 * enabled on the bridge. If the store is already loaded, runs immediately
 * (sync) when enabled, or never when disabled. Returns an unsubscribe
 * function so callers can cancel a still-pending wait.
 *
 * Use this for boot-time wires (active-session push, runtime probes,
 * one-shot config fetches) that target module-specific endpoints.
 */
export function whenBridgeModuleEnabled(name: string, fn: () => void): () => void {
  const s0 = useBridgeModulesStore.getState();
  if (s0.loadState === 'loaded') {
    if (s0.byName.get(name) === true) fn();
    return () => {};
  }
  const unsub = useBridgeModulesStore.subscribe((s) => {
    if (s.loadState !== 'loaded') return;
    unsub();
    if (s.byName.get(name) === true) fn();
  });
  return unsub;
}
