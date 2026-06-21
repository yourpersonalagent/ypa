// PrefsEntriesSlot — renders every `prefsEntries` register entry whose
// `tab` matches the slot's `tab` prop, sorted by `order` then `label`.
//
// Phase 4 of LayoutPlan.md: gives modules a way to contribute *individual
// settings* (not whole tabs) so each one is addressable from the `/`
// palette as `prefs.<id>`. The slot owns the rendering of the control
// itself based on the entry's `type` field; entries only describe the
// value, not the widget.
//
// Mount one slot per tab body:
//   <PrefsEntriesSlot tab="system" />

import { useSyncExternalStore, type ChangeEvent } from 'react';
import { registers } from '../keys.js';
import type { PrefsEntry, PrefsEntryOption } from '../keys.js';
import { useRegisterList } from '../useRegisterList.js';
import { getAppActions, getAppState, useAppStore } from '../../stores/appStore.js';
import { LAYOUTS } from '../../layouts/index.js';
import { colorTheme } from '../../color-theme.js';

interface PrefsEntriesSlotProps {
  /** Matches `PrefsEntry.tab`. */
  tab: string;
  /** Optional heading for the auto-rendered section. */
  heading?: string;
}

export function PrefsEntriesSlot({ tab, heading }: PrefsEntriesSlotProps) {
  const all = useRegisterList(registers.prefsEntries) as PrefsEntry[];
  const entries = all
    .filter((e) => e.tab === tab)
    .sort((a, b) => {
      const oa = a.order ?? 100;
      const ob = b.order ?? 100;
      if (oa !== ob) return oa - ob;
      return a.label.localeCompare(b.label);
    });

  // Subscribe to appStore so toggles tied to it re-render on external changes.
  // Cheap — useAppStore is the same hook the rest of the app uses.
  useAppStore((s) => s.colorTheme);
  useAppStore((s) => s.layoutMode);

  if (!entries.length) return null;
  return (
    <div className="prefs-entries-section" data-prefs-tab={tab}>
      {heading ? <h3 className="prefs-entries-heading">{heading}</h3> : null}
      {entries.map((entry) => (
        <PrefsEntryRow key={entry.id} entry={entry} />
      ))}
    </div>
  );
}

function PrefsEntryRow({ entry }: { entry: PrefsEntry }) {
  // useSyncExternalStore so a setter elsewhere triggers a re-render even
  // when the entry's underlying value isn't in appStore.
  const value = useSyncExternalStore(
    (cb) => {
      window.addEventListener('yha:prefs-entry-changed', cb);
      return () => window.removeEventListener('yha:prefs-entry-changed', cb);
    },
    () => entry.get(),
  );

  function commit(next: unknown) {
    entry.set(next);
    // Notify slot subscribers + any palette consumers. The event is generic;
    // callers re-read the latest via `entry.get()`.
    window.dispatchEvent(new CustomEvent('yha:prefs-entry-changed', { detail: { id: entry.id } }));
  }

  const id = `prefs-entry-${entry.id}`;
  return (
    <div className="prefs-entry-row" data-entry-id={entry.id} data-type={entry.type}>
      <label htmlFor={id} className="prefs-entry-label">
        <span className="prefs-entry-title">{entry.label}</span>
        {entry.description ? <span className="prefs-entry-desc">{entry.description}</span> : null}
      </label>
      <div className="prefs-entry-control">{renderControl(entry, id, value, commit)}</div>
    </div>
  );
}

