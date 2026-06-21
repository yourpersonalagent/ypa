// WorkflowEditor — React SVG node/link canvas replacing editor.ts.
// Portals node cards into #node-layer and bezier paths into #edge-layer.
// Sets #editor-root[data-react="1"] so editor.ts skips its own init/render.

import { useCallback, useEffect, useLayoutEffect, useRef, useState, Fragment } from 'react';
import { createPortal } from 'react-dom';
import { type GraphNode, type GraphLink, useGraphStore, getGraphState, getGraphActions, useAppStore } from '../stores/index.js';
import { bus, save } from '../state.js';
import { node as nodeModule } from './NodeOverlay.js';
import { commands } from '../commands.js';
import { getToastActions } from '../stores/toastStore.js';

// ── Pure helpers (logic ported from editor.ts) ───────────────────────────────

interface Point { x: number; y: number }
interface NodeSize { w: number; h: number }

const PORT_EXT = 4;

function iconFor(n: GraphNode): string {
  if (n.type === 'chat') return '💬';
  if (n.type === 'tool') return '🔧';
  if (n.type === 'if') return '?';
  if (n.type === 'agent') return '🤖';
  if (n.type === 'workflow') return '⚙';
  if (n.type === 'trigger') return '⚡';
  return '▸';
}

function summaryText(n: GraphNode): string {
  const out = (n.output || '').trim();
  if (out) return out.slice(0, 160);
  if (n.command) return String(n.command).slice(0, 160);
  return '(empty)';
}

function bezier(a: Point, b: Point): string {
  const dx = b.x - a.x, dy = b.y - a.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  let cp1x: number, cp1y: number, cp2x: number, cp2y: number;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const off = Math.max(40, Math.min(dist * 0.4, 120));
    cp1x = a.x + (dx >= 0 ? off : -off); cp1y = a.y;
    cp2x = b.x - (dx >= 0 ? off : -off); cp2y = b.y;
  } else {
    const off = Math.max(40, Math.min(dist * 0.4, 120));
    cp1x = a.x; cp1y = a.y + (dy >= 0 ? off : -off);
    cp2x = b.x; cp2y = b.y - (dy >= 0 ? off : -off);
  }
  return `M ${a.x} ${a.y} C ${cp1x} ${cp1y}, ${cp2x} ${cp2y}, ${b.x} ${b.y}`;
}

function optimalDir(
  nodeId: string,
  portType: 'in' | 'out',
  subPort: string | null,
  nodes: GraphNode[],
  links: GraphLink[],
): string {
  const n = nodes.find(x => x.id === nodeId);
  if (!n) return portType === 'out' ? 'right' : 'left';
  let peers: GraphNode[];
  if (portType === 'in') {
    peers = links.filter(l => l.to === nodeId).map(l => nodes.find(x => x.id === l.from)!).filter(Boolean);
  } else if (subPort) {
    peers = links
      .filter(l => l.from === nodeId && (l.fromPort === subPort || (!l.fromPort && subPort === 'true')))
      .map(l => nodes.find(x => x.id === l.to)!)
      .filter(Boolean);
  } else {
    peers = links.filter(l => l.from === nodeId).map(l => nodes.find(x => x.id === l.to)!).filter(Boolean);
  }
  if (!peers.length) return portType === 'out' ? 'right' : 'left';
  const cx = peers.reduce((s, p) => s + p.x, 0) / peers.length;
  const cy = peers.reduce((s, p) => s + p.y, 0) / peers.length;
  const dx = cx - n.x, dy = cy - n.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 'right' : 'left';
  return dy >= 0 ? 'bottom' : 'top';
}

