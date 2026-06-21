// audio-tts-openai — registers an OpenAI TTS provider into the
// `ttsProviders` register. VoiceMode reads the active provider id from
// the `voice.tts.provider` pref and falls back to BrowserTTS if the
// chosen entry isn't registered (i.e. this module is disabled).

import host from '../../host/index.js';
import { OpenAITTS } from './OpenAITTS.js';

const MODULE_NAME = 'audio-tts-openai';

const PROVIDER_PREF_KEY = 'yha.voice.tts.provider';
const VOICE_KEY = 'yha.tts.openai.voice';
const MODEL_KEY = 'yha.tts.openai.model';

// Kept in sync with bridge/modules/audio-tts-openai/index.ts ALLOWED_VOICES.
const VOICE_OPTIONS = [
  { id: 'alloy',   label: 'Alloy (neutral)'   },
  { id: 'ash',     label: 'Ash'               },
  { id: 'ballad',  label: 'Ballad'            },
  { id: 'coral',   label: 'Coral'             },
  { id: 'echo',    label: 'Echo'              },
  { id: 'fable',   label: 'Fable'             },
  { id: 'nova',    label: 'Nova'              },
  { id: 'onyx',    label: 'Onyx (deep)'       },
  { id: 'sage',    label: 'Sage'              },
  { id: 'shimmer', label: 'Shimmer'           },
  { id: 'verse',   label: 'Verse'             },
];

const MODEL_OPTIONS = [
  { id: 'gpt-4o-mini-tts', label: 'gpt-4o-mini-tts (fast, cheap)' },
  { id: 'tts-1',           label: 'tts-1 (low latency)'           },
  { id: 'tts-1-hd',        label: 'tts-1-hd (higher quality)'     },
];

export default {
  activate() {
    host.registers.ttsProviders.add(
      {
        id: 'audio-tts-openai.openai',
        providerId: 'openai',
        label: 'OpenAI',
        factory: () => new OpenAITTS(),
        order: 100,
      },
      MODULE_NAME,
    );

    host.registers.prefsEntries.add(
      {
        id: 'audio-tts-openai.use-openai',
        tab: 'system',
        label: 'Use OpenAI for VoiceMode TTS',
        description: 'Routes spoken replies through OpenAI /audio/speech. Requires OPENAI_API_KEY under Providers → OpenAI. Falls back to BrowserTTS on error.',
        type: 'toggle',
        get: () => {
          try { return localStorage.getItem(PROVIDER_PREF_KEY) === 'openai'; }
          catch { return false; }
        },
        set: (v) => {
          try { localStorage.setItem(PROVIDER_PREF_KEY, v ? 'openai' : 'browser'); }
          catch { /* ignore */ }
        },
        order: 200,
      },
      MODULE_NAME,
    );

    host.registers.prefsEntries.add(
      {
        id: 'audio-tts-openai.voice',
        tab: 'system',
        label: 'OpenAI TTS voice',
        description: 'Voice timbre used by OpenAI /audio/speech.',
        type: 'select',
        options: VOICE_OPTIONS,
        get: () => {
          try { return localStorage.getItem(VOICE_KEY) || 'alloy'; }
          catch { return 'alloy'; }
        },
        set: (v) => {
          try { if (typeof v === 'string') localStorage.setItem(VOICE_KEY, v); }
          catch { /* ignore */ }
        },
        order: 210,
      },
      MODULE_NAME,
    );

    host.registers.prefsEntries.add(
      {
        id: 'audio-tts-openai.model',
        tab: 'system',
        label: 'OpenAI TTS model',
        description: 'Model used by OpenAI /audio/speech. gpt-4o-mini-tts is the cheapest.',
        type: 'select',
        options: MODEL_OPTIONS,
        get: () => {
          try { return localStorage.getItem(MODEL_KEY) || 'gpt-4o-mini-tts'; }
          catch { return 'gpt-4o-mini-tts'; }
        },
        set: (v) => {
          try { if (typeof v === 'string') localStorage.setItem(MODEL_KEY, v); }
          catch { /* ignore */ }
        },
        order: 220,
      },
      MODULE_NAME,
    );

    return { name: MODULE_NAME };
  },
  deactivate() {
    host.removeModuleEverywhere(MODULE_NAME);
  },
};