function renderControl(
  entry: PrefsEntry,
  domId: string,
  value: unknown,
  commit: (v: unknown) => void,
): React.ReactNode {
  switch (entry.type) {
    case 'toggle':
      return (
        <input
          id={domId}
          type="checkbox"
          checked={!!value}
          onChange={(e: ChangeEvent<HTMLInputElement>) => commit(e.target.checked)}
        />
      );
    case 'radio':
      return (
        <div className="prefs-entry-radio-group" role="radiogroup">
          {(entry.options ?? []).map((opt) => (
            <label key={opt.id} className="prefs-entry-radio">
              <input
                type="radio"
                name={domId}
                value={opt.id}
                checked={value === opt.id}
                onChange={() => commit(opt.id)}
              />
              <span>{opt.label}</span>
            </label>
          ))}
        </div>
      );
    case 'select':
      return (
        <select
          id={domId}
          value={value as string ?? ''}
          onChange={(e: ChangeEvent<HTMLSelectElement>) => commit(e.target.value)}
        >
          {(entry.options ?? []).map((opt: PrefsEntryOption) => (
            <option key={opt.id} value={opt.id}>{opt.label}</option>
          ))}
        </select>
      );
    case 'number':
      return (
        <input
          id={domId}
          type="number"
          value={Number(value ?? 0)}
          min={entry.min}
          max={entry.max}
          step={entry.step}
          onChange={(e: ChangeEvent<HTMLInputElement>) => commit(e.target.valueAsNumber)}
        />
      );
    case 'text':
      return (
        <input
          id={domId}
          type="text"
          value={String(value ?? '')}
          onChange={(e: ChangeEvent<HTMLInputElement>) => commit(e.target.value)}
        />
      );
    case 'color-theme':
      // Defer to the existing color-theme picker. We render a button that
      // opens it; the actual swatch grid lives in TabSystem / ColorThemeButton.
      return (
        <button
          type="button"
          className="prefs-entry-action"
          onClick={() => { document.getElementById('btn-theme')?.click(); }}
        >
          Open color theme picker
        </button>
      );
    case 'layout':
      return (
        <select
          id={domId}
          value={getAppState().layoutMode}
          onChange={(e) => getAppActions().setLayoutMode(e.target.value as never)}
        >
          {Object.values(LAYOUTS).map((meta) => (
            <option key={meta.id} value={meta.id}>{meta.label}</option>
          ))}
        </select>
      );
    case 'action':
      return (
        <button
          id={domId}
          type="button"
          className="prefs-entry-action"
          onClick={() => commit(true)}
        >
          {entry.keywords?.[0] ?? 'Run'}
        </button>
      );
  }
}

/**
 * Synchronously list every prefsEntry that should generate an auto palette
 * command. Used by the AppCommandPalette to derive `prefs.<id>` entries.
 * The helper functions below run when the palette invokes the command.
 */
export function listAutoPaletteEntries(): PrefsEntry[] {
  return registers.prefsEntries.list().filter((e) => e.paletteCommand !== false);
}

/**
 * Run the auto-action for a prefsEntry — toggle the boolean, cycle the
 * radio, etc. Exposed so the palette command runner agrees with this
 * file's rendering.
 */
export function runAutoPaletteAction(entry: PrefsEntry): void {
  switch (entry.type) {
    case 'toggle':
      entry.set(!entry.get());
      break;
    case 'radio': {
      const opts = entry.options ?? [];
      if (!opts.length) return;
      const cur = String(entry.get() ?? '');
      const idx = opts.findIndex((o) => o.id === cur);
      const next = opts[(idx + 1) % opts.length];
      entry.set(next.id);
      break;
    }
    case 'action':
      entry.set(true);
      break;
    case 'layout': {
      const layouts = Object.values(LAYOUTS);
      const cur = getAppState().layoutMode;
      const idx = layouts.findIndex((m) => m.id === cur);
      const next = layouts[(idx + 1) % layouts.length];
      getAppActions().setLayoutMode(next.id as never);
      break;
    }
    case 'color-theme':
      // Cycle through variants of the current family — a small reversible
      // step from the palette; full picks happen via the dedicated
      // `color-theme.set.*` commands.
      colorTheme.setVariant(getAppState().colorTheme.endsWith('-dark') ? 'bright' : 'dark');
      break;
    default:
      // number / text / select — open the prefs modal scrolled to the tab.
      try {
        // Lazy import avoids a circular dependency with preferences.ts.
        void import('../../preferences.js').then(({ prefs }) => {
          (prefs as unknown as { open?: (tabId?: string) => void }).open?.(entry.tab);
        });
      } catch { /* ignore */ }
  }
  window.dispatchEvent(new CustomEvent('yha:prefs-entry-changed', { detail: { id: entry.id } }));
}
