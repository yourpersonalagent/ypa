// mcp-client — frontend module owning the "MCP" prefs tab.
//
// Tab manages MCP server connections that the bridge `mcp-client` module
// proxies for the harness. Before the modular extraction it was registered as
// a core prefs entry in `host/bootstrap-core-prefs-tabs.ts`; it now activates
// here so disabling the bridge `mcp-client` module hides the tab in lockstep.

import host from '../../host/index.js';
import { TabMcp } from '../../prefs/TabMcp.js';

const MODULE_NAME = 'mcp-client';

export default {
  activate() {
    host.registers.prefsTabs.add(
      {
        id: 'mcp',
        group: 'capabilities',
        order: 30,
        label: 'MCP',
        simpleMode: null,
        component: TabMcp,
        icon: '🔌',
      },
      MODULE_NAME,
    );
    return { name: MODULE_NAME };
  },
  deactivate() {
    host.removeModuleEverywhere(MODULE_NAME);
  },
};
