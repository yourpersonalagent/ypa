// petV1 cadence constants — moved out of petOverlayConstants.ts so they
// live alongside the V1 hooks (usePetPatrol, usePetIdleBehaviors) that
// consume them. Geometry constants that are profile-agnostic (PET_W,
// PET_H, PATROL_GUTTER, CLICK_DRAG_THRESHOLD_PX, SIDE_ZONE_DEPTH,
// JUMP_PEAK_PX, POS_HOME_SNAP_THRESHOLD_PX, RETURN_HOME_MS) stay in
// petOverlayConstants.ts because non-V1 code (FloatingPet shell,
// PetDebugOverlay, usePetPlayground) needs them too.

// ── Patrol motion (used only by usePetPatrol) ─────────────────────────────

/** Minimum X-delta below which we skip the running sprite animation entirely.
 *  Small fidgets (4–32 px) look ridiculous with a full run cycle playing while
 *  the pet barely moves — just let the CSS slide happen without a sprite swap. */
export const MIN_RUN_ANIM_PX = 50;
export const PATROL_DELAY_MIN_MS = 18_000;
export const PATROL_DELAY_RANGE_MS = 36_000;
/** Above this absolute X delta we play a JUMP sequence instead of a CSS
 *  slide. Below the threshold the pet runs (CSS slide + running sprite).
 *  Raised from 60 → 90 px so small fidgets still look like a quick dash
 *  rather than a theatrical leap. */
export const JUMP_DISTANCE_THRESHOLD_PX = 90;
/** Above this absolute X delta we play a 3-hop sequence for extra drama
 *  on full cross-side patrols. Between JUMP_DISTANCE_THRESHOLD_PX and
 *  this value we use the existing 2-hop zigzag. */
export const JUMP_LONG_DISTANCE_PX = 200;
/** Single-hop duration. Each hop lifts off, peaks at JUMP_PEAK_PX, lands.
 *  With the inter-hop gap below the full out-and-back takes
 *  ~JUMP_DURATION_MS × 3 + gap + rest — long enough that both hops read
 *  as discrete jumps but short enough that a mood event mid-patrol can
 *  still take over within ~2 s. */
export const JUMP_DURATION_MS = 720;
/** Brief pause between hop 1 landing and hop 2 lifting off — reads as a
 *  recoil/squat rather than a single 1.4 s jump. Too long and the two
 *  hops feel unrelated; too short and the takeoff steals the landing. */
export const JUMP_INTER_HOP_GAP_MS = 90;
/** Sit-time at the destination before the pet hops home. Long enough to
 *  read as "arrived, looked around, hopped back", short enough that
 *  patrol cycles don't pile up at high activityRate. */
export const JUMP_DESTINATION_REST_MS = 1100;

// ── Side-zone patrol preference ───────────────────────────────────────────

/** Fraction of patrol cycles that move the pet to the *opposite* side zone
 *  and settle it there permanently (until the next cross). */
export const SIDE_CROSS_PROBABILITY = 0.30;
/** Fraction of patrol cycles that are small fidgets within the current zone.
 *  The remaining ~30 % use the original full-range wander through centre. */
export const SIDE_FIDGET_PROBABILITY = 0.40;

// ── Vertical wander on side strips ────────────────────────────────────────

/** Minimum wait between vertical position changes (ms). Scaled by activityRate. */
export const VERTICAL_WANDER_MIN_MS = 40_000;
/** Additional random range on top of the minimum (ms). */
export const VERTICAL_WANDER_RANGE_MS = 80_000;
/** Minimum gap from the top of the viewport when wandering upward (px). */
export const VERTICAL_WANDER_TOP_MARGIN_PX = 80;
/** Exponent for the random-lift distribution — values > 1 bias toward
 *  the home (bottom) position so higher positions are rarer. */
export const VERTICAL_WANDER_EXPONENT = 2.5;

// ── Idle look-around (used only by usePetIdleBehaviors) ───────────────────

export const LOOK_AROUND_INTERVAL_MS = 22_000;
export const LOOK_AROUND_PROBABILITY = 0.25;
export const LOOK_AROUND_DURATION_MIN_MS = 3500;
export const LOOK_AROUND_DURATION_RANGE_MS = 2500;

// ── Fight-side variation ───────────────────────────────────────────────────
// On every triggerFight() the pet picks a new target offset within
// [-max, +max], slides there over the existing 900ms transition, plays
// the fight in place, then returns to home when the mood clears.

export const FIGHT_SIDE_NEAR_FRAC = 0.45;
export const FIGHT_SIDE_FAR_FRAC = 0.85;

// ── Peek-away (the pet "sneaks behind" UI for a bit) ──────────────────────
// Every PEEK_AWAY_INTERVAL_MS the pet rolls a probability and, if it lands,
// shrinks down + drops z-index so chat input / messages start to occlude it.
// Reads as the pet wandering away into the background. Skipped during action
// moods so we don't break a fight animation by hiding the pet mid-swing.

export const PEEK_AWAY_INTERVAL_MS = 32_000;
export const PEEK_AWAY_PROBABILITY = 0.18;
export const PEEK_AWAY_DURATION_MIN_MS = 4500;
export const PEEK_AWAY_DURATION_RANGE_MS = 4500;

// ── Button-hop (the pet jumps onto a random visible button) ───────────────
// Periodically the pet picks a random visible button on the page, slides
// over it, optionally fires a few "press" bounces, then slides home. Reads
// as the companion playfully poking at the UI. Skipped during action moods,
// drag, peek-away. Press hops are purely visual — we never click the
// button.

export const BUTTON_HOP_INTERVAL_MS = 75_000;
export const BUTTON_HOP_PROBABILITY = 0.22;
/** Probability that the hop ends with press-bounces. */
export const BUTTON_PRESS_PROBABILITY = 0.55;
/** Number of press-bounces (inclusive low/high). */
export const BUTTON_PRESS_COUNT_MIN = 2;
export const BUTTON_PRESS_COUNT_MAX = 4;
/** Duration of a single press-bounce keyframe cycle. Keep in sync with
 *  the `pet-button-press` keyframes in pet.css. */
export const BUTTON_PRESS_DURATION_MS = 320;
/** How long the pet sits on the button before pressing or returning. */
export const BUTTON_HOP_HOLD_MS = 700;
/** Slide-out + slide-back transition duration. Matches the existing
 *  `transition: transform 900ms` on .pet-overlay so the slides land
 *  cleanly in time with the wait/press timings below. */
export const BUTTON_HOP_SLIDE_MS = 900;
/** Minimum size of a candidate button so we don't try to land on a
 *  4 × 4 px icon and miss the visual. */
export const BUTTON_HOP_MIN_W = 28;
export const BUTTON_HOP_MIN_H = 22;

// ── Walk-facing tracker ────────────────────────────────────────────────────

/** How long after a movement transition we keep facing locked to the
 *  travel direction. Slightly longer than the slide so the facing
 *  doesn't snap back mid-stride. */
export const WALK_FACING_HOLD_MS = 950;
/** How many px the effective X must shift before we count it as a
 *  movement (filters out tiny resize-driven snaps). */
export const WALK_FACING_MIN_DELTA_PX = 4;
