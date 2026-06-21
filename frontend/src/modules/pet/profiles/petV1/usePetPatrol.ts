// usePetPatrol — patrol scheduler + vertical wander, extracted from FloatingPet.tsx.
//
// Owns the random-walk left/right patrol (three behaviours: cross-side, fidget,
// free-wander) and the vertical drift that occasionally lifts the pet toward
// the top of the viewport. Both schedulers run as self-rescheduling
// setTimeouts so they don't tear down and reset the clock on every render.
//
// All state lives in FloatingPet; the hook receives setters and refs as
// arguments so it can drive the pet's position without owning anything.

import { useEffect } from 'react';
import type { MutableRefObject } from 'react';
import type { PetMood } from '../../store/petStore.js';
import type { Point } from '../../petOverlayGeometry.js';
import { clampPos, maxPatrolDistance } from '../../petOverlayGeometry.js';
import {
  PET_W,
  MIN_PATROL_PX,
  JUMP_PEAK_PX,
  SIDE_ZONE_DEPTH,
} from '../../petOverlayConstants.js';
import {
  MIN_RUN_ANIM_PX,
  PATROL_DELAY_MIN_MS,
  PATROL_DELAY_RANGE_MS,
  JUMP_DISTANCE_THRESHOLD_PX,
  JUMP_LONG_DISTANCE_PX,
  JUMP_DURATION_MS,
  JUMP_INTER_HOP_GAP_MS,
  JUMP_DESTINATION_REST_MS,
  SIDE_CROSS_PROBABILITY,
  SIDE_FIDGET_PROBABILITY,
  VERTICAL_WANDER_MIN_MS,
  VERTICAL_WANDER_RANGE_MS,
  VERTICAL_WANDER_TOP_MARGIN_PX,
  VERTICAL_WANDER_EXPONENT,
} from './constants.js';

export interface UsePetPatrolArgs {
  isVisible: boolean;
  dragging: boolean;
  mood: PetMood;
  // Refs — stable, don't cause re-renders on read.
  activityRateRef: MutableRefObject<number>;
  playgroundModeRef: MutableRefObject<boolean>;
  posRef: MutableRefObject<Point>;
  facingScaleRef: MutableRefObject<number>;
  settledSideRef: MutableRefObject<'left' | 'right'>;
  dragRefBool: MutableRefObject<boolean>;
  moodRef: MutableRefObject<PetMood>;
  flipWrapRef: MutableRefObject<HTMLDivElement | null>;
  // Setters from FloatingPet's useState.
  setPatrolX: (x: number) => void;
  setPatrolY: (y: number) => void;
  setLocomotionMood: (m: PetMood | null) => void;
  setPos: (updater: (prev: Point) => Point) => void;
  // Callback that atomically commits a new settled-side to React state,
  // the settledSideRef, the module-level gSettledSide, and localStorage.
  commitSettledSide: (newSide: 'left' | 'right') => void;
  // Module-level sideZoneCenter — reads gSettledSide from FloatingPet's scope.
  sideZoneCenter: (side: 'left' | 'right') => number | null;
  // homePos — used by vertical wander to compute maxLift.
  homePos: () => Point;
}

/**
 * Drives the pet's autonomous horizontal patrol and vertical wander.
 *
 * Patrol (horizontal):
 *   Three random behaviours selected each cycle:
 *   • CROSS  (30 %): jump to the opposite side zone and settle there.
 *   • FIDGET (40 %): small wiggle within the current zone (≤ SIDE_ZONE_DEPTH px).
 *   • WANDER (30 %): full-range random walk; hops back home after a rest beat.
 *
 *   Long distances (≥ JUMP_LONG_DISTANCE_PX) play as a 3-part theatrical jump;
 *   medium distances (≥ JUMP_DISTANCE_THRESHOLD_PX) use a 2-hop zigzag;
 *   short distances use a CSS slide with the running-sprite animation.
 *
 * Vertical wander:
 *   Every 40–120 s (scaled by activityRate) the pet drifts upward by a random
 *   amount, biased toward the home position. Cleared on drag and layout changes.
 */
