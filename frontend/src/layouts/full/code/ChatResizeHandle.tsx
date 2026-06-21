// Vertical drag handle for the chat / code-view boundary.
//
// Modeled on `Splitter.tsx`: a flex sibling between #view-chat and CodeView
// styled with the shared `.splitter` chrome so it looks/feels identical to
// the chat ↔ workflow divider in Split mode. Uses document-level mouse +
// touch listeners (same pattern as Splitter) instead of pointer capture.
//
// We persist the chat column width in pixels — not a fraction — because the
// natural UX here is "I dragged the seam to here", which should survive a
// window resize. The width is written to `--cv-chat-width` on #main-views;
// the CSS rule in `code.css` consumes that custom property on #view-chat.

import { useEffect } from 'react';

const LS_KEY = 'yha.codeView.chatColumnPx';
const MIN_PX = 280;
const MAX_FRAC = 0.7;

function applyWidthPx(host: HTMLElement, px: number) {
  host.style.setProperty('--cv-chat-width', `${px}px`);
}

function loadInitial(): number | null {
  try {
    const v = parseInt(localStorage.getItem(LS_KEY) || '', 10);
    if (Number.isFinite(v) && v >= MIN_PX) return v;
  } catch {}
  return null;
}

export function ChatResizeHandle() {
  // Apply persisted width on mount and clean the custom property on unmount
  // so other layouts never inherit our value.
  useEffect(() => {
    const host = document.getElementById('main-views');
    if (!host) return;
    const px = loadInitial();
    if (px !== null) applyWidthPx(host, px);
    return () => {
      host.style.removeProperty('--cv-chat-width');
    };
  }, []);

  function startDrag(startX: number) {
    const host = document.getElementById('main-views');
    const chat = document.getElementById('view-chat');
    if (!host || !chat) return null;
    const startPx = chat.getBoundingClientRect().width;
    const total = host.getBoundingClientRect().width;
    return { host, startX, startPx, max: total * MAX_FRAC };
  }

  function persist(host: HTMLElement) {
    const chat = document.getElementById('view-chat');
    if (!chat) return;
    try { localStorage.setItem(LS_KEY, String(Math.round(chat.getBoundingClientRect().width))); } catch {}
    // Force one read of the custom property to settle the layout for any
    // observers that listen on resize — no-op if everything is already in
    // sync.
    void host.offsetWidth;
  }

  function handleMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    e.preventDefault();
    const ctx = startDrag(e.clientX);
    if (!ctx) return;
    function onMove(ev: MouseEvent) {
      const next = Math.max(MIN_PX, Math.min(ctx!.max, ctx!.startPx + (ev.clientX - ctx!.startX)));
      applyWidthPx(ctx!.host, next);
    }
    function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      persist(ctx!.host);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function handleTouchStart(e: React.TouchEvent<HTMLDivElement>) {
    const t0 = e.touches[0];
    if (!t0) return;
    e.preventDefault();
    const ctx = startDrag(t0.clientX);
    if (!ctx) return;
    function onMove(ev: TouchEvent) {
      const tc = ev.touches[0];
      if (!tc) return;
      const next = Math.max(MIN_PX, Math.min(ctx!.max, ctx!.startPx + (tc.clientX - ctx!.startX)));
      applyWidthPx(ctx!.host, next);
    }
    function onEnd() {
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend', onEnd);
      persist(ctx!.host);
    }
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);
  }

  function resetWidth() {
    const host = document.getElementById('main-views');
    if (!host) return;
    host.style.removeProperty('--cv-chat-width');
    try { localStorage.removeItem(LS_KEY); } catch {}
  }

  return (
    <div
      id="cv-chat-splitter"
      className="splitter"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize chat column"
      onMouseDown={handleMouseDown}
      onTouchStart={handleTouchStart}
      onDoubleClick={resetWidth}
    />
  );
}
