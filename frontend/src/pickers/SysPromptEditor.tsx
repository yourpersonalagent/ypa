// SysPromptEditor — React picker for the #chat-sys-btn (chat header).
// Owns the click through a delegated document listener and yha:open-sysprompt.
// Hydrates initial state from server-prefs at mount and loads presets
// from /v1/config/ — replacing the previous panels/sysprompt.ts entirely.

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useAppStore, getAppActions, getAppState } from '../stores/index.js';
import type { SysPromptState } from '../stores/index.js';
import { normalizeSysPromptSelection, resolveSysPromptText } from '../stores/appStore.js';
import { store } from '../store.js';
import { api } from '../api.js';
import { iconSvg } from '../chat/icons.js';

// Hydrate sysPrompt selection from server-prefs (parity with old sysprompt.init)
function hydrateSelection(): SysPromptState {
  const cur = getAppState().sysPrompt?.selection;
  if (cur && typeof cur.mode === 'string') return normalizeSysPromptSelection(cur);
  const s = store.get('sysPrompt', null) as Record<string, unknown> | null;
  if (s && typeof s.mode === 'string') return normalizeSysPromptSelection(s as unknown as SysPromptState);
  if (s && typeof s.override === 'boolean') {
    return normalizeSysPromptSelection({
      mode: (s.override ? 'append' : 'off') as SysPromptState['mode'],
      preset: (s.preset as string) || '',
    });
  }
  return { mode: 'off', preset: '' };
}

async function fetchPresets(): Promise<Record<string, string>> {
  try {
    const r = await fetch(api.config.baseUrl + '/v1/config/');
    const d = (await r.json()) as { config?: { presetsMap?: Record<string, string> } };
    return d.config?.presetsMap || {};
  } catch {
    return {};
  }
}

function SysPromptPicker({
  anchor,
  selection,
  presets,
  onChange,
}: {
  anchor: DOMRect;
  selection: SysPromptState;
  presets: Record<string, string>;
  onChange: (s: SysPromptState) => void;
}) {
  const names = Object.keys(presets);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const pw = Math.min(290, vw - 16);
  // Hidden-anchor fallback: Zen / Messenger hide the chat bar so the rect is
  // all zeros; center on viewport so palette-driven opens stay visible.
  const hiddenAnchor = anchor.width === 0 && anchor.height === 0;
  const left = hiddenAnchor
    ? Math.max(8, (vw - pw) / 2)
    : Math.max(8, Math.min(vw - pw - 8, anchor.right - pw));
  const posAbove = !hiddenAnchor && anchor.bottom > vh / 2;

  const style: React.CSSProperties = {
    position: 'fixed',
    width: pw,
    left,
    zIndex: 9999,
    ...(hiddenAnchor
      ? { top: Math.max(8, vh * 0.2), bottom: 'auto' }
      : posAbove
        ? { bottom: vh - anchor.top + 6, top: 'auto' }
        : { top: anchor.bottom + 6, bottom: 'auto' }),
  };

  const modeOff = selection.mode === 'off';
  const modeAppend = selection.mode === 'append';
  const modeReplace = selection.mode === 'replace';
  const selectedNames = selection.presets?.length ? selection.presets : (selection.preset ? [selection.preset] : []);
  const selectedSet = new Set(selectedNames);
  const previewText = resolveSysPromptText(selection, presets);

  function setMode(mode: SysPromptState['mode']) {
    onChange({ ...selection, mode });
  }

  function togglePreset(name: string) {
    const nextNames = selectedSet.has(name)
      ? selectedNames.filter((n) => n !== name)
      : [...selectedNames, name];
    onChange({
      mode: nextNames.length ? (selection.mode === 'off' ? 'append' : selection.mode) : selection.mode,
      preset: nextNames[0] || '',
      presets: nextNames,
    });
  }

  return (
    <div id="react-sysprompt-picker" className="popover" style={style}>
      <div className="sp-header">
        <span className="sp-title">System Prompt</span>
      </div>
      <div className="sp-mode-row">
        <button className={`sp-mode-btn${modeOff ? ' active' : ''}`} onClick={() => setMode('off')}>
          Off
        </button>
        <button className={`sp-mode-btn${modeAppend ? ' active' : ''}`} onClick={() => setMode('append')}>
          Append
        </button>
        <button className={`sp-mode-btn${modeReplace ? ' active' : ''}`} onClick={() => setMode('replace')}>
          Replace
        </button>
      </div>
      <div className="sp-mode-hint">
        {modeOff && <span className="dim">Default system prompt active — no modification.</span>}
        {modeAppend && <span>Adds selected preset(s) after the harness default system prompt.</span>}
        {modeReplace && <span className="warn">Replaces the harness default system prompt with selected preset(s).</span>}
      </div>
      {!modeOff && (
        <>
          <div className="sp-section-lbl">Choose presets</div>
          <div className="dim" style={{ padding: '0 10px 6px', fontSize: 11 }}>
            Select multiple to combine — joined with blank lines. Use <strong>ypa</strong> alone for the full agent prompt (includes YHA Boost layers).
          </div>
          <div className="sp-preset-list">
            {names.length ? (
              names.map((n) => (
                <button
                  type="button"
                  key={n}
                  className={`sp-preset-item${selectedSet.has(n) ? ' current' : ''}`}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    togglePreset(n);
                  }}
                >
                  <span className="sp-preset-check" aria-hidden="true">{selectedSet.has(n) ? '✓' : ''}</span>
                  <span className="sp-preset-name">{n}</span>
                </button>
              ))
            ) : (
              <div className="dim" style={{ padding: '6px 10px', fontSize: 11 }}>
                No presets — add in Settings → Prompts
              </div>
            )}
          </div>
          {previewText && <div className="sp-preview">{previewText}</div>}
        </>
      )}
    </div>
  );
}

