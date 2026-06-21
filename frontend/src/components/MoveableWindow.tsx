// Generic moveable, resizable, fullscreen-toggleable window frame. Lifted
// out of BrowserWindow so the file editor (and any future moveable surface)
// can reuse the same drag/resize/persist/clamp/Escape behaviour without
// duplicating it.
//
// Each consumer passes a unique storageKey so its geometry persists in
// localStorage independently of other windows.

import {
  useCallback, useEffect, useImperativeHandle, useRef, useState,
  type ReactNode, type Ref, type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { createPortal } from 'react-dom';

interface Geometry {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type MoveableDragInitEvent =
  | ReactMouseEvent | ReactPointerEvent | MouseEvent | PointerEvent;

export interface MoveableWindowHandle {
  startDrag: (e: MoveableDragInitEvent) => void;
}

export interface MoveableWindowProps {
  isOpen: boolean;
  title: ReactNode;
  storageKey: string;
  defaultGeometry?: Partial<Geometry>;
  minWidth?: number;
  minHeight?: number;
  zIndex?: number;
  onClose: () => void;
  closeOnOutsideClick?: boolean;
  closeOnEscape?: boolean;
  headerExtras?: ReactNode;
  bodyClassName?: string;
  cardClassName?: string;
  overlayClassName?: string;
  footer?: ReactNode;
  children: ReactNode;
  ref?: Ref<MoveableWindowHandle>;
}

// Keep the window fully inside the viewport. Width/height shrink to fit if
// they would otherwise overflow — even past minWidth/minHeight on tiny screens,
// since "respect the user's resize floor" matters less than "actually visible
// on a phone". Once size is clamped, position is clamped so the right/bottom
// edge can't escape the viewport either.
//
// Compensates for the small-screen `html { zoom: 0.9 }` rule: the overlay
// uses `position: absolute; inset: 0` which fills html's *unzoomed* layout
// box (733 on a 660-px viewport at zoom 0.9), and the card lives inside
// that coordinate space. window.innerWidth (and html.clientWidth) report
// the visual viewport (660), so using those to clamp would shrink the card
// 10% and leave the same right/bottom gutter the layout fix addressed.
// Dividing the visual viewport by html's effective zoom gives the layout-
// space dimensions the card actually needs.
function getZoom() {
  return parseFloat(getComputedStyle(document.documentElement).zoom) || 1;
}

function viewportSize() {
  const zoom = getZoom();
  return {
    vw: Math.round(window.innerWidth  / zoom),
    vh: Math.round(window.innerHeight / zoom),
  };
}

function clampGeometry(g: Geometry, _minW: number, _minH: number): Geometry {
  const { vw, vh } = viewportSize();
  const width  = Math.min(g.width,  vw);
  const height = Math.min(g.height, vh);
  const maxLeft = Math.max(0, vw - width);
  const maxTop  = Math.max(0, vh - height);
  return {
    width, height,
    left: Math.min(maxLeft, Math.max(0, g.left)),
    top:  Math.min(maxTop,  Math.max(0, g.top)),
  };
}

function computeInitialGeometry(
  storageKey: string,
  defaults: Partial<Geometry>,
  minW: number,
  minH: number,
): Geometry {
  const w = defaults.width  ?? 960;
  const h = defaults.height ?? 640;
  const { vw, vh } = viewportSize();
  const fallback: Geometry = {
    left: defaults.left ?? Math.max(40, Math.round(vw / 2 - w / 2)),
    top:  defaults.top  ?? Math.max(40, Math.round(vh / 2 - h / 2)),
    width: w,
    height: h,
  };
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return fallback;
    const g = JSON.parse(raw);
    if (typeof g.left === 'number' && typeof g.top === 'number'
        && typeof g.width === 'number' && typeof g.height === 'number') {
      return clampGeometry(g, minW, minH);
    }
  } catch {}
  return fallback;
}

export function MoveableWindow(props: MoveableWindowProps) {
  const {
    isOpen, title, storageKey,
    defaultGeometry = {},
    minWidth = 360, minHeight = 260,
    zIndex = 1200,
    onClose,
    closeOnOutsideClick = false,
    closeOnEscape = true,
    headerExtras, bodyClassName, cardClassName, overlayClassName,
    footer, children,
    ref,
  } = props;

  const [geometry, setGeometry] = useState<Geometry>(() =>
    computeInitialGeometry(storageKey, defaultGeometry, minWidth, minHeight)
  );
  const [isFullscreen, setIsFullscreen] = useState(false);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const geomRef = useRef<Geometry>(geometry);
  const fsRef = useRef(false);

  useEffect(() => { geomRef.current = geometry; }, [geometry]);
  useEffect(() => { fsRef.current = isFullscreen; }, [isFullscreen]);

  const persist = useCallback((g: Geometry) => {
    try { localStorage.setItem(storageKey, JSON.stringify(g)); } catch {}
  }, [storageKey]);

  const startDrag = useCallback((e: MoveableDragInitEvent) => {
    if (fsRef.current) return;
    const target = e.target as HTMLElement | null;
    if (target?.closest('button')) return;
    e.preventDefault();
    const pid = (e as PointerEvent).pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    const baseLeft = geomRef.current.left;
    const baseTop = geomRef.current.top;
    const baseWidth = geomRef.current.width;
    const baseHeight = geomRef.current.height;
    cardRef.current?.classList.add('dragging');

    function onMove(ev: PointerEvent) {
      if (pid !== undefined && ev.pointerId !== pid) return;
      // Pointer events are in visual-viewport CSS pixels; the card lives in
      // html's unzoomed layout coordinate space — divide by zoom so a 100-px
      // finger drag moves the card by 100 layout pixels on phones.
      const z = getZoom();
      const dx = (ev.clientX - startX) / z;
      const dy = (ev.clientY - startY) / z;
      const { vw, vh } = viewportSize();
      const maxLeft = Math.max(0, vw - baseWidth);
      const maxTop  = Math.max(0, vh - baseHeight);
      const nx = Math.min(maxLeft, Math.max(0, baseLeft + dx));
      const ny = Math.min(maxTop,  Math.max(0, baseTop  + dy));
      setGeometry((g) => ({ ...g, left: nx, top: ny }));
    }
    function onUp(ev: PointerEvent) {
      if (pid !== undefined && ev.pointerId !== pid) return;
      cardRef.current?.classList.remove('dragging');
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      setGeometry((g) => { persist(g); return g; });
    }
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  }, [persist]);

  const startResize = useCallback((e: ReactPointerEvent) => {
    if (fsRef.current) return;
    e.preventDefault();
    e.stopPropagation();
    const pid = e.pointerId;
    const startX = e.clientX;
    const startY = e.clientY;
    const baseW = geomRef.current.width;
    const baseH = geomRef.current.height;
    const baseLeft = geomRef.current.left;
    const baseTop = geomRef.current.top;
    cardRef.current?.classList.add('resizing');

    function onMove(ev: PointerEvent) {
      if (pid !== undefined && ev.pointerId !== pid) return;
      const z = getZoom();
      const dx = (ev.clientX - startX) / z;
      const dy = (ev.clientY - startY) / z;
      const { vw, vh } = viewportSize();
      // Cap so the right/bottom edge stays on-screen; the minWidth/minHeight
      // floor still wins if the viewport can accommodate it.
      const maxW = Math.max(1, vw - baseLeft);
      const maxH = Math.max(1, vh - baseTop);
      const nw = Math.min(maxW, Math.max(Math.min(minWidth, maxW),  baseW + dx));
      const nh = Math.min(maxH, Math.max(Math.min(minHeight, maxH), baseH + dy));
      setGeometry((g) => ({ ...g, width: nw, height: nh }));
    }
    function onUp(ev: PointerEvent) {
      if (pid !== undefined && ev.pointerId !== pid) return;
      cardRef.current?.classList.remove('resizing');
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      setGeometry((g) => { persist(g); return g; });
    }
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  }, [minWidth, minHeight, persist]);

  function toggleFullscreen() {
    const card = cardRef.current;
    if (!card) return;
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else {
      card.requestFullscreen().catch(() => {});
    }
  }

  useEffect(() => {
    function onChange() { setIsFullscreen(!!document.fullscreenElement); }
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Escape closes the window — unless we're in fullscreen, in which case the
  // browser uses Escape to exit fullscreen first (a second press hits us).
  useEffect(() => {
    if (!isOpen || !closeOnEscape) return;
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      if (document.fullscreenElement) return;
      onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, closeOnEscape, onClose]);

  // Visibility guard: re-clamp on viewport changes and a lazy 4 s tick.
  useEffect(() => {
    if (!isOpen || isFullscreen) return;
    function ensureVisible() {
      setGeometry((g) => {
        const c = clampGeometry(g, minWidth, minHeight);
        if (c.left === g.left && c.top === g.top && c.width === g.width && c.height === g.height) {
          return g;
        }
        persist(c);
        return c;
      });
    }
    ensureVisible();
    window.addEventListener('resize', ensureVisible);
    const interval = window.setInterval(ensureVisible, 4000);
    return () => {
      window.removeEventListener('resize', ensureVisible);
      window.clearInterval(interval);
    };
  }, [isOpen, isFullscreen, minWidth, minHeight, persist]);

  useImperativeHandle(ref, () => ({ startDrag }), [startDrag]);

  if (!isOpen) return null;

  const cardStyle: CSSProperties = isFullscreen
    ? { position: 'fixed', inset: 0, width: '100vw', height: '100vh' }
    : ({
        position: 'absolute',
        left: geometry.left,
        top: geometry.top,
        width: geometry.width,
        height: geometry.height,
        // Feed the resize floor to the CSS min-width/height, which caps it to
        // the viewport so the card can shrink to fit small screens.
        '--mw-min-w': `${minWidth}px`,
        '--mw-min-h': `${minHeight}px`,
      } as CSSProperties);

  function handleOverlayMouseDown(e: ReactMouseEvent) {
    if (!closeOnOutsideClick) return;
    if (e.target === e.currentTarget) onClose();
  }

  const overlayCls = [
    'mw-overlay',
    closeOnOutsideClick ? 'mw-overlay-modal' : '',
    overlayClassName ?? '',
  ].filter(Boolean).join(' ');

  const cardCls = ['mw-card', cardClassName ?? ''].filter(Boolean).join(' ');
  const bodyCls = ['mw-body', bodyClassName ?? ''].filter(Boolean).join(' ');

  const content = (
    <div className={overlayCls} style={{ zIndex }} onMouseDown={handleOverlayMouseDown}>
      <div className={cardCls} style={cardStyle} ref={cardRef}>
        <header className="mw-header" onPointerDown={startDrag}>
          <span className="mw-title">{title}</span>
          <div className="mw-spacer" />
          {headerExtras}
          <button
            className="mw-btn"
            type="button"
            title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
            onClick={toggleFullscreen}
          >⛶</button>
          <button
            className="mw-btn"
            type="button"
            title="Close"
            onClick={onClose}
          >✕</button>
        </header>

        <div className={bodyCls}>{children}</div>

        {footer}

        {!isFullscreen && (
          <div className="mw-resize" onPointerDown={startResize} title="Drag to resize" />
        )}
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
