// OpenAITTS — TTSProvider impl that proxies through the bridge's
// /v1/tts/openai route. Plays the returned audio bytes via a single
// HTMLAudioElement, with a small in-memory queue so calls made while
// one is still playing line up behind it (matches BrowserTTS shape).
//
// Why a queue: VoiceMode calls speak() once per assistant message; on
// rapid streamed messages we'd otherwise cut off the previous clip.
// Browser Speech Synthesis queues natively; we mimic the contract.

interface SpeakOpts {
  lang?: string;
  onStart?: () => void;
  onEnd?: () => void;
  onError?: () => void;
}

interface QueueItem {
  text: string;
  opts: SpeakOpts;
}

export type OpenAIVoiceId =
  | 'alloy' | 'ash' | 'ballad' | 'coral' | 'echo' | 'fable'
  | 'nova' | 'onyx' | 'sage' | 'shimmer' | 'verse';

const VOICE_KEY = 'yha.tts.openai.voice';
const MODEL_KEY = 'yha.tts.openai.model';
const DEFAULT_VOICE: OpenAIVoiceId = 'alloy';
const DEFAULT_MODEL = 'gpt-4o-mini-tts';

export class OpenAITTS {
  private audio: HTMLAudioElement | null = null;
  private currentUrl: string | null = null;
  private queue: QueueItem[] = [];
  private busy = false;
  private cancelled = false;

  available(): boolean {
    // Always advertise available — the actual /v1/tts/openai 503
    // (missing api_key) is surfaced via the error handler at speak time.
    // available() is consulted by VoiceMode at modal-open; throwing here
    // would block the picker from listing the option at all.
    return typeof window !== 'undefined' && typeof Audio !== 'undefined';
  }

  speak(text: string, opts: SpeakOpts = {}): void {
    const t = text.trim();
    if (!t) { opts.onEnd?.(); return; }
    this.queue.push({ text: t, opts });
    this.cancelled = false;
    void this._drain();
  }

  cancel(): void {
    this.cancelled = true;
    this.queue = [];
    if (this.audio) {
      try { this.audio.pause(); } catch { /* ignore */ }
    }
    this._release();
    this.busy = false;
  }

  isSpeaking(): boolean {
    return this.busy && !!this.audio && !this.audio.paused;
  }

  private async _drain(): Promise<void> {
    if (this.busy) return;
    const item = this.queue.shift();
    if (!item) return;
    this.busy = true;
    try {
      await this._playOne(item);
    } finally {
      this.busy = false;
      if (!this.cancelled && this.queue.length) void this._drain();
    }
  }

  private async _playOne(item: QueueItem): Promise<void> {
    const voice = (typeof localStorage !== 'undefined' && localStorage.getItem(VOICE_KEY)) || DEFAULT_VOICE;
    const model = (typeof localStorage !== 'undefined' && localStorage.getItem(MODEL_KEY)) || DEFAULT_MODEL;

    let resp: Response;
    try {
      resp = await fetch('/v1/tts/openai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: item.text, voice, model, format: 'mp3' }),
      });
    } catch (e) {
      console.warn('[openai-tts] fetch failed:', e);
      item.opts.onError?.();
      return;
    }
    if (!resp.ok) {
      let detail = '';
      try { detail = await resp.text(); } catch { /* ignore */ }
      console.warn(`[openai-tts] /v1/tts/openai ${resp.status}:`, detail);
      item.opts.onError?.();
      return;
    }
    let blob: Blob;
    try {
      blob = await resp.blob();
    } catch (e) {
      console.warn('[openai-tts] blob read failed:', e);
      item.opts.onError?.();
      return;
    }
    if (this.cancelled) return;

    const url = URL.createObjectURL(blob);
    this.currentUrl = url;
    const audio = new Audio(url);
    this.audio = audio;

    await new Promise<void>((resolve) => {
      let settled = false;
      const done = (which: 'end' | 'error') => {
        if (settled) return;
        settled = true;
        if (which === 'error') item.opts.onError?.();
        else item.opts.onEnd?.();
        this._release();
        resolve();
      };
      audio.onplay = () => { item.opts.onStart?.(); };
      audio.onended = () => done('end');
      audio.onerror = () => done('error');
      audio.play().catch(() => done('error'));
    });
  }

  private _release(): void {
    if (this.currentUrl) {
      try { URL.revokeObjectURL(this.currentUrl); } catch { /* ignore */ }
      this.currentUrl = null;
    }
    this.audio = null;
  }
}
