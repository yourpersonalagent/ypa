// VoiceGroupButtons — chat-bar voice group rendered by the voice module slot.
//
// Replaces the hardcoded <span className="voice-group"> block in ChatView.tsx.
// When the voice module is disabled this component is unregistered and the
// buttons disappear cleanly without any change to ChatView.

import { useState, useCallback, useRef } from 'react';
import { bus } from '../../state.js';
import { useRegisterList } from '../../host/useRegisterList.js';
import { registers } from '../../host/keys.js';

// Minimal local type — matches the SpeechRecognitionInstance shape in providers.ts
// but scoped to what this component actually uses.
interface SRInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onresult: ((ev: { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  start(): void;
  stop(): void;
}

const w = window as unknown as {
  SpeechRecognition?: new () => SRInstance;
  webkitSpeechRecognition?: new () => SRInstance;
};
const SpeechRecognitionCtor = w.SpeechRecognition || w.webkitSpeechRecognition;

export function VoiceGroupButtons() {
  const [recording, setRecording] = useState(false);
  const recogRef = useRef<SRInstance | null>(null);

  const handleMicClick = useCallback(() => {
    if (recording) {
      recogRef.current?.stop();
      return;
    }
    if (!SpeechRecognitionCtor) return;
    const recog = new SpeechRecognitionCtor();
    recog.lang = navigator.language || 'en-US';
    recog.continuous = false;
    recog.interimResults = false;
    recog.onstart = () => { setRecording(true); };
    recog.onend = () => { setRecording(false); };
    recog.onerror = () => { setRecording(false); };
    recog.onresult = (ev) => {
      const transcript = ev.results[0]?.[0]?.transcript || '';
      if (!transcript) return;
      const visibleTa = document.getElementById('chat-ta') as HTMLTextAreaElement | null;
      const cur = visibleTa?.value ?? '';
      const next = cur + (cur && !cur.endsWith(' ') ? ' ' : '') + transcript;
      bus.emit('chat:set-input', next);
    };
    recogRef.current = recog;
    recog.start();
  }, [recording]);

  // Voice-mode submit targets — when one is enabled (today: pet module with its
  // opt-in toggle on), voice mode should open as the small pet-anchored panel
  // instead of the full-screen overlay. Mirrors VoiceMode._pickSubmitTarget()
  // so both call sites agree on what "the pet wants the turn" means.
  const submitTargets = useRegisterList(registers.voiceSubmitTargets);
  const handleVoiceModeClick = useCallback(() => {
    const minimized = submitTargets.some((t) => !t.enabled || t.enabled());
    window.dispatchEvent(new CustomEvent('yha:voice-mode-open', { detail: { minimized } }));
  }, [submitTargets]);

  return (
    <span className="voice-group" title="Voice">
      {SpeechRecognitionCtor && (
        <button
          id="chat-mic"
          className={`chat-bar-btn mic-btn${recording ? ' mic-active' : ''}`}
          title={recording ? 'Stop recording' : 'Voice input (Chrome)'}
          onClick={handleMicClick}
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"
            fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z" />
            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
            <line x1="12" x2="12" y1="19" y2="22" />
          </svg>
        </button>
      )}
      <button
        id="chat-voicemode"
        className="chat-bar-btn voice-mode-btn"
        title="Voice mode (continuous conversation) [Alt+V]"
        onClick={handleVoiceModeClick}
      >
        <svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24"
          fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 12a7 7 0 0 1 14 0" />
          <path d="M8 14a4 4 0 0 1 8 0" />
          <path d="M11 16a1 1 0 0 1 2 0" />
        </svg>
      </button>
    </span>
  );
}
