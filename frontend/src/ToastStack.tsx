// ToastStack — renders toast notifications via a React portal.
// Replaces the imperative DOM creation in toast.ts.
// Uses existing CSS classes from layout.css (.toast, .toast--visible, etc.)

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useToastStore, type ToastEntry } from './stores/toastStore.js';

// ── Individual toast ───────────────────────────────────────────────────────

const ICONS: Record<string, string> = {
  success:
    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><polyline points="4,10 8,14 16,6"/></svg>',
  error:
    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="5" x2="15" y2="15"/><line x1="15" y1="5" x2="5" y2="15"/></svg>',
  warning:
    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 3L18 17H2Z"/><line x1="10" y1="9" x2="10" y2="13"/><circle cx="10" cy="15.5" r="0.5" fill="currentColor"/></svg>',
  info:
    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"><circle cx="10" cy="10" r="8"/><line x1="10" y1="9" x2="10" y2="14"/><circle cx="10" cy="6.5" r="0.5" fill="currentColor"/></svg>',
  running:
    '<svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" class="toast-spin"><circle cx="10" cy="10" r="7" stroke-dasharray="22 22" stroke-dashoffset="11"/></svg>',
};

function Toast({ entry, onDismiss }: { entry: ToastEntry; onDismiss: (id: string) => void }) {
  const [visible, setVisible] = useState(false);
  const [out, setOut] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pausedRef = useRef(false);
  const remainingRef = useRef(entry.duration);
  const startedAtRef = useRef<number>(0);

  function startTimer(ms: number) {
    if (ms <= 0) return;
    startedAtRef.current = Date.now();
    remainingRef.current = ms;
    timerRef.current = setTimeout(() => dismiss(), ms);
  }

  function pauseTimer() {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
      remainingRef.current = Math.max(0, remainingRef.current - (Date.now() - startedAtRef.current));
      pausedRef.current = true;
    }
  }

  function resumeTimer() {
    if (pausedRef.current) {
      pausedRef.current = false;
      startTimer(remainingRef.current * 0.5); // resume at 50% remaining (matches toast.ts behaviour)
    }
  }

  function dismiss() {
    if (timerRef.current) clearTimeout(timerRef.current);
    setOut(true);
    setVisible(false);
    setTimeout(() => onDismiss(entry.id), 350);
  }

  useEffect(() => {
    // Animate in on mount
    const raf = requestAnimationFrame(() => setVisible(true));
    if (entry.duration > 0) startTimer(entry.duration);
    return () => {
      cancelAnimationFrame(raf);
      if (timerRef.current) clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const cls = [
    'toast',
    `toast--${entry.type}`,
    visible ? 'toast--visible' : '',
    out ? 'toast--out' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div
      className={cls}
      onMouseEnter={pauseTimer}
      onMouseLeave={resumeTimer}
    >
      <span
        className="toast-icon"
        dangerouslySetInnerHTML={{ __html: ICONS[entry.type] ?? ICONS.info }}
      />
      <div className="toast-body">
        {entry.title && <div className="toast-title">{entry.title}</div>}
        <div className="toast-msg">{entry.message}</div>
      </div>
      <button className="toast-close" onClick={dismiss} aria-label="Dismiss">
        <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2">
          <line x1="5" y1="5" x2="15" y2="15" />
          <line x1="15" y1="5" x2="5" y2="15" />
        </svg>
      </button>
    </div>
  );
}

// ── Stack container ────────────────────────────────────────────────────────

export function ToastStack() {
  const toasts = useToastStore((s) => s.toasts);
  const position = useToastStore((s) => s.position);
  const dismiss = useToastStore((s) => s.dismiss);

  const content = (
    <div id="toast-stack" data-position={position}>
      {toasts.map((t) => (
        <Toast key={t.id} entry={t} onDismiss={dismiss} />
      ))}
    </div>
  );

  return createPortal(content, document.body);
}
