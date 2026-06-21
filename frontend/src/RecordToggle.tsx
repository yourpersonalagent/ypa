import { useAppStore } from './stores/index.js';
import { getAppActions } from './stores/index.js';
import { store } from './store.js';

const MODES = [
  { id: 'rec-all',      value: 'all'      as const, label: '●', title: 'Record all' },
  { id: 'rec-no-tools', value: 'no-tools' as const, label: '◎', title: 'Record, skip tools' },
  { id: 'rec-off',      value: 'off'      as const, label: '○', title: "Don't record" },
];

export function RecordToggle() {
  const recordChat = useAppStore((s) => s.recordChat);

  function set(val: 'all' | 'no-tools' | 'off') {
    getAppActions().setRecordChat(val);
    store.set('recordChat', val);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    const idx = MODES.findIndex((m) => m.value === recordChat);
    if (idx === -1) return;
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
    e.preventDefault();
    const delta = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1;
    const next = MODES[(idx + delta + MODES.length) % MODES.length];
    set(next.value);
    document.getElementById(next.id)?.focus();
  }

  return (
    <div
      className="hud-rec-toggle"
      id="rec-toggle"
      role="radiogroup"
      aria-label="Record mode"
      onKeyDown={handleKeyDown}
    >
      {MODES.map((m) => {
        const active = recordChat === m.value;
        return (
          <button
            key={m.value}
            className={`hud-rec-toggle-btn${active ? ' hud-rec-active' : ''}`}
            id={m.id}
            type="button"
            data-record={m.value}
            role="radio"
            aria-checked={active}
            title={m.title}
            tabIndex={active ? 0 : -1}
            onClick={() => set(m.value)}
          >
            {m.label}
          </button>
        );
      })}
    </div>
  );
}