function portPos(
  nodeId: string,
  which: 'in' | 'out',
  subPort: string | null,
  nodes: GraphNode[],
  links: GraphLink[],
  sizes: Map<string, NodeSize>,
): Point | null {
  const n = nodes.find(x => x.id === nodeId);
  const sz = sizes.get(nodeId);
  if (!n || !sz) return null;
  const { w, h } = sz;

  if (which === 'out' && n.type === 'if' && subPort) {
    const dir = optimalDir(nodeId, 'out', subPort, nodes, links);
    const isTrue = subPort === 'true';
    switch (dir) {
      case 'right':  return { x: n.x + w + PORT_EXT, y: n.y + h * (isTrue ? 0.3 : 0.7) };
      case 'left':   return { x: n.x - PORT_EXT,     y: n.y + h * (isTrue ? 0.3 : 0.7) };
      case 'top':    return { x: n.x + w * (isTrue ? 0.35 : 0.65), y: n.y - PORT_EXT };
      case 'bottom': return { x: n.x + w * (isTrue ? 0.35 : 0.65), y: n.y + h + PORT_EXT };
      default:       return { x: n.x + w + PORT_EXT, y: n.y + h * (isTrue ? 0.3 : 0.7) };
    }
  }

  const dir = optimalDir(nodeId, which, null, nodes, links);
  switch (dir) {
    case 'right':  return { x: n.x + w + PORT_EXT, y: n.y + h / 2 };
    case 'left':   return { x: n.x - PORT_EXT,     y: n.y + h / 2 };
    case 'top':    return { x: n.x + w / 2,         y: n.y - PORT_EXT };
    case 'bottom': return { x: n.x + w / 2,         y: n.y + h + PORT_EXT };
    default:       return which === 'in'
      ? { x: n.x - PORT_EXT,     y: n.y + h / 2 }
      : { x: n.x + w + PORT_EXT, y: n.y + h / 2 };
  }
}

// ── Interaction state types ──────────────────────────────────────────────────

interface DragState {
  nodeId: string; startX: number; startY: number;
  startNodeX: number; startNodeY: number;
  moved: boolean; curX: number; curY: number;
}
interface PanState { startX: number; startY: number; startPanX: number; startPanY: number }
interface ConnectState { fromId: string; fromPort: string | null }
interface PinchState {
  pointerIds: [number, number];
  startDist: number;
  startZoom: number;
  startPan: { x: number; y: number };
  startCx: number;
  startCy: number;
}
interface PointerInfo { x: number; y: number; type: string }

type AppWin = { _dragJustEnded?: boolean };

// ── Component ────────────────────────────────────────────────────────────────

