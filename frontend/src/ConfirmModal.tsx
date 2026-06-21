// ConfirmModal — single global confirmation dialog driven by useConfirmStore.
// Renders into document.body via a portal, like ToastStack. The store enforces
// "one modal at a time" so we don't need to manage a queue here.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useConfirmStore } from './stores/confirmStore.js';

export function ConfirmModal() {
  const active = useConfirmStore((s) => s.active);
  const resolve = useConfirmStore((s) => s.resolve);
  const [visible, setVisible] = useState(false);
  const confirmBtnRef = useRef<HTMLButtonElement | null>(null);

  // Animate in on each new entry; reset on close.
  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }
    const raf = requestAnimationFrame(() => setVisible(true));
    // Focus the confirm button so Enter/Space confirms immediately.
    const focusRaf = requestAnimationFrame(() => confirmBtnRef.current?.focus());
    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(focusRaf);
    };
  }, [active?.id]);

  // Esc cancels, Enter confirms (button focus already covers Enter, but
  // keep an explicit handler so it also works if focus drifts).
  useEffect(() => {
    if (!active) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        resolve(false);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        resolve(true);
      }
    }
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [active, resolve]);

  if (!active) return null;

  const cls = ['confirm-modal', visible ? 'confirm-modal--visible' : '']
    .filter(Boolean)
    .join(' ');

  const danger = active.danger !== false;

  const content = (
    <div
      className="confirm-backdrop"
      data-visible={visible ? 'true' : 'false'}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) resolve(false);
      }}
    >
      <div className={cls} role="dialog" aria-modal="true" aria-labelledby={active.title ? 'confirm-title' : undefined}>
        {active.title && (
          <div id="confirm-title" className="confirm-title">{active.title}</div>
        )}
        <div className="confirm-msg">{active.message}</div>
        <div className="confirm-actions">
          <button
            className="confirm-btn confirm-btn--cancel"
            onClick={() => resolve(false)}
            type="button"
          >
            {active.cancelLabel || 'Cancel'}
          </button>
          <button
            ref={confirmBtnRef}
            className={`confirm-btn ${danger ? 'confirm-btn--danger' : 'confirm-btn--primary'}`}
            onClick={() => resolve(true)}
            type="button"
          >
            {active.confirmLabel || 'Confirm'}
          </button>
        </div>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
