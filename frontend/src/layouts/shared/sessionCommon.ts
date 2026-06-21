// Shared helpers and state hooks for session list components.
// Consumed by both SessionRail (messenger layout) and SessionPicker (popover)
// so behaviour stays in sync without duplicating logic.

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  useSessionStore,
  getSessionActions,
  type SessionEntry,
  type StreamState,
} from '../../stores/index.js';
import {
  useSessionActivityStore,
  type SessionLiveMeta,
} from '../../stores/sessionActivityStore.js';
import { confirm } from '../../stores/confirmStore.js';
import { session } from '../../session.js';

// ── Pure helpers ─────────────────────────────────────────────────────────────

export function relativeTime(ts: number | undefined): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`;
  return new Date(ts).toLocaleDateString('en', { month: 'short', day: 'numeric' });
}

export function sessionSubtitle(s: SessionEntry): string {
  if (s.workingDir) {
    const parts = s.workingDir.split('/').filter(Boolean);
    return parts.length > 1 ? `…/${parts.slice(-2).join('/')}` : s.workingDir;
  }
  return s.boundWorkflowName ? `≡ ${s.boundWorkflowName}` : '';
}

export function isBusy(
  s: SessionEntry,
  streams: Record<string, StreamState>,
  activity?: Record<string, SessionLiveMeta>,
): boolean {
  const local = streams[String(s.id)];
  if (local && local.status === 'streaming' && (local.localLive || local.serverActive)) return true;
  // Presence in the process-global activity feed means streaming right now,
  // even for sessions this tab never attached a per-session stream to.
  if (activity && activity[String(s.id)]) return true;
  return s.isRunning === true;
}

export function isUnread(s: SessionEntry, currentId: string): boolean {
  if (String(s.id) === currentId) return false;
  const lastMsg = s.lastUsed ?? 0;
  return lastMsg > 0 && lastMsg > (s.viewedAt ?? 0);
}

export function busySinceOf(s: SessionEntry, streams: Record<string, StreamState>): number {
  return s.runningSince ?? s.lastUsed ?? s.createdAt ?? (streams[String(s.id)] ? Date.now() : 0);
}

// ── Activity feed hook ──────────────────────────────────────────────────────

// useActivityBusy subscribes the calling list view to the process-global
// /v1/activity/stream feed for its mounted lifetime and returns the live
// "streaming right now" map keyed by session id. The EventSource is shared
// (refcounted) across every subscriber, so mounting this in both the picker
// and the rail costs a single connection. Pass the result into isBusy() so a
// row flips to busy the instant a session starts streaming — no manual reload.
export function useActivityBusy(): Record<string, SessionLiveMeta> {
  // Subscribe to the sorted id string rather than the full sessions object.
  // Zustand compares with Object.is (string equality), so the calling component
  // only re-renders when sessions start or stop — not on every ~1 Hz token-
  // counter tick frame. The sessions map is read from getState() inside the
  // memo, which fires only when the membership string changes.
  const membershipKey = useSessionActivityStore(
    (s) => Object.keys(s.sessions).sort().join(','),
  );
  const sessions = useMemo(
    () => useSessionActivityStore.getState().sessions,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [membershipKey],
  );
  useEffect(() => {
    useSessionActivityStore.getState().connect();
    return () => {
      useSessionActivityStore.getState().disconnect();
    };
  }, []);
  return sessions;
}

// ── Action hook ───────────────────────────────────────────────────────────────

// Encapsulates rename / pin / delete state + API calls so both SessionRail
// and SessionPicker share identical behaviour. Callers own the rendering.
export function useSessionActions() {
  const [renamingId, setRenamingId] = useState<string | null>(null);

  const startRename = useCallback((s: SessionEntry) => setRenamingId(String(s.id)), []);
  const cancelRename = useCallback(() => setRenamingId(null), []);

  const commitRename = useCallback(async (s: SessionEntry, name: string) => {
    const trimmed = name.trim();
    setRenamingId(null);
    if (!trimmed || trimmed === s.name) return;
    const all = useSessionStore.getState().sessions;
    const idx = all.findIndex((x) => x.id === s.id);
    if (idx >= 0) {
      const updated = [...all];
      updated[idx] = { ...all[idx], name: trimmed };
      getSessionActions().setSessions(updated);
    }
    try {
      await fetch(`/v1/sessions/${s.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      await session?.fetchList?.();
    } catch {}
  }, []);

  const toggleTodo = useCallback(async (id: string) => {
    const all = useSessionStore.getState().sessions;
    const idx = all.findIndex((s) => String(s.id) === id);
    if (idx < 0) return;
    const target = all[idx];
    const next = !target.isTodo;
    const updated = [...all];
    updated[idx] = { ...target, isTodo: next };
    getSessionActions().setSessions(updated);
    try {
      const r = await fetch(`/v1/sessions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isTodo: next }),
      });
      if (!r.ok) throw new Error(`PATCH /v1/sessions/${id} ${r.status}`);
    } catch {
      session?.fetchList?.();
    }
  }, []);

  const deleteSession = useCallback(async (s: SessionEntry) => {
    const ok = await confirm({
      scope: 'delete-session',
      title: 'Delete session',
      message: `Delete "${s.name}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      danger: true,
      trustMs: 5 * 60_000,
    });
    if (ok) session?.delete?.(s.id);
  }, []);

  return { renamingId, startRename, cancelRename, commitRename, toggleTodo, deleteSession };
}
