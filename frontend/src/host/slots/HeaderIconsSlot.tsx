// HeaderIconsSlot — renders entries from the `headerIconButtons`
// register, filtered by `group` (primary | secondary).
//
// Replaces the hardcoded JSX block in Shell.tsx:200-279. After this,
// adding or removing a header icon is a matter of `register.add({...})`
// in a module's `activate()` and `register.removeAllByModule()` in
// `deactivate()`. The slot subscribes via `useRegisterList()` so
// re-renders are automatic and stable React keys keep button state
// (popovers, focus) intact across register changes.

import type { MouseEvent } from 'react';
import { registers, type HeaderIconButton } from '../keys.js';
import { useRegisterList } from '../useRegisterList.js';

interface HeaderIconsSlotProps {
  group: 'primary' | 'secondary';
}

export function HeaderIconsSlot({ group }: HeaderIconsSlotProps) {
  const entries = useRegisterList(registers.headerIconButtons);
  const filtered = entries.filter((e) => e.group === group);
  return (
    <div className={`hm-row-pair hm-row-pair-${group}`}>
      {filtered.map((entry) => <HeaderIconButtonView key={entry.id} entry={entry} />)}
    </div>
  );
}

function HeaderIconButtonView({ entry }: { entry: HeaderIconButton }) {
  // If the entry brought its own component, render it. Components are
  // responsible for their own state (popovers, badges, etc.).
  if (entry.component) {
    const C = entry.component;
    return <C />;
  }
  // Shorthand path: simple icon button.
  const icon = typeof entry.icon === 'function' ? (entry.icon as () => unknown)() : entry.icon;
  return (
    <button
      className={`hm-item${entry.className ? ' ' + entry.className : ''}`}
      id={entry.domId}
      title={entry.title}
      onClick={(e: MouseEvent) => entry.onClick?.(e)}
    >
      {typeof icon === 'string' || typeof icon === 'number'
        ? icon
        : <span className="hm-icon" aria-hidden="true">{icon as React.ReactNode}</span>}
      {entry.badge ? <BadgeView render={entry.badge} /> : null}
    </button>
  );
}

function BadgeView({ render }: { render: () => string | number | null }) {
  const v = render();
  if (v === null || v === undefined || v === '') return null;
  return <span className="hm-badge">{v}</span>;
}