export function SysPromptEditor() {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const btnRef = useRef<HTMLElement | null>(null);

  const selection = useAppStore((s) => s.sysPrompt.selection);
  const presets = useAppStore((s) => s.sysPrompt.presets);
  const active = selection.mode !== 'off';

  // One-time hydration at mount: load saved selection from server-prefs +
  // fetch presets list from /v1/config/. Also re-fetch presets when the
  // Prompts tab in PrefsModal dispatches yha:reload-sysprompt-presets.
  useEffect(() => {
    getAppActions().setSysPrompt(hydrateSelection());
    fetchPresets().then((p) => getAppActions().setSysPromptPresets(p));
    const onReload = () => fetchPresets().then((p) => getAppActions().setSysPromptPresets(p));
    window.addEventListener('yha:reload-sysprompt-presets', onReload);
    return () => window.removeEventListener('yha:reload-sysprompt-presets', onReload);
  }, []);

  function setSelection(next: SysPromptState) {
    store.set('sysPrompt', normalizeSysPromptSelection(next));
  }

  function fallbackAnchor(): DOMRect {
    return new DOMRect(window.innerWidth / 2, window.innerHeight * 0.2, 0, 0);
  }

  function buttonAnchor(): DOMRect {
    const btn = document.getElementById('chat-sys-btn') as HTMLElement | null;
    btnRef.current = btn;
    return btn?.getBoundingClientRect() || fallbackAnchor();
  }

  function openPicker(nextOpen?: boolean) {
    setAnchor(buttonAnchor());
    setOpen((current) => (typeof nextOpen === 'boolean' ? nextOpen : !current));
  }

  // Wire button/palette opens. Use delegation so this survives React replacing
  // the chat input button and hidden layouts where the palette is the opener.
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      const target = e.target as HTMLElement | null;
      if (!target?.closest('#chat-sys-btn')) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      openPicker();
    }

    function handleOpen() {
      openPicker(true);
    }

    document.addEventListener('click', handleClick, true);
    window.addEventListener('yha:open-sysprompt', handleOpen);
    return () => {
      document.removeEventListener('click', handleClick, true);
      window.removeEventListener('yha:open-sysprompt', handleOpen);
      btnRef.current = null;
    };
  }, []);

  // Keep button appearance in sync with store
  useLayoutEffect(() => {
    const btn = document.getElementById('chat-sys-btn');
    if (!btn) return;
    btn.innerHTML = iconSvg(active ? 'circle-dot-filled' : 'circle-dot', 13, 2);
    const names = selection.presets?.length ? selection.presets : (selection.preset ? [selection.preset] : []);
    btn.title = active
      ? `System [${selection.mode === 'replace' ? 'Replace' : 'Append'}]: ${names.join(', ') || '(none)'}`
      : 'System prompt: no override (default behavior active)';
    btn.classList.toggle('active', active);
  }, [active, selection.mode, selection.preset, selection.presets]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('#react-sysprompt-picker')) return;
      if (target === btnRef.current) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onDown, true);
    return () => document.removeEventListener('mousedown', onDown, true);
  }, [open]);

  // Close on global Esc (dispatched by KeyboardShortcuts).
  useEffect(() => {
    if (!open) return;
    const onEsc = () => setOpen(false);
    window.addEventListener('yha:escape', onEsc);
    return () => window.removeEventListener('yha:escape', onEsc);
  }, [open]);

  if (!open || !anchor) return null;
  return createPortal(
    <SysPromptPicker
      anchor={anchor}
      selection={selection}
      presets={presets}
      onChange={setSelection}
    />,
    document.body
  );
}
