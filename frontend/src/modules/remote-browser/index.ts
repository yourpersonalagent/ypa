// remote-browser — bridge-linked frontend module.
//
// Owns the "Remote Browser Window" header icon (primary row, order 40),
// the BrowserWindow modal, and the Alt+B hotkey that opens it. The modal
// self-wires to the `yha:open-browser-window` window event; the header
// button + hotkey both dispatch that event.
//
// Bridge gate: `remote-browser` in bridge/modules.json — when disabled,
// every surface in this module disappears.
//
// Panel slots registered here (consumed via <PanelSlot id="…" />):
//   remote-browser-modal — <BrowserWindow />

import { lazy, createElement } from 'react';
import host from '../../host/index.js';

const BrowserWindow = lazy(() =>
  import('./BrowserWindow.js').then(m => ({ default: m.BrowserWindow })),
);

function openBrowserWindow() {
  window.dispatchEvent(new CustomEvent('yha:open-browser-window'));
}

const MODULE_NAME = 'remote-browser';

export default {
  activate() {
    // A. Header icon button — primary row, order 40.
    host.registers.headerIconButtons.add(
      {
        id: 'remote-browser.header-icon',
        group: 'primary',
        order: 40,
        domId: 'btn-remote-browser',
        title: 'Start the remote desktop browser [Alt+B]',
        icon: () =>
          createElement(
            'svg',
            {
              width: 14,
              height: 14,
              viewBox: '0 0 24 24',
              fill: 'none',
              stroke: 'currentColor',
              strokeWidth: 1.75,
              strokeLinecap: 'round',
              strokeLinejoin: 'round',
            },
            createElement('rect', { x: 2, y: 4, width: 20, height: 14, rx: 2 }),
            createElement('path', { d: 'M2 9h20' }),
            createElement('circle', { cx: 5.5, cy: 6.5, r: 0.5, fill: 'currentColor' }),
            createElement('circle', { cx: 7.5, cy: 6.5, r: 0.5, fill: 'currentColor' }),
            createElement('path', { d: 'M8 22h8' }),
            createElement('path', { d: 'M12 18v4' }),
          ),
        onClick: openBrowserWindow,
      },
      MODULE_NAME,
    );

    // B. Panel slot registration — App.tsx renders <PanelSlot id="remote-browser-modal" />.
    host.registers.panels.add(
      { id: 'remote-browser.modal', slotId: 'remote-browser-modal', component: BrowserWindow },
      MODULE_NAME,
    );

    // C. Alt+B hotkey to open the window. Mirrors the original behaviour
    // in KeyboardShortcuts.tsx — fires even when an input is focused.
    host.registers.hotkeys.add(
      {
        id: 'remote-browser.alt-b',
        keys: 'alt+b',
        description: 'Open the remote desktop browser window',
        enableInInputs: true,
        handler: (e) => {
          e.preventDefault();
          openBrowserWindow();
        },
      },
      MODULE_NAME,
    );

    return { name: MODULE_NAME };
  },
  deactivate() {
    host.removeModuleEverywhere(MODULE_NAME);
  },
};
