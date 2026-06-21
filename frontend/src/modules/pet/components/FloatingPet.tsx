// FloatingPet — the bare overlay that renders the active pet sprite, drives
// patrol/walk motion, drag-to-reposition, XP bursts, and the small touches
// the user-facing pet system relies on:
//
//   • Facing direction          — petStore.facing + per-walk + per-fight + idle look-around
//   • Default home              — anchored to the LEFT edge of .chat-input-wrapper
//   • Tool-call side variation  — fights teleport-slide to a random side, facing inward
//   • Vertical CRT shutdown     — sprite collapses to a vertical line on connection loss
//   • Theme tint                — optional SVG filter (#yha-pet-tint) tints the
//                                  sprite to the live accent without bleeding
//                                  onto the transparent corners of the cell
//
// Removed (May 2026): cursor-follow hops. Even with aggressive debouncing
// the document-level `input` listener and mirror-div caret measurement
// added perceptible typing lag in the chat textarea. The user preference
// was "rather no follow than slow typing", so the feature is gone — see
// petsREADME.md §8 for history. If we re-add later, do it via a Worker or
// `getClientRects()` on a contenteditable mirror, NOT a textarea mirror
// that forces synchronous layout on every measurement.
//
// All non-trivial timings live as named constants in pet/petOverlayConstants.ts
// so they're easy to tune without re-reading the code.
//
// The patrol, idle-behavior, and playground-mode useEffects live in dedicated
// hooks (pet/usePetPatrol.ts, pet/usePetIdleBehaviors.ts,
// pet/usePetPlayground.ts) — this file owns all shared state and refs and
// passes setters/refs to those hooks.

import { useEffect, useRef, useState } from 'react';
import type { CSSProperties, PointerEvent } from 'react';
import { createPortal } from 'react-dom';
import { usePetStore, type PetMood, type PetFacing } from '../store/petStore.js';
import { useConnectionStore } from '../../../stores/connectionStore.js';
import { PetSprite } from './PetSprite.js';
import { useChatReflow } from '../chatReflow.js';
import { usePetConsoleStore } from '../store/petConsoleStore.js';
import { usePetWorldModel } from '../world/usePetWorldModel.js';

import {
  PET_W,
  PET_H,
  RETURN_HOME_MS,
  POS_HOME_SNAP_THRESHOLD_PX,
  CLICK_DRAG_THRESHOLD_PX,
  SIDE_ZONE_DEPTH,
} from '../petOverlayConstants.js';

import {
  type Point,
  parseColor,
  darken,
  clampPos,
  msgAreaBounds,
  randomXpThreshold,
} from '../petOverlayGeometry.js';

import { useSpriteConfig, RewardBurst } from './PetRewardBurst.js';
import { PetDebugOverlay } from './PetDebugOverlay.js';
import { usePetPlayground } from '../usePetPlayground.js';
import { getProfile, type PetProfile, type UsePetSchedulerArgs } from '../profiles/index.js';

// POS_KEY bumped to v2 when we moved the default home anchor from the right
// edge of the chat input to the LEFT edge. Old saved positions would otherwise
// keep the pet stuck on the right side of the input wrapper for users who had
// dragged it once with the previous default.
const POS_KEY = 'yha.pet.overlayPos.v2';
const POS_KEY_LEGACY = 'yha.pet.overlayPos';
/** Persists which side zone the pet is settled on ('left' | 'right'). */
const SIDE_KEY = 'yha.pet.settledSide.v1';

/** Active state moods always win over locomotion override in effectiveMood.
 *  See the lookup site below for the rationale (streaming/thinking/fighting/
 *  etc. must show their own poses during a chat session, not the walk cycle
 *  a patrolling scheduler set via setLocomotionMood). Defined at module
 *  scope so the array isn't re-created on every render. */
const ACTIVE_STATE_MOODS: ReadonlySet<PetMood> = new Set([
  'streaming', 'thinking', 'reconnecting',
  'powermove', 'fighting', 'xpeffect', 'error',
] as const);
/** Module-level settled-side. homePos() and sideZoneCenter() read this so
 *  they return the correct zone even when called outside the component
 *  (resize handlers, return-home timer). Updated synchronously via a
 *  useEffect whenever the in-component settledSide state changes. */
let gSettledSide: 'left' | 'right' = (() => {
  try { const v = localStorage.getItem(SIDE_KEY); return v === 'right' ? 'right' : 'left'; }
  catch { return 'left'; }
})();

/**
 * Absolute viewport X of the centre of the named side zone (accounts for
 * pet width so the zone edges align with the bubble edges). Returns null
 * when no messages are visible yet.
 */
function sideZoneCenter(side: 'left' | 'right'): number | null {
  const b = msgAreaBounds();
  if (!b) return null;
  // The overlay is 240 px wide; the hitbox sits 56 px from the left edge.
  // Right formula: body right edge = b.right + 36 (36 px outside the column).
  // Left formula: symmetric — body left edge = b.left - 36.
  //   pos.x + 56 = b.left - 36  →  pos.x = b.left - 92 = b.left - 2×56 + SIDE_ZONE_DEPTH/2
  return side === 'left'
    ? b.left  - 2 * 56 + SIDE_ZONE_DEPTH / 2  // body left 36px outside b.left — mirrors right
    : b.right - PET_W  - SIDE_ZONE_DEPTH / 2; // body right 36px outside b.right (unchanged)
}

