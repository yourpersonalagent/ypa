// petOverlayConstants — shared, profile-agnostic constants for the
// FloatingPet overlay shell. Behavior-cadence constants used by a single
// profile (patrol timing, peek-away probability, button-hop tuning, etc.)
// live next to that profile's hooks (e.g. profiles/petV1/constants.ts).
// Anything in this file is consumed by FloatingPet itself, the debug
// overlay, the world model, or usePetPlayground — i.e. infrastructure
// that exists regardless of which behavior profile is active.

// ── Pet hitbox dimensions ──────────────────────────────────────────────────

export const PET_W = 136;
export const PET_H = 168;

/** Offset of `.pet-hitbox` inside the `.pet-overlay` element. The overlay
 *  is a 240×240 box (extra padding for effect zones, glow, drop-shadow);
 *  the visible hitbox sits at `left: HITBOX_OFFSET_X, top: HITBOX_OFFSET_Y`
 *  inside it. Keep these values in sync with `.pet-hitbox` in pet.css —
 *  they're the difference between `pos` (overlay top-left) and the
 *  visible-pet top-left, which clampPos uses to keep the hitbox inside
 *  the viewport. */
export const HITBOX_OFFSET_X = 56;
export const HITBOX_OFFSET_Y = 40;
export const RETURN_HOME_MS = 8500;
/** If the persisted X is more than this far from the home X, snap back to
 *  home on init. Catches users whose v1 position survived the key bump via
 *  some other route, or who dragged the pet to the right under the old
 *  defaults and want it auto-corrected. */
export const POS_HOME_SNAP_THRESHOLD_PX = 320;

// ── Patrol geometry (shared by any profile) ───────────────────────────────

/** Minimum X delta for the pet to actually translate — anything smaller
 *  reads as a fidget and is also the minimum sensible patrol corridor
 *  width. Used by petOverlayGeometry.maxPatrolDistance and by petV1's
 *  patrol scheduler as a movement floor. */
export const MIN_PATROL_PX = 40;
export const PATROL_GUTTER = 18; // breathing room from the input's far edge
/** Peak vertical lift of each hop (px above the foot line). Raised from
 *  38 → 65 px for more theatrical, clearly-airborne arcs. The pet now
 *  visibly leaves the chat-input surface. Read by petV1's patrol *and*
 *  by usePetPlayground (keyboard-driven jumps), so it lives here. */
export const JUMP_PEAK_PX = 65;

// ── Click vs drag gate (Phase 1.5 — Pet Console) ─────────────────────────

/** Maximum total Euclidean displacement (px) between pointerdown and
 *  pointerup that still counts as a "click" rather than a "drag". The user
 *  spec calls for ">4 px" → drag, so 4 px inclusive is the click ceiling.
 *  Touchscreens routinely register 1–3 px micro-jitter on a tap; this
 *  threshold lets honest taps through without making longer drags ambiguous. */
export const CLICK_DRAG_THRESHOLD_PX = 4;

// ── Side-zone geometry (shared with PetDebugOverlay) ──────────────────────

/** Width of each preferred side zone (px). The pet body's outer edge sits
 *  ~36 px outside the message column edge (left zone: body left past b.left;
 *  right zone: body right past b.right), keeping it in the 40px margin strip.
 *  Read by petV1's patrol *and* by PetDebugOverlay (visualization), so it
 *  lives here as shared geometry rather than profile-cadence. */
export const SIDE_ZONE_DEPTH = 40;
