// Screencast — canvas-backed live view of the Windows desktop-browser MCP.
//
// Replaces the KasmVNC iframe on Windows hosts. Streams JPEG frames from
// Chrome DevTools Protocol Page.startScreencast over a same-origin WS proxy
// (/proxy/desktop-browser-stream) and forwards mouse / wheel / keyboard
// events back as JSON messages — protocol defined in bridge/mcp/_screencast-server.js.
//
// Why a canvas instead of the iframe pattern: CDP doesn't have a web client
// (KasmVNC/Selkies live inside a container). For Windows we don't have a
// container, so we wire the bytes up ourselves. Tradeoff: ~250 LOC of input
// plumbing here vs. the convenience of iframe-as-blackbox.

import { useEffect, useRef, useState, useCallback, forwardRef, useImperativeHandle } from 'react';

const STREAM_URL = '/proxy/desktop-browser-stream';

export interface ScreencastPreset {
  fps: number;
  jpeg_quality: number;
  max_dim: number;
}

interface ScreencastProps {
  preset: ScreencastPreset;
  locked: boolean;
  onNavigated?: (url: string) => void;
  onError?: (msg: string) => void;
}

// Imperative API for the surrounding browser chrome (address bar + nav buttons
// in BrowserWindow). The WS lives in here, so navigation is driven through this
// handle rather than lifting the socket up.
export interface ScreencastHandle {
  navigate: (url: string) => void;
  back: () => void;
  forward: () => void;
  reload: () => void;
}

type ConnState = 'connecting' | 'open' | 'closed' | 'error';

