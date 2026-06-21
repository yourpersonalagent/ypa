// RailSessionItem — a single row in the messenger session rail.
// Displays name + subtitle + timestamp, plus hover-revealed actions
// (rename, pin/unpin, delete) matching the behaviour of SessionPicker rows.

import { memo, useState } from 'react';
import { Pin } from '../../chat/icons.js';
import type { SessionEntry } from '../../stores/sessionStore.js';

// ── Rename input ──────────────────────────────────────────────────────────────

interface RenameInputProps {
  initialName: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}

function RenameInput({ initialName, onCommit, onCancel }: RenameInputProps) {
  const [value, setValue] = useState(initialName);
  return (
    <input
      className="session-rail-name-input"
      value={value}
      autoFocus
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onCommit(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onCommit(value);
        if (e.key === 'Escape') onCancel();
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

// ── Row ───────────────────────────────────────────────────────────────────────

export interface RailSessionItemProps {
  session: SessionEntry;
  isCurrent: boolean;
  busy: boolean;
  unread: boolean;
  isRenaming: boolean;
  relTime: string;
  subtitle: string;
  onSwitchTo: (id: string | number) => void;
  onStartRename: (s: SessionEntry) => void;
  onCommitRename: (s: SessionEntry, name: string) => void;
  onCancelRename: () => void;
  onToggleTodo: (id: string) => void;
  onDelete: (s: SessionEntry) => void;
}

export const RailSessionItem = memo(function RailSessionItem({
  session: s,
  isCurrent,
  busy,
  unread,
  isRenaming,
  relTime,
  subtitle,
  onSwitchTo,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onToggleTodo,
  onDelete,
}: RailSessionItemProps) {
  const sid = String(s.id);

  return (
    <li
      role="option"
      aria-selected={isCurrent}
      className={[
        'session-rail-row',
        isCurrent ? 'is-current' : '',
        s.isTodo ? 'is-pinned' : '',
        busy ? 'is-busy' : '',
        unread ? 'is-unread' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      onClick={() => !isRenaming && onSwitchTo(s.id)}
    >
      <div className="session-rail-row-top">
        {isRenaming ? (
          <RenameInput
            initialName={s.name}
            onCommit={(name) => onCommitRename(s, name)}
            onCancel={onCancelRename}
          />
        ) : (
          <span className="session-rail-row-name">
            {unread && (
              <span className="session-rail-row-unread" aria-label="unread" title="Unread">
                ✉
              </span>
            )}
            {s.name || 'Untitled'}
          </span>
        )}
        <span className="session-rail-row-time">{relTime}</span>
      </div>

      <div className="session-rail-row-bottom">
        <span className="session-rail-row-sub">{subtitle}</span>
        <span className="session-rail-row-indicators">
          {busy && <span className="session-rail-row-dot" title="Busy" />}
          {s.isTodo && !busy && <span className="session-rail-row-pin" title="Pinned">●</span>}
        </span>
      </div>

      {!isRenaming && (
        <div
          className="session-rail-row-actions"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            className="srail-action-btn srail-rename-btn"
            title="Rename"
            onClick={() => onStartRename(s)}
          >
            ✎
          </button>
          <button
            type="button"
            className={`srail-action-btn srail-pin-btn${s.isTodo ? ' is-pinned' : ''}`}
            title={s.isTodo ? 'Unpin' : 'Pin'}
            onClick={() => onToggleTodo(sid)}
          >
            <Pin size={13} strokeWidth={1.75} fill={s.isTodo ? 'currentColor' : 'none'} />
          </button>
          <button
            type="button"
            className="srail-action-btn srail-delete-btn"
            title="Delete"
            onClick={() => onDelete(s)}
          >
            ✕
          </button>
        </div>
      )}
    </li>
  );
});
