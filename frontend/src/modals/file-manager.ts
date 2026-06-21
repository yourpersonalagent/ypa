// File-manager bridge object. The React FileManager.tsx component owns the
// modal UI and writes its open/close handlers into this object on mount;
// vanilla callers (FilePicker.tsx footer button, KeyboardShortcuts.tsx
// `Ctrl+Shift+F`, Shell.tsx header button) read them from here.

export const fileManager: {
  open?: (path?: string) => void;
  close?: () => void;
} = {};
