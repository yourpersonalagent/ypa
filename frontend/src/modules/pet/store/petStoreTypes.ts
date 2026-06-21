// petStoreTypes — all exported type/interface definitions and constants
// that were originally inline in petStore.ts. Extracted so petStore.ts
// stays focused on state logic (< 700 lines goal).

import type { PetProfileId } from '../profiles/types.js';

// PetMood — the Codex 9-row canonical vocabulary plus two YHA-extras
// (`reconnecting`, `fighting`) that chat sets directly. YHA-extras have
// fallback chains into the Codex 9 so Codex-imported pets, which only
// ship the 9 canonical rows, render gracefully when chat triggers them.
//
// Direction variants (`runningLeft`, `runningFront`) are intentionally
// absent. The per-pet `flipRun` toggle + CSS scaleX(-1) mirror the
// single right-facing `running` row for left-direction motion. Vertical
// motion can use either `running` or `jumping` — no front-facing variant
// needed in cut 1.
export type PetMood =
  // ── Codex 9 (canonical row vocabulary) ─────────────────────────────────
  | 'idle'
  | 'running'      // locomotion (also: Codex row 1 canonical right walk)
  | 'streaming'    // busy/working
  | 'happy'        // wave / celebrate
  | 'error'        // stumble / failure reaction
  | 'thinking'     // review / meditation
  | 'jumping'      // jump arc (also: locomotion vertical hop)
  | 'powermove'    // big-move action
  | 'xpeffect'     // reward burst
  // ── YHA-extras (chat-triggered, fallback into the Codex 9) ─────────────
  | 'reconnecting' // bridge reconnecting; falls back through chain
  | 'fighting';    // tool-call combat; falls back through chain

export interface SpriteConfig {
  label?: string;
  src: string | null;
  fallback: string | null;
  frames?: { src: string; duration: number }[];
  hotspotAnchor: string;
  effectZone: {
    width: number;
    height: number;
    top: number;
    left: number;
  };
  /**
   * Per-row display-time scale. See ManifestPose.scale.
   * Applied by PetSprite as a CSS transform around the foot anchor so the
   * character stays planted on the ground while its body grows or shrinks.
   */
  scale?: number;
}

export interface PetManifest {
  name: string;
  label: string;
  description: string;
  homeSpot: { x: number | null; y: number };
  spriteFormat: string;
  spriteSize: number;
  poses: Partial<Record<PetMood, SpriteConfig>>;
  voiceLines?: Partial<Record<PetMood, string[]>>;
  xpeffectStyle?: string;
  xpeffectInterval?: { min: number; max: number };
  /** When true, flipRun defaults to true for this pet (frames face left).
   *  Set on Codex pets imported before CODEX_HFLIP was enabled. The user
   *  can still override via the "Flip run dir" button (saved per-pet in
   *  localStorage), which takes precedence over this manifest default. */
  flipRunDefault?: boolean;
  /** Which PetProfile this pet was designed for. Loading the pet
   *  auto-applies this profile (unless the user has explicitly picked
   *  a different one for this pet, which takes precedence). String
   *  typed here to keep the cross-module import surface minimal —
   *  the petStore casts to `PetProfileId` when resolving. */
  preferredProfile?: string;
}

export interface PetIdentity {
  id: string;
  name: string;
  rewardKind: 'stars' | 'coins' | 'fruit' | 'sparks';
  manifest?: PetManifest;
}

/**
 * Which direction the pet's sprite normally faces. The hatched sprites are
 * drawn facing one direction (typically right); flipping is done via CSS
 * `scaleX(-1)` at the FloatingPet layer.
 */
export type PetFacing = 'left' | 'right';

/**
 * Whether to tint the sprite to match the active app theme. Implemented as
 * an inline SVG filter `#yha-pet-tint` (defined in FloatingPet) applied
 * to the sprite <img>. The filter clips the accent flood to the sprite's
 * own alpha channel, so transparent cell-corners stay transparent — no
 * bleed onto the chat background.
 */
