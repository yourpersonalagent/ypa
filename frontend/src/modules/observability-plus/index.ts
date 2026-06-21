// observability-plus — frontend module owning the "Cost Stats" prefs tab
// and the DebugModal portal host.
//
// The bridge `observability-plus` module exposes /v1/debug/*, /v1/costs,
// /v1/tokens. This FE module surfaces those endpoints in:
//   • Prefs tab "Cost Stats" (id 'stats') — was a core prefs entry.
//   • The DebugModal overlay — was rendered unconditionally from App.tsx
//     into a `<div id="debug-modal" />` placeholder in Shell.tsx.
// Both vanish when the bridge half is disabled in modules.json.

import { lazy } from 'react';
import host from '../../host/index.js';
import { TabStats } from '../../prefs/TabStats.js';

const DebugModal = lazy(() =>
  import('../../panels/DebugModal.js').then(m => ({ default: m.DebugModal })),
);

const MODULE_NAME = 'observability-plus';

export default {
  activate() {
    host.registers.prefsTabs.add(
      {
        id: 'stats',
        group: 'platform',
        order: 40,
        label: 'Cost Stats',
        simpleMode: 'all',
        component: TabStats,
        icon: '📊',
      },
      MODULE_NAME,
    );
    host.registers.panels.add(
      {
        id: 'observability-plus.debug-modal',
        slotId: 'observability-plus-debug-modal',
        component: DebugModal,
      },
      MODULE_NAME,
    );
    return { name: MODULE_NAME };
  },
  deactivate() {
    host.removeModuleEverywhere(MODULE_NAME);
  },
};
