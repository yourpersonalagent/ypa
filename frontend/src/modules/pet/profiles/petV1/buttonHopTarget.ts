// pickButtonHopTarget — petV1's button-hop picker.
//
// Only V1's idle scheduler hops the pet onto random visible buttons, so
// this picker and its tuning constants live inside the V1 profile. The
// shared petOverlayGeometry module keeps PET_W / clampPos primitives but
// stays free of V1-specific behavior.

import {
  PET_W,
  PET_H,
} from '../../petOverlayConstants.js';
import { clampPos, type Point } from '../../petOverlayGeometry.js';
import {
  BUTTON_HOP_MIN_W,
  BUTTON_HOP_MIN_H,
  BUTTON_PRESS_PROBABILITY,
  BUTTON_PRESS_COUNT_MIN,
  BUTTON_PRESS_COUNT_MAX,
} from './constants.js';

/**
 * Pick a random visible, reasonably-sized button on the page and return
 * the (dx, dy) offset from `currentPos` to land the pet's feet just above
 * the button's centre. Returns null if no candidate fits.
 *
 * Filters:
 *   • element matches `button:not([disabled])` or `[role="button"]`
 *     (covers our React buttons + raw <button>s)
 *   • bounding-box within the viewport with a small inner margin
 *   • bounding-box ≥ BUTTON_HOP_MIN_W × BUTTON_HOP_MIN_H so we don't
 *     try to land on a 12 × 12 px close-icon
 *   • not inside `.pet-overlay` (our own hitbox would be a self-target)
 *   • visible (computedStyle.visibility / display, parent chain ok)
 *
 * The press-count roll lives here too — the caller (button-hop scheduler)
 * just consumes the returned pressCount as-is.
 */
export function pickButtonHopTarget(
  currentPos: Point,
): { dx: number; dy: number; pressCount: number } | null {
  const all = document.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [role="button"]:not([aria-disabled="true"])',
  );
  const candidates: Array<{ el: HTMLElement; r: DOMRect }> = [];
  for (const el of all) {
    if (el.closest('.pet-overlay')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < BUTTON_HOP_MIN_W || r.height < BUTTON_HOP_MIN_H) continue;
    if (r.top < 8 || r.left < 8) continue;
    if (r.bottom > window.innerHeight - 8) continue;
    if (r.right > window.innerWidth - 8) continue;
    const cs = window.getComputedStyle(el);
    if (cs.visibility === 'hidden' || cs.display === 'none' || +cs.opacity < 0.1) continue;
    candidates.push({ el, r });
  }
  if (candidates.length === 0) return null;
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  const r = pick.r;
  // Land the pet's feet just above the button's vertical centre. The
  // sprite is anchored bottom-centre via its own padding (PET_H tall),
  // so feeting at button.top + buttonH/2 places the feet on the button's
  // mid-line — visually "standing on the button".
  const targetX = r.left + r.width / 2 - PET_W / 2;
  const targetY = r.top + r.height / 2 - PET_H + 12; // 12 px below feet → buffer
  const clampedTarget = clampPos({ x: targetX, y: targetY });
  const pressRoll = Math.random();
  const pressCount = pressRoll < BUTTON_PRESS_PROBABILITY
    ? BUTTON_PRESS_COUNT_MIN + Math.floor(Math.random() * (BUTTON_PRESS_COUNT_MAX - BUTTON_PRESS_COUNT_MIN + 1))
    : 0;
  return {
    dx: clampedTarget.x - currentPos.x,
    dy: clampedTarget.y - currentPos.y,
    pressCount,
  };
}
