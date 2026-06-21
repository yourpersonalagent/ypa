// Shared TTS provider picker. Reads the user's preferred provider from
// localStorage (set by the audio-tts-openai prefs entry) and returns an
// instance of the matching `ttsProviders` register entry, or BrowserTTS
// when the pref is 'browser' / unset / unavailable.
//
// Used by both VoiceMode (continuous conversation) and chat-actions
// (per-message "read aloud" button) so flipping the OpenAI toggle
// affects both surfaces.

import { BrowserTTS, type TTSProvider } from './providers.js';
import { registers } from '../../host/keys.js';

export const TTS_PROVIDER_PREF_KEY = 'yha.voice.tts.provider';

export function pickTtsProvider(): TTSProvider {
  let chosen: string | null = null;
  try { chosen = localStorage.getItem(TTS_PROVIDER_PREF_KEY); } catch { /* ignore */ }
  if (chosen && chosen !== 'browser') {
    const entry = registers.ttsProviders.list().find((e) => e.providerId === chosen);
    if (entry) {
      try {
        const p = entry.factory();
        if (p && p.available()) return p as TTSProvider;
      } catch (e) {
        console.warn(`[tts-picker] ttsProvider "${chosen}" factory threw — falling back to BrowserTTS:`, e);
      }
    }
  }
  return new BrowserTTS();
}
