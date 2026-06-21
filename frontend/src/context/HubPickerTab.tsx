// HubPickerTab — full-fat Picker view inside the ContextHub modal.
// Phase 1b / Adaption 4 (Shell #2).
//
// Two view modes (toggle at the top):
//   • "By context" — sessions GROUPED BY CATEGORY (sorter-derived graph).
//     Click a row → switches the active chat session. "📋 Post context"
//     button per row pastes the full session transcript into the chat
//     input. Default for new ContextHub opens — see user request 2026-05-06.
//   • "Files & sessions" (legacy) — flat list with category tabs, each
//     pick pastes into chat input. Same engine as QuickContextPicker but
//     with the rails off:
//       – Shows ALL category tabs (Quick-Picker trims to a ~7-tab subset).
//       – Defaults `showAllTiers` to ON.
//       – Pick = paste-into-input via the `chat:set-input` bus.

import { useEffect, useRef, useState } from 'react';
import { bus } from '../state.js';
import { api } from '../api.js';
import { ContextList }  from './ContextList.js';
import { CategoryTabs } from './CategoryTabs.js';
import { HubContextSessionPicker } from './HubContextSessionPicker.js';
import { useContextStore, type ContextItem } from './contextStore.js';
import { consume } from './usePendingConfirms.js';

type PickerMode = 'by-context' | 'flat';

function _baseUrl(): string {
  return (api.config as { baseUrl?: string })?.baseUrl || '';
}

async function _fetchFullContent(item: ContextItem): Promise<string> {
  if (item.kind !== 'file' || !item.path) return item.snippet || '';
  const url = _baseUrl();
  if (!url) return item.snippet || '';
  try {
    const r = await fetch(
      `${url}/v1/context/file?path=${encodeURIComponent(item.path)}&confirmToken=${encodeURIComponent(item.id)}`
    );
    if (!r.ok) return item.snippet || '';
    const j = (await r.json()) as { content?: string };
    return j?.content || item.snippet || '';
  } catch { return item.snippet || ''; }
}

function _formatBlock(item: ContextItem, body: string): string {
  const ref = item.kind === 'session'
    ? `session:${item.sid}`
    : `file:${item.path || '(unknown)'}`;
  const hdr = `> **Context** — ${item.title}  \n> _${ref}_${item.category ? ` · ${item.category}` : ''}\n`;
  const trimmed = body.length > 4_000 ? body.slice(0, 4_000) + '\n…[truncated]' : body;
  return `${hdr}\n${trimmed}\n`;
}

export function HubPickerTab() {
  const setShowAllTiers = useContextStore((s) => s.setShowAllTiers);
  const showAllTiers    = useContextStore((s) => s.showAllTiers);
  const setQuery        = useContextStore((s) => s.setQuery);
  const query           = useContextStore((s) => s.query);
  const refresh         = useContextStore((s) => s.refresh);
  const total           = useContextStore((s) => s.total);

  // View-mode toggle. "by-context" is the new sorter-driven grouped view
  // (default per user request 2026-05-06); "flat" is the legacy list.
  // Persist the choice in localStorage so reopens remember the user's
  // preference without round-tripping to the bridge.
  const [mode, setMode] = useState<PickerMode>(() => {
    try {
      const v = localStorage.getItem('yha.contextHub.pickerMode');
      return v === 'flat' ? 'flat' : 'by-context';
    } catch { return 'by-context'; }
  });
  function _setMode(m: PickerMode) {
    setMode(m);
    try { localStorage.setItem('yha.contextHub.pickerMode', m); } catch { /* ignore */ }
  }

  const [localQuery, setLocalQuery] = useState(query);
  const searchRef = useRef<HTMLInputElement>(null);

  // First mount: flip "Show all tiers" on (Hub default — see doc §6).
  // Don't override if the user has been navigating before — we still
  // refresh once so freshly-opened Hubs reflect server-side changes.
  useEffect(() => {
    if (!showAllTiers) setShowAllTiers(true);
    void refresh();
    searchRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounce search the same way the Quick-Picker does.
  useEffect(() => {
    const t = setTimeout(() => {
      if (localQuery !== query) setQuery(localQuery);
    }, 200);
    return () => clearTimeout(t);
  }, [localQuery, query, setQuery]);

  async function handlePick(item: ContextItem) {
    const body = await _fetchFullContent(item);
    consume(item.id);
    const block = _formatBlock(item, body);
    const ta = document.querySelector<HTMLTextAreaElement>('#chat-ta[data-react-owned="1"]')
            ?? document.querySelector<HTMLTextAreaElement>('#chat-ta')
            ?? document.querySelector<HTMLTextAreaElement>('#chat-ta-legacy');
    const existing = ta?.value || '';
    const next = existing.trim() ? `${block}\n${existing}` : block;
    bus.emit('chat:set-input', next);
    // Don't auto-close the Hub — the user might want to grab another item.
  }

  // Mode-switcher row — shared chrome above whichever view is active.
  function _ModeSwitcher() {
    return (
      <div role="tablist" aria-label="Picker view mode" style={{ display: 'flex', gap: 0, border: '1px solid var(--border, #2a2a2a)', borderRadius: 6, alignSelf: 'flex-start' }}>
        {([
          { id: 'by-context', label: '🗂 By context' },
          { id: 'flat',       label: '📑 Files & sessions' },
        ] as const).map((opt) => {
          const active = mode === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => _setMode(opt.id)}
              style={{
                padding: '5px 12px',
                fontSize: '12px',
                background: active ? 'var(--accent, #4a8)' : 'transparent',
                color:      active ? '#000' : 'var(--fg, #ccc)',
                border:     'none',
                cursor:     'pointer',
              }}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    );
  }

  if (mode === 'by-context') {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <_ModeSwitcher />
        <HubContextSessionPicker />
      </div>
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <_ModeSwitcher />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          ref={searchRef}
          className="ss-search"
          type="search"
          placeholder="Search across all categories…"
          value={localQuery}
          onChange={(e) => setLocalQuery(e.target.value)}
          style={{ flex: 1 }}
        />
        <span style={{ fontSize: '12px', color: 'var(--fg-mute, #888)', whiteSpace: 'nowrap' }}>
          {total} item{total === 1 ? '' : 's'}
        </span>
      </div>

      {/* Hub uses the full, non-compact tab strip. */}
      <CategoryTabs />

      <div
        style={{
          flex:        1,
          minHeight:   240,
          maxHeight:   '52vh',
          overflowY:   'auto',
          border:      '1px solid var(--border, #2a2a2a)',
          borderRadius: 6,
        }}
      >
        <ContextList
          onPick={handlePick}
          emptyHint="No items in this category yet — let the categorizer run, or pick another tab."
        />
      </div>

      {/* Hub Picker shows the tier toggle as a hint rather than a switch you
          have to flip on every open — the default here is "all tiers". */}
      <div style={{ fontSize: '11.5px', color: 'var(--fg-mute, #888)', display: 'flex', alignItems: 'center', gap: 6 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={showAllTiers}
            onChange={(e) => setShowAllTiers(e.target.checked)}
          />
          Show 🔒 private &amp; ⚙️🔒 system tiers
        </label>
        <span style={{ opacity: 0.6, marginLeft: 'auto' }}>
          Click an item to paste it into the chat input.
        </span>
      </div>
    </div>
  );
}
