// Frontend module-host public surface.
//
// Modules import from here only — `frontend/src/host/keys.ts`
// declares the registers, `slots/` renders them. A module's
// `index.ts` looks like:
//
//   import host from '../../host/index.js';
//   export default {
//     activate() {
//       host.registers.headerIconButtons.add({ id: 'mymod.icon', … });
//     },
//     deactivate() { host.removeModuleEverywhere('mymod'); },
//   };

export { registers, PREFS_TAB_GROUPS } from './keys.js';
export { useRegisterList, useRegisterListAll } from './useRegisterList.js';
export {
  createRegister, declareRegister, getRegister,
  listRegisters, removeModuleEverywhere,
} from './registers.js';
export type {
  Register, Entry, RegisterEntryMeta,
} from './registers.js';
export type {
  HeaderIconButton, HeaderActionButton,
  ChatBarButton, ChatBarPressCtx, ChatSubmitInterceptor, ChatSubmitCtx,
  PrefsTab, PrefsTabGroupId, ViewMenuButton, MinimapMarker, MinimapMarkerDescriptor,
  WelcomeMessageRenderer, SessionPickerRegion, SessionPickerSlotEntry,
  CwdDropdownEntry, HarnessTypeEntry, PanelEntry, HotkeyBinding, HudButton,
  FrontendRegisters, Reg,
} from './keys.js';

import { registers } from './keys.js';
import { removeModuleEverywhere } from './registers.js';
import { registerAgentSurface } from './surface-registry.js';

const host = {
  registers,
  removeModuleEverywhere,
  agentSurfaces: { register: registerAgentSurface },
};
export default host;
export type Host = typeof host;
