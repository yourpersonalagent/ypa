// QuickContextPicker — input-popover Shell #1 of the ContextGenerator pipeline.
// Phase 1a / Adaption 3 + 4 + 6.   Unified-shells refactor: 2026-05-07.
//
// Mounts at the #context button (formerly #note) in the chat input bar and
// delegates rendering to the same `HubContextSessionPicker` component the
// Hub's "By context" view uses. Both shells now behave identically:
//
//   • Click on a row title  → switches the active chat session (and, for
//                              notes, scrolls the exact note message into
//                              view via `setScrollIntent`).
//   • "Post context" button → pastes the session transcript / note body
//                              into the chat input as a markdown block.
//
// The only thing the popover variant does differently from the modal Hub
// variant is that it boots with the 📝 Notes accordion section open by
// default — `defaultOpenCategories={['notes']}`. The user's brief was
// "beide ident, nur input startet auf notes".
//
// Architecture:
//   • All engine state lives in HubContextSessionPicker (graph + notes
//     fetch, accordion, filter, post-action).
//   • This file owns ONLY: the popover shell + position math + ESC /
//     click-outside dismissal + the shim that re-routes the legacy
//     #chat-notes-btn click.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { HubContextSessionPicker } from '../context/HubContextSessionPicker.js';

interface PanelProps {
  onClose: () => void;
  anchor:  DOMRect | null;
}

function PanelContent({ onClose, anchor }: PanelProps) {
  const overlayRef = useRef<HTMLDivElement>(null);

  // Close on outside click + ESC, mirroring NotePanel/CommandPicker.
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (overlayRef.current && !overlayRef.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  // Position the popover above the trigger button, mimicking NotePanel.
  // Wider than the legacy QuickPicker (380→440) because the by-context
  // accordion needs room for the 📝 + title + post button on one row.
  const width  = 440;
  const margin = 8;
  const gap    = 6;
  const vw     = window.innerWidth;
  // Cap height to the space between the viewport top and the trigger so the
  // popover can never grow past the browser's top border — matters when the
  // trigger sits high (e.g. chat-empty-state in full layout where the input
  // is centered vertically). Without this `maxHeight: 70vh` overflows.
  const availableAbove = anchor ? Math.max(120, anchor.top - margin - gap) : 0;
  const style: React.CSSProperties = anchor
    ? {
        position: 'fixed',
        bottom:   window.innerHeight - anchor.top + gap,
        left:     Math.max(margin, Math.min(vw - width - margin, anchor.left)),
        width,
        maxHeight: `min(70vh, ${availableAbove}px)`,
        background: 'var(--bg, #1a1a1a)',
        border:     '1px solid var(--border, #333)',
        borderRadius: 8,
        boxShadow:  '0 12px 40px rgba(0,0,0,0.5)',
        display:    'flex',
        flexDirection: 'column',
        overflow:   'hidden',
        zIndex:     200,
        padding:    10,
      }
    : { display: 'none' };

  return (
    <div ref={overlayRef} className="popover quick-context-picker" style={style}>
      <HubContextSessionPicker
        defaultOpenCategories={['notes']}
        onPicked={onClose}
      />
    </div>
  );
}

// ── Mount ────────────────────────────────────────────────────────────────────
// Reuses the existing #chat-notes-btn DOM element so existing markup stays
// in place; the title/icon stay handled by ChatView.tsx (we just hijack the
// click).

export function QuickContextPicker() {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  useEffect(() => {
    function onBtnClick(e: Event) {
      const b = e.currentTarget as HTMLElement;
      setAnchor(b.getBoundingClientRect());
      setOpen((o) => !o);
      e.stopPropagation();
    }
    function wire() {
      const el = document.getElementById('chat-notes-btn');
      if (el) (el as HTMLButtonElement).onclick = onBtnClick;
    }
    wire();
    const obs = new MutationObserver(wire);
    obs.observe(document.body, { childList: true, subtree: true });
    return () => {
      obs.disconnect();
      const el = document.getElementById('chat-notes-btn');
      if (el) (el as HTMLButtonElement).onclick = null;
    };
  }, []);

  if (!open) return null;
  return createPortal(
    <PanelContent anchor={anchor} onClose={() => setOpen(false)} />,
    document.body
  );
}
