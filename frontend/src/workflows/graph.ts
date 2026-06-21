// Pure data-layer: nodes, links, topo sort. No DOM.
// Phase 2: thin shim that delegates to graphStore and emits legacy bus events.

import { getGraphActions } from '../stores/index.js';

export const graph = (() => {
  function uid(prefix: string = 'n'): string {
    return prefix + Math.random().toString(36).slice(2, 9);
  }

  function _bus() {
    return (window as unknown as { app?: { bus?: { emit: (e: string, d?: unknown) => void } } }).app?.bus;
  }

  function addNode(partial?: Record<string, unknown> | null): unknown {
    const n = getGraphActions().addNode(partial as any);
    _bus()?.emit('graph:change', { reason: 'addNode', node: n });
    return n;
  }

  function removeNode(id: string): void {
    getGraphActions().removeNode(id);
    _bus()?.emit('graph:change', { reason: 'removeNode', id });
  }

  function updateNode(id: string, patch: Record<string, unknown>): unknown {
    const n = getGraphActions().updateNode(id, patch as any);
    _bus()?.emit('graph:change', { reason: 'updateNode', id, patch });
    return n;
  }

  function addLink(from: string, to: string, fromPort?: string): unknown {
    const l = getGraphActions().addLink(from, to, fromPort);
    if (l) _bus()?.emit('graph:change', { reason: 'addLink', link: l });
    return l;
  }

  function removeLink(id: string): void {
    getGraphActions().removeLink(id);
    _bus()?.emit('graph:change', { reason: 'removeLink', id });
  }

  function getNode(id: string): unknown {
    return getGraphActions().getNode(id);
  }

  function upstreamOf(id: string): unknown[] {
    return getGraphActions().upstreamOf(id);
  }

  function downstreamOf(id: string): unknown[] {
    return getGraphActions().downstreamOf(id);
  }

  function topoOrder(startId: string | null = null): unknown[] {
    return getGraphActions().topoOrder(startId);
  }

  function clear(): void {
    getGraphActions().clear();
    _bus()?.emit('graph:change', { reason: 'clear' });
  }

  return {
    uid,
    addNode,
    removeNode,
    updateNode,
    addLink,
    removeLink,
    getNode,
    upstreamOf,
    downstreamOf,
    topoOrder,
    clear,
  };
})();
