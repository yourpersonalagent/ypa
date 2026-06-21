// Code-view bridge object. The CodeView's EditorRegion writes its public
// methods (open/close/listTabs) into this object on mount; other parts of
// the app call into it without holding a React ref. Mirrors the pattern
// used by frontend/src/modals/file-editor.ts.

export const codeView: {
  openFile?: (path: string, name?: string) => void;
  closeFile?: (path: string) => void;
  listTabs?: () => string[];
} = {};
