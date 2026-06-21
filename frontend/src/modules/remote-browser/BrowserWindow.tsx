// BrowserWindow — moveable, resizable, fullscreen-toggleable iframe view
// onto the desktop-browser MCP's KasmVNC surface (http://127.0.0.1:3001/).
//
// Primary path is the model: the MCP itself drives Chromium via CDP, and tool
// calls succeed regardless of whether this window is open. This component
// exists so the user can OCCASIONALLY see and take over (logins, captchas).
//
// Open via the global event 'yha:open-browser-window' (the header button and
// Alt+B both dispatch it). Drag/resize/fullscreen/persistence is provided by
// MoveableWindow; only KasmVNC-specific behaviour lives here.

import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../api.js';
import { MoveableWindow, type MoveableWindowHandle } from '../../components/MoveableWindow.js';
import { Screencast, type ScreencastPreset, type ScreencastHandle } from './Screencast.js';

// Same-origin via the bridge's reverse proxy. Loading http://127.0.0.1:3011/
// directly would be blocked as mixed content when YHA itself runs on HTTPS.
const KASM_URL = '/proxy/browser/';
const STREAM_URL = '/proxy/desktop-browser-stream';
const STORAGE_KEY = 'yha.browserWindow.geometry';
const QUALITY_KEY = 'yha.browserWindow.quality';

type BackendMode = 'docker-linux' | 'native-windows';

// 5-step quality presets. The KasmVNC fields (encoder/h264_crf/video_bitrate)
// are only consumed on the Linux iframe path; the Screencast (CDP) path reads
// only fps/jpeg_quality/max_dim. Both shapes share the same index so the
// stored preference (yha.browserWindow.quality) survives across platforms.
interface QualityPreset {
  label: string;
  hint:  string;             // tooltip text for KasmVNC mode
  hintCdp: string;           // tooltip text for CDP screencast mode
  fps:   number;
  encoder: 'jpeg' | 'x264enc';
  jpeg_quality: number;
  h264_crf: number;
  video_bitrate: number;
  max_dim: number | 0;       // 0 = native size (no maxWidth/Height clamp)
}
const QUALITY_PRESETS: QualityPreset[] = [
  { label: 'eco',  hint: '8 fps · JPEG 20 · ~1 Mbps',         hintCdp: '5 fps · JPEG 25 — minimal CPU/network',  fps: 8,  encoder: 'jpeg',    jpeg_quality: 20, h264_crf: 38, video_bitrate: 1,  max_dim: 1280 },
  { label: 'low',  hint: '12 fps · JPEG 35 · ~2 Mbps',        hintCdp: '10 fps · JPEG 40',                       fps: 12, encoder: 'jpeg',    jpeg_quality: 35, h264_crf: 35, video_bitrate: 2,  max_dim: 1280 },
  { label: 'mid',  hint: '20 fps · H.264 CRF 30 · 4 Mbps',    hintCdp: '15 fps · JPEG 55 (default)',             fps: 20, encoder: 'x264enc', jpeg_quality: 55, h264_crf: 30, video_bitrate: 4,  max_dim: 1600 },
  { label: 'high', hint: '30 fps · H.264 CRF 25 · 8 Mbps',    hintCdp: '24 fps · JPEG 70',                       fps: 30, encoder: 'x264enc', jpeg_quality: 70, h264_crf: 25, video_bitrate: 8,  max_dim: 1920 },
  { label: 'max',  hint: '60 fps · H.264 CRF 18 · 16 Mbps',   hintCdp: '30 fps · JPEG 85 — full-res',            fps: 60, encoder: 'x264enc', jpeg_quality: 85, h264_crf: 18, video_bitrate: 16, max_dim: 0    },
];

// Per-mode preset overrides — for CDP we use a calmer fps ladder than KasmVNC
// (CDP screencast at 60 fps eats CPU with little visible benefit since we're
// already JPEG-encoding every frame, vs Selkies H.264 which is GPU-cheap).
function cdpPreset(p: QualityPreset, index: number): ScreencastPreset {
  const cdpFps = [5, 10, 15, 24, 30][index] ?? p.fps;
  return { fps: cdpFps, jpeg_quality: p.jpeg_quality, max_dim: p.max_dim || 2560 };
}

