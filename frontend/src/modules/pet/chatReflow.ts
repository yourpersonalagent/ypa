// useChatReflow — CSS float reflow around the pet.
//
// When petTextReflow pref is ON (and the pet is in front of the UI):
// watches the pet's position via a requestAnimationFrame loop and sets
// CSS custom properties (--pet-float-*) on whichever .msg element the
// pet is currently overlapping. A CSS ::before rule on .msg-bubble reads
// those vars and creates a float that wraps the bubble's text around the
// pet natively — no Preact, no JS line-break math.
//
// CSS var approach (replaces the old DOM sentinel):
//   --pet-float-dir: right | left
//   --pet-float-w:   Wpx
//   --pet-float-h:   Hpx
//   --pet-float-mt:  Mpx
//   data-pet-float="1" on the .msg element activates the ::before rule.
//
// Why not a DOM node? The old approach injected a <div> as the first child
// of .msg-bubble. That worked for completed messages, but during streaming
// React's dangerouslySetInnerHTML replaces .msg's entire innerHTML on every
// chunk (~20x/s), wiping the sentinel and causing 1-frame reflow flicker
// per chunk. CSS custom properties set on the .msg element via
// el.style.setProperty() are never touched by innerHTML replacement — they
// live on the element itself. The ::before pseudo-element is recomputed from
// the CSS rule each frame, so it is always up to date regardless of whether
// .msg-bubble was just re-created by React.
//
// When the pet leaves a message (or the pref is off / pet is behind UI),
// the CSS vars and data-pet-float attribute are cleared. Only one message
// has the float active at a time.
//
// Performance notes:
//   - Position key (CSS var read, O(1)) short-circuits the expensive
//     querySelectorAll + getBoundingClientRect scan when the pet is
//     stationary. The pet is stationary ~95% of the time so this
//     eliminates almost all of the 60fps scan cost.
//   - When the position KEY changes (patrol starts), a MOTION_TRACK window
//     opens so the sentinel keeps updating for the full patrol transition
//     (~900ms CSS slide). Without this, the float would snap to the
//     target bubble immediately while the pet is still mid-animation.

import { useEffect, useRef } from 'react';
import type React from 'react';
import { usePetStore } from './store/petStore.js';
import { useChatStore } from '../../stores/chatStore.js';

// CSS variable names that encode the pet's effective viewport position.
// Reading inline styles is free (no forced layout); getBoundingClientRect is not.
const POS_VARS = ['--pet-x', '--pet-y', '--pet-patrol-x', '--pet-offset-y'] as const;

// Hysteresis thresholds for float height. A single threshold (old: 16px)
// causes rapid insert/remove cycling when the pet sits at the bottom of a
// message and the float itself changes the bubble's text layout:
//
//   float activated → text reflows → mentionedFilesEl.offsetTop shifts
//   → effectiveHeight shifts by a few px → height crosses 16px → float
//   removed → text reflows back → height rises above 16px again → repeat.
//
// The deadband (activate only at ≥ FLOAT_HEIGHT_INSERT, deactivate only at
// < FLOAT_HEIGHT_REMOVE) breaks the oscillation: once removed, the pet
// must move far enough that there is clearly usable room; once activated,
// only a clear exit from the bubble removes it.
const FLOAT_HEIGHT_INSERT = 24;  // px — new float requires this much room
const FLOAT_HEIGHT_REMOVE = 10;  // px — existing float survives down to this
/** Bottom padding of .msg-bubble (CSS: padding: 18px 14px 10px).
 *  A float that lands solely inside this padding zone overlaps only the
 *  tail of the last text line — not a full line — so the browser wraps
 *  that line to a new row *below* the float, inflating the bubble by a
 *  full line-height.  At font-size:2em (user bubbles) that is ~48 px of
 *  sudden empty space.  Subtracting this from effectiveHeight keeps the
 *  float inside the live text area and prevents the gap. */
