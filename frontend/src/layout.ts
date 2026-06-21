// Layout: pure store-operation helpers for view modes, header, and splitter.
// All DOM reflection (CSS application, data-attrs, class toggling) is handled
// reactively by Shell.tsx / ViewOverlay.tsx / Splitter.tsx. Only timer-based
// hold detection and store actions live here so KeyboardShortcuts.tsx can call
// them without touching the DOM.

import { getAppState, getAppActions } from './stores/index.js';
import { save } from './state.js';

const HOLD_MS = 450;

// ── Split button hold (Alt+X keyboard mirror) ────────────────────────────────
let _holdTimer: number | null = null;
let _didHold = false;

export function holdStart(): void {
  _didHold = false;
  if (_holdTimer !== null) clearTimeout(_holdTimer);
  _holdTimer = window.setTimeout(() => {
    _holdTimer = null;
    _didHold = true;
    if (getAppState().layoutMode !== 'full') getAppActions().setLayoutMode('full');
    if (getAppState().viewMode !== 'split') getAppActions().setViewMode('split');
    getAppActions().setViewSwap(!getAppState().viewSwap);
    save.view();
  }, HOLD_MS);
}

export function holdEnd(): void {
  if (_holdTimer !== null) { clearTimeout(_holdTimer); _holdTimer = null; }
  if (_didHold) { _didHold = false; return; }
  toggleSplitOrient();
}

// ── Menu button hold (Alt+H keyboard mirror) ─────────────────────────────────
let _menuHoldTimer: number | null = null;
let _menuDidHold = false;

export function headerHoldStart(): void {
  _menuDidHold = false;
  if (_menuHoldTimer !== null) clearTimeout(_menuHoldTimer);
  _menuHoldTimer = window.setTimeout(() => {
    _menuHoldTimer = null;
    _menuDidHold = true;
    toggleHeaderOrient();
  }, HOLD_MS);
}

export function headerHoldEnd(): void {
  if (_menuHoldTimer !== null) { clearTimeout(_menuHoldTimer); _menuHoldTimer = null; }
  if (_menuDidHold) { _menuDidHold = false; return; }
  toggleHeader();
}

// ── Public helpers ────────────────────────────────────────────────────────────

export function cycleForward(): void {
  const { layoutMode, viewMode } = getAppState();
  const { setLayoutMode, setViewMode } = getAppActions();
  if (layoutMode === 'full' && viewMode !== 'chat') {
    setViewMode('chat');
    save.view();
  } else if (layoutMode === 'full') {
    setLayoutMode('messenger');
  } else if (layoutMode === 'messenger') {
    setLayoutMode('zen');
  } else {
    setLayoutMode('full');
    setViewMode('chat');
    save.view();
  }
}

export function setMode(mode: string): void {
  if (getAppState().layoutMode !== 'full') getAppActions().setLayoutMode('full');
  getAppActions().setViewMode(mode as 'split' | 'chat' | 'workflow' | 'code');
  save.view();
}

export function toggleHeader(): void {
  getAppActions().setHeaderOpen(!getAppState().headerOpen);
  save.view();
}

export function setHeader(open: boolean): void {
  getAppActions().setHeaderOpen(open);
  save.view();
}

export function toggleSplitOrient(): void {
  if (getAppState().layoutMode !== 'full') {
    getAppActions().setLayoutMode('full');
    getAppActions().setViewMode('split');
  } else if (getAppState().viewMode !== 'split') {
    getAppActions().setViewMode('split');
  } else {
    const cur = getAppState().viewOrient;
    getAppActions().setViewOrient(cur === 'h' ? 'v' : 'h');
  }
  save.view();
}

export function toggleHeaderOrient(): void {
  const cur = getAppState().headerOrient;
  getAppActions().setHeaderOrient(cur === 'h' ? 'v' : 'h');
  save.view();
}

// Legacy object-shape export so existing callers (KeyboardShortcuts.tsx) keep working.
export const layout = {
  holdStart,
  holdEnd,
  headerHoldStart,
  headerHoldEnd,
  cycleForward,
  setMode,
  toggleHeader,
  setHeader,
  toggleSplitOrient,
  toggleHeaderOrient,
};
