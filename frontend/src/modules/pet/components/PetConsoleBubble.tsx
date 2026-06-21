// PetConsoleBubble — the speech-bubble that pops next to the floating pet
// and houses BOTH the quick-chat console AND the routed toast notifications
// (Phase 1.5 of the ContextGenerator pipeline).
//
// Layout
// ──────
//   ┌────────────────────────────────────┐
//   │  conversation history (scrollable) │  ← 3–5 lines visible, scrolls past
//   │  ── divider ──                     │
//   │  toast bubbles (auto-dismiss)      │  ← below user content per spec
//   │  one-line input ▸ Enter to send    │
//   │  cheap-model · NVIDIA · 132ms      │  ← tiny status
//   └────────────────────────────────────┘
//
// Positioning
// ───────────
// Anchored to the live `.pet-overlay` element via getBoundingClientRect,
// re-measured on every animation frame while open. The bubble sits to the
// SIDE of the pet (left if the pet is on the right half of the viewport,
// right otherwise) and never pushes the pet off-screen — clamped to the
// viewport with an 8 px gutter, same convention as the pet itself.
//
// Lifecycle
// ─────────
// Two visible modes (added 2026-05-06 to stop toast-driven focus-steal):
//
//   1. FULL CONSOLE — `consoleOpen === true`
//      Renders history + input + status footer + queued toasts beneath.
//      Set ONLY by an explicit user gesture: click on the pet (gated in
//      FloatingPet), or submitting a question (the user typed into it).
//      Closes on Escape, "×", or click outside (but not on the pet itself
//      — clicking the pet toggles).
//
//   2. MINIMAL TOAST POPOVER — `consoleOpen === false && toastBubbles > 0`
//      Renders ONLY the queued toast rows in a compact card next to the
//      pet. No input, no history, no status footer, no autofocus. Auto-
//      dismisses each row after its `duration`. Click anywhere outside
//      does nothing (the toasts dismiss themselves). Click on the pet
//      escalates to FULL CONSOLE (the gate flips `consoleOpen`).
//
// In both modes the bubble is anchored to `.pet-overlay` via rAF-driven
// getBoundingClientRect so it follows patrol/jump animations.

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { usePetStore } from '../store/petStore.js';
import { usePetConsoleStore, type PetToastBubble } from '../store/petConsoleStore.js';

// ── Constants ────────────────────────────────────────────────────────────────

const BUBBLE_W       = 320;
const BUBBLE_GUTTER  = 12;        // px between pet edge and bubble
const VIEWPORT_PAD   = 8;
/** Side preference. The pet typically lives on the LEFT of the chat input
 *  area; the bubble appears to the RIGHT by default so it doesn't poke off
 *  the screen. We flip when the pet is in the right half of the viewport. */
const FALLBACK_SIDE: 'left' | 'right' = 'right';

interface AnchorRect {
  left:   number;
  top:    number;
  right:  number;
  bottom: number;
  width:  number;
  height: number;
}

// ── Toast bubble row (one routed toast) ─────────────────────────────────────

function ToastBubbleRow({ entry, onDismiss }: { entry: PetToastBubble; onDismiss: (id: string) => void }) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (entry.duration > 0) {
      timerRef.current = setTimeout(() => onDismiss(entry.id), entry.duration);
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entry.id, entry.duration]);

  return (
    <div className={`pet-bubble-toast pet-bubble-toast--${entry.type}`}>
      {entry.title ? <div className="pet-bubble-toast-title">{entry.title}</div> : null}
      <div className="pet-bubble-toast-msg">{entry.message}</div>
      <button
        type="button"
        className="pet-bubble-toast-close"
        aria-label="Dismiss"
        onClick={() => onDismiss(entry.id)}
      >
        ×
      </button>
    </div>
  );
}

// ── Main bubble ──────────────────────────────────────────────────────────────

