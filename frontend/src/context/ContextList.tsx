// ContextList — the shared item-list rendering used by both shells.
// Phase 1a / Adaption 4 of the ContextGenerator pipeline.
//
// Click handler routes through the SensitivityGate when the item isn't
// `public` and isn't already in the local whitelist. The actual injection
// (paste into ChatInput / open file / switch session) is delegated to the
// caller via `onPick(item)` so QuickPicker and Hub can do different things.
//
// State coupling:
//   • Reads items + loading state from contextStore.
//   • Reads/refreshes the whitelist via usePendingConfirms.
//   • Owns one piece of local state: the item currently waiting for
//     confirmation, so the gate modal mounts at the right moment.

import { useState } from 'react';
import { useContextStore, type ContextItem } from './contextStore.js';
import { SensitivityBadge } from './SensitivityBadge.js';
import { SensitivityGate } from './SensitivityGate.js';
import { usePendingConfirms } from './usePendingConfirms.js';

interface Props {
  onPick:     (item: ContextItem) => void;
  emptyHint?: string;
}

function _formatWhen(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString()) {
    return 'Yesterday ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function ContextList({ onPick, emptyHint }: Props) {
  const items   = useContextStore((s) => s.items);
  const loading = useContextStore((s) => s.loading);
  const error   = useContextStore((s) => s.error);
  const cat     = useContextStore((s) => s.activeCategory);
  const query   = useContextStore((s) => s.query);

  const { isConfirmed } = usePendingConfirms();
  const [pending, setPending] = useState<ContextItem | null>(null);

  function handleClick(item: ContextItem) {
    // Public → straight through.
    if (item.sensitivity === 'public' || !item.requiresConfirm) {
      onPick(item);
      return;
    }
    // Already confirmed in this tab session → straight through; the read
    // endpoint will consume the whitelist entry server-side.
    if (isConfirmed(item.id)) {
      onPick(item);
      return;
    }
    // Otherwise — mount the gate and wait for the user's call.
    setPending(item);
  }

  return (
    <>
      <div className="context-list" style={{ display: 'flex', flexDirection: 'column' }}>
        {error && (
          <div style={{ padding: '10px 14px', color: '#e88', fontSize: '12.5px' }}>
            {error}
          </div>
        )}
        {loading && items.length === 0 && (
          <div style={{ padding: '12px 16px', color: 'var(--fg-mute, #aaa)', fontSize: '13px' }}>
            Loading…
          </div>
        )}
        {!loading && items.length === 0 && (
          <div style={{ padding: '12px 16px', color: 'var(--fg-mute, #aaa)', fontSize: '13px' }}>
            {emptyHint ||
              (query
                ? `No items match "${query}" in ${cat || 'all categories'}.`
                : `No items in ${cat || 'this view'} yet.`)}
          </div>
        )}
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            className="context-item"
            onClick={() => handleClick(item)}
            style={{
              display:        'flex',
              flexDirection:  'column',
              alignItems:     'stretch',
              textAlign:      'left',
              padding:        '8px 12px',
              border:         'none',
              borderBottom:   '1px solid var(--border, #2a2a2a)',
              background:     'transparent',
              color:          'inherit',
              cursor:         'pointer',
              gap:            2,
            }}
            title={item.requiresConfirm ? `${item.sensitivity} — confirm before access` : item.title}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <SensitivityBadge tier={item.sensitivity} />
              <span style={{ fontSize: '13px', fontWeight: 500, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {item.title}
              </span>
              <span style={{ fontSize: '11px', color: 'var(--fg-mute, #888)' }}>
                {_formatWhen(item.updatedAt)}
              </span>
            </div>
            {item.snippet && (
              <div
                style={{
                  fontSize:   '11.5px',
                  color:      'var(--fg-mute, #aaa)',
                  display:    '-webkit-box',
                  WebkitBoxOrient: 'vertical',
                  WebkitLineClamp: 2,
                  overflow:   'hidden',
                }}
              >
                {item.snippet}
              </div>
            )}
            {item.kind === 'note' && item.sessionName && (
              <div style={{ fontSize: '10.5px', color: 'var(--fg-mute, #888)', marginTop: 2 }}>
                <span aria-hidden style={{ marginRight: 4 }}>↳</span>
                {item.sessionName}
              </div>
            )}
            {item.tags && item.tags.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 2 }}>
                {item.tags.map((t) => (
                  <span
                    key={t}
                    style={{
                      fontSize:    '10.5px',
                      padding:     '1px 5px',
                      borderRadius: 3,
                      background:  'var(--bg-soft, #262626)',
                      color:       'var(--fg-mute, #aaa)',
                    }}
                  >
                    {t}
                  </span>
                ))}
              </div>
            )}
          </button>
        ))}
      </div>

      {pending && (
        <SensitivityGate
          item={pending}
          onCancel={() => setPending(null)}
          onConfirm={() => {
            const it = pending;
            setPending(null);
            onPick(it);
          }}
        />
      )}
    </>
  );
}
