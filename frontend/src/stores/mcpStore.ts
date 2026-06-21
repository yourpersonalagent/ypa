// mcpStore — centralised /v1/mcp/ status polling.
//
// Previously BashConsole + KnowledgeButtons + prefs/tab-mcp each had their
// own setInterval(3s) polling /v1/mcp/, which produced 100+ hits/min on the
// rate limiter (the snapshot showed 112 hits in ~165 s). This store does
// reference-counted polling: the FIRST subscriber starts a single
// setInterval (5 s by default), the LAST unsubscribe stops it. All callers
// share the same `servers` snapshot via a Zustand selector, so they
// re-render together when the data refreshes.

import { create } from 'zustand';
import { isBridgeModuleEnabledStrict, useBridgeModulesStore } from '../host/bridge-modules.js';

export interface McpServer {
  name: string;
  ok: boolean;
  running?: boolean;
  configured?: boolean;
  error?: string | null;
  tools?: number;
  prompts?: number;
  resources?: number;
  pendingRequests?: number;
}

interface McpState {
  servers: McpServer[];
  loading: boolean;
  lastFetchedAt: number;
  lastError: string | null;
  _subscribers: number;
  _timer: ReturnType<typeof setInterval> | null;
  _inflight: Promise<void> | null;
  refresh: () => Promise<void>;
  subscribe: () => () => void;
  isRunning: (name: string) => boolean;
}

const POLL_MS = 5_000;

export const useMcpStore = create<McpState>((set, get) => ({
  servers: [],
  loading: false,
  lastFetchedAt: 0,
  lastError: null,
  _subscribers: 0,
  _timer: null,
  _inflight: null,

  refresh: async () => {
    const cur = get();
    if (cur._inflight) return cur._inflight;
    // Gate on either MCP bridge half being enabled. While both are off there's
    // no /v1/mcp endpoint to hit — silently skip rather than 404 every 5s.
    if (!isBridgeModuleEnabledStrict('mcp-client') && !isBridgeModuleEnabledStrict('mcp-servers')) {
      set({ servers: [], loading: false, lastError: null });
      return;
    }
    set({ loading: true });
    const p = (async () => {
      try {
        const r = await fetch('/v1/mcp/');
        if (!r.ok) {
          set({ loading: false, lastError: `HTTP ${r.status}`, _inflight: null });
          return;
        }
        const data = (await r.json()) as { servers?: McpServer[] } | McpServer[];
        const servers: McpServer[] = Array.isArray(data) ? data : data?.servers ?? [];
        set({ servers, loading: false, lastFetchedAt: Date.now(), lastError: null, _inflight: null });
      } catch (e) {
        set({ loading: false, lastError: e instanceof Error ? e.message : String(e), _inflight: null });
      }
    })();
    set({ _inflight: p });
    return p;
  },

  subscribe: () => {
    const { _subscribers, _timer, refresh } = get();
    const next = _subscribers + 1;
    set({ _subscribers: next });
    if (next === 1 && !_timer) {
      // Fire one fetch immediately so the new subscriber gets data without
      // waiting POLL_MS. Subsequent subscribers within the window will read
      // the cached `servers` directly.
      //
      // React mounts (via main-react.tsx) BEFORE main.ts awaits
      // fetchBridgeModulesOnce(), so the first subscriber typically arrives
      // while bridge-modules is still in 'unknown' state. In that case
      // refresh() would early-skip on the fail-closed gate, and the next
      // setInterval tick is POLL_MS away — leaving the bash-console header
      // button (gated on useMcpRunning) hidden for up to 5s after boot.
      // Defer the initial fetch until /v1/modules resolves to close that gap.
      const bm = useBridgeModulesStore.getState();
      if (bm.loadState !== 'unknown') {
        refresh();
      } else {
        const unsub = useBridgeModulesStore.subscribe((s) => {
          if (s.loadState === 'unknown') return;
          unsub();
          get().refresh();
        });
      }
      const id = setInterval(() => { get().refresh(); }, POLL_MS);
      set({ _timer: id });
    }
    return () => {
      const cur = get();
      const remaining = Math.max(0, cur._subscribers - 1);
      set({ _subscribers: remaining });
      if (remaining === 0 && cur._timer) {
        clearInterval(cur._timer);
        set({ _timer: null });
      }
    };
  },

  isRunning: (name: string) => {
    const s = get().servers.find((x) => x.name === name);
    return !!(s && (s.ok === true || s.running === true));
  },
}));

// React hook: subscribe on mount, unsubscribe on unmount. Returns the
// `servers` array directly so consumers can derive whatever they need.
import { useEffect } from 'react';

export function useMcpServers(): McpServer[] {
  const servers = useMcpStore((s) => s.servers);
  useEffect(() => {
    const unsub = useMcpStore.getState().subscribe();
    return unsub;
  }, []);
  return servers;
}

export function useMcpRunning(name: string): boolean {
  const servers = useMcpServers();
  const s = servers.find((x) => x.name === name);
  return !!(s && (s.ok === true || s.running === true));
}
