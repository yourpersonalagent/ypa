// VoiceMode — continuous-listening conversation overlay.
// Replaces voice/voice-mode.ts (deleted). State machine, STT/TTS/VAD providers,
// echo suppression, hard-interrupt keywords, sentence-cut speech queueing — all
// preserved. UI now renders via JSX + portals; state machine lives in React refs
// since it changes much faster than React re-render cadence.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BrowserSTT, VADProvider, type STTProvider, type TTSProvider } from './providers.js';
import { pickTtsProvider } from './tts-picker.js';
import { mountVoiceBg, type VoiceBgHandle } from './voice-bg.js';
import { detectLang, langToBCP47 } from './lang-detect.js';
import { useAppStore, getAppState } from '../../stores/index.js';
import { runStatusAnim } from '../../chat/chat-ui.js';
import { resolveAvatarColor } from '../../color-themes-config.js';
import { useRegisterList } from '../../host/useRegisterList.js';
import { registers } from '../../host/keys.js';
import type { VoiceSubmitTarget } from '../../host/keys.js';

type VoiceState = 'idle' | 'listening' | 'thinking' | 'speaking';
/** Voice-mode UI variants:
 *  - 'full'      = full-screen modal with backdrop blur (default)
 *  - 'minimized' = small panel anchored near the pet, no backdrop. Used when
 *                  the pet module is the active voice target and the user
 *                  clicks the pet to start a voice conversation. */
type VoiceMode = 'full' | 'minimized';

const SILENCE_MS = 1200;
const MIN_USER_CHARS = 2;

// ── Pet-anchored placement (only used in `mode === 'minimized'`) ───────────
// Mirrors PetConsoleBubble's positioning convention so both pet popovers feel
// like a coherent surface that follows the pet's patrol/jump animations.
const MINI_PANEL_W = 220;
const MINI_PANEL_H = 220;
const MINI_GUTTER  = 12;
const MINI_VP_PAD  = 8;
const DEFAULT_USER_COLOR = '#ff9a3d';
const DEFAULT_AI_COLOR = '#00e08a';
const THINKING_COLOR = '#cfd6df';

const ECHO_WINDOW_MS = 8000;
const ECHO_OVERLAP_RATIO = 0.45;
const ECHO_MIN_INTERRUPT_WORDS = 2;
const ECHO_MIN_INTERRUPT_WORDS_WHILE_SPEAKING = 2;

const INTERRUPT_KEYWORDS = new Set<string>([
  'stop', 'halt', 'wait', 'pause', 'cancel', 'enough',
  'nein', 'warte', 'warten', 'schluss', 'aufhören', 'aufhoeren',
  'arrête', 'arrete', 'attends', 'stopp',
  'para', 'espera', 'alto',
  'aspetta', 'fermati',
]);

interface AuthorInfo { name: string; color: string }
interface StreamTextDetail { mid: number; text: string; done: boolean; flush?: boolean; author: AuthorInfo | null }

function tokenize(s: string): string[] {
  return s.toLowerCase().split(/[^\p{L}\p{N}']+/u).filter((w) => w.length >= 2);
}

function countWords(s: string): number { return tokenize(s).length; }

function hasInterruptKeyword(transcript: string): boolean {
  for (const tok of tokenize(transcript)) if (INTERRUPT_KEYWORDS.has(tok)) return true;
  return false;
}

function sentenceCuts(s: string): number[] {
  const cuts: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === '.' || c === '!' || c === '?' || c === '\n') {
      const next = s[i + 1];
      if (c === '.' && next && /[0-9.]/.test(next)) continue;
      cuts.push(i + 1);
    }
  }
  return cuts;
}

// ── Imperative open API for callers (chat.ts wires the voice-mode button) ─

export interface OpenVoiceModeDetail {
  /** Open already-minimized. The pet click handler uses this so the voice
   *  modal appears next to the pet without the full-screen overlay. Falsy /
   *  omitted = open in full mode (default for the chat-bar voice button). */
  minimized?: boolean;
}