function saveSettledSide(side: 'left' | 'right'): void {
  try { localStorage.setItem(SIDE_KEY, side); } catch { /* ignore */ }
}

/**
 * Compute the pet's home position. Prefers the centre of the current
 * `gSettledSide` zone within the chat message area; falls back to the LEFT
 * edge of `.chat-input-wrapper` when no messages are visible (empty chat).
 * Y is always anchored to the top surface of the input area.
 */
function homePos(): Point {
  const input = document.querySelector<HTMLElement>('.chat-input-wrapper, .chat-input-container');
  const r = input?.getBoundingClientRect();
  // Anchor the SPRITE FOOT to the top edge of the visible input-area
  // background (.chat-input-wrapper::before paints `var(--surface-2)` at
  // inset:0). The pet overlay is 240px tall; the hitbox sits at top:40px
  // and is PET_H tall, so the foot is at offset (40 + PET_H) inside the
  // overlay. overlay.y = wrapperTop - 40 - PET_H lands the foot exactly
  // on the wrapper's top edge; +36 sinks the foot 36 px into the surface
  // so the pet reads as standing on it rather than perching on the edge.
  const y = r ? r.top - 40 - PET_H + 36 : window.innerHeight - PET_H - 120;
  // X: use the current settled side zone centre; fall back to input left edge.
  const cx = sideZoneCenter(gSettledSide);
  const x  = cx != null ? cx : r ? Math.max(8, r.left + 6) : 24;
  return clampPos({ x, y });
}

