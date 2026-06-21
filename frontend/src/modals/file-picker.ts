// File-picker handle. The React FilePicker.tsx component owns the modal UI
// and writes its open handler into this object on mount; vanilla callers
// (chat.ts) read it from here.

export const filePicker: {
  open?: () => void;
} = {};
