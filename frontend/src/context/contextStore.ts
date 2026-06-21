// contextStore — shared state for the ContextGenerator pipeline (Phase 1a).
//
// One engine, two shells:
//   • QuickContextPicker (input popover) consumes this store to render items.
//   • ContextHub (header modal, Phase 1b) reuses the same store + selectors.
//
// Why a Zustand store instead of inline state?
//   • Keeps Quick + Hub views in sync without a parent component.
//   • Lets selectors live next to data (e.g. allowedTiers).
//   • Enables future SSE-driven invalidation (`context:categorized` fires →
//     refetch active category, no prop drilling).
//
// Persistence: NONE. Items are fetched fresh from the bridge each time the
// active category changes. This file deliberately avoids `localStorage` —
// the truth lives on the server (sessions JSON + docs/) and we don't want
// stale cached items leaking into a private/system tier badge.
//
// Whitelist for confirmed sensitive items lives in usePendingConfirms.ts,
// not here, because it's a session-scoped concern that mirrors a separate
// server-side TTL map.

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';
import { api } from '../api.js';

// ── Types ────────────────────────────────────────────────────────────────────

export type Tier = 'public' | 'private' | 'system';

export interface ContextItem {
  id:                 string;       // "session:<sid>" | "file:<base64url>" | "note:<sid>:<msgIdx>"
  kind:               'session' | 'file' | 'note';
  title:              string;
  category:           string | null;
  tags:               string[];
  sensitivity:        Tier;
  sensitivitySource:  'auto' | 'user' | 'path' | null;
  requiresConfirm:    boolean;
  snippet:            string;
  updatedAt:          number;
  // Kind-specific fields
  sid?:               string;
  path?:              string;
  nameSource?:        string | null;
  // Note-kind fields (Phase 1.10 — resurrected #notepicker)
  msgIdx?:            number;       // index of the note message in session.messages
  sessionName?:       string;       // parent session label, used for context
}

export type BridgeMode = 'standalone' | 'mcp' | 'both';

interface ContextState {
  activeCategory:   string;          // '' = all; 'notes'|'mail'|'calendar'|<categorizer-slug>
  query:            string;          // debounced search input
  showAllTiers:     boolean;         // QuickPicker footer "Show all tiers" toggle
  bridgeMode:       BridgeMode;      // default 'standalone'; lives mostly in Hub but state shared
  items:            ContextItem[];
  total:            number;
  loading:          boolean;
  error:            string | null;
  lastFetchKey:     string;          // used to dedupe overlapping fetches
  // Actions
  setActiveCategory: (cat: string) => void;
  setQuery:          (q:   string) => void;
  setShowAllTiers:   (on:  boolean) => void;
  setBridgeMode:     (m:   BridgeMode) => void;
  refresh:           () => Promise<void>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function baseUrl(): string {
  return (api.config as { baseUrl?: string })?.baseUrl || '';
}

// Build the tier whitelist string from the current showAllTiers setting.
// Keeping this in one place so the Quick-Picker and Hub agree.
function tiersForRequest(showAll: boolean): string {
  return showAll ? 'public,private,system' : 'public';
}

let _abortInFlight: AbortController | null = null;

// ── Store ────────────────────────────────────────────────────────────────────

export const useContextStore = create<ContextState>()(
  devtools(
    (set, get) => ({
      activeCategory: 'notes',  // Default tab for the QuickPicker per the plan.
      query:          '',
      showAllTiers:   false,
      bridgeMode:     'standalone',
      items:          [],
      total:          0,
      loading:        false,
      error:          null,
      lastFetchKey:   '',

      setActiveCategory: (cat) => {
        if (get().activeCategory === cat) return;
        set({ activeCategory: cat });
        void get().refresh();
      },

      setQuery: (q) => {
        if (get().query === q) return;
        set({ query: q });
        void get().refresh();
      },

      setShowAllTiers: (on) => {
        if (get().showAllTiers === on) return;
        set({ showAllTiers: on });
        void get().refresh();
      },

      setBridgeMode: (m) => set({ bridgeMode: m }),

      refresh: async () => {
        const { activeCategory, query, showAllTiers } = get();
        const tier = tiersForRequest(showAllTiers);
        const key = `${activeCategory}|${query}|${tier}`;
        // Drop any in-flight request — we only ever want the latest filter.
        _abortInFlight?.abort();
        const ac = new AbortController();
        _abortInFlight = ac;

        set({ loading: true, error: null, lastFetchKey: key });
        const url = baseUrl();
        if (!url) {
          set({ loading: false, error: 'no baseUrl', items: [], total: 0 });
          return;
        }

        const params = new URLSearchParams();
        if (activeCategory) params.set('cat', activeCategory);
        if (query)          params.set('q',   query);
        params.set('tier', tier);

        try {
          const r = await fetch(`${url}/v1/context/items?${params.toString()}`, {
            signal: ac.signal,
          });
          if (!r.ok) {
            set({ loading: false, error: `HTTP ${r.status}`, items: [], total: 0 });
            return;
          }
          const j = (await r.json()) as { success?: boolean; items?: ContextItem[]; total?: number; error?: string };
          if (ac.signal.aborted) return;
          if (j?.success === false) {
            set({ loading: false, error: j.error || 'failed', items: [], total: 0 });
            return;
          }
          // Late-arriving response from a previous filter — drop it.
          if (get().lastFetchKey !== key) return;
          set({
            loading: false,
            items:   Array.isArray(j.items) ? j.items : [],
            total:   Number(j.total) || (Array.isArray(j.items) ? j.items.length : 0),
            error:   null,
          });
        } catch (e) {
          if (ac.signal.aborted) return;
          set({
            loading: false,
            error:   e instanceof Error ? e.message : String(e),
            items:   [],
            total:   0,
          });
        }
      },
    }),
    { name: 'contextStore' }
  )
);

// ── Convenience exports for components that don't need the whole store ──────

export function tierLabel(t: Tier): string {
  if (t === 'private') return 'Private';
  if (t === 'system')  return 'System';
  return 'Public';
}

export function tierIcon(t: Tier): string {
  if (t === 'private') return '🔒';
  if (t === 'system')  return '⚙️🔒';
  return '';
}
