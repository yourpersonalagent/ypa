// usePetWorldModel — captures a debounced snapshot of the pet's surroundings.
//
// Producer-side of petWorldStore. Lifecycle rules:
//
//   • Visibility-gated: when the pet is hidden or behindUi the hook unmounts
//     the rAF loop and clears the store to null. No background CPU when
//     the pet isn't on screen.
//
//   • Lazy / posKey-debounced: rAF ticks read the pet's CSS-var posKey (O(1),
//     no forced layout). While the posKey changes the pet is moving — we
//     defer capture. Once the posKey has been stable for STILL_DELAY_MS,
//     a single snapshot is captured and pushed to the store. A new posKey
//     change resets the timer.
//
//   • Idempotent: each posKey produces exactly one snapshot. If the pet
//     comes to rest at the same posKey it had before (rare but possible
//     after drag+release), the snapshot is re-captured because focused
//     elements / nearby buttons may have changed in the meantime.
//
// Snapshot capture is a single querySelectorAll + getBoundingClientRect
// sweep — O(buttons+inputs), runs at most every STILL_DELAY_MS so the cost
// is amortised. Read-only on the DOM; no mutations.

import { useEffect } from 'react';
import type React from 'react';
import { usePetStore } from '../store/petStore.js';
import {
  usePetWorldStore,
  type PetWorldSnapshot,
  type PetRect,
  type NearbyElement,
  type NearbyInput,
  type NearbyPanel,
  type PetActiveRegion,
  type FocusedElement,
} from '../store/petWorldStore.js';

const POS_VARS = ['--pet-x', '--pet-y', '--pet-patrol-x', '--pet-offset-y'] as const;
/** Quiet time after the pet's last move before we capture a snapshot. */
const STILL_DELAY_MS = 2000;
/** rAF throttle floor — even when moving, don't burn rAF on every frame. */
const RAF_THROTTLE_MS = 200;
/** Top-N visible buttons kept in the snapshot. Limits push payload size and
 *  keeps the debug overlay readable. */
const MAX_VISIBLE_BUTTONS = 8;

export function usePetWorldModel(petElRef: React.RefObject<HTMLElement | null>): void {
  const isVisible = usePetStore((s) => s.isVisible);
  // behindUi == pet sits behind chat content; "nearest button" loses meaning
  // (the pet is occluded by everything) so we don't run.
  const behindUi = usePetStore((s) => s.behindUi);

  useEffect(() => {
    if (!isVisible || behindUi) {
      usePetWorldStore.getState().setSnapshot(null);
      return;
    }

    let cancelled = false;
    let rafId = 0;
    let lastTickAt = 0;
    let lastPosKey = '';
    let stillSinceAt = 0;
    let snapshotPosKey = '';

    function tick(now: number) {
      if (cancelled) return;
      rafId = requestAnimationFrame(tick);
      if (now - lastTickAt < RAF_THROTTLE_MS) return;
      lastTickAt = now;

      const petEl = petElRef.current;
      if (!petEl) return;

      const posKey = POS_VARS.map((v) => petEl.style.getPropertyValue(v)).join('|');
      if (posKey !== lastPosKey) {
        // Pet moved (or first tick) — restart the still-timer.
        lastPosKey = posKey;
        stillSinceAt = now;
        return;
      }
      if (snapshotPosKey === posKey) return;            // already captured for this rest
      if (now - stillSinceAt < STILL_DELAY_MS) return;  // not still long enough yet

      const snapshot = captureSnapshot(petEl);
      if (snapshot) {
        snapshotPosKey = posKey;
        usePetWorldStore.getState().setSnapshot(snapshot);
        // Phase 4b: push to the bridge's in-memory store so the MCP
        // pet_observe tool can describe the pet's surroundings to other
        // agents. Fire-and-forget — failures don't affect FE behavior.
        pushSnapshotToBridge(snapshot);
      }
    }

    rafId = requestAnimationFrame(tick);
    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      usePetWorldStore.getState().setSnapshot(null);
      // Tell the bridge to drop its cached snapshot so the MCP tool
      // doesn't surface stale coords after the pet goes hidden.
      clearSnapshotOnBridge();
    };
  }, [isVisible, behindUi, petElRef]);
}

// ── Bridge push (Phase 4b) ────────────────────────────────────────────────

/** Same base-url discovery the rest of the FE uses. window.API_CONFIG is set
 *  by frontend/src/api.ts at module init; fall back to the page origin so
 *  this hook is safe to import before api.ts ran. */
function bridgeBaseUrl(): string {
  const cfg = (window as Window & { API_CONFIG?: { baseUrl?: string } }).API_CONFIG;
  return cfg?.baseUrl || window.location.origin;
}

