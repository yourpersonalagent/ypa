// pet — frontend module.
//
// Owns the floating pet overlay, the pet console bubble, the hatch
// wizard UI (HatchModal + FrameNudgeModal + PetGalleryModal), the
// petStore / hatchStore / petConsoleStore zustand stores, and the
// /pet local slash command. The PetHeaderButton (secondary header
// row, order 20) is registered from `activate()` below — when the
// module is disabled, that icon disappears.
//
// Panel slots registered here (consumed via <PanelSlot id="…" />):
//   floating-pet          — <FloatingPet />
//   pet-hatch-modal       — <HatchModal />
//   pet-console-bubble    — <PetConsoleBubble />
//   pet-gallery-modal     — <PetGalleryModal />
//   pet-frame-nudge-modal — <FrameNudgeModal />
//   prefs-appearance-pet  — <PetPrefsSection />

import { lazy } from 'react';
import host from '../../host/index.js';
import { PetHeaderButton } from './components/PetHeaderButton.js';
import { initPetStore, usePetStore } from './store/petStore.js';
import { installPetBubbleRouter } from './petBubbleRouter.js';
import { PetConsoleBubble } from './components/PetConsoleBubble.js';
import { PetGalleryModal, usePetGalleryStore } from './hatch/PetGalleryModal.js';
import { FrameNudgeModal } from './hatch/FrameNudgeModal.js';
import { PetPrefsSection } from './PetPrefsSection.js';
import { tryHandlePetSlash } from './localSlash.js';
import { useHatchStore } from './store/hatchStore.js';
import { installCatalogPush } from './world/catalogPush.js';
import {
  getPetConsoleActions,
  getPetConsoleState,
} from './store/petConsoleStore.js';

const FloatingPet = lazy(() => import('./components/FloatingPet.js').then(m => ({ default: m.FloatingPet })));
const HatchModal  = lazy(() => import('./hatch/HatchModal.js').then(m => ({ default: m.HatchModal })));

const MODULE_NAME = 'pet';

/** localStorage key for the "Voice mode → Pet" opt-in toggle. Default-on so
 *  enabling the pet immediately re-routes voice mode through the pet's
 *  dedicated cheap-lane model. Mirrors the LS_PET_* convention used by
 *  PetQuickChat.tsx / petConsoleStore.ts. */
export const LS_PET_VOICE_ROUTE = 'yha.pet.chat.voiceRoute';

export function isPetVoiceRouteEnabled(): boolean {
  try {
    // Stored as 'on' | 'off'. Anything else (including null/unset) reads as
    // 'on' so a fresh install gets the integrated experience by default.
    return localStorage.getItem(LS_PET_VOICE_ROUTE) !== 'off';
  } catch { return true; }
}

function _readAccentColor(): string {
  try {
    const cs = getComputedStyle(document.documentElement);
    const a = cs.getPropertyValue('--accent').trim();
    if (a) return a;
  } catch { /* SSR / restricted DOM — fall through */ }
  return '#00e08a';
}

