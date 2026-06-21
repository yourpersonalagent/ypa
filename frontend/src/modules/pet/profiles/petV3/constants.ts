// petV3 cadence constants.
//
// petV3 is deliberately calmer than petV1: no peek-away, no button-hop,
// no theatrical 3-hop jumps. The whole autonomous repertoire is `wander`
// (occasional walk to a nearby spot, then home) and `perch` (slide over
// near a focused input, return on blur). These numbers tune those two
// behaviors.

// ── Slide / CSS transition ────────────────────────────────────────────────

/** Matches the `transition: transform 900ms` on .pet-overlay. Any time we
 *  change patrolX/patrolY, the visible slide takes this long — V3 waits
 *  out the slide before clearing the locomotion mood. */
export const SLIDE_DURATION_MS = 900;

/** Extra time the running sprite stays up AFTER the CSS slide finishes,
 *  so the walk-cycle animation plays through cleanly and the pet doesn't
 *  snap to idle the instant the transform settles. The full running pose
 *  is on screen for SLIDE_DURATION_MS + LOCOMOTION_TAIL_MS. */
export const LOCOMOTION_TAIL_MS = 250;

/** Minimum |dx| (px) for a slide to count as horizontal motion. Below
 *  this, slideTo will NOT set 'running' and will NOT flip walkFacing —
 *  the run sprite only ever shows when the pet is actually traveling
 *  left or right. */
export const LOCOMOTION_HORIZONTAL_MIN_PX = 2;
/** Minimum |dy| (px) for a slide to count as vertical motion. Used when
 *  there's no significant horizontal component: if the pet has a
 *  `jumping` pose, slideTo picks it instead of `running` so the floating
 *  drift reads as a hop rather than a run-in-place. */
export const LOCOMOTION_VERTICAL_MIN_PX = 4;

// ── Wander cadence ────────────────────────────────────────────────────────

/** Minimum wait between wander rolls (ms). Scaled by activityRate at fire
 *  time, so a chattier session moves the pet a little more often. */
export const WANDER_INTERVAL_MIN_MS = 22_000;
/** Additional random range on top of the minimum (ms). */
export const WANDER_INTERVAL_RANGE_MS = 28_000;
/** Probability that the wander timer actually fires a walk. The rest of
 *  the time it reschedules without moving — keeps the pet from looking
 *  metronomic. */
export const WANDER_PROBABILITY = 0.55;
/** Distance budget for a single horizontal wander hop (px from current
 *  position). Picked from a uniform range so short fidgets and longer
 *  strolls both happen. Sign is randomised. */
export const WANDER_DISTANCE_MIN_PX = 60;
export const WANDER_DISTANCE_MAX_PX = 220;
/** Dwell at the wander destination before sliding home. Long enough that
 *  the move reads as intentional, short enough that the pet doesn't camp
 *  somewhere odd. */
export const WANDER_DWELL_MIN_MS = 1500;
export const WANDER_DWELL_RANGE_MS = 1800;
/** Probability that a wander roll is *vertical* (drift upward) instead of
 *  horizontal. Lower than horizontal because vertical motion across the
 *  chat-input baseline reads stronger and shouldn't dominate the pet's
 *  cadence. The drift is always *up* — patrol y of 0 is the resting line;
 *  negative y lifts above it. After the dwell the pet slides back down. */
export const WANDER_VERTICAL_PROBABILITY = 0.22;
/** Vertical-drift distance range (px upward). Kept smaller than horizontal
 *  range because climbing too high disconnects the pet from the chat
 *  input visually. */
export const WANDER_VERTICAL_MIN_PX = 40;
export const WANDER_VERTICAL_MAX_PX = 140;

// ── Perch (focused-input follower) ────────────────────────────────────────

/** Only perch if the focused input is at least this far (px, X axis) from
 *  the pet's current screen position. Avoids the pet hopping back and
 *  forth a few pixels when the user clicks an input directly under it. */
export const PERCH_MIN_DISTANCE_PX = 160;
/** Debounce — the input must hold focus for this long before V3 acts.
 *  Suppresses the perch on transient focus events (tabbing through a
 *  form, accidental click-then-click-away). */
export const PERCH_FOCUS_DWELL_MS = 800;
/** Where the pet's feet land relative to the focused input:
 *  - x offset is `PERCH_X_OFFSET_PX` to the side of the input edge
 *    (sign chosen so the pet sits on the side closer to its current pos).
 *  - y offset places the feet `PERCH_Y_ABOVE_PX` above the input's top. */
export const PERCH_X_OFFSET_PX = 24;
export const PERCH_Y_ABOVE_PX = 12;
/** Maximum perch dwell. After this, even if focus is still held, the pet
 *  walks home — prevents the pet from getting stuck on a long-form input
 *  the user is typing in for 20 minutes. */
export const PERCH_MAX_DURATION_MS = 90_000;