export const Screencast = forwardRef<ScreencastHandle, ScreencastProps>(function Screencast(
  { preset, locked, onNavigated, onError },
  ref,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const pendingBinaryRef = useRef<{ bytes: number; ts?: number } | null>(null);
  const lastMouseRef = useRef<{ x: number; y: number; buttons: number }>({ x: 0, y: 0, buttons: 0 });
  const hasAutoFocusedRef = useRef(false);
  // The device-metrics size we last asked the server for (via `resize`) — i.e.
  // the page's layout-viewport in CSS px. Input coords must be in THIS space,
  // and it's what the streamed frame is a (possibly downscaled) copy of. Mirror
  // the server's initial viewport + its min clamps so the two never disagree.
  const deviceMetricsRef = useRef<{ w: number; h: number }>({ w: 1280, h: 800 });
  const [connState, setConnState] = useState<ConnState>('connecting');
  const [overlay, setOverlay] = useState<{ fps: number; kbps: number } | null>(null);

  // Build wss:// or ws:// based on current page scheme. Same-origin so cookies
  // and any session auth ride along automatically.
  const wsUrl = (() => {
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${window.location.host}${STREAM_URL}`;
  })();

  // ── Connect / reconnect ────────────────────────────────────────────────────
  useEffect(() => {
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let closed = false;
    let frameCount = 0;
    let byteCount = 0;
    let lastStatsTs = Date.now();

    function connect() {
      if (closed) return;
      setConnState('connecting');
      const ws = new WebSocket(wsUrl);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        setConnState('open');
        // Send initial config + resize as soon as we know our canvas dims.
        sendConfig();
        sendResize();
      };

      ws.onclose = () => {
        setConnState('closed');
        wsRef.current = null;
        if (!closed) retryTimer = setTimeout(connect, 1500);
      };

      ws.onerror = () => {
        setConnState('error');
        // ws.onclose fires next; retry happens there.
      };

      ws.onmessage = async (ev) => {
        // Protocol: text JSON for control + frame_meta header, binary for JPEG.
        if (typeof ev.data === 'string') {
          let msg: any;
          try { msg = JSON.parse(ev.data); } catch { return; }
          if (msg.type === 'frame_meta') {
            pendingBinaryRef.current = { bytes: msg.bytes, ts: msg.ts };
          } else if (msg.type === 'navigated' && onNavigated) {
            onNavigated(msg.url);
          } else if (msg.type === 'error' && onError) {
            onError(msg.message || 'screencast error');
          } else if (msg.type === 'ready') {
            // server confirmed attach — nothing to do
          }
          return;
        }
        // Binary JPEG frame
        const buf: ArrayBuffer = ev.data instanceof Blob ? await ev.data.arrayBuffer() : ev.data;
        byteCount += buf.byteLength;
        frameCount++;
        const now = Date.now();
        if (now - lastStatsTs >= 1000) {
          setOverlay({ fps: frameCount, kbps: Math.round((byteCount * 8) / 1024 / ((now - lastStatsTs) / 1000)) });
          frameCount = 0; byteCount = 0; lastStatsTs = now;
        }
        try {
          const blob = new Blob([buf], { type: 'image/jpeg' });
          const bmp = await createImageBitmap(blob);
          const cv = canvasRef.current;
          if (!cv) { bmp.close(); return; }
          const ctx = cv.getContext('2d');
          if (!ctx) { bmp.close(); return; }
          // Set canvas's drawing buffer to match the natural frame size so we
          // don't blur on upscale. CSS (object-fit:contain) fits it to the
          // wrapper without distorting the aspect ratio.
          if (cv.width !== bmp.width || cv.height !== bmp.height) {
            cv.width = bmp.width; cv.height = bmp.height;
          }
          ctx.drawImage(bmp, 0, 0);
          // lastMouseRef holds page (device-metrics) coords — what we send the
          // server. The canvas backing store is the (possibly downscaled) frame,
          // so convert page→frame before drawing the synthetic cursor.
          const dm = deviceMetricsRef.current;
          const curX = dm.w ? lastMouseRef.current.x * (bmp.width / dm.w) : lastMouseRef.current.x;
          const curY = dm.h ? lastMouseRef.current.y * (bmp.height / dm.h) : lastMouseRef.current.y;
          drawCursor(ctx, curX, curY, bmp.width, bmp.height, cv);
          bmp.close();
        } catch (_) { /* decode error — drop frame */ }
      };
    }
    connect();
    return () => {
      closed = true;
      if (retryTimer) clearTimeout(retryTimer);
      try { wsRef.current?.close(); } catch {}
      wsRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wsUrl]);

  // ── Outbound: config when preset changes, resize on size changes ───────────
  function sendConfig() {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      type: 'config',
      fps: preset.fps,
      jpeg_quality: preset.jpeg_quality,
      max_dim: preset.max_dim,
    }));
  }
  function sendResize() {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const el = wrapRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const w = Math.round(r.width);
    const h = Math.round(r.height);
    // Mirror the server's clamp (bridge/mcp/_screencast-server.js 'resize') so
    // our coordinate mapping uses the same device-metrics the server applies.
    deviceMetricsRef.current = { w: Math.max(320, w), h: Math.max(240, h) };
    ws.send(JSON.stringify({ type: 'resize', w, h }));
  }
  useEffect(() => { sendConfig(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [preset.fps, preset.jpeg_quality, preset.max_dim]);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let t: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      // Debounce — ResizeObserver fires per frame during a drag-resize and
      // we don't want to spam Emulation.setDeviceMetricsOverride.
      if (t) clearTimeout(t);
      t = setTimeout(sendResize, 120);
    });
    ro.observe(el);
    return () => { ro.disconnect(); if (t) clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-focus the wrapper so the user can type a URL immediately. The window
  // unmounts this component on close (MoveableWindow returns null), so the
  // first 'open' after mount means the user just opened it → take focus even
  // though the header toggle button currently holds it. On later reconnects,
  // only take focus if nothing else has it, so a background reconnect doesn't
  // yank keyboard focus away from the rest of the app.
  useEffect(() => {
    if (connState !== 'open' || locked) return;
    if (!hasAutoFocusedRef.current) {
      hasAutoFocusedRef.current = true;
      wrapRef.current?.focus();
      return;
    }
    const active = document.activeElement;
    if (!active || active === document.body) wrapRef.current?.focus();
  }, [connState, locked]);

  // ── Coordinate mapping (canvas client → page) ──────────────────────────────
  // CDP Input.dispatch* wants coordinates in the page's layout-viewport CSS px
  // (= the device-metrics size we requested via `resize`). The canvas is shown
  // object-fit:contain, so map: client → the displayed image box (account for
  // letterbox offset + contain scale) → frame px → device-metrics px. In the
  // steady state (frame aspect == wrapper aspect, no letterbox) this reduces to
  // identity; it stays correct during a resize transient or any frame/wrapper
  // aspect mismatch, instead of mis-landing clicks the way a naive scale would.
  const eventToPageCoords = useCallback((e: { clientX: number; clientY: number }) => {
    const cv = canvasRef.current;
    if (!cv) return { x: 0, y: 0 };
    const r = cv.getBoundingClientRect();
    const fw = cv.width || 1;   // frame px (canvas backing store)
    const fh = cv.height || 1;
    const scale = Math.min(r.width / fw, r.height / fh) || 1; // object-fit:contain
    const offX = (r.width - fw * scale) / 2;
    const offY = (r.height - fh * scale) / 2;
    // client → frame px, clamped so a click on the letterbox lands on the edge.
    const fx = Math.min(Math.max((e.clientX - r.left - offX) / scale, 0), fw);
    const fy = Math.min(Math.max((e.clientY - r.top - offY) / scale, 0), fh);
    // frame px → device-metrics (page) px — the frame is the page downscaled to
    // fit max_dim, so scale back up by deviceMetrics / frame.
    const dm = deviceMetricsRef.current;
    return {
      x: Math.round(fx * (dm.w / fw)),
      y: Math.round(fy * (dm.h / fh)),
    };
  }, []);

  function modifiersFromEvent(e: { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): number {
    // CDP Input.dispatch* modifier bitmask:
    //  1=Alt, 2=Ctrl, 4=Meta/Cmd, 8=Shift
    return (e.altKey ? 1 : 0) | (e.ctrlKey ? 2 : 0) | (e.metaKey ? 4 : 0) | (e.shiftKey ? 8 : 0);
  }

  function buttonName(b: number): 'left' | 'middle' | 'right' | 'none' {
    if (b === 0) return 'left';
    if (b === 1) return 'middle';
    if (b === 2) return 'right';
    return 'none';
  }

  // ── Mouse / wheel / key handlers ───────────────────────────────────────────
  function send(msg: object) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(msg));
  }

  // Browser-chrome navigation, driven by the address bar / nav buttons in
  // BrowserWindow. These reach the same page the model drives over MCP, so the
  // server runs them on its shared page session (see _screencast-server.js).
  useImperativeHandle(ref, () => ({
    navigate: (url: string) => send({ type: 'navigate', url }),
    back: () => send({ type: 'goBack' }),
    forward: () => send({ type: 'goForward' }),
    reload: () => send({ type: 'reload' }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  function onPointerDown(e: React.PointerEvent) {
    if (locked) return;
    // Clicking the canvas must (re)focus the wrapper: onKeyDown only fires while
    // the wrapper is document.activeElement. Without this, clicking the remote
    // input focuses it *in the page* but the wrapper stays unfocused, so typing
    // goes nowhere and focus, once lost, never comes back.
    wrapRef.current?.focus();
    // setPointerCapture can throw (InvalidStateError if the pointer isn't
    // active) — must not abort the mouse-down send below, or clicks silently
    // die while focus/keyboard still work.
    try { (e.target as Element).setPointerCapture?.(e.pointerId); } catch { /* non-fatal */ }
    const { x, y } = eventToPageCoords(e);
    const button = buttonName(e.button);
    lastMouseRef.current = { x, y, buttons: e.buttons };
    send({ type: 'mouse', action: 'down', x, y, button, buttons: e.buttons,
      clickCount: e.detail || 1, modifiers: modifiersFromEvent(e) });
  }
  function onPointerUp(e: React.PointerEvent) {
    if (locked) return;
    const { x, y } = eventToPageCoords(e);
    const button = buttonName(e.button);
    lastMouseRef.current = { x, y, buttons: e.buttons };
    send({ type: 'mouse', action: 'up', x, y, button, buttons: e.buttons,
      clickCount: 1, modifiers: modifiersFromEvent(e) });
  }
  function onPointerMove(e: React.PointerEvent) {
    if (locked) return;
    const { x, y } = eventToPageCoords(e);
    lastMouseRef.current = { x, y, buttons: e.buttons };
    send({ type: 'mouse', action: 'move', x, y,
      button: e.buttons ? buttonName(0) : 'none', buttons: e.buttons,
      modifiers: modifiersFromEvent(e) });
  }
  function onWheel(e: React.WheelEvent) {
    if (locked) return;
    const { x, y } = eventToPageCoords(e);
    send({ type: 'wheel', x, y, deltaX: e.deltaX, deltaY: e.deltaY,
      modifiers: modifiersFromEvent(e) });
  }
  function onContextMenu(e: React.MouseEvent) { e.preventDefault(); /* let RMB pass to page */ }

  // Keyboard goes to the wrapper div (canvas can't take focus directly).
  function onKeyDown(e: React.KeyboardEvent) {
    if (locked) return;
    e.preventDefault();
    send({ type: 'key', action: 'down', key: e.key, code: e.code,
      text: e.key.length === 1 ? e.key : undefined,
      modifiers: modifiersFromEvent(e),
      windowsVirtualKeyCode: keyToVirtualKeyCode(e.key),
    });
  }
  function onKeyUp(e: React.KeyboardEvent) {
    if (locked) return;
    e.preventDefault();
    send({ type: 'key', action: 'up', key: e.key, code: e.code,
      modifiers: modifiersFromEvent(e),
      windowsVirtualKeyCode: keyToVirtualKeyCode(e.key),
    });
  }
  function onPaste(e: React.ClipboardEvent) {
    if (locked) return;
    const t = e.clipboardData.getData('text');
    if (t) { e.preventDefault(); send({ type: 'paste', text: t }); }
  }

  return (
    <div
      ref={wrapRef}
      className="browser-window-screencast-wrap"
      tabIndex={locked ? -1 : 0}
      onPointerDown={onPointerDown}
      onPointerUp={onPointerUp}
      onPointerMove={onPointerMove}
      onWheel={onWheel}
      onContextMenu={onContextMenu}
      onKeyDown={onKeyDown}
      onKeyUp={onKeyUp}
      onPaste={onPaste}
      style={{ position: 'relative', width: '100%', height: '100%', outline: 'none', overflow: 'hidden', background: '#000' }}
    >
      <canvas
        ref={canvasRef}
        className="browser-window-screencast-canvas"
        style={{ width: '100%', height: '100%', display: 'block', objectFit: 'contain', imageRendering: 'auto' }}
      />
      {connState !== 'open' && (
        <div className="browser-window-screencast-status" style={statusOverlayStyle}>
          {connState === 'connecting' && 'connecting…'}
          {connState === 'closed' && 'reconnecting…'}
          {connState === 'error' && 'connection error'}
        </div>
      )}
      {overlay && connState === 'open' && (
        <div className="browser-window-screencast-stats" style={statsOverlayStyle}>
          {overlay.fps} fps · {overlay.kbps} kbps
        </div>
      )}
    </div>
  );
});

const statusOverlayStyle: React.CSSProperties = {
  position: 'absolute', inset: 0, display: 'flex',
  alignItems: 'center', justifyContent: 'center',
  color: '#eee', fontFamily: 'system-ui, sans-serif', fontSize: 14,
  background: 'rgba(0,0,0,0.4)', pointerEvents: 'none',
};

const statsOverlayStyle: React.CSSProperties = {
  position: 'absolute', right: 8, bottom: 8,
  color: '#eee', fontFamily: 'ui-monospace, monospace', fontSize: 11,
  background: 'rgba(0,0,0,0.55)', padding: '2px 6px', borderRadius: 4,
  pointerEvents: 'none',
};

// Draw a small synthetic cursor at the last reported mouse position. The CDP
// screencast frames do not include the OS cursor, so without this the user
// sees their pointer hovering "above" the canvas with nothing on the rendered
// page that suggests where it actually is to the browser.
function drawCursor(
  ctx: CanvasRenderingContext2D,
  pageX: number, pageY: number,
  _frameW: number, _frameH: number,
  _cv: HTMLCanvasElement,
) {
  if (!pageX && !pageY) return;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(pageX, pageY);
  ctx.lineTo(pageX + 12, pageY + 4);
  ctx.lineTo(pageX + 4, pageY + 12);
  ctx.closePath();
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.strokeStyle = 'rgba(0,0,0,0.85)';
  ctx.lineWidth = 1;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

// Minimal subset of "JS key string → Windows virtual key code" needed for
// CDP keyDown/keyUp to fire the right page-level handlers (Enter, Tab,
// arrow keys, etc.). Letters/digits already work via the `text`/`key` fields;
// these are the ones whose semantics depend on the VK code.
function keyToVirtualKeyCode(key: string): number | undefined {
  switch (key) {
    case 'Backspace': return 8;
    case 'Tab':       return 9;
    case 'Enter':     return 13;
    case 'Shift':     return 16;
    case 'Control':   return 17;
    case 'Alt':       return 18;
    case 'Escape':    return 27;
    case ' ':         return 32;
    case 'PageUp':    return 33;
    case 'PageDown':  return 34;
    case 'End':       return 35;
    case 'Home':      return 36;
    case 'ArrowLeft': return 37;
    case 'ArrowUp':   return 38;
    case 'ArrowRight':return 39;
    case 'ArrowDown': return 40;
    case 'Insert':    return 45;
    case 'Delete':    return 46;
    case 'Meta':      return 91;
    default: return undefined;
  }
}
