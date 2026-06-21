// inputHistoryStore — global last-inputs list for the chat textarea (ArrowUp).
// Persisted to localStorage via Zustand persist middleware (instant paint),
// and synced to bridge `/v1/input-history` so it follows the user across
// devices/sessions.

import { create } from 'zustand';
import { devtools, persist, createJSONStorage } from 'zustand/middleware';
import { api } from '../api.js';
import { isBridgeModuleEnabledStrict, whenBridgeModuleEnabled } from '../host/bridge-modules.js';

const MAX_HISTORY = 100;
const LEGACY_KEY = 'yha-chat-history';

interface InputHistoryState {
  history: string[];
  historyIdx: number;
  hydrated: boolean;
  add: (text: string) => void;
  setIdx: (i: number) => void;
  hydrateFromServer: () => Promise<void>;
}

function dedupeUnshift(history: string[], text: string): string[] {
  const filtered = history.filter((h) => h !== text);
  filtered.unshift(text);
  return filtered.slice(0, MAX_HISTORY);
}

export const useInputHistoryStore = create<InputHistoryState>()(
  devtools(
    persist(
      (set, get) => ({
        history: [],
        historyIdx: -1,
        hydrated: false,

        add: (text) => {
          const trimmed = String(text || '').trim();
          if (!trimmed) return;
          set({ history: dedupeUnshift(get().history, trimmed), historyIdx: -1 });
          const baseUrl = api.config.baseUrl || '';
          // /v1/input-history is owned by chat-extras — local persist still
          // happens above, but skip the server hop when chat-extras is off.
          if (baseUrl && isBridgeModuleEnabledStrict('chat-extras')) {
            fetch(baseUrl + '/v1/input-history', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ text: trimmed }),
            }).catch(() => {});
          }
        },

        setIdx: (i) => set({ historyIdx: i }),

        // Called once at boot. Merges local + server, writes the union back to
        // the server, and stores the merged result locally so ArrowUp shows
        // entries that were created on other devices in the same account.
        // Defers until the chat-extras bridge module is confirmed enabled so
        // we don't 404 on /v1/input-history/merge when the module is off.
        hydrateFromServer: async () => {
          const baseUrl = api.config.baseUrl || '';
          if (!baseUrl) { set({ hydrated: true }); return; }
          whenBridgeModuleEnabled('chat-extras', () => {
            const local = get().history;
            (async () => {
              try {
                const r = await fetch(baseUrl + '/v1/input-history/merge', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ history: local }),
                });
                if (r.ok) {
                  const j = await r.json() as { history?: string[] };
                  if (Array.isArray(j.history)) {
                    set({ history: j.history, hydrated: true });
                    return;
                  }
                }
              } catch (_) {}
              set({ hydrated: true });
            })();
          });
          // If chat-extras never loads, leave hydrated false — the local
          // history still works (Zustand persist middleware loaded it from
          // localStorage); ArrowUp / ArrowDown read `history` directly.
        },
      }),
      {
        name: 'yha-input-history',
        storage: createJSONStorage(() => localStorage),
        partialize: (s) => ({ history: s.history }),
        // Migrate from the old `yha-chat-history` localStorage key written by
        // chat-ui.ts before this store existed. Runs once; the legacy key is
        // cleared after migration so re-running is a no-op.
        migrate: (state) => {
          try {
            const legacy = localStorage.getItem(LEGACY_KEY);
            if (legacy) {
              const arr = JSON.parse(legacy);
              if (Array.isArray(arr)) {
                const seen = new Set<string>();
                const merged: string[] = [];
                const incoming = (state as InputHistoryState | undefined)?.history || [];
                for (const h of [...incoming, ...arr]) {
                  if (typeof h !== 'string') continue;
                  if (!seen.has(h)) { seen.add(h); merged.push(h); }
                  if (merged.length >= MAX_HISTORY) break;
                }
                localStorage.removeItem(LEGACY_KEY);
                return { ...(state as object), history: merged } as InputHistoryState;
              }
            }
          } catch (_) {}
          return state as InputHistoryState;
        },
        version: 1,
      },
    ),
    { name: 'inputHistoryStore' },
  ),
);

export const inputHistoryActions = {
  add: (text: string) => useInputHistoryStore.getState().add(text),
  setIdx: (i: number) => useInputHistoryStore.getState().setIdx(i),
  getIdx: () => useInputHistoryStore.getState().historyIdx,
  getHistory: () => useInputHistoryStore.getState().history,
};
