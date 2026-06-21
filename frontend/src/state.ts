// Shared state, event bus, and save/restore helpers for YHA frontend.

import { useAppStore, useGraphStore, useChatStore } from './stores/index.js';
import { store } from './store.js';

type BusHandler = (data?: unknown) => void;

export const state = {
  // `yha.theme` is the pre-rename key; appStore handles full migration. This
  // legacy `state.theme` field is kept for any vanilla-JS callers that still
  // reach into window.app.state during hydration.
  colorTheme: localStorage.getItem('yha.colorTheme') || localStorage.getItem('yha.theme') || 'default-dark',
  viewMode: localStorage.getItem('yha.viewMode') || 'split',
  viewSplit: parseFloat(localStorage.getItem('yha.viewSplit') || '0.5'),
  viewOrient: localStorage.getItem('yha.viewOrient') || 'h',
  headerOpen: localStorage.getItem('yha.headerOpen') !== 'false',
  headerOrient: localStorage.getItem('yha.headerOrient') || 'v',
  overlayPos: localStorage.getItem('yha.overlayPos') || 'bottom',
  currentModel: { id: 0, name: 'gpt-4o-mini' } as { id: number; name: string },
  currentPreset: 0,
  currentSession: 0,
  models: [] as unknown[],
  modelsRaw: '',
  workflow: { name: '', id: null as number | null },
  graph: { nodes: [] as unknown[], links: [] as unknown[] },
  chat: { messages: [] as unknown[] },
  editor: { pan: { x: 0, y: 0 }, zoom: 1 },
  tokens: { total: 0, cost: 0 },
  effort: localStorage.getItem('yha.effort') || null,
  recordChat: localStorage.getItem('yha.recordChat') || 'all',
  harnessInstance: localStorage.getItem('yha.harnessInstance') || '',
  codexInstance: localStorage.getItem('yha.codexInstance') || '',
  sysPrompt: (() => {
    try {
      return (
        (JSON.parse(localStorage.getItem('yha.sysPrompt') || 'null') as {
          override: boolean;
          preset: string;
        } | null) || { override: false, preset: '' }
      );
    } catch {
      return { override: false, preset: '' };
    }
  })(),
};

export const bus = (() => {
  const m = new Map<string, BusHandler[]>();
  return {
    on(e: string, fn: BusHandler): void {
      let handlers = m.get(e);
      if (!handlers) {
        handlers = [];
        m.set(e, handlers);
      }
      handlers.push(fn);
    },
    off(e: string, fn: BusHandler): void {
      const a = m.get(e);
      if (a) {
        const i = a.indexOf(fn);
        if (i !== -1) a.splice(i, 1);
      }
    },
    emit(e: string, data?: unknown): void {
      [...(m.get(e) || [])].forEach((fn) => {
        try {
          fn(data);
        } catch (err) {
          console.error(err);
        }
      });
    },
  };
})();

export const save = {
  view(): void {
    const s = useAppStore.getState();
    store.set('viewMode', s.viewMode);
    store.set('viewSplit', s.viewSplit);
    store.set('viewOrient', s.viewOrient);
    store.set('headerOpen', s.headerOpen);
    store.set('headerOrient', s.headerOrient);
    store.set('overlayPos', s.overlayPos);
  },
  colorTheme(): void {
    store.set('colorTheme', useAppStore.getState().colorTheme);
  },
  graph(): void {
    const g = useGraphStore.getState();
    store.set('lastGraph', { nodes: g.nodes, links: g.links });
  },
  chat(): void {
    const messages = useChatStore.getState().messages;
    localStorage.setItem('yha.chat', JSON.stringify(messages.slice(-200)));
  },
};

export const restore = {
  graph(): void {
    try {
      const g = store.get('lastGraph') as { nodes?: unknown[]; links?: unknown[] } | undefined;
      if (g?.nodes) {
        useGraphStore.getState().setNodes(g.nodes as never);
        if (g.links) useGraphStore.getState().setLinks(g.links as never);
      }
    } catch (e) {
      console.warn('restore graph', e);
    }
  },
  chat(): void {
    try {
      const raw = localStorage.getItem('yha.chat');
      if (raw) {
        const messages = JSON.parse(raw);
        useChatStore.getState().setMessages(messages);
      }
    } catch (e) {
      console.warn('restore chat', e);
    }
  },
};
