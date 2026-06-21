// serveStore — runtime state for the per-CWD live-preview tool. Mirrors what
// the bridge owns at /v1/serve/* but holds only what the UI needs to render
// quickly. Persistent profile choices live in store.ts (serveProfiles).
//
// The bridge owns the source of truth; this store is a refresh-on-demand cache.

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { useAppStore } from './appStore.js';
import { useSessionStore } from './sessionStore.js';

export type ServeProfile = 'static' | 'python' | 'node' | 'php' | 'custom';
export type ServeStatus  = 'idle' | 'starting' | 'ready' | 'error';

export interface ServeEntryPublic {
  id: string;
  cwd: string;
  profile: ServeProfile;
  cmdLine: string;
  port: number;
  startedAt: number;
  lastTouched: number;
  sessionId: string | null;
  keepAlive: boolean;
  status: 'starting' | 'ready' | 'error' | 'stopped';
  errorMsg?: string;
  expiresAt: number | null;
  proxyPath: string;
  legacyProxyPath?: string;
  shares?: ServeSharePublic[];
  stats?: ServeStatsPublic;
}

export interface ServeSharePublic {
  token: string;
  serveId: string;
  createdAt: number;
  expiresAt: number | null;
  revokedAt?: number;
  active?: boolean;
  publicPath?: string;
}

export interface ServeStatsPublic {
  hits: number;
  pageViews: number;
  lastViewedAt: number | null;
  byIp: Record<string, { hits: number; pageViews: number; lastViewedAt: number }>;
  recent: Array<{ at: number; ip: string; method: string; path: string; shareToken?: string }>;
}

export interface ServeRuntimes {
  python: boolean;
  node: boolean;
  php: boolean;
}

export interface ServeState {
  entry: ServeEntryPublic | null;     // current cwd's server, if any
  status: ServeStatus;
  errorMsg: string;
  runtimes: ServeRuntimes;
}

export interface ServeActions {
  refresh:    (cwd: string | null) => Promise<void>;
  start:      (cwd: string, profile: ServeProfile, cmdLine?: string, keepAlive?: boolean, ttlMs?: number | null) => Promise<ServeEntryPublic | null>;
  stop:       (id: string) => Promise<void>;
  touch:      (id: string) => Promise<void>;
  setKeepAlive: (id: string, keepAlive: boolean) => Promise<void>;
}

type ServeStore = ServeState & ServeActions;

async function jsonFetch(url: string, init?: RequestInit): Promise<any> {
  const res = await fetch(url, { credentials: 'same-origin', ...init });
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const j = await res.json(); if (j?.error) msg = j.error; } catch {}
    throw new Error(msg);
  }
  return res.json();
}

export const useServeStore = create<ServeStore>()(devtools((set, get) => ({
  entry: null,
  status: 'idle',
  errorMsg: '',
  runtimes: { python: true, node: true, php: false },

  refresh: async (cwd) => {
    if (!cwd) {
      set({ entry: null, status: 'idle', errorMsg: '' });
      return;
    }
    try {
      const data = await jsonFetch('/v1/serve/status?cwd=' + encodeURIComponent(cwd));
      const entry: ServeEntryPublic | null = data.entry || null;
      const status: ServeStatus = entry
        ? (entry.status === 'starting' ? 'starting'
          : entry.status === 'error'   ? 'error'
          : entry.status === 'ready'   ? 'ready'
          : 'idle')
        : 'idle';
      set({ entry, status, errorMsg: entry?.errorMsg || '' });
    } catch (e) {
      set({ entry: null, status: 'error', errorMsg: (e as Error).message });
    }
  },

  start: async (cwd, profile, cmdLine, keepAlive, ttlMs) => {
    // appStore.currentSession is the source-of-truth set by route changes;
    // sessionStore.currentId mirrors it but several boot paths populate one
    // without the other (see frontend-stores/F-001 for the broader drift),
    // so reading sessionStore here would tag the serve runtime with the
    // previous tab's session after a quick session-switch.
    const appCurrent = useAppStore.getState().currentSession;
    const sessionId = (appCurrent != null && appCurrent !== 0 && appCurrent !== '')
      ? String(appCurrent)
      : (useSessionStore.getState().currentId || null);
    set({ status: 'starting', errorMsg: '' });
    try {
      const data = await jsonFetch('/v1/serve/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, profile, cmdLine, sessionId, keepAlive: !!keepAlive, ttlMs: ttlMs === undefined ? 60 * 60_000 : ttlMs }),
      });
      const entry: ServeEntryPublic = data.entry;
      set({ entry, status: entry.status === 'error' ? 'error' : 'starting', errorMsg: entry.errorMsg || '' });
      return entry;
    } catch (e) {
      set({ entry: null, status: 'error', errorMsg: (e as Error).message });
      return null;
    }
  },

  stop: async (id) => {
    try { await jsonFetch('/v1/serve/stop/' + encodeURIComponent(id), { method: 'POST' }); } catch (_) {}
    set({ entry: null, status: 'idle', errorMsg: '' });
  },

  touch: async (id) => {
    try { await jsonFetch('/v1/serve/touch/' + encodeURIComponent(id), { method: 'POST' }); } catch (_) {}
  },

  setKeepAlive: async (id, keepAlive) => {
    try {
      await jsonFetch('/v1/serve/keep-alive/' + encodeURIComponent(id), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keepAlive }),
      });
    } catch (_) {}
    const cur = get().entry;
    if (cur && cur.id === id) set({ entry: { ...cur, keepAlive } });
  },
}), { name: 'ServeStore' }));

export function getServeState(): ServeState   { return useServeStore.getState(); }
export function getServeActions(): ServeActions { return useServeStore.getState(); }

// One-time runtime probe at boot.
export async function probeServeRuntimes(): Promise<void> {
  try {
    const data = await jsonFetch('/v1/serve/runtimes');
    if (data?.runtimes) useServeStore.setState({ runtimes: data.runtimes });
  } catch (_) {}
}

// Wire active-session + cwd-change push to the bridge so the reaper sees them.
// Called once during boot from a side-effect component (AppEffects or similar).
let _wired = false;
export function wireServeSessionTracking(): void {
  if (_wired) return;
  _wired = true;

  const post = (sessionId: string | null) => {
    fetch('/v1/serve/active-session', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    }).catch(() => {});
  };

  // Push initial active-session id, then on every session change.
  let prevSession = useSessionStore.getState().currentId || null;
  post(prevSession);
  useSessionStore.subscribe((state) => {
    const id = state.currentId || null;
    if (id === prevSession) return;
    prevSession = id;
    post(id);
  });

  // Refresh entry whenever the session-bound cwd changes.
  let prevCwd = useAppStore.getState().sessionWorkingDir;
  useServeStore.getState().refresh(prevCwd);
  useAppStore.subscribe((state) => {
    if (state.sessionWorkingDir === prevCwd) return;
    prevCwd = state.sessionWorkingDir;
    useServeStore.getState().refresh(prevCwd);
  });
}
