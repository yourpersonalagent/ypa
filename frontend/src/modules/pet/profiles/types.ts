// PetProfile — pluggable behavior bundle for the floating pet overlay.
//
// A profile is a structured declaration of:
//   • What the pet *does* autonomously (`behaviors[]`) — rendered as
//     visible chips/cards in the profile picker so the user can see what
//     each profile actually triggers without reading source.
//   • Which moods the profile *uses* (`usesMoods[]`) — fed into a per-pet
//     compatibility hint ("this pet has 8/10 moods petV1 uses").
//   • A single `useScheduler` hook that drives motion (the *implementation*
//     of the declared behaviors).
//
// FloatingPet builds one args object once and passes it through
// `<PetBehaviors key={activeProfileId} />`. React requires hooks to be
// called the same way on every render; switching profiles unmounts and
// remounts the scheduler subtree, so different profiles may compose
// different numbers of useEffects internally.

import type { PetMood } from '../store/petStore.js';
import type { UsePetPatrolArgs } from './petV1/usePetPatrol.js';
import type { UsePetIdleBehaviorsArgs } from './petV1/usePetIdleBehaviors.js';

export type PetProfileId = 'petV1' | 'petV3';

/**
 * Scheduler-args shape — the full set of state, refs, and setters
 * FloatingPet supplies to whichever profile is active.
 *
 * Currently a structural superset of petV1's two internal hook args
 * (patrol + idle). When a new profile lands it may consume only a
 * subset; this type stays a superset so FloatingPet always has one
 * args object to construct regardless of the active profile.
 */
export type UsePetSchedulerArgs = UsePetPatrolArgs & UsePetIdleBehaviorsArgs;

/**
 * One autonomous behavior the profile exhibits. The picker renders these
 * as visible chips so the user can see what each profile actually does.
 *
 * Behaviors are NOT triggered individually — the scheduler hook owns the
 * implementation. This is metadata for *display + understanding*.
 */
export interface ProfileBehavior {
  /** Stable id for keying React lists. */
  id: string;
  /** Short noun phrase shown on the chip (e.g. "Wander", "Peek away"). */
  label: string;
  /** One-line user-facing explanation of when/how the behavior fires. */
  summary: string;
}

export interface PetProfile {
  id: PetProfileId;
  /** Display name shown in the dropdown (e.g. "petV3 (fresh)"). */
  label: string;
  /** One-line intro shown beneath the dropdown selection — sets the
   *  profile's overall character ("Calm Codex-aligned companion."). */
  tagline: string;
  /** Structured list of autonomous behaviors. Rendered as a chip/card
   *  cluster in the picker so the user can see at a glance what each
   *  profile triggers without reading source comments. */
  behaviors: ProfileBehavior[];
  /** Moods this profile actively triggers via setLocomotionMood (and
   *  related store actions). Used by the picker to compute a "this pet
   *  has N/M frames the profile needs" compatibility hint. */
  usesMoods: PetMood[];
  hooks: {
    useScheduler: (args: UsePetSchedulerArgs) => void;
  };
}
