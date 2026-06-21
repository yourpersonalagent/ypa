// ── WebGL voice-modal backdrop removed ───────────────────────────────────────
// Previously rendered the active bg-theme shader behind the voice assistant
// modal. Removed with the rest of the WebGL animation system — CSS filter
// chains on any WebGL canvas force 60fps GPU compositing. RIP.

export interface VoiceBgHandle { dispose: () => void }

export function mountVoiceBg(_parent: HTMLElement): VoiceBgHandle | null {
  return null;
}