export function usePetPatrol({
  isVisible,
  dragging,
  mood,
  activityRateRef,
  playgroundModeRef,
  posRef,
  facingScaleRef,
  settledSideRef,
  dragRefBool,
  moodRef,
  flipWrapRef,
  setPatrolX,
  setPatrolY,
  setLocomotionMood,
  setPos,
  commitSettledSide,
  sideZoneCenter,
  homePos,
}: UsePetPatrolArgs): void {

  // ── Random patrol left/right ───────────────────────────────────────────
  useEffect(() => {
    if (!isVisible) return;
    let cancelled = false;
    const timers = new Set<number>();
    const addT = (id: number): number => { timers.add(id); return id; };

    const fireHop = (durationMs: number): void => {
      const wrap = flipWrapRef.current;
      if (!wrap || typeof wrap.animate !== 'function') return;
      const fs = facingScaleRef.current;
      const peak = JUMP_PEAK_PX;
      wrap.animate(
        [
          { transform: `scaleX(${fs}) translateY(0px)`,                offset: 0 },
          { transform: `scaleX(${fs}) translateY(-${peak * 0.55}px)`,  offset: 0.18 },
          { transform: `scaleX(${fs}) translateY(-${peak}px)`,         offset: 0.45 },
          { transform: `scaleX(${fs}) translateY(-${peak * 0.55}px)`,  offset: 0.72 },
          { transform: `scaleX(${fs}) translateY(0px)`,                offset: 1 },
        ],
        { duration: durationMs, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'none' },
      );
    };

    const schedule = (): void => {
      if (cancelled) return;
      const rate = activityRateRef.current;
      const baseDelay = PATROL_DELAY_MIN_MS + Math.random() * PATROL_DELAY_RANGE_MS;
      const delay = rate <= 0.05 ? 4000 : baseDelay / rate;
      addT(window.setTimeout(() => {
        if (cancelled) return;
        if (
          dragging
          || playgroundModeRef.current
          || mood === 'powermove'
          || mood === 'fighting'
          || document.visibilityState !== 'visible'
          || activityRateRef.current <= 0.05
        ) {
          schedule();
          return;
        }

        const fireHopWithSprite = (durationMs: number): void => {
          fireHop(durationMs);
          setLocomotionMood('jumping');
          addT(window.setTimeout(() => {
            if (cancelled) return;
            setLocomotionMood(null);
          }, durationMs));
        };

        const doWalk = (walk: number, settle: boolean, newSide?: 'left' | 'right'): void => {
          if (Math.abs(walk) >= JUMP_LONG_DISTANCE_PX) {
            // ── Three-part theatrical jump (long cross-side patrol) ────
            const third = walk / 3;
            const zigzagSign = Math.random() < 0.5 ? -1 : 1;
            const zigzag = zigzagSign * (8 + Math.random() * 14);
            fireHopWithSprite(JUMP_DURATION_MS);
            setPatrolX(third + zigzag);
            addT(window.setTimeout(() => {
              if (cancelled) return;
              fireHopWithSprite(JUMP_DURATION_MS);
              setPatrolX(walk * 0.65 - zigzag * 0.6);
              addT(window.setTimeout(() => {
                if (cancelled) return;
                fireHopWithSprite(JUMP_DURATION_MS);
                setPatrolX(walk);
                addT(window.setTimeout(() => {
                  if (cancelled) return;
                  addT(window.setTimeout(() => {
                    if (cancelled) return;
                    if (settle && newSide != null) {
                      setPos((prev) => clampPos({ x: prev.x + walk, y: prev.y }));
                      commitSettledSide(newSide);
                      setPatrolX(0);
                      schedule();
                    } else {
                      fireHopWithSprite(JUMP_DURATION_MS);
                      setPatrolX(0);
                      addT(window.setTimeout(() => {
                        if (cancelled) return;
                        schedule();
                      }, JUMP_DURATION_MS));
                    }
                  }, JUMP_DESTINATION_REST_MS));
                }, JUMP_DURATION_MS));
              }, JUMP_DURATION_MS + JUMP_INTER_HOP_GAP_MS));
            }, JUMP_DURATION_MS + JUMP_INTER_HOP_GAP_MS));

          } else if (Math.abs(walk) >= JUMP_DISTANCE_THRESHOLD_PX) {
            // ── Two-part zigzag jump (medium distance) ────────────────
            const zigzagSign = Math.random() < 0.5 ? -1 : 1;
            const zigzagAmount = zigzagSign * (12 + Math.random() * 18);
            const halfX = walk * 0.5 + zigzagAmount;
            fireHopWithSprite(JUMP_DURATION_MS);
            setPatrolX(halfX);
            addT(window.setTimeout(() => {
              if (cancelled) return;
              fireHopWithSprite(JUMP_DURATION_MS);
              setPatrolX(walk);
              addT(window.setTimeout(() => {
                if (cancelled) return;
                addT(window.setTimeout(() => {
                  if (cancelled) return;
                  if (settle && newSide != null) {
                    setPos((prev) => clampPos({ x: prev.x + walk, y: prev.y }));
                    commitSettledSide(newSide);
                    setPatrolX(0);
                    schedule();
                  } else {
                    fireHopWithSprite(JUMP_DURATION_MS);
                    setPatrolX(0);
                    addT(window.setTimeout(() => {
                      if (cancelled) return;
                      schedule();
                    }, JUMP_DURATION_MS));
                  }
                }, JUMP_DESTINATION_REST_MS));
              }, JUMP_DURATION_MS));
            }, JUMP_DURATION_MS + JUMP_INTER_HOP_GAP_MS));

          } else {
            // ── Short CSS slide + running sprite ──────────────────────
            // Single locomotion mood for both directions — left motion uses
            // the per-pet flipRun toggle + CSS scaleX(-1) to mirror the
            // right-facing 'running' frames.
            if (Math.abs(walk) >= MIN_RUN_ANIM_PX) {
              setLocomotionMood('running');
            }
            setPatrolX(walk);
            const dur = Math.min(6500, Math.max(2200, Math.abs(walk) * 9 + 800));
            addT(window.setTimeout(() => {
              if (cancelled) return;
              setLocomotionMood(null);
            }, dur));
            addT(window.setTimeout(() => {
              if (cancelled) return;
              if (settle && newSide != null) {
                setPos((prev) => clampPos({ x: prev.x + walk, y: prev.y }));
                commitSettledSide(newSide);
              }
              setPatrolX(0);
              schedule();
            }, dur));
          }
        };

        const roll = Math.random();

        if (roll < SIDE_CROSS_PROBABILITY) {
          // ── Cross to the opposite side zone and settle ──────────────
          const fromSide = settledSideRef.current;
          const toSide: 'left' | 'right' = fromSide === 'left' ? 'right' : 'left';
          const toCenter = sideZoneCenter(toSide);
          if (toCenter == null) { schedule(); return; }
          const jitter = (Math.random() - 0.5) * SIDE_ZONE_DEPTH;
          const toX = Math.max(8, Math.min(window.innerWidth - PET_W - 8, toCenter + jitter));
          const walk = toX - posRef.current.x;
          if (Math.abs(walk) < MIN_PATROL_PX) { schedule(); return; }
          doWalk(walk, true, toSide);

        } else if (roll < SIDE_CROSS_PROBABILITY + SIDE_FIDGET_PROBABILITY) {
          // ── Small fidget within the current side zone ───────────────
          const fidget = (Math.random() - 0.5) * SIDE_ZONE_DEPTH * 0.8;
          if (Math.abs(fidget) < 4) { schedule(); return; }
          doWalk(fidget, false);

        } else {
          // ── Free wander through the full range (covers centre) ─────
          const max = maxPatrolDistance();
          const span = MIN_PATROL_PX + Math.random() * Math.max(0, max - MIN_PATROL_PX);
          const walk = Math.random() < 0.5 ? -span : span;
          doWalk(walk, false);
        }
      }, delay));
    };
    schedule();
    return () => {
      cancelled = true;
      for (const t of timers) window.clearTimeout(t);
    };
  }, [dragging, isVisible, mood]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Vertical wander: pet drifts up/down while settled on a side strip ───
  // Fires every 40–120 s (scaled by activityRate). Picks a vertical lift
  // with exponential bias toward 0 (home/bottom) so higher positions are
  // rarer. patrolY is a negative offset on top of pos.y — the existing
  // 900 ms CSS transition on .pet-overlay animates the drift smoothly.
  // Reset to 0 happens on drag-return-home and on layout changes so the
  // pet eventually comes back to the chat-input surface.
  useEffect(() => {
    if (!isVisible) return;
    let cancelled = false;
    const timers = new Set<number>();
    const addT = (id: number): number => { timers.add(id); return id; };

    const scheduleNext = (): void => {
      if (cancelled) return;
      const rate = activityRateRef.current;
      const baseDelay = VERTICAL_WANDER_MIN_MS + Math.random() * VERTICAL_WANDER_RANGE_MS;
      const delay = rate <= 0.05 ? 4000 : baseDelay / rate;
      addT(window.setTimeout(() => {
        if (cancelled) return;
        if (
          dragRefBool.current
          || playgroundModeRef.current
          || moodRef.current === 'powermove'
          || moodRef.current === 'fighting'
          || document.visibilityState !== 'visible'
          || activityRateRef.current <= 0.05
        ) {
          scheduleNext();
          return;
        }
        const homeY = homePos().y;
        const maxLift = Math.max(0, homeY - VERTICAL_WANDER_TOP_MARGIN_PX);
        if (maxLift < 50) { scheduleNext(); return; }
        const lift = Math.floor(Math.pow(Math.random(), VERTICAL_WANDER_EXPONENT) * maxLift);
        setPatrolY(-lift); // negative = up toward screen top
        scheduleNext();
      }, delay));
    };

    scheduleNext();
    return () => {
      cancelled = true;
      for (const t of timers) window.clearTimeout(t);
      setPatrolY(0);
    };
  }, [isVisible]); // eslint-disable-line react-hooks/exhaustive-deps
}
