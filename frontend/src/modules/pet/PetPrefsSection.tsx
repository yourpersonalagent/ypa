// PetPrefsSection — pet text-reflow prefs row + behavior profile picker,
// extracted from TabSystem.tsx so the pet module can register it as a slot
// fill and TabSystem stays module-agnostic.
//
// Slot id: 'prefs-appearance-pet'
// Registered from: modules/pet/index.ts → host.registers.panels

import { usePetStore } from './store/petStore.js';
import { PET_PROFILES, type PetProfileId } from './profiles/index.js';
import { ProfileDetailCard } from './components/ProfileDetailCard.js';

const PROFILE_ORDER: PetProfileId[] = ['petV1', 'petV3'];

export function PetPrefsSection() {
  const petTextReflow = usePetStore((s) => s.petTextReflow);
  const setPetTextReflow = usePetStore((s) => s.setPetTextReflow);
  // Reflow has no visual effect when the pet is behind the UI — grey it out.
  const petBehindUi = usePetStore((s) => s.behindUi);
  const activeProfileId = usePetStore((s) => s.activeProfileId);
  const setActiveProfileId = usePetStore((s) => s.setActiveProfileId);
  const debugOverlay = usePetStore((s) => s.debugOverlay);
  const setDebugOverlay = usePetStore((s) => s.setDebugOverlay);

  return (
    <>
      <div
        className="prefs-row"
        style={{
          marginTop: 8,
          alignItems: 'center',
          gap: 8,
          opacity: petBehindUi ? 0.45 : 1,
          transition: 'opacity 0.2s',
        }}
      >
        <label style={{ flex: 1, fontSize: '.82rem', color: 'var(--fg-dim)' }}>
          Text wraps around pet
          {petBehindUi && (
            <span style={{ marginLeft: 6, fontSize: '.76rem', opacity: 0.7 }}>
              (needs pet in front)
            </span>
          )}
        </label>
        <button
          className={'prefs-btn' + (petTextReflow && !petBehindUi ? ' is-active' : '')}
          onClick={() => { if (!petBehindUi) setPetTextReflow(!petTextReflow); }}
          title={
            petBehindUi
              ? 'Switch pet to "in front" mode first (Layer toggle above)'
              : 'When the pet is positioned over a chat message, text flows around it (CSS float)'
          }
          style={{ minWidth: 48 }}
          aria-disabled={petBehindUi}
        >
          {petTextReflow ? 'on' : 'off'}
        </button>
      </div>

      <div
        className="prefs-row"
        style={{ marginTop: 8, alignItems: 'flex-start', gap: 6, flexDirection: 'column' }}
      >
        <label
          htmlFor="pet-prefs-profile-select"
          style={{ fontSize: '.82rem', color: 'var(--fg-dim)' }}
        >
          Behavior profile
        </label>
        <select
          id="pet-prefs-profile-select"
          className="prefs-select"
          value={activeProfileId}
          onChange={(e) => {
            const id = e.target.value as PetProfileId;
            if (PET_PROFILES[id]) setActiveProfileId(id);
          }}
          style={{ width: '100%' }}
        >
          {PROFILE_ORDER.map((id) => {
            const profile = PET_PROFILES[id];
            const available = profile != null;
            return (
              <option key={id} value={id} disabled={!available}>
                {available ? profile!.label : `${id} (coming soon)`}
              </option>
            );
          })}
        </select>
        {PET_PROFILES[activeProfileId] && (
          <ProfileDetailCard profile={PET_PROFILES[activeProfileId]!} />
        )}
      </div>

      <div
        className="prefs-row"
        style={{ marginTop: 8, alignItems: 'center', gap: 8 }}
      >
        <label style={{ flex: 1, fontSize: '.82rem', color: 'var(--fg-dim)' }}>
          Debug overlay
          <span style={{ marginLeft: 6, fontSize: '.72rem', opacity: 0.65 }}>
            (hitbox · home zones · nearest button/input)
          </span>
        </label>
        <button
          className={'prefs-btn' + (debugOverlay ? ' is-active' : '')}
          onClick={() => setDebugOverlay(!debugOverlay)}
          title="Show a translucent overlay with the pet's hitbox, settle zones, and what the world model is seeing."
          style={{ minWidth: 48 }}
        >
          {debugOverlay ? 'on' : 'off'}
        </button>
      </div>
    </>
  );
}