export function openVoiceMode(detail: OpenVoiceModeDetail = {}): void {
  window.dispatchEvent(new CustomEvent('yha:voice-mode-open', { detail }));
}

// ── Component ──────────────────────────────────────────────────────────────

const DEFAULT_HINT = 'Speak naturally. Pause to send. Speak again to interrupt. Click panel to mute.';
const MUTED_HINT = 'Microphone muted. Click to unmute.';

export function VoiceMode() {
  const [active, setActive] = useState(false);
  const [mode, setMode] = useState<VoiceMode>('full');
  /** In minimized mode the user can collapse the panel away with a pet-click
   *  without ending voice mode. Voice keeps listening + speaking; only the
   *  rendered UI hides (CSS rule on .voice-modal[data-collapsed='1']). */
  const [collapsed, setCollapsed] = useState(false);
  /** Live pet-anchored placement in minimized mode. Null = no pet visible or
   *  full mode — panel falls back to CSS defaults (bottom-right corner). */
  const [petAnchor, setPetAnchor] = useState<{ left: number; top: number } | null>(null);
  const [state, setState] = useState<VoiceState>('idle');
  const [transcript, setTranscript] = useState(''); // for re-render only
  const [muted, setMuted] = useState(false);
  const [hint, setHint] = useState(DEFAULT_HINT);

  // Voice-mode submit targets — registered by modules (pet, future agents…).
  // When non-empty AND the first enabled target gates true, that target
  // handles the user turn instead of the chat-input fallback path. The
  // pet module's entry is gated on (a) the user's opt-in toggle and (b)
  // pet visibility — see modules/pet/index.ts.
  const submitTargets = useRegisterList(registers.voiceSubmitTargets);
  /** Mirror onto a ref so submit() / interruptModel() can read without
   *  triggering re-renders. Re-points on every register change. */
  const submitTargetsRef = useRef(submitTargets);
  useEffect(() => { submitTargetsRef.current = submitTargets; }, [submitTargets]);
  /** Synthetic mid counter for the in-component dispatch of yha-stream-text
   *  events when a submit target returns an answer. Negative values stay out
   *  of the normal chat mid range. */
  const syntheticMidRef = useRef(-1);
  /** The currently active target for the in-flight turn, if any. Used by
   *  interruptModel() so a hard-interrupt while a pet answer is being read
   *  also aborts the underlying request (not just the TTS). */
  const activeTargetRef = useRef<VoiceSubmitTarget | null>(null);

  // Refs: rapidly-changing state that doesn't need re-render
  const sttRef = useRef<STTProvider | null>(null);
  const ttsRef = useRef<TTSProvider | null>(null);
  const vadRef = useRef<VADProvider | null>(null);
  const bgRef = useRef<VoiceBgHandle | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const transcriptElRef = useRef<HTMLDivElement | null>(null);
  const stateRef = useRef<VoiceState>('idle');
  const mutedRef = useRef(false);
  const finalRef = useRef('');
  const interimRef = useRef('');
  const silenceTimerRef = useRef<number>(0);
  const currentLangRef = useRef('en');
  const spokenByMidRef = useRef(new Map<number, number>());
  const authorByMidRef = useRef(new Map<number, AuthorInfo | null>());
  const currentMidRef = useRef<number | null>(null);
  const recentTtsRef = useRef<{ tok: string; t: number }[]>([]);
  const thinkingAnimRef = useRef<{ stop: () => void } | null>(null);
  // True between submit() and the done:true stream event. While true, we hold
  // state in 'speaking' even when the TTS queue empties between sentence
  // chunks (typical mid-tool-call gap) so the echo filter keeps suppressing
  // speaker bleed-through and STT can't accidentally submit a new turn.
  const streamActiveRef = useRef(false);

  // ── Rendering helpers ────────────────────────────────────────────────────
  const renderTranscript = useCallback(() => {
    setTranscript(stateRef.current === 'thinking'
      ? '' // owned by thinking anim
      : (finalRef.current + (interimRef.current ? ' ' + interimRef.current : '')).trim(),
    );
  }, []);

  const stopThinkingAnim = useCallback(() => {
    if (thinkingAnimRef.current) {
      thinkingAnimRef.current.stop();
      thinkingAnimRef.current = null;
    }
  }, []);

  const startThinkingAnim = useCallback(() => {
    stopThinkingAnim();
    if (transcriptElRef.current) {
      thinkingAnimRef.current = runStatusAnim(transcriptElRef.current);
    }
  }, [stopThinkingAnim]);

  const setStateBoth = useCallback((s: VoiceState) => {
    const prev = stateRef.current;
    stateRef.current = s;
    setState(s);
    if (s === 'thinking') {
      startThinkingAnim();
    } else {
      stopThinkingAnim();
      // Wipe leftover anim text + leftover speaker echo
      if (prev === 'thinking' && transcriptElRef.current) transcriptElRef.current.innerHTML = '';
      if (prev === 'speaking' && s === 'listening') {
        finalRef.current = '';
        interimRef.current = '';
        if (silenceTimerRef.current) {
          clearTimeout(silenceTimerRef.current);
          silenceTimerRef.current = 0;
        }
      }
      renderTranscript();
    }
  }, [renderTranscript, startThinkingAnim, stopThinkingAnim]);

  // ── Echo detection ───────────────────────────────────────────────────────
  function isLikelyEcho(text: string): boolean {
    const tokens = tokenize(text);
    if (tokens.length === 0) return true;
    const liveAll = ttsRef.current?.isSpeaking() ?? false;
    const cutoff = performance.now() - ECHO_WINDOW_MS;
    const recent = new Set(recentTtsRef.current.filter((e) => liveAll || e.t >= cutoff).map((e) => e.tok));
    if (recent.size === 0) return false;
    let hits = 0;
    for (const t of tokens) if (recent.has(t)) hits++;
    const ratio = hits / tokens.length;
    if (tokens.length <= 3 && ratio >= 0.34) return true;
    return ratio >= ECHO_OVERLAP_RATIO;
  }

  function rememberTTS(text: string): void {
    const now = performance.now();
    const cutoff = now - ECHO_WINDOW_MS * 3;
    recentTtsRef.current = recentTtsRef.current.filter((e) => e.t >= cutoff);
    for (const tok of tokenize(text)) recentTtsRef.current.push({ tok, t: now });
  }

  // ── Submit user turn ─────────────────────────────────────────────────────
  // Two paths:
  //   1. A registered VoiceSubmitTarget (pet module, future agents) gates
  //      true → call `target.submit()`, then synthesise a single
  //      `yha-stream-text` event with done:true so the existing sentence-
  //      cut / echo-filter / interrupt pipeline speaks the answer.
  //   2. No target enabled → legacy path: fill `#chat-ta` + click
  //      `#chat-send`, let the real chat stream fire its own events.
  function submit(text: string): void {
    const target = _pickSubmitTarget();
    streamActiveRef.current = true;
    setStateBoth('thinking');
    if (target) {
      _submitViaTarget(text, target);
    } else {
      const ta = document.getElementById('chat-ta') as HTMLTextAreaElement | null;
      const sendBtn = document.getElementById('chat-send') as HTMLButtonElement | null;
      if (!ta || !sendBtn) {
        setHint('Chat input not found');
        streamActiveRef.current = false;
        setStateBoth('listening');
        return;
      }
      ta.value = text;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      sendBtn.click();
    }
  }

  function _pickSubmitTarget(): VoiceSubmitTarget | null {
    for (const entry of submitTargetsRef.current) {
      if (!entry.enabled || entry.enabled()) return entry;
    }
    return null;
  }

  function _submitViaTarget(text: string, target: VoiceSubmitTarget): void {
    activeTargetRef.current = target;
    const mid = syntheticMidRef.current--;
    target
      .submit(text, { lang: currentLangRef.current })
      .then((result) => {
        // Aborted between issuing the call and the resolve? Skip — the
        // interrupt path already returned us to 'listening'. Same for
        // closed-modal-mid-flight.
        if (activeTargetRef.current !== target) return;
        if (stateRef.current === 'idle') return;
        activeTargetRef.current = null;
        const answer = (result?.answer ?? '').trim();
        if (!answer) {
          // No content — pretend the turn ended quietly so we don't lock the
          // user out of the next listen cycle.
          streamActiveRef.current = false;
          setStateBoth('listening');
          return;
        }
        const author = result.author
          ?? (target.speakerName
              ? { name: target.speakerName, color: target.speakerColor || '' }
              : null);
        window.dispatchEvent(new CustomEvent('yha-stream-text', {
          detail: { mid, text: answer, done: true, flush: true, author },
        }));
      })
      .catch(() => {
        if (activeTargetRef.current !== target) return;
        activeTargetRef.current = null;
        streamActiveRef.current = false;
        setStateBoth('listening');
      });
  }

  function closeUserTurn(): void {
    if (stateRef.current !== 'listening') return;
    const text = (finalRef.current + ' ' + interimRef.current).trim();
    if (text.length < MIN_USER_CHARS) return;
    finalRef.current = '';
    interimRef.current = '';
    renderTranscript();
    submit(text);
  }

  function armSilenceTimer(): void {
    if (silenceTimerRef.current) clearTimeout(silenceTimerRef.current);
    silenceTimerRef.current = window.setTimeout(closeUserTurn, SILENCE_MS);
  }

  // ── Interrupt model ─────────────────────────────────────────────────────
  function interruptModel(): void {
    ttsRef.current?.cancel();
    // Two stop paths, one per submit-target type.
    //   • Active VoiceSubmitTarget → call its cancel() (pet target aborts the
    //     in-flight /v1/pet-console/ask via petConsoleStore.abortPending()).
    //   • Legacy chat path → click the existing #chat-stop button if visible.
    const target = activeTargetRef.current;
    if (target) {
      try { target.cancel?.(); } catch { /* non-fatal */ }
      activeTargetRef.current = null;
    } else {
      const stopBtn = document.getElementById('chat-stop') as HTMLButtonElement | null;
      if (stopBtn && stopBtn.style.display !== 'none') stopBtn.click();
    }
    streamActiveRef.current = false;
    setStateBoth('listening');
  }

  // ── Speech of model output (sentence-cut queue) ─────────────────────────
  const speakWithLang = useCallback((text: string) => {
    const clean = text
      .replace(/```[\s\S]*?```/g, ' (code block) ')
      .replace(/`([^`]+)`/g, '$1')
      .replace(/[*_#>]/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!clean || !ttsRef.current) return;
    const lang = detectLang(clean, currentLangRef.current);
    ttsRef.current.speak(clean, {
      lang,
      onStart: () => rememberTTS(clean),
      onEnd: () => {
        // Hold 'speaking' while the stream is still active — keeps the echo
        // filter on so the gap between TTS chunks (e.g. across a tool call)
        // doesn't get treated as user speech.
        if (streamActiveRef.current) return;
        if (!ttsRef.current?.isSpeaking() && stateRef.current === 'speaking') setStateBoth('listening');
      },
    });
  }, [setStateBoth]);

  // ── Stream-text event handler (model token stream) ──────────────────────
  // Three phases the stream signals to us:
  //   1. incremental delta  → speak only on sentence cuts (avoids choppy TTS)
  //   2. flush (pre-tool-call) → speak whatever's unspoken, even partial
  //   3. done (end of stream) → speak tail + release the speaking-hold
  const onStreamText = useCallback((e: Event) => {
    if (!stateRef.current || stateRef.current === 'idle') return;
    const detail = (e as CustomEvent<StreamTextDetail>).detail;
    const { mid, text, done, flush, author } = detail;
    currentMidRef.current = mid;
    if (author && (author.color || author.name)) authorByMidRef.current.set(mid, author);
    const already = spokenByMidRef.current.get(mid) ?? 0;

    if (flush || done) {
      // Speak the entire unspoken tail regardless of sentence cuts. This is
      // the boundary moment where we can no longer afford to wait for the
      // next period — either a tool call is about to take over the stream,
      // or the stream is finishing.
      const tail = text.slice(already).trim();
      if (tail) { speakWithLang(tail); setStateBoth('speaking'); }
      spokenByMidRef.current.set(mid, text.length);
      if (done) {
        streamActiveRef.current = false;
        if (!ttsRef.current?.isSpeaking() && stateRef.current === 'speaking') setStateBoth('listening');
      }
      return;
    }

    // Incremental: speak only complete sentences. The unspoken trailing
    // fragment will be picked up by the next flush or done event.
    const newTail = text.slice(already);
    const cuts = sentenceCuts(newTail);
    if (cuts.length) {
      const lastCut = cuts[cuts.length - 1]!;
      const speakable = newTail.slice(0, lastCut).trim();
      if (speakable) {
        speakWithLang(speakable);
        spokenByMidRef.current.set(mid, already + lastCut);
        setStateBoth('speaking');
      }
    }
  }, [speakWithLang, setStateBoth]);

  // ── Mute toggle ──────────────────────────────────────────────────────────
  // Mute keeps STT/VAD running but discards their callbacks. The model's
  // stream + TTS keep flowing, so the conversation isn't broken — the user
  // just stops being heard until they click again.
  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    if (next) {
      // Drop any in-flight transcript so we don't auto-submit on unmute.
      finalRef.current = '';
      interimRef.current = '';
      if (silenceTimerRef.current) {
        clearTimeout(silenceTimerRef.current);
        silenceTimerRef.current = 0;
      }
      renderTranscript();
      setHint(MUTED_HINT);
    } else {
      setHint(DEFAULT_HINT);
    }
  }, [renderTranscript]);

  // ── Open / Close ─────────────────────────────────────────────────────────
  const open = useCallback((opts: { minimized?: boolean } = {}) => {
    setMode(opts.minimized ? 'minimized' : 'full');
    setCollapsed(false);
    if (stateRef.current !== 'idle' && active) return;
    setActive(true);
  }, [active]);

  const toggleMinimized = useCallback(() => {
    setMode((m) => (m === 'minimized' ? 'full' : 'minimized'));
    setCollapsed(false);
  }, []);

  const toggleCollapsed = useCallback(() => {
    setCollapsed((c) => !c);
  }, []);

  const close = useCallback(() => {
    if (!active) return;
    setActive(false);
    sttRef.current?.stop();
    vadRef.current?.stop();
    vadRef.current = null;
    ttsRef.current?.cancel();
    if (silenceTimerRef.current) {
      clearTimeout(silenceTimerRef.current);
      silenceTimerRef.current = 0;
    }
    stopThinkingAnim();
    // Defer bg dispose so the close-out animation finishes
    const bg = bgRef.current;
    const modal = modalRef.current;
    if (modal) {
      modal.dataset['closing'] = '1';
      window.setTimeout(() => {
        bg?.dispose();
      }, 3000);
    }
    bgRef.current = null;
    spokenByMidRef.current.clear();
    authorByMidRef.current.clear();
    currentMidRef.current = null;
    finalRef.current = '';
    interimRef.current = '';
    recentTtsRef.current = [];
    streamActiveRef.current = false;
    mutedRef.current = false;
    setMuted(false);
    setCollapsed(false);
    setHint(DEFAULT_HINT);
    stateRef.current = 'idle';
    setState('idle');
  }, [active, stopThinkingAnim]);

  // Reflect voice-mode active state on <body> so the pet click handler (and
  // any other consumer outside the React tree) can synchronously decide
  // whether a click should collapse the voice panel or toggle the mini-chat.
  useEffect(() => {
    if (active) {
      document.body.dataset['yhaVoiceActive'] = '1';
      return () => { delete document.body.dataset['yhaVoiceActive']; };
    }
    return undefined;
  }, [active]);

  // ── Pet-anchored placement (minimized mode only) ────────────────────────
  // Re-measure the floating pet on every animation frame while the minimized
  // panel is visible. Cheap (one getBoundingClientRect per frame) and follows
  // patrol/jump exactly the same way PetConsoleBubble does — so the voice
  // panel feels like a sibling of the mini-chat surface.
  //
  // Skipped when collapsed (no need to track an invisible panel) or when the
  // pet element isn't in the DOM (fall through to the CSS bottom-right
  // default — keeps the panel reachable even with the pet hidden).
  useLayoutEffect(() => {
    if (!active || mode !== 'minimized' || collapsed) return;
    let raf = 0;
    const tick = () => {
      const el = document.querySelector<HTMLElement>('.pet-overlay');
      raf = requestAnimationFrame(tick);
      if (!el) { setPetAnchor((p) => (p ? null : p)); return; }
      const r = el.getBoundingClientRect();
      if (r.width < 10 || r.height < 10) { setPetAnchor((p) => (p ? null : p)); return; }
      const vpW = window.innerWidth;
      const vpH = window.innerHeight;
      // Side preference: opposite the pet's centre-of-mass, same convention
      // as PetConsoleBubble so the two never fight over the same gutter.
      const petCenterX = r.left + r.width / 2;
      const wantRight = petCenterX < vpW / 2;
      let left = wantRight
        ? r.right + MINI_GUTTER
        : r.left - MINI_PANEL_W - MINI_GUTTER;
      if (left + MINI_PANEL_W > vpW - MINI_VP_PAD) left = r.left - MINI_PANEL_W - MINI_GUTTER;
      if (left < MINI_VP_PAD) left = r.right + MINI_GUTTER;
      left = Math.max(MINI_VP_PAD, Math.min(vpW - MINI_PANEL_W - MINI_VP_PAD, left));
      let top = r.top + r.height / 2 - MINI_PANEL_H / 2;
      top = Math.max(MINI_VP_PAD, Math.min(vpH - MINI_PANEL_H - MINI_VP_PAD, top));
      setPetAnchor((prev) => {
        if (prev && Math.abs(prev.left - left) < 0.5 && Math.abs(prev.top - top) < 0.5) return prev;
        return { left, top };
      });
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [active, mode, collapsed]);

  // Pet-click collapse-toggle: only meaningful while voice is active AND in
  // minimized mode (full mode owns the whole viewport — collapsing it would
  // be a confusing UX). Otherwise the event is a no-op so a stray dispatch
  // from anywhere else doesn't tear the modal apart.
  useEffect(() => {
    function onToggleCollapsed() {
      if (!active || mode !== 'minimized') return;
      toggleCollapsed();
    }
    window.addEventListener('yha:voice-mode-toggle-collapsed', onToggleCollapsed);
    return () => window.removeEventListener('yha:voice-mode-toggle-collapsed', onToggleCollapsed);
  }, [active, mode, toggleCollapsed]);

  // ── Setup providers + STT/VAD when modal opens ──────────────────────────
  useEffect(() => {
    if (!active) return;
    if (!sttRef.current) sttRef.current = new BrowserSTT();
    if (!ttsRef.current) ttsRef.current = pickTtsProvider();

    if (sttRef.current.available()) {
      currentLangRef.current = (navigator.language || 'en').split('-')[0]!;
      sttRef.current.start({
        lang: langToBCP47(currentLangRef.current),
        onResult: ({ transcript: t, isFinal }) => {
          if (mutedRef.current) return;
          const hardInterrupt = stateRef.current === 'speaking' && hasInterruptKeyword(t);
          if (!hardInterrupt && stateRef.current === 'speaking' && isLikelyEcho(t)) return;
          if (isFinal) {
            finalRef.current += (finalRef.current && !finalRef.current.endsWith(' ') ? ' ' : '') + t.trim();
            interimRef.current = '';
            const detected = detectLang(finalRef.current, currentLangRef.current);
            if (detected !== currentLangRef.current) {
              currentLangRef.current = detected;
              sttRef.current?.setLang(langToBCP47(detected));
            }
          } else {
            interimRef.current = t;
          }
          renderTranscript();
          if (stateRef.current === 'speaking' || stateRef.current === 'thinking') {
            const minWords = ttsRef.current?.isSpeaking()
              ? ECHO_MIN_INTERRUPT_WORDS_WHILE_SPEAKING
              : ECHO_MIN_INTERRUPT_WORDS;
            if (hardInterrupt || countWords(t) >= minWords) interruptModel();
          }
          if (stateRef.current === 'listening') armSilenceTimer();
        },
        onError: (err) => setHint(`STT: ${err}`),
        onEnd: () => { /* provider self-restarts */ },
      });
    } else {
      const vad = new VADProvider();
      vadRef.current = vad;
      void vad.start({
        onSpeechStart: () => {
          if (mutedRef.current) return;
          if (stateRef.current === 'speaking' || stateRef.current === 'thinking') interruptModel();
        },
        onSpeechEnd: () => { /* no transcript path */ },
        onError: (err) => setHint(`Mic error: ${err}`),
      });
      setHint('Speech-to-text not available in this browser. Voice interrupt still works — type to send.');
    }

    setStateBoth('listening');
    return () => {
      // cleanup handled by close() — useEffect re-run only on active toggling
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // ── Mount voice-bg WebGL once modal element is rendered ─────────────────
  // Skipped in minimized mode — no backdrop means no shader, saves the GPU
  // and avoids painting an invisible WebGL canvas.
  useEffect(() => {
    if (!active || !modalRef.current || mode === 'minimized') return;
    bgRef.current = mountVoiceBg(modalRef.current);
    return () => {
      bgRef.current?.dispose();
      bgRef.current = null;
    };
  }, [active, mode]);

  // ── Stream-text + ESC listeners ─────────────────────────────────────────
  useEffect(() => {
    if (!active) return;
    window.addEventListener('yha-stream-text', onStreamText as EventListener);
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('yha-stream-text', onStreamText as EventListener);
      document.removeEventListener('keydown', onKey);
    };
  }, [active, close, onStreamText]);

  // ── Imperative open + button click wiring ───────────────────────────────
  useEffect(() => {
    function onOpenEvent(e: Event) {
      const detail = (e as CustomEvent<OpenVoiceModeDetail>).detail || {};
      open({ minimized: !!detail.minimized });
    }
    window.addEventListener('yha:voice-mode-open', onOpenEvent as EventListener);
    return () => window.removeEventListener('yha:voice-mode-open', onOpenEvent as EventListener);
  }, [open]);

  // ── Subscribe to userName / userSymbolColor for re-render on identity ──
  useAppStore((s) => s.userName);
  useAppStore((s) => s.userSymbolColor);

  if (!active) return null;
  void transcript; // re-render trigger

  const sp = activeSpeaker(stateRef.current, currentMidRef.current, authorByMidRef.current);
  const stateLabels: Record<VoiceState, string> = {
    idle: 'idle', listening: 'listening', thinking: 'reasoning', speaking: 'speaking',
  };
  const liveText = (finalRef.current + (interimRef.current ? ' ' + interimRef.current : '')).trim();

  // Override the CSS bottom-right defaults with a live pet-anchored placement
  // when we have a measured pet. Right/bottom must be cleared explicitly so
  // they don't fight the inline left/top and stretch the panel.
  const panelStyle: React.CSSProperties =
    mode === 'minimized' && petAnchor
      ? { left: petAnchor.left, top: petAnchor.top, right: 'auto', bottom: 'auto' }
      : {};

  return createPortal(
    <div
      className="voice-modal"
      data-state={state}
      data-muted={muted ? '1' : undefined}
      data-mode={mode}
      data-collapsed={collapsed ? '1' : undefined}
      ref={modalRef}
      style={{ '--voice-color': sp.color } as React.CSSProperties}
      // In minimized mode the wrapper has no backdrop, so clicks on the
      // (invisible) outer area must not close — only the explicit close
      // button does. Full mode keeps the click-to-close-on-backdrop UX.
      onClick={(e) => { if (mode === 'full' && e.target === e.currentTarget) close(); }}
    >
      <div
        className="voice-modal-panel"
        role="dialog"
        aria-label="Voice mode"
        style={panelStyle}
        onClick={toggleMute}
      >
        {mode === 'minimized' ? (
          <div className="voice-mini-controls" onClick={(e) => e.stopPropagation()}>
            <button
              type="button"
              className="voice-mini-btn"
              title="Maximize"
              aria-label="Maximize voice mode"
              onClick={toggleMinimized}
            >
              ⤢
            </button>
            <button
              type="button"
              className="voice-mini-btn"
              title="Close voice mode"
              aria-label="Close voice mode"
              onClick={close}
            >
              ×
            </button>
          </div>
        ) : null}
        <div className="voice-top">
          <span className="voice-speaker-name" style={{ color: sp.color }}>{sp.name}</span>
          <span className="voice-status" data-state={state}>{stateLabels[state]}</span>
        </div>
        <div className="voice-stage">
          <div className="voice-orb" aria-hidden="true"><span /><span /><span /></div>
          <div
            className="voice-avatar"
            style={{ background: sp.color, display: state === 'thinking' ? 'none' : '' }}
          >
            {sp.initial}
          </div>
          {muted && <MicMutedBadge />}
        </div>
        <div className="voice-bottom">
          <div className="voice-transcript" ref={transcriptElRef}>
            {state !== 'thinking' ? liveText : ''}
          </div>
          <div className="voice-hint">{hint}</div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function MicMutedBadge() {
  return (
    <div className="voice-mic-muted" aria-label="Microphone muted" title="Microphone muted">
      <svg viewBox="0 0 24 24" width="32" height="32" aria-hidden="true">
        <path
          fill="currentColor"
          d="M12 14a3 3 0 0 0 3-3V8.83l-6 6V11a3 3 0 0 0 3 3Zm5.91-3a.9.9 0 0 0-.9.9 5.04 5.04 0 0 1-.4 1.94l1.34 1.34A6.99 6.99 0 0 0 19 11.9a.9.9 0 0 0-.9-.9ZM4.27 3 3 4.27l5.99 5.99V11a3 3 0 0 0 4.27 2.71l1.62 1.62A4.96 4.96 0 0 1 12 16a5 5 0 0 1-5-5 .9.9 0 0 0-.9-.9.9.9 0 0 0-.9.9 7 7 0 0 0 5.9 6.92V21h2v-3.08a6.95 6.95 0 0 0 2.66-.84l3.07 3.07L20 18.88 4.27 3Z"
        />
      </svg>
    </div>
  );
}

function activeSpeaker(
  state: VoiceState,
  currentMid: number | null,
  authorByMid: Map<number, AuthorInfo | null>,
): { initial: string; color: string; name: string } {
  if (state === 'thinking') {
    return { initial: '', color: THINKING_COLOR, name: 'thinking' };
  }
  if (state === 'listening' || state === 'idle') {
    const app = getAppState();
    const name = app.userName || 'You';
    const color = app.userSymbolColor ? resolveAvatarColor(app.userSymbolColor) : DEFAULT_USER_COLOR;
    return { initial: (name[0] || 'U').toUpperCase(), color, name };
  }
  // speaking
  const author = currentMid != null ? authorByMid.get(currentMid) : null;
  if (author && author.color && author.name) {
    return { initial: (author.name[0] || 'A').toUpperCase(), color: resolveAvatarColor(author.color), name: author.name };
  }
  return { initial: 'AI', color: DEFAULT_AI_COLOR, name: 'AI' };
}
