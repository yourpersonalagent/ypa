// "Manage…" button shown in the FilePicker footer. Closes the picker and
// opens the FileManager modal scoped to the picker's current directory.
// Lives in the files-manager module so it disappears when the module is
// disabled, in lockstep with the header icon and modal.

import { fileManager } from '../../modals/file-manager.js';

interface Props {
  currentPath: string;
  closeModal(): void;
}

export function ManageButton({ currentPath, closeModal }: Props) {
  return (
    <button
      className="fp-btn"
      title="Open File Manager (drag-drop, mkdir, rename, move, delete) [Ctrl+Shift+F]"
      onClick={() => {
        closeModal();
        // Wait a tick for the popover to actually close before opening the
        // FileManager modal — otherwise the outside-click handler on the
        // popover briefly competes with the modal's mount.
        setTimeout(() => fileManager.open?.(currentPath), 0);
      }}
    >
      Manage…
    </button>
  );
}
