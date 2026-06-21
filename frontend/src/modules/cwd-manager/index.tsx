// cwd-manager — frontend module.
//
// P2 surface for the bridge-side programmatic heartbeat supervisor:
// - CWD dropdown subsection with full controls (start/stop, interval, check now)
// - Compact strip above Tasks for quick start/stop/check
// - SSE hydration from the existing triggers EventSource bus

import host from '../../host/index.js';
import { CwdManagerSubsection } from './CwdManagerSubsection.js';
import { CwdManagerToggle } from './CwdManagerToggle.js';
import { startCwdManagerSse, stopCwdManagerSse, useCwdManagerStore } from './cwdManagerStore.js';

const MODULE_NAME = 'cwd-manager';

function CwdManagerDropdownWrapper({ cwd }: { cwd: string }) {
  if (!cwd) return null;
  return <CwdManagerSubsection cwd={cwd} />;
}

export default {
  activate() {
    startCwdManagerSse();
    useCwdManagerStore.getState().refresh();
    host.registers.cwdDropdownEntries.add(
      { id: 'cwd-manager.cwd-entry', order: 850, component: CwdManagerDropdownWrapper },
      MODULE_NAME
    );
    host.registers.sessionPickerSlots.add(
      {
        id: 'cwd-manager.aboveTodos',
        region: 'aboveTodos',
        order: 10,
        component: CwdManagerToggle,
      },
      MODULE_NAME
    );
    return { name: MODULE_NAME };
  },
  deactivate() {
    stopCwdManagerSse();
    host.removeModuleEverywhere(MODULE_NAME);
  },
};
