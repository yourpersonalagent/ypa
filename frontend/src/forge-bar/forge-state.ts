// Forge-bar polling state.
//
// The forge bar (Branch 11 of grill-session-plan.md §4.3) is conditional
// chrome — it materializes only when there's workshop state worth showing
// (an in-flight or just-finished module edit) or when a hot-swap broke a
// module (failed state). At rest it occupies zero pixels.
//
// Two data sources back the visibility decision:
//   1. /v1/modules — list of modules with their current state. Any module
//      reporting `state: "failed"` flips the bar into emergency mode.
//   2. /__rewind/api/edits?limit=1 — the most recent rewind record. When
//      its timestamp is within RECENT_EDIT_MS, the bar shows the "ambient
//      activity" pill so the user can see (and undo) the agent's last move.
//
// Polling is deliberate: the plan calls for an SSE topic on
// /v1/modules/events, but until that lands polling /v1/modules every few
// seconds is cheap and avoids new bridge plumbing. A future cut can swap
// the source without changing the consumer.

import { create } from 'zustand';

export interface FailedModule {
  name: string;
  error: string | null;
}

export interface RecentEdit {
  id: string;
  ts: number;
  module: string;
  trigger: string;
  fileCount: number;
  // Relative paths (to YHA install root) of files touched. Used by the file
  // editor toolbar to flag tabs whose underlying file was changed by an agent.
  paths: string[];
}

interface ForgeState {
  failedModules: FailedModule[];
  recentEdit: RecentEdit | null;
  setFailedModules: (list: FailedModule[]) => void;
  setRecentEdit: (edit: RecentEdit | null) => void;
}

export const useForgeStore = create<ForgeState>()((set) => ({
  failedModules: [],
  recentEdit: null,
  setFailedModules: (list) => set({ failedModules: list }),
  setRecentEdit: (edit) => set({ recentEdit: edit }),
}));

export const POLL_MS = 4000;
export const RECENT_EDIT_MS = 10_000;

// Poll /v1/modules for failed entries. Errors fail silent so a brief
// bridge outage doesn't spam toasts — the watchdog overlay (yha.html)
// owns "bridge is down" messaging.
export async function pollModules(): Promise<void> {
  try {
    const r = await fetch('/v1/modules');
    if (!r.ok) return;
    const d = (await r.json()) as {
      modules?: Array<{ name: string; state?: string; error?: string | null }>;
    };
    const failed: FailedModule[] = (d.modules || [])
      .filter((m) => m.state === 'failed')
      .map((m) => ({ name: m.name, error: m.error ?? null }));
    useForgeStore.getState().setFailedModules(failed);
  } catch {
    // network blip — keep last-known state
  }
}

// Poll /__rewind/api/edits?limit=1 for the latest record. The bridge
// proxy gates this with WorkOS auth so a non-signed-in user gets a 302
// (graceful no-op).
export async function pollRecentEdit(): Promise<void> {
  try {
    const r = await fetch('/__rewind/api/edits?limit=1');
    if (!r.ok) return;
    const d = (await r.json()) as {
      edits?: Array<{
        id: string;
        ts: number;
        module: string;
        trigger: string;
        files: Array<{ path?: string }>;
      }>;
    };
    const latest = d.edits?.[0];
    if (!latest) {
      useForgeStore.getState().setRecentEdit(null);
      return;
    }
    const paths = (latest.files ?? [])
      .map((f) => (typeof f.path === 'string' ? f.path : ''))
      .filter(Boolean);
    useForgeStore.getState().setRecentEdit({
      id: latest.id,
      ts: latest.ts,
      module: latest.module,
      trigger: latest.trigger,
      fileCount: latest.files?.length || 0,
      paths,
    });
  } catch {
    // ignore
  }
}

// Restore the BEFORE content for `id` via the bridge's /__rewind proxy.
// Returns a friendly summary message; throws on transport errors.
export async function restoreEdit(id: string): Promise<string> {
  const r = await fetch(`/__rewind/api/restore/${encodeURIComponent(id)}`, {
    method: 'POST',
  });
  const d = (await r.json()) as {
    error?: string;
    direction?: string;
    results?: Array<{ path: string; op: string; ok: boolean; err?: string }>;
  };
  if (!r.ok || d.error) {
    throw new Error(d.error || `HTTP ${r.status}`);
  }
  const okN = (d.results || []).filter((x) => x.ok).length;
  const failN = (d.results || []).filter((x) => !x.ok).length;
  return failN > 0
    ? `Rewind partial: ${okN} OK, ${failN} failed`
    : `Rewind OK: ${okN} files restored`;
}

let pollHandle: ReturnType<typeof setInterval> | null = null;

export function startForgePolling(): () => void {
  if (pollHandle) return () => {};
  void pollModules();
  void pollRecentEdit();
  pollHandle = setInterval(() => {
    void pollModules();
    void pollRecentEdit();
  }, POLL_MS);
  return () => {
    if (pollHandle) {
      clearInterval(pollHandle);
      pollHandle = null;
    }
  };
}
