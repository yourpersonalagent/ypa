import { create } from 'zustand';
import type { CwdManagerEntry, CwdManagerSummary } from './types.js';

interface ApiListResponse {
  success: boolean;
  entries?: CwdManagerEntry[];
  summary?: CwdManagerSummary;
  error?: string;
}
interface ApiEntryResponse {
  success: boolean;
  entry?: CwdManagerEntry;
  error?: string;
}

interface CwdManagerState {
  byCwd: Record<string, CwdManagerEntry>;
  summary: CwdManagerSummary | null;
  loading: boolean;
  error: string | null;
  sseConnected: boolean;
  refresh: () => Promise<void>;
  refreshEntry: (cwd: string) => Promise<CwdManagerEntry | null>;
  toggle: (cwd: string, enabled: boolean) => Promise<CwdManagerEntry | null>;
  configure: (cwd: string, activeIntervalMs: number, agentEnabled?: boolean, workerEnabled?: boolean) => Promise<CwdManagerEntry | null>;
  setAgentEnabled: (cwd: string, enabled: boolean) => Promise<CwdManagerEntry | null>;
  setWorkerEnabled: (cwd: string, enabled: boolean) => Promise<CwdManagerEntry | null>;
  startWorker: (cwd: string, todoId?: string) => Promise<CwdManagerEntry | null>;
  tickNow: (cwd: string) => Promise<CwdManagerEntry | null>;
  applyEntry: (entry: Partial<CwdManagerEntry> & { cwd: string }) => void;
  setSseConnected: (connected: boolean) => void;
}

function base(): string {
  return (
    (window as Window & { API_CONFIG?: { baseUrl?: string } }).API_CONFIG?.baseUrl ||
    window.location.origin
  );
}

function entryUrl(cwd: string): string {
  return `${base()}/v1/cwd-manager/entry?cwd=${encodeURIComponent(cwd)}`;
}

async function readJson<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data?.success === false) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return data as T;
}

function upsertEntry(
  state: CwdManagerState,
  entry: Partial<CwdManagerEntry> & { cwd: string }
): Partial<CwdManagerState> {
  const previous = state.byCwd[entry.cwd];
  return {
    byCwd: { ...state.byCwd, [entry.cwd]: { ...(previous || {}), ...entry } as CwdManagerEntry },
    error: null,
  };
}

export const useCwdManagerStore = create<CwdManagerState>()((set) => ({
  byCwd: {},
  summary: null,
  loading: false,
  error: null,
  sseConnected: false,

  async refresh() {
    set({ loading: true, error: null });
    try {
      const data = await fetch(`${base()}/v1/cwd-manager`, { credentials: 'same-origin' }).then(
        (r) => readJson<ApiListResponse>(r)
      );
      const byCwd: Record<string, CwdManagerEntry> = {};
      for (const e of data.entries || []) byCwd[e.cwd] = e;
      set({ byCwd, summary: data.summary || null, loading: false, error: null });
    } catch (e) {
      set({ loading: false, error: e instanceof Error ? e.message : String(e) });
    }
  },

  async refreshEntry(cwd) {
    if (!cwd) return null;
    try {
      const data = await fetch(entryUrl(cwd), { credentials: 'same-origin' }).then((r) =>
        readJson<ApiEntryResponse>(r)
      );
      if (data.entry) set((s) => upsertEntry(s, data.entry!));
      return data.entry || null;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  },

  async toggle(cwd, enabled) {
    if (!cwd) return null;
    try {
      const data = await fetch(`${base()}/v1/cwd-manager/toggle`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, enabled }),
      }).then((r) => readJson<ApiEntryResponse>(r));
      if (data.entry) set((s) => upsertEntry(s, data.entry!));
      return data.entry || null;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  },

  async configure(cwd, activeIntervalMs, agentEnabled, workerEnabled) {
    if (!cwd) return null;
    try {
      const data = await fetch(`${base()}/v1/cwd-manager/config`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cwd,
          activeIntervalMs,
          ...(agentEnabled === undefined ? {} : { agentEnabled }),
          ...(workerEnabled === undefined ? {} : { workerEnabled }),
        }),
      }).then((r) => readJson<ApiEntryResponse>(r));
      if (data.entry) set((s) => upsertEntry(s, data.entry!));
      return data.entry || null;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  },

  async setAgentEnabled(cwd, enabled) {
    if (!cwd) return null;
    try {
      const data = await fetch(`${base()}/v1/cwd-manager/agent`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, enabled }),
      }).then((r) => readJson<ApiEntryResponse>(r));
      if (data.entry) set((s) => upsertEntry(s, data.entry!));
      return data.entry || null;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  },


  async setWorkerEnabled(cwd, enabled) {
    if (!cwd) return null;
    try {
      const data = await fetch(`${base()}/v1/cwd-manager/worker`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, enabled }),
      }).then((r) => readJson<ApiEntryResponse>(r));
      if (data.entry) set((s) => upsertEntry(s, data.entry!));
      return data.entry || null;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  },

  async startWorker(cwd, todoId) {
    if (!cwd) return null;
    try {
      const data = await fetch(`${base()}/v1/cwd-manager/start-worker`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, ...(todoId ? { todoId } : {}) }),
      }).then((r) => readJson<ApiEntryResponse>(r));
      if (data.entry) set((s) => upsertEntry(s, data.entry!));
      return data.entry || null;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  },

  async tickNow(cwd) {
    if (!cwd) return null;
    try {
      const data = await fetch(`${base()}/v1/cwd-manager/tick`, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd }),
      }).then((r) => readJson<ApiEntryResponse>(r));
      if (data.entry) set((s) => upsertEntry(s, data.entry!));
      return data.entry || null;
    } catch (e) {
      set({ error: e instanceof Error ? e.message : String(e) });
      return null;
    }
  },

  applyEntry(entry) {
    set((s) => upsertEntry(s, entry));
  },

  setSseConnected(connected) {
    set({ sseConnected: connected });
  },
}));

let es: EventSource | null = null;

export function startCwdManagerSse(): void {
  if (es) return;
  es = new EventSource(`${base()}/v1/triggers/events`);
  es.onopen = () => useCwdManagerStore.getState().setSseConnected(true);
  es.onerror = () => useCwdManagerStore.getState().setSseConnected(false);
  es.addEventListener('cwd-manager:status', (ev) => {
    try {
      const data = JSON.parse((ev as MessageEvent).data) as
        | { entry?: CwdManagerEntry }
        | CwdManagerEntry;
      const maybeWrapped = data as { entry?: CwdManagerEntry };
      const entry = maybeWrapped.entry || (data as CwdManagerEntry);
      if (entry && typeof entry.cwd === 'string') {
        const store = useCwdManagerStore.getState();
        store.applyEntry(entry);
        if (!store.byCwd[entry.cwd]) void store.refreshEntry(entry.cwd);
      }
    } catch (e) {
      console.warn('[cwd-manager] bad SSE payload:', e);
    }
  });
}

export function stopCwdManagerSse(): void {
  if (es) {
    es.close();
    es = null;
  }
  useCwdManagerStore.getState().setSseConnected(false);
}

export function getCwdManagerEntry(cwd: string | null | undefined): CwdManagerEntry | null {
  if (!cwd) return null;
  return useCwdManagerStore.getState().byCwd[cwd] || null;
}
