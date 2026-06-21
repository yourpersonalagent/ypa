// Minimal compatibility shim — the real workflow canvas now lives in
// workflows/WorkflowEditor.tsx (React SVG renderer).
//
// All UI rendering / drag / port-positioning code that used to be here was
// removed once WorkflowEditor.tsx took over. This file remains only to keep
// `editor.fit()` / `editor.init()` / `editor.render()` callable from a few
// vanilla service modules (workflow.ts, triggers.ts, main.ts) — they update
// the graphStore which WorkflowEditor.tsx subscribes to.

import { getGraphState, getGraphActions } from '../stores/index.js';

function init(): void { /* no-op — WorkflowEditor.tsx mounts the canvas */ }
function render(): void { /* no-op — WorkflowEditor.tsx renders via JSX */ }

// Auto-fit pan/zoom so all nodes fit on screen. Updates the editor pan/zoom
// in the Zustand store; WorkflowEditor.tsx subscribes and applies the SVG
// transform.
function fit(): void {
  const ns = getGraphState().nodes;
  if (!ns.length) return;
  const xs = ns.map((n) => n.x);
  const ys = ns.map((n) => n.y);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  getGraphActions().setEditor({ pan: { x: 60 - minX, y: 60 - minY }, zoom: 1 });
}

export const editor = { init, render, fit };
export default editor;
