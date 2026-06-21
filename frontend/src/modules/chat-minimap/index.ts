// chat-minimap — first real frontend module under the modular plan.
//
// What it does: registers the `Minimap` component into the `panels`
// register at slot id `chat-minimap`. Wherever ChatView (or its
// successor) renders `<PanelSlot id="chat-minimap" />`, the minimap
// appears.
//
// What it does NOT do today: own its own tick-producer registers.
// The Minimap component reads chat messages directly from the store
// (legacy behaviour, byte-identical to before the move). When module
// authors ask for "register a custom marker into the minimap" we add
// the `chatMinimapMarkers` register entries (already declared in
// host/keys.ts) and have Minimap.tsx merge `produce()` results — but
// that's a follow-up, not part of the contract-validation cut.
//
// Disable in `bridge/modules.json` (or by removing the
// `enableChatMinimap()` call from `host/enabled-modules.ts`):
// minimap disappears, chat-scroll keeps working.

import host from '../../host/index.js';
import { Minimap } from './Minimap.js';

const MODULE_NAME = 'chat-minimap';

export interface ChatMinimapApi {
  /** Module name, for diagnostics. */
  name: string;
}

export default {
  activate(): ChatMinimapApi {
    host.registers.panels.add(
      {
        id: 'chat-minimap.host',
        slotId: 'chat-minimap',
        component: Minimap,
        order: 100,
      },
      MODULE_NAME,
    );
    return { name: MODULE_NAME };
  },
  deactivate() {
    host.removeModuleEverywhere(MODULE_NAME);
  },
};
