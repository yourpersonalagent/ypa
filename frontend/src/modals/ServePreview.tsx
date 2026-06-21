// ServePreview — moveable, resizable, fullscreen-toggleable iframe view onto
// a per-CWD live-preview server (the active /v1/serve entry for the current
// session's CWD). Embeds the same /share/<token>/ route used by external
// shares so the in-app iframe gets identical path-rewrite/auth behavior.
//
// Open via the global event 'yha:open-serve-preview' (the Serve sub-section
// of CwdPanel dispatches it after Start). Profile picking, start/stop,
// and keep-alive toggling all live in CwdPanel — this window is purely
// the rendered preview surface.

import { useCallback, useEffect, useRef, useState } from 'react';
import { MoveableWindow, type MoveableWindowHandle } from '../components/MoveableWindow.js';
import { useServeStore, type ServeEntryPublic } from '../stores/serveStore.js';
import { useAppStore } from '../stores/appStore.js';
import { bus } from '../state.js';

const STORAGE_KEY = 'yha.servePreview.geometry';
const POLL_DEADLINE_MS = 30_000;
const TOUCH_INTERVAL_MS = 30_000;

function firstActiveSharePath(entry: ServeEntryPublic): string | null {
  const now = Date.now();
  const active = (entry.shares || []).find((s) =>
    s.active && !s.revokedAt && (s.expiresAt === null || s.expiresAt > now)
  );
  return active ? (active.publicPath || `/share/${active.token}/`) : null;
}

export function ServePreview() {
  const [open, setOpen] = useState(false);
  const [iframeReady, setIframeReady] = useState(false);
  const [bootError,   setBootError]   = useState('');
  const [iframeKey,   setIframeKey]   = useState(0);
  const [previewPath, setPreviewPath] = useState('');

  const sessionWorkingDir = useAppStore((s) => s.sessionWorkingDir);
  const entry             = useServeStore((s) => s.entry);
  const refresh           = useServeStore((s) => s.refresh);
  const stop              = useServeStore((s) => s.stop);
  const touch             = useServeStore((s) => s.touch);
  const setKeepAlive      = useServeStore((s) => s.setKeepAlive);

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const windowRef = useRef<MoveableWindowHandle | null>(null);
  const touchTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Poll until the proxy answers, then mount/refresh the iframe. On timeout
  // we auto-stop the dead serve entry — otherwise reopening this preview
  // would immediately retry against the same id and waste another 30 s
  // before reporting the same failure. The user has to explicitly Start a
  // new serve in the Projects panel to recover.
  const pollUntilReady = useCallback(async (id: string, basePath: string) => {
    const sep = basePath.includes('?') ? '&' : '?';
    const url = basePath + sep + 'probe=' + Date.now();
    const deadline = Date.now() + POLL_DEADLINE_MS;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(url, { cache: 'no-store', credentials: 'same-origin' });
        if (r.ok || r.status === 304 || r.status === 404) {
          setIframeReady(true);
          setIframeKey((k) => k + 1);
          return;
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 600));
    }
    setBootError(`server did not respond on /serve/${id}/ within ${POLL_DEADLINE_MS / 1000} s — stopped automatically`);
    try { await stop(id); } catch (_) { /* best-effort cleanup */ }
  }, [stop]);

  async function ensurePreviewSharePath(entry: ServeEntryPublic): Promise<string> {
    // The embedded preview intentionally uses the public /share/<token>/ route
    // too. That route is the one users already validated externally, and it
    // avoids iframe/auth edge-cases from the private /serve/<id>/ route. Reuse
    // an active share when present so opening the preview does not spray tokens.
    const now = Date.now();
    const activePath = firstActiveSharePath(entry);
    if (activePath) return activePath;

    const ttlMs = entry.expiresAt && entry.expiresAt > now
      ? Math.max(60_000, entry.expiresAt - now)
      : 60 * 60_000;
    const res = await fetch('/v1/serve/share/' + encodeURIComponent(entry.id), {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttlMs, label: 'internal-preview' }),
    });
    if (!res.ok) throw new Error(`could not create preview share (HTTP ${res.status})`);
    const data = await res.json();
    const token = data?.share?.token;
    if (!token) throw new Error('could not create preview share');
    return data.share.publicPath || `/share/${token}/`;
  }

  // Open / close events.
  useEffect(() => {
    async function onOpen() {
      setOpen(true);
      setBootError('');
      setIframeReady(false);
      setPreviewPath('');
      await refresh(sessionWorkingDir);
      const cur = useServeStore.getState().entry;
      if (!cur) {
        setBootError('No server is running for this working directory. Start one in the Projects panel.');
        return;
      }
      let sharePath = '';
      try {
        sharePath = await ensurePreviewSharePath(cur);
        setPreviewPath(sharePath);
      } catch (e) {
        setBootError((e as Error).message);
        return;
      }
      if (cur.profile === 'static') {
        setIframeReady(true);
        setIframeKey((k) => k + 1);
      } else {
        pollUntilReady(cur.id, sharePath);
      }
    }
    function onEsc() { if (!document.fullscreenElement) setOpen(false); }
    window.addEventListener('yha:open-serve-preview', onOpen);
    window.addEventListener('yha:escape', onEsc);
    return () => {
      window.removeEventListener('yha:open-serve-preview', onOpen);
      window.removeEventListener('yha:escape', onEsc);
    };
  }, [refresh, sessionWorkingDir, pollUntilReady]);

  // Touch heartbeat while the window is open: keeps the bridge reaper at bay.
  useEffect(() => {
    if (!open || !entry || entry.profile === 'static') {
      if (touchTimerRef.current) { clearInterval(touchTimerRef.current); touchTimerRef.current = null; }
      return;
    }
    touchTimerRef.current = setInterval(() => { touch(entry.id); }, TOUCH_INTERVAL_MS);
    return () => {
      if (touchTimerRef.current) { clearInterval(touchTimerRef.current); touchTimerRef.current = null; }
    };
  }, [open, entry, touch]);

  function handleReload() { setIframeKey((k) => k + 1); }

  async function handleStop() {
    if (!entry) return;
    await stop(entry.id);
    setOpen(false);
  }

  // Hand the running preview to the model: pre-fill the chat input with a
  // ready-to-send prompt + the exact playwright-mcp__browse tool call. Leave
  // the preview window open so the user can watch the model interact, and
  // tickle the server so it doesn't get reaped before the model calls the tool.
  function handleHandoffToModel() {
    if (!entry) return;
    touch(entry.id);
    const path = previewPath || firstActiveSharePath(entry) || `/serve/${entry.id}/`;
    const url = window.location.origin + (path.startsWith('/') ? path : `/serve/${entry.id}/`);
    const prompt =
`The local dev preview for this session's working directory is now live and you can browse it yourself. Use the playwright-mcp__browse tool (or web__navigate if you want me to watch) to load:

  ${url}

Suggested first call:
\`\`\`json
{
  "tool": "playwright-mcp__browse",
  "arguments": {
    "url": "${url}",
    "wait_for": "load"
  }
}
\`\`\`
Profile: ${entry.profile}${entry.port > 0 ? ` (proxy → 127.0.0.1:${entry.port})` : ' (in-process static)'}.
Working directory: ${entry.cwd}.`;
    bus.emit('chat:set-input', prompt);
  }

  const headerExtras = entry ? (
    <ServeIframeHeader
      entry={entry}
      ready={iframeReady}
      onReload={handleReload}
      onStop={handleStop}
      onToggleKeepAlive={(v) => setKeepAlive(entry.id, v)}
      onHandoffToModel={handleHandoffToModel}
    />
  ) : null;

  return (
    <MoveableWindow
      ref={windowRef}
      isOpen={open}
      title="Serve preview"
      storageKey={STORAGE_KEY}
      defaultGeometry={{ width: 960, height: 640 }}
      zIndex={1190}
      onClose={() => setOpen(false)}
      closeOnOutsideClick={false}
      closeOnEscape={false}
      headerExtras={headerExtras}
      bodyClassName="serve-window-body"
    >
      <ServeBody
        entry={entry}
        ready={iframeReady}
        bootError={bootError}
        iframeKey={iframeKey}
        iframeRef={iframeRef}
        previewPath={previewPath}
      />
    </MoveableWindow>
  );
}

