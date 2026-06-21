// graphStore — graph/node/link state for the workflow editor
// Pure data layer (no DOM). Replaces app.graph namespace + app.state.graph data.

import { create } from 'zustand';
import { devtools } from 'zustand/middleware';

// ── Types ──────────────────────────────────────────────────────────────────

export interface GraphNode {
  id: string;
  type: string;
  title: string;
  command: string;
  input: string;
  output: string;
  x: number;
  y: number;
  status: 'idle' | 'running' | 'done' | 'error';
  meta: Record<string, unknown>;
  disabled?: boolean;
  inputMode?: 'upstream' | 'manual' | 'off';
  // Per-node agent config (chat nodes only)
  nodeModel?: string;
  nodeModelProvider?: string;
  nodePreset?: string;
  nodeSystemMode?: 'replace' | 'append' | 'off';
  nodeSkillSet?: string;
  nodeToolSetPreset?: string;
  nodeCapVision?: boolean;
  nodeCapReasoning?: 'enabled' | 'disabled' | null;
  nodeCapTools?: 'on' | 'filter' | false;
  decisionLogic?: {
    leftOperand: string;
    operator: string;
    rightOperand: string;
  };
  triggerConfig?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface GraphLink {
  id: string;
  from: string;
  to: string;
  fromPort?: string | null;
}

export interface LastExecuted {
  nodeId: string;
  node: GraphNode;
  output: unknown;
  error: boolean;
  data?: unknown;
  viaChatEngine?: boolean;
}

export interface GraphState {
  nodes: GraphNode[];
  links: GraphLink[];
  selectedNodeId: string | null;
  editor: {
    pan: { x: number; y: number };
    zoom: number;
  };
  lastExecuted: LastExecuted | null;
  graphRevision: number;
}

export interface GraphActions {
  addNode: (partial?: Partial<GraphNode>) => GraphNode;
  removeNode: (id: string) => void;
  updateNode: (id: string, patch: Partial<GraphNode>) => GraphNode | null;
  getNode: (id: string) => GraphNode | undefined;
  addLink: (from: string, to: string, fromPort?: string | null) => GraphLink | null;
  removeLink: (id: string) => void;
  clear: () => void;
  setNodes: (nodes: GraphNode[]) => void;
  setLinks: (links: GraphLink[]) => void;
  setSelectedNodeId: (id: string | null) => void;
  setEditor: (patch: Partial<GraphState['editor']>) => void;
  setLastExecuted: (e: LastExecuted | null) => void;
  bumpRevision: () => void;
  upstreamOf: (id: string) => GraphNode[];
  downstreamOf: (id: string) => GraphNode[];
  topoOrder: (startId?: string | null) => GraphNode[];
  hydrateFromLegacy: () => void;
}

export type GraphStore = GraphState & GraphActions;

// ── Helpers ────────────────────────────────────────────────────────────────

// Graph node ids round-trip through the bridge's `triggers` engine and into
// persisted workflow JSON, so Math.random's ~1-in-10⁹ collision probability is
// not a theoretical concern: a long-lived workflow can accumulate enough nodes
// for a single collision to corrupt edge bindings silently. Prefer the WebCrypto
// UUID when available and fall back to the legacy form on ancient browsers.
function uid(prefix = 'n'): string {
  const cryptoApi: { randomUUID?: () => string } | undefined =
    typeof globalThis !== 'undefined' ? (globalThis as { crypto?: { randomUUID?: () => string } }).crypto : undefined;
  if (cryptoApi?.randomUUID) {
    return prefix + cryptoApi.randomUUID().replace(/-/g, '').slice(0, 12);
  }
  return prefix + Math.random().toString(36).slice(2, 9);
}

function inferType(cmd: unknown): string | null {
  if (!cmd || typeof cmd !== 'string') return null;
  const c = cmd.trim();
  if (/^#if(\s|$)/i.test(c)) return 'if';
  if (/^#agent(\s|$)/i.test(c)) return 'agent';
  if (/^#workflow(\s|$)/i.test(c)) return 'workflow';
  return null;
}

// ── Store ──────────────────────────────────────────────────────────────────

export const useGraphStore = create<GraphStore>()(devtools((set, get) => ({
  nodes: [],
  links: [],
  selectedNodeId: null,
  editor: { pan: { x: 0, y: 0 }, zoom: 1 },
  lastExecuted: null,
  graphRevision: 0,

  addNode: (partial) => {
    const n: GraphNode = {
      id: uid('n'),
      type: 'command',
      title: '',
      command: '',
      input: '',
      output: '',
      x: 200,
      y: 200,
      status: 'idle',
      meta: {},
      decisionLogic: { leftOperand: 'content', operator: '==', rightOperand: '' },
      ...(partial || {}),
    };

    // Auto-detect type from command when caller didn't set an explicit type
    if (!partial || !partial.type || partial.type === 'command') {
      const detected = inferType(n.command);
      if (detected) n.type = detected;
    }

    set((s) => ({ nodes: [...s.nodes, n], graphRevision: s.graphRevision + 1 }));
    return n;
  },

  removeNode: (id) => {
    set((s) => ({
      nodes: s.nodes.filter((n) => n.id !== id),
      links: s.links.filter((l) => l.from !== id && l.to !== id),
      selectedNodeId: s.selectedNodeId === id ? null : s.selectedNodeId,
      graphRevision: s.graphRevision + 1,
    }));
  },

  updateNode: (id, patch) => {
    const state = get();
    const idx = state.nodes.findIndex((n) => n.id === id);
    if (idx === -1) return null;
    const updated = { ...state.nodes[idx], ...patch };
    set((s) => {
      const nodes = [...s.nodes];
      nodes[idx] = updated;
      return { nodes, graphRevision: s.graphRevision + 1 };
    });
    return updated;
  },

  getNode: (id) => {
    return get().nodes.find((n) => n.id === id);
  },

  addLink: (from, to, fromPort) => {
    if (from === to) return null;
    const state = get();
    if (
      state.links.some(
        (l) => l.from === from && l.to === to && (l.fromPort || null) === (fromPort || null)
      )
    )
      return null;

    const link: GraphLink = { id: uid('l'), from, to };
    if (fromPort) link.fromPort = fromPort;
    set((s) => ({ links: [...s.links, link], graphRevision: s.graphRevision + 1 }));
    return link;
  },

  removeLink: (id) => {
    set((s) => ({ links: s.links.filter((l) => l.id !== id), graphRevision: s.graphRevision + 1 }));
  },

  clear: () => set((s) => ({ nodes: [], links: [], selectedNodeId: null, graphRevision: s.graphRevision + 1 })),

  setNodes: (nodes) => set((s) => ({ nodes, graphRevision: s.graphRevision + 1 })),
  setLinks: (links) => set((s) => ({ links, graphRevision: s.graphRevision + 1 })),
  setSelectedNodeId: (selectedNodeId) => set({ selectedNodeId }),

  setEditor: (patch) => {
    set((s) => ({ editor: { ...s.editor, ...patch } }));
  },

  setLastExecuted: (lastExecuted) => set({ lastExecuted }),
  bumpRevision: () => set((s) => ({ graphRevision: s.graphRevision + 1 })),

  upstreamOf: (id) => {
    const state = get();
    return state.links
      .filter((l) => l.to === id)
      .map((l) => state.nodes.find((n) => n.id === l.from))
      .filter((n): n is GraphNode => n !== undefined);
  },

  downstreamOf: (id) => {
    const state = get();
    return state.links
      .filter((l) => l.from === id)
      .map((l) => state.nodes.find((n) => n.id === l.to))
      .filter((n): n is GraphNode => n !== undefined);
  },

  topoOrder: (startId = null) => {
    const state = get();
    const ids = new Set(state.nodes.map((n) => n.id));
    const incoming = new Map<string, number>();
    ids.forEach((i) => incoming.set(i, 0));
    state.links.forEach((l) => {
      if (ids.has(l.to)) incoming.set(l.to, (incoming.get(l.to) || 0) + 1);
    });
    const queue: string[] = [...ids].filter((i) => (incoming.get(i) || 0) === 0);
    const order: GraphNode[] = [];
    while (queue.length) {
      const i = queue.shift()!;
      const node = state.nodes.find((n) => n.id === i);
      if (node) order.push(node);
      for (const l of state.links.filter((l) => l.from === i)) {
        incoming.set(l.to, incoming.get(l.to)! - 1);
        if (incoming.get(l.to) === 0) queue.push(l.to);
      }
    }
    if (order.length !== ids.size) throw new Error('Cycle detected');
    if (startId) {
      const idx = order.findIndex((n) => n.id === startId);
      return idx >= 0 ? order.slice(idx) : order;
    }
    return order;
  },

  hydrateFromLegacy: () => {
    const win = window as unknown as { app?: { state?: { graph?: { nodes?: unknown[]; links?: unknown[] }; editor?: { pan: { x: number; y: number }; zoom: number } } } };
    const legacy = win.app?.state;
    if (!legacy) return;
    if (legacy.graph?.nodes) set({ nodes: legacy.graph.nodes as GraphNode[] });
    if (legacy.graph?.links) set({ links: legacy.graph.links as GraphLink[] });
    if (legacy.editor) set({ editor: legacy.editor as GraphState['editor'] });
  },
}), { name: 'GraphStore' }));

// ── Convenience getters ────────────────────────────────────────────────────
export function getGraphState(): GraphState {
  return useGraphStore.getState();
}

export function getGraphActions(): GraphActions {
  return useGraphStore.getState();
}
