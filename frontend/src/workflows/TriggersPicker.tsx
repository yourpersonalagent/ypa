// TriggersPicker — popover for trigger management, anchored to the ⏱ HUD button.
// Positioned above the button (HUD lives at bottom-right). Handles
// Escape + outside-click to close, same pattern as WorkflowPicker.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { TriggersPanelContent } from '../panels/TriggersPanel.js';

interface Props {
  open: boolean;
  onClose: () => void;
  anchorRef: React.RefObject<HTMLButtonElement | null>;
}

interface PopoverPos {
  right: number;
  bottom: number;
  width: number;
}

function computePos(anchor: HTMLElement): PopoverPos {
  const r = anchor.getBoundingClientRect();
  const vw = window.innerWidth;
  const pw = Math.min(520, vw - 16);
  const right = Math.max(8, vw - r.right);
  const bottom = window.innerHeight - r.top + 6;
  return { right, bottom, width: pw };
}

export function TriggersPicker({ open, onClose, anchorRef }: Props) {
  const [pos, setPos] = useState<PopoverPos | null>(null);
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !anchorRef.current) return;
    setPos(computePos(anchorRef.current));
    function onResize() {
      if (anchorRef.current) setPos(computePos(anchorRef.current));
    }
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [open, anchorRef]);

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (popRef.current?.contains(e.target as Node)) return;
      if (anchorRef.current?.contains(e.target as Node)) return;
      onClose();
    }
    setTimeout(() => document.addEventListener('mousedown', onDown, true), 0);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [open, onClose, anchorRef]);

  if (!open || !pos) return null;

  const style: React.CSSProperties = {
    position: 'fixed',
    zIndex: 1000,
    right: pos.right,
    bottom: pos.bottom,
    width: pos.width,
    maxHeight: '70vh',
  };

  return createPortal(
    <div ref={popRef} className="popover triggers-picker" style={style}>
      <div className="triggers-picker-header">
        <span className="triggers-picker-title">Triggers</span>
        <button className="triggers-picker-close" title="Close" onClick={onClose}>✕</button>
      </div>
      <TriggersPanelContent />
    </div>,
    document.body,
  );
}
