// usePetPlayground — WASD / arrow-key free-movement mode, extracted from FloatingPet.tsx.
//
// Active only while `playgroundMode` is true. Reads keyboard input via
// keydown/keyup, runs a rAF tick that moves the pet 3 px/frame (6 px/frame
// with Shift), and fires WAAPI jump arcs on Space. Calls scheduleReturnHome
// on exit so the pet drifts back to its settled position.

import { useEffect } from 'react';
import type { MutableRefObject } from 'react';
import type { PetMood, PetFacing } from './store/petStore.js';
import type { Point } from './petOverlayGeometry.js';
import { clampPos } from './petOverlayGeometry.js';
import { JUMP_PEAK_PX } from './petOverlayConstants.js';

export interface UsePetPlaygroundArgs {
  playgroundMode: boolean;
  // Refs
  flipWrapRef: MutableRefObject<HTMLDivElement | null>;
  facingScaleRef: MutableRefObject<number>;
  walkFacingTimer: MutableRefObject<number | null>;
  locomotionMoodRef: MutableRefObject<PetMood | null>;
  keysHeld: MutableRefObject<Set<string>>;
  pgRafRef: MutableRefObject<number | null>;
  // Setters
  setPlaygroundMode: (v: boolean) => void;
  setPatrolX: (x: number) => void;
  setPatrolY: (y: number) => void;
  setPos: (updater: (prev: Point) => Point) => void;
  setLocomotionMood: (m: PetMood | null) => void;
  setWalkFacing: (f: PetFacing | null) => void;
  // Callback to schedule the return-home timer (defined in FloatingPet).
  scheduleReturnHome: () => void;
}

/**
 * Drives WASD / arrow-key free-movement while playground mode is active.
 *
 * Movement:
 *   A/←  D/→   → horizontal (running sprite)
 *   W/↑  S/↓   → vertical motion (reuses the canonical running sprite)
 *   Shift       → 2× speed
 *   Space       → one-shot jump arc (WAAPI, doesn't repeat while held)
 *   Escape      → exit playground mode
 *
 * On exit, clears locomotion/facing overrides and schedules the return-home
 * timer so the pet drifts back to its settled side zone.
 */
export function usePetPlayground({
  playgroundMode,
  flipWrapRef,
  facingScaleRef,
  walkFacingTimer,
  locomotionMoodRef,
  keysHeld,
  pgRafRef,
  setPlaygroundMode,
  setPatrolX,
  setPatrolY,
  setPos,
  setLocomotionMood,
  setWalkFacing,
  scheduleReturnHome,
}: UsePetPlaygroundArgs): void {
  useEffect(() => {
    if (!playgroundMode) return;
    const SPEED = 3;
    // Clear any lingering patrol offsets so the pet starts from a clean
    // on-screen position.
    setPatrolX(0);
    setPatrolY(0);

    let jumpActive = false;

    const onKeyDown = (e: KeyboardEvent) => {
      keysHeld.current.add(e.key);
      if (e.key === 'Escape') setPlaygroundMode(false);
      // Trigger a one-shot jump on Space press (not held).
      if (e.key === ' ' && !e.repeat && !jumpActive) {
        jumpActive = true;
        setLocomotionMood('jumping');
        const wrap = flipWrapRef.current;
        if (wrap && typeof wrap.animate === 'function') {
          const fs = facingScaleRef.current;
          wrap.animate(
            [
              { transform: `scaleX(${fs}) translateY(0px)`,                        offset: 0    },
              { transform: `scaleX(${fs}) translateY(-${JUMP_PEAK_PX * 0.55}px)`,  offset: 0.18 },
              { transform: `scaleX(${fs}) translateY(-${JUMP_PEAK_PX}px)`,         offset: 0.45 },
              { transform: `scaleX(${fs}) translateY(-${JUMP_PEAK_PX * 0.55}px)`,  offset: 0.72 },
              { transform: `scaleX(${fs}) translateY(0px)`,                        offset: 1    },
            ],
            { duration: 840, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'none' },
          );
        }
        window.setTimeout(() => { jumpActive = false; }, 840);
      }
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', ' '].includes(e.key)) {
        e.preventDefault();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => keysHeld.current.delete(e.key);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    const tick = () => {
      const keys = keysHeld.current;
      const speed = keys.has('Shift') ? SPEED * 2 : SPEED;
      let dx = 0, dy = 0;
      if (keys.has('a') || keys.has('ArrowLeft'))  dx -= speed;
      if (keys.has('d') || keys.has('ArrowRight')) dx += speed;
      if (keys.has('w') || keys.has('ArrowUp'))    dy -= speed;
      if (keys.has('s') || keys.has('ArrowDown'))  dy += speed;

      if (dx !== 0 || dy !== 0) {
        setPos(prev => clampPos({ x: prev.x + dx, y: prev.y + dy }));
        if (!jumpActive) {
          // Single locomotion mood for every direction (Codex 9 + flipRun
          // model) — CSS scaleX(-1) handles the mirror for left motion;
          // vertical-only motion reuses the same right-facing sprite.
          if (dx !== 0) {
            if (walkFacingTimer.current != null) window.clearTimeout(walkFacingTimer.current);
            setWalkFacing(dx > 0 ? 'right' : 'left');
          }
          if (locomotionMoodRef.current !== 'running') setLocomotionMood('running');
        }
      } else if (!jumpActive) {
        if (locomotionMoodRef.current !== null) setLocomotionMood(null);
      }
      pgRafRef.current = requestAnimationFrame(tick);
    };
    pgRafRef.current = requestAnimationFrame(tick);

    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      if (pgRafRef.current !== null) {
        cancelAnimationFrame(pgRafRef.current);
        pgRafRef.current = null;
      }
      keysHeld.current.clear();
      setLocomotionMood(null);
      setWalkFacing(null);
      scheduleReturnHome();
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [playgroundMode]);
}
