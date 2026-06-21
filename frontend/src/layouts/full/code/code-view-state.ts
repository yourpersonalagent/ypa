// Code-view UI state — panel layout for the right + bottom stacks and the
// active tab in each. Editor tabs live in EditorRegion's own state; this
// store covers ONLY the side panels (Files/GitHub/Rewind/Terminal/Browser/
// Debug) because they're the ones that move between regions via DnD.
//
// Persisted via PUT /v1/code-view/state alongside editor tabs (see
// bridge/routes/code-view.ts).

import { create } from 'zustand';
import { ALL_PANEL_IDS, DEFAULT_BOTTOM_PANELS, DEFAULT_RIGHT_PANELS, type PanelId } from './code-panels.js';

export type StackId = 'right' | 'bottom';

interface LayoutState {
  right:  PanelId[];
  bottom: PanelId[];
  rightActive:  PanelId | null;
  bottomActive: PanelId | null;
  hydrated: boolean;

  setActive: (stack: StackId, id: PanelId) => void;
  movePanel: (id: PanelId, toStack: StackId, toIndex?: number) => void;
  hydrate: (next: Partial<Omit<LayoutState, 'hydrated' | 'setActive' | 'movePanel' | 'hydrate'>>) => void;
  serialize: () => { right: PanelId[]; bottom: PanelId[]; rightActive: PanelId | null; bottomActive: PanelId | null };
}

function sanitize(list: unknown, fallback: PanelId[]): PanelId[] {
  if (!Array.isArray(list)) return [...fallback];
  const out: PanelId[] = [];
  for (const v of list) {
    if (typeof v === 'string' && ALL_PANEL_IDS.has(v as PanelId) && !out.includes(v as PanelId)) {
      out.push(v as PanelId);
    }
  }
  return out;
}

export const useCodeLayout = create<LayoutState>()((set, get) => ({
  right:        [...DEFAULT_RIGHT_PANELS],
  bottom:       [...DEFAULT_BOTTOM_PANELS],
  rightActive:  DEFAULT_RIGHT_PANELS[0],
  bottomActive: DEFAULT_BOTTOM_PANELS[0],
  hydrated:     false,

  setActive: (stack, id) => set(() => {
    if (stack === 'right')  return { rightActive:  id };
    /* bottom */             return { bottomActive: id };
  }),

  movePanel: (id, toStack, toIndex) => set((s) => {
    const fromRight  = s.right.includes(id);
    const fromBottom = s.bottom.includes(id);
    if (!fromRight && !fromBottom) return s;

    let nextRight  = fromRight  ? s.right.filter((x) => x !== id)  : s.right.slice();
    let nextBottom = fromBottom ? s.bottom.filter((x) => x !== id) : s.bottom.slice();

    const target = toStack === 'right' ? nextRight : nextBottom;
    const insertAt = typeof toIndex === 'number'
      ? Math.max(0, Math.min(target.length, toIndex))
      : target.length;
    target.splice(insertAt, 0, id);

    if (toStack === 'right') nextRight  = target;
    else                      nextBottom = target;

    // Don't leave a stack with an active panel that no longer lives there.
    const rightActive  = nextRight.includes(s.rightActive  ?? ('' as PanelId))
      ? s.rightActive
      : (nextRight[0]  ?? null);
    const bottomActive = nextBottom.includes(s.bottomActive ?? ('' as PanelId))
      ? s.bottomActive
      : (nextBottom[0] ?? null);

    // The moved panel becomes active in its new stack — feels like VSCode.
    const finalActive = toStack === 'right'
      ? { rightActive: id, bottomActive }
      : { rightActive,    bottomActive: id };

    return {
      right:  nextRight,
      bottom: nextBottom,
      ...finalActive,
    };
  }),

  hydrate: (next) => set(() => {
    const right  = sanitize(next.right,  DEFAULT_RIGHT_PANELS);
    const bottom = sanitize(next.bottom, DEFAULT_BOTTOM_PANELS);
    // Any panel missing from both stacks gets dumped into its default home
    // so disabling a saved layout key doesn't silently drop functionality.
    const present = new Set<PanelId>([...right, ...bottom]);
    for (const id of DEFAULT_RIGHT_PANELS)  if (!present.has(id)) right.push(id);
    for (const id of DEFAULT_BOTTOM_PANELS) if (!present.has(id)) bottom.push(id);

    const rightActive  = right.includes(next.rightActive  as PanelId) ? next.rightActive  as PanelId : (right[0]  ?? null);
    const bottomActive = bottom.includes(next.bottomActive as PanelId) ? next.bottomActive as PanelId : (bottom[0] ?? null);
    return { right, bottom, rightActive, bottomActive, hydrated: true };
  }),

  serialize: () => {
    const s = get();
    return {
      right:        s.right,
      bottom:       s.bottom,
      rightActive:  s.rightActive,
      bottomActive: s.bottomActive,
    };
  },
}));
