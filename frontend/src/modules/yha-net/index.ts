// yha-net — frontend module owning the "YHA Net" prefs tab (node registry).
//
// Phase 1 (registry + self-detect) + Phase 2 (live merged file access): the
// net proxy lives in bridge/config/net-routes (core route, no bridge module
// yet). This FE module activates unconditionally. When chat sync lands it can
// move to BRIDGE_LINKED if we want to gate the whole surface.

import host from '../../host/index.js';
import { TabNodes } from './TabNodes.js';

const MODULE_NAME = 'yha-net';

export default {
  activate() {
    host.registers.prefsTabs.add(
      {
        id: 'nodes',
        group: 'platform',
        order: 60,
        label: 'YHA Net',
        simpleMode: 'all',
        component: TabNodes,
        icon: '🌐',
      },
      MODULE_NAME,
    );
    return { name: MODULE_NAME };
  },
  deactivate() {
    host.removeModuleEverywhere(MODULE_NAME);
  },
};
