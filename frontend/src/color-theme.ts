import { getAppState, getAppActions } from './stores/index.js';
import { store } from './store.js';
import {
  DEFAULT_COLOR_THEME,
  buildColorThemeId,
  isValidColorTheme,
  nextColorThemeFamily,
  parseColorThemeId,
  prevColorThemeFamily,
  type ColorThemeVariant,
} from './color-themes-config.js';

// Color-theme controller.
//
// Header `#btn-theme` interaction model (left or right mouse button):
//   • Click (press + release within HOLD_THRESHOLD_MS) — flip dark↔bright in
//     the current family.
//   • Press-and-hold — enter cycle mode: advance one family every
//     CYCLE_INTERVAL_MS, keeping the current variant. Left mouse cycles
//     forward, right mouse cycles backward. While the hold lasts the button
//     glyph shows the *family* icon of whatever is currently applied; on
//     release the last family stays selected and the button reverts to the
//     dark/bright glyph for the next click.
//
// Direct calls (`set`, `setFamily`, `setVariant`) bypass the press/hold
// machinery.
//
// The DOM button id stays `#btn-theme` — URL/reference stable. Only the
// concept and code symbols have been renamed to "color theme".

export type CycleDirection = 'forward' | 'backward';

const HOLD_THRESHOLD_MS = 350;
const CYCLE_INTERVAL_MS = 1000;

let _holdStartTimer: ReturnType<typeof setTimeout> | null = null;
let _cycleInterval: ReturnType<typeof setInterval> | null = null;
let _inHoldMode = false;
let _holdDirection: CycleDirection = 'forward';

function _clearHoldTimers(): void {
  if (_holdStartTimer !== null) {
    clearTimeout(_holdStartTimer);
    _holdStartTimer = null;
  }
  if (_cycleInterval !== null) {
    clearInterval(_cycleInterval);
    _cycleInterval = null;
  }
}

export const colorTheme = {
  init() {
    const raw = getAppState().colorTheme;
    const id = isValidColorTheme(raw) ? raw : DEFAULT_COLOR_THEME;
    getAppActions().setColorTheme(id);
  },

  click() {
    const cur = parseColorThemeId(getAppState().colorTheme);
    const v: ColorThemeVariant = cur.variant === 'dark' ? 'bright' : 'dark';
    this._apply(buildColorThemeId(cur.family, v));
  },

  holdStart(direction: CycleDirection = 'forward') {
    _clearHoldTimers();
    _inHoldMode = false;
    _holdDirection = direction;
    _holdStartTimer = setTimeout(() => {
      _inHoldMode = true;
      this._advanceFamily(_holdDirection);
      _cycleInterval = setInterval(() => this._advanceFamily(_holdDirection), CYCLE_INTERVAL_MS);
    }, HOLD_THRESHOLD_MS);
  },

  holdEnd() {
    const wasHolding = _inHoldMode;
    _clearHoldTimers();
    _inHoldMode = false;
    if (!wasHolding) this.click();
  },

  _advanceFamily(direction: CycleDirection) {
    const cur = parseColorThemeId(getAppState().colorTheme);
    const nf = direction === 'backward' ? prevColorThemeFamily(cur.family) : nextColorThemeFamily(cur.family);
    const id = buildColorThemeId(nf, cur.variant);
    getAppActions().setColorTheme(id);
    store.set('colorTheme', getAppState().colorTheme);
  },

  set(id: string) {
    _clearHoldTimers();
    _inHoldMode = false;
    this._apply(id);
  },

  setFamily(family: string) {
    _clearHoldTimers();
    _inHoldMode = false;
    const cur = parseColorThemeId(getAppState().colorTheme);
    this._apply(buildColorThemeId(family, cur.variant));
  },

  setVariant(variant: ColorThemeVariant) {
    _clearHoldTimers();
    _inHoldMode = false;
    const cur = parseColorThemeId(getAppState().colorTheme);
    this._apply(buildColorThemeId(cur.family, variant));
  },

  _apply(id: string) {
    getAppActions().setColorTheme(id);
    store.set('colorTheme', getAppState().colorTheme);
  },
};