function pushSnapshotToBridge(snapshot: PetWorldSnapshot): void {
  try {
    void fetch(bridgeBaseUrl() + '/v1/pet-vision/snapshot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // keepalive ensures the push survives a pagehide / unload race so
      // the bridge sees the latest snapshot even if the tab closes a
      // beat later — same trick we use for telemetry pings.
      keepalive: true,
      body: JSON.stringify({
        snapshot,
        viewport: { width: window.innerWidth, height: window.innerHeight },
      }),
    }).catch(() => { /* fire-and-forget */ });
  } catch { /* never block the rAF loop on push failures */ }
}

function clearSnapshotOnBridge(): void {
  try {
    void fetch(bridgeBaseUrl() + '/v1/pet-vision/snapshot', {
      method: 'DELETE',
      keepalive: true,
    }).catch(() => { /* fire-and-forget */ });
  } catch { /* swallow */ }
}

// ── Capture ────────────────────────────────────────────────────────────────

function captureSnapshot(petEl: HTMLElement): PetWorldSnapshot | null {
  const hitboxEl = petEl.querySelector<HTMLElement>('.pet-hitbox');
  const petRectDom = (hitboxEl ?? petEl).getBoundingClientRect();
  const petRect = rectToPlain(petRectDom);

  const buttons = collectButtons(petRectDom);
  const visibleButtons = buttons
    .slice()
    .sort((a, b) => b.importance - a.importance)
    .slice(0, MAX_VISIBLE_BUTTONS);

  const nearestButton = buttons.length
    ? buttons.slice().sort((a, b) => a.distancePx - b.distancePx)[0]
    : null;

  const nearestInput = pickNearestInput(petRectDom);
  const nearestPanel = pickNearestPanel(petRectDom);
  const activeRegion = detectRegion(petRectDom);
  const focusedElement = readFocusedElement();

  return {
    petPos: { x: petRect.left, y: petRect.top },
    petRect,
    nearest: {
      button: nearestButton,
      input: nearestInput,
      panel: nearestPanel,
    },
    visibleButtons,
    activeRegion,
    focusedElement,
    capturedAt: performance.now(),
  };
}

// ── DOM helpers ────────────────────────────────────────────────────────────

function rectToPlain(r: DOMRect): PetRect {
  return {
    left: r.left,
    top: r.top,
    right: r.right,
    bottom: r.bottom,
    width: r.width,
    height: r.height,
  };
}

/** Edge-to-edge distance between two rects in px. 0 if they overlap. */
function rectDistance(a: DOMRect | PetRect, b: DOMRect | PetRect): number {
  const dx = Math.max(0, Math.max(a.left, b.left) - Math.min(a.right, b.right));
  const dy = Math.max(0, Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom));
  if (dx === 0 && dy === 0) return 0;
  return Math.round(Math.hypot(dx, dy));
}

/** Pick the human-readable label for an element: aria-label > title >
 *  trimmed visible text > tag. Caller filters empty results. */
function elementLabel(el: HTMLElement): string {
  const aria = el.getAttribute('aria-label');
  if (aria && aria.trim()) return aria.trim().slice(0, 80);
  const title = el.getAttribute('title');
  if (title && title.trim()) return title.trim().slice(0, 80);
  const text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
  if (text) return text.slice(0, 80);
  const ph = el.getAttribute('placeholder');
  if (ph && ph.trim()) return ph.trim().slice(0, 80);
  return el.tagName.toLowerCase();
}

/** Best-effort CSS selector. Not guaranteed unique — just a hint. */
function bestSelector(el: HTMLElement): string {
  if (el.id) return `#${el.id}`;
  const testId = el.getAttribute('data-testid');
  if (testId) return `[data-testid="${testId}"]`;
  const tag = el.tagName.toLowerCase();
  const cls = el.classList.length
    ? '.' + Array.from(el.classList).slice(0, 2).join('.')
    : '';
  return `${tag}${cls}`;
}

function isVisuallyVisible(el: HTMLElement): boolean {
  const cs = getComputedStyle(el);
  if (cs.visibility === 'hidden' || cs.display === 'none') return false;
  if (Number(cs.opacity) < 0.1) return false;
  return true;
}

function inViewport(r: DOMRect): boolean {
  return r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
}

// ── Buttons ────────────────────────────────────────────────────────────────

function collectButtons(petRect: DOMRect): NearbyElement[] {
  const out: NearbyElement[] = [];
  const els = document.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [role="button"]:not([aria-disabled="true"])',
  );
  for (const el of els) {
    if (el.closest('.pet-overlay')) continue;          // skip our own UI
    const r = el.getBoundingClientRect();
    if (r.width < 8 || r.height < 8) continue;          // micro icons
    if (!inViewport(r)) continue;
    if (!isVisuallyVisible(el)) continue;
    const label = elementLabel(el);
    if (!label) continue;
    out.push({
      label,
      rect: rectToPlain(r),
      distancePx: rectDistance(petRect, r),
      importance: scoreImportance(el, r),
      selector: bestSelector(el),
    });
  }
  return out;
}

