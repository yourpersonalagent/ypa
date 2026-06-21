// preferences.ts — stub API for prefs modal.
// PrefsModal.tsx patches prefs.open / prefs.close with its own React state handlers.
// init() is a no-op; the vanilla tab renderers are fully replaced by Tab*.tsx components.

import { loadCosts, clearCosts, getHiddenModels } from './prefs/costs.js';

export const prefs = {
  init(): void { /* PrefsModal.tsx owns all open/close/tab logic */ },
  open(_tab?: string): void { /* overridden by PrefsModal.tsx on mount */ },
  close(): void { /* overridden by PrefsModal.tsx on mount */ },
  trackCost: () => {},
  loadCosts,
  clearCosts,
  getHiddenModels,
};