export function WorkflowEditor() {
  const layoutMode = useAppStore((s) => s.layoutMode);
  // Editor DOM (#editor-root/#node-layer/#edge-layer) is destroyed when code view opens and rebuilt on return, while this component stays mounted — so the DOM-binding effects below must rebind on this flip, not just on layoutMode.
  const isCode = useAppStore((s) => s.viewMode === 'code');
  const nodes = useGraphStore(s => s.nodes);
  const links = useGraphStore(s => s.links);
  const selectedNodeId = useGraphStore(s => s.selectedNodeId);

  // Stable refs so event handlers never go stale
  const nodesRef = useRef(nodes);
  const linksRef = useRef(links);
  nodesRef.current = nodes;
  linksRef.current = links;

  // DOM refs for imperative drag/pan updates
  const nodeRefs    = useRef<Map<string, HTMLDivElement>>(new Map());
  const nodeSizes   = useRef<Map<string, NodeSize>>(new Map());
  const edgeRefs    = useRef<Map<string, [SVGPathElement, SVGPathElement]>>(new Map());
  const ghostRef    = useRef<SVGPathElement | null>(null);

  // Interaction state (refs — never causes re-renders mid-drag)
  const dragging  = useRef<DragState | null>(null);
  const panning   = useRef<PanState | null>(null);
  const connecting = useRef<ConnectState | null>(null);
  const pinching  = useRef<PinchState | null>(null);
  const activePointers = useRef<Map<number, PointerInfo>>(new Map());

  // Force a re-render only when edge positions need recomputing (after size measurement)
  const [, bumpEdges] = useState(0);

  const measureNodeSizes = useCallback(() => {
    let changed = false;
    nodeRefs.current.forEach((el, id) => {
      const w = el.offsetWidth, h = el.offsetHeight;
      const old = nodeSizes.current.get(id);
      if (!old || old.w !== w || old.h !== h) {
        nodeSizes.current.set(id, { w, h });
        changed = true;
      }
    });
    // Remove stale entries for deleted nodes
    nodeSizes.current.forEach((_, id) => {
      if (!nodeRefs.current.has(id)) { nodeSizes.current.delete(id); changed = true; }
    });
    if (changed) bumpEdges(v => v + 1);
  }, []);

  // Portal targets — resolved after commit so layout switches that recreate
  // #node-layer / #edge-layer are handled correctly.
  const [nodeLayer, setNodeLayer] = useState<Element | null>(null);
  const [edgeSvg, setEdgeSvg]     = useState<Element | null>(null);
  useEffect(() => {
    setNodeLayer(document.getElementById('node-layer'));
    setEdgeSvg(document.getElementById('edge-layer'));
  }, [layoutMode, isCode]);

  // ── Gate editor.ts before its init() runs ─────────────────────────────────
  // React mounts synchronously from react/main.tsx which is imported after
  // main.ts starts its async boot() — so this flag is set before editor.init().
  useLayoutEffect(() => {
    const root = document.getElementById('editor-root');
    if (root) root.dataset.react = '1';
    return () => {
      const r = document.getElementById('editor-root');
      if (r) delete r.dataset.react;
    };
  }, [layoutMode, isCode]);

  // ── Measure node sizes, trigger edge re-render when they change ───────────
  useLayoutEffect(() => {
    if (!nodeLayer || !edgeSvg) return;
    measureNodeSizes();
  }, [nodes, nodeLayer, edgeSvg, measureNodeSizes]);

  // Portal targets are resolved after the first commit. The node refs are then
  // created in the next commit, so edge geometry must be measured off that
  // portal attachment as well as graph changes. ResizeObserver keeps paths
  // correct when content, fonts, or split-view geometry alter node boxes.
  useLayoutEffect(() => {
    if (!nodeLayer || !edgeSvg) return;
    const nodes = [...nodeRefs.current.values()];
    if (!nodes.length) {
      measureNodeSizes();
      return;
    }

    let raf = 0;
    const scheduleMeasure = () => {
      if (raf) cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        raf = 0;
        measureNodeSizes();
      });
    };

    scheduleMeasure();

    if (typeof ResizeObserver === 'undefined') {
      return () => {
        if (raf) cancelAnimationFrame(raf);
      };
    }

    const ro = new ResizeObserver(scheduleMeasure);
    nodes.forEach(el => ro.observe(el));
    return () => {
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [nodes, nodeLayer, edgeSvg, measureNodeSizes]);

  // ── Pan / zoom / drag / connect / pinch pointer events (registered once) ──
  // Pointer Events unify mouse + touch + pen, so the same handlers cover all three.
  // touch-action:none on #editor-root (CSS) tells the browser not to claim touches
  // as scroll/zoom, so our handlers always see the move stream.
  useEffect(() => {
    const root     = document.getElementById('editor-root');
    const nodeLayer = document.getElementById('node-layer');
    const edgeSvg  = document.getElementById('edge-layer') as SVGSVGElement | null;
    if (!root || !nodeLayer || !edgeSvg) return;

    root.style.cursor = 'grab';

    function applyTransform() {
      const { pan, zoom } = getGraphState().editor;
      const t = `translate(${pan.x}px,${pan.y}px) scale(${zoom})`;
      nodeLayer!.style.transform = t;
      (edgeSvg as unknown as HTMLElement).style.transform = t;
    }
    applyTransform();

    function isBackground(el: Element | null): boolean {
      if (!el || el === root || el === edgeSvg || el === nodeLayer) return true;
      if (el.closest?.('.node, .edge, .edge-hit, .port, .editor-hud')) return false;
      return true;
    }

    function updateDragEdges(nodeId: string, nx: number, ny: number) {
      const ns = nodesRef.current;
      const ls = linksRef.current;
      const sz = nodeSizes.current;
      const adj = ns.map(n => (n.id === nodeId ? { ...n, x: nx, y: ny } : n));
      for (const l of ls) {
        if (l.from !== nodeId && l.to !== nodeId) continue;
        const a = portPos(l.from, 'out', l.fromPort ?? null, adj, ls, sz);
        const b = portPos(l.to,   'in',  null,               adj, ls, sz);
        if (!a || !b) continue;
        const d = bezier(a, b);
        const pair = edgeRefs.current.get(l.id);
        if (pair) { pair[0].setAttribute('d', d); pair[1].setAttribute('d', d); }
      }
    }

    function drawGhost(cx: number, cy: number) {
      if (!connecting.current || !ghostRef.current) return;
      const from = portPos(
        connecting.current.fromId, 'out', connecting.current.fromPort,
        nodesRef.current, linksRef.current, nodeSizes.current,
      );
      if (!from) return;
      const r = root!.getBoundingClientRect();
      const { pan, zoom } = getGraphState().editor;
      const to = { x: (cx - r.left - pan.x) / zoom, y: (cy - r.top - pan.y) / zoom };
      ghostRef.current.setAttribute('d', bezier(from, to));
    }

    function openAddNodeAt(cx: number, cy: number) {
      const r = root!.getBoundingClientRect();
      const { pan, zoom } = getGraphState().editor;
      const x = (cx - r.left - pan.x) / zoom;
      const y = (cy - r.top  - pan.y) / zoom;
      commands.openAddNode(cx, cy, (cmd: unknown) => {
        const text = String(cmd || '').trim();
        const isCmd = text.startsWith('#') || text.startsWith('/');
        const isChatNode = !text || text === 'chat' || !isCmd;
        const n = getGraphActions().addNode({
          x, y,
          title: isCmd && text.startsWith('#') ? text.split(' ')[0] : 'chat',
          type: isChatNode ? 'chat' : 'command',
          command: text === 'chat' ? '' : text,
          input: '',
        });
        bus.emit('graph:change', { reason: 'addNode', node: n });
        save.graph();
        nodeModule.openOverlay(n.id);
      });
    }

    // Abort any in-progress single-pointer interaction (used when pinch starts
    // or a pointer is cancelled). Visually rolls back an unsaved node drag so
    // the DOM matches the data model.
    //
    // The store wasn't updated mid-drag (pointer-move only writes inline
    // styles; save.graph() lands on pointerup), so on cancel we just roll
    // the DOM back to the drag-start coords. Without the explicit reflow +
    // inline-style clear below, React's next render could paint *over* the
    // inline transform for a frame, leaving the node visibly shifted until
    // the next mutation. Reading offsetWidth forces synchronous layout so
    // any subsequent state update repaints from the now-authoritative store.
    function cancelInteractions() {
      if (panning.current) { panning.current = null; root!.style.cursor = 'grab'; }
      if (dragging.current) {
        const d = dragging.current;
        dragging.current = null;
        if (d.moved) {
          const el = nodeRefs.current.get(d.nodeId);
          if (el) {
            el.style.left = d.startNodeX + 'px';
            el.style.top = d.startNodeY + 'px';
            // Force reflow before clearing the inline styles so React's
            // next render takes over from the correct geometry rather
            // than racing against the stale style attribute.
            void el.offsetWidth;
            el.style.removeProperty('left');
            el.style.removeProperty('top');
          }
          updateDragEdges(d.nodeId, d.startNodeX, d.startNodeY);
        }
      }
      if (connecting.current) {
        if (ghostRef.current) ghostRef.current.setAttribute('d', '');
        connecting.current = null;
      }
    }

    // Background pan + pinch initiation. Triggered for every pointer that lands
    // anywhere inside #editor-root (node/port pointerdowns also bubble through here
    // — their React handlers stop synthetic propagation, but native delegate runs
    // first, so we can still track pointer count for pinch detection).
    function onPointerDown(e: PointerEvent) {
      activePointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY, type: e.pointerType });

      // Two simultaneous touches anywhere on the canvas → pinch zoom.
      const touchPts = [...activePointers.current.entries()].filter(([, p]) => p.type === 'touch');
      if (touchPts.length >= 2 && !pinching.current) {
        cancelInteractions();
        const [[id1, p1], [id2, p2]] = touchPts;
        const { pan, zoom } = getGraphState().editor;
        pinching.current = {
          pointerIds: [id1, id2],
          startDist: Math.hypot(p2.x - p1.x, p2.y - p1.y) || 1,
          startZoom: zoom,
          startPan: { x: pan.x, y: pan.y },
          startCx: (p1.x + p2.x) / 2,
          startCy: (p1.y + p2.y) / 2,
        };
        return;
      }

      if (pinching.current) return;
      if (e.button === 2 || !isBackground(e.target as Element)) return;
      const { pan } = getGraphState().editor;
      panning.current = { startX: e.clientX, startY: e.clientY, startPanX: pan.x, startPanY: pan.y };
      root!.style.cursor = 'grabbing';
    }

    function onContextMenu(e: MouseEvent) {
      if (!isBackground(e.target as Element)) return;
      e.preventDefault();
      openAddNodeAt(e.clientX, e.clientY);
    }
    function onDblClick(e: MouseEvent) {
      if (isBackground(e.target as Element)) openAddNodeAt(e.clientX, e.clientY);
    }
    function onWheel(e: WheelEvent) {
      if (!e.ctrlKey && !e.metaKey) {
        const { pan } = getGraphState().editor;
        getGraphActions().setEditor({ pan: { x: pan.x - e.deltaX, y: pan.y - e.deltaY } });
      } else {
        e.preventDefault();
        const delta = -e.deltaY * 0.001;
        const { pan, zoom: z0 } = getGraphState().editor;
        const z1 = Math.max(0.25, Math.min(2.5, z0 * (1 + delta)));
        const r = root!.getBoundingClientRect();
        const mx = e.clientX - r.left, my = e.clientY - r.top;
        getGraphActions().setEditor({
          pan: { x: mx - (mx - pan.x) * (z1 / z0), y: my - (my - pan.y) * (z1 / z0) },
          zoom: z1,
        });
      }
      applyTransform();
    }

    // Window-level move + up so drags continue when the pointer leaves #editor-root.
    function onPointerMove(e: PointerEvent) {
      const tracked = activePointers.current.get(e.pointerId);
      if (tracked) { tracked.x = e.clientX; tracked.y = e.clientY; }

      // Pinch: combined zoom + pan around the moving finger midpoint.
      // Math mirrors the wheel-zoom anchor formula but with a moving anchor:
      //   pan_new = anchor_now − (anchor_start − pan_start) × (z1/z0)
      // — so the workspace point originally under the gesture center stays under
      // the (possibly translated) gesture center, and zooms with the spread.
      if (pinching.current) {
        const [id1, id2] = pinching.current.pointerIds;
        const p1 = activePointers.current.get(id1);
        const p2 = activePointers.current.get(id2);
        if (!p1 || !p2) return;
        const cx = (p1.x + p2.x) / 2, cy = (p1.y + p2.y) / 2;
        const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
        const ps = pinching.current;
        const z0 = ps.startZoom;
        const z1 = Math.max(0.25, Math.min(2.5, z0 * dist / ps.startDist));
        const r = root!.getBoundingClientRect();
        const sx = ps.startCx - r.left, sy = ps.startCy - r.top;
        const tx = cx - r.left,         ty = cy - r.top;
        getGraphActions().setEditor({
          pan: {
            x: tx - (sx - ps.startPan.x) * (z1 / z0),
            y: ty - (sy - ps.startPan.y) * (z1 / z0),
          },
          zoom: z1,
        });
        applyTransform();
        return;
      }

      if (panning.current) {
        const dx = e.clientX - panning.current.startX, dy = e.clientY - panning.current.startY;
        getGraphActions().setEditor({ pan: { x: panning.current.startPanX + dx, y: panning.current.startPanY + dy } });
        applyTransform();
      }
      if (dragging.current) {
        const d = dragging.current;
        const dx = e.clientX - d.startX, dy = e.clientY - d.startY;
        if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
        const z = getGraphState().editor.zoom;
        d.curX = d.startNodeX + dx / z;
        d.curY = d.startNodeY + dy / z;
        const el = nodeRefs.current.get(d.nodeId);
        if (el) { el.style.left = d.curX + 'px'; el.style.top = d.curY + 'px'; }
        updateDragEdges(d.nodeId, d.curX, d.curY);
      }
      if (connecting.current) drawGhost(e.clientX, e.clientY);
    }

    function onPointerUp(e: PointerEvent) {
      activePointers.current.delete(e.pointerId);

      // Lifting either pinch finger ends the pinch. Setting _dragJustEnded
      // suppresses any synthetic click that some browsers fire after pinch.
      if (pinching.current && pinching.current.pointerIds.includes(e.pointerId)) {
        pinching.current = null;
        (window as unknown as AppWin)._dragJustEnded = true;
        setTimeout(() => { (window as unknown as AppWin)._dragJustEnded = false; }, 0);
        return;
      }

      if (panning.current) { panning.current = null; root!.style.cursor = 'grab'; }
      if (dragging.current) {
        const d = dragging.current;
        dragging.current = null;
        if (d.moved) {
          getGraphActions().updateNode(d.nodeId, { x: d.curX, y: d.curY });
          save.graph();
        }
        setTimeout(() => { (window as unknown as AppWin)._dragJustEnded = false; }, 0);
      }
      if (connecting.current) {
        const hit = document.elementFromPoint(e.clientX, e.clientY);
        const portEl = hit?.closest('.port.in');
        if (portEl) {
          const toId = (portEl.closest('.node') as HTMLElement | null)?.dataset.id;
          if (toId) {
            const link = getGraphActions().addLink(connecting.current.fromId, toId, connecting.current.fromPort ?? undefined);
            if (link) {
              // Cycle check: graphStore.topoOrder() throws when the just-
              // added edge introduces a cycle. Previously the save would
              // succeed and only `workflow.run()` later surfaced the error
              // via a generic alert — by then the user had no in-canvas
              // indication of which edge was bad. Reject the link
              // immediately, toast the reason, and skip the save.
              let cycle = false;
              try { getGraphActions().topoOrder(); }
              catch (_) { cycle = true; }
              if (cycle) {
                getGraphActions().removeLink(link.id);
                try {
                  getToastActions().show(
                    `Link would create a cycle (${connecting.current.fromId} → ${toId}) — rejected`,
                    'warning',
                    { duration: 5000 },
                  );
                } catch (_) { /* toast may not be ready */ }
              } else {
                bus.emit('graph:change', { reason: 'addLink', link });
                save.graph();
              }
            }
          }
        }
        if (ghostRef.current) ghostRef.current.setAttribute('d', '');
        connecting.current = null;
      }
    }

    function onPointerCancel(e: PointerEvent) {
      activePointers.current.delete(e.pointerId);
      if (pinching.current && pinching.current.pointerIds.includes(e.pointerId)) {
        pinching.current = null;
      }
      cancelInteractions();
    }

    // HUD buttons
    function setZoom(z: number) {
      const { pan, zoom: z0 } = getGraphState().editor;
      const z1 = Math.max(0.25, Math.min(2.5, z));
      const r = root!.getBoundingClientRect();
      const mx = r.width / 2, my = r.height / 2;
      getGraphActions().setEditor({ pan: { x: mx - (mx - pan.x) * (z1 / z0), y: my - (my - pan.y) * (z1 / z0) }, zoom: z1 });
      applyTransform();
    }
    function fit() {
      const ns = getGraphState().nodes;
      if (!ns.length) return;
      const xs = ns.map(n => n.x), ys = ns.map(n => n.y);
      getGraphActions().setEditor({ pan: { x: 60 - Math.min(...xs), y: 60 - Math.min(...ys) }, zoom: 1 });
      applyTransform();
    }
    const hudIn  = document.getElementById('hud-zoom-in');
    const hudOut = document.getElementById('hud-zoom-out');
    const hudFit = document.getElementById('hud-fit');
    const zoomIn  = () => setZoom(getGraphState().editor.zoom * 1.15);
    const zoomOut = () => setZoom(getGraphState().editor.zoom / 1.15);
    hudIn?.addEventListener('click', zoomIn);
    hudOut?.addEventListener('click', zoomOut);
    hudFit?.addEventListener('click', fit);

    // Re-apply transform when store changes (e.g. from fit/zoom calls before React mounts)
    const unsub = useGraphStore.subscribe(() => applyTransform());

    root.addEventListener('pointerdown',     onPointerDown);
    root.addEventListener('contextmenu',     onContextMenu);
    root.addEventListener('dblclick',        onDblClick);
    root.addEventListener('wheel',           onWheel, { passive: false });
    window.addEventListener('pointermove',   onPointerMove);
    window.addEventListener('pointerup',     onPointerUp);
    window.addEventListener('pointercancel', onPointerCancel);

    return () => {
      root.removeEventListener('pointerdown',     onPointerDown);
      root.removeEventListener('contextmenu',     onContextMenu);
      root.removeEventListener('dblclick',        onDblClick);
      root.removeEventListener('wheel',           onWheel);
      window.removeEventListener('pointermove',   onPointerMove);
      window.removeEventListener('pointerup',     onPointerUp);
      window.removeEventListener('pointercancel', onPointerCancel);
      hudIn?.removeEventListener('click', zoomIn);
      hudOut?.removeEventListener('click', zoomOut);
      hudFit?.removeEventListener('click', fit);
      unsub();
    };
  }, [layoutMode, isCode]);

  // ── Node event handlers (React synthetic, on React-owned divs) ────────────
  // React's stopPropagation halts synthetic dispatch but native events still bubble
  // through the DOM until they hit the React root, so the native pointerdown
  // listener on #editor-root sees node/port pointerdowns first and can track
  // pointer counts for pinch detection.
  function onNodePointerDown(e: React.PointerEvent, n: GraphNode) {
    if (e.button !== 0 || (e.target as HTMLElement).classList.contains('port')) return;
    dragging.current = {
      nodeId: n.id, startX: e.clientX, startY: e.clientY,
      startNodeX: n.x, startNodeY: n.y, moved: false, curX: n.x, curY: n.y,
    };
    e.stopPropagation();
  }
  function onNodeClick(e: React.MouseEvent, n: GraphNode) {
    if ((e.target as HTMLElement).classList.contains('port')) return;
    if ((window as unknown as AppWin)._dragJustEnded) return;
    nodeModule.openOverlay(n.id);
  }
  function onNodePointerUp() {
    if (dragging.current?.moved) (window as unknown as AppWin)._dragJustEnded = true;
  }
  function onOutPortDown(e: React.PointerEvent, n: GraphNode, fromPort: string | null) {
    e.stopPropagation();
    connecting.current = { fromId: n.id, fromPort };
  }
  function onInPortClick(e: React.MouseEvent, n: GraphNode) {
    if (!e.altKey) return;
    const incoming = getGraphState().links.filter(l => l.to === n.id);
    incoming.forEach(l => {
      getGraphActions().removeLink(l.id);
      bus.emit('graph:change', { reason: 'removeLink', id: l.id });
    });
    if (incoming.length) save.graph();
  }
  function onEdgeClick(e: React.MouseEvent, linkId: string) {
    e.stopPropagation();
    getGraphActions().removeLink(linkId);
    bus.emit('graph:change', { reason: 'removeLink', id: linkId });
    save.graph();
  }

  // ── Portals ───────────────────────────────────────────────────────────────
  if (!nodeLayer || !edgeSvg) return null;

  return (
    <>
      {/* Node cards → #node-layer (div) */}
      {createPortal(
        <>
          {nodes.map(n => {
            const isIf   = n.type === 'if';
            const hasIn  = links.some(l => l.to === n.id);
            const inDir  = optimalDir(n.id, 'in', null, nodes, links);
            const outDir = !isIf ? optimalDir(n.id, 'out', null, nodes, links) : null;
            const hasOut = !isIf ? links.some(l => l.from === n.id) : false;

            const cls = [
              'node',
              selectedNodeId === n.id && 'active',
              n.status === 'running'   && 'running',
              n.status === 'error'     && 'error',
              n.disabled               && 'disabled',
              n.type === 'if'          && 'if',
              n.type === 'trigger'     && 'trigger',
            ].filter(Boolean).join(' ');

            return (
              <div
                key={n.id}
                className={cls}
                data-id={n.id}
                style={{ left: n.x, top: n.y }}
                ref={el => { if (el) nodeRefs.current.set(n.id, el); else nodeRefs.current.delete(n.id); }}
                onPointerDown={e => onNodePointerDown(e, n)}
                onClick={e => onNodeClick(e, n)}
                onPointerUp={onNodePointerUp}
              >
                <div className="node-icon">{iconFor(n)}</div>
                <div className="node-body">
                  <div className="node-title">{n.title || n.command || n.type}</div>
                  <div className="node-summary">{summaryText(n)}</div>
                </div>
                <div
                  className={`port in ${inDir}${hasIn ? ' connected' : ''}`}
                  title="input"
                  onClick={e => onInPortClick(e, n)}
                />
                {isIf ? (
                  <>
                    {(['true', 'false'] as const).map(port => {
                      const dir = optimalDir(n.id, 'out', port, nodes, links);
                      const conn = links.some(l => l.from === n.id && (l.fromPort === port || (!l.fromPort && port === 'true')));
                      return (
                        <div
                          key={port}
                          className={`port out ${port} ${dir}${conn ? ' connected' : ''}`}
                          title={`${port} output`}
                          onPointerDown={e => onOutPortDown(e, n, port)}
                        />
                      );
                    })}
                  </>
                ) : (
                  <div
                    className={`port out ${outDir}${hasOut ? ' connected' : ''}`}
                    title="output"
                    onPointerDown={e => onOutPortDown(e, n, null)}
                  />
                )}
              </div>
            );
          })}
        </>,
        nodeLayer,
      )}

      {/* Bezier edges + ghost → #edge-layer (SVG) */}
      {createPortal(
        <>
          {links.map(l => {
            const a = portPos(l.from, 'out', l.fromPort ?? null, nodes, links, nodeSizes.current);
            const b = portPos(l.to,   'in',  null,               nodes, links, nodeSizes.current);
            if (!a || !b) return null;
            const d = bezier(a, b);
            return (
              <Fragment key={l.id}>
                <path
                  className="edge-hit"
                  d={d}
                  data-id={l.id}
                  ref={el => {
                    if (el) {
                      const p = edgeRefs.current.get(l.id);
                      if (p) p[0] = el; else edgeRefs.current.set(l.id, [el, el]);
                    } else {
                      edgeRefs.current.delete(l.id);
                    }
                  }}
                  onClick={e => onEdgeClick(e, l.id)}
                />
                <path
                  className="edge"
                  d={d}
                  data-id={l.id}
                  ref={el => {
                    if (el) {
                      const p = edgeRefs.current.get(l.id);
                      if (p) p[1] = el;
                    }
                  }}
                  onClick={e => onEdgeClick(e, l.id)}
                />
              </Fragment>
            );
          })}
          {/* Ghost edge shown while dragging from an output port */}
          <path ref={ghostRef} className="edge provisional" d="" />
        </>,
        edgeSvg,
      )}
    </>
  );
}
