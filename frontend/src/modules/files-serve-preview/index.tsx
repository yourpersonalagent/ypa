// files-serve-preview — frontend module.
//
// Owns the "Serve" sub-section of the CWD dropdown — the profile
// picker (static / python / node / php / custom), start/stop controls, and
// running-process row. Plugged into CwdPanel via the
// `cwdDropdownEntries` register; with the module disabled the row vanishes.
//
// The iframe preview itself still lives in `panels/ServePreview.tsx` and is
// opened via the existing `yha:open-serve-preview` window event.

import host from '../../host/index.js';
import { ServeSubsection } from './ServeSubsection.js';

const MODULE_NAME = 'files-serve-preview';

function ServeWrapper({ cwd }: { cwd: string }) {
  if (!cwd) return null;
  return <ServeSubsection cwd={cwd} />;
}

export default {
  activate() {
    host.registers.cwdDropdownEntries.add(
      // High order so Serve sits at the bottom of the dropdown — below the
      // shared Actions row (github/knowledge/rclone) and any other module
      // entries that ship later.
      { id: 'files-serve-preview.cwd-entry', order: 900, component: ServeWrapper },
      MODULE_NAME,
    );
    return { name: MODULE_NAME };
  },
  deactivate() {
    host.removeModuleEverywhere(MODULE_NAME);
  },
};
