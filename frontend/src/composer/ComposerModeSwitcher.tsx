// ComposerModeSwitcher — compact mode picker rendered inside the chat bar's
// right-rest area. Default view shows only the active mode's icon; clicking it
// opens a small popover with the inactive options (icon + label). Picking one
// switches mode and closes the popover.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore } from '../stores/appStore.js';
import type { ComposerMode } from '../stores/appStore.js';
import { COMPOSER_MODES } from '../stores/appStore.js';
import { ComposerModeIcon } from './modeIcons.js';

const LABELS: Record<ComposerMode, string> = {
  chat: 'Chat',
  image: 'Image',
  audio: 'Audio',
  video: 'Video',
};

export function ComposerModeSwitcher() {
  const mode = useAppStore((s) => s.composerMode);
  const setMode = useAppStore((s) => s.setComposerMode);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const popRef = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocPointer(e: MouseEvent) {
      const t = e.target as Node;
      if (rootRef.current?.contains(t)) return;
      if (popRef.current?.contains(t)) return;
      setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    function onReposition() {
      const b = btnRef.current?.getBoundingClientRect();
      if (b) setPos({ left: b.left + b.width / 2, bottom: window.innerHeight - b.top + 6 });
    }
    document.addEventListener('mousedown', onDocPointer, true);
    document.addEventListener('keydown', onEsc, true);
    window.addEventListener('resize', onReposition);
    window.addEventListener('scroll', onReposition, true);
    return () => {
      document.removeEventListener('mousedown', onDocPointer, true);
      document.removeEventListener('keydown', onEsc, true);
      window.removeEventListener('resize', onReposition);
      window.removeEventListener('scroll', onReposition, true);
    };
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const b = btnRef.current?.getBoundingClientRect();
    if (b) setPos({ left: b.left + b.width / 2, bottom: window.innerHeight - b.top + 6 });
  }, [open]);

  const others = COMPOSER_MODES.filter((m) => m !== mode);

  return (
    <div
      ref={rootRef}
      className={`composer-mode-switch${open ? ' open' : ''}`}
      role="group"
      aria-label="Composer mode"
    >
      <button
        ref={btnRef}
        type="button"
        className="cms-active"
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Mode: ${LABELS[mode]} (click to change)`}
        onClick={() => setOpen((v) => !v)}
      >
        <ComposerModeIcon mode={mode} size={14} />
      </button>
      {open && pos && createPortal(
        <div
          ref={popRef}
          className="popover cms-popover"
          role="menu"
          style={{ left: `${pos.left}px`, bottom: `${pos.bottom}px` }}
        >
          {others.map((m) => (
            <button
              key={m}
              type="button"
              role="menuitem"
              className="popover-item cms-opt"
              onClick={() => {
                setMode(m);
                setOpen(false);
              }}
            >
              <ComposerModeIcon mode={m} size={14} className="cms-opt-icon" />
              <span className="cms-label">{LABELS[m]}</span>
            </button>
          ))}
        </div>,
        document.body,
      )}
    </div>
  );
}