interface IframeHeaderProps {
  entry: ServeEntryPublic;
  ready: boolean;
  onReload: () => void;
  onStop: () => void;
  onToggleKeepAlive: (v: boolean) => void;
  onHandoffToModel: () => void;
}
function ServeIframeHeader(p: IframeHeaderProps) {
  const phase = !p.ready ? 'starting' : p.entry.status;
  return (
    <>
      <span className={`serve-status-dot ${phase}`} title={phase} />
      <span className="serve-status-line">
        serve · {p.entry.profile}
        {p.entry.port > 0 ? ` · :${p.entry.port}` : ''}
      </span>
      <button type="button" className="mw-btn" title="Reload preview" onClick={p.onReload}>↻</button>
      <button type="button" className="mw-btn" title="Stop server" onClick={p.onStop}>⏹</button>
      <label className="serve-keep-toggle" title="Keep server alive on session switch / idle">
        <input
          type="checkbox"
          checked={p.entry.keepAlive}
          onChange={(e) => p.onToggleKeepAlive(e.target.checked)}
        />
        <span>keep</span>
      </label>
      <button
        type="button"
        className="mw-btn"
        title="Hand off to the model — pre-fill the chat input with a ready-to-send prompt + playwright-mcp__browse tool call pointed at this preview"
        onClick={p.onHandoffToModel}
      >🤖</button>
    </>
  );
}

interface ServeBodyProps {
  entry: ServeEntryPublic | null;
  ready: boolean;
  bootError: string;
  iframeKey: number;
  iframeRef: React.RefObject<HTMLIFrameElement | null>;
  previewPath: string;
}
function ServeBody(p: ServeBodyProps) {
  if (p.bootError) {
    return (
      <div className="serve-status-pane">
        <p className="serve-error">Could not open preview.</p>
        <pre className="serve-errmsg">{p.bootError}</pre>
      </div>
    );
  }
  if (!p.entry || !p.ready) {
    return (
      <div className="serve-status-pane">
        <div className="serve-spinner" />
        <p>{p.entry ? `Starting ${p.entry.profile} preview…` : 'Starting preview…'}</p>
        {p.entry && <p className="serve-hint">{p.entry.cmdLine}</p>}
      </div>
    );
  }
  const src = p.previewPath || firstActiveSharePath(p.entry) || `/serve/${p.entry.id}/`;
  return (
    <iframe
      key={'k' + p.iframeKey}
      ref={p.iframeRef}
      className="serve-iframe"
      src={src}
      // No allow-same-origin: the preview is proxied through the bridge's own
      // origin, so granting it would let previewed content script the parent
      // (localStorage/session IDs) and ride the user's bridge cookies. Opaque
      // origin keeps it isolated — same convention as plugin tiles (assets.ts).
      sandbox="allow-scripts allow-forms allow-popups allow-modals"
      title="Serve preview"
    />
  );
}
