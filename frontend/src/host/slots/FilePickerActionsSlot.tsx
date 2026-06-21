// FilePickerActionsSlot — renders entries from the `filePickerActions`
// register inside the FilePicker footer. Modules add buttons here without
// FilePicker having to import them.
//
// Usage (in FilePicker.tsx):
//   <FilePickerActionsSlot currentPath={currentPath} closeModal={closeModal} />
//
// Each entry's component receives `{ currentPath, closeModal }` so the child
// button can act on the picker's current directory and close the picker
// before opening its own modal.

import { registers } from '../keys.js';
import { useRegisterList } from '../useRegisterList.js';

interface FilePickerActionsSlotProps {
  currentPath: string;
  closeModal(): void;
}

export function FilePickerActionsSlot({ currentPath, closeModal }: FilePickerActionsSlotProps) {
  const entries = useRegisterList(registers.filePickerActions);
  if (!entries.length) return null;
  return (
    <>
      {entries.map((entry) => {
        const C = entry.component;
        return <C key={entry.id} currentPath={currentPath} closeModal={closeModal} />;
      })}
    </>
  );
}
