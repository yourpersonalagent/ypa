// files-editor — frontend module owning the FileEditor moveable window
// (markdown click-to-edit + CodeMirror 6 code editor). The component is
// lazy-imported from App.tsx so the CodeMirror bundle stays out of the
// initial chunk (~600 KB savings per registers-doc §4.21e).
//
// The bridge object `fileEditor` (frontend/src/modals/file-editor.ts)
// stays in core because vanilla callers (FilePicker, chat.ts,
// HubContextSessionPicker, FileManager) read open/close/isViewable
// from it. FileEditor.tsx populates the bridge on mount; nothing here
// to register, so activate() is a no-op marker that exists so the
// host can list the module + future hot-reload hooks have a handle.

const MODULE_NAME = 'files-editor';

export default {
  activate() {
    // No registers to populate — App.tsx renders <FileEditor /> directly
    // via a lazy() import that resolves to ./FileEditor.js. When the FE
    // moves to dynamic /v1/modules-driven loading (plan §5), this is
    // where we'd register a panels-slot entry instead.
    return { name: MODULE_NAME };
  },
  deactivate() {
    // No-op for the same reason.
  },
};
