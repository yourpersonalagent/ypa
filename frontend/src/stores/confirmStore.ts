// confirmStore — promise-based confirmation dialogs with a scope-trust window.
//
// confirm({ scope, title, message, trustMs }) returns Promise<boolean>.
// When the user confirms once, the same scope auto-resolves true for trustMs
// without re-prompting (default 5 min). Different scopes stay independent.
//
// Vanilla JS callers: getConfirmActions().confirm(...) or confirm(...).
// React: useConfirmStore hook; <ConfirmModal /> is the sole renderer.

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

// ── Types ──────────────────────────────────────────────────────────────────

export interface ConfirmRequest {
  scope: string;
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  trustMs?: number;
}

export interface ConfirmEntry extends ConfirmRequest {
  id: string;
  resolve: (ok: boolean) => void;
}

export interface ConfirmState {
  active: ConfirmEntry | null;
  trustedAt: Record<string, number>;
}

export interface ConfirmActions {
  confirm: (req: ConfirmRequest) => Promise<boolean>;
  resolve: (ok: boolean) => void;
  resetTrust: (scope?: string) => void;
}

type ConfirmStore = ConfirmState & ConfirmActions;

const DEFAULT_TRUST_MS = 5 * 60_000;

let _idCounter = 0;
function nextId(): string {
  return `confirm-${Date.now()}-${++_idCounter}`;
}

// ── Store ──────────────────────────────────────────────────────────────────

export const useConfirmStore = create<ConfirmStore>()(
  devtools(
    (set, get) => ({
      active: null,
      trustedAt: {},

      confirm: (req) => {
        const trustMs = req.trustMs ?? DEFAULT_TRUST_MS;
        const last = get().trustedAt[req.scope] ?? 0;
        if (trustMs > 0 && Date.now() - last < trustMs) {
          return Promise.resolve(true);
        }
        // If a modal is already open, refuse the new one rather than stack —
        // surface the conflict to the caller so it can no-op gracefully.
        if (get().active) return Promise.resolve(false);

        return new Promise<boolean>((resolve) => {
          const entry: ConfirmEntry = { ...req, id: nextId(), resolve };
          set({ active: entry });
        });
      },

      resolve: (ok) => {
        const entry = get().active;
        if (!entry) return;
        set((s) => {
          const trustedAt = { ...s.trustedAt };
          if (ok) {
            const trustMs = entry.trustMs ?? DEFAULT_TRUST_MS;
            if (trustMs > 0) trustedAt[entry.scope] = Date.now();
          }
          return { active: null, trustedAt };
        });
        entry.resolve(ok);
      },

      resetTrust: (scope) => {
        if (!scope) {
          set({ trustedAt: {} });
          return;
        }
        set((s) => {
          const trustedAt = { ...s.trustedAt };
          delete trustedAt[scope];
          return { trustedAt };
        });
      },
    }),
    { name: 'ConfirmStore' }
  )
);

// ── Convenience wrappers ───────────────────────────────────────────────────

export function getConfirmActions(): ConfirmActions {
  return useConfirmStore.getState();
}

export function confirm(req: ConfirmRequest): Promise<boolean> {
  return useConfirmStore.getState().confirm(req);
}
