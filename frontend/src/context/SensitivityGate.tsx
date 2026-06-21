// SensitivityGate — English confirm-dialog for private/system context items.
// Phase 1a / Adaption 6 of the ContextGenerator pipeline.
//
// Triggered by the picker/Hub when the user clicks an item with sensitivity
// !== 'public'. Renders a portal-mounted modal:
//
//   ┌─────────────────────────────────────────────┐
//   │  🔒  Private Context                        │
//   │  ─────────────────────────────              │
//   │  This item is marked private:               │
//   │     "Personal Notes — Bank Access"          │
//   │                                             │
//   │  Inserting it will paste its contents into  │
//   │  the current chat and may share it with     │
//   │  the model.                                 │
//   │                                             │
//   │  [✓] Remember for this session (30 min)     │
//   │                                             │
//   │  [Cancel]              [Confirm Access]     │
//   └─────────────────────────────────────────────┘
//
// All copy is English by deliberate plan decision (§8).

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ContextItem } from './contextStore.js';
import { confirmOnce, confirmForSession } from './usePendingConfirms.js';

interface Props {
  item:       ContextItem;
  onConfirm:  () => void;       // called after successful whitelist add
  onCancel:   () => void;
}

export function SensitivityGate({ item, onConfirm, onCancel }: Props) {
  const [remember, setRemember] = useState(false);
  const [busy, setBusy]         = useState(false);
  const [error, setError]       = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  // ESC closes; click outside closes. Match the existing popover patterns.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
    }
    function onMouseDown(e: MouseEvent) {
      if (dialogRef.current && !dialogRef.current.contains(e.target as Node)) onCancel();
    }
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onMouseDown, true);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onMouseDown, true);
    };
  }, [onCancel]);

  async function handleConfirm() {
    if (busy) return;
    setBusy(true);
    setError(null);
    const ok = remember
      ? await confirmForSession(item.id)
      : await confirmOnce(item.id);
    setBusy(false);
    if (!ok) {
      setError('Failed to register confirmation. Please try again.');
      return;
    }
    onConfirm();
  }

  const isSystem = item.sensitivity === 'system';
  const heading  = isSystem ? '⚙️🔒  System Context' : '🔒  Private Context';
  const description = isSystem
    ? 'This item is marked as system-level and may contain credentials, ' +
      'API keys, or configuration secrets.'
    : 'This item is marked private and may contain personal information.';

  return createPortal(
    <div
      className="sensitivity-gate-backdrop"
      style={{
        position:    'fixed',
        inset:       0,
        background:  'rgba(0,0,0,0.5)',
        zIndex:      9999,
        display:     'flex',
        alignItems:  'center',
        justifyContent: 'center',
      }}
      role="dialog"
      aria-modal="true"
      aria-label={heading}
    >
      <div
        ref={dialogRef}
        className={`sensitivity-gate sensitivity-gate-${item.sensitivity}`}
        style={{
          background:    'var(--bg, #1c1c1c)',
          color:         'var(--fg, #eee)',
          padding:       '20px 24px',
          borderRadius:  '8px',
          maxWidth:      '440px',
          minWidth:      '320px',
          border:        '1px solid var(--border, #333)',
          boxShadow:     '0 12px 40px rgba(0,0,0,0.5)',
        }}
      >
        <div style={{ fontSize: '15px', fontWeight: 600, marginBottom: 12 }}>
          {heading}
        </div>
        <div style={{ height: 1, background: 'var(--border, #333)', margin: '0 0 14px' }} />

        <div style={{ marginBottom: 8, fontSize: '13px' }}>
          This item is marked {item.sensitivity}:
        </div>
        <div
          style={{
            margin:       '0 0 14px',
            padding:      '6px 10px',
            background:   'var(--bg-soft, #262626)',
            borderRadius: 4,
            fontFamily:   'monospace',
            fontSize:     '12.5px',
            wordBreak:    'break-all',
          }}
        >
          “{item.title}”
        </div>

        <div style={{ marginBottom: 14, fontSize: '12.5px', color: 'var(--fg-mute, #aaa)', lineHeight: 1.5 }}>
          {description} Inserting it will paste its contents into the current
          chat and may share it with the model.
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: '12.5px', cursor: 'pointer', userSelect: 'none' }}>
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            disabled={busy}
          />
          Remember for this session (30 min)
        </label>

        {error && (
          <div style={{ marginTop: 10, color: '#e88', fontSize: '12px' }}>
            {error}
          </div>
        )}

        <div style={{ marginTop: 18, display: 'flex', justifyContent: 'flex-end', gap: 10 }}>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="btn btn-ghost"
            style={{ padding: '6px 12px', fontSize: '12.5px' }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={busy}
            className="btn btn-primary"
            autoFocus
            style={{
              padding:     '6px 14px',
              fontSize:    '12.5px',
              background:  isSystem ? '#a04040' : 'var(--accent, #4a8)',
              color:       'white',
              border:      'none',
              borderRadius: 4,
              cursor:      busy ? 'wait' : 'pointer',
            }}
          >
            {busy ? 'Confirming…' : 'Confirm Access'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
}
