// todos — frontend module.
//
// Owns the Zustand store (`todoStore.ts`), the full-screen modal
// (`TodosModal.tsx`), the legacy header strip (`TodosHeader.tsx`,
// orphan since CwdPanel.tsx replaced the header rendering),
// and the per-CWD inline task list (`TodosForCwd.tsx`) which plugs
// into CwdPanel via the `sessionPickerSlots` register at the
// `belowSessions` region.
//
// What's still inline in App.tsx (deferred):
//   - `<TodosModal />` mount. Turning it into a panel slot
//     (`<PanelSlot id="todos-modal" />`) is cosmetic and doesn't
//     change behavior.
//
// What's NOT shipped here:
//   - `cwdDropdownEntries` register entry. The host has the register
//     declared (host/keys.ts) but no consumer slot exists yet — there
//     is no CwdDropdown component to render the entries into. When
//     that slot lands, this module should add a CwdDropdownTodosEntry.

import host from '../../host/index.js';
import { TodosForCwd } from './TodosForCwd.js';
import { TodosModal } from './TodosModal.js';

const MODULE_NAME = 'todos';

export default {
  activate() {
    host.registers.sessionPickerSlots.add(
      {
        id: 'todos.belowSessions',
        region: 'belowSessions',
        component: TodosForCwd,
      },
      MODULE_NAME,
    );
    host.registers.panels.add({
      id: 'todos.modal',
      slotId: 'todos-modal',
      component: TodosModal,
    }, MODULE_NAME);
    return { name: MODULE_NAME };
  },
  deactivate() {
    host.removeModuleEverywhere(MODULE_NAME);
  },
};