const BUBBLE_PADDING_BOTTOM = 10; // px — matches .msg-bubble padding-bottom
/** Top padding of .msg-bubble (CSS: padding: 18px 14px 10px).
 *  Used together with BUBBLE_PADDING_BOTTOM and the float geometry to
 *  compute the "float floor" — the bubble height when the float (not the
 *  text) is the tallest element in the BFC:
 *    floatFloor = BUBBLE_PADDING_TOP + float.marginTop + float.height + BUBBLE_PADDING_BOTTOM
 *  Comparing msgRect.height against floatFloor lets us distinguish
 *  float-driven BFC expansion (height ≤ floatFloor) from real streaming
 *  content growth (height > floatFloor). */
const BUBBLE_PADDING_TOP = 18; // px — matches .msg-bubble padding-top
/** Breathing room around the pet's bounding box so text doesn't hug
 *  the sprite edge. Horizontal only — the height is exact. */
const FLOAT_PAD_X = 8;
/** How long after a position-key change we keep re-evaluating the float
 *  on every rAF tick, to cover the CSS patrol transition (~900ms) plus buffer. */
const MOTION_TRACK_MS = 1300;
/** After every float geometry change (apply OR clear), suppress scroll-dirty
 *  for this many ms to break the reflow → scroll → rescan feedback loop.
 *  Text reflow triggered by the float change fires a scroll event; without
 *  the cooldown that scroll event would re-enter the scan path immediately
 *  and could flip the float back, causing paragraph-height oscillation. */
const FLOAT_CHANGE_COOLDOWN_MS = 250;

/**
 * React hook. Call inside FloatingPet with the ref to the outer
 * .pet-overlay div. Manages the CSS float lifecycle.
 */
