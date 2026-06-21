// ProfileDetailCard — visualises a PetProfile's structured metadata.
//
// Renders the profile's tagline, its behavior list as chips/cards, and a
// pet-vs-profile fit hint based on `usesMoods` ↔ the active manifest's
// pose set. Used by both PetPrefsSection (the Prefs > Appearance > Pet
// tab) and PetHeaderButton (the in-overlay pet menu) so the picker UI
// is consistent across surfaces.

import { usePetStore } from '../store/petStore.js';
import type { PetProfile } from '../profiles/index.js';
import type { PetMood } from '../store/petStore.js';

interface Props {
  profile: PetProfile;
}

export function ProfileDetailCard({ profile }: Props) {
  // Live pose set from the active pet's manifest. Used to compute the
  // "this pet has N/M of the moods this profile uses" hint.
  const poses = usePetStore((s) => s.currentPet?.manifest?.poses);
  // Manifest's preferred profile, if any. When this profile matches, show
  // a small "preferred for this pet" badge so the user knows the pet was
  // designed for this profile.
  const manifestPreferred = usePetStore((s) => s.currentPet?.manifest?.preferredProfile);
  const isPreferredForActivePet = manifestPreferred === profile.id;
  // Drive the reset-override button. Visible only when the manifest has a
  // preferredProfile, the active profile id differs from it, AND the card
  // being rendered IS that manifest-preferred profile (so the button sits
  // next to the "★ Preferred for this pet" badge — clicking it goes to
  // exactly the profile the badge promises).
  const activeProfileId = usePetStore((s) => s.activeProfileId);
  const resetProfileForActivePet = usePetStore((s) => s.resetProfileForActivePet);
  const showResetButton =
    isPreferredForActivePet
    && manifestPreferred != null
    && activeProfileId !== manifestPreferred;

  const present: PetMood[] = [];
  const missing: PetMood[] = [];
  for (const mood of profile.usesMoods) {
    if (poses?.[mood]) present.push(mood);
    else missing.push(mood);
  }
  const fitTotal = profile.usesMoods.length;
  const fitCovered = present.length;
  const fullFit = fitTotal === 0 || fitCovered === fitTotal;

  return (
    <div className="pet-profile-detail">
      {isPreferredForActivePet && (
        <div className="pet-profile-detail-preferred-row">
          <span
            className="pet-profile-detail-preferred"
            title="The pet's manifest declares this profile as its preferred fit. Loading the pet auto-selects it (unless you've explicitly picked another)."
          >
            ★ Preferred for this pet
          </span>
          {showResetButton && (
            <button
              type="button"
              className="pet-profile-detail-reset"
              onClick={resetProfileForActivePet}
              title="Clear your manual pick for this pet and switch to the manifest's preferred profile."
            >
              ↺ Use preferred
            </button>
          )}
        </div>
      )}
      <p className="pet-profile-detail-tagline">{profile.tagline}</p>

      {profile.behaviors.length > 0 && (
        <ul className="pet-profile-detail-behaviors" aria-label="Profile behaviors">
          {profile.behaviors.map((b) => (
            <li key={b.id} className="pet-profile-behavior" title={b.summary}>
              <span className="pet-profile-behavior-label">{b.label}</span>
              <span className="pet-profile-behavior-summary">{b.summary}</span>
            </li>
          ))}
        </ul>
      )}

      {fitTotal > 0 && (
        <div
          className={'pet-profile-detail-fit' + (fullFit ? ' is-full' : ' is-partial')}
          title={
            fullFit
              ? 'This pet ships every animation this profile uses — no fallback needed.'
              : `Missing animation rows: ${missing.join(', ')}. Profile still runs; missing moods fall back through the pose chain.`
          }
        >
          <span className="pet-profile-detail-fit-label">Pet fit</span>
          <span className="pet-profile-detail-fit-count">
            {fitCovered}/{fitTotal}
          </span>
          {!fullFit && (
            <span className="pet-profile-detail-fit-missing">
              missing: {missing.join(', ')}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
