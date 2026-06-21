// toastStore — toast notification state
// Replaces the imperative DOM system in toast.ts.
// Vanilla JS callers: use getToastActions().show(...) or app.toast.show(...)
// React: useToastStore hook; <ToastStack /> is the sole renderer.

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

// ── Types ──────────────────────────────────────────────────────────────────

export type ToastType = 'info' | 'success' | 'error' | 'warning' | 'running';

export type ToastPosition =
  | 'bottom-right'
  | 'bottom-left'
  | 'bottom-center'
  | 'top-right';

export interface ToastEntry {
  id: string;
  message: string;
  type: ToastType;
  title?: string;
  duration: number; // ms; 0 = persistent until dismissed
}

export interface ToastState {
  toasts: ToastEntry[];
  position: ToastPosition;
  enabled: boolean;
  maxVisible: number;
}

export interface ToastActions {
  show: (
    message: string,
    type?: ToastType | string,
    opts?: { title?: string; duration?: number; id?: string } | number
  ) => string;
  dismiss: (id: string) => void;
  clear: () => void;
  setConfig: (patch: Partial<Pick<ToastState, 'position' | 'enabled' | 'maxVisible'>>) => void;
}

type ToastStore = ToastState & ToastActions;

// ── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_DURATION: Record<ToastType, number> = {
  error: 6000,
  warning: 5000,
  running: 0,
  info: 3500,
  success: 3500,
};

function lsParse<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

function loadConfig() {
  const cfg = lsParse<Partial<ToastState>>('yha.toast', {});
  return {
    position: (cfg.position as ToastPosition) || 'bottom-right',
    enabled: cfg.enabled !== false,
    maxVisible: typeof cfg.maxVisible === 'number' ? cfg.maxVisible : 5,
  };
}

function normalizeType(t: string | undefined): ToastType {
  if (t === 'ok') return 'success';
  if (t === 'err') return 'error';
  if ((t as ToastType) in DEFAULT_DURATION) return t as ToastType;
  return 'info';
}

let _idCounter = 0;
function nextId(): string {
  return `toast-${Date.now()}-${++_idCounter}`;
}

// ── Store ──────────────────────────────────────────────────────────────────

export const useToastStore = create<ToastStore>()(
  devtools(
    (set, get) => ({
      toasts: [],
      ...loadConfig(),

      show: (message, type, opts) => {
        if (!get().enabled) return '';
        const resolvedType = normalizeType(typeof type === 'string' ? type : undefined);

        // opts can be a number (legacy duration arg) or an object
        let duration = DEFAULT_DURATION[resolvedType];
        let title: string | undefined;
        let explicitId: string | undefined;
        if (typeof opts === 'number') {
          duration = opts;
        } else if (opts) {
          if (typeof opts.duration === 'number') duration = opts.duration;
          if (opts.title) title = opts.title;
          if (opts.id) explicitId = opts.id;
        }

        const id = explicitId || nextId();
        const entry: ToastEntry = { id, message: String(message), type: resolvedType, title, duration };

        set((s) => {
          // If a toast with this explicit id already exists, replace it.
          const existing = s.toasts.findIndex((t) => t.id === id);
          let toasts: ToastEntry[];
          if (existing !== -1) {
            toasts = [...s.toasts];
            toasts[existing] = entry;
          } else {
            toasts = [...s.toasts, entry].slice(-s.maxVisible);
          }
          return { toasts };
        });
        return id;
      },

      dismiss: (id) => {
        set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
      },

      clear: () => set({ toasts: [] }),

      setConfig: (patch) => {
        set(patch);
        try {
          const { position, enabled, maxVisible } = { ...get(), ...patch };
          localStorage.setItem('yha.toast', JSON.stringify({ position, enabled, maxVisible }));
        } catch {}
      },
    }),
    { name: 'ToastStore' }
  )
);

// ── Convenience getters for non-React code ─────────────────────────────────

export function getToastState(): ToastState {
  return useToastStore.getState();
}

export function getToastActions(): ToastActions {
  return useToastStore.getState();
}