// Turn an address-bar entry into a navigable URL: pass through explicit
// http(s), promote a bare host (one token, has a dot) to https, otherwise
// treat it as a Google search. Mirrors the in-page start page's logic so the
// two entry points behave identically.
function normalizeAddress(input: string): string | null {
  const v = input.trim();
  if (!v) return null;
  if (/^https?:\/\//i.test(v)) return v;
  if (v.indexOf(' ') === -1 && /^[^\s.]+(\.[^\s.]+)+$/.test(v)) return 'https://' + v;
  return 'https://www.google.com/search?q=' + encodeURIComponent(v);
}

function loadQuality(): number {
  try {
    const v = parseInt(localStorage.getItem(QUALITY_KEY) || '', 10);
    if (v >= 1 && v <= 5) return v;
  } catch {}
  return 2; // default: low — eco-friendly, plenty for handoff
}
function saveQuality(q: number): void {
  try { localStorage.setItem(QUALITY_KEY, String(q)); } catch {}
}
function buildIframeSrc(q: number): string {
  const p = QUALITY_PRESETS[q - 1];
  const params = new URLSearchParams({
    framerate:     String(p.fps),
    encoder:       p.encoder,
    jpeg_quality:  String(p.jpeg_quality),
    h264_crf:      String(p.h264_crf),
    video_bitrate: String(p.video_bitrate),
  });
  return KASM_URL + '?' + params.toString();
}

type Phase = 'idle' | 'starting' | 'ready' | 'error';

async function fetchServerPlatform(base: string): Promise<string | null> {
  try {
    const r = await fetch(base + '/v1/config/', { cache: 'no-store' });
    if (!r.ok) return null;
    const j = await r.json();
    const platform = j?.config?.serverPlatform;
    return typeof platform === 'string' ? platform : null;
  } catch {
    return null;
  }
}

export function BrowserWindow() {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>('idle');
  const [errorMsg, setErrorMsg] = useState<string>('');
  const [locked, setLocked] = useState(false);
  const [quality, setQualityState] = useState<number>(loadQuality);
  const [mode, setMode] = useState<BackendMode>('docker-linux');
  const [currentUrl, setCurrentUrl] = useState('');
  const [urlDraft, setUrlDraft] = useState('');
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const windowRef = useRef<MoveableWindowHandle | null>(null);
  const screencastRef = useRef<ScreencastHandle | null>(null);
  const urlInputRef = useRef<HTMLInputElement | null>(null);

  function setQuality(q: number) {
    const clamped = Math.max(1, Math.min(5, q));
    setQualityState(clamped);
    saveQuality(clamped);
  }

  // Keep the address bar reflecting the live page URL — which also changes when
  // the assistant navigates over MCP (the screencast session sees the same
  // Page.frameNavigated) — but never clobber what the user is mid-typing.
  // about:blank is the idle/start page, so show it as empty.
  useEffect(() => {
    if (urlInputRef.current && document.activeElement === urlInputRef.current) return;
    setUrlDraft(/^about:blank/.test(currentUrl) ? '' : currentUrl);
  }, [currentUrl]);

  const submitAddress = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    const url = normalizeAddress(urlDraft);
    if (!url) return;
    screencastRef.current?.navigate(url);
    urlInputRef.current?.blur(); // let live URL updates resume
  }, [urlDraft]);

  // ── State machine: from "click button" to "stream live" ──────────────────
  // We probe the platform-appropriate surface: Windows uses the CDP screencast
  // path, while Linux/macOS use the Docker/KasmVNC path. If platform detection
  // fails, fall back to probing both so old/partial backends still work.
  const ensureRunning = useCallback(async () => {
    setPhase('starting');
    setErrorMsg('');
    const base = api.config.baseUrl;
    try {
      await fetch(base + '/v1/mcp/web/start', { method: 'POST' });
      const serverPlatform = await fetchServerPlatform(base);
      const probeStream = serverPlatform === null || serverPlatform === 'win32';
      const probeKasm = serverPlatform === null || serverPlatform !== 'win32';
      const deadline = Date.now() + 45_000;
      let resolvedMode: BackendMode | null = null;
      let lastStreamError: string | null = null;
      while (Date.now() < deadline) {
        // Race the enabled probes — first to 200 wins. ESC/server-down rejects fast.
        const probes = await Promise.all([
          probeStream
            ? fetch(STREAM_URL + '?probe=' + Date.now(), { cache: 'no-store' }).catch(() => null)
            : Promise.resolve(null),
          probeKasm
            ? fetch(KASM_URL + '?probe=' + Date.now(), { cache: 'no-store' }).catch(() => null)
            : Promise.resolve(null),
        ]);
        if (probes[0] && probes[0].ok) { resolvedMode = 'native-windows'; break; }
        if (probes[1] && probes[1].ok) { resolvedMode = 'docker-linux';   break; }
        // While the Windows screencast path is still booting it answers 503
        // with a JSON body carrying the last boot error (or null). Remember
        // it so a 45 s timeout can explain *why* instead of just "no response".
        if (probes[0] && !probes[0].ok) {
          try {
            const j = await probes[0].json();
            if (j && typeof j.error === 'string' && j.error) lastStreamError = j.error;
          } catch { /* go-core's own 503 is plain text — ignore */ }
        }
        await new Promise((r) => setTimeout(r, 600));
      }
      if (!resolvedMode) {
        const targets = [
          probeStream ? STREAM_URL : null,
          probeKasm ? KASM_URL : null,
        ].filter(Boolean).join(' or ');
        throw new Error(lastStreamError
          ? 'Remote browser failed to start: ' + lastStreamError
          : 'Remote browser did not respond on ' + targets + ' within 45 s');
      }
      setMode(resolvedMode);
      setPhase('ready');
    } catch (e) {
      setPhase('error');
      setErrorMsg(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // ── Open / close events ──────────────────────────────────────────────────
  // Note: this window deliberately does NOT close on Esc. It's a long-lived
  // remote-desktop surface that often forwards Esc into the running browser
  // (e.g. to dismiss a page-level overlay), so global Esc would steal that.
  // Close it via the window's own ✕ button or the trigger that opened it.
  useEffect(() => {
    function onOpen() {
      setOpen(true);
      // Kick off the boot sequence on every open — idempotent server-side.
      ensureRunning();
    }
    window.addEventListener('yha:open-browser-window', onOpen);
    return () => {
      window.removeEventListener('yha:open-browser-window', onOpen);
    };
  }, [ensureRunning]);

  const headerExtras = (
    <>
      <span className={`browser-window-phase phase-${phase}`}>
        {phase === 'starting' && 'starting…'}
        {phase === 'ready' && 'live'}
        {phase === 'error' && 'error'}
        {phase === 'idle' && '—'}
      </span>
      <div
        className="browser-window-quality"
        role="radiogroup"
        aria-label="Stream quality"
        title={`Stream quality: ${QUALITY_PRESETS[quality - 1].label} — ${mode === 'native-windows' ? QUALITY_PRESETS[quality - 1].hintCdp : QUALITY_PRESETS[quality - 1].hint}. Click a dot to change.`}
      >
        {QUALITY_PRESETS.map((p, i) => (
          <button
            key={i}
            type="button"
            role="radio"
            aria-checked={quality === i + 1}
            className={`bw-q-dot${quality >= i + 1 ? ' on' : ''}${quality === i + 1 ? ' current' : ''}`}
            title={`${p.label} — ${mode === 'native-windows' ? p.hintCdp : p.hint}`}
            onClick={() => setQuality(i + 1)}
          />
        ))}
      </div>
      <button
        className={`mw-btn${locked ? ' active' : ''}`}
        title={locked
          ? 'Locked — clicks/keys go to the window, not the page. Click to unlock.'
          : 'Lock — block clicks/keys from reaching the page; whole window becomes a drag handle.'}
        onClick={() => setLocked((v) => !v)}
        aria-pressed={locked}
      >
        {locked ? '🔒' : '🔓'}
      </button>
    </>
  );

  return (
    <MoveableWindow
      ref={windowRef}
      isOpen={open}
      title="Remote Browser"
      storageKey={STORAGE_KEY}
      defaultGeometry={{ width: 960, height: 640 }}
      zIndex={1200}
      onClose={() => setOpen(false)}
      closeOnOutsideClick={false}
      // Closure handled by the existing 'yha:escape' listener above; let
      // MoveableWindow's own Escape do nothing so we don't double-close.
      closeOnEscape={false}
      headerExtras={headerExtras}
      bodyClassName="browser-window-body"
    >
      {phase === 'starting' && (
        <div className="browser-window-status">
          <div className="browser-window-spinner" />
          <p>Starting the remote browser…</p>
          <p className="browser-window-hint">First start can take ~30 s while Chromium boots.</p>
        </div>
      )}
      {phase === 'error' && (
        <div className="browser-window-status">
          <p className="browser-window-error">Could not start the remote browser.</p>
          <pre className="browser-window-errmsg">{errorMsg}</pre>
          <button className="browser-window-retry" onClick={ensureRunning}>Retry</button>
        </div>
      )}
      {phase === 'ready' && mode === 'docker-linux' && (
        <iframe
          // key forces a remount (and therefore a fresh stream-settings
          // negotiation with Selkies) whenever the quality preset changes.
          key={'q' + quality}
          ref={iframeRef}
          className="browser-window-iframe"
          src={buildIframeSrc(quality)}
          sandbox="allow-scripts allow-same-origin allow-forms"
          allow="clipboard-read; clipboard-write"
          title="Remote Browser"
          tabIndex={locked ? -1 : 0}
        />
      )}
      {phase === 'ready' && mode === 'native-windows' && (
        <div className="browser-window-cdp">
          {/* Browser chrome — Windows/CDP path only. The Linux KasmVNC iframe
              ships its own toolbar inside the streamed desktop. */}
          <div className="browser-window-toolbar">
            <button type="button" className="bw-nav-btn" title="Back"
              onClick={() => screencastRef.current?.back()} aria-label="Back">‹</button>
            <button type="button" className="bw-nav-btn" title="Forward"
              onClick={() => screencastRef.current?.forward()} aria-label="Forward">›</button>
            <button type="button" className="bw-nav-btn" title="Reload"
              onClick={() => screencastRef.current?.reload()} aria-label="Reload">↻</button>
            <form className="bw-address-form" onSubmit={submitAddress}>
              <input
                ref={urlInputRef}
                className="bw-address-bar"
                type="text"
                value={urlDraft}
                onChange={(e) => setUrlDraft(e.target.value)}
                onFocus={(e) => e.currentTarget.select()}
                placeholder="Enter a URL or search, then press Enter"
                spellCheck={false}
                autoComplete="off"
                aria-label="Address bar"
              />
            </form>
          </div>
          <div className="browser-window-cdp-view">
            <Screencast
              ref={screencastRef}
              preset={cdpPreset(QUALITY_PRESETS[quality - 1], quality - 1)}
              locked={locked}
              onNavigated={(u) => setCurrentUrl(u)}
              onError={(m) => { setPhase('error'); setErrorMsg(m); }}
            />
          </div>
        </div>
      )}
      {locked && phase === 'ready' && mode === 'docker-linux' && (
        // Transparent overlay swallows pointer events so they never reach
        // the iframe — and acts as a drag handle for the whole window.
        // On the native-windows path the Screencast component handles
        // `locked` internally (no events forwarded), so no overlay needed.
        <div
          className="browser-window-lock-overlay"
          onPointerDown={(e) => windowRef.current?.startDrag(e)}
          title="Locked. Drag anywhere to move the window. Click the lock icon to unlock."
        />
      )}
    </MoveableWindow>
  );
}
