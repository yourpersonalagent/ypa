// PanelSlot — renders entries from the `panels` register matching a
// given slot id. Used for "named regions" where a module plugs in one
// component (chat-minimap, welcome-messages, …).
//
// Usage:
//   <PanelSlot id="chat-minimap" />
//
// When the chat-minimap module is enabled, its `index.ts` calls
// `host.registers.panels.add({ id: 'chat-minimap.host', slotId:
// 'chat-minimap', component: Minimap })`. The slot finds the entry
// and renders it. With the module disabled, the slot renders nothing
// — chat-scroll keeps working without a minimap (plan §8 done
// criterion 13).

import { Suspense } from 'react';
import { registers } from '../keys.js';
import { useRegisterList } from '../useRegisterList.js';

interface PanelSlotProps {
  id: string;
}

export function PanelSlot({ id }: PanelSlotProps) {
  const entries = useRegisterList(registers.panels);
  const matching = entries.filter((e) => e.slotId === id);
  return (
    <>
      {matching.map((entry) => {
        const C = entry.component;
        // Wrap in Suspense so modules can register React.lazy() components
        // (e.g. heavy pet modals, file editor) without a separate Suspense
        // boundary in App.tsx. fallback=null keeps the DOM quiet until ready.
        return (
          <Suspense key={entry.id} fallback={null}>
            <C />
          </Suspense>
        );
      })}
    </>
  );
}
