// YHA Net preferences tab — named, signed networks.
//
// The old prefs-backed `yhaNetNodes` manual registry is intentionally not shown
// here anymore. It still exists as a compatibility type/API for older remote
// file-picker/proxy code, but this tab is now only the durable network model:
// node identity, named networks, invites, signed peers, offers, docs, and
// model/pricing sync.

import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api.js';
import { session } from '../../session.js';
import {
  bestBrowserOrigin,
  browserEndpointLabel,
  formatUpdateStatus,
  sshHint,
  summarizeNetworkReachability,
  type NetReachability,
} from './net-endpoints.js';

const NET_SYNC_INTERVAL_MS = 5 * 60 * 1000;

// Compatibility export for older file picker / file manager code that still
// talks to the legacy `/v1/net/nodes/:id/*` proxy. Do not use this in the YHA
// Net prefs UI; the UI below uses NetNetwork membership instead.
export type NodeMode = 'lan' | 'tailscale' | 'webservice';
export type NodeProfile = 'private' | 'home' | 'professional' | 'public' | 'access-only';
export type NodeAvailability = 'always-on' | 'when-idle' | 'manual';
export type NodeOwner = 'self' | 'family' | 'friend';
export interface YhaNode {
  id: string;
  label: string;
  computerName: string;
  tailscaleName?: string;
  webserviceUrl?: string;
  port?: number;
  preferredMode: NodeMode;
  profile: NodeProfile;
  availability: NodeAvailability;
  owner: NodeOwner;
  enabled: boolean;
  isSelf?: boolean;
  serving?: string;
  token?: string;
}

interface SelfIdentity {
  hostname: string;
  tailscaleHost: string;
  tailscaleUrl: string;
  funnelUrl: string;
  port: number;
  platform: string;
  nodeId?: string;
  label?: string;
  publicKey?: string;
  identity?: { id: string; label: string; publicKey: string; endpoints?: Record<string, string> };
}

interface NetMember {
  nodeId?: string;
  label?: string;
  role?: string;
  hostname?: string;
  platform?: string;
  joinedAt?: string;
  endpoints?: Record<string, string>;
}

interface NetNetwork {
  id: string;
  name: string;
  revision: number;
  createdAt: string;
  updatedAt: string;
  members?: Record<string, NetMember>;
}

interface NetOffer {
  id: string;
  kind: string;
  label: string;
  enabled?: boolean;
}

interface NetOffers {
  offers?: NetOffer[];
}

interface NodeUpdateSource {
  mode?: 'standard' | 'custom';
  sourceLabel?: 'public' | 'custom';
  url?: string;
  hasToken?: boolean;
  updatedAt?: string | null;
}

interface NodeBuildInfo {
  version?: string | null;
  commit?: string | null;
  branch?: string | null;
  describe?: string | null;
  dirty?: boolean;
  installPath?: string | null;
  sshHost?: string | null;
  generatedAt?: string | null;
  updateSource?: NodeUpdateSource | null;
}

interface NodeUpdateStatus {
  upToDate?: boolean;
  behind?: number;
  ahead?: number;
  dirty?: boolean;
  localVersion?: string | null;
  remoteVersion?: string | null;
  branch?: string | null;
  fetchOk?: boolean;
  checkedAt?: string | null;
  mode?: 'standard' | 'custom';
  sourceLabel?: 'public' | 'custom';
  sourceDisplayUrl?: string | null;
}

interface PeerManifest {
  fetchedAt?: string;
  fetchedFrom?: string;
  node?: {
    id: string;
    label?: string;
    hostname?: string;
    installPath?: string;
    sshHost?: string;
  };
  build?: NodeBuildInfo;
  updateSource?: NodeUpdateSource | null;
  updateStatus?: NodeUpdateStatus | null;
  offers?: Array<{ id: string; kind: string; label: string; enabled?: boolean }>;
}

interface RemoteDocEntry {
  name: string;
  path: string;
  type: 'dir' | 'file';
  size?: number;
  updatedAt?: string | null;
}

interface RemoteDocsState {
  loading?: boolean;
  path: string;
  entries?: RemoteDocEntry[];
  previewPath?: string;
  preview?: string;
  error?: string;
}

interface JoinRequest {
  id: string;
  networkId: string;
  networkName?: string;
  status: 'pending' | 'accepted' | 'rejected';
  requestedAt: string;
  requestingNode?: {
    id: string;
    label?: string;
    hostname?: string;
    platform?: string;
    endpoints?: Record<string, string>;
  };
}

function endpointSummary(member?: NetMember): string {
  const best = bestBrowserOrigin(member?.endpoints || {});
  return best ? browserEndpointLabel(best) : member?.hostname || 'no endpoint';
}

