// Registry of movable panels for the Code view's two tab stacks (right +
// bottom). Each panel has an id, a short label, and a render function. The
// layout — which panels live in which stack, in what order — is held in
// code-view-state.ts and persisted via the bridge.
//
// Editor file tabs stay in EditorRegion; they're inherently bound to the
// CodeMirror host. Only these "side panels" are draggable between regions.

import type { ReactNode } from 'react';
import { FilesPanel, GithubPanel, RewindPanel } from './panels/right-panels.js';
import { TerminalPanel, DebugPanel } from './panels/bottom-panels.js';

// Browser dropped — the header already has a dedicated Browser button.
export type PanelId =
  | 'files' | 'github' | 'rewind'
  | 'terminal' | 'debug';

export interface PanelDef {
  id: PanelId;
  label: string;
  render: () => ReactNode;
}

export const PANELS: Record<PanelId, PanelDef> = {
  files:    { id: 'files',    label: 'Files',    render: () => <FilesPanel    /> },
  github:   { id: 'github',   label: 'GitHub',   render: () => <GithubPanel   /> },
  rewind:   { id: 'rewind',   label: 'Rewind',   render: () => <RewindPanel   /> },
  terminal: { id: 'terminal', label: 'Terminal', render: () => <TerminalPanel /> },
  debug:    { id: 'debug',    label: 'Debug',    render: () => <DebugPanel    /> },
};

export const DEFAULT_RIGHT_PANELS:  PanelId[] = ['files', 'github', 'rewind'];
export const DEFAULT_BOTTOM_PANELS: PanelId[] = ['terminal', 'debug'];

export const ALL_PANEL_IDS = new Set<PanelId>(Object.keys(PANELS) as PanelId[]);
