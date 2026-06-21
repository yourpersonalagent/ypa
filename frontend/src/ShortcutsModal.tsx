// ShortcutsModal — read-only cheat sheet of all keyboard shortcuts.
// Opens via window event 'yha:open-shortcuts' (dispatched by Alt+K and by the
// "Show all shortcuts" button in prefs System tab). Closes on Esc, click
// outside the card, or the close button.
//
// Core discoverability metadata lives in host/core-shortcuts.ts; module
// shortcuts are read dynamically from the hotkeys register.

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useRegisterList } from './host/useRegisterList.js';
import { registers } from './host/keys.js';
import { CORE_SHORTCUT_GROUPS } from './host/core-shortcuts.js';
import {
  registerAgentSurface,
  type AgentSurfaceController,
} from './host/surface-registry.js';

// Converts react-hotkeys-hook key strings (e.g. "ctrl+p, meta+k") to display form.
function formatHotkeyKeys(keys: string): string {
  const names: Record<string, string> = {
    alt: 'Alt', ctrl: 'Ctrl', meta: '⌘', shift: 'Shift',
    left: '←', right: '→', up: '↑', down: '↓',
    escape: 'Esc', esc: 'Esc', enter: 'Enter', space: 'Space', tab: 'Tab',
  };
  return keys
    .split(',')
    .map((combo) =>
      combo.trim().split('+').map((k) => names[k.toLowerCase()] ?? k.toUpperCase()).join(' + ')
    )
    .join(' / ');
}

export function ShortcutsModal() {
  const [open, setOpen] = useState(false);
  const moduleHotkeys = useRegisterList(registers.hotkeys);
  const surfaceControllerRef = useRef<AgentSurfaceController | null>(null);

  useEffect(() => {
    const controller = registerAgentSurface({
      id: 'keyboard-shortcuts',
      label: 'Keyboard shortcuts',
      kind: 'modal',
      module: '<core>',
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

  useEffect(() => {
    function onOpen() { setOpen(true); }
    function onEscape() { setOpen(false); }
    window.addEventListener('yha:open-shortcuts', onOpen);
    window.addEventListener('yha:escape', onEscape);
    return () => {
      window.removeEventListener('yha:open-shortcuts', onOpen);
      window.removeEventListener('yha:escape', onEscape);
    };
  }, []);

  if (!open) return null;

  // Module hotkeys that opted into the cheat sheet by providing a description.
  const moduleItems = moduleHotkeys
    .filter((e) => e.description)
    .map((e) => ({ keys: formatHotkeyKeys(e.keys), description: e.description! }));

  const allGroups = moduleItems.length > 0
    ? [...CORE_SHORTCUT_GROUPS, { group: 'Module shortcuts', items: moduleItems }]
    : CORE_SHORTCUT_GROUPS;

  const content = (
    <div className="sc-modal-overlay" onClick={() => setOpen(false)}>
      <div className="sc-modal-card" onClick={(e) => e.stopPropagation()}>
        <header className="sc-modal-header">
          <h3>Keyboard shortcuts</h3>
          <button className="sc-modal-close" title="Close [Esc]" onClick={() => setOpen(false)}>✕</button>
        </header>
        <div className="sc-modal-body">
          {allGroups.map((g) => (
            <section key={g.group} className="sc-modal-group">
              <h4>{g.group}</h4>
              <table>
                <tbody>
                  {g.items.map((s) => (
                    <tr key={s.keys}>
                      <td className="sc-keys"><kbd>{s.keys}</kbd></td>
                      <td className="sc-desc">{s.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>
        <footer className="sc-modal-footer">
          <span className="sc-hint">Tip: shortcuts work everywhere — including while typing in chat or form fields. Alt is a modifier so they don't collide with regular text input.</span>
        </footer>
      </div>
    </div>
  );

  return createPortal(content, document.body);
}