function normalizePastedInviteToken(input: string): string {
  let raw = String(input || '').trim();
  if ((raw.startsWith('\"') && raw.endsWith('\"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }
  const embedded = raw.match(/yha-net:\/\/join\?payload=([A-Za-z0-9_-]+)/);
  if (embedded) return embedded[0];
  const payloadMatch = raw.match(/payload[\s:=\"]+([A-Za-z0-9_-]+)/i);
  if (payloadMatch) return payloadMatch[1];
  return raw.replace(/\s+/g, '');
}

export function TabNodes() {
  const apiBase = api.config.baseUrl;
  const [self, setSelf] = useState<SelfIdentity | null>(null);
  const [selfErr, setSelfErr] = useState('');
  const [networks, setNetworks] = useState<NetNetwork[]>([]);
  const [offers, setOffers] = useState<NetOffers | null>(null);
  const [offerDraft, setOfferDraft] = useState<NetOffer[]>([]);
  const [peerManifests, setPeerManifests] = useState<Record<string, PeerManifest[]>>({});
  const [reachability, setReachability] = useState<Record<string, NetReachability>>({});
  const [localBuild, setLocalBuild] = useState<NodeBuildInfo | null>(null);
  const [localUpdateSource, setLocalUpdateSource] = useState<NodeUpdateSource | null>(null);
  const [localUpdateStatus, setLocalUpdateStatus] = useState<NodeUpdateStatus | null>(null);
  const [joinRequests, setJoinRequests] = useState<JoinRequest[]>([]);
  const [newNetworkName, setNewNetworkName] = useState('');
  const [joinToken, setJoinToken] = useState('');
  const [joinEndpoint, setJoinEndpoint] = useState('');
  const [netBusy, setNetBusy] = useState(false);
  const [netMsg, setNetMsg] = useState('');
  const [inviteToken, setInviteToken] = useState('');
  const [remoteDocs, setRemoteDocs] = useState<Record<string, RemoteDocsState>>({});

  async function loadCachedManifests(networkList: NetNetwork[]) {
    const entries = await Promise.all(networkList.map(async (n) => {
      try {
        const mr = await fetch(apiBase + `/v1/net/networks/${encodeURIComponent(n.id)}/manifests`);
        const md = await mr.json();
        return [n.id, md?.success && Array.isArray(md.manifests) ? md.manifests : []] as const;
      } catch {
        return [n.id, []] as const;
      }
    }));
    setPeerManifests(Object.fromEntries(entries));
  }

  async function loadSelfIdentity() {
    try {
      const r = await fetch(apiBase + '/v1/net/self');
      const d = (await r.json()) as { success?: boolean; self?: SelfIdentity };
      if (d?.success && d.self) {
        setSelf(d.self);
        setSelfErr('');
      } else {
        setSelfErr('returned no data');
      }
    } catch (e) {
      setSelfErr((e as Error).message);
    }
  }

  async function loadNetworks(options: { sync?: boolean; probe?: boolean; refreshManifests?: boolean } = {}) {
    const sync = options.sync !== false;
    const probe = options.probe !== false;
    const refreshManifests = !!options.refreshManifests;
    try {
      const query = `${sync ? 'sync=1&' : ''}${probe ? 'probe=1' : ''}`.replace(/&$/, '');
      const [nr, or] = await Promise.all([
        fetch(apiBase + `/v1/net/networks${query ? `?${query}` : ''}`),
        fetch(apiBase + '/v1/net/offers'),
      ]);
      const jr = await fetch(apiBase + '/v1/net/join-requests').catch(() => null);
      const nd = await nr.json();
      const od = await or.json();
      const jd = jr ? await jr.json().catch(() => null) : null;
      if (nd?.success && Array.isArray(nd.networks)) {
        setNetworks(nd.networks);
        setReachability((nd.reachability || {}) as Record<string, NetReachability>);
        if (nd.build) {
          const build = nd.build as NodeBuildInfo & { updateStatus?: NodeUpdateStatus | null };
          setLocalBuild(build);
          setLocalUpdateSource(build.updateSource || null);
          setLocalUpdateStatus(build.updateStatus || null);
        }
        if (refreshManifests) {
          await Promise.all(nd.networks.map(async (n: NetNetwork) => {
            try {
              const rr = await fetch(apiBase + `/v1/net/networks/${encodeURIComponent(n.id)}/refresh`, { method: 'POST' });
              const rd = await rr.json();
              if (rd?.success && Array.isArray(rd.manifests)) {
                setPeerManifests((prev) => ({ ...prev, [n.id]: rd.manifests }));
              }
            } catch { /* best effort */ }
          }));
        } else {
          await loadCachedManifests(nd.networks);
        }
      }
      if (od?.success && od.offers) {
        setOffers(od.offers);
        setOfferDraft(Array.isArray(od.offers.offers) ? od.offers.offers.map((o: NetOffer) => ({ ...o })) : []);
      }
      if (jd?.success && Array.isArray(jd.requests)) setJoinRequests(jd.requests);
    } catch (e) {
      setNetMsg(`YHA Net load failed: ${(e as Error).message}`);
    }
  }

  async function refreshAll(options: { silent?: boolean } = {}) {
    setNetBusy(true);
    if (!options.silent) {
      setNetMsg('');
      setInviteToken('');
    }
    try {
      await loadSelfIdentity();
      // Show cached durable membership immediately. Live sync/probe can be slow
      // or temporarily fail after a router restart; it must not make the whole
      // network disappear from the preferences tab.
      await loadNetworks({ sync: false, probe: false, refreshManifests: false });
      await loadNetworks({ sync: true, probe: true, refreshManifests: true });
      if (!options.silent) {
        setNetMsg('YHA Net refreshed: membership synced, reachability probed, and peer offers updated.');
      }
    } catch (e) {
      if (!options.silent) setNetMsg((e as Error).message);
    } finally {
      setNetBusy(false);
    }
  }

  useEffect(() => {
    void refreshAll({ silent: true });
    const timer = window.setInterval(() => { void refreshAll({ silent: true }); }, NET_SYNC_INTERVAL_MS);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiBase]);

  async function createNetwork() {
    const name = newNetworkName.trim();
    if (!name) return;
    setNetBusy(true);
    setNetMsg('');
    setInviteToken('');
    try {
      const r = await fetch(apiBase + '/v1/net/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      const d = await r.json();
      if (!d?.success) throw new Error(d?.error || 'Create network failed');
      setNewNetworkName('');
      setNetMsg(`Created network “${d.network.name}”.`);
      await loadNetworks();
    } catch (e) {
      setNetMsg((e as Error).message);
    } finally {
      setNetBusy(false);
    }
  }

  async function createInvite(networkId: string) {
    setNetBusy(true);
    setNetMsg('');
    setInviteToken('');
    try {
      const r = await fetch(apiBase + `/v1/net/networks/${encodeURIComponent(networkId)}/invites`, { method: 'POST' });
      const d = await r.json();
      if (!d?.success) throw new Error(d?.error || 'Create invite failed');
      setInviteToken(d.invite.token || '');
      setNetMsg('Invite token created. It expires in 10 minutes.');
    } catch (e) {
      setNetMsg((e as Error).message);
    } finally {
      setNetBusy(false);
    }
  }

  async function saveOffers() {
    setNetBusy(true);
    setNetMsg('');
    try {
      const r = await fetch(apiBase + '/v1/net/offers', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ offers: offerDraft }),
      });
      const d = await r.json();
      if (!d?.success) throw new Error(d?.error || 'Save offers failed');
      setOffers(d.offers);
      setOfferDraft(Array.isArray(d.offers?.offers) ? d.offers.offers.map((o: NetOffer) => ({ ...o })) : []);
      setNetMsg('Saved this node\'s offers.');
      await loadNetworks({ sync: false, probe: false, refreshManifests: false });
    } catch (e) {
      setNetMsg((e as Error).message);
    } finally {
      setNetBusy(false);
    }
  }

  async function refreshPeerManifests(networkId: string) {
    setNetBusy(true);
    setNetMsg('');
    try {
      const r = await fetch(apiBase + `/v1/net/networks/${encodeURIComponent(networkId)}/refresh`, { method: 'POST' });
      const d = await r.json();
      if (!d?.success) throw new Error(d?.error || 'Refresh manifests failed');
      const ok = Array.isArray(d.results) ? d.results.filter((x: { ok?: boolean }) => x.ok).length : 0;
      const total = Array.isArray(d.results) ? d.results.length : 0;
      setPeerManifests((prev) => ({ ...prev, [networkId]: Array.isArray(d.manifests) ? d.manifests : [] }));
      await loadNetworks({ sync: true, probe: true, refreshManifests: false });
      setNetMsg(`Refreshed peer manifests: ${ok}/${total} reachable.`);
    } catch (e) {
      setNetMsg((e as Error).message);
    } finally {
      setNetBusy(false);
    }
  }

  async function joinNetwork() {
    const token = normalizePastedInviteToken(joinToken);
    if (!token) return;
    setNetBusy(true);
    setNetMsg('');
    setInviteToken('');
    try {
      const r = await fetch(apiBase + '/v1/net/join', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, endpoint: joinEndpoint.trim() || undefined }),
      });
      const d = await r.json();
      if (!d?.success) throw new Error(d?.error || 'Join request failed');
      setJoinToken('');
      setJoinEndpoint('');
      setNetMsg(`Join request sent to ${d.endpoint}. Wait for acceptance on the inviter node.`);
    } catch (e) {
      setNetMsg((e as Error).message);
    } finally {
      setNetBusy(false);
    }
  }

  async function decideJoinRequest(requestId: string, decision: 'accept' | 'reject') {
    setNetBusy(true);
    setNetMsg('');
    try {
      const r = await fetch(apiBase + `/v1/net/join-requests/${encodeURIComponent(requestId)}/${decision}`, { method: 'POST' });
      const d = await r.json();
      if (!d?.success) throw new Error(d?.error || `${decision} failed`);
      setNetMsg(decision === 'accept' ? 'Join request accepted.' : 'Join request rejected.');
      await loadNetworks();
    } catch (e) {
      setNetMsg((e as Error).message);
    } finally {
      setNetBusy(false);
    }
  }

  // Sync (fetch + auto-apply) model-data or pricing from all peers.
  async function syncNetworkData(networkId: string, kind: 'model-data' | 'pricing', nodeId?: string) {
    setNetBusy(true);
    setNetMsg('');
    try {
      const r = await fetch(apiBase + `/v1/net/networks/${encodeURIComponent(networkId)}/sync/${kind}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(nodeId ? { nodeId } : {}),
      });
      const d = await r.json();
      if (!d?.success) throw new Error(d?.error || `Sync ${kind} failed`);
      const ok = Array.isArray(d.fetchResults) ? d.fetchResults.filter((x: { ok?: boolean }) => x.ok).length : 0;
      const total = Array.isArray(d.fetchResults) ? d.fetchResults.length : 0;
      const applied = Number(d.applied || 0);
      const created = Number(d.providersCreated || 0);
      const parts = [`${ok}/${total} peer${total === 1 ? '' : 's'} reached`, `${applied} model${applied === 1 ? '' : 's'} updated`];
      if (created) parts.push(`${created} new provider${created === 1 ? '' : 's'} added`);
      setNetMsg(`${kind === 'model-data' ? 'Model metadata' : 'Pricing'} synced: ${parts.join(', ')}.`);
    } catch (e) {
      setNetMsg((e as Error).message);
    } finally {
      setNetBusy(false);
    }
  }

  async function removeNetworkMember(networkId: string, nodeId: string, label?: string) {
    if (!window.confirm(`Remove ${label || nodeId} from this YHA Net network?`)) return;
    setNetBusy(true);
    setNetMsg('');
    try {
      const r = await fetch(apiBase + `/v1/net/networks/${encodeURIComponent(networkId)}/members/${encodeURIComponent(nodeId)}`, { method: 'DELETE' });
      const d = await r.json();
      if (!d?.success) throw new Error(d?.error || 'Remove member failed');
      setNetMsg(`Removed ${label || nodeId}.`);
      await loadNetworks();
    } catch (e) {
      setNetMsg((e as Error).message);
    } finally {
      setNetBusy(false);
    }
  }

  async function leaveNetwork(networkId: string, name?: string) {
    if (!window.confirm(`Leave ${name || 'this YHA Net network'} on this node?`)) return;
    setNetBusy(true);
    setNetMsg('');
    try {
      const r = await fetch(apiBase + `/v1/net/networks/${encodeURIComponent(networkId)}/leave`, { method: 'POST' });
      const d = await r.json();
      if (!d?.success) throw new Error(d?.error || 'Leave network failed');
      setNetMsg(`Left ${name || networkId}.`);
      await loadNetworks();
    } catch (e) {
      setNetMsg((e as Error).message);
    } finally {
      setNetBusy(false);
    }
  }

  async function loadRemoteDocs(networkId: string, nodeId: string, path = '') {
    const key = `${networkId}:${nodeId}`;
    setRemoteDocs((prev) => ({ ...prev, [key]: { ...(prev[key] || { path: '' }), path, loading: true, error: '' } }));
    try {
      const r = await fetch(apiBase + `/v1/net/networks/${encodeURIComponent(networkId)}/peers/${encodeURIComponent(nodeId)}/docs/list?path=${encodeURIComponent(path)}`);
      const d = await r.json();
      if (!d?.success) throw new Error(d?.error || 'Remote docs list failed');
      setRemoteDocs((prev) => ({ ...prev, [key]: { ...(prev[key] || {}), path: d.path || path, entries: Array.isArray(d.entries) ? d.entries : [], loading: false, error: '' } }));
    } catch (e) {
      setRemoteDocs((prev) => ({ ...prev, [key]: { ...(prev[key] || { path }), path, loading: false, error: (e as Error).message } }));
    }
  }

  async function previewRemoteDoc(networkId: string, nodeId: string, path: string) {
    const key = `${networkId}:${nodeId}`;
    setRemoteDocs((prev) => ({ ...prev, [key]: { ...(prev[key] || { path: '' }), loading: true, error: '' } }));
    try {
      const r = await fetch(apiBase + `/v1/net/networks/${encodeURIComponent(networkId)}/peers/${encodeURIComponent(nodeId)}/docs/read?path=${encodeURIComponent(path)}`);
      const d = await r.json();
      if (!d?.success) throw new Error(d?.error || 'Remote doc read failed');
      setRemoteDocs((prev) => ({ ...prev, [key]: { ...(prev[key] || { path: '' }), previewPath: d.path || path, preview: String(d.content || ''), loading: false, error: '' } }));
    } catch (e) {
      setRemoteDocs((prev) => ({ ...prev, [key]: { ...(prev[key] || { path: '' }), loading: false, error: (e as Error).message } }));
    }
  }

  async function importPeerSessions(networkId: string, nodeId: string, label?: string) {
    setNetBusy(true);
    setNetMsg('');
    try {
      const r = await fetch(apiBase + `/v1/net/networks/${encodeURIComponent(networkId)}/peers/${encodeURIComponent(nodeId)}/sessions/import`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const d = await r.json();
      if (!d?.success) throw new Error(d?.error || 'Import chat history failed');
      const added = Number(d.imported || 0);
      const duplicates = Number(d.duplicates ?? d.skipped ?? 0);
      const candidates = Number(d.candidates ?? 0);
      const errors = Array.isArray(d.errors) ? d.errors.length : 0;
      if (added > 0) await session.fetchList().catch(() => {});
      setNetMsg(
        `Imported chat history from ${label || nodeId}: ${added} new`
        + `, ${duplicates} already in local DB`
        + (errors ? `, ${errors} fetch error${errors === 1 ? '' : 's'}` : '')
        + ` (of ${Number(d.available || 0)} shared, ${candidates} missing locally).`
        + (added > 0 ? ' Session list refreshed.' : duplicates > 0 && candidates === 0 ? ' All shared sessions already exist here — nothing to add.' : ''),
      );
    } catch (e) {
      setNetMsg((e as Error).message);
    } finally {
      setNetBusy(false);
    }
  }

  async function syncPeerDocs(networkId: string, nodeId: string, label?: string) {
    setNetBusy(true);
    setNetMsg('');
    try {
      const r = await fetch(apiBase + `/v1/net/networks/${encodeURIComponent(networkId)}/peers/${encodeURIComponent(nodeId)}/docs/sync`, { method: 'POST' });
      const d = await r.json();
      if (!d?.success) throw new Error(d?.error || 'Sync docs failed');
      const errs = Array.isArray(d.errors) ? d.errors.length : 0;
      setNetMsg(`Synced docs from ${label || nodeId}: ${Number(d.synced || 0)} updated, ${Number(d.upToDate || 0)} already current, ${Number(d.skipped || 0)} skipped${errs ? `, ${errs} error${errs === 1 ? '' : 's'}` : ''}.`);
    } catch (e) {
      setNetMsg((e as Error).message);
    } finally {
      setNetBusy(false);
    }
  }

  const selfId = self?.nodeId || self?.identity?.id || '';
  const networkSummary = useMemo(
    () => summarizeNetworkReachability(reachability, networks),
    [reachability, networks],
  );

  function memberOfferRows(network: NetNetwork) {
    const manifestsByNode = new Map(
      (peerManifests[network.id] || []).map((m) => [m.node?.id || '', m]),
    );
    const onlineByNode = new Map(
      (reachability[network.id]?.members || []).map((m) => [m.nodeId, m.online]),
    );
    return Object.entries(network.members || {}).map(([id, member]) => {
      const isSelf = id === selfId;
      const manifest = manifestsByNode.get(id);
      const memberOffers = isSelf
        ? (offers?.offers || [])
        : (manifest?.offers || []);
      const build = isSelf
        ? localBuild
        : (manifest?.build || null);
      const updateStatus = isSelf
        ? localUpdateStatus
        : (manifest?.updateStatus || null);
      const updateSource = isSelf
        ? localUpdateSource
        : (manifest?.updateSource || null);
      const installPath = isSelf
        ? (localBuild?.installPath || null)
        : (manifest?.node?.installPath || manifest?.build?.installPath || null);
      const sshHost = isSelf
        ? (localBuild?.sshHost || self?.tailscaleHost || self?.hostname || null)
        : (manifest?.node?.sshHost || manifest?.build?.sshHost || rowMemberHostname(member));
      return {
        id,
        member,
        isSelf,
        manifest,
        offers: memberOffers,
        online: onlineByNode.get(id),
        build,
        updateStatus,
        updateSource,
        installPath,
        sshHost,
      };
    });
  }

  function rowMemberHostname(member?: NetMember): string | null {
    return member?.hostname || null;
  }

  return (
    <>
      <section className="prefs-section" data-view="simple">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <h4 className="prefs-sec" style={{ margin: 0 }}>YHA Net</h4>
          <button className="prefs-btn" disabled={netBusy} onClick={() => { void refreshAll(); }}>
            {netBusy ? 'Refreshing…' : 'Refresh all'}
          </button>
          {networks.length > 0 && (
            <span className="prefs-hint" style={{ margin: 0 }}>
              {networkSummary.label} · {networkSummary.online} of {networkSummary.total} node{networkSummary.total === 1 ? '' : 's'} reachable
            </span>
          )}
        </div>
        <div className="prefs-hint">
          Manage named YHA Net networks. Create or join by invite, approve join requests, then choose
          which offers this node publishes for docs, model metadata, and pricing sync.
        </div>
      </section>

      <section className="prefs-section" data-view="simple">
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
          gap: 16,
          alignItems: 'start',
        }}>
          <div>
            <h4 className="prefs-sec">This node identity</h4>
            {self ? (
              <div style={{
                display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '4px 12px',
                fontSize: 12, margin: '4px 0 0', fontFamily: 'var(--font-mono)',
              }}>
                <span style={{ color: 'var(--fg-mute)' }}>Node id</span>
                <span style={{ color: 'var(--fg)' }}>{selfId || '—'}</span>
                <span style={{ color: 'var(--fg-mute)' }}>Label</span>
                <span style={{ color: 'var(--fg)' }}>{self.label || self.identity?.label || '—'}</span>
                <span style={{ color: 'var(--fg-mute)' }}>Computer name</span>
                <span style={{ color: 'var(--fg)' }}>{self.hostname || '—'}</span>
                <span style={{ color: 'var(--fg-mute)' }}>Tailscale</span>
                <span style={{ color: self.tailscaleHost ? 'var(--fg)' : 'var(--fg-mute)' }}>{self.tailscaleHost || 'not on a tailnet'}</span>
                <span style={{ color: 'var(--fg-mute)' }}>Funnel / web</span>
                <span style={{ color: self.funnelUrl ? 'var(--fg)' : 'var(--fg-mute)' }}>{self.funnelUrl || 'no funnel configured'}</span>
                <span style={{ color: 'var(--fg-mute)' }}>Install path</span>
                <span style={{ color: localBuild?.installPath ? 'var(--fg)' : 'var(--fg-mute)' }}>{localBuild?.installPath || 'unknown'}</span>
                <span style={{ color: 'var(--fg-mute)' }}>SSH</span>
                <span style={{ color: 'var(--fg)' }}>{sshHint(localBuild?.sshHost || self.tailscaleHost || self.hostname, localBuild?.installPath || undefined)}</span>
                <span style={{ color: 'var(--fg-mute)' }}>Build</span>
                <span style={{ color: 'var(--fg)' }}>{localBuild?.describe || localBuild?.commit || 'unknown'}{localBuild?.branch ? ` · ${localBuild.branch}` : ''}</span>
                <span style={{ color: 'var(--fg-mute)' }}>Update source</span>
                <span style={{ color: 'var(--fg)' }}>
                  {localUpdateSource?.sourceLabel === 'custom' ? 'custom' : 'public'}
                  {localUpdateSource?.url && localUpdateSource.sourceLabel === 'custom'
                    ? ` · ${localUpdateSource.url.replace(/^https?:\/\//, '')}`
                    : ''}
                </span>
                <span style={{ color: 'var(--fg-mute)' }}>Updates</span>
                <span style={{ color: 'var(--fg)' }}>{formatUpdateStatus(localUpdateStatus)}</span>
                <span style={{ color: 'var(--fg-mute)' }}>Public port</span>
                <span style={{ color: 'var(--fg)' }}>{self.port} · {self.platform}</span>
              </div>
            ) : selfErr ? (
              <div className="prefs-hint" style={{ color: 'var(--err, #f66)' }}>Self-detect failed: {selfErr}</div>
            ) : (
              <div className="prefs-hint">Detecting…</div>
            )}
          </div>
          <div>
            <h4 className="prefs-sec">This node&apos;s offers</h4>
            <div className="prefs-hint" style={{ marginBottom: 8 }}>
              Choose what this node publishes to other YHA Net members. Disabled offers stay local only.
            </div>
            {offerDraft.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {offerDraft.map((offer, idx) => (
                  <label key={offer.id} className="prefs-row" style={{ alignItems: 'center', gap: 8, margin: 0 }}>
                    <input
                      type="checkbox"
                      checked={offer.enabled !== false}
                      onChange={(e) => {
                        const enabled = e.target.checked;
                        setOfferDraft((prev) => prev.map((o, i) => i === idx ? { ...o, enabled } : o));
                      }}
                    />
                    <span>{offer.label}</span>
                    <span className="prefs-hint" style={{ margin: 0 }}>{offer.kind}</span>
                  </label>
                ))}
                <div className="prefs-row" style={{ gap: 8, marginTop: 4 }}>
                  <button className="prefs-btn" disabled={netBusy} onClick={() => { void saveOffers(); }}>Save offers</button>
                </div>
              </div>
            ) : (
              <div className="prefs-hint">Loading offers…</div>
            )}
          </div>
        </div>
      </section>

      <section className="prefs-section" data-view="simple">
        <h4 className="prefs-sec">Networks</h4>
        <div className="prefs-row" style={{ alignItems: 'center', gap: 8, marginTop: 8 }}>
          <input
            className="prefs-input flex1"
            type="text"
            value={newNetworkName}
            placeholder="Network name, e.g. Michael Home YPA"
            onChange={(e) => setNewNetworkName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') createNetwork(); }}
          />
          <button className="prefs-btn" disabled={netBusy || !newNetworkName.trim()} onClick={createNetwork}>Create network</button>
        </div>
        <div style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--stroke)' }}>
          <div className="prefs-hint" style={{ marginBottom: 6 }}>
            Join another YHA Net: paste a 10-minute invite token from another node. Endpoint override is only needed if the token has no reachable Funnel hint.
          </div>
          <div className="prefs-row" style={{ alignItems: 'center', gap: 8 }}>
            <textarea
              className="prefs-input flex1"
              value={joinToken}
              placeholder="yha-net://join?payload=…"
              rows={2}
              spellCheck={false}
              style={{ fontFamily: 'var(--font-mono)', fontSize: 11, resize: 'vertical' }}
              onChange={(e) => setJoinToken(e.target.value)}
              onBlur={() => setJoinToken((v) => normalizePastedInviteToken(v))}
            />
            <input
              className="prefs-input"
              type="text"
              value={joinEndpoint}
              placeholder="optional https://node.taila…"
              style={{ width: 220 }}
              onChange={(e) => setJoinEndpoint(e.target.value)}
            />
            <button className="prefs-btn" disabled={netBusy || !joinToken.trim()} onClick={joinNetwork}>Send join request</button>
          </div>
        </div>
        {netMsg && <div className="prefs-hint" style={{ marginTop: 8 }}>{netMsg}</div>}
        {inviteToken && (
          <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center' }}>
            <textarea
              className="prefs-input flex1"
              readOnly
              value={inviteToken}
              rows={2}
              spellCheck={false}
              style={{ fontFamily: 'var(--font-mono)', fontSize: 11, resize: 'vertical' }}
              onFocus={(e) => e.currentTarget.select()}
            />
            <button className="prefs-btn" onClick={() => navigator.clipboard?.writeText(inviteToken).then(() => setNetMsg('Invite copied to clipboard.')).catch(() => setNetMsg('Copy failed. Select the full invite token and copy it manually.'))}>Copy full invite</button>
          </div>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
          {networks.length === 0 ? (
            <div className="prefs-hint">This node is not in a named YHA Net network yet.</div>
          ) : networks.map((network) => {
            const members = Object.entries(network.members || {});
            const offerRows = memberOfferRows(network);
            return (
              <div key={network.id} style={{ padding: '10px 12px', borderRadius: 'var(--radius-sm)', background: 'var(--bg)', border: '1px solid var(--stroke)' }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                  <strong className="flex1">{network.name}</strong>
                  <span className="prefs-hint" style={{ margin: 0 }}>
                    rev {network.revision} · {reachability[network.id]?.online ?? 0} of {reachability[network.id]?.total ?? members.length} reachable
                  </span>
                  <button className="prefs-btn" disabled={netBusy} onClick={() => refreshPeerManifests(network.id)}>Refresh offers</button>
                  <button className="prefs-btn" disabled={netBusy} title="Fetch model capabilities (context length, vision, tool-call support) from all peers and apply" onClick={() => syncNetworkData(network.id, 'model-data')}>Sync model metadata</button>
                  <button className="prefs-btn" disabled={netBusy} title="Fetch per-token pricing from all peers and apply" onClick={() => syncNetworkData(network.id, 'pricing')}>Sync pricing</button>
                  <button className="prefs-btn" disabled={netBusy} onClick={() => createInvite(network.id)}>Create 10-min invite</button>
                  <button className="prefs-btn danger" disabled={netBusy} onClick={() => leaveNetwork(network.id, network.name)}>Leave</button>
                </div>
                {members.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                    {members.map(([id, m]) => {
                      const isThisNode = id === selfId;
                      return (
                        <span key={id} className="prefs-hint" style={{ display: 'inline-flex', gap: 5, alignItems: 'center', margin: 0, padding: '3px 6px', border: '1px solid var(--stroke)', borderRadius: 999 }} title={endpointSummary(m)}>
                          {m.label || id}{isThisNode ? ' (this node)' : ''} · {m.role || 'member'}
                          {!isThisNode && <button className="prefs-btn danger" disabled={netBusy} style={{ padding: '1px 5px' }} onClick={() => removeNetworkMember(network.id, id, m.label)}>Remove</button>}
                        </span>
                      );
                    })}
                  </div>
                )}
                {offerRows.length > 0 && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 8 }}>
                    {offerRows.map((row) => {
                      const nodeId = row.id;
                      const m = row.manifest;
                      const key = `${network.id}:${nodeId}`;
                      const docs = remoteDocs[key] || { path: '' };
                      const enabledOffers = (row.offers || []).filter((o) => o.enabled !== false);
                      const hasDocs = enabledOffers.some((o) => o.kind === 'docs' || o.id === 'offer_docs');
                      const hasChat = enabledOffers.some((o) => o.kind === 'chat-history' || o.id === 'offer_chat_history');
                      const offerText = enabledOffers.length
                        ? enabledOffers.map((o) => o.label || o.kind).join(' · ')
                        : row.isSelf ? 'no offers enabled' : 'not fetched yet';
                      const statusBits = [
                        row.isSelf ? 'this node' : null,
                        row.online === true ? 'reachable' : row.online === false ? 'offline' : null,
                        m?.fetchedAt ? `seen ${new Date(m.fetchedAt).toLocaleString()}` : null,
                        endpointSummary(row.member),
                      ].filter(Boolean);
                      const buildText = row.build?.describe || row.build?.commit || null;
                      return (
                        <div key={nodeId} style={{ padding: '8px 10px', borderRadius: 'var(--radius-sm)', background: 'var(--bg-2)', border: '1px solid var(--stroke)' }}>
                          <div className="prefs-hint" style={{ margin: 0 }}>
                            <strong>{row.member?.label || nodeId || 'Node'}</strong>
                            {' offers: '}
                            {offerText}
                            {statusBits.length ? ` · ${statusBits.join(' · ')}` : ''}
                          </div>
                          <div className="prefs-hint" style={{ margin: '4px 0 0', fontFamily: 'var(--font-mono)', fontSize: 11 }}>
                            {row.installPath ? `install ${row.installPath}` : 'install path unknown'}
                            {' · '}
                            {sshHint(row.sshHost || undefined, row.installPath || undefined)}
                          </div>
                          <div className="prefs-hint" style={{ margin: '4px 0 0', fontSize: 11 }}>
                            {buildText ? `build ${buildText}` : 'build unknown'}
                            {' · '}
                            source {row.updateSource?.sourceLabel === 'custom' ? 'custom' : 'public'}
                            {row.updateSource?.url && row.updateSource.sourceLabel === 'custom'
                              ? ` (${row.updateSource.url.replace(/^https?:\/\//, '')})`
                              : ''}
                            {' · '}
                            {formatUpdateStatus(row.updateStatus)}
                          </div>
                          {nodeId && !row.isSelf && (hasChat || hasDocs) && (
                            <div style={{ marginTop: 6, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              {hasDocs && (
                                <button className="prefs-btn" disabled={netBusy} onClick={() => syncPeerDocs(network.id, nodeId, row.member?.label)}>Sync docs ⟲</button>
                              )}
                              {hasChat && (
                                <button className="prefs-btn" disabled={netBusy} onClick={() => importPeerSessions(network.id, nodeId, row.member?.label)}>Import chat history</button>
                              )}
                            </div>
                          )}
                          {hasDocs && nodeId && !row.isSelf && (
                            <div style={{ marginTop: 6 }}>
                              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                                <button className="prefs-btn" disabled={!!docs.loading} onClick={() => loadRemoteDocs(network.id, nodeId, '')}>Browse docs</button>
                                {docs.path && (
                                  <button
                                    className="prefs-btn"
                                    disabled={!!docs.loading}
                                    onClick={() => loadRemoteDocs(network.id, nodeId, docs.path.split('/').slice(0, -1).join('/'))}
                                  >Up</button>
                                )}
                                <span className="prefs-hint" style={{ margin: 0, fontFamily: 'var(--font-mono)' }}>{docs.path || '/'}</span>
                              </div>
                              {docs.error && <div className="prefs-hint" style={{ color: 'var(--err, #f66)' }}>{docs.error}</div>}
                              {docs.entries && (
                                <div style={{ marginTop: 6, display: 'grid', gridTemplateColumns: '1fr auto', gap: 4, fontSize: 12 }}>
                                  {docs.entries.map((e) => (
                                    <button
                                      key={e.path}
                                      className="prefs-btn"
                                      style={{ textAlign: 'left', justifyContent: 'flex-start', fontFamily: e.type === 'file' ? 'var(--font-mono)' : undefined }}
                                      onClick={() => e.type === 'dir' ? loadRemoteDocs(network.id, nodeId, e.path) : previewRemoteDoc(network.id, nodeId, e.path)}
                                    >
                                      {e.type === 'dir' ? '📁 ' : '📄 '}{e.name}
                                    </button>
                                  ))}
                                </div>
                              )}
                              {docs.preview !== undefined && (
                                <pre style={{
                                  marginTop: 6, maxHeight: 220, overflow: 'auto', padding: 8,
                                  borderRadius: 'var(--radius-sm)', border: '1px solid var(--stroke)',
                                  background: 'var(--bg)', whiteSpace: 'pre-wrap', fontSize: 11,
                                }}>{docs.previewPath ? `${docs.previewPath}\n\n` : ''}{docs.preview}</pre>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {joinRequests.filter((r) => r.status === 'pending').length > 0 && (
          <div style={{ marginTop: 12 }}>
            <h4 className="prefs-sec" style={{ marginTop: 0 }}>Join requests</h4>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {joinRequests.filter((r) => r.status === 'pending').map((r) => {
                const rn = r.requestingNode;
                return (
                  <div key={r.id} style={{ padding: '10px 12px', borderRadius: 'var(--radius-sm)', background: 'var(--bg)', border: '1px solid var(--stroke)', display: 'flex', gap: 8, alignItems: 'center' }}>
                    <div className="flex1">
                      <strong>{rn?.label || rn?.id || 'Unknown node'}</strong>
                      <div className="prefs-hint" style={{ marginTop: 3 }}>
                        wants to join {r.networkName || r.networkId} · {rn?.hostname || rn?.platform || 'no hostname'} · {new Date(r.requestedAt).toLocaleString()}
                      </div>
                    </div>
                    <button className="prefs-btn" disabled={netBusy} onClick={() => decideJoinRequest(r.id, 'accept')}>Accept</button>
                    <button className="prefs-btn" disabled={netBusy} onClick={() => decideJoinRequest(r.id, 'reject')}>Reject</button>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </section>
    </>
  );
}
