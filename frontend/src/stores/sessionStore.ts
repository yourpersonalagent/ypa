// sessionStore — session management state + actions
// Server-backed via /v1/sessions/. Works alongside Zustand for reactive state.

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import type { ChatMessage } from '../chat/chat-utils.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface SessionEntry {
  id: string | number;
  name: string;
  messages?: ChatMessage[];
  messageCount?: number;
  participants: unknown[];
  groupMode: string;
  createdAt: number;
  lastUsed?: number;
  viewedAt?: number;
  workingDir?: string | null;
  boundWorkflowName?: string;
  isRunning?: boolean;
  runningSince?: number | null;
  // Picker "todo" pin. Lives on the server (per-session JSON), not localStorage,
  // so the same set of todos shows up on every browser/device viewing this bridge.
  isTodo?: boolean;
  // When set, this session belongs to a multichat group (every group spawns N
  // background slot sessions). Switching to such a session re-activates the
  // multichat overlay; switching to a normal session deactivates it.
  multichatGroupId?: string | null;
}

export interface SessionState {
  currentId: string;
  sessions: SessionEntry[];
  _cache: SessionEntry[];
  defaultWorkingDir: string;
  hostname: string;
  loading: boolean;
  error: string | null;
  // Bumped when active participants change — used by subscribers
  // that need to refresh participant chips/badges.
  participantsRevision: number;
}

export interface SessionActions {
  setCurrentId: (id: string | number) => void;
  setSessions: (sessions: SessionEntry[]) => void;
  setDefaultWorkingDir: (dir: string) => void;
  setHostname: (host: string) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
  getCachedSession: (id: string | number) => SessionEntry | undefined;
  ensureCachedSession: (id: string | number, patch?: Partial<SessionEntry>) => SessionEntry | null;
  bumpParticipantsRevision: () => void;
}

export type SessionStore = SessionState & SessionActions;

// ── Store ──────────────────────────────────────────────────────────────────

export const useSessionStore = create<SessionStore>()(devtools((set, get) => ({
  currentId: localStorage.getItem('yha.currentSession') || '',
  sessions: [],
  _cache: [],
  defaultWorkingDir: '',
  hostname: '',
  loading: false,
  error: null,
  participantsRevision: 0,

  setCurrentId: (id) => {
    const sid = String(id);
    localStorage.setItem('yha.currentSession', sid);
    set({ currentId: sid });
  },

  setSessions: (sessions) => {
    set({ sessions, _cache: sessions });
  },

  setDefaultWorkingDir: (dir) => set({ defaultWorkingDir: dir }),
  setHostname: (hostname) => set({ hostname }),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),

  getCachedSession: (id) => {
    return get()._cache.find((s) => String(s.id) === String(id));
  },

  ensureCachedSession: (id, patch = {}) => {
    const sid = String(id || '');
    if (!sid) return null;
    const cache = get()._cache;
    let existing = cache.find((s) => String(s.id) === sid);
    if (!existing) {
      existing = {
        id: sid,
        name: patch.name || 'New session',
        messages: [],
        participants: [],
        groupMode: 'sequential',
        createdAt: Date.now(),
        lastUsed: Date.now(),
        viewedAt: Date.now(),
      };
      set({ _cache: [existing!, ...cache] });
    }
    if (patch) Object.assign(existing, patch);
    return existing;
  },

  bumpParticipantsRevision: () =>
    set((s) => ({ participantsRevision: s.participantsRevision + 1 })),
}), { name: 'SessionStore' }));

// ── Convenience getters ────────────────────────────────────────────────────
export function getSessionState(): SessionState {
  return useSessionStore.getState();
}

export function getSessionActions(): SessionActions {
  return useSessionStore.getState();
}
