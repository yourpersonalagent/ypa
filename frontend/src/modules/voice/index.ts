// voice — placeholder frontend module.
//
// Files moved from frontend/src/voice/ wholesale:
//   VoiceMode.tsx   — continuous-listening overlay (state machine + UI)
//   voice-bg.ts     — animated background blob renderer
//   providers.ts    — BrowserSTT / BrowserTTS / VADProvider abstractions
//   lang-detect.ts  — text-to-locale heuristic (used by chat-actions
//                     to pick a TTS voice for assistant playback)
//
// The two external callers were updated to point at the new path:
//   frontend/src/App.tsx                 imports VoiceMode
//   frontend/src/chat/chat-actions.ts    imports detectLang + pickVoice
//
// activate() is a no-op today because the voice surface (the overlay
// trigger button + the auto-TTS hook) is still wired statically inside
// App.tsx + chat-actions.ts. Introducing a chatBarLeftButtons register
// entry to make the overlay trigger module-owned belongs to a later
// pass — see YHA-modular-status.md §"Phase 1 — voice".
//
// Disabling the module (by removing this file's enabled-modules.ts
// entry) is a no-op today; once the slot integration lands, disabling
// will hide the chat-bar voice button and the auto-TTS hook will
// no-op via lang-detect being absent.

import host from '../../host/index.js';
import { VoiceMode } from './VoiceMode.js';
import { VoiceGroupButtons } from './VoiceGroupButtons.js';

const MODULE_NAME = 'voice';

export interface VoiceApi {
  /** Module name, for diagnostics. */
  name: string;
}

export default {
  activate(): VoiceApi {
    host.registers.panels.add({
      id: 'voice.overlay',
      slotId: 'voice-mode-overlay',
      component: VoiceMode,
    }, MODULE_NAME);

    host.registers.chatBarButtons.add({
      id: 'voice.chat-bar',
      side: 'left',
      group: 'voice',
      title: 'Voice',
      component: VoiceGroupButtons,
    }, MODULE_NAME);

    // Palette entries so voice controls work on layouts that hide the
    // chat bar (Zen, Messenger). The mic button only renders when the
    // browser exposes SpeechRecognition; click() is a no-op otherwise.
    host.registers.appCommands.add({
      id: 'chat.voice.mic',
      group: 'chat',
      label: 'Voice Input (Mic)',
      icon: 'mic',
      keywords: ['chat', 'voice', 'mic', 'speech', 'dictate', 'record'],
      run: ({ closePalette }) => {
        document.getElementById('chat-mic')?.click();
        closePalette();
      },
    }, MODULE_NAME);

    host.registers.appCommands.add({
      id: 'chat.voice.mode',
      group: 'chat',
      label: 'Open Voice Mode',
      icon: 'audio-lines',
      keywords: ['chat', 'voice', 'mode', 'continuous', 'conversation'],
      run: ({ closePalette }) => {
        document.getElementById('chat-voicemode')?.click();
        closePalette();
      },
    }, MODULE_NAME);

    return { name: MODULE_NAME };
  },
  deactivate() {
    host.removeModuleEverywhere(MODULE_NAME);
  },
};
