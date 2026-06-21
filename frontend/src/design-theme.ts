// Design-theme controller — sibling of color-theme.ts.
//
// Public API:
//   designTheme.init()              — apply persisted value (called at boot)
//   designTheme.set('atelier')      — direct set
//   designTheme.cycle()             — round-robin Console → Atelier → Patchbay → …
//   designTheme.current()           — current id
//
// Storage:
//   localStorage `yha.designTheme`  — read by inline boot script before CSS arrives
//   server pref  `designTheme`      — synced via the same store.set() pathway as colorTheme

import { getAppState, getAppActions } from './stores/index.js';
import { store } from './store.js';
import {
  DEFAULT_DESIGN_THEME,
  isValidDesignTheme,
  nextDesignTheme,
  resolveDesignTheme,
} from './design-themes-config.js';

export const designTheme = {
  init() {
    const raw = getAppState().designTheme;
    const id = isValidDesignTheme(raw) ? raw : DEFAULT_DESIGN_THEME;
    getAppActions().setDesignTheme(id);
  },

  current(): string {
    return resolveDesignTheme(getAppState().designTheme);
  },

  set(id: string) {
    const next = resolveDesignTheme(id);
    getAppActions().setDesignTheme(next);
    store.set('designTheme', next);
  },

  cycle() {
    this.set(nextDesignTheme(this.current()));
  },
};
