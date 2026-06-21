// SessionPickerSlot — renders entries from the `sessionPickerSlots`
// register filtered by `region`. Used inside the CWD panel
// (formerly "session picker") so modules can plug in extra rows
// above/below the canonical sections without panels/CwdPanel.tsx
// having to import them.
//
// Usage:
//   <SessionPickerSlot region="belowSessions" cwd={cwd} sessionId={id} />
//
// Each entry's component receives `{ cwd, sessionId }` props so the
// child can react to the active working directory + session without
// re-subscribing to the same stores CwdPanel already reads.

import { registers, type SessionPickerRegion } from '../keys.js';
import { useRegisterList } from '../useRegisterList.js';

interface SessionPickerSlotProps {
  region: SessionPickerRegion;
  cwd: string | null;
  sessionId: string | null;
}

export function SessionPickerSlot({ region, cwd, sessionId }: SessionPickerSlotProps) {
  const entries = useRegisterList(registers.sessionPickerSlots);
  const matching = entries.filter((e) => e.region === region);
  return (
    <>
      {matching.map((entry) => {
        const C = entry.component;
        return <C key={entry.id} cwd={cwd} sessionId={sessionId} />;
      })}
    </>
  );
}
