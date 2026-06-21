// files-rclone — frontend module owning the Rclone UI surface.
//
// Registers the CWD-dropdown action row containing the "rclone" button
// (formerly hard-coded in panels/CwdPanel.tsx CwdActionsSubsection)
// and the lazy-loaded <RcloneModal /> (formerly rendered inline from
// App.tsx, gated on `useBridgeModuleEnabled('files-rclone')`). When the
// module is disabled the button disappears and the modal unmounts in
// one shot.
//
// Panel slots registered here (consumed via <PanelSlot id="…" />):
//   files-rclone-modal — <RcloneModal />

import { lazy } from 'react';
import host from '../../host/index.js';

const RcloneModal = lazy(() =>
  import('../../modals/RcloneModal.js').then(m => ({ default: m.RcloneModal })),
);

const MODULE_NAME = 'files-rclone';

export default {
  activate() {
    // A. Shared Actions row button — sits inside the single "Actions"
    //    sub-section in the CWD dropdown alongside github / knowledge.
    //    Click wiring lives in RcloneModal which finds this button by id.
    host.registers.cwdActionButtons.add(
      {
        id: 'files-rclone.cwd-action',
        order: 10,
        label: 'rclone',
        title: 'rclone — FTP, Sync, Remotes',
        domId: 'btn-cwd-rclone',
      },
      MODULE_NAME,
    );

    // B. Panel slot — App.tsx renders <PanelSlot id="files-rclone-modal" />.
    host.registers.panels.add(
      { id: 'files-rclone.modal', slotId: 'files-rclone-modal', component: RcloneModal },
      MODULE_NAME,
    );

    return { name: MODULE_NAME };
  },
  deactivate() {
    host.removeModuleEverywhere(MODULE_NAME);
  },
};
