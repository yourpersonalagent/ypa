// CwdDropdownSlot — renders entries from the `cwdDropdownEntries` register.
// Used inside CwdPanel so modules can plug in extra rows bound to the
// active working directory without CwdPanel having to import them.
//
// Usage:
//   <CwdDropdownSlot cwd={cwd} />
//
// Each entry's component receives `{ cwd }` props so the child can react to
// the active working directory without re-subscribing to the same stores
// CwdPanel already reads.

import { registers } from '../keys.js';
import { useRegisterList } from '../useRegisterList.js';

interface CwdDropdownSlotProps {
  cwd: string | null;
}

export function CwdDropdownSlot({ cwd }: CwdDropdownSlotProps) {
  const entries = useRegisterList(registers.cwdDropdownEntries);
  if (!entries.length || !cwd) return null;
  return (
    <>
      {entries.map((entry) => {
        const C = entry.component;
        return <C key={entry.id} cwd={cwd} />;
      })}
    </>
  );
}
