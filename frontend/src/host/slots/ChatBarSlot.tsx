// ChatBarSlot — renders entries from the `chatBarButtons` register for one side.
//
// Usage (in ChatView.tsx):
//   <ChatBarSlot side="left" />   — renders all registered left-side buttons
//   <ChatBarSlot side="right" />  — renders all registered right-side buttons
//
// Modules register buttons via host.registers.chatBarButtons.add():
//
//   // shorthand button (plain <button>):
//   host.registers.chatBarButtons.add({
//     id: 'voice.voicemode', side: 'left', group: 'voice',
//     title: 'Voice mode [Alt+V]', domId: 'chat-voicemode',
//     icon: <SomeIcon />,
//     onPress: () => window.dispatchEvent(new CustomEvent('yha:voice-mode-open')),
//   }, MODULE_NAME);
//
//   // component button (owns its own state, e.g. mic toggle):
//   host.registers.chatBarButtons.add({
//     id: 'voice.chat-bar', side: 'left', group: 'voice',
//     title: 'Voice', component: VoiceGroupButtons,
//   }, MODULE_NAME);
//
// When a module is disabled its entries are removed automatically; the slot
// renders nothing — the surrounding bar layout is unaffected.

import type { ComponentType } from 'react';
import { useSessionStore, useAppStore } from '../../stores/index.js';
import { registers } from '../keys.js';
import { useRegisterList } from '../useRegisterList.js';
import type { ChatBarPressCtx } from '../keys.js';

interface ChatBarSlotProps {
  side: 'left' | 'right';
}

export function ChatBarSlot({ side }: ChatBarSlotProps) {
  const entries = useRegisterList(registers.chatBarButtons);
  const filtered = entries.filter((e) => e.side === side);
  const sessionId = useSessionStore((s) => s.currentId);
  const cwd = useAppStore((s) => s.sessionWorkingDir ?? null);

  if (!filtered.length) return null;

  return (
    <>
      {filtered.map((entry) => {
        // Component mode — module owns full rendering + state
        if (entry.component) {
          const C = entry.component as ComponentType;
          return <C key={entry.id} />;
        }

        // Shorthand mode — slot renders a standard chat-bar-btn
        const icon = typeof entry.icon === 'function' ? entry.icon() : entry.icon;
        const ctx: ChatBarPressCtx = {
          // Resolved lazily at press time so we don't hold a stale reference
          // to the React-managed <textarea> that ChatInput.tsx replaces on mount.
          textareaRef: {
            get current() {
              return document.getElementById('chat-ta') as HTMLTextAreaElement | null;
            },
          } as React.RefObject<HTMLTextAreaElement>,
          valueRef: {
            get current() {
              return (document.getElementById('chat-ta') as HTMLTextAreaElement | null)?.value ?? '';
            },
          } as React.MutableRefObject<string>,
          sessionId: sessionId != null ? String(sessionId) : null,
          cwd,
        };

        return (
          <button
            key={entry.id}
            id={entry.domId}
            className="chat-bar-btn"
            title={entry.title}
            onClick={() => entry.onPress?.(ctx)}
          >
            {icon ?? entry.label}
          </button>
        );
      })}
    </>
  );
}
