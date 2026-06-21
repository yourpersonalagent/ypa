// usePetV3Scheduler — petV3's behaviour FSM.
//
// V3 is a fresh start: it does NOT call any petV1 hook. The autonomous
// repertoire is intentionally small for cut 1 so the new code can grow
// without dragging in V1 baggage:
//
//   • Wander  — every ~25-50 s (scaled by activityRate), with 55%
//               probability the pet picks either a horizontal target
//               within WANDER_DISTANCE_MIN/MAX or (rarer) a small
//               upward drift, slides there, dwells, then slides home.
//               The slide's sprite is chosen by slideTo from the
//               direction — running for horizontal, jumping for pure
//               vertical (when the pet has those frames).
//   • Perch   — when an <input>/<textarea>/[contenteditable] receives
//               focus for PERCH_FOCUS_DWELL_MS and is far enough from
//               the pet, V3 walks the pet just above-and-to-the-side of
//               the input. Returns home on blur or after
//               PERCH_MAX_DURATION_MS.
//
// V3 deliberately omits V1's peek-away, button-hop, look-around, fight
// anchor, and theatrical 3-hop jumps. Each state owns its own setTimeout
// chain and clears it on unmount / mood change / drag — no shared
// "patrol clock" across states. Behaviours never run during action moods
// (powermove/fighting/jumping/xpeffect/error) or while dragging /
// playground / hidden.
//
// Locomotion mood (picked by slideTo from the requested dx/dy + the
// active pet's pose capabilities):
//   • Horizontal travel (|dx| > LOCOMOTION_HORIZONTAL_MIN_PX) → 'running'
//     if the pet has it. Left direction handled by the per-pet flipRun
//     toggle + CSS scaleX(-1) on the canonical right-facing frames.
//   • Pure vertical travel (no significant dx, |dy| >
//     LOCOMOTION_VERTICAL_MIN_PX) → 'jumping' if the pet has it. Falls
//     through to no sprite swap when the pet only has 'running' (the
//     run cycle would read as run-in-place while the sprite drifts up).
//   • Anything smaller → no mood override; the slide happens silently.

import { useCallback, useEffect, useRef } from 'react';
import { usePetStore } from '../../store/petStore.js';
import type { PetMood } from '../../store/petStore.js';
import { clampPos, maxPatrolDistance } from '../../petOverlayGeometry.js';
import { PET_W } from '../../petOverlayConstants.js';
import type { UsePetSchedulerArgs } from '../types.js';
import {
  SLIDE_DURATION_MS,
  LOCOMOTION_TAIL_MS,
  LOCOMOTION_HORIZONTAL_MIN_PX,
  LOCOMOTION_VERTICAL_MIN_PX,
  WANDER_INTERVAL_MIN_MS,
  WANDER_INTERVAL_RANGE_MS,
  WANDER_PROBABILITY,
  WANDER_DISTANCE_MIN_PX,
  WANDER_DISTANCE_MAX_PX,
  WANDER_DWELL_MIN_MS,
  WANDER_DWELL_RANGE_MS,
  WANDER_VERTICAL_PROBABILITY,
  WANDER_VERTICAL_MIN_PX,
  WANDER_VERTICAL_MAX_PX,
  PERCH_MIN_DISTANCE_PX,
  PERCH_FOCUS_DWELL_MS,
  PERCH_X_OFFSET_PX,
  PERCH_Y_ABOVE_PX,
  PERCH_MAX_DURATION_MS,
} from './constants.js';
import { detectCapabilities } from './capabilities.js';

/** Total time the running sprite is held up for a slide — CSS transition
 *  duration plus a tail so the walk-cycle plays through cleanly instead
 *  of snapping to idle at the very moment the transform settles. */
const SLIDE_LOCOMOTION_MS = SLIDE_DURATION_MS + LOCOMOTION_TAIL_MS;

/** A mood is "passive" when V3 is allowed to drive autonomous motion.
 *  Action moods drive their own poses; V3 sits still during them so it
 *  doesn't interrupt a swing / jump / xp burst. */
function isPassiveMood(m: string): boolean {
  return m === 'idle'
      || m === 'thinking'
      || m === 'streaming'
      || m === 'reconnecting'
      || m === 'happy';
}