export function useChatReflow(
  petElRef: React.RefObject<HTMLElement | null>,
): void {
  const petTextReflow = usePetStore((s) => s.petTextReflow);
  const isVisible = usePetStore((s) => s.isVisible);
  // When the pet is behind the UI, text flows OVER the pet — wrapping text
  // around it makes no visual sense. Disable float entirely.
  const behindUi = usePetStore((s) => s.behindUi);

  // Track which .msg element currently has the CSS float vars set so we
  // can clear them efficiently without querySelectorAll on every frame.
  const floatMsgRef = useRef<HTMLElement | null>(null);
  // Last CSS-var posKey seen — used to skip frames where the pet didn't move.
  const lastPosKeyRef = useRef<string>('');
  // Timestamp until which we keep running the full scan after a motion start,
  // to cover the patrol CSS transition (~900ms).
  const motionEndTimeRef = useRef<number>(0);
  // Becomes true on scroll so the bubble scan runs even when pet position is
  // unchanged (scrolling moves messages relative to the fixed pet).
  const scrollDirtyRef = useRef<boolean>(false);
  // Cached float geometry (rounded px). Compared before every CSS var write
  // so we skip updates when nothing changed — prevents spurious style mutations
  // that can dirty paint even when values are "the same".
  const lastGeomRef = useRef<{ dir: string; w: number; h: number; mt: number } | null>(null);
  // Cooldown timestamp: after each float geometry change, suppress scroll-dirty
  // events for FLOAT_CHANGE_COOLDOWN_MS to break the feedback loop where the
  // float-induced text reflow changes scrollHeight, which fires a scroll event,
  // which triggers a rescan, which may flip the float back → oscillation.
  // Particularly visible with larger pet sizes where the float height is big
  // enough to shift entire paragraphs between line-wrap states.
  const floatChangedAtRef = useRef<number>(0);
  // Snapshot of the bubble's height at the moment we FIRST apply a float to it.
  // Prevents the BFC feedback loop: .msg-bubble is a flex item, which makes it
  // a block formatting context (BFC). A BFC expands to contain internal floats.
  // So after we apply ::before { float; height: Hpx }, the bubble grows by up to
  // H px. The next rAF tick reads the taller msgRect.height, computes a larger
  // effectiveHeight → larger float height → even taller bubble → runaway, until
  // the bubble hits the pet's body height (~168 px) and the chat looks full of
  // empty blocks.
  // We break the loop by using this snapshot as the stable height baseline.
  // Updated upward only when streaming content genuinely grows the bubble past
  // what the float alone can explain (msgRect.height > floatFloor + jitter).
  const preFLoatHeightRef = useRef<number>(0);

  useEffect(() => {
    // When the pref is off, pet is hidden, or pet is behind the UI: no float.
    if (!petTextReflow || !isVisible || behindUi) {
      clearFloat(floatMsgRef, lastGeomRef);
      return;
    }

    let rafId: number;
    let cancelled = false;

    // A scroll on the chat panel changes which bubble the (fixed) pet overlaps,
    // so mark dirty — the next tick will run the full intersection scan.
    // Exception: if a float change just happened, the scroll was likely caused
    // by the float-induced text reflow (not a user scroll), so we suppress it
    // for FLOAT_CHANGE_COOLDOWN_MS to avoid the height-oscillation feedback loop.
    const scrollEl = document.getElementById('chat-scroll');
    const onScroll = () => {
      // During streaming the chat auto-scrolls ~20×/s. Each scroll event here
      // would trigger a getBoundingClientRect scan + forced layout (Layerize)
      // — 20 GPU compositing cycles per second. Skip while any stream is live;
      // the float will re-sync on the next motion or post-stream scroll.
      const streams = useChatStore.getState().sessionStreams;
      const anyLive = Object.values(streams).some(
        (s) => s.localLive || s.reconnecting || s.serverActive,
      );
      if (anyLive) return;
      if (performance.now() - floatChangedAtRef.current > FLOAT_CHANGE_COOLDOWN_MS) {
        scrollDirtyRef.current = true;
      }
    };
    scrollEl?.addEventListener('scroll', onScroll, { passive: true });

    function tick() {
      if (cancelled) return;
      rafId = requestAnimationFrame(tick);

      const petEl = petElRef.current;
      if (!petEl) {
        clearFloat(floatMsgRef, lastGeomRef);
        return;
      }

      // Fast position check via inline CSS var reads — O(1), no forced layout.
      // Include --pet-global-scale so a size change reopens the motion-track
      // window: a scaled pet needs float dimensions recalculated even while
      // stationary, and the scale change deserves a fresh cooldown window too.
      const posKey = [
        ...POS_VARS.map((v) => petEl.style.getPropertyValue(v)),
        petEl.style.getPropertyValue('--pet-global-scale'),
      ].join('|');
      const now = performance.now();

      if (posKey !== lastPosKeyRef.current) {
        // Position TARGET changed — pet started a new patrol or teleported.
        // Open a motion-track window so we keep scanning during the CSS transition.
        lastPosKeyRef.current = posKey;
        motionEndTimeRef.current = now + MOTION_TRACK_MS;
      } else if (now > motionEndTimeRef.current && !scrollDirtyRef.current) {
        // Pet is stationary and motion window has closed — skip expensive ops.
        return;
      }
      scrollDirtyRef.current = false;

      // Use the hitbox element for the float rect so the displacement zone
      // tracks the actual sprite body (136×168 px base) rather than the full
      // 240×240 overlay box.  Both include the --pet-global-scale transform
      // (getBoundingClientRect always returns visual/post-transform bounds),
      // but the hitbox excludes the transparent margins on the left (56 px)
      // and top (40 px) of the overlay, giving a correctly-proportioned zone
      // that grows and shrinks in step with the pet-size slider.
      const hitboxEl = petEl.querySelector<HTMLElement>('.pet-hitbox');
      const petRect = (hitboxEl ?? petEl).getBoundingClientRect();

      // Find all message bubble prose containers.
      const bubbles = document.querySelectorAll<HTMLElement>(
        '#chat-scroll .msg.agent .msg-bubble, #chat-scroll .msg.user .msg-bubble',
      );

      let targetBubble: HTMLElement | null = null;
      let targetMsgRect: DOMRect | null = null;

      // Only call getBoundingClientRect on bubbles that are in the visible
      // viewport — bubbles scrolled off-screen can never intersect the fixed
      // pet, so skipping them avoids the expensive forced-layout calls that
      // produced 130 ms+ reflow violations with long chat histories.
      const vh = window.innerHeight;
      for (const bubble of bubbles) {
        const msgRect = bubble.getBoundingClientRect();
        // Skip if the bubble is entirely above or below the viewport.
        if (msgRect.bottom < 0 || msgRect.top > vh) continue;
        if (rectsIntersect(petRect, msgRect)) {
          targetBubble = bubble;
          targetMsgRect = msgRect;
          break; // first intersecting bubble wins
        }
      }

      if (!targetBubble || !targetMsgRect) {
        // Pet is not over any message — clear float.
        clearFloat(floatMsgRef, lastGeomRef);
        return;
      }

      // The CSS vars are set on the .msg element (parent of .msg-bubble) so
      // they survive dangerouslySetInnerHTML updates during streaming: React
      // replaces .msg's innerHTML (recreating .msg-bubble) but never touches
      // .msg's own style attribute. The ::before pseudo-element on .msg-bubble
      // re-reads the vars from .msg on every browser layout pass.
      const targetMsg = targetBubble.closest<HTMLElement>('.msg');
      if (!targetMsg) {
        clearFloat(floatMsgRef, lastGeomRef);
        return;
      }

      // User messages are short (1-2 lines, font-size: 2em). Applying a float
      // whose height exceeds the text content makes the bubble taller than the
      // text, creating an empty gap below the last line. Skip float for user
      // messages — the wrap effect is only meaningful on long agent responses.
      if (targetMsg.classList.contains('user')) {
        clearFloat(floatMsgRef, lastGeomRef);
        return;
      }

      const msgRect = targetMsgRect;

      // ── Stable pre-float height baseline ─────────────────────────────────
      // Must run before effectiveHeight is computed (it feeds into it).
      //
      // When switching to a new bubble: record the current height as the
      // baseline (no float has been applied yet → height is the natural
      // content height).
      //
      // When staying on the same bubble: only update the baseline upward when
      // real content growth (streaming) pushes the bubble past the "float
      // floor" — the minimum height the BFC reaches due to the float alone:
      //   floatFloor = paddingTop + float.marginTop + float.height + paddingBottom
      // If msgRect.height ≤ floatFloor (+4 px jitter), the height is driven
      // by the float; we keep the snapshot and prevent the runaway growth.
      // If msgRect.height > floatFloor, real text content grew past the float;
      // we update the snapshot so the float can grow proportionally.
      if (floatMsgRef.current !== targetMsg) {
        preFLoatHeightRef.current = msgRect.height;
      } else if (lastGeomRef.current) {
        const lg = lastGeomRef.current;
        const floatFloor = BUBBLE_PADDING_TOP + lg.mt + lg.h + BUBBLE_PADDING_BOTTOM;
        if (msgRect.height > floatFloor + 4) {
          preFLoatHeightRef.current = msgRect.height;
        }
      }

      // Decide float direction: if the pet's horizontal centre is right
      // of the bubble's horizontal centre, float right; else float left.
      const petCentreX = petRect.left + petRect.width / 2;
      const msgCentreX = msgRect.left + msgRect.width / 2;
      const floatDir: 'right' | 'left' = petCentreX > msgCentreX ? 'right' : 'left';

      // ── Height budget ─────────────────────────────────────────────────────
      // File-chip strips (.msg-mentioned-files / .msg-external-files) sit at
      // the bottom of agent bubbles. Their layout doesn't interact cleanly
      // with an in-flow float, so we treat the top edge of the first strip
      // as the hard lower boundary for the float.
      const mentionedFilesEl =
        targetBubble.querySelector<HTMLElement>('.msg-mentioned-files, .msg-external-files');
      // effectiveHeight = usable area ABOVE the chip strip (or full bubble
      // height minus padding-bottom).  We always strip the bottom padding
      // because a float that overlaps only the padding zone (no real text) still
      // forces the last text line to wrap to a new row — creating a visible gap
      // that is especially large in user messages (font-size: 2em ≈ 48 px/line).
      //
      // For the non-mentionedFiles path we use preFLoatHeightRef (the snapshot
      // taken before the float was applied) instead of msgRect.height. This
      // breaks the BFC feedback loop: once the float is active, the flex-item
      // BFC expands the bubble to contain it; using the inflated msgRect.height
      // would grow the float each frame until it saturates at the pet body
      // height, creating the large empty blocks the user sees.
      const effectiveHeight = mentionedFilesEl
        ? Math.max(0, mentionedFilesEl.offsetTop - 4) // 4 px gap above strip
        : Math.max(0, preFLoatHeightRef.current - BUBBLE_PADDING_BOTTOM);

      // margin-top offsets the float from the bubble top to where the pet
      // actually sits; clamped to the effective area.
      const marginTop = Math.max(0, Math.min(petRect.top - msgRect.top, effectiveHeight - 1));

      // Clamp float height so (marginTop + height) never exceeds effectiveHeight.
      // Without this a pet at/near the bottom creates space below the bubble.
      const availableHeight = Math.max(0, effectiveHeight - marginTop);
      const height = Math.min(petRect.height, availableHeight);

      // Hysteresis gate: use a deadband instead of a single threshold.
      // Without this, the float being near the bottom of a bubble causes a
      // feedback loop: float → text reflows → mentionedFilesEl shifts →
      // effectiveHeight shifts ±2 px → height crosses threshold → remove →
      // text reflows back → height rises → re-activate → 60 fps oscillation.
      // The deadband breaks the cycle.
      const floatIsHere = floatMsgRef.current === targetMsg;
      const minHeight = floatIsHere ? FLOAT_HEIGHT_REMOVE : FLOAT_HEIGHT_INSERT;
      if (height < minHeight) {
        if (floatIsHere) floatChangedAtRef.current = now; // float removal → cooldown
        clearFloat(floatMsgRef, lastGeomRef);
        return;
      }

      const width = petRect.width + FLOAT_PAD_X;

      if (floatMsgRef.current !== targetMsg) {
        // Pet moved to a different (or first) message — rebuild float.
        clearFloat(floatMsgRef, lastGeomRef);
        applyFloat(targetMsg, floatDir, width, height, marginTop);
        floatMsgRef.current = targetMsg;
        lastGeomRef.current = { dir: floatDir, w: Math.round(width), h: Math.round(height), mt: Math.round(marginTop) };
        floatChangedAtRef.current = now;
      } else {
        // Same message — update geometry only when rounded values changed.
        // Skipping identical-value writes avoids spurious CSS mutations that
        // can dirty the paint even when nothing visually changes.
        const rW = Math.round(width);
        const rH = Math.round(height);
        const rM = Math.round(marginTop);
        const last = lastGeomRef.current;
        if (!last || last.dir !== floatDir || last.w !== rW || last.h !== rH || last.mt !== rM) {
          applyFloat(targetMsg, floatDir, width, height, marginTop);
          lastGeomRef.current = { dir: floatDir, w: rW, h: rH, mt: rM };
          floatChangedAtRef.current = now;
        }
      }
    }

    rafId = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      cancelAnimationFrame(rafId);
      scrollEl?.removeEventListener('scroll', onScroll);
      clearFloat(floatMsgRef, lastGeomRef);
    };
  }, [petTextReflow, isVisible, behindUi, petElRef]);
}

