// welcome-messages — frontend module that owns the empty-chat
// greeting line and the hero "growl" audio gesture. Both register
// into the `panels` register so App.tsx is blind to them; the slots
// `chat-empty-greeting` and `chat-hero-growl` mount the components
// when the module is enabled.

import host from '../../host/index.js';
import { ChatEmptyGreeting } from './ChatEmptyGreeting.js';
import { ChatHeroGrowl } from './ChatHeroGrowl.js';

const MODULE_NAME = 'welcome-messages';

export default {
  activate() {
    host.registers.panels.add(
      {
        id: 'welcome-messages.empty-greeting',
        slotId: 'chat-empty-greeting',
        component: ChatEmptyGreeting,
        order: 100,
      },
      MODULE_NAME,
    );
    host.registers.panels.add(
      {
        id: 'welcome-messages.hero-growl',
        slotId: 'chat-hero-growl',
        component: ChatHeroGrowl,
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
