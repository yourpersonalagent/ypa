import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.js';
import { useAppStore } from '../stores/appStore.js';
import {
  appUrl,
  bestBrowserOrigin,
  browserEndpointLabel,
  summarizeNetworkReachability,
  type NetReachability,
} from '../modules/yha-net/net-endpoints.js';

export type NetworkNodeMode = 'lan' | 'tailscale' | 'webservice';

export interface NetworkSwitcherNode {
  id: string;
  label?: string;
  computerName?: string;
  tailscaleName?: string;
  webserviceUrl?: string;
  port?: number;
  preferredMode?: NetworkNodeMode;
  enabled?: boolean;
  isSelf?: boolean;
  serving?: string;
  endpointUrl?: string;
  networkName?: string;
  online?: boolean;
}

interface NetMember {
  nodeId?: string;
  label?: string;
  hostname?: string;
  endpoints?: Record<string, string>;
  role?: string;
}

interface NetNetwork {
  id: string;
  name?: string;
  members?: Record<string, NetMember>;
}

function nodeFromMember(
  network: NetNetwork,
  id: string,
  member: NetMember,
  online?: boolean,
): NetworkSwitcherNode {
  const endpoints = member?.endpoints || {};
  const bestOrigin = bestBrowserOrigin(endpoints);
  const tailscaleOrigin = bestBrowserOrigin({
    tailscaleHttps: endpoints.tailscaleHttps,
    tailscale: endpoints.tailscale,
    tailscaleHttp: endpoints.tailscaleHttp,
  });
  const isWebLike = (() => {
    try {
      const u = new URL(bestOrigin);
      return u.protocol === 'https:' || !!endpoints.web || !!endpoints.funnel;
    } catch { return false; }
  })();
  const endpointUrl = appUrl(bestOrigin);
  return {
    id,
    label: member?.label || member?.hostname || id,
    computerName: member?.hostname || undefined,
    webserviceUrl: bestOrigin || undefined,
    tailscaleName: tailscaleOrigin ? tailscaleOrigin.replace(/^https?:\/\//, '').replace(/:\d+$/, '') : undefined,
    preferredMode: isWebLike ? 'webservice' : tailscaleOrigin ? 'tailscale' : 'lan',
    enabled: true,
    endpointUrl,
    networkName: network.name || network.id,
    serving: member?.role ? `${member.role} · ${network.name || network.id}` : (network.name || network.id),
    online,
  };
}

async function fetchNetworkNodes(): Promise<{
  nodes: NetworkSwitcherNode[];
  reachability: Record<string, NetReachability>;
  networks: NetNetwork[];
}> {
  // The switcher should be instant and router-restart tolerant: render durable
  // cached membership first, then let the YHA Net background sync heal endpoints.
  const r = await fetch(api.config.baseUrl + '/v1/net/networks?probe=1');
  const d = await r.json().catch(() => null);
  if (!d?.success || !Array.isArray(d.networks)) {
    return { nodes: [], reachability: {}, networks: [] };
  }
  const reachability = (d.reachability || {}) as Record<string, NetReachability>;
  const onlineByNode = new Map<string, boolean>();
  for (const stats of Object.values(reachability)) {
    for (const member of stats.members || []) {
      if (member?.nodeId) onlineByNode.set(member.nodeId, !!member.online);
    }
  }
  const byId = new Map<string, NetworkSwitcherNode>();
  for (const network of d.networks as NetNetwork[]) {
    for (const [id, member] of Object.entries(network.members || {})) {
      if (!id || byId.has(id)) continue;
      byId.set(id, nodeFromMember(network, id, member || {}, onlineByNode.get(id)));
    }
  }
  return {
    nodes: Array.from(byId.values()),
    reachability,
    networks: d.networks as NetNetwork[],
  };
}

function normalizeOrigin(origin: string): string {
  try {
    return new URL(origin).origin.toLowerCase();
  } catch {
    return origin.replace(/\/$/, '').toLowerCase();
  }
}

function normalizeHost(host: string): string {
  return host.replace(/^https?:\/\//, '').replace(/\/$/, '').toLowerCase();
}

export function resolveNetworkNodeUrl(node: NetworkSwitcherNode): string | null {
  if (node.endpointUrl) return appUrl(node.endpointUrl);
  const port = node.port || 8443;
  const lan = node.computerName ? `http://${node.computerName}:${port}` : '';
  const tailscale = node.tailscaleName ? `https://${node.tailscaleName}/ypa` : '';
  const web = (node.webserviceUrl || '').trim();
  const mode = node.preferredMode || 'webservice';
  const order: Record<NetworkNodeMode, string[]> = {
    lan: [web, tailscale, lan],
    tailscale: [web, tailscale, lan],
    webservice: [web, tailscale, lan],
  };
  const chosen = (order[mode] || order.webservice).find(Boolean) || null;
  return chosen ? appUrl(chosen) : null;
}

function isCurrentNode(node: NetworkSwitcherNode): boolean {
  if (node.isSelf) return true;
  const url = resolveNetworkNodeUrl(node);
  const here = normalizeOrigin(window.location.origin);
  if (url && normalizeOrigin(url) === here) return true;
  const host = normalizeHost(window.location.host);
  return [node.webserviceUrl, node.tailscaleName, node.computerName]
    .filter((v): v is string => !!v)
    .some((v) => normalizeHost(v) === host || normalizeHost(v).split(':')[0] === host.split(':')[0]);
}

function nodeTitle(node: NetworkSwitcherNode): string {
  return node.label?.trim() || node.computerName?.trim() || node.tailscaleName?.trim() || 'Unnamed node';
}

function nodeSubtitle(node: NetworkSwitcherNode, url: string | null): string {
  const endpoint = url ? browserEndpointLabel(url) : 'no endpoint';
  const status = node.online === false ? 'offline' : node.online ? 'reachable' : '';
  if (node.networkName?.trim()) {
    return status ? `${node.networkName.trim()} · ${status} · ${endpoint}` : `${node.networkName.trim()} · ${endpoint}`;
  }
  if (node.serving?.trim()) return node.serving.trim();
  return endpoint;
}

interface NetworkNodeSwitcherProps {
  children: ReactNode;
  className?: string;
  title?: string;
  compact?: boolean;
}

function captureAnchorRect(el: HTMLElement | null): DOMRect | null {
  const rect = el?.getBoundingClientRect();
  return rect && rect.width > 0 && rect.height > 0 ? rect : null;
}

function menuPositionStyle(
  anchor: DOMRect,
  headerOrient: 'h' | 'v',
  compact: boolean,
): CSSProperties {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const margin = 12;
  const gap = 8;
  const minWidth = compact ? 260 : 320;

  const panel: CSSProperties = {
    position: 'fixed',
    zIndex: 10000,
    minWidth,
    maxWidth: 'min(420px, calc(100vw - 24px))',
    padding: 8,
    borderRadius: 12,
    border: '1px solid var(--stroke)',
    background: 'var(--bg-1, var(--bg))',
    color: 'var(--fg)',
    boxShadow: '0 14px 40px rgba(0,0,0,.38)',
    fontSize: 12,
    textAlign: 'left',
    fontFamily: 'var(--font-ui, inherit)',
  };

  if (headerOrient === 'h') {
    const top = anchor.bottom + gap;
    const left = Math.max(margin, Math.min(vw - minWidth - margin, anchor.left));
    const maxHeight = Math.max(180, vh - top - margin);
    return { ...panel, top, left, maxHeight, overflowY: 'auto' };
  }

  const spaceRight = vw - anchor.right - gap - margin;
  const spaceLeft = anchor.left - gap - margin;
  let left = spaceRight >= minWidth || spaceRight >= spaceLeft
    ? anchor.right + gap
    : anchor.left - gap - minWidth;
  left = Math.max(margin, Math.min(vw - minWidth - margin, left));
  const top = Math.max(margin, Math.min(vh - 200 - margin, anchor.top));
  const maxHeight = Math.max(200, vh - top - margin);
  return { ...panel, top, left, maxHeight, overflowY: 'auto' };
}

export function NetworkNodeSwitcher({ children, className, title, compact = false }: NetworkNodeSwitcherProps) {
  const rootRef = useRef<HTMLSpanElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLSpanElement>(null);
  const headerOrient = useAppStore((s) => s.headerOrient);
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [nodes, setNodes] = useState<NetworkSwitcherNode[]>([]);
  const [reachability, setReachability] = useState<Record<string, NetReachability>>({});
  const [networks, setNetworks] = useState<NetNetwork[]>([]);
  const [refreshing, setRefreshing] = useState(false);

  async function refresh() {
    setRefreshing(true);
    try {
      const data = await fetchNetworkNodes();
      setNodes(data.nodes);
      setReachability(data.reachability);
      setNetworks(data.networks);
    } catch {
      setNodes([]);
      setReachability({});
      setNetworks([]);
    } finally {
      setRefreshing(false);
    }
  }

  useLayoutEffect(() => {
    if (!open) {
      setAnchor(null);
      return;
    }
    setAnchor(captureAnchorRect(buttonRef.current));
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    void refresh();
    const reposition = () => {
      const rect = captureAnchorRect(buttonRef.current);
      if (rect) setAnchor(rect);
    };
    const onPointerDown = (ev: PointerEvent) => {
      const target = ev.target as Node;
      if (rootRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', reposition);
    window.addEventListener('scroll', reposition, true);
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', reposition);
      window.removeEventListener('scroll', reposition, true);
      window.removeEventListener('focus', onFocus);
    };
  }, [open]);

  useEffect(() => { void refresh(); }, []);

  const enabledNodes = useMemo(() => nodes.filter((n) => n.enabled !== false), [nodes]);
  const current = enabledNodes.find(isCurrentNode);
  const networkSummary = useMemo(
    () => summarizeNetworkReachability(reachability, networks),
    [reachability, networks],
  );

  function openNode(node: NetworkSwitcherNode) {
    const url = resolveNetworkNodeUrl(node);
    if (!url) return;
    window.location.href = url;
  }

  const menuStyle = useMemo(
    () => (anchor ? menuPositionStyle(anchor, headerOrient, compact) : null),
    [anchor, headerOrient, compact],
  );

  const menu = open && menuStyle ? (
    <span
      ref={menuRef}
      role="menu"
      aria-label="YPA Node Switcher"
      style={menuStyle}
    >
      <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, margin: '2px 4px 8px' }}>
        <strong style={{ fontSize: 12 }}>YPA Node Switcher</strong>
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          <button
            type="button"
            className="prefs-btn"
            style={{ padding: '2px 7px', fontSize: 11 }}
            disabled={refreshing}
            onClick={() => { void refresh(); }}
          >
            {refreshing ? 'Refreshing…' : 'Refresh'}
          </button>
          <span style={{ color: 'var(--fg-mute)', fontSize: 11 }}>{enabledNodes.length} node{enabledNodes.length === 1 ? '' : 's'}</span>
        </span>
      </span>
      {enabledNodes.length === 0 ? (
        <span style={{ display: 'block', color: 'var(--fg-mute)', padding: '8px 6px 10px', lineHeight: 1.35 }}>
          No YHA Net members yet. Create or join a network in Preferences → YHA Net.
        </span>
      ) : (
        <span style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
          {enabledNodes.map((node) => {
            const url = resolveNetworkNodeUrl(node);
            const selected = current?.id === node.id || isCurrentNode(node);
            return (
              <button
                key={node.id}
                type="button"
                role="menuitem"
                disabled={!url || selected}
                onClick={() => openNode(node)}
                style={{
                  width: '100%',
                  border: '1px solid var(--stroke)',
                  borderRadius: 10,
                  padding: '8px 9px',
                  background: selected ? 'color-mix(in srgb, var(--accent) 18%, transparent)' : 'var(--bg)',
                  color: 'inherit',
                  cursor: !url || selected ? 'default' : 'pointer',
                  textAlign: 'left',
                  opacity: !url ? 0.55 : 1,
                }}
                title={url || 'No reachable URL configured'}
              >
                <span style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                  <strong style={{ fontSize: 12 }}>{nodeTitle(node)}</strong>
                  <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
                    {node.online === false && <span style={{ color: 'var(--fg-mute)', fontSize: 11 }}>offline</span>}
                    {selected && <span style={{ color: 'var(--accent)', fontSize: 11 }}>current</span>}
                  </span>
                </span>
                <span style={{ display: 'block', marginTop: 3, color: 'var(--fg-mute)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {nodeSubtitle(node, url)}
                </span>
              </button>
            );
          })}
        </span>
      )}
      <span style={{ display: 'block', color: 'var(--fg-mute)', fontSize: 11, margin: '8px 4px 2px', lineHeight: 1.35 }}>
        {networks.length > 0
          ? `${networkSummary.label} · ${networkSummary.online} of ${networkSummary.total} node${networkSummary.total === 1 ? '' : 's'} reachable`
          : 'No YHA Net network joined yet'}
      </span>
    </span>
  ) : null;

  return (
    <span ref={rootRef} style={{ display: 'inline-block' }} className={className}>
      <button
        ref={buttonRef}
        type="button"
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((v) => !v); }}
        title={title || 'Open YPA Node Switcher'}
        aria-haspopup="menu"
        aria-expanded={open}
        style={{
          all: 'unset',
          color: 'inherit',
          cursor: 'pointer',
          display: 'inline-flex',
          alignItems: 'baseline',
          gap: compact ? 4 : 0,
        }}
      >
        {children}
      </button>
      {menu ? createPortal(menu, document.body) : null}
    </span>
  );
}