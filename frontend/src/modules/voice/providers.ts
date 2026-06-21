// Voice provider adapters. Browser-native today; ElevenLabs/Whisper drop in later
// behind the same STTProvider / TTSProvider interfaces.

import { pickVoice } from './lang-detect.js';

export interface STTResult {
  transcript: string;
  isFinal: boolean;
}

export interface STTProvider {
  available(): boolean;
  start(opts: { lang?: string; onResult: (r: STTResult) => void; onError?: (e: string) => void; onEnd?: () => void }): void;
  stop(): void;
  setLang(lang: string): void;
  isListening(): boolean;
}

export interface TTSProvider {
  available(): boolean;
  speak(text: string, opts?: { lang?: string; onStart?: () => void; onEnd?: () => void; onError?: () => void }): void;
  cancel(): void;
  isSpeaking(): boolean;
}

interface SpeechRecognitionEv {
  resultIndex: number;
  results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
}
interface SpeechRecognitionInstance {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error?: string }) => void) | null;
  onresult: ((ev: SpeechRecognitionEv) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

export class BrowserSTT implements STTProvider {
  private recog: SpeechRecognitionInstance | null = null;
  private listening = false;
  private wantRestart = false;
  private lang = '';
  private opts: { lang?: string; onResult: (r: STTResult) => void; onError?: (e: string) => void; onEnd?: () => void } | null = null;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  // Mobile Chrome silently disables continuous mode; instead the engine drops
  // after each utterance and we have to respawn. The respawn needs a real
  // breathing-room delay or the engine refuses to start (looks like "doesn't
  // recognise speech" — same symptom as a stuck loop on the user's phone).
  private isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);

  available(): boolean {
    const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
    return !!(w.SpeechRecognition || w.webkitSpeechRecognition);
  }

  start(opts: { lang?: string; onResult: (r: STTResult) => void; onError?: (e: string) => void; onEnd?: () => void }): void {
    this.opts = opts;
    this.lang = opts.lang || navigator.language || 'en-US';
    this._spawn();
  }

  setLang(lang: string): void {
    if (!lang || lang === this.lang) return;
    this.lang = lang;
    if (!this.opts) return;
    // Restart with the new lang. The auto-restart path inside onend will pick it up.
    try { this.recog?.stop(); } catch { /* ignore */ }
  }

  private _spawn(): void {
    if (this.listening || !this.opts) return;
    const w = window as unknown as { SpeechRecognition?: new () => SpeechRecognitionInstance; webkitSpeechRecognition?: new () => SpeechRecognitionInstance };
    const SR = w.SpeechRecognition || w.webkitSpeechRecognition;
    if (!SR) { this.opts.onError?.('SpeechRecognition not supported'); return; }
    const r = new SR();
    r.lang = this.lang;
    // Mobile Chrome ignores continuous=true in practice — the engine still
    // ends after each utterance. Setting it false matches reality and stops
    // us fighting the engine; we drive the loop with our own restart timer.
    r.continuous = !this.isMobile;
    r.interimResults = true;
    const opts = this.opts;
    r.onstart = () => { this.listening = true; };
    r.onend = () => {
      this.listening = false;
      if (this.wantRestart) {
        // Delay before respawning. Mobile especially needs this — instant
        // respawn after the engine closes silently fails on Android Chrome.
        const delay = this.isMobile ? 300 : 80;
        this.restartTimer = setTimeout(() => { this.recog = null; this._spawn(); }, delay);
      } else {
        opts.onEnd?.();
      }
    };
    r.onerror = (e) => {
      const err = e.error || 'unknown';
      // Transient errors that should NOT abort the listening loop. 'no-speech'
      // fires constantly on mobile when the user isn't speaking; 'aborted'
      // fires when we triggered a stop to change lang; 'audio-capture' and
      // 'network' can be momentary. We let onend handle the respawn for these.
      const transient = err === 'no-speech' || err === 'aborted' || err === 'audio-capture' || err === 'network';
      if (!transient) opts.onError?.(err);
    };
    r.onresult = (ev) => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const res = ev.results[i];
        if (!res) continue;
        opts.onResult({ transcript: res[0].transcript, isFinal: res.isFinal });
      }
    };
    this.recog = r;
    this.wantRestart = true;
    try { r.start(); } catch { /* already started — onend will respawn */ }
  }

  stop(): void {
    this.wantRestart = false;
    this.listening = false;
    this.opts = null;
    if (this.restartTimer) { clearTimeout(this.restartTimer); this.restartTimer = null; }
    try { this.recog?.stop(); } catch { /* ignore */ }
    this.recog = null;
  }

  isListening(): boolean { return this.listening; }
}

// VAD-only fallback: emits a synthetic "speech detected" tick rather than a transcript.
// Used on Safari/Firefox where SpeechRecognition is missing. Useful for the interrupt
// signal; transcription itself falls back to "press to talk, release to send" UX
// (the modal shows a hint when this provider is active).
export class VADProvider {
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private stream: MediaStream | null = null;
  private raf = 0;
  private listening = false;
  private speaking = false;
  private silenceStart = 0;

  async start(opts: {
    onSpeechStart: () => void;
    onSpeechEnd: () => void;
    onError?: (e: string) => void;
    silenceMs?: number;
    threshold?: number;
  }): Promise<void> {
    if (this.listening) return;
    const silenceMs = opts.silenceMs ?? 1200;
    const threshold = opts.threshold ?? 0.012;
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        // Enable AEC/NS/AGC so the VAD energy threshold isn't tripped by the
        // model's own TTS playing through the device speakers.
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } as MediaTrackConstraints
      });
    } catch (e) {
      opts.onError?.(String(e));
      return;
    }
    const Ctx = (window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext }).AudioContext
      || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) { opts.onError?.('AudioContext not supported'); return; }
    this.ctx = new Ctx();
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    src.connect(this.analyser);
    const buf = new Float32Array(this.analyser.fftSize);
    this.listening = true;
    const tick = (): void => {
      if (!this.listening || !this.analyser) return;
      this.analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) { const v = buf[i]!; sum += v * v; }
      const rms = Math.sqrt(sum / buf.length);
      if (rms > threshold) {
        if (!this.speaking) { this.speaking = true; opts.onSpeechStart(); }
        this.silenceStart = 0;
      } else if (this.speaking) {
        if (!this.silenceStart) this.silenceStart = performance.now();
        else if (performance.now() - this.silenceStart > silenceMs) {
          this.speaking = false;
          this.silenceStart = 0;
          opts.onSpeechEnd();
        }
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  stop(): void {
    this.listening = false;
    this.speaking = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.analyser = null;
    void this.ctx?.close();
    this.ctx = null;
  }

  isSpeaking(): boolean { return this.speaking; }
}

export class BrowserTTS implements TTSProvider {
  private speaking = false;
  private queue: SpeechSynthesisUtterance[] = [];

  available(): boolean {
    return !!(window as unknown as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
  }

  speak(text: string, opts: { lang?: string; onStart?: () => void; onEnd?: () => void; onError?: () => void } = {}): void {
    const synth = (window as unknown as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
    if (!synth) { opts.onError?.(); return; }
    const t = text.trim();
    if (!t) { opts.onEnd?.(); return; }
    const u = new SpeechSynthesisUtterance(t);
    let voice: SpeechSynthesisVoice | null = null;
    if (opts.lang) voice = pickVoice(opts.lang);
    if (!voice) {
      const voices = synth.getVoices();
      voice = voices.find((v) => /Microsoft/i.test(v.name)) || voices.find((v) => v.default) || null;
    }
    if (voice) { u.voice = voice; u.lang = voice.lang; }
    else if (opts.lang) u.lang = opts.lang;
    u.onstart = () => { this.speaking = true; opts.onStart?.(); };
    u.onend = () => {
      this.queue = this.queue.filter((q) => q !== u);
      if (this.queue.length === 0) this.speaking = false;
      opts.onEnd?.();
    };
    u.onerror = () => {
      this.queue = this.queue.filter((q) => q !== u);
      if (this.queue.length === 0) this.speaking = false;
      opts.onError?.();
    };
    this.queue.push(u);
    synth.speak(u);
  }

  cancel(): void {
    const synth = (window as unknown as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
    this.queue = [];
    this.speaking = false;
    try { synth?.cancel(); } catch { /* ignore */ }
  }

  isSpeaking(): boolean {
    const synth = (window as unknown as { speechSynthesis?: SpeechSynthesis }).speechSynthesis;
    return !!synth?.speaking || this.speaking;
  }
}