// ── Helpers ────────────────────────────────────────────────────────────────

function rectsIntersect(a: DOMRect, b: DOMRect): boolean {
  return (
    a.left < b.right &&
    a.right > b.left &&
    a.top < b.bottom &&
    a.bottom > b.top
  );
}

/** Set CSS custom properties on the .msg element to activate the ::before float. */
function applyFloat(
  el: HTMLElement,
  floatDir: 'right' | 'left',
  width: number,
  height: number,
  marginTop: number,
): void {
  el.style.setProperty('--pet-float-dir', floatDir);
  el.style.setProperty('--pet-float-w', `${width}px`);
  el.style.setProperty('--pet-float-h', `${height}px`);
  el.style.setProperty('--pet-float-mt', `${marginTop}px`);
  el.setAttribute('data-pet-float', '1');
}

/** Clear CSS float vars from .msg element and remove the activating attribute. */
function clearFloat(
  floatMsgRef: React.MutableRefObject<HTMLElement | null>,
  geomRef?: React.MutableRefObject<{ dir: string; w: number; h: number; mt: number } | null>,
): void {
  const el = floatMsgRef.current;
  if (el) {
    el.style.removeProperty('--pet-float-dir');
    el.style.removeProperty('--pet-float-w');
    el.style.removeProperty('--pet-float-h');
    el.style.removeProperty('--pet-float-mt');
    el.removeAttribute('data-pet-float');
  }
  floatMsgRef.current = null;
  if (geomRef) geomRef.current = null;
}
