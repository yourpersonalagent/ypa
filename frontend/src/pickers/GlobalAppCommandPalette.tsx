// GlobalAppCommandPalette — `Ctrl+P` / `Cmd+K` overlay mount of
// AppCommandPalette. Independent of the chat textarea — opens centered on
// the viewport with its own text input. Same catalog, same hierarchical
// filter, same keybindings as the inline `/` palette.
//
// Mounted once at the App level. Never opens the `#` Chat Command Picker.

import { useEffect, useRef, useState } from 'react';
import { useHotkeys } from 'react-hotkeys-hook';
import { AppCommandPalette, findSelectedRow, runAppCommand } from './AppCommandPalette.js';
import {
  registerAgentSurface,
  type AgentSurfaceController,
} from '../host/surface-registry.js';

export function GlobalAppCommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  // Hierarchical (rest) view: which group is currently expanded. Reset
  // whenever the overlay closes so re-opening shows a fresh collapsed list.
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const surfaceControllerRef = useRef<AgentSurfaceController | null>(null);

  useEffect(() => {
    const controller = registerAgentSurface({
      id: 'app-command-palette',
      label: 'App command palette',
      kind: 'picker',
      module: '<core>',
      focus: () => inputRef.current?.focus(),
      close: () => setOpen(false),
    });
    surfaceControllerRef.current = controller;
    return () => {
      surfaceControllerRef.current = null;
      controller.dispose();
    };
  }, []);

  useEffect(() => {
    surfaceControllerRef.current?.setOpen(open);
  }, [open]);

  // Global hotkey: Ctrl+P (Linux/Win) and Cmd+K (Mac shorthand).
  // `enableOnFormTags` so it fires even when the chat textarea has focus.
  useHotkeys(
    'ctrl+p, meta+k',
    (e) => {
      e.preventDefault();
      setOpen((v) => !v);
      setSelectedIndex(0);
      setQuery('/');
      setExpandedGroup(null);
    },
    { enableOnFormTags: ['textarea', 'input'] },
  );

  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => inputRef.current?.focus());
  }, [open]);

  function closeOverlay() {
    setOpen(false);
    setQuery('');
    setExpandedGroup(null);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') { e.preventDefault(); closeOverlay(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIndex((i) => i + 1); return; }
    if (e.key === 'ArrowUp')   { e.preventDefault(); setSelectedIndex((i) => Math.max(0, i - 1)); return; }
    if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      const row = findSelectedRow(query, selectedIndex, expandedGroup);
      if (row?.kind === 'group') {
        setExpandedGroup(row.expanded ? null : row.group);
        return;
      }
      if (row?.kind === 'item') {
        runAppCommand(row.cmd, { closePalette: closeOverlay });
        closeOverlay();
      }
    }
  }

  if (!open) return null;

  return (
    <div className="app-cmd-palette-overlay" onClick={closeOverlay} role="dialog" aria-modal>
      <div
        className="app-cmd-palette-modal"
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'fixed',
          left: '50%',
          top: '18%',
          transform: 'translateX(-50%)',
          width: 'min(560px, 92vw)',
          background: 'var(--bg-soft, #111)',
          border: '1px solid var(--border, rgba(255,255,255,0.08))',
          borderRadius: 8,
          boxShadow: '0 12px 48px rgba(0, 0, 0, 0.45)',
          overflow: 'hidden',
          padding: 0,
          zIndex: 9999,
        }}
      >
        <input
          ref={inputRef}
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0); }}
          onKeyDown={handleKeyDown}
          placeholder="Type to filter app commands… (theme, layout, view, prefs, module:…)"
          style={{
            width: '100%',
            padding: '12px 14px',
            background: 'transparent',
            color: 'var(--fg, #eee)',
            border: 'none',
            borderBottom: '1px solid var(--border, rgba(255,255,255,0.08))',
            outline: 'none',
            fontSize: '0.95rem',
          }}
        />
        <AppCommandPalette
          open={open}
          textarea={null}
          query={query}
          selectedIndex={selectedIndex}
          onSelectedIndexChange={setSelectedIndex}
          expandedGroup={expandedGroup}
          onExpandedGroupChange={setExpandedGroup}
          onClose={closeOverlay}
          renderInline
        />
      </div>
    </div>
  );
}