export function PetConsoleBubble() {
  const consoleOpen  = usePetConsoleStore((s) => s.consoleOpen);
  const history      = usePetConsoleStore((s) => s.history);
  const pending      = usePetConsoleStore((s) => s.pending);
  const error        = usePetConsoleStore((s) => s.error);
  const modelLabel   = usePetConsoleStore((s) => s.modelLabel);
  const toastBubbles = usePetConsoleStore((s) => s.toastBubbles);
  const setOpen      = usePetConsoleStore((s) => s.setOpen);
  const ask          = usePetConsoleStore((s) => s.ask);
  const abortPending = usePetConsoleStore((s) => s.abortPending);
  const dismissBub   = usePetConsoleStore((s) => s.dismissToastBubble);
  const refreshStatus = usePetConsoleStore((s) => s.refreshStatus);

  const isPetVisible = usePetStore((s) => s.isVisible);

  const [input, setInput] = useState('');
  const [anchor, setAnchor] = useState<AnchorRect | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const historyRef = useRef<HTMLDivElement | null>(null);
  // Cached `.pet-overlay` node — see readPetRect. Held across rAF ticks so
  // we don't re-query the DOM 60×/s while a (possibly passive) toast shows.
  const petElRef = useRef<HTMLElement | null>(null);

  // The bubble is "live" (worth measuring + rendering) whenever EITHER
  // mode is active. Computed once per render so we don't repeat the
  // condition in every effect.
  const minimalToastOnly = !consoleOpen && toastBubbles.length > 0;
  const anyVisible = isPetVisible && (consoleOpen || minimalToastOnly);

  // Read the live pet rect, reusing the cached `.pet-overlay` node. The
  // rAF loop below runs every frame while the bubble is live (both modes,
  // including passive toasts), so document.querySelector per tick was pure
  // waste once the node is found — we cache it and only re-query when it's
  // missing or detached (the pet hide→show cycle remounts the overlay).
  // getBoundingClientRect still runs per frame: that's what tracks the
  // pet's patrol/jump animation and can't be cached, but it's cheap when
  // the position is steady because the setAnchor short-circuit below skips
  // the state write, so no layout-thrashing write precedes the next read.
  const readPetRect = useCallback((): AnchorRect | null => {
    let el = petElRef.current;
    if (!el || !el.isConnected) {
      el = document.querySelector<HTMLElement>('.pet-overlay');
      petElRef.current = el;
    }
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 10 || r.height < 10) return null;
    return {
      left:   r.left,
      top:    r.top,
      right:  r.right,
      bottom: r.bottom,
      width:  r.width,
      height: r.height,
    };
  }, []);

  // Re-measure the pet position on every rAF tick while *anything* is
  // visible so the bubble follows patrol/jump animations without a
  // ResizeObserver dance. (requestAnimationFrame is auto-paused by the
  // browser while the tab is hidden, so no visibility gate is needed.)
  useLayoutEffect(() => {
    if (!anyVisible) return;
    let raf = 0;
    const tick = () => {
      const next = readPetRect();
      setAnchor((prev) => {
        if (!next) return null;
        if (
          prev &&
          Math.abs(prev.left - next.left) < 0.5 &&
          Math.abs(prev.top - next.top) < 0.5
        ) {
          return prev;
        }
        return next;
      });
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [anyVisible, readPetRect]);

  // Refresh model status once when the FULL console first opens — gives
  // the user a live "cheap-model · NVIDIA" line and doubles as a passive
  // health probe. Skipped for minimal-toast mode (no status footer there).
  useEffect(() => {
    if (consoleOpen && !modelLabel) {
      void refreshStatus();
    }
  }, [consoleOpen, modelLabel, refreshStatus]);

  // Autofocus input ONLY when the FULL console is open — the minimal-toast
  // popover must never pull focus from whatever the user is typing into.
  useEffect(() => {
    if (!consoleOpen) return;
    const t = setTimeout(() => inputRef.current?.focus(), 30);
    return () => clearTimeout(t);
  }, [consoleOpen]);

  // Auto-scroll history to bottom when new turns arrive (or on open).
  useEffect(() => {
    if (!consoleOpen) return;
    const el = historyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [history.length, consoleOpen]);

  // Escape closes the FULL console. Click-outside handled below.
  // Minimal-toast mode ignores Escape — the toasts auto-dismiss themselves.
  useEffect(() => {
    if (!consoleOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setOpen(false);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [consoleOpen, setOpen]);

  // Click-outside: only active in FULL console mode. In minimal-toast
  // mode the popover is non-interactive (no input, no focus) so an
  // outside click never needs to "close" anything — the user is busy in
  // the chat input and the popover stays out of their way until each
  // toast auto-dismisses.
  useEffect(() => {
    if (!consoleOpen) return;
    const onPointer = (e: PointerEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      if (bubbleRef.current?.contains(target)) return;
      if (target.closest('.pet-overlay')) return;
      setOpen(false);
    };
    // capture: catch clicks that other handlers stopPropagate'd before
    // they bubble to document.
    window.addEventListener('pointerdown', onPointer, true);
    return () => window.removeEventListener('pointerdown', onPointer, true);
  }, [consoleOpen, setOpen]);

  const onSubmit = useCallback(
    (e?: React.FormEvent) => {
      e?.preventDefault();
      // Form submit fires the action button: send a new turn OR — while a
      // turn is in flight — abort it. Mirrors the chat-send / chat-stop
      // morphing in the main chat-bar.
      if (pending) {
        abortPending();
        return;
      }
      const v = input.trim();
      if (!v) return;
      setInput('');
      void ask(v);
    },
    [input, pending, ask, abortPending],
  );

  // Compute bubble position. If we have no anchor yet (pet just rendered),
  // park it in a default corner so the user still sees toast bubbles fire.
  if (!anyVisible) return null;

  const vpW = window.innerWidth;
  const vpH = window.innerHeight;

  let placement: { left: number; top: number; side: 'left' | 'right' };
  if (anchor) {
    // Prefer the side opposite the pet's centre-of-mass.
    const petCenterX = anchor.left + anchor.width / 2;
    const wantSide: 'left' | 'right' = petCenterX > vpW / 2 ? 'left' : 'right';
    let left =
      wantSide === 'right'
        ? anchor.right + BUBBLE_GUTTER
        : anchor.left - BUBBLE_W - BUBBLE_GUTTER;
    // Vertical: align the bubble's bottom near the pet's top so it floats
    // ABOVE the pet's head — but clamp to viewport.
    let top = anchor.top - 8;
    // Clamp horizontal — fall back to the other side if we'd clip.
    let actualSide = wantSide;
    if (left + BUBBLE_W > vpW - VIEWPORT_PAD) {
      left = anchor.left - BUBBLE_W - BUBBLE_GUTTER;
      actualSide = 'left';
    }
    if (left < VIEWPORT_PAD) {
      left = anchor.right + BUBBLE_GUTTER;
      actualSide = 'right';
    }
    left = Math.max(VIEWPORT_PAD, Math.min(vpW - BUBBLE_W - VIEWPORT_PAD, left));
    top  = Math.max(VIEWPORT_PAD, Math.min(vpH - 200, top));
    placement = { left, top, side: actualSide };
  } else {
    placement = {
      left: FALLBACK_SIDE === 'right' ? vpW - BUBBLE_W - 80 : 80,
      top:  vpH - 380,
      side: FALLBACK_SIDE,
    };
  }

  // ── Minimal-toast mode ────────────────────────────────────────────────
  // Compact card, only the routed toast rows, no input/history/footer.
  // Strictly non-focusing — the user's chat input keeps focus while these
  // float in. Auto-dismiss is handled per-row by ToastBubbleRow.
  if (minimalToastOnly) {
    return createPortal(
      <div
        ref={bubbleRef}
        className={`pet-bubble pet-bubble--minimal pet-bubble--${placement.side}`}
        style={{
          position: 'fixed',
          left:     placement.left,
          top:      placement.top,
          width:    BUBBLE_W,
          zIndex:   2147483640,
        }}
        role="status"
        aria-live="polite"
        aria-label="Pet notifications"
        // Do NOT autofocus or trap focus — explicitly preserve whatever the
        // user is currently typing into.
        tabIndex={-1}
      >
        <div className="pet-bubble-toasts pet-bubble-toasts--bare">
          {toastBubbles.map((entry) => (
            <ToastBubbleRow key={entry.id} entry={entry} onDismiss={dismissBub} />
          ))}
        </div>
      </div>,
      document.body,
    );
  }

  // ── Full console mode ────────────────────────────────────────────────
  return createPortal(
    <div
      ref={bubbleRef}
      className={`pet-bubble pet-bubble--${placement.side}`}
      style={{
        position: 'fixed',
        left:     placement.left,
        top:      placement.top,
        width:    BUBBLE_W,
        zIndex:   2147483640, // above the pet (which lives at a high z) but below modal hosts
      }}
      role="dialog"
      aria-label="Pet console"
    >
      <button
        type="button"
        className="pet-bubble-close"
        aria-label="Close pet console"
        onClick={() => setOpen(false)}
      >
        ×
      </button>

      {/* Conversation history — 3–5 lines visible, scrolls past. */}
      <div className="pet-bubble-history" ref={historyRef}>
        {history.length === 0 ? (
          <div className="pet-bubble-empty">
            Hi! Ask me anything — short answers only.
          </div>
        ) : (
          history.map((t) => (
            <div
              key={t.id}
              className={[
                'pet-bubble-turn',
                `pet-bubble-turn--${t.role}`,
                t.isError ? 'pet-bubble-turn--error' : '',
              ]
                .filter(Boolean)
                .join(' ')}
            >
              {t.text}
              {/* Tool usage annotation — only shown for assistant turns that
                  actually invoked tools during the bridge tool-loop. Compact
                  one-liner so it doesn't push the user's question off-screen
                  in the 5-line bubble window. */}
              {t.role === 'assistant' && t.toolsUsed && t.toolsUsed.length ? (
                <div
                  className="pet-bubble-tools-used"
                  title={`Tools used: ${t.toolsUsed.join(', ')}`}
                >
                  🔧 {t.toolsUsed.join(', ')}
                </div>
              ) : null}
            </div>
          ))
        )}
        {pending ? (
          <div className="pet-bubble-turn pet-bubble-turn--pending">…</div>
        ) : null}
      </div>

      {/* Routed toasts — sit BELOW the user conversation so they never
          push the user's own messages out of the visible window. */}
      {toastBubbles.length > 0 ? (
        <div className="pet-bubble-toasts">
          {toastBubbles.map((entry) => (
            <ToastBubbleRow key={entry.id} entry={entry} onDismiss={dismissBub} />
          ))}
        </div>
      ) : null}

      <form className="pet-bubble-input-row" onSubmit={onSubmit}>
        <input
          ref={inputRef}
          type="text"
          className="pet-bubble-input"
          value={input}
          maxLength={600}
          placeholder={pending ? 'Pet is thinking…' : 'Ask the pet…'}
          disabled={pending}
          onChange={(e) => setInput(e.target.value)}
        />
        <button
          type="submit"
          className={`pet-bubble-send${pending ? ' is-stop' : ''}`}
          disabled={!pending && !input.trim()}
          aria-label={pending ? 'Stop' : 'Send'}
          title={pending ? 'Stop (abort the in-flight pet turn)' : 'Send'}
        >
          <span className="pet-bubble-send-icon" aria-hidden="true">
            {pending ? '◼' : '▸'}
          </span>
        </button>
      </form>

      <div className="pet-bubble-status">
        {error ? (
          <span className="pet-bubble-status-error">⚠ {error}</span>
        ) : (
          <span className="pet-bubble-status-model">
            {modelLabel || 'cheap-lane'}
          </span>
        )}
      </div>
    </div>,
    document.body,
  );
}
