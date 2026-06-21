// File-editor bridge object. The React FileEditor.tsx component owns the
// modal UI and writes its open/close/isViewable handlers into this object
// on mount; vanilla callers (FilePicker.tsx) read them from here.

export const fileEditor: {
  open?: (path: string, name?: string) => void;
  close?: () => void;
  isViewable?: (name: string) => boolean;
} = {};