export function usePetV3Scheduler(args: UsePetSchedulerArgs): void {
  const {
    isVisible,
    dragging,
    mood,
    moodRef,
    dragRefBool,
    playgroundModeRef,
    activityRateRef,
    posRef,
    setPatrolX,
    setPatrolY,
    setLocomotionMood,
    setWalkFacing,
  } = args;

  // Live capability snapshot — recomputed whenever the active manifest
  // changes. Stored in a ref so the long-lived schedulers below see the
  // current value without re-tearing down their timers.
  const manifest = usePetStore((s) => s.currentPet?.manifest);
  const capsRef = useRef(detectCapabilities(manifest));
  useEffect(() => {
    capsRef.current = detectCapabilities(manifest);
  }, [manifest]);

  // V3's own bookkeeping of where it last commanded patrolX/Y to be —
  // FloatingPet doesn't surface a live patrol-offset ref, so V3 tracks
  // its own commands. Resets to (0, 0) when the pet returns home.
  const lastPatrolXRef = useRef(0);
  const lastPatrolYRef = useRef(0);

  // ── Slide primitive ────────────────────────────────────────────────────
  // The ONLY way V3 changes patrolX / patrolY. Picks the locomotion mood
  // by decomposing the requested move:
  //   • |dx| > LOCOMOTION_HORIZONTAL_MIN_PX → 'running' (if the pet has
  //     the pose) plus walkFacing = left/right. The run cycle never plays
  //     while the pet is stationary or floating purely vertical — it
  //     only ever shows when the sprite is actually traveling sideways.
  //   • no significant dx, but |dy| > LOCOMOTION_VERTICAL_MIN_PX →
  //     'jumping' (if the pet has the pose). A pure vertical drift reads
  //     as a hop, not a run-in-place. Falls through to null when the pet
  //     lacks `jumping` frames — the CSS slide still happens, just
  //     without a sprite swap, which is preferable to the wrong sprite.
  //   • otherwise → null (in-place adjustment too small to animate).
  // Sets the patrol offsets last. Returns the duration after which the
  // caller can safely schedule a next slide / clear / dwell. Locomotion
  // + facing are NOT auto-cleared — that's the caller's responsibility
  // so chained slides can stay uninterrupted (call slideTo again before
  // the timer fires).
  const slideTo = useCallback((
    targetX: number,
    targetY: number,
  ): number => {
    const dx = targetX - lastPatrolXRef.current;
    const dy = targetY - lastPatrolYRef.current;
    const absDx = Math.abs(dx);
    const absDy = Math.abs(dy);
    const horizontalMotion = absDx > LOCOMOTION_HORIZONTAL_MIN_PX;
    const verticalMotion = absDy > LOCOMOTION_VERTICAL_MIN_PX;
    const caps = capsRef.current;

    let nextLocomotion: PetMood | null = null;
    if (horizontalMotion && caps.hasRunning) {
      nextLocomotion = 'running';
    } else if (!horizontalMotion && verticalMotion && caps.hasJumping) {
      nextLocomotion = 'jumping';
    }

    // setLocomotionMood + setWalkFacing FIRST so the React batch lands
    // both the sprite swap and the transform change on the same render —
    // CSS transition kicks in with the chosen pose already in place.
    setLocomotionMood(nextLocomotion);
    if (horizontalMotion) {
      setWalkFacing(dx < 0 ? 'left' : 'right');
    }
    // No facing change for pure-vertical slides — flipping the sprite
    // mid-hop would look wrong.
    setPatrolX(targetX);
    setPatrolY(targetY);
    lastPatrolXRef.current = targetX;
    lastPatrolYRef.current = targetY;

    return SLIDE_LOCOMOTION_MS;
  }, [setLocomotionMood, setPatrolX, setPatrolY, setWalkFacing]);

  /** Drop locomotion mood + walkFacing back to defaults — the pet is
   *  standing still again. Idempotent. */
  const clearLocomotion = useCallback((): void => {
    setLocomotionMood(null);
    setWalkFacing(null);
  }, [setLocomotionMood, setWalkFacing]);

  // ── Wander ─────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isVisible) return;
    let cancelled = false;
    const timers = new Set<number>();
    const addT = (id: number): number => { timers.add(id); return id; };

    const fireWander = (): void => {
      if (cancelled) return;

      // Each wander roll picks horizontal OR vertical motion (vertical
      // is the rarer of the two — it reads stronger across the chat
      // baseline so we don't want it dominating the cadence).
      const isVertical = Math.random() < WANDER_VERTICAL_PROBABILITY;

      let targetX = 0;
      let targetY = 0;

      if (isVertical) {
        // Vertical wander: lift upward by a random amount. Always
        // negative (up) — the pet has a chat-input baseline it should
        // return to, not float down into the bottom-right.
        const lift = WANDER_VERTICAL_MIN_PX + Math.random() * (WANDER_VERTICAL_MAX_PX - WANDER_VERTICAL_MIN_PX);
        targetY = -lift;
      } else {
        // Horizontal wander: pick a random target X within the patrol
        // corridor relative to the pet's current home (pos).
        const corridor = maxPatrolDistance();
        const span = WANDER_DISTANCE_MIN_PX + Math.random() * (WANDER_DISTANCE_MAX_PX - WANDER_DISTANCE_MIN_PX);
        const sign = Math.random() < 0.5 ? -1 : 1;
        const halfCorridor = corridor / 2;
        targetX = Math.max(-halfCorridor, Math.min(halfCorridor, sign * span));
      }

      // ── Outbound slide ─────────────────────────────────────────────
      const outboundMs = slideTo(targetX, targetY);
      const dwellMs = WANDER_DWELL_MIN_MS + Math.random() * WANDER_DWELL_RANGE_MS;

      addT(window.setTimeout(() => {
        if (cancelled) return;
        // Arrived: drop locomotion so the dwell reads as "stopped and
        // looking around" instead of running-in-place.
        clearLocomotion();
        addT(window.setTimeout(() => {
          if (cancelled) return;
          // Skip the return if mood escalated or pet got dragged during
          // dwell — let FloatingPet's return-home logic take over.
          if (
            dragRefBool.current
            || !isPassiveMood(moodRef.current)
            || playgroundModeRef.current
          ) {
            schedule();
            return;
          }
          // ── Return slide ─────────────────────────────────────────
          const returnMs = slideTo(0, 0);
          addT(window.setTimeout(() => {
            if (cancelled) return;
            clearLocomotion();
            schedule();
          }, returnMs));
        }, dwellMs));
      }, outboundMs));
    };

    const schedule = (): void => {
      if (cancelled) return;
      const rate = activityRateRef.current;
      const base = WANDER_INTERVAL_MIN_MS + Math.random() * WANDER_INTERVAL_RANGE_MS;
      const delay = rate <= 0.05 ? 60_000 : base / Math.max(0.2, rate);
      addT(window.setTimeout(() => {
        if (cancelled) return;
        if (
          dragRefBool.current
          || playgroundModeRef.current
          || !isPassiveMood(moodRef.current)
          || document.visibilityState !== 'visible'
          || activityRateRef.current <= 0.05
        ) {
          schedule();
          return;
        }
        if (!capsRef.current.hasRunning) {
          // No locomotion sprite — V3 won't move at all on this pet.
          schedule();
          return;
        }
        if (Math.random() >= WANDER_PROBABILITY) {
          schedule();
          return;
        }
        fireWander();
      }, delay));
    };

    schedule();

    return () => {
      cancelled = true;
      for (const id of timers) window.clearTimeout(id);
      timers.clear();
    };
    // The patrol scheduler should not re-arm on every mood/drag tick —
    // it reads live values through refs. Restart only when visibility
    // toggles (the outer useEffect dep) or on profile remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible]);

  // ── Perch (focused input follower) ─────────────────────────────────────
  useEffect(() => {
    if (!isVisible) return;
    let cancelled = false;
    let perchTarget: HTMLElement | null = null;
    const timers = new Set<number>();
    const addT = (id: number): number => { timers.add(id); return id; };
    let dwellTimer: number | null = null;
    let maxDurationTimer: number | null = null;

    const isFocusableTarget = (el: EventTarget | null): el is HTMLElement => {
      if (!(el instanceof HTMLElement)) return false;
      if (el.closest('.pet-overlay')) return false; // never perch on the pet itself
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return true;
      if (el.isContentEditable) return true;
      return false;
    };

    const slideHome = (): void => {
      perchTarget = null;
      if (maxDurationTimer) { window.clearTimeout(maxDurationTimer); maxDurationTimer = null; }
      const ms = slideTo(0, 0);
      addT(window.setTimeout(() => {
        if (cancelled) return;
        clearLocomotion();
      }, ms));
    };

    const slideToPerch = (el: HTMLElement): void => {
      const rect = el.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 10) return;

      const petScreenX = posRef.current.x + lastPatrolXRef.current;
      // Pick the side closer to the pet's current position so it doesn't
      // cross the input unnecessarily.
      const inputCenterX = rect.left + rect.width / 2;
      const onLeft = petScreenX < inputCenterX;
      const feetX = onLeft
        ? rect.left - PET_W - PERCH_X_OFFSET_PX
        : rect.right + PERCH_X_OFFSET_PX;
      const feetY = rect.top - PERCH_Y_ABOVE_PX;

      const clamped = clampPos({ x: feetX, y: feetY });
      const dx = clamped.x - posRef.current.x;
      const dy = clamped.y - posRef.current.y;

      if (Math.abs(dx - lastPatrolXRef.current) < PERCH_MIN_DISTANCE_PX) {
        // Too close to bother — but still arm the max-duration timer so
        // we don't leave a stale perchTarget set forever.
        perchTarget = el;
        if (maxDurationTimer) window.clearTimeout(maxDurationTimer);
        maxDurationTimer = window.setTimeout(() => {
          if (cancelled || perchTarget !== el) return;
          slideHome();
        }, PERCH_MAX_DURATION_MS);
        return;
      }

      perchTarget = el;
      const ms = slideTo(dx, dy);
      addT(window.setTimeout(() => {
        if (cancelled || perchTarget !== el) return;
        clearLocomotion();
      }, ms));

      if (maxDurationTimer) window.clearTimeout(maxDurationTimer);
      maxDurationTimer = window.setTimeout(() => {
        if (cancelled || perchTarget !== el) return;
        slideHome();
      }, PERCH_MAX_DURATION_MS);
    };

    const onFocusIn = (ev: FocusEvent): void => {
      const el = ev.target;
      if (!isFocusableTarget(el)) return;
      if (
        dragRefBool.current
        || playgroundModeRef.current
        || !isPassiveMood(moodRef.current)
        || !capsRef.current.hasRunning
      ) return;

      // Debounce — only commit after the input has held focus continuously
      // for PERCH_FOCUS_DWELL_MS, to ignore transient tab-throughs.
      if (dwellTimer) window.clearTimeout(dwellTimer);
      const captured = el;
      dwellTimer = window.setTimeout(() => {
        dwellTimer = null;
        if (cancelled) return;
        // Re-verify focus is still on the same element after the dwell.
        if (document.activeElement !== captured) return;
        if (
          dragRefBool.current
          || playgroundModeRef.current
          || !isPassiveMood(moodRef.current)
        ) return;
        slideToPerch(captured);
      }, PERCH_FOCUS_DWELL_MS);
    };

    const onFocusOut = (ev: FocusEvent): void => {
      const el = ev.target instanceof HTMLElement ? ev.target : null;
      if (!el || el !== perchTarget) return;
      if (dwellTimer) { window.clearTimeout(dwellTimer); dwellTimer = null; }
      // Brief delay so a click that moves focus to an adjacent input
      // (e.g. submit button) doesn't immediately send the pet home and
      // back again. If focus lands on another input, the new focusin
      // handler picks it up.
      addT(window.setTimeout(() => {
        if (cancelled || perchTarget !== el) return;
        slideHome();
      }, 250));
    };

    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    return () => {
      cancelled = true;
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
      if (dwellTimer) window.clearTimeout(dwellTimer);
      if (maxDurationTimer) window.clearTimeout(maxDurationTimer);
      for (const id of timers) window.clearTimeout(id);
      timers.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVisible]);

  // ── Mood escalation cancel ─────────────────────────────────────────────
  // When an action mood kicks in mid-wander/perch, snap the pet home so
  // the action plays from a known position. The schedulers above check
  // moodRef inside their timeouts, but mood transitions need an explicit
  // "abort current motion" path too.
  useEffect(() => {
    if (isPassiveMood(mood)) return;
    if (lastPatrolXRef.current === 0 && lastPatrolYRef.current === 0) return;
    setPatrolX(0);
    setPatrolY(0);
    lastPatrolXRef.current = 0;
    lastPatrolYRef.current = 0;
    clearLocomotion();
  }, [mood, setPatrolX, setPatrolY, clearLocomotion]);

  // Drag cancel — same idea, but for the user grabbing the pet.
  useEffect(() => {
    if (!dragging) return;
    if (lastPatrolXRef.current === 0 && lastPatrolYRef.current === 0) return;
    setPatrolX(0);
    setPatrolY(0);
    lastPatrolXRef.current = 0;
    lastPatrolYRef.current = 0;
    clearLocomotion();
  }, [dragging, setPatrolX, setPatrolY, clearLocomotion]);
}