export interface PetState {
  currentPet: PetIdentity;
  isVisible: boolean;
  mood: PetMood;
  lastJumpMid: number | null;
  rewardBurstId: number;
  /** Persisted base facing direction the user has chosen for this pet. */
  facing: PetFacing;
  /** When true, ALL sprite directions are visually inverted (scaleX negated).
   *  Use for pets whose sprites were drawn facing left instead of YHA's
   *  expected right-facing convention. Set via the "Mirror sprite" button. */
  mirrorSprite: boolean;
  /** When true, the running direction is flipped for THIS pet only.
   *  Persisted per-pet (key: `yha.pet.flipRun.<petId>`) so each imported
   *  pet can remember its own setting independently. */
  flipRun: boolean;
  /** Toggle for the theme-color tint overlay on the sprite. */
  themeTint: boolean;
  /**
   * One-shot signal: a tool-call triggered fight. When set, FloatingPet
   * picks a random side (left or right of home) and flips facing inward
   * for the duration of the animation, then returns home. Cleared by
   * FloatingPet once the slide-out + animation cycle finishes.
   */
  fightVariantSeed: number;
  /**
   * Vertical offset (px) of the ground-shadow from the foot line. Negative
   * pulls the shadow up (closer to the body), positive pushes it down. The
   * default sits the shadow exactly under the feet; the slider in the pet
   * menu lets the user fine-tune for sprites whose foot anchor isn't quite
   * at the manifest's default.
   */
  shadowOffsetPx: number;
  /**
   * Multiplicative scale applied to the entire pet (sprite + aura + shadow
   * + glow) at the .pet-overlay layer. 1.0 = native (136×168 px); 0.4 = the
   * sprite reads as small chibi; 2.0 = oversized hero. Implemented as a
   * `transform: scale(--pet-global-scale)` on the overlay with a foot-
   * anchored transform-origin (50 % 100 %) so the pet stays planted on the
   * chat input while the size changes. Pure visual — neither the hitbox
   * nor the patrol/fight bounds shift, so the user can shrink without
   * worrying about losing the click target.
   */
  globalScale: number;
  /**
   * 0..1 multiplier on the soft glow behind the pet (`.pet-aura` and the
   * gold drop-shadow on `.pet-sprite-img`). 1 = full glow (default), 0 =
   * aura completely hidden (display: none, not transparency 0 — the user
   * specifically asked for "not even show"). Intermediate values dim the
   * aura proportionally on top of any keyframe-driven opacity animation
   * (streaming pulse, powermove charge). Persisted in localStorage so the
   * user's preference survives reloads.
   */
  glowIntensity: number;
  /**
   * Persistent total XP earned over the pet's lifetime. Each XP burst
   * (the gold-stars-floating-up animation that fires every few minutes
   * of visible screen time) grants a randomised amount; when the running
   * total crosses the next level threshold, `level` increments and we
   * trigger the 3-part grow-shrink animation via `levelUpStage`.
   *
   * Static-step thresholds: lvl N→N+1 needs `N * XP_PER_LEVEL` XP. So
   * level 1 → 2 = 100 XP, 2 → 3 = 200 XP, 3 → 4 = 300 XP, etc. Linear
   * rise was the user's explicit request ("static rise"); the previous
   * suggestion of an exponential curve would have made high levels feel
   * unattainable for a pet that earns XP from passive screen time only.
   */
  xp: number;
  level: number;
  /**
   * Level-up animation stage indicator. 0 = idle (no animation playing).
   * 1, 2, 3 = the three "grow steps" the user asked for — each step
   * scales the pet incrementally larger via CSS class transitions in
   * pet.css. Stage 4 = the snap-back to original size. The store sets
   * the stage in sequence via `triggerLevelUp()`; FloatingPet just
   * reflects the value as a `data-level-stage="N"` attribute and the
   * keyframes do the rest.
   */
  levelUpStage: 0 | 1 | 2 | 3 | 4;
  /**
   * "Sit behind the UI" toggle. When true the .pet-overlay drops to
   * `z-index: 0` AND the body gets a `has-pet-behind-ui` class, which
   * promotes `#root` to its own positive-z stacking context. Net effect:
   * every chat/text/button/image lives ABOVE the pet — the pet still
   * walks/patrols/fights, but it does so in the background plane,
   * occluded by chat content. Drag interaction is intentionally lost
   * in this mode (clicks land on the UI element above), but the menu's
   * Hide/Show toggle still works.
   *
   * Default false so existing users keep the in-front-of-everything
   * behaviour they're used to. Persisted in localStorage.
   */
  behindUi: boolean;
  /**
   * Multiplier on every spontaneous activity the pet does on its own —
   * button-hops, peek-away "wandering off", idle look-around, patrol
   * cadence, AND the probability of fighting tool calls / escalating to
   * powermove on concurrent calls. Range 0..2 in 0.1 steps.
   *
   *   0   = "calm" — pet stays put, never attacks tool calls, never
   *         hops on buttons, never wanders off. The level-up burst
   *         and manual buttons (Power move / Fight / XP burst /
   *         preview chips) still work — those are explicit user
   *         actions, not spontaneous ones.
   *   1   = current behaviour (defaults).
   *   2   = double cadence — probabilities double (clamped at 1.0
   *         per gate so they don't overshoot), patrol interval halves.
   *
   * Implemented by FloatingPet reading the live value through a ref
   * (so changing the slider takes effect immediately without
   * re-creating the long-lived setIntervals) and by petStore's
   * tool-call fight + powermove-escalation listeners reading it
   * through `get()`.
   *
   * Persisted in localStorage as `yha.pet.activityRate`.
   */
  activityRate: number;
  /**
   * When true, the pet's bounding box acts as a CSS float obstacle for
   * chat message text. A sentinel `<div>` is injected at the start of
   * whichever `.msg-bubble` the pet is currently overlapping; the browser
   * layout engine wraps the text around it natively (no Pretext, no JS
   * line-break math). Implemented by `useChatReflow` in `pet/chatReflow.ts`.
   *
   * Default false. Persisted as `yha.pet.textReflow`. Only visible when
   * the pet is in front of the UI (behindUi = false).
   */
  petTextReflow: boolean;
  /** True while the pet is in WASD keyboard-control playground mode. */
  playgroundMode: boolean;
  /**
   * Visual debug overlay toggle. When true, a transparent SVG layer renders
   * box borders for the pet's hitbox, the two settle-zone targets, the
   * message-area bounds, the nearest button/input from the world snapshot,
   * and the currently-focused element. Drawn at high z-index but
   * pointer-events: none so it never intercepts interaction.
   *
   * Persisted under `yha.pet.debugOverlay`. Defaults to false so first-time
   * users don't see the dev-only boxes.
   */
  debugOverlay: boolean;
  /**
   * Active behavior profile id. Selects which `useScheduler` implementation
   * FloatingPet calls — currently `petV1` is the only profile (the original
   * wander/peek/hop scheduler). Future profiles plug in here. Switching
   * profiles remounts FloatingPet's scheduler subtree via a
   * `key={activeProfileId}` guard so the rules of hooks aren't violated
   * by the dispatch.
   *
   * Persisted under `yha.pet.profileId`.
   */
  activeProfileId: PetProfileId;
}

