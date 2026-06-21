// Layout registry — maps `layoutMode` to its React component.
//
// Each layout owns its own chrome (header, rails, composer position, etc.)
// and reads only the appStore fields it needs. Layouts are sandboxed under
// the `[data-layout="<name>"]` attribute selector on <html>, set by
// LayoutAttribute.tsx. CSS lives under `frontend/css/layouts/`.
//
// Adding a new layout:
//   1. Create `frontend/src/layouts/<name>/<Name>Layout.tsx`
//   2. Create `frontend/css/layouts/<name>.css` wrapped in
//      `[data-layout="<name>"] { … }` and import it from the layout component
//      (or globally in `frontend/css/index.css`).
//   3. Append a `LayoutMode` literal to `stores/appStore.ts`.
//   4. Register the component below.
//   5. Drop a `README.md` next to the layout describing intent + chrome.

import type { ComponentType } from 'react';
import type { LayoutMode } from '../stores/appStore.js';
import { FullLayout } from './full/FullLayout.js';
import { MessengerLayout } from './messenger/MessengerLayout.js';
import { ZenLayout } from './zen/ZenLayout.js';

export interface LayoutMeta {
  id: LayoutMode;
  label: string;
  description: string;
  /** Lucide icon name for palette / picker UI. */
  icon: string;
  component: ComponentType;
}

export const LAYOUTS: Record<LayoutMode, LayoutMeta> = {
  full: {
    id: 'full',
    label: 'Full',
    description: 'The default YHA layout — header bar, collapsible sections, chat/workflow split-view.',
    icon: 'layout-dashboard',
    component: FullLayout,
  },
  messenger: {
    id: 'messenger',
    label: 'Messenger',
    description: 'Persistent left rail of sessions, chat pane on the right. Header dissolved into the rail and command palette.',
    icon: 'messages-square',
    component: MessengerLayout,
  },
  zen: {
    id: 'zen',
    label: 'Zen',
    description: 'Absolute minimum — centered single-column chat, no chrome. Every action reachable from the command palette.',
    icon: 'minimize-2',
    component: ZenLayout,
  },
};

export function getLayoutComponent(mode: LayoutMode): ComponentType {
  return (LAYOUTS[mode] ?? LAYOUTS.full).component;
}

export function listLayouts(): LayoutMeta[] {
  return Object.values(LAYOUTS);
}
