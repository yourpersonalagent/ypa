import { usePetStore } from './store/petStore.js';
import { useHatchStore } from './store/hatchStore.js';
import { usePetGalleryStore } from './hatch/PetGalleryModal.js';

// UI-only pet commands. None of these reach the bridge as chat turns;
// they trigger purely local UI (toggle, animation demos, hatch wizard,
// gallery modal).
export function tryHandlePetSlash(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed !== '/pet' && !trimmed.startsWith('/pet ')) return false;

  const arg = trimmed.slice(4).trim().toLowerCase();
  const store = usePetStore.getState();
  if (arg === 'powermove' || arg === 'flex') store.triggerPowermove();
  else if (arg === 'fight') store.triggerFight();
  else if (arg === 'xp' || arg === 'reward') store.triggerRewardBurst();
  else if (arg === 'hatch') useHatchStore.getState().openWizard();
  else if (arg === 'manage' || arg === 'gallery') usePetGalleryStore.getState().openGallery();
  else if (arg === 'show') store.setVisible(true);
  else if (arg === 'hide') store.setVisible(false);
  else store.toggle();
  return true;
}