export interface PetActions {
  toggle: () => void;
  setVisible: (v: boolean) => void;
  setMood: (m: PetMood) => void;
  /**
   * Manual mood preview — set the mood now, auto-revert to the derived
   * mood after `durationMs`. Bypasses the `setMood` powermove guard so the
   * Pet Menu's "preview animation" buttons can show every state regardless
   * of what the chat-streaming subscription says. Default duration is
   * 2.6 s (long enough to see a typical 6-frame animation cycle); pass a
   * larger value for slower animations or `Infinity` to lock until the
   * user clicks another preview.
   */
  previewMood: (m: PetMood, durationMs?: number) => void;
  triggerPowermove: () => void;
  triggerFight: () => void;
  triggerRewardBurst: () => void;
  /**
   * Add `n` XP. If the running total crosses the next level threshold,
   * also bumps `level` and fires `triggerLevelUp()`. Caller decides the
   * amount; the existing screen-time XP timer in FloatingPet uses a
   * randomised gain per burst (12–48 XP).
   */
  addXp: (n: number) => void;
  /**
   * Manually fire the 3-part grow-shrink level-up animation. Normally
   * called automatically by `addXp()` when crossing a threshold; the
   * pet menu also exposes a "Trigger level up" debug button so the user
   * can see the animation without grinding XP. Resets to stage 0 after
   * the animation finishes.
   */
  triggerLevelUp: () => void;
  jumpTo: (mid: number) => void;
  loadManifest: (id: string) => Promise<void>;
  installManifest: (manifest: PetManifest) => void;
  setSpriteConfig: (mood: PetMood, config: SpriteConfig) => void;
  setFacing: (f: PetFacing) => void;
  flipFacing: () => void;
  /** Toggle the per-pet running-direction flip. Persisted to localStorage. */
  toggleFlipRun: () => void;
  setThemeTint: (v: boolean) => void;
  setShadowOffsetPx: (px: number) => void;
  setGlobalScale: (s: number) => void;
  setGlowIntensity: (v: number) => void;
  setBehindUi: (v: boolean) => void;
  setActivityRate: (v: number) => void;
  setPetTextReflow: (v: boolean) => void;
  setPlaygroundMode: (v: boolean) => void;
  setActiveProfileId: (id: PetProfileId) => void;
  /** Clear the per-pet profile override for the currently active pet and
   *  re-resolve from the manifest's preferredProfile (or the global
   *  default). Drives the "Reset to manifest preference" button. */
  resetProfileForActivePet: () => void;
  setDebugOverlay: (v: boolean) => void;
}