export default {
  activate() {
    // A. Lifecycle initialization — idempotent, safe to call here.
    initPetStore();
    installPetBubbleRouter();
    installCatalogPush();

    // B. Header icon button.
    host.registers.headerIconButtons.add(
      {
        id: 'pet.header-icon',
        group: 'secondary',
        order: 20,
        component: PetHeaderButton,
      },
      MODULE_NAME,
    );

    // C. Panel slot registrations — App.tsx renders these via <PanelSlot id="…" />.
    host.registers.panels.add({ id: 'pet.floating',    slotId: 'floating-pet',          component: FloatingPet }, MODULE_NAME);
    host.registers.panels.add({ id: 'pet.hatch',       slotId: 'pet-hatch-modal',       component: HatchModal }, MODULE_NAME);
    host.registers.panels.add({ id: 'pet.console',     slotId: 'pet-console-bubble',    component: PetConsoleBubble }, MODULE_NAME);
    host.registers.panels.add({ id: 'pet.gallery',     slotId: 'pet-gallery-modal',     component: PetGalleryModal }, MODULE_NAME);
    host.registers.panels.add({ id: 'pet.frame-nudge', slotId: 'pet-frame-nudge-modal', component: FrameNudgeModal }, MODULE_NAME);
    host.registers.panels.add({ id: 'pet.prefs',       slotId: 'prefs-appearance-pet',  component: PetPrefsSection }, MODULE_NAME);

    // D'. Voice-mode submit target.
    //
    // When the pet module is loaded AND the user hasn't opted out, voice mode
    // routes finalised user turns into the pet's quick-chat lane instead of
    // the currently open main chat session. The TTS / interrupt / sentence-cut
    // pipeline in VoiceMode.tsx is unchanged — only the answer SOURCE swaps.
    //
    // Disabling the module → entry is removed via removeModuleEverywhere(),
    // and voice mode automatically falls back to its normal #chat-ta path.
    // No extra gating needed at the voice-mode call site.
    host.registers.voiceSubmitTargets.add(
      {
        id: 'pet.voice-target',
        targetId: 'pet',
        enabled: () => {
          if (!isPetVoiceRouteEnabled()) return false;
          // Only route while the pet is actually visible — hidden pet means
          // the user has put it away and would be confused by an invisible
          // speaker answering their voice turn.
          return usePetStore.getState().isVisible;
        },
        speakerName: 'Pet',
        async submit(text) {
          // ask() resolves with { answer } on success, null on error/abort —
          // returning null from submit() lets VoiceMode.tsx fall back to the
          // regular chat path for this one turn.
          const result = await getPetConsoleActions().ask(text);
          if (!result || !result.answer) return { answer: '' };
          const pet = usePetStore.getState().currentPet;
          return {
            answer: result.answer,
            author: {
              name: pet?.name || 'Pet',
              color: _readAccentColor(),
            },
            toolsUsed: result.toolsUsed,
          };
        },
        cancel: () => {
          // Voice-mode interrupt path — aborts the in-flight /v1/pet-console/
          // ask so the user can immediately start their next turn. Safe to
          // call even when no request is pending.
          if (getPetConsoleState().pending) getPetConsoleActions().abortPending();
        },
      },
      MODULE_NAME,
    );

    // D. Chat submit interceptor for /pet slash commands.
    // Kept so typing `/pet show` directly in the chat textarea still
    // works (independent of the `/` palette opening). The palette
    // entries below call the same handlers without round-tripping
    // through the textarea.
    host.registers.chatSubmitInterceptors.add(
      {
        id: 'pet.slash-commands',
        handle(text, _ctx) {
          return tryHandlePetSlash(text);
        },
      },
      MODULE_NAME,
    );

    // E. `/` App Command Palette entries — pet actions live under
    // `module:pet`. Migrated from the pre-modularity `#` Chat Command
    // Picker "local" group (frontend/src/commands.ts), which only made
    // sense for chat tools (#debug, #note, …) — pet actions are local UI.
    host.registers.appCommands.add(
      {
        id: 'module:pet.toggle',
        group: 'module:pet',
        label: 'Toggle Pet',
        keywords: ['pet', 'show', 'hide', 'floating'],
        icon: 'cat',
        state: () => ({ active: usePetStore.getState().isVisible }),
        run: ({ closePalette }) => { usePetStore.getState().toggle(); closePalette(); },
      },
      MODULE_NAME,
    );
    host.registers.appCommands.add(
      {
        id: 'module:pet.show',
        group: 'module:pet',
        label: 'Show Pet',
        keywords: ['pet', 'show'],
        run: ({ closePalette }) => { usePetStore.getState().setVisible(true); closePalette(); },
      },
      MODULE_NAME,
    );
    host.registers.appCommands.add(
      {
        id: 'module:pet.hide',
        group: 'module:pet',
        label: 'Hide Pet',
        keywords: ['pet', 'hide'],
        run: ({ closePalette }) => { usePetStore.getState().setVisible(false); closePalette(); },
      },
      MODULE_NAME,
    );
    host.registers.appCommands.add(
      {
        id: 'module:pet.hatch',
        group: 'module:pet',
        label: 'Open Hatch Wizard',
        keywords: ['pet', 'hatch', 'wizard', 'new'],
        run: ({ closePalette }) => { useHatchStore.getState().openWizard(); closePalette(); },
      },
      MODULE_NAME,
    );
    host.registers.appCommands.add(
      {
        id: 'module:pet.manage',
        group: 'module:pet',
        label: 'Pet Gallery',
        keywords: ['pet', 'gallery', 'manage', 'switch', 'delete'],
        run: ({ closePalette }) => { usePetGalleryStore.getState().openGallery(); closePalette(); },
      },
      MODULE_NAME,
    );
    host.registers.appCommands.add(
      {
        id: 'module:pet.powermove',
        group: 'module:pet',
        label: 'Pet Powermove (demo)',
        keywords: ['pet', 'powermove', 'flex', 'sword'],
        run: ({ closePalette }) => { usePetStore.getState().triggerPowermove(); closePalette(); },
      },
      MODULE_NAME,
    );
    host.registers.appCommands.add(
      {
        id: 'module:pet.fight',
        group: 'module:pet',
        label: 'Pet Fight (demo)',
        keywords: ['pet', 'fight', 'tool', 'demo'],
        run: ({ closePalette }) => { usePetStore.getState().triggerFight(); closePalette(); },
      },
      MODULE_NAME,
    );
    host.registers.appCommands.add(
      {
        id: 'module:pet.xp',
        group: 'module:pet',
        label: 'Pet Reward Burst',
        keywords: ['pet', 'xp', 'reward', 'burst'],
        run: ({ closePalette }) => { usePetStore.getState().triggerRewardBurst(); closePalette(); },
      },
      MODULE_NAME,
    );

    return { name: MODULE_NAME };
  },
  deactivate() {
    host.removeModuleEverywhere(MODULE_NAME);
  },
};
