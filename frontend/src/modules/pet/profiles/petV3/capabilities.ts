// petV3 sprite-vocabulary capabilities.
//
// After the Codex-first vocabulary cleanup there's only one locomotion
// pose (`running`) and one greet pose (`happy`) in the canonical 9-row
// vocabulary. Left-direction motion is handled by the per-pet `flipRun`
// toggle + CSS scaleX(-1) — no `runningLeft`/`runningFront` variants
// exist anymore.
//
// This module is the single source of truth for "what can this pet do?".
// Read once at scheduler-mount time and cached on the manifest reference.

import type { PetMood } from '../../store/petStore.js';

/** Structural sniff of a pet manifest — anything with a `poses` map of
 *  the petStore.PetMood vocabulary is acceptable. Stays decoupled from
 *  the stricter hatch-time `YhaPetManifest` shape so the petStore's
 *  loosely-typed `PetManifest` can flow through unchanged. */
type ManifestLike = {
  poses?: Partial<Record<PetMood, { frames?: { src: string }[] } | undefined>>;
};

export interface PetV3Capabilities {
  /** True when the manifest has the canonical horizontal locomotion pose.
   *  V3 won't fire wander if this is false (the pet has no walk cycle). */
  hasRunning: boolean;
  /** True when the manifest has the `jumping` pose. Used by slideTo to
   *  pick the jump sprite for pure-vertical slides (lift / drop) so the
   *  pet doesn't play the horizontal run cycle while floating up. */
  hasJumping: boolean;
  /** True if a dedicated wave/greet pose exists (`happy` row in the
   *  Codex 9). V3 doesn't initiate `happy` itself (FloatingPet's mood
   *  system does), but can use it for the perch-arrival reaction in a
   *  later cut. */
  hasWave: boolean;
}

export function detectCapabilities(manifest: ManifestLike | null | undefined): PetV3Capabilities {
  const poses = manifest?.poses ?? {};
  const has = (m: PetMood): boolean => !!poses[m]?.frames?.length;
  return {
    hasRunning: has('running'),
    hasJumping: has('jumping'),
    hasWave: has('happy'),
  };
}