/** Heuristic importance score, clamped 0..1. Header buttons, primary-action
 *  classes, and larger surfaces score higher. The pet uses this to decide
 *  *which* buttons are worth talking about / hopping toward. */
function scoreImportance(el: HTMLElement, r: DOMRect): number {
  let s = 0.3;
  // Header / top-bar buttons are usually navigation or session controls.
  if (r.top < 80) s += 0.2;
  // Common primary-action class names YHA uses across panels.
  if (el.classList.contains('btn-primary') || el.classList.contains('is-primary')) s += 0.25;
  if (el.getAttribute('data-primary') === 'true') s += 0.25;
  // Send-button / chat-input area: high signal for an "active region" pet.
  if (el.closest('.chat-input-wrapper, .chat-input-container')) s += 0.15;
  // Size weight — a big rectangular button is more likely meaningful.
  const area = r.width * r.height;
  if (area > 80 * 28) s += 0.05;
  if (area > 160 * 40) s += 0.05;
  // Popup triggers (menu / palette openers) get a small bonus.
  if (el.getAttribute('aria-haspopup')) s += 0.05;
  return Math.max(0, Math.min(1, s));
}

// ── Inputs ─────────────────────────────────────────────────────────────────

function pickNearestInput(petRect: DOMRect): NearbyInput | null {
  const els = document.querySelectorAll<HTMLElement>(
    'input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), [contenteditable="true"]',
  );
  let best: NearbyInput | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  const active = document.activeElement;
  for (const el of els) {
    if (el.closest('.pet-overlay')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 20 || r.height < 14) continue;
    if (!inViewport(r)) continue;
    if (!isVisuallyVisible(el)) continue;
    const d = rectDistance(petRect, r);
    if (d >= bestDist) continue;
    const tag = el.tagName.toLowerCase();
    const kind: NearbyInput['kind'] =
      tag === 'textarea' ? 'textarea'
      : tag === 'input' ? 'input'
      : 'contenteditable';
    const placeholder =
      (el as HTMLInputElement).placeholder
      || el.getAttribute('placeholder')
      || el.getAttribute('aria-placeholder')
      || '';
    best = {
      label: elementLabel(el) || placeholder || tag,
      rect: rectToPlain(r),
      distancePx: d,
      importance: scoreImportance(el, r),
      selector: bestSelector(el),
      placeholder,
      hasFocus: active === el,
      kind,
    };
    bestDist = d;
  }
  return best;
}

// ── Panels ─────────────────────────────────────────────────────────────────

/** "Panel-ish" element that the pet can perch near. We accept multiple
 *  semantic markers because YHA's panels are heterogeneous (tabs, popovers,
 *  command palette, modals). */
function pickNearestPanel(petRect: DOMRect): NearbyPanel | null {
  const sels = [
    '[role="dialog"]',
    '[role="region"]',
    '.popover',
    '.modal',
    '.tab-panel',
    '.app-cmd-palette',
    '#chat-scroll',
  ].join(', ');
  const els = document.querySelectorAll<HTMLElement>(sels);
  let best: NearbyPanel | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width < 80 || r.height < 60) continue;
    if (!inViewport(r)) continue;
    if (!isVisuallyVisible(el)) continue;
    const d = rectDistance(petRect, r);
    if (d >= bestDist) continue;
    best = {
      label: el.getAttribute('aria-label')
        || el.getAttribute('data-panel-id')
        || el.id
        || el.className.split(' ')[0]
        || 'panel',
      rect: rectToPlain(r),
      id: el.id || bestSelector(el),
    };
    bestDist = d;
  }
  return best;
}

// ── Region detection ──────────────────────────────────────────────────────

function detectRegion(petRect: DOMRect): PetActiveRegion {
  const cx = petRect.left + petRect.width / 2;
  const cy = petRect.top + petRect.height / 2;
  const point = document.elementFromPoint(cx, cy);
  if (point instanceof HTMLElement) {
    if (point.closest('#react-app-command-palette, .app-cmd-palette')) return 'command-palette';
    if (point.closest('.chat-input-wrapper, .chat-input-container')) return 'chat-input';
    if (point.closest('#chat-scroll, #view-chat')) return 'chat';
    if (point.closest('[role="dialog"], .modal, .popover, .tab-panel')) return 'panel';
    if (point.closest('header, [role="banner"]') || cy < 64) return 'header';
  } else if (cy < 64) {
    return 'header';
  }
  return 'free';
}

// ── Focused element ────────────────────────────────────────────────────────

function readFocusedElement(): FocusedElement | null {
  const el = document.activeElement;
  if (!(el instanceof HTMLElement)) return null;
  if (el === document.body) return null;
  if (el.closest('.pet-overlay')) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return null;
  return {
    tag: el.tagName.toLowerCase(),
    label: elementLabel(el),
    rect: rectToPlain(r),
  };
}
