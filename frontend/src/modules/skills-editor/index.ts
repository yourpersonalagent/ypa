// skills-editor — frontend module owning the "Skills" prefs tab.
//
// Tab manages skill definitions edited via the bridge `skills-editor` module
// routes. Before the modular extraction it was registered as a core prefs
// entry in `host/bootstrap-core-prefs-tabs.ts`; it now activates here so
// disabling the bridge `skills-editor` module hides the tab in lockstep.

import host from '../../host/index.js';
import { TabSkills } from '../../prefs/TabSkills.js';

const MODULE_NAME = 'skills-editor';

export default {
  activate() {
    host.registers.prefsTabs.add(
      {
        id: 'skills',
        group: 'capabilities',
        order: 20,
        label: 'Skills',
        simpleMode: null,
        component: TabSkills,
        icon: '✨',
      },
      MODULE_NAME,
    );
    return { name: MODULE_NAME };
  },
  deactivate() {
    host.removeModuleEverywhere(MODULE_NAME);
  },
};
