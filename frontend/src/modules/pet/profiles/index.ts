// Pet behavior profile registry.
//
// Profiles are looked up by id from petStore.activeProfileId. New profiles
// are added by importing them here and listing them in PET_PROFILES below;
// PetProfileId in types.ts gains the new literal at the same time.

import type { PetProfile, PetProfileId } from './types.js';
import { petV1Profile } from './petV1/index.js';
import { petV3Profile } from './petV3/index.js';

export type { PetProfile, PetProfileId, UsePetSchedulerArgs } from './types.js';

export const PET_PROFILES: Record<PetProfileId, PetProfile | undefined> = {
  petV1: petV1Profile,
  petV3: petV3Profile,
};

// Default profile for new installs + the absolute fallback when neither
// the per-pet override nor the manifest's preferredProfile resolves to
// a valid id. V3 is the Codex-first calm default — V1 is still available
// in the picker for users who want the busier behaviour set.
export const DEFAULT_PROFILE_ID: PetProfileId = 'petV3';

export function getProfile(id: PetProfileId): PetProfile {
  return PET_PROFILES[id] ?? petV1Profile;
}

/** Profiles that are available for selection right now (excludes stubs). */
export function getAvailableProfiles(): PetProfile[] {
  return (Object.values(PET_PROFILES).filter(Boolean) as PetProfile[]);
}
