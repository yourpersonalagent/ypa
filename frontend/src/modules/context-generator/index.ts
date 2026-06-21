// context-generator — frontend module.
//
// Owns:
//   • The "Context Generator" header icon button (secondary row, order 10) —
//     ContextGenButton manages its own modal open/close via the
//     `yha:open-context-hub` event.
//   • The chat-bar "⚡" RAG button (left side, group 'context-rag', order 55)
//     and the QuickRagPicker popover that opens off it. Both pieces are
//     gated by this module's enable bit, so disabling context-generator
//     also hides the RAG surface in the composer.
//
// Component files live under `frontend/src/context/` and `frontend/src/chat/`
// (kept in place to avoid churn for unrelated importers); this module only
// registers them.

import { lazy } from 'react';
import host from '../../host/index.js';
import { ContextGenButton } from '../../context/ContextGenButton.js';
import { QuickRagButton } from './QuickRagButton.js';

const QuickRagPicker = lazy(() =>
  import('../../chat/QuickRagPicker.js').then((m) => ({ default: m.QuickRagPicker })),
);

const MODULE_NAME = 'context-generator';

export default {
  activate() {
    host.registers.headerIconButtons.add(
      {
        id: 'context-generator.header-icon',
        group: 'secondary',
        order: 10,
        component: ContextGenButton,
      },
      MODULE_NAME,
    );

    host.registers.chatBarButtons.add(
      {
        id: 'context-generator.chat-rag-btn',
        side: 'left',
        group: 'context-rag',
        order: 55,
        title: 'RAG — search vector DBs and attach hits to the next message',
        component: QuickRagButton,
      },
      MODULE_NAME,
    );

    host.registers.panels.add(
      {
        id: 'context-generator.quick-rag-picker',
        slotId: 'context-rag-quick-picker',
        component: QuickRagPicker,
      },
      MODULE_NAME,
    );

    host.registers.appCommands.add(
      {
        id: 'chat.rag-search',
        group: 'chat',
        label: 'Open RAG Search',
        icon: 'zap',
        keywords: ['chat', 'rag', 'vector', 'search', 'context-rag', 'attach'],
        run: ({ closePalette }) => {
          document.getElementById('chat-rag-btn')?.click();
          closePalette();
        },
      },
      MODULE_NAME,
    );

    return { name: MODULE_NAME };
  },
  deactivate() {
    host.removeModuleEverywhere(MODULE_NAME);
  },
};
