// todoStore — per-WD task lists. Hydrated from /v1/todos; polled lazily so the
// header bubble stays in sync when models call TodoWrite via either route
// (OpenAI inline tools or MCP-Tools aggregator → bridge__TodoWrite).

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

export interface Todo {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority?: 'high' | 'medium' | 'low';
}

export interface CwdEntry {
  key: string;
  cwd: string;
  count: number;
  openCount: number;
}

interface TodoState {
  byCwd: Record<string, Todo[]>;
  cwds: CwdEntry[];
  defaultCwd: string;
  loading: boolean;
  error: string | null;

  // Modal UI state
  modalOpen: boolean;
  modalCwd: string | null;
}

interface TodoActions {
  refresh: () => Promise<void>;
  saveTodos: (cwd: string, todos: Todo[]) => Promise<void>;
  openModal: (cwd?: string) => void;
  closeModal: () => void;
  setModalCwd: (cwd: string) => void;
}

export type TodoStore = TodoState & TodoActions;

export const useTodoStore = create<TodoStore>()(devtools((set, get) => ({
  byCwd: {},
  cwds: [],
  defaultCwd: '',
  loading: false,
  error: null,
  modalOpen: false,
  modalCwd: null,

  refresh: async () => {
    set({ loading: true, error: null });
    try {
      const res = await fetch('/v1/todos');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      set({
        byCwd: data.byCwd || {},
        cwds: data.cwds || [],
        defaultCwd: data.defaultCwd || '',
        loading: false,
      });
    } catch (e) {
      set({ loading: false, error: (e as Error).message });
    }
  },

  saveTodos: async (cwd, todos) => {
    // Optimistic update.
    const prev = get().byCwd;
    const next = { ...prev, [cwd]: todos };
    const cwdsNext = Object.entries(next)
      .filter(([_, list]) => list.length > 0)
      .map(([c, list]) => ({
        key: c.replace(/[^a-z0-9]/gi, '_'),
        cwd: c,
        count: list.length,
        openCount: list.filter((t) => t.status !== 'completed').length,
      }));
    set({ byCwd: next, cwds: cwdsNext });
    try {
      const res = await fetch('/v1/todos', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, todos }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (e) {
      // Revert on error.
      set({ byCwd: prev, error: (e as Error).message });
      get().refresh();
    }
  },

  openModal: (cwd) => {
    const target = cwd || get().defaultCwd || get().cwds[0]?.cwd || '';
    set({ modalOpen: true, modalCwd: target });
  },
  closeModal: () => set({ modalOpen: false }),
  setModalCwd: (cwd) => set({ modalCwd: cwd }),
})));

export const getTodoState = () => useTodoStore.getState();
export const getTodoActions = () => useTodoStore.getState();
