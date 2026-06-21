import { getAppState, getAppActions } from './stores/index.js';
import { COMPOSER_MODES, type ComposerMode } from './stores/appStore.js';

// Ctrl+Alt+M interaction model — mirrors the colorTheme tap/hold pattern:
//   • Tap  — advance one composer mode forward (chat → image → audio → video → chat).
//   • Hold ≥ HOLD_THRESHOLD_MS — enter cycle mode, advancing every CYCLE_INTERVAL_MS.

const HOLD_THRESHOLD_MS = 350;
const CYCLE_INTERVAL_MS = 1000;

let _holdStartTimer: ReturnType<typeof setTimeout> | null = null;
let _cycleInterval: ReturnType<typeof setInterval> | null = null;
let _inHoldMode = false;

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

export const composerMode = {
  click() {
    this._advance();
  },

  holdStart() {
    _clearHoldTimers();
    _inHoldMode = false;
    _holdStartTimer = setTimeout(() => {
      _inHoldMode = true;
      this._advance();
      _cycleInterval = setInterval(() => this._advance(), CYCLE_INTERVAL_MS);
    }, HOLD_THRESHOLD_MS);
  },

  holdEnd() {
    const wasHolding = _inHoldMode;
    _clearHoldTimers();
    _inHoldMode = false;
    if (!wasHolding) this.click();
  },

  _advance() {
    const cur: ComposerMode = (getAppState().composerMode as ComposerMode) ?? 'chat';
    const idx = COMPOSER_MODES.indexOf(cur);
    const next = COMPOSER_MODES[(idx + 1) % COMPOSER_MODES.length];
    getAppActions().setComposerMode(next);
  },
};
