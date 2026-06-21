// Tutorial overlay — spotlight + explanation card.
//
// Renders nothing until the tour is active. While active it dims the UI,
// cuts a spotlight hole over the current step's target (recomputed against
// the live DOM so it tracks scroll / resize / late-arriving panels), and
// shows a card with Back / Next / Skip / Done. Esc skips; ←/→ navigate.
//
// Targets are resolved from the store's step list every frame-batch, so a
// target that animates in (e.g. the Preferences modal) or moves is followed
// automatically; one that never appears falls back to a centered card.

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTutorialStore } from './tutorial-state.js';
import type { TutorialStep, TutorialPlacement } from './tutorial-types.js';

interface Box { top: number; left: number; width: number; height: number; }

const PAD = 8;            // spotlight breathing room around the target
const CARD_W = 340;
const GAP = 14;           // distance from spotlight to the card
const MARGIN = 12;        // min distance from the viewport edge

function unionBox(els: Element[]): Box | null {
  if (!els.length) return null;
  let top = Infinity, left = Infinity, right = -Infinity, bottom = -Infinity;
  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    top = Math.min(top, r.top);
    left = Math.min(left, r.left);
    right = Math.max(right, r.right);
    bottom = Math.max(bottom, r.bottom);
  }
  if (!isFinite(top)) return null;
  return { top, left, width: right - left, height: bottom - top };
}

function resolveBox(step: TutorialStep | undefined): Box | null {
  if (!step?.target) return null;
  let result: Element | Element[] | null = null;
  try { result = step.target(); } catch { return null; }
  const els = (Array.isArray(result) ? result : result ? [result] : []).filter(
    (el): el is Element => !!el,
  );
  const box = unionBox(els);
  if (!box) return null;
  return {
    top: box.top - PAD,
    left: box.left - PAD,
    width: box.width + PAD * 2,
    height: box.height + PAD * 2,
  };
}

/** Place the card next to the spotlight, clamped to the viewport. */
function placeCard(
  box: Box | null,
  placement: TutorialPlacement,
  cardSize: { w: number; h: number },
): { left: number; top: number } {
  const vw = window.innerWidth, vh = window.innerHeight;
  const { w, h } = cardSize;
  if (!box || placement === 'center') {
    return { left: (vw - w) / 2, top: (vh - h) / 2 };
  }

  // Auto: pick the side with the most room around the spotlight.
  let side: TutorialPlacement = placement;
  if (side === 'auto') {
    const space = {
      bottom: vh - (box.top + box.height),
      top: box.top,
      right: vw - (box.left + box.width),
      left: box.left,
    };
    side = (Object.entries(space).sort((a, b) => b[1] - a[1])[0][0]) as TutorialPlacement;
  }

  let left: number, top: number;
  switch (side) {
    case 'top':
      left = box.left + box.width / 2 - w / 2;
      top = box.top - GAP - h;
      break;
    case 'bottom':
      left = box.left + box.width / 2 - w / 2;
      top = box.top + box.height + GAP;
      break;
    case 'left':
      left = box.left - GAP - w;
      top = box.top + box.height / 2 - h / 2;
      break;
    case 'right':
    default:
      left = box.left + box.width + GAP;
      top = box.top + box.height / 2 - h / 2;
      break;
  }
  left = Math.max(MARGIN, Math.min(vw - w - MARGIN, left));
  top = Math.max(MARGIN, Math.min(vh - h - MARGIN, top));
  return { left, top };
}

export function Tutorial() {
  const active = useTutorialStore((s) => s.active);
  const steps = useTutorialStore((s) => s.steps);
  const index = useTutorialStore((s) => s.index);
  const tick = useTutorialStore((s) => s.tick);
  const next = useTutorialStore((s) => s.next);
  const back = useTutorialStore((s) => s.back);
  const skip = useTutorialStore((s) => s.skip);

  const step = steps[index];
  const cardRef = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState<Box | null>(null);
  const [cardPos, setCardPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });

  // Accurate progress readout — count only steps that would actually show.
  const { displayTotal, displayNum } = useMemo(() => {
    let total = 0, num = 0;
    steps.forEach((s, i) => {
      let shows = true;
      if (s.target && !s.keepIfNoTarget) {
        try {
          const t = s.target();
          shows = (Array.isArray(t) ? t.length : t ? 1 : 0) > 0;
        } catch { shows = false; }
      }
      if (shows) {
        total += 1;
        if (i <= index) num += 1;
      }
    });
    return { displayTotal: total || steps.length, displayNum: num || 1 };
    // tick forces a recount after each transition / DOM change.
  }, [steps, index, tick]);

  const recompute = useCallback(() => {
    if (!step) return;
    const b = resolveBox(step);
    setBox(b);
    const card = cardRef.current;
    const size = card
      ? { w: card.offsetWidth || CARD_W, h: card.offsetHeight || 180 }
      : { w: CARD_W, h: 180 };
    setCardPos(placeCard(b, step.placement ?? 'auto', size));
  }, [step]);

  // Recompute on transition, scroll, resize, and a few delayed ticks so that
  // panels animating in (Preferences) settle under the spotlight.
  useLayoutEffect(() => {
    if (!active || !step) return;
    recompute();
    const timers = [60, 180, 360, 600].map((ms) => window.setTimeout(recompute, ms));
    const onScroll = () => recompute();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    const ro = new ResizeObserver(recompute);
    ro.observe(document.body);
    return () => {
      timers.forEach(clearTimeout);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
      ro.disconnect();
    };
  }, [active, step, tick, recompute]);

  // Keyboard navigation (capture phase so the app behind stays inert).
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); skip(); }
      else if (e.key === 'ArrowRight' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); void next(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); void back(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active, next, back, skip]);

  if (!active || !step) return null;

  const isFinish = step.group === 'finish';
  const isFirst = index === 0;

  const overlay = (
    <div className="tut-root" role="dialog" aria-modal="true" aria-label="Tutorial">
      {/* Click-blocker — keeps the app behind inert during the tour. */}
      <div className="tut-block" />

      {/* Spotlight cutout (box-shadow dims everything outside the hole). */}
      {box ? (
        <div
          className="tut-spot"
          style={{ top: box.top, left: box.left, width: box.width, height: box.height }}
        />
      ) : (
        <div className="tut-dim" />
      )}

      {/* Explanation card */}
      <div className="tut-card" ref={cardRef} style={{ left: cardPos.left, top: cardPos.top }}>
        <div className="tut-card-progress">
          <span className="tut-card-section">{step.groupLabel}</span>
          <span className="tut-card-count">{displayNum} / {displayTotal}</span>
        </div>
        <h3 className="tut-card-title">{step.title}</h3>
        <p className="tut-card-body">{step.body}</p>
        <div className="tut-card-actions">
          <button type="button" className="tut-btn tut-btn-ghost" onClick={skip}>
            Skip
          </button>
          <div className="tut-card-actions-right">
            {!isFirst && (
              <button type="button" className="tut-btn" onClick={() => void back()}>
                Back
              </button>
            )}
            <button type="button" className="tut-btn tut-btn-primary" onClick={() => void next()}>
              {isFinish ? 'Done' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(overlay, document.body);
}
