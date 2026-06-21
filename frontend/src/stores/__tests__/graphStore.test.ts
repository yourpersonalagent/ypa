import { beforeEach, describe, expect, it } from 'vitest';
import { useGraphStore } from '../graphStore.js';

const reset = () =>
  useGraphStore.setState({ nodes: [], links: [], selectedNodeId: null, editor: { pan: { x: 0, y: 0 }, zoom: 1 } });

describe('graphStore', () => {
  beforeEach(reset);

  describe('addNode()', () => {
    it('creates a node with defaults and returns it', () => {
      const n = useGraphStore.getState().addNode();
      expect(n.id).toMatch(/^n/);
      expect(n.type).toBe('command');
      expect(n.status).toBe('idle');
      expect(useGraphStore.getState().nodes).toHaveLength(1);
      expect(useGraphStore.getState().nodes[0]).toEqual(n);
    });

    it('merges supplied partial fields', () => {
      const n = useGraphStore.getState().addNode({ title: 'My Node', x: 100, y: 50 });
      expect(n.title).toBe('My Node');
      expect(n.x).toBe(100);
      expect(n.y).toBe(50);
    });

    it('auto-detects #if command → type "if"', () => {
      const n = useGraphStore.getState().addNode({ command: '#if foo == bar' });
      expect(n.type).toBe('if');
    });

    it('auto-detects #agent command → type "agent"', () => {
      const n = useGraphStore.getState().addNode({ command: '#agent do something' });
      expect(n.type).toBe('agent');
    });

    it('does not override explicit type with auto-detection', () => {
      const n = useGraphStore.getState().addNode({ type: 'workflow', command: '#if x' });
      expect(n.type).toBe('workflow');
    });
  });

  describe('removeNode()', () => {
    it('removes the node and its connected links', () => {
      const a = useGraphStore.getState().addNode();
      const b = useGraphStore.getState().addNode();
      useGraphStore.getState().addLink(a.id, b.id);
      useGraphStore.getState().removeNode(a.id);
      expect(useGraphStore.getState().nodes).toHaveLength(1);
      expect(useGraphStore.getState().links).toHaveLength(0);
    });

    it('clears selectedNodeId when the selected node is removed', () => {
      const n = useGraphStore.getState().addNode();
      useGraphStore.setState({ selectedNodeId: n.id });
      useGraphStore.getState().removeNode(n.id);
      expect(useGraphStore.getState().selectedNodeId).toBeNull();
    });

    it('preserves selectedNodeId when a different node is removed', () => {
      const a = useGraphStore.getState().addNode();
      const b = useGraphStore.getState().addNode();
      useGraphStore.setState({ selectedNodeId: b.id });
      useGraphStore.getState().removeNode(a.id);
      expect(useGraphStore.getState().selectedNodeId).toBe(b.id);
    });
  });

  describe('updateNode()', () => {
    it('patches the node and returns the updated object', () => {
      const n = useGraphStore.getState().addNode({ title: 'old' });
      const updated = useGraphStore.getState().updateNode(n.id, { title: 'new' });
      expect(updated?.title).toBe('new');
      expect(useGraphStore.getState().nodes[0].title).toBe('new');
    });

    it('returns null for unknown id', () => {
      const result = useGraphStore.getState().updateNode('unknown', { title: 'x' });
      expect(result).toBeNull();
    });
  });

  describe('addLink()', () => {
    it('creates a link between two nodes', () => {
      const a = useGraphStore.getState().addNode();
      const b = useGraphStore.getState().addNode();
      const link = useGraphStore.getState().addLink(a.id, b.id);
      expect(link).not.toBeNull();
      expect(link!.from).toBe(a.id);
      expect(link!.to).toBe(b.id);
      expect(useGraphStore.getState().links).toHaveLength(1);
    });

    it('returns null for self-links', () => {
      const n = useGraphStore.getState().addNode();
      expect(useGraphStore.getState().addLink(n.id, n.id)).toBeNull();
    });

    it('deduplicates identical links', () => {
      const a = useGraphStore.getState().addNode();
      const b = useGraphStore.getState().addNode();
      useGraphStore.getState().addLink(a.id, b.id);
      const dup = useGraphStore.getState().addLink(a.id, b.id);
      expect(dup).toBeNull();
      expect(useGraphStore.getState().links).toHaveLength(1);
    });

    it('stores fromPort when supplied', () => {
      const a = useGraphStore.getState().addNode();
      const b = useGraphStore.getState().addNode();
      const link = useGraphStore.getState().addLink(a.id, b.id, 'out-true');
      expect(link!.fromPort).toBe('out-true');
    });
  });

  describe('removeLink()', () => {
    it('removes a link by id', () => {
      const a = useGraphStore.getState().addNode();
      const b = useGraphStore.getState().addNode();
      const link = useGraphStore.getState().addLink(a.id, b.id)!;
      useGraphStore.getState().removeLink(link.id);
      expect(useGraphStore.getState().links).toHaveLength(0);
    });
  });

  describe('upstreamOf() / downstreamOf()', () => {
    it('returns correct upstream nodes', () => {
      const a = useGraphStore.getState().addNode();
      const b = useGraphStore.getState().addNode();
      useGraphStore.getState().addLink(a.id, b.id);
      const upstream = useGraphStore.getState().upstreamOf(b.id);
      expect(upstream).toHaveLength(1);
      expect(upstream[0].id).toBe(a.id);
    });

    it('returns correct downstream nodes', () => {
      const a = useGraphStore.getState().addNode();
      const b = useGraphStore.getState().addNode();
      useGraphStore.getState().addLink(a.id, b.id);
      const downstream = useGraphStore.getState().downstreamOf(a.id);
      expect(downstream).toHaveLength(1);
      expect(downstream[0].id).toBe(b.id);
    });
  });

  describe('topoOrder()', () => {
    it('returns nodes in topological order', () => {
      const a = useGraphStore.getState().addNode();
      const b = useGraphStore.getState().addNode();
      const c = useGraphStore.getState().addNode();
      useGraphStore.getState().addLink(a.id, b.id);
      useGraphStore.getState().addLink(b.id, c.id);
      const order = useGraphStore.getState().topoOrder();
      const ids = order.map((n) => n.id);
      expect(ids.indexOf(a.id)).toBeLessThan(ids.indexOf(b.id));
      expect(ids.indexOf(b.id)).toBeLessThan(ids.indexOf(c.id));
    });

    it('slices from startId when provided', () => {
      const a = useGraphStore.getState().addNode();
      const b = useGraphStore.getState().addNode();
      const c = useGraphStore.getState().addNode();
      useGraphStore.getState().addLink(a.id, b.id);
      useGraphStore.getState().addLink(b.id, c.id);
      const order = useGraphStore.getState().topoOrder(b.id);
      expect(order[0].id).toBe(b.id);
      expect(order).toHaveLength(2);
    });

    it('throws on cycles', () => {
      const a = useGraphStore.getState().addNode();
      const b = useGraphStore.getState().addNode();
      useGraphStore.getState().addLink(a.id, b.id);
      useGraphStore.getState().addLink(b.id, a.id);
      expect(() => useGraphStore.getState().topoOrder()).toThrow('Cycle detected');
    });
  });

  describe('clear()', () => {
    it('removes all nodes, links, and selection', () => {
      const a = useGraphStore.getState().addNode();
      const b = useGraphStore.getState().addNode();
      useGraphStore.getState().addLink(a.id, b.id);
      useGraphStore.setState({ selectedNodeId: a.id });
      useGraphStore.getState().clear();
      const s = useGraphStore.getState();
      expect(s.nodes).toHaveLength(0);
      expect(s.links).toHaveLength(0);
      expect(s.selectedNodeId).toBeNull();
    });
  });
});
