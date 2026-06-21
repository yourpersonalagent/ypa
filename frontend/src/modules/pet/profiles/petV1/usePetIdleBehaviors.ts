// usePetIdleBehaviors — idle spontaneous behaviors extracted from FloatingPet.tsx.
//
// Groups all the "while nothing important is happening" effects:
//   • Peek-away  — pet shrinks + drops behind UI occasionally
//   • Look-around — rare, brief facing flip to the opposite direction
//   • Fight anchor — picks the pet's fight position when mood = fighting/powermove
//   • Walk-facing tracker — faces the pet in its direction of travel
//   • Button-hop scheduler — pet jumps onto a random visible button
//   • Press-bounce — WAAPI keyframe per pressBeat increment
//   • Cancel effects — clears button-hop on mood escalation; locomotion on fight

import { useEffect } from 'react';
import type { MutableRefObject } from 'react';
import type { PetMood, PetFacing } from '../../store/petStore.js';
import type { Point } from '../../petOverlayGeometry.js';
import { maxPatrolDistance } from '../../petOverlayGeometry.js';
import { pickButtonHopTarget } from './buttonHopTarget.js';
import { PET_W } from '../../petOverlayConstants.js';
import {
  LOOK_AROUND_INTERVAL_MS,
  LOOK_AROUND_PROBABILITY,
  LOOK_AROUND_DURATION_MIN_MS,
  LOOK_AROUND_DURATION_RANGE_MS,
  FIGHT_SIDE_NEAR_FRAC,
  FIGHT_SIDE_FAR_FRAC,
  PEEK_AWAY_INTERVAL_MS,
  PEEK_AWAY_PROBABILITY,
  PEEK_AWAY_DURATION_MIN_MS,
  PEEK_AWAY_DURATION_RANGE_MS,
  BUTTON_HOP_INTERVAL_MS,
  BUTTON_HOP_PROBABILITY,
  BUTTON_PRESS_DURATION_MS,
  BUTTON_HOP_HOLD_MS,
  BUTTON_HOP_SLIDE_MS,
  WALK_FACING_HOLD_MS,
  WALK_FACING_MIN_DELTA_PX,
} from './constants.js';

export interface FightAnchor {
  x: number;
  facing: PetFacing;
}

export interface ButtonHopTarget {
  dx: number;
  dy: number;
  pressCount: number;
}

export interface UsePetIdleBehaviorsArgs {
  // State values
  isVisible: boolean;
  mood: PetMood;
  dragging: boolean;
  isPeekingAway: boolean;
  fightAnchor: FightAnchor | null;
  lookAroundFacing: PetFacing | null;
  walkFacing: PetFacing | null;
  buttonHopTarget: ButtonHopTarget | null;
  pressBeat: number;
  baseFacing: PetFacing;
  fightVariantSeed: number;
  locomotionMood: PetMood | null;
  patrolX: number;
  posX: number; // pos.x only (avoids dep on full pos object)
  // Refs
  activityRateRef: MutableRefObject<number>;
  playgroundModeRef: MutableRefObject<boolean>;
  moodRef: MutableRefObject<PetMood>;
  dragRefBool: MutableRefObject<boolean>;
  peekRef: MutableRefObject<boolean>;
  buttonHopTargetRef: MutableRefObject<ButtonHopTarget | null>;
  posRef: MutableRefObject<Point>;
  settledSideRef: MutableRefObject<'left' | 'right'>;
  lastEffectiveXRef: MutableRefObject<number>;
  walkFacingTimer: MutableRefObject<number | null>;
  flipWrapRef: MutableRefObject<HTMLDivElement | null>;
  // Setters
  setIsPeekingAway: (v: boolean) => void;
  setLookAroundFacing: (f: PetFacing | null) => void;
  setFightAnchor: (a: FightAnchor | null) => void;
  setWalkFacing: (f: PetFacing | null) => void;
  setButtonHopTarget: (t: ButtonHopTarget | null) => void;
  setPressBeat: (updater: (prev: number) => number) => void;
  setLocomotionMood: (m: PetMood | null) => void;
  // Module-level sideZoneCenter — reads gSettledSide from FloatingPet.
  sideZoneCenter: (side: 'left' | 'right') => number | null;
}

/**
 * All idle spontaneous-behavior effects for the floating pet.
 *
 * Designed as a batch of `useEffect` calls that share the same argument
 * object. State ownership stays in FloatingPet; this hook only drives it.
 */
