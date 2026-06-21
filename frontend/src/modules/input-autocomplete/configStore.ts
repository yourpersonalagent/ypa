// Module-local config store for input-autocomplete.
//
// One source of truth for the prefs tab (writes), the suggestion hook
// (reads on each keystroke), and ChatInput (reads `enabled` to gate the
// overlay render). Backed by GET/PATCH /v1/input-autocomplete/config.

import { create } from 'zustand';
import { api } from '../../api.js';

export interface AutocompleteConfig {
  enabled:            boolean;
  model:              string;
  provider:           string;
  debounceBoundaryMs: number;
  debounceMidwordMs:  number;
  maxTokens:          number;
  temperature:        number;
  minChars:           number;
  historyChars:       number;
  completionMode:     'chat' | 'fim';
}

export const DEFAULTS: AutocompleteConfig = {
  enabled:            false,
  model:              'nvidia/nemotron-mini-4b-instruct',
  provider:           'NVIDIA',
  debounceBoundaryMs: 500,
  debounceMidwordMs:  2000,
  maxTokens:          40,
  temperature:        0.4,
  minChars:           3,
  historyChars:       400,
  completionMode:     'chat',
};

interface State {
  cfg: AutocompleteConfig;
  loaded: boolean;
  fetch: () => Promise<void>;
  patch: (p: Partial<AutocompleteConfig>) => Promise<void>;
}

export const useAutocompleteConfig = create<State>((set, get) => ({
  cfg: DEFAULTS,
  loaded: false,

  async fetch() {
    const base = api.config.baseUrl || '';
    if (!base) return;
    try {
      const r = await fetch(base + '/v1/input-autocomplete/config');
      if (!r.ok) {
        // Bridge module disabled — keep defaults, mark loaded so the hook
        // doesn't keep retrying.
        set({ loaded: true });
        return;
      }
      const d = await r.json() as { config?: Partial<AutocompleteConfig> };
      set({ cfg: { ...DEFAULTS, ...(d.config || {}) }, loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  async patch(p) {
    const base = api.config.baseUrl || '';
    if (!base) return;
    // Optimistic — the prefs tab debounces, so flicker is rare.
    set({ cfg: { ...get().cfg, ...p } });
    try {
      const r = await fetch(base + '/v1/input-autocomplete/config', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(p),
      });
      if (!r.ok) return;
      const d = await r.json() as { config?: Partial<AutocompleteConfig> };
      set({ cfg: { ...DEFAULTS, ...(d.config || {}) } });
    } catch {
      /* leave optimistic state */
    }
  },
}));