export type PetStore = PetState & PetActions;

/** XP threshold step. Linear: lvl N → N+1 needs `N * XP_PER_LEVEL` XP.
 *  100 was picked so a pet earning ~24 XP/burst at the default 5-min
 *  burst cadence levels every ~20 minutes of screen time at lvl 1 — fast
 *  enough to be visible early but slow enough that lvl 10 (= 5500 total
 *  XP) feels meaningful. */
export const XP_PER_LEVEL = 100;
/** Per-burst XP gain range — randomised within these bounds at each
 *  reward-burst tick. */
export const XP_GAIN_MIN = 12;
export const XP_GAIN_MAX = 48;
/** Each level-up stage hold, in ms. The 3-stage grow-step + 1 shrink-back
 *  animation lasts 4 × this — keep it short enough that simultaneous tool
 *  calls / streams don't collide too long, but long enough that each step
 *  visibly registers. */
export const LEVEL_STAGE_MS = 380;
/** Range the slider exposes for shadow tuning. Wider than typical needs so
 *  oddly anchored hand-edited pets can still be made to look right. */
export const SHADOW_OFFSET_MIN_PX = -40;
export const SHADOW_OFFSET_MAX_PX = 60;
export const SHADOW_OFFSET_DEFAULT_PX = -8; // tighter than 0 — most sprites' "feet"
                                            // sit a few px above the cell bottom.

/** Range the global-scale slider exposes. We allow shrinking down to 40 %
 *  (chibi mode — the pet is tiny but still hit-testable) and growth up to
 *  220 % (cinema mode — eats screen real estate but works on big monitors).
 *  Step is 0.05 so the slider feels precise without producing fractional
 *  pixel artefacts during animations. */
export const GLOBAL_SCALE_MIN = 0.4;
export const GLOBAL_SCALE_MAX = 2.2;
export const GLOBAL_SCALE_STEP = 0.05;
export const GLOBAL_SCALE_DEFAULT = 1.0;

/** Range the glow-intensity slider exposes. 0 fully hides the aura
 *  (display: none — the user asked for "not even show", not "transparency
 *  0"). 1 is the default look. Step 0.05 matches the global-scale feel. */
export const GLOW_INTENSITY_MIN = 0;
export const GLOW_INTENSITY_MAX = 1;
export const GLOW_INTENSITY_STEP = 0.05;
export const GLOW_INTENSITY_DEFAULT = 1.0;

/** Range the activity-rate slider exposes — controls how often the pet
 *  does spontaneous things on its own (button-hops, peek-away, patrol,
 *  tool-call fights, powermove escalation on concurrent tools). 0
 *  fully disables spontaneous behaviour (manual triggers still work);
 *  1 is the original cadence; 2 is the "hyperactive" upper bound where
 *  probabilities double and patrol/peek intervals halve.
 *
 *  Step 0.1 was picked because perceptually 10 % cadence shifts are
 *  meaningful; finer steps would feel imprecise on the slider. */
export const ACTIVITY_RATE_MIN = 0;
export const ACTIVITY_RATE_MAX = 2;
export const ACTIVITY_RATE_STEP = 0.1;
export const ACTIVITY_RATE_DEFAULT = 1.0;

/** XP threshold to advance from the given level to the next. Static rise
 *  per the user's spec ("for each lvl more xp to reach next lvl - static
 *  rise"). Lvl 1→2 = 100, 2→3 = 200, 3→4 = 300, etc. */
export function xpForNextLevel(level: number): number {
  return Math.max(1, level) * XP_PER_LEVEL;
}