export function usePetIdleBehaviors({
  isVisible,
  mood,
  dragging,
  isPeekingAway,
  fightAnchor,
  lookAroundFacing,
  walkFacing,
  buttonHopTarget,
  pressBeat,
  baseFacing,
  fightVariantSeed,
  locomotionMood,
  patrolX,
  posX,
  activityRateRef,
  playgroundModeRef,
  moodRef,
  dragRefBool,
  peekRef,
  buttonHopTargetRef,
  posRef,
  settledSideRef,
  lastEffectiveXRef,
  walkFacingTimer,
  flipWrapRef,
  setIsPeekingAway,
  setLookAroundFacing,
  setFightAnchor,
  setWalkFacing,
  setButtonHopTarget,
  setPressBeat,
  setLocomotionMood,
  sideZoneCenter,
}: UsePetIdleBehaviorsArgs): void {

  // ── Peek-away: pet sometimes "wanders behind" UI elements ───────────────
  useEffect(() => {
    if (!isVisible) return;
    let cancelled = false;
    let endTimer: number | null = null;
    const tick = window.setInterval(() => {
      if (cancelled) return;
      if (mood !== 'idle' && mood !== 'thinking') return;
      if (dragging) return;
      if (document.visibilityState !== 'visible') return;
      const rate = activityRateRef.current;
      if (rate <= 0) return;
      if (Math.random() >= Math.min(1, PEEK_AWAY_PROBABILITY * rate)) return;
      setIsPeekingAway(true);
      endTimer = window.setTimeout(
        () => setIsPeekingAway(false),
        PEEK_AWAY_DURATION_MIN_MS + Math.random() * PEEK_AWAY_DURATION_RANGE_MS,
      );
    }, PEEK_AWAY_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(tick);
      if (endTimer != null) window.clearTimeout(endTimer);
    };
  }, [dragging, isVisible, mood]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cancel a peek immediately if mood escalates.
  useEffect(() => {
    if (mood !== 'idle' && mood !== 'thinking' && isPeekingAway) {
      setIsPeekingAway(false);
    }
  }, [mood, isPeekingAway]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Idle look-around: rare, brief facing flip ───────────────────────────
  useEffect(() => {
    if (!isVisible) return;
    let cancelled = false;
    let revertTimer: number | null = null;
    const tick = window.setInterval(() => {
      if (cancelled) return;
      if (mood !== 'idle' && mood !== 'thinking') return;
      if (document.visibilityState !== 'visible') return;
      const rate = activityRateRef.current;
      if (rate <= 0) return;
      if (Math.random() >= Math.min(1, LOOK_AROUND_PROBABILITY * rate)) return;
      const flipped: PetFacing = baseFacing === 'right' ? 'left' : 'right';
      setLookAroundFacing(flipped);
      revertTimer = window.setTimeout(() => {
        setLookAroundFacing(null);
      }, LOOK_AROUND_DURATION_MIN_MS + Math.random() * LOOK_AROUND_DURATION_RANGE_MS);
    }, LOOK_AROUND_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(tick);
      if (revertTimer != null) window.clearTimeout(revertTimer);
    };
  }, [baseFacing, isVisible, mood]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Tool-call (fight/powermove) side variation ──────────────────────────
  // Fight plays from the current settled side zone, facing inward toward the
  // message centre. A small random jitter within the zone (±15 px) gives
  // variety across successive tool-calls without jarring position jumps.
  useEffect(() => {
    if (mood !== 'fighting' && mood !== 'powermove') {
      setFightAnchor(null);
      return;
    }
    const side = settledSideRef.current;
    const cx = sideZoneCenter(side);
    if (cx != null) {
      const jitter = (Math.random() - 0.5) * 30;
      const targetX = Math.max(8, Math.min(window.innerWidth - PET_W - 8, cx + jitter));
      setFightAnchor({
        x: targetX - posRef.current.x,
        facing: side === 'left' ? 'right' : 'left',
      });
    } else {
      const max = maxPatrolDistance();
      const distance = max * (FIGHT_SIDE_NEAR_FRAC + Math.random() * (FIGHT_SIDE_FAR_FRAC - FIGHT_SIDE_NEAR_FRAC));
      const goRight = Math.random() < 0.5;
      setFightAnchor({
        x: goRight ? distance : -distance,
        facing: goRight ? 'left' : 'right',
      });
    }
  }, [mood, fightVariantSeed]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Walk-facing tracker ─────────────────────────────────────────────────
  // Whenever the effective on-screen X changes meaningfully (patrol step,
  // fight slide, return-home, button-hop slide), set walkFacing in the
  // direction of motion and clear it after the transition settles.
  useEffect(() => {
    const offsetX = fightAnchor ? fightAnchor.x : (buttonHopTarget?.dx ?? patrolX);
    const currentEffectiveX = posX + offsetX;
    if (dragging || playgroundModeRef.current) {
      lastEffectiveXRef.current = currentEffectiveX;
      return;
    }
    const delta = currentEffectiveX - lastEffectiveXRef.current;
    if (Math.abs(delta) < WALK_FACING_MIN_DELTA_PX) return;
    setWalkFacing(delta > 0 ? 'right' : 'left');
    lastEffectiveXRef.current = currentEffectiveX;
    if (walkFacingTimer.current != null) window.clearTimeout(walkFacingTimer.current);
    walkFacingTimer.current = window.setTimeout(() => {
      setWalkFacing(null);
    }, WALK_FACING_HOLD_MS);
  }, [posX, patrolX, fightAnchor, buttonHopTarget, dragging]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Button-hop: pet jumps onto a random visible button occasionally ─────
  // Scheduler runs as a single setInterval whose dependency array contains
  // only [isVisible]. State that the tick reads (mood, dragging, peek,
  // current pos) goes through *Ref companions to keep the cadence stable.
  useEffect(() => {
    if (!isVisible) return;
    let cancelled = false;
    const timers = new Set<number>();
    const scheduleClear = (id: number) => { timers.add(id); };
    const tick = window.setInterval(() => {
      if (cancelled) return;
      if (buttonHopTargetRef.current != null) return;
      const m = moodRef.current;
      if (m !== 'idle' && m !== 'thinking') return;
      if (dragRefBool.current || peekRef.current) return;
      if (document.visibilityState !== 'visible') return;
      const rate = activityRateRef.current;
      if (rate <= 0) return;
      if (Math.random() >= Math.min(1, BUTTON_HOP_PROBABILITY * rate)) return;
      const target = pickButtonHopTarget(posRef.current);
      if (!target) return;
      setButtonHopTarget(target);
      const onArrive = window.setTimeout(() => {
        if (cancelled) return;
        if (target.pressCount > 0) {
          for (let i = 0; i < target.pressCount; i++) {
            const id = window.setTimeout(() => {
              if (cancelled) return;
              setPressBeat((b) => b + 1);
            }, i * BUTTON_PRESS_DURATION_MS);
            scheduleClear(id);
          }
          const totalPressMs = target.pressCount * BUTTON_PRESS_DURATION_MS;
          const id = window.setTimeout(() => {
            if (cancelled) return;
            setButtonHopTarget(null);
          }, totalPressMs + BUTTON_HOP_HOLD_MS);
          scheduleClear(id);
        } else {
          const id = window.setTimeout(() => {
            if (cancelled) return;
            setButtonHopTarget(null);
          }, BUTTON_HOP_HOLD_MS);
          scheduleClear(id);
        }
      }, BUTTON_HOP_SLIDE_MS);
      scheduleClear(onArrive);
    }, BUTTON_HOP_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(tick);
      for (const t of timers) window.clearTimeout(t);
    };
  }, [isVisible]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cancel any in-flight button-hop the moment mood escalates or drag starts.
  useEffect(() => {
    if (buttonHopTarget == null) return;
    if (dragging || mood === 'fighting' || mood === 'powermove' || mood === 'error') {
      setButtonHopTarget(null);
    }
  }, [dragging, mood, buttonHopTarget]); // eslint-disable-line react-hooks/exhaustive-deps

  // Clear locomotion override when an action mood kicks in.
  useEffect(() => {
    if (locomotionMood == null) return;
    if (mood === 'fighting' || mood === 'powermove' || mood === 'error') {
      setLocomotionMood(null);
    }
  }, [mood, locomotionMood]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Press-bounce: imperative WAAPI call on each beat ───────────────────
  // Fires one bounce keyframe per pressBeat increment. Done imperatively
  // (not via CSS class) so the sprite component doesn't re-mount each beat.
  useEffect(() => {
    if (pressBeat === 0) return;
    const el = flipWrapRef.current;
    if (!el || typeof el.animate !== 'function') return;
    let f: PetFacing = baseFacing;
    if (fightAnchor) f = fightAnchor.facing;
    else if (lookAroundFacing) f = lookAroundFacing;
    else if (walkFacing) f = walkFacing;
    const fs = f === 'left' ? -1 : 1;
    const base = `scaleX(${fs})`;
    el.animate(
      [
        { transform: `${base} translateY(0)`,    offset: 0 },
        { transform: `${base} translateY(7px)`,  offset: 0.42 },
        { transform: `${base} translateY(-3px)`, offset: 0.74 },
        { transform: `${base} translateY(0)`,    offset: 1 },
      ],
      { duration: BUTTON_PRESS_DURATION_MS, easing: 'ease-in-out' },
    );
  }, [pressBeat, baseFacing, fightAnchor, lookAroundFacing, walkFacing]); // eslint-disable-line react-hooks/exhaustive-deps
}
