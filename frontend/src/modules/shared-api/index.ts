// shared-api — frontend module owning the "API" prefs tab.
//
// The tab manages public API keys that external clients (Hermes, OpenClaw,
// other yha instances) use to call this yha's bridge. Before the modular
// extraction the tab was registered as a core prefs entry in
// `host/bootstrap-core-prefs-tabs.ts`; it now registers from this module so
// disabling the bridge `shared-api` module (and the `/v1/api-keys/*`
// endpoints behind it) removes the tab cleanly.

import host from '../../host/index.js';
import { TabApi } from '../../prefs/TabApi.js';

const MODULE_NAME = 'shared-api';

export default {
  activate() {
    host.registers.prefsTabs.add(
      {
        id: 'api',
        group: 'platform',
        order: 50,
        label: 'API',
        simpleMode: null,
        component: TabApi,
        icon: '🔐',
      },
      MODULE_NAME,
    );
    return { name: MODULE_NAME };
  },
  deactivate() {
    host.removeModuleEverywhere(MODULE_NAME);
  },
};