function loadPos(): Point | null {
  try {
    // Drop any v1 entry so it doesn't leak through if the new key gets
    // cleared. Cheap defensive cleanup; runs once per page load.
    localStorage.removeItem(POS_KEY_LEGACY);
  } catch { /* ignore */ }
  try {
    const raw = localStorage.getItem(POS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Point>;
    if (typeof parsed.x !== 'number' || typeof parsed.y !== 'number') return null;
    const candidate = clampPos({ x: parsed.x, y: parsed.y });
    // Auto-snap to home if the saved position is way out of line with the
    // current home anchor. Skip the check when settled on the right side —
    // the right zone is far from the fallback left-edge homePos() and a
    // fixed distance threshold would incorrectly reset valid right-side
    // positions before the message area is rendered.
    if (gSettledSide === 'left') {
      const home = homePos();
      if (Math.abs(candidate.x - home.x) > POS_HOME_SNAP_THRESHOLD_PX) {
        console.info('[FloatingPet] saved position is far from home — snapping back.');
        return home;
      }
    }
    return candidate;
  } catch {
    return null;
  }
}

function savePos(p: Point): void {
  try { localStorage.setItem(POS_KEY, JSON.stringify(p)); } catch { /* ignore */ }
}

export function FloatingPet() {
  const isVisible = usePetStore((s) => s.isVisible);
  const mood = usePetStore((s) => s.mood);
  const rewardBurstId = usePetStore((s) => s.rewardBurstId);
  const triggerRewardBurst = usePetStore((s) => s.triggerRewardBurst);
  const baseFacing = usePetStore((s) => s.facing);
  const mirrorSprite = usePetStore((s) => s.mirrorSprite);
  const flipRun = usePetStore((s) => s.flipRun);
  const themeTint = usePetStore((s) => s.themeTint);
  const fightVariantSeed = usePetStore((s) => s.fightVariantSeed);
  const shadowOffsetPx = usePetStore((s) => s.shadowOffsetPx);
  const globalScale = usePetStore((s) => s.globalScale);
  const glowIntensity = usePetStore((s) => s.glowIntensity);
  // Level-up signal — non-zero means an animation is currently playing
  // and the pet should be in the corresponding grow-step / settle pose.
  // 0 = no animation. Read here so a re-render is forced as the stage
  // advances; the actual visual lives in CSS keyframes keyed off the
  // `data-level-stage` attribute.
  const levelUpStage = usePetStore((s) => s.levelUpStage);
  const level = usePetStore((s) => s.level);
  // behindUi toggles the pet's z-index below #root so chat / text /
  // buttons / images all sit ABOVE the pet. Reflected as `is-behind-ui`
  // on .pet-overlay; the body class (which actually promotes #root
  // into a stacking context) is set by setBehindUi() in the store, so
  // the toggle works regardless of FloatingPet mount state.
  const behindUi = usePetStore((s) => s.behindUi);
  // activityRate scales the cadence of every spontaneous behaviour.
  // Read here so a re-render fires when it changes; the long-lived
  // schedulers read the live value through `activityRateRef` so they
  // don't tear down + recreate on every tweak (which would reset the
  // interval timer and feel laggy).
  const activityRate = usePetStore((s) => s.activityRate);
  const xpInterval = usePetStore((s) => s.currentPet?.manifest?.xpeffectInterval);
  const connectionStatus = useConnectionStore((s) => s.status);
  const playgroundMode = usePetStore((s) => s.playgroundMode);
  const setPlaygroundMode = usePetStore((s) => s.setPlaygroundMode);
  // Active behavior profile (petV1 today, future profiles plug into the
  // same slot). The sub-component <PetBehaviors key={activeProfileId} />
  // below carries a key bound to this id so React fully remounts the
  // scheduler subtree when the user switches — different profiles may
  // compose a different number of useEffects inside their hook bodies,
  // so we can't call profile.hooks.useScheduler directly on the same
  // render path without violating the rules of hooks.
  const activeProfileId = usePetStore((s) => s.activeProfileId);
  const activeProfile = getProfile(activeProfileId);

  const [pos, setPos] = useState<Point>(() => loadPos() || homePos());
  /** Live theme accent — read from CSS var on mount, refreshed when YHA
   *  emits its `yha:bg-theme` event or any data-theme/data-variant
   *  mutation on <html>. Used by the SVG tint filter so the sprite
   *  recolours correctly on theme switch without React state going stale.
   *
   *  The new dual-tone tint pipeline (May 2026) reads two colors: the
   *  primary `--accent` (used for highlights / bright parts of the
   *  desaturated sprite) and a darker `--accent-2` (used for shadows /
   *  dark parts). The result is a clean two-tone re-colour that maps the
   *  sprite's luminance to a gradient between the two theme colors —
   *  much higher contrast than the old single-color blend. */
  const [accentColor, setAccentColor] = useState<string>('#00e08a');
  const [accentDark, setAccentDark] = useState<string>('#0a3a26');
  const [dragging, setDragging] = useState(false);
  /** Walk-direction patrol offset; px from `pos` (negative = left, positive = right). */
  const [patrolX, setPatrolX] = useState(0);
  /** Vertical wander offset; px from `pos.y` (negative = up, 0 = home). */
  const [patrolY, setPatrolY] = useState(0);
  /** Transient look-around override; null = use baseFacing + walk direction. */
  const [lookAroundFacing, setLookAroundFacing] = useState<PetFacing | null>(null);
  /** Fight-time anchor offset and facing. Cleared when mood drops back. */
  const [fightAnchor, setFightAnchor] = useState<{ x: number; facing: PetFacing } | null>(null);
  /** "Peeking away" — pet shrinks and drops behind the chat input. Idle only. */
  const [isPeekingAway, setIsPeekingAway] = useState(false);
  /** Button-hop target. (dx, dy) is offset from pos.x/pos.y. While set, the
   *  pet slides over the chosen button. Pressing kicks in after the slide
   *  if pressCount > 0. Cleared when the pet returns home. */
  const [buttonHopTarget, setButtonHopTarget] = useState<{
    dx: number;
    dy: number;
    pressCount: number;
  } | null>(null);
  /** Press-bounce trigger key. Each new value re-runs the keyframe. */
  const [pressBeat, setPressBeat] = useState<number>(0);
  /** Direction the pet is currently *moving*; set whenever the effective
   *  X changes meaningfully and cleared by a timer after the transition
   *  settles. Wins over base facing in the priority chain so the pet
   *  always looks where it's going. */
  const [walkFacing, setWalkFacing] = useState<PetFacing | null>(null);
  /** Which side zone the pet is currently settled on. Controls homePos(),
   *  patrol target selection, and fight anchor placement. Persisted to
   *  localStorage so the pet wakes up on the same side it last settled on. */
  const [settledSide, setSettledSide] = useState<'left' | 'right'>(() => gSettledSide);
  const settledSideRef = useRef<'left' | 'right'>(gSettledSide);
  /**
   * Locomotion mood override — set by doWalk() while the pet is physically
   * moving. Wins over the chat-derived `mood` when computing the effective
   * sprite to show. `null` means "show the regular mood sprite".
   */
  const [locomotionMood, setLocomotionMood] = useState<PetMood | null>(null);
  const locomotionMoodRef = useRef<PetMood | null>(null);

  // effectiveMood: chat-driven *active* moods (streaming, thinking, fighting,
  // …) ALWAYS win over the locomotion override so a patrolling pet doesn't
  // mask the working/thinking animation during a chat session. For passive
  // moods (idle, happy) locomotion wins — that's the autonomous wander +
  // patrol behavior driving the sprite.
  //
  // Without this gate, V1's patrol scheduler setting locomotionMood='running'
  // during a streaming chat would display the walk cycle instead of the
  // streaming/working pose.
  const effectiveMood: PetMood = ACTIVE_STATE_MOODS.has(mood) ? mood : (locomotionMood ?? mood);
  const spriteConfig = useSpriteConfig(effectiveMood);

  const dragRef = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
  const returnTimer = useRef<number | null>(null);
  const visibleMs = useRef(0);
  const xpTarget = useRef(randomXpThreshold());
  /** Imperative target for the press-bounce Web Animations API call.
   *  Living on a ref instead of going through CSS class toggling avoids
   *  re-mounting the PetSprite (which would flash the loading state). */
  const flipWrapRef = useRef<HTMLDivElement | null>(null);
  /** Ref to the outer .pet-overlay div — passed to useChatReflow so the
   *  hook can measure the pet's viewport rect without re-renders. */
  const petRef = useRef<HTMLDivElement | null>(null);
  /** Last on-screen X for the walk-facing tracker. Updated only when the
   *  effective X changes by ≥ WALK_FACING_MIN_DELTA_PX. */
  const lastEffectiveXRef = useRef<number>(0);
  const walkFacingTimer = useRef<number | null>(null);
  /** Refs mirroring the latest state for use inside long-lived schedulers
   *  (button-hop interval, etc.) without re-creating the timer on every
   *  position/mood change. */
  const posRef = useRef<Point>({ x: 0, y: 0 });
  const dragRefBool = useRef<boolean>(false);
  const peekRef = useRef<boolean>(false);
  const moodRef = useRef<PetMood>('idle');
  const buttonHopTargetRef = useRef<typeof buttonHopTarget>(null);
  /** Live activity-rate multiplier read by every spontaneous-behaviour
   *  scheduler. Mirrored from the store so the long-lived setIntervals
   *  (button-hop / peek-away / look-around / patrol) don't have to go
   *  in their dependency arrays — that would re-create the timer on
   *  every slider step and feel laggy. */
  const activityRateRef = useRef<number>(activityRate);
  /** Current sprite-flip scale (-1 left, +1 right) read by the imperative
   *  hop animation in the patrol scheduler. Mirroring it on a ref keeps
   *  the patrol useEffect's dep array tight (otherwise every facing flip
   *  would tear the patrol schedule down + lose the in-flight hop) while
   *  still letting fireHop() compose its WAAPI keyframes around the
   *  correct base scaleX. */
  const facingScaleRef = useRef<number>(1);

  // ── Playground mode (WASD / arrow-key free movement) ──────────────────
  const playgroundModeRef = useRef(false);
  const keysHeld = useRef(new Set<string>());
  const pgRafRef = useRef<number | null>(null);

  // ── Drag-locomotion refs ───────────────────────────────────────────────
  /** Last X during drag — used to detect horizontal movement direction. */
  const lastDragX = useRef<number | null>(null);
  /** Timer that clears locomotionMood a beat after drag ends. */
  const locomotionClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const onResize = () => setPos((p) => clampPos(p));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // When the chat switches between empty and non-empty mode (#view-chat gets
  // or loses the `chat-empty` class), the input-area slides vertically via a
  // CSS translateY transition (~400 ms).  getBoundingClientRect() reflects the
  // post-transform position, so we just need to wait for the transition to
  // finish before calling homePos() again.
  useEffect(() => {
    const root = document.getElementById('view-chat');
    if (!root) return;
    let tid: ReturnType<typeof setTimeout>;
    const obs = new MutationObserver(() => {
      clearTimeout(tid);
      tid = setTimeout(() => { setPos(homePos()); setPatrolY(0); }, 420);
    });
    obs.observe(root, { attributeFilter: ['class'] });
    return () => { obs.disconnect(); clearTimeout(tid); };
  }, []);

  // Mirror state into refs so the long-lived schedulers (button-hop in
  // particular) can read current values without taking React state in
  // their dependency array — that would re-create the setInterval every
  // mood/position change and reset the cadence.
  useEffect(() => { posRef.current = pos; }, [pos]);
  useEffect(() => { dragRefBool.current = dragging; }, [dragging]);
  useEffect(() => { peekRef.current = isPeekingAway; }, [isPeekingAway]);
  useEffect(() => { moodRef.current = mood; }, [mood]);
  useEffect(() => { buttonHopTargetRef.current = buttonHopTarget; }, [buttonHopTarget]);
  useEffect(() => { activityRateRef.current = activityRate; }, [activityRate]);
  useEffect(() => { locomotionMoodRef.current = locomotionMood; }, [locomotionMood]);
  useEffect(() => { playgroundModeRef.current = playgroundMode; }, [playgroundMode]);
  useEffect(() => () => {
    if (locomotionClearTimer.current !== null) clearTimeout(locomotionClearTimer.current);
  }, []);
  // Keep module-level gSettledSide and the per-render ref in sync with state.
  // Both are read by helpers (homePos, sideZoneCenter) and long-lived
  // closures (patrol scheduler, fight anchor) that don't re-close over
  // React state on every render.
  useEffect(() => {
    settledSideRef.current = settledSide;
    gSettledSide = settledSide;
  }, [settledSide]);

  // Text-reflow around pet: inject/update/remove CSS float sentinel.
  useChatReflow(petRef);
  // Spatial-awareness snapshot — debounced 2 s after the pet rests, gated on
  // isVisible/!behindUi. Producer for petWorldStore; consumed by the debug
  // overlay, the pet-vision MCP, and any future profile that wants
  // spatial awareness.
  usePetWorldModel(petRef);

  // Keep fireHop() pointed at the correct facing without putting live
  // facing state into the patrol effect's dep array (which would
  // recreate the schedule on every flip + drop the pending hop chain).
  useEffect(() => {
    let f: PetFacing = baseFacing;
    if (fightAnchor) f = fightAnchor.facing;
    else if (lookAroundFacing) f = lookAroundFacing;
    else if (walkFacing) f = walkFacing;
    facingScaleRef.current = f === 'left' ? -1 : 1;
  }, [baseFacing, fightAnchor, lookAroundFacing, walkFacing]);

  // ── Theme accent reader (drives the SVG tint filter) ───────────────────
  // Re-reads on mount + when YHA emits its theme events. The earlier
  // implementation also ran a MutationObserver on `<html>` that watched
  // `class`/`style` mutations — but during heavy runtime (typing,
  // streaming, layout shifts) that observer fires often and each fire
  // synchronously calls `getComputedStyle` which forces style recalc on
  // <html>. The combined cost showed up as input lag for the user.
  // Theme changes always go through one of the two events below, so the
  // observer added cost without coverage. Removed.
  useEffect(() => {
    if (!themeTint) return;
    const read = () => {
      try {
        const cs = getComputedStyle(document.documentElement);
        const a = cs.getPropertyValue('--accent').trim();
        const d = cs.getPropertyValue('--accent-2').trim()
               || cs.getPropertyValue('--accent-3').trim();
        if (a) setAccentColor(a);
        // Fallback chain: --accent-2 → --accent-3 → derive a darker shade
        // from the primary accent. Some themes only define a single accent
        // and would otherwise map both shadow and highlight to the same
        // colour — defeating the dual-tone effect.
        if (d) setAccentDark(d);
        else if (a) setAccentDark(darken(a, 0.55));
      } catch { /* ignore */ }
    };
    read();
    const onTheme = () => read();
    // `yha:bg-theme` + `yha:store-bgtheme` fire when the bg-shader theme
    // changes; `yha:color-theme` fires when the color-theme family or
    // dark/bright variant flips (color-themes-config.ts:applyColorThemeToDom).
    // The color-theme event is the load-bearing one for the tint pipeline —
    // the bg-shader events used to be the only listeners, so a plain
    // dark↔bright toggle left the sprite tinted with the previous accent
    // until reload.
    window.addEventListener('yha:bg-theme', onTheme as EventListener);
    window.addEventListener('yha:store-bgtheme', onTheme as EventListener);
    window.addEventListener('yha:color-theme', onTheme as EventListener);
    return () => {
      window.removeEventListener('yha:bg-theme', onTheme as EventListener);
      window.removeEventListener('yha:store-bgtheme', onTheme as EventListener);
      window.removeEventListener('yha:color-theme', onTheme as EventListener);
    };
  }, [themeTint]);

  // XP-Timer (echte Screentime)
  useEffect(() => {
    if (!isVisible) return;
    visibleMs.current = 0;
    xpTarget.current = randomXpThreshold(xpInterval);
    const tick = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return;
      visibleMs.current += 1000;
      if (visibleMs.current >= xpTarget.current) {
        visibleMs.current = 0;
        xpTarget.current = randomXpThreshold(xpInterval);
        triggerRewardBurst();
      }
    }, 1000);
    return () => window.clearInterval(tick);
  }, [isVisible, triggerRewardBurst, xpInterval]);

  // ── commitSettledSide ───────────────────────────────────────────────────
  // Atomically commits a new settled-side to React state, the ref, the
  // module-level gSettledSide (for helpers like homePos/sideZoneCenter
  // called outside the component), and localStorage. Passed to usePetPatrol
  // so the hook doesn't need to import gSettledSide or saveSettledSide.
  function commitSettledSide(newSide: 'left' | 'right'): void {
    setSettledSide(newSide);
    settledSideRef.current = newSide;
    gSettledSide = newSide;
    saveSettledSide(newSide);
  }

  // ── Behavior scheduler (driven by the active profile) ─────────────────
  // Profile-owned hooks are called inside <PetBehaviors />, not here, so
  // switching profiles can safely remount the scheduler subtree via the
  // key prop without violating the rules of hooks in FloatingPet itself.
  const schedulerArgs: UsePetSchedulerArgs = {
    isVisible,
    dragging,
    mood,
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
    posX: pos.x,
    activityRateRef,
    playgroundModeRef,
    posRef,
    facingScaleRef,
    settledSideRef,
    dragRefBool,
    moodRef,
    peekRef,
    buttonHopTargetRef,
    lastEffectiveXRef,
    walkFacingTimer,
    flipWrapRef,
    setPatrolX,
    setPatrolY,
    setLocomotionMood,
    setPos,
    setIsPeekingAway,
    setLookAroundFacing,
    setFightAnchor,
    setWalkFacing,
    setButtonHopTarget,
    setPressBeat,
    commitSettledSide,
    sideZoneCenter,
    homePos,
  };

  useEffect(() => {
    const refreshHome = () => {
      if (dragging || mood === 'powermove' || document.visibilityState !== 'visible') return;
      setPos((p) => {
        const home = homePos();
        const nearHome = Math.abs(p.x - home.x) < 4 && Math.abs(p.y - home.y) < 4;
        return nearHome ? home : p;
      });
    };
    window.addEventListener('resize', refreshHome);
    window.addEventListener('yha:layout-changed', refreshHome as EventListener);
    return () => {
      window.removeEventListener('resize', refreshHome);
      window.removeEventListener('yha:layout-changed', refreshHome as EventListener);
    };
  }, [dragging, isVisible, mood]);

  function scheduleReturnHome() {
    if (returnTimer.current != null) window.clearTimeout(returnTimer.current);
    returnTimer.current = window.setTimeout(() => {
      const next = homePos();
      setPos(next);
      savePos(next);
      setPatrolY(0); // reset vertical wander — pet returns fully home after drag
    }, RETURN_HOME_MS);
  }

  // ── Unified Pointer-Drag für Mouse + Touch ─────────────────────────────

  function onPointerDown(e: PointerEvent<HTMLElement>) {
    if (playgroundMode) return;
    const el = e.currentTarget;
    e.preventDefault();
    el.setPointerCapture?.(e.pointerId);
    setDragging(true);
    setPatrolX(0);
    setPatrolY(0); // clear vertical wander — originY bakes in the current patrolY below
    if (returnTimer.current != null) window.clearTimeout(returnTimer.current);
    dragRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      originX: pos.x,
      // Bake the current vertical wander offset into the drag origin so
      // clampPos operates on the true visual Y (pos.y + patrolY). Without
      // this, clampPos caps pos.y at innerHeight - PET_H - 8 while the
      // visual sits |patrolY| pixels above that, making the bottom of the
      // viewport unreachable during drag after any vertical wander.
      originY: pos.y + patrolY,
      // Click vs drag gate (Phase 1.5a — Pet Console). The pointermove
      // handler flips this true once total displacement exceeds
      // CLICK_DRAG_THRESHOLD_PX. On pointerup we read it to decide whether
      // to toggle the pet console bubble or just commit a drag.
      moved: false,
    };
    lastDragX.current = pos.x;
    if (locomotionClearTimer.current !== null) {
      clearTimeout(locomotionClearTimer.current);
      locomotionClearTimer.current = null;
    }
  }

  function onPointerMove(e: PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    e.preventDefault();
    // Flip the click/drag gate the first time displacement crosses the
    // threshold. Once flipped it stays flipped — a user who drags 30 px
    // and then nudges back to 1 px is still drag-intent.
    if (!drag.moved) {
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      if (dx * dx + dy * dy > CLICK_DRAG_THRESHOLD_PX * CLICK_DRAG_THRESHOLD_PX) {
        drag.moved = true;
      }
    }
    const next = clampPos({
      x: e.clientX - drag.startX + drag.originX,
      y: e.clientY - drag.startY + drag.originY,
    });
    setPos(next);
    // Show running animation in drag direction when moving horizontally.
    if (lastDragX.current !== null && Math.abs(next.x - lastDragX.current) > 6) {
      if (locomotionClearTimer.current !== null) {
        clearTimeout(locomotionClearTimer.current);
        locomotionClearTimer.current = null;
      }
      // Single locomotion mood for both directions — the per-pet flipRun
      // toggle + CSS scaleX(-1) mirror the right-facing 'running' frames
      // for left motion.
      setLocomotionMood('running');
      setWalkFacing(next.x > lastDragX.current ? 'right' : 'left');
      lastDragX.current = next.x;
    }
  }

  function onPointerUp(e: PointerEvent<HTMLElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    e.preventDefault();
    e.currentTarget.releasePointerCapture?.(e.pointerId);
    const wasClick = !drag.moved;
    dragRef.current = null;
    setDragging(false);
    lastDragX.current = null;
    // Pos speichern + Rückkehr planen
    setPos((p) => {
      savePos(p);
      return p;
    });
    scheduleReturnHome();
    // Clear running animation shortly after release so the landing
    // frame has time to show before the pet goes idle.
    if (locomotionClearTimer.current !== null) clearTimeout(locomotionClearTimer.current);
    locomotionClearTimer.current = setTimeout(() => {
      setLocomotionMood(null);
      locomotionClearTimer.current = null;
    }, 400);
    // ── Click/tap → toggle the pet console bubble (or collapse voice) ──
    // Phase 1.5a. Only fires when total pointer displacement stayed below
    // the click/drag threshold — drag-and-drop never opens anything.
    // Skipped in playgroundMode so WASD-mode taps don't pop the bubble
    // mid-keyboard-control.
    //
    // Branch:
    //   • Voice mode currently active (body[data-yha-voice-active='1'] set
    //     by VoiceMode.tsx on open) → dispatch toggle-collapsed event so
    //     the minimized panel hides/shows without stopping voice. The pet
    //     effectively "carries" the small panel — click to tuck it away,
    //     click again to bring it back.
    //   • Otherwise → legacy mini-chat toggle (the in-popover Q&A surface).
    //     Voice routing decisions live in the voice button itself + the
    //     submit-target opt-in, not on the pet click.
    if (wasClick && !playgroundMode) {
      const voiceActive = document.body.dataset['yhaVoiceActive'] === '1';
      if (voiceActive) {
        try {
          window.dispatchEvent(new CustomEvent('yha:voice-mode-toggle-collapsed'));
        } catch { /* non-fatal */ }
      } else {
        try {
          usePetConsoleStore.getState().toggleOpen();
        } catch { /* store not yet hydrated — silent */ }
      }
    }
  }

  // ── Playground mode: WASD / arrow-key free movement ───────────────────
  usePetPlayground({
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
  });

  // ── Compute the effective offsets for the rendered overlay.
  //    Priority: drag > fight anchor > button-hop target > patrol > 0
  //    Button-hop is the only one that contributes a vertical offset
  //    (so the pet can land on a button anywhere on the page); the
  //    others are horizontal-only.
  let activeOffsetX = patrolX;
  let activeOffsetY = 0;
  if (fightAnchor) {
    activeOffsetX = fightAnchor.x;
  } else if (buttonHopTarget) {
    activeOffsetX = buttonHopTarget.dx;
    activeOffsetY = buttonHopTarget.dy;
  }

  // Effective facing: fight (locked, faces inward) > look-around >
  // walkFacing (set by the movement-vector tracker effect) > base.
  // walkFacing covers patrol motion, return-home, button-hop slide, and
  // any other transition-driven movement — replacing the older
  // walkDirection inline computation that only knew about patrol.
  let effectiveFacing: PetFacing = baseFacing;
  if (fightAnchor) {
    effectiveFacing = fightAnchor.facing;
  } else if (lookAroundFacing) {
    effectiveFacing = lookAroundFacing;
  } else if (walkFacing) {
    effectiveFacing = walkFacing;
  }

  // CRT-style vertical collapse on connection loss; reverses on restore.
  const isShutdownState = connectionStatus === 'lost' || connectionStatus === 'unauthorized';
  const isBootingState = connectionStatus === 'booting';
  const isRestoringState = connectionStatus === 'restored' || connectionStatus === 'booted';

  // mirrorSprite inverts ALL facing computations for pets whose sprites were
  // drawn facing left (opposite of YHA convention). Toggled by the "Mirror"
  // button so the user can fix inverted sprite sheets without re-importing.
  const facingForFlip: PetFacing = mirrorSprite
    ? (effectiveFacing === 'left' ? 'right' : 'left')
    : effectiveFacing;
  // Per-pet running-direction flip: negates flipScale only during the
  // running locomotion mood. The `running` row is canonically right-facing;
  // CSS scaleX(-1) mirrors it for left motion. The per-pet `flipRun` toggle
  // is the user's manual override for pets imported facing the wrong way.
  const isRunningMood = locomotionMood === 'running';
  const rawFlipScale = facingForFlip === 'left' ? -1 : 1;
  const flipScale = (isRunningMood && flipRun) ? -rawFlipScale : rawFlipScale;
  // Guard: imported Codex manifests may omit effectZone. Fall back to a
  // safe default so the render never throws TypeError on zone.width.
  const zone = spriteConfig.effectZone ?? { width: 300, height: 300, top: -80, left: -60 };

  // ── Behavior-profile hook hosts ────────────────────────────────────────
  // Profile-owned schedulers run regardless of `isVisible` because they
  // gate on it internally — preserves the pre-profile behavior where the
  // hooks were initialized once per FloatingPet mount and stayed live
  // across show/hide toggles. `key={activeProfileId}` forces a clean
  // remount when the user picks a different profile so React's hooks
  // contract holds across profiles that may compose a different number
  // of useEffects.
  const petPortal = !isVisible ? null : createPortal(
    <div
      ref={petRef}
      className={[
        'pet-overlay',
        dragging ? 'is-dragging' : '',
        isShutdownState ? 'is-shutdown' : '',
        isRestoringState ? 'is-restoring' : '',
        isBootingState ? 'is-booting' : '',
        themeTint ? 'is-theme-tinted' : '',
        isPeekingAway ? 'is-peeking-away' : '',
        buttonHopTarget ? 'is-on-button' : '',
        // Hard-cut class for glow=0. The CSS multiplies opacity by the
        // intensity variable, but at exactly 0 the .pet-aura's blurred
        // radial gradient is still composited (just invisible) — adding
        // `display: none` via this class drops it from the layer entirely
        // so the GPU stops blurring 240×210 transparent pixels per frame.
        glowIntensity <= 0 ? 'is-glow-off' : '',
        // Drops the pet to z-index 0 so chat / text / buttons paint
        // above. The body class `has-pet-behind-ui` (set by the store)
        // promotes #root into a positive-z stacking context to make
        // this work — see pet.css for the rule pair.
        behindUi ? 'is-behind-ui' : '',
        playgroundMode ? 'playground-active' : '',
      ].filter(Boolean).join(' ')}
      style={{
        '--pet-x': `${pos.x}px`,
        '--pet-y': `${pos.y}px`,
        '--pet-patrol-x': `${activeOffsetX}px`,
        '--pet-patrol-y': `${patrolY}px`,
        '--pet-offset-y': `${activeOffsetY}px`,
        '--pet-w': `${PET_W}px`,
        '--pet-h': `${PET_H}px`,
        '--pet-effect-w': `${zone.width}px`,
        '--pet-effect-h': `${zone.height}px`,
        '--pet-effect-top': `${zone.top}px`,
        '--pet-effect-left': `${zone.left}px`,
        '--pet-flip-x': flipScale,
        '--pet-shadow-offset': `${shadowOffsetPx}px`,
        // Global scale + glow intensity. Both are applied in pet.css —
        // scale via a transform: scale() on .pet-overlay (foot-anchored
        // origin), glow via opacity multipliers on .pet-aura and the
        // sprite's gold drop-shadow filter.
        '--pet-global-scale': globalScale,
        '--pet-glow-intensity': glowIntensity,
        // Surface the level so a small badge can show next to the pet
        // menu button via CSS counter / content. Inline so theming
        // CSS can take it without going through React.
        '--pet-level': String(level),
      } as CSSProperties}
      data-mood={effectiveMood}
      data-facing={effectiveFacing}
      // Drives the 3-part grow-step + settle level-up animation. CSS in
      // pet.css attaches its own keyframe per stage value; the petStore
      // walks 0 → 1 → 2 → 3 → 4 → 0 over LEVEL_STAGE_MS×4 ms when an XP
      // gain crosses the next threshold.
      data-level-stage={levelUpStage > 0 ? String(levelUpStage) : undefined}
    >
      {/* Effekt-Layer (kein Pointer-Event-Durchlass) */}
      <div className="pet-effects" aria-hidden="true">
        <div className="pet-aura" />
        <div className="pet-tool-sparks" />
        <div className="pet-ground-glow" />
      </div>

      {/* Hitbox — only the pet itself is interactive */}
      <div
        className="pet-hitbox"
        title="YHA Pet · /pet for commands"
        aria-label="YHA Pet"
        role="button"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        style={{
          width: PET_W,
          height: PET_H,
          cursor: dragging ? 'grabbing' : 'grab',
          touchAction: 'none',
          userSelect: 'none',
          WebkitUserSelect: 'none',
        }}
      >
        {/* The flip wrapper carries the scaleX so the sprite mirrors but
            the hitbox + effects stay in their original geometry. The
            ref is used by the press-bounce effect to fire one-shot Web
            Animations API keyframes (see usePetIdleBehaviors) — that
            avoids the React re-mount that a key swap would force on the
            sprite, which would briefly flash the pet-sprite-loading state
            on every press. */}
        <div
          ref={flipWrapRef}
          className="pet-flip-wrap"
          // No inline transform — the base scaleX flip is driven by
          // `--pet-flip-x` from the overlay style block, so CSS rules
          // for the level-up grow steps and other state-driven scales
          // can override the wrap's transform without competing with
          // an inline-style declaration (which would otherwise win on
          // specificity and freeze the wrap at scaleX-only).
        >
          <PetSprite mood={effectiveMood} config={spriteConfig} size={PET_W} />
        </div>
      </div>

      {/* Theme-tint SVG filter — dual-tone luminance remap.
          1. Desaturate → pure grayscale.
          2. Contrast bump (slope 1.18) for more separation.
          3. feComponentTransfer linear remap: dark accent → light accent
             so sprite darks use --accent-2, highlights use --accent.
          Alpha channel passed through unchanged (transparent corners stay
          transparent). Inline so filter: url(#yha-pet-tint) resolves. */}
      {themeTint ? (
        <svg
          aria-hidden="true"
          style={{
            position: 'absolute',
            width: 0,
            height: 0,
            overflow: 'hidden',
            pointerEvents: 'none',
          }}
        >
          <defs>
            <filter
              id="yha-pet-tint"
              colorInterpolationFilters="sRGB"
              x="0%"
              y="0%"
              width="100%"
              height="100%"
            >
              <feColorMatrix type="saturate" values="0" result="gray" />
              {/* Slight contrast bump on the grayscale before tinting —
                  pushes mid-tones away from the centre so the dual-tone
                  has more separation (otherwise a low-contrast sprite
                  reads as "all one mid-color" after the remap). */}
              <feComponentTransfer in="gray" result="contrasted">
                <feFuncR type="linear" slope="1.18" intercept="-0.09" />
                <feFuncG type="linear" slope="1.18" intercept="-0.09" />
                <feFuncB type="linear" slope="1.18" intercept="-0.09" />
              </feComponentTransfer>
              <feComponentTransfer in="contrasted" result="tinted">
                {(() => {
                  const bright = parseColor(accentColor) || [0, 0.88, 0.54];
                  const dark = parseColor(accentDark) || [0.02, 0.18, 0.10];
                  return (
                    <>
                      <feFuncR
                        type="linear"
                        slope={(bright[0] - dark[0]).toFixed(4)}
                        intercept={dark[0].toFixed(4)}
                      />
                      <feFuncG
                        type="linear"
                        slope={(bright[1] - dark[1]).toFixed(4)}
                        intercept={dark[1].toFixed(4)}
                      />
                      <feFuncB
                        type="linear"
                        slope={(bright[2] - dark[2]).toFixed(4)}
                        intercept={dark[2].toFixed(4)}
                      />
                      {/* Pass alpha through unchanged — the channel
                          remap above only touches RGB, so transparent
                          pixels would otherwise stay transparent (good)
                          but we set this explicitly so a future tweak
                          to the channel funcs can't accidentally fill
                          alpha in. */}
                      <feFuncA type="identity" />
                    </>
                  );
                })()}
              </feComponentTransfer>
            </filter>
          </defs>
        </svg>
      ) : null}

      {/* XP-Burst-Layer */}
      <div key={rewardBurstId} className="pet-xp-layer" aria-hidden="true">
        {rewardBurstId > 0 ? <RewardBurst /> : null}
      </div>
    </div>,
    document.body,
  );

  return (
    <>
      <PetBehaviors
        key={activeProfileId}
        profile={activeProfile}
        args={schedulerArgs}
      />
      {petPortal}
      <PetDebugOverlay petElRef={petRef} />
    </>
  );
}

/**
 * Renders nothing — exists purely to host the profile-driven scheduler
 * hooks. Mounted by FloatingPet with `key={activeProfileId}` so React
 * fully tears the subtree down and re-runs the hooks when the user picks
 * a different behavior profile.
 */
interface PetBehaviorsProps {
  profile: PetProfile;
  args: UsePetSchedulerArgs;
}
function PetBehaviors({ profile, args }: PetBehaviorsProps): null {
  profile.hooks.useScheduler(args);
  return null;
}
