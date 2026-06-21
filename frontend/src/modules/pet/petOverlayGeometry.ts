// petOverlayGeometry — pure helper functions for the FloatingPet overlay.
// Extracted from FloatingPet.tsx to keep it under the 900-line goal.
// These functions are pure or DOM-query-only (no module-level mutable state).

import {
  PET_W,
  PET_H,
  PATROL_GUTTER,
  MIN_PATROL_PX,
  HITBOX_OFFSET_X,
  HITBOX_OFFSET_Y,
} from './petOverlayConstants.js';

export type Point = { x: number; y: number };

/**
 * Parse a `#rgb`, `#rrggbb`, or `rgb(r, g, b)` string into normalised
 * 0..1 RGB triplet. The dual-tone SVG filter feeds these into per-channel
 * `feFuncR/G/B` `linear` slope+intercept components so the desaturated
 * sprite's luminance maps cleanly onto the (dark → bright) theme gradient.
 *
 * Returns null on parse failure so the caller can fall back to a sensible
 * default (e.g. just keep the previous tint values rather than crash the
 * filter on a malformed --accent token).
 */
export function parseColor(s: string): [number, number, number] | null {
  const t = (s || '').trim();
  if (!t) return null;
  if (t.startsWith('#')) {
    let hex = t.slice(1);
    if (hex.length === 3) hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
    if (hex.length !== 6) return null;
    const n = parseInt(hex, 16);
    if (Number.isNaN(n)) return null;
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }
  const m = t.match(/^rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  if (!m) return null;
  return [+m[1] / 255, +m[2] / 255, +m[3] / 255];
}

/** Multiply an RGB color by a 0..1 factor — used to derive a dark shadow
 *  colour from the primary --accent when the theme doesn't define its
 *  own --accent-2. Stays inside the same hue family so the result reads
 *  as the same theme, just darker. */
export function darken(s: string, factor: number): string {
  const c = parseColor(s);
  if (!c) return s;
  const f = Math.max(0, Math.min(1, factor));
  const r = Math.round(c[0] * 255 * f);
  const g = Math.round(c[1] * 255 * f);
  const b = Math.round(c[2] * 255 * f);
  return `#${[r, g, b].map((n) => n.toString(16).padStart(2, '0')).join('')}`;
}

/** Clamp the overlay's top-left so the visible hitbox stays inside the
 *  viewport. `pos` is the .pet-overlay top-left; the hitbox sits at
 *  (HITBOX_OFFSET_X, HITBOX_OFFSET_Y) inside it. Without the offset the
 *  clamp would let the hitbox bleed past the right/bottom edges (the
 *  overlay box extends ~104 px past the hitbox right edge and ~32 px
 *  past the bottom) while pinning it ~56/~40 px inside the left/top
 *  edges — the "margin left/top but no margin right/bottom" asymmetry.
 *  Now the hitbox's four edges are the clamp's four limits. */
export function clampPos(p: Point): Point {
  return {
    x: Math.max(-HITBOX_OFFSET_X, Math.min(window.innerWidth - PET_W - HITBOX_OFFSET_X, p.x)),
    y: Math.max(-HITBOX_OFFSET_Y, Math.min(window.innerHeight - PET_H - HITBOX_OFFSET_Y, p.y)),
  };
}

/**
 * Get the left/right bounds of the chat message area by measuring the first
 * visible `.msg` element inside `#chat-scroll`. All messages share the same
 * horizontal extent due to `max-width + margin:auto` centering. Returns null
 * when no message is in the DOM (empty chat, initial render).
 */
export function msgAreaBounds(): { left: number; right: number } | null {
  const msg = document.querySelector<HTMLElement>('#chat-scroll .msg');
  if (!msg) return null;
  const r = msg.getBoundingClientRect();
  if (r.width < 100) return null;      // sanity — skip collapsed elements
  return { left: r.left, right: r.right };
}

/**
 * Full patrol range — total distance from left-most to right-most reachable
 * position. Keyed to the message area width when messages are visible; falls
 * back to the chat-input wrapper width otherwise.
 */
export function maxPatrolDistance(): number {
  const bounds = msgAreaBounds();
  if (bounds) {
    return Math.max(MIN_PATROL_PX, Math.floor(bounds.right - bounds.left - PET_W - PATROL_GUTTER));
  }
  const input = document.querySelector<HTMLElement>('.chat-input-wrapper, .chat-input-container');
  const w = input?.getBoundingClientRect().width;
  if (typeof w === 'number' && w > 0) {
    return Math.max(MIN_PATROL_PX, Math.floor(w - PET_W - PATROL_GUTTER));
  }
  return Math.max(MIN_PATROL_PX, Math.floor(window.innerWidth * 0.4));
}

/**
 * Randomise the next XP burst threshold. Range comes from the manifest's
 * `xpeffectInterval` config or sensible defaults (180–540 s). Returns
 * milliseconds.
 */
export function randomXpThreshold(range?: { min: number; max: number }): number {
  const min = Math.max(30, range?.min ?? 180);
  const max = Math.max(min, range?.max ?? 540);
  return (min + Math.floor(Math.random() * (max - min + 1))) * 1000;
}

