// search — frontend module owning the "Search" prefs tab.
//
// Tab manages web-search provider config (Google CSE, etc.) consumed by the
// bridge `search` module. Before the modular extraction it was registered as
// a core prefs entry in `host/bootstrap-core-prefs-tabs.ts`; it now activates
// here so disabling the bridge `search` module hides the tab in lockstep.

import host from '../../host/index.js';
import { TabSearch } from '../../prefs/TabSearch.js';

const MODULE_NAME = 'search';

export default {
  activate() {
    host.registers.prefsTabs.add(
      {
        id: 'search',
        group: 'capabilities',
        order: 40,
        label: 'Search',
        simpleMode: 'partial',
        component: TabSearch,
        icon: '🔍',
      },
      MODULE_NAME,
    );
    return { name: MODULE_NAME };
  },
  deactivate() {
    host.removeModuleEverywhere(MODULE_NAME);
  },
};
