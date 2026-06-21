// CodeView — VSCode-style sub-view of the Full layout (`viewMode === 'code'`).
//
// Renders THREE regions: an editor centre (tabs + CodeMirror host + minimap),
// a right-side tab stack and a bottom tab stack. The fourth visible region —
// ChatView in the left column — is rendered by FullLayout itself, so React
// keeps its identity across `viewMode` flips and chat state survives Full ↔
// Code transitions.
//
// The chat ↔ code-view seam is a flex sibling rendered by FullLayout using
// the shared <ChatResizeHandle/> component — same `.splitter` chrome and DnD
// pattern as the chat ↔ workflow divider in Split mode.
//
// The right and bottom regions render the same generic <PanelStack/>; which
// panels (Files / GitHub / Rewind / Terminal / Browser / Debug) live in
// which region is held in code-view-state.ts and persisted via the bridge.
// Tabs are draggable between regions.
//
// CSS: frontend/css/layouts/code.css, scoped under
// [data-layout="full"] #main-views[data-mode="code"]. Loaded from yha.html
// alongside full/messenger/zen layout stylesheets.

import { EditorRegion } from './EditorRegion.js';
import { PanelStack } from './PanelStack.js';

export default function CodeView() {
  return (
    <div className="code-view" data-region-host="true">
      <div className="cv-center">
        <div className="cv-editor-region" aria-label="Editor">
          <EditorRegion />
        </div>
        <div className="cv-bottom-stack" aria-label="Bottom tabs">
          <PanelStack stack="bottom" />
        </div>
      </div>
      <div className="cv-right-stack" aria-label="Right tabs">
        <PanelStack stack="right" />
      </div>
    </div>
  );
}
