// files-manager — frontend module owning the Files Manager UI surface.
//
// Registers the primary-row header icon (folder glyph, order 30) that
// dispatches the `yha:open-file-manager` event, plus a panel slot for
// the lazy-loaded <FileManager /> modal (which self-wires to that
// event). Before this module existed the header icon lived inline in
// `host/bootstrap-core-icons.tsx` as `core.file-manager` and the modal
// was rendered directly from App.tsx — both moved here so disabling
// the module hides the icon and unmounts the modal in one shot.
//
// Panel slots registered here (consumed via <PanelSlot id="…" />):
//   files-manager-modal — <FileManager />

import { createElement, lazy } from 'react';
import host from '../../host/index.js';
import { ManageButton } from './ManageButton.js';

const FileManager = lazy(() =>
  import('../../modals/FileManager.js').then(m => ({ default: m.FileManager })),
);

const MODULE_NAME = 'files-manager';

export default {
  activate() {
    // A. Header icon button (primary row, order 30) — replaces the old
    //    `core.file-manager` entry in bootstrap-core-icons.tsx.
    host.registers.headerIconButtons.add(
      {
        id: 'files-manager.header-icon',
        group: 'primary',
        order: 30,
        domId: 'btn-file-manager',
        title: 'Open File Manager — drag-drop uploads, mkdir, rename, move, delete [Ctrl+Shift+F]',
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
            createElement('path', {
              d: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
            }),
          ),
        onClick: () => window.dispatchEvent(new CustomEvent('yha:open-file-manager')),
      },
      MODULE_NAME,
    );

    // B. Panel slot — App.tsx renders <PanelSlot id="files-manager-modal" />.
    host.registers.panels.add(
      { id: 'files-manager.modal', slotId: 'files-manager-modal', component: FileManager },
      MODULE_NAME,
    );

    // C. FilePicker footer "Manage…" button — extracted from FilePicker.tsx.
    host.registers.filePickerActions.add(
      { id: 'files-manager.fp-action', order: 10, component: ManageButton },
      MODULE_NAME,
    );

    return { name: MODULE_NAME };
  },
  deactivate() {
    host.removeModuleEverywhere(MODULE_NAME);
  },
};
