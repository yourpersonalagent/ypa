// input-autocomplete — frontend module that owns the Autocomplete prefs tab
// and exposes the suggestion hook + GhostOverlay for ChatInput to consume.
//
// Self-registered prefs tab: no entry in bootstrap-core-prefs-tabs.ts. When
// the bridge half is disabled in modules.json, host's enabled-modules gating
// skips activate() and the tab disappears in lockstep.

import host from '../../host/index.js';
import { TabAutocomplete } from './TabAutocomplete.js';
import { useAutocompleteConfig } from './configStore.js';

const MODULE_NAME = 'input-autocomplete';

export default {
  activate() {
    host.registers.prefsTabs.add(
      {
        id: 'autocomplete',
        group: 'workspace',
        order: 20,
        label: 'Autocomplete',
        simpleMode: 'partial',
        component: TabAutocomplete,
        icon: '⌨️',
      },
      MODULE_NAME,
    );
    // Eager-load config so the first keystroke after page load doesn't
    // race the GET. Failing GET (bridge module disabled) just leaves the
    // store on defaults with `enabled: false` — hook gates on that.
    void useAutocompleteConfig.getState().fetch();
    return { name: MODULE_NAME };
  },
  deactivate() {
    host.removeModuleEverywhere(MODULE_NAME);
  },
};

export { useInlineSuggestion } from './useInlineSuggestion.js';
export { GhostOverlay } from './GhostOverlay.js';
export { useAutocompleteConfig } from './configStore.js';
