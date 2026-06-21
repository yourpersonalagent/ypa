// context — frontend module.
//
// Owns the chat-input "Context" notepad-icon button (left side of the
// chat bar, between sessions and the # commands button) and the
// QuickContextPicker popover that opens off it.
//
// What it registers:
//   • chatBarButtons → { id: 'context.chat-notes-btn', side: 'left',
//                        group: 'context', order: 50, component: ChatNotesButton }
//   • panels         → { slotId: 'context-quick-picker', component: QuickContextPicker }
//
// QuickContextPicker self-wires its trigger by reading
// `document.getElementById('chat-notes-btn')`, so the rendered button keeps
// that DOM id. When the module is disabled both the icon and the popover
// disappear together.

import { lazy } from 'react';
import host from '../../host/index.js';
import { ChatNotesButton } from './ChatNotesButton.js';

const QuickContextPicker = lazy(() =>
  import('../../chat/QuickContextPicker.js').then((m) => ({ default: m.QuickContextPicker })),
);

const MODULE_NAME = 'context';

export default {
  activate() {
    host.registers.chatBarButtons.add(
      {
        id: 'context.chat-notes-btn',
        side: 'left',
        group: 'context',
        order: 50,
        title: 'Context — pick from notes, mail, calendar, sessions, files',
        component: ChatNotesButton,
      },
      MODULE_NAME,
    );

    host.registers.panels.add(
      {
        id: 'context.quick-picker',
        slotId: 'context-quick-picker',
        component: QuickContextPicker,
      },
      MODULE_NAME,
    );

    // Palette entry so the button is reachable on layouts that hide the
    // chat bar (Zen, Messenger). Clicks the rendered button so the
    // self-wired QuickContextPicker handler fires unchanged.
    host.registers.appCommands.add(
      {
        id: 'chat.context-notes',
        group: 'chat',
        label: 'Open Context Notes',
        icon: 'sticky-note',
        keywords: ['chat', 'context', 'notes', 'notepad', 'mail', 'calendar', 'files'],
        run: ({ closePalette }) => {
          document.getElementById('chat-notes-btn')?.click();
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
