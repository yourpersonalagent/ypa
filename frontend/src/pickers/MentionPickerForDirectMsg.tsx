// MentionPickerForDirectMsg — @-mention dropdown for the chat textarea.
// Renders a popover above the textarea when the user types `@xxx` to suggest
// employees/agents for direct mentions. Selected entry replaces the @-fragment
// in the textarea.
//
// Pairs with chat/chat-participants.ts which is the *participant lifecycle*
// service (server invitations, button hide/show based on session participants,
// textarea binding) — not a UI duplicate.

import { useEffect } from 'react';
import { createPortal } from 'react-dom';

type Employee = {
  id: string;
  name?: string;
  role?: string;
};

function esc(s: unknown): string {
  return String(s ?? '');
}

export function MentionPickerForDirectMsg({
  open,
  textarea,
  employees,
  selectedIndex,
  onSelectedIndexChange,
  onPick,
  onClose,
}: {
  open: boolean;
  textarea: HTMLTextAreaElement | null;
  employees: Employee[];
  selectedIndex: number;
  onSelectedIndexChange: (n: number) => void;
  onPick: (emp: Employee) => void;
  onClose: () => void;
}) {
  useEffect(() => {
    if (!open || !textarea) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      if (target?.closest('#react-at-picker')) return;
      if (target === textarea) return;
      onClose();
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [open, textarea, onClose]);

  if (!open || !textarea) return null;

  const rect = textarea.getBoundingClientRect();
  const popH = Math.min(employees.length * 38 + 8, 280);

  return createPortal(
    <div
      id="react-at-picker"
      className="at-picker"
      style={{
        left: rect.left,
        top: rect.top - popH - 4,
        width: Math.max(rect.width, 220),
      }}
    >
      {employees.length ? (
        employees.map((emp, idx) => (
          <div
            key={emp.id}
            className={`at-picker-item${idx === selectedIndex ? ' at-picker-active' : ''}`}
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(emp);
            }}
            onMouseEnter={() => onSelectedIndexChange(idx)}
          >
            <span className="at-picker-av">{esc((emp.name || emp.id || '?')[0]?.toUpperCase())}</span>
            <span className="at-picker-info">
              <span className="at-picker-name">{esc(emp.name || emp.id)}</span>
              <span className="at-picker-role">{esc(emp.role || '')}</span>
            </span>
            <span className="at-picker-action">@{esc(emp.name || emp.id)}</span>
          </div>
        ))
      ) : (
        <div className="at-picker-empty">No employees found</div>
      )}
    </div>,
    document.body
  );
}
