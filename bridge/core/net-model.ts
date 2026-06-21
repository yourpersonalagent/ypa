'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const PATHS = require('./paths');
const { NET_DIR, getNodeIdentity, publicNodeIdentity, atomicWriteJson, readJson, nowIso, signPeerRequest, verifyPeerSignature, sha256Hex } = require('./net-identity');
const state = require('./state');

const NETWORKS_DIR = path.join(NET_DIR, 'networks');
const OFFERS_FILE = path.join(NET_DIR, 'offers.json');
const INVITES_FILE = path.join(NET_DIR, 'invites.json');
const JOIN_REQUESTS_FILE = path.join(NET_DIR, 'join-requests.json');
const OUTGOING_JOINS_FILE = path.join(NET_DIR, 'outgoing-joins.json');
const PEER_MANIFESTS_DIR = path.join(NET_DIR, 'peer-manifests');
const SYNC_CACHE_DIR = path.join(NET_DIR, 'sync-cache');
const NONCES_FILE = path.join(NET_DIR, 'peer-nonces.json');
const EVENTS_DIR = path.join(NET_DIR, 'events');
const peerNonces = new Map();
const eventSubscribers: any = new Map();

const PEER_FETCH_TIMEOUT_MS = Number.parseInt(process.env.YHA_NET_PEER_TIMEOUT_MS || '3500', 10);
const PEER_PROBE_TIMEOUT_MS = Number.parseInt(process.env.YHA_NET_PROBE_TIMEOUT_MS || '1800', 10);

function timeoutSignal(ms) {
  const n = Number(ms || 0);
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(Number.isFinite(n) && n > 0 ? n : PEER_FETCH_TIMEOUT_MS);
  }
  return undefined;
}

async function fetchPeerWithTimeout(url, options: any = {}, ms = PEER_FETCH_TIMEOUT_MS) {
  return fetch(url, { ...options, signal: options.signal || timeoutSignal(ms) });
}

function id(prefix) { return `${prefix}_${Buffer.from(crypto.randomBytes(16)).toString('base64url')}`; }
function ensureDirs() { fs.mkdirSync(NETWORKS_DIR, { recursive: true }); }
function networkFile(networkId) { return path.join(NETWORKS_DIR, `${networkId}.json`); }
function listNetworkFiles() { ensureDirs(); return fs.readdirSync(NETWORKS_DIR).filter((f) => f.endsWith('.json')); }

function safeIdPart(value) {
  const s = String(value || '');
  if (!/^[A-Za-z0-9_-]+$/.test(s)) throw new Error('Invalid id.');
  return s;
}

function loadNonceStore() {
  const cutoff = Date.now() - 10 * 60_000;
  const store = readJson(NONCES_FILE, { schemaVersion: 1, nonces: {} });
  const nonces = store && store.nonces && typeof store.nonces === 'object' ? store.nonces : {};
  peerNonces.clear();
  for (const [k, v] of Object.entries(nonces)) {
    const ts = Number(v || 0);
    if (Number.isFinite(ts) && ts >= cutoff) peerNonces.set(k, ts);
  }
}

function persistNonceStore() {
  const cutoff = Date.now() - 10 * 60_000;
  const nonces = {};
  for (const [k, v] of peerNonces) {
    if (Date.now() - v <= 10 * 60_000 && v >= cutoff) nonces[k] = v;
  }
  atomicWriteJson(NONCES_FILE, { schemaVersion: 1, updatedAt: nowIso(), nonces }, 0o600);
}

function eventLogFile(networkId) {
  return path.join(EVENTS_DIR, `${safeIdPart(networkId)}.jsonl`);
}

function appendNetEvent(networkId, type, data = {}) {
  const event = { id: id('evt'), networkId, type, data, createdAt: nowIso() };
  try {
    fs.mkdirSync(EVENTS_DIR, { recursive: true });
    fs.appendFileSync(eventLogFile(networkId), JSON.stringify(event) + '\n', { mode: 0o600 });
  } catch (_) { /* best effort */ }
  const subs = eventSubscribers.get(networkId);
  if (subs) {
    for (const cb of Array.from(subs) as any[]) {
      try { cb(event); } catch (_) { /* subscriber gone */ }
    }
  }
  return event;
}

function subscribeNetworkEvents(networkId, cb: any) {
  const id = safeIdPart(networkId);
  let subs = eventSubscribers.get(id);
  if (!subs) { subs = new Set(); eventSubscribers.set(id, subs); }
  subs.add(cb);
  return () => {
    const current = eventSubscribers.get(id);
    if (!current) return;
    current.delete(cb);
    if (current.size === 0) eventSubscribers.delete(id);
  };
}

function recentNetworkEvents(networkId, limit = 50) {
  try {
    const lines = fs.readFileSync(eventLogFile(networkId), 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-Math.max(1, Math.min(Number(limit) || 50, 200))).map((line) => JSON.parse(line));
  } catch (_) { return []; }
}

function cleanName(name) {
  const s = String(name || '').trim();
  if (!s) throw new Error('Network name is required.');
  if (s.length > 80) throw new Error('Network name is too long.');
  return s;
}

function readNetworks() {
  return listNetworkFiles().map((f) => readJson(path.join(NETWORKS_DIR, f), null)).filter(Boolean);
}

function readNetwork(networkId) {
  const s = String(networkId || '');
  if (!/^net_[A-Za-z0-9_-]+$/.test(s)) return null;
  return readJson(networkFile(s), null);
}

function publicNetwork(network) {
  if (!network) return null;
  return {
    schemaVersion: network.schemaVersion || 1,
    id: network.id,
    name: network.name,
    createdAt: network.createdAt,
    createdBy: network.createdBy,
    revision: network.revision || 1,
    updatedAt: network.updatedAt,
    updatedBy: network.updatedBy,
    members: network.members || {},
  };
}

function writeNetwork(network) {
  ensureDirs();
  atomicWriteJson(networkFile(network.id), network, 0o600);
  return network;
}

function sameJson(a, b) { return JSON.stringify(a || {}) === JSON.stringify(b || {}); }

function isTailscaleHost(host) {
  const h = String(host || '').toLowerCase();
  return h.endsWith('.ts.net') || h.endsWith('.tailscale.net');
}

function normalizeEndpoints(endpoints: any = {}) {
  const ep = { ...(endpoints || {}) };
  for (const key of Object.keys(ep)) {
    const raw = String(ep[key] || '').trim().replace(/\/+$/, '');
    if (!raw) { delete ep[key]; continue; }
    ep[key] = raw;
  }
  const addHttpsAlias = (raw) => {
    try {
      const u = new URL(String(raw));
      if (!isTailscaleHost(u.hostname)) return '';
      if (u.protocol === 'https:' && (!u.port || u.port === '443')) return `https://${u.hostname}`;
      if (u.protocol === 'http:') return `https://${u.hostname}`;
    } catch { /* skip */ }
    return '';
  };
  const httpsFrom = ['tailscaleHttps', 'tailscale', 'web', 'funnel', 'tailscaleHttp', 'lan']
    .map((k) => ep[k])
    .filter(Boolean);
  for (const raw of httpsFrom) {
    const alias = addHttpsAlias(raw);
    if (alias && !ep.tailscaleHttps) ep.tailscaleHttps = alias;
    if (alias && !ep.tailscale) ep.tailscale = alias;
  }
  if (ep.tailscaleHttps && !ep.tailscale) ep.tailscale = ep.tailscaleHttps;
  if (ep.tailscale && !ep.tailscaleHttps) {
    const alias = addHttpsAlias(ep.tailscale);
    if (alias) ep.tailscaleHttps = alias;
  }
  return ep;
}

function hydrateNetworkEndpoints(network) {
  if (!network || !network.members) return { changed: false, network };
  let changed = false;
  for (const member of Object.values(network.members) as any[]) {
    if (!member || typeof member !== 'object') continue;
    const next = normalizeEndpoints(member.endpoints || {});
    if (!sameJson(member.endpoints || {}, next)) {
      member.endpoints = next;
      changed = true;
    }
  }
  if (changed) {
    network.updatedAt = nowIso();
    writeNetwork(network);
  }
  return { changed, network };
}

function hydrateAllNetworkEndpoints() {
  const changed: string[] = [];
  for (const network of readNetworks()) {
    const result = hydrateNetworkEndpoints(network);
    if (result.changed) changed.push(network.id);
  }
  return { changed };
}

function normalizeNetworkMembers(members: any = {}) {
  const out = { ...(members || {}) };
  for (const [id, member] of Object.entries(out)) {
    if (!member || typeof member !== 'object') continue;
    out[id] = {
      ...(member as any),
      endpoints: normalizeEndpoints((member as any).endpoints || {}),
    };
  }
  return out;
}

function mergeEndpointObjects(existing: any = {}, detected: any = {}) {
  const merged = normalizeEndpoints(existing || {});
  for (const [k, v] of Object.entries(normalizeEndpoints(detected || {}))) if (v) merged[k] = String(v);
  return normalizeEndpoints(merged);
}

function isHttpsUrl(value: any) {
  return /^https:/i.test(String(value || '').trim());
}

// Pick the better of two endpoint values for the same key. An https URL always
// beats a plain http one (so a known-good browser endpoint is never lost to a
// later http-only report). Otherwise the caller's tiebreak (preferExisting)
// decides, which keeps a node authoritative for its own entry.
function chooseEndpointValue(a: any, b: any, preferExisting: boolean) {
  const av = String(a || '').trim();
  const bv = String(b || '').trim();
  if (!av) return bv;
  if (!bv) return av;
  const ah = isHttpsUrl(av);
  const bh = isHttpsUrl(bv);
  if (ah && !bh) return av;
  if (bh && !ah) return bv;
  return preferExisting ? av : bv;
}

// Union two endpoint maps, never dropping a key either side knows about.
function unionEndpoints(existing: any = {}, incoming: any = {}, preferExisting: boolean) {
  const a = normalizeEndpoints(existing || {});
  const b = normalizeEndpoints(incoming || {});
  const out: any = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const v = chooseEndpointValue(a[key], b[key], preferExisting);
    if (v) out[key] = v;
  }
  return normalizeEndpoints(out);
}

function endpointHintsFromManifest(manifest: any = {}) {
  const endpoints = { ...(manifest?.node?.endpoints || {}) };
  const fetchedFrom = String(manifest?.fetchedFrom || '').trim();
  if (fetchedFrom) {
    try {
      const u = new URL(fetchedFrom);
      const origin = `${u.protocol}//${u.host}`.replace(/\/+$/, '');
      if (origin) endpoints.web = endpoints.web || origin;
      if (isTailscaleHost(u.hostname)) {
        endpoints.tailscaleHttps = endpoints.tailscaleHttps || `https://${u.hostname}`;
        endpoints.tailscale = endpoints.tailscale || `https://${u.hostname}`;
      }
    } catch { /* ignore malformed cached endpoint */ }
  }
  return normalizeEndpoints(endpoints);
}

// Merge an incoming members map into the local one, treating THIS node as the
// sole authority for its own entry (endpoints/label/hostname) and union-merging
// every other member's endpoints so a good https endpoint learned anywhere is
// never lost. Membership facts (role/joinedAt/addedBy) follow the incoming doc.
function mergeMembersAuthoritative(existingMembers: any = {}, incomingMembers: any = {}, selfId = '') {
  const existing = existingMembers || {};
  const incoming = incomingMembers || {};
  const out: any = {};
  for (const [nodeId, incomingMember] of Object.entries(incoming)) {
    if (!incomingMember || typeof incomingMember !== 'object') continue;
    const prev = existing[nodeId];
    if (nodeId === selfId && prev && typeof prev === 'object') {
      // Self knows itself best: keep our own identity + freshly detected endpoints.
      out[nodeId] = {
        ...(incomingMember as any),
        ...(prev as any),
        endpoints: normalizeEndpoints((prev as any).endpoints || {}),
      };
      continue;
    }
    if (prev && typeof prev === 'object') {
      out[nodeId] = {
        ...(prev as any),
        ...(incomingMember as any),
        label: (incomingMember as any).label || (prev as any).label,
        hostname: (incomingMember as any).hostname || (prev as any).hostname,
        endpoints: unionEndpoints((prev as any).endpoints, (incomingMember as any).endpoints, false),
      };
    } else {
      out[nodeId] = {
        ...(incomingMember as any),
        endpoints: normalizeEndpoints((incomingMember as any).endpoints || {}),
      };
    }
  }
  return out;
}

function updateSelfEndpointsInNetworks(endpoints: any = {}) {
  const self = publicNodeIdentity({ endpoints });
  const changed: any[] = [];
  for (const network of readNetworks()) {
    if (!network || !network.members || !network.members[self.id]) continue;
    const member = network.members[self.id];
    const nextEndpoints = mergeEndpointObjects(member.endpoints || {}, self.endpoints || {});
    const nextLabel = self.label || member.label;
    const nextHostname = self.hostname || member.hostname;
    if (sameJson(member.endpoints || {}, nextEndpoints) && member.label === nextLabel && member.hostname === nextHostname) continue;
    member.endpoints = nextEndpoints;
    member.label = nextLabel;
    member.hostname = nextHostname;
    member.platform = self.platform || member.platform;
    member.publicKey = self.publicKey || member.publicKey;
    // Bump the revision so this correction actually wins on peers — otherwise a
    // peer's stale (equal-revision) view of us survives the next merge.
    network.revision = Number(network.revision || 1) + 1;
    network.updatedAt = nowIso();
    network.updatedBy = self.id;
    writeNetwork(network);
    appendNetEvent(network.id, 'membership.changed', { revision: network.revision, reason: 'self.endpoints.changed', nodeId: self.id });
    changed.push(network.id);
  }
  return { changed };
}

function peerManifestDir(networkId) {
  return path.join(PEER_MANIFESTS_DIR, String(networkId || ''));
}

function peerManifestFile(networkId, nodeId) {
  return path.join(peerManifestDir(networkId), `${String(nodeId || '')}.json`);
}

function syncCacheFile(networkId, nodeId, kind) {
  return path.join(SYNC_CACHE_DIR, String(networkId || ''), `${String(nodeId || '')}-${String(kind || 'data')}.json`);
}

function createNetwork(input: any = {}) {
  const self = publicNodeIdentity({ endpoints: input.endpoints && typeof input.endpoints === 'object' ? input.endpoints : {} });
  const ts = nowIso();
  const network = {
    schemaVersion: 1,
    id: id('net'),
    name: cleanName(input.name),
    createdAt: ts,
    createdBy: self.id,
    revision: 1,
    updatedAt: ts,
    updatedBy: self.id,
    members: {
      [self.id]: {
        nodeId: self.id,
        label: self.label,
        hostname: self.hostname,
        platform: self.platform,
        publicKey: self.publicKey,
        endpoints: self.endpoints || {},
        role: 'owner',
        joinedAt: ts,
        addedBy: self.id,
      },
    },
  };
  writeNetwork(network);
  appendNetEvent(network.id, 'membership.changed', { revision: network.revision, reason: 'network.created' });
  ensureDefaultOffers();
  return network;
}

function defaultOffers() {
  const self = getNodeIdentity();
  const docsRoot = PATHS.userDocsDir;
  return {
    schemaVersion: 1,
    nodeId: self.id,
    updatedAt: nowIso(),
    offers: [
      {
        id: 'offer_docs',
        kind: 'docs',
        label: 'Docs Folder',
        root: docsRoot,
        enabled: true,
        capabilities: { list: true, read: true, write: false, sync: true, search: true },
      },
      {
        id: 'offer_model_data',
        kind: 'model-data',
        label: 'Model Metadata',
        enabled: true,
        capabilities: { read: true, sync: true },
      },
      {
        id: 'offer_pricing',
        kind: 'price-costs',
        label: 'Pricing Catalog',
        enabled: true,
        capabilities: { read: true, sync: true },
      },
      {
        id: 'offer_usage_cost_summary',
        kind: 'usage-cost-summary',
        label: 'Usage Cost Summary',
        enabled: false,
        privacy: 'aggregate-only',
        capabilities: { read: true, sync: true },
      },
      {
        id: 'offer_chat_history',
        kind: 'chat-history',
        label: 'Chat History',
        // Off by default — conversation transcripts are sensitive, so a node
        // only shares them after the owner explicitly opts in.
        enabled: false,
        privacy: 'transcripts',
        capabilities: { list: true, read: true, sync: true },
      },
    ],
  };
}

function ensureDefaultOffers() {
  const existing = readJson(OFFERS_FILE, null);
  if (existing && Array.isArray(existing.offers)) {
    // Backfill default offers added in newer versions (e.g. chat-history)
    // without clobbering the owner's enable/disable choices on existing ones.
    const known = new Set(existing.offers.map((o) => o && o.id).filter(Boolean));
    const missing = defaultOffers().offers.filter((o) => o && !known.has(o.id));
    if (missing.length) {
      existing.offers = [...existing.offers, ...missing];
      existing.updatedAt = nowIso();
      atomicWriteJson(OFFERS_FILE, existing, 0o600);
    }
    return existing;
  }
  const offers = defaultOffers();
  atomicWriteJson(OFFERS_FILE, offers, 0o600);
  return offers;
}

function readOffers() {
  const offers = ensureDefaultOffers();
  const self = getNodeIdentity();
  if (offers.nodeId !== self.id) {
    offers.nodeId = self.id;
    offers.updatedAt = nowIso();
    atomicWriteJson(OFFERS_FILE, offers, 0o600);
  }
  return offers;
}

function writeOffers(input) {
  if (!input || !Array.isArray(input.offers)) throw new Error('offers[] is required.');
  const self = getNodeIdentity();
  const out = {
    schemaVersion: 1,
    nodeId: self.id,
    updatedAt: nowIso(),
    offers: input.offers.map((offer) => ({
      ...offer,
      id: String(offer.id || id('offer')),
      kind: String(offer.kind || 'custom'),
      label: String(offer.label || offer.kind || 'Offer'),
      enabled: offer.enabled !== false,
      capabilities: offer.capabilities && typeof offer.capabilities === 'object' ? offer.capabilities : {},
    })),
  };
  atomicWriteJson(OFFERS_FILE, out, 0o600);
  for (const network of readNetworks()) {
    if (network && network.members && network.members[self.id]) appendNetEvent(network.id, 'offers.changed', { nodeId: self.id });
  }
  return out;
}

function createInvite(networkId, input: any = {}) {
  const network = readNetwork(networkId);
  if (!network) throw new Error('Network not found.');
  const self = getNodeIdentity();
  if (!network.members || !network.members[self.id]) throw new Error('This node is not a member of that network.');
  const ttlMs = Math.min(Math.max(Number(input.ttlMs || 10 * 60_000), 30_000), 10 * 60_000);
  const expiresAt = new Date(Date.now() + ttlMs).toISOString();
  const invite = {
    id: id('inv'),
    networkId: network.id,
    networkName: network.name,
    inviterNodeId: self.id,
    createdAt: nowIso(),
    expiresAt,
    inviteSecret: Buffer.from(crypto.randomBytes(24)).toString('base64url'),
    endpointHints: Array.isArray(input.endpointHints) ? input.endpointHints.filter(Boolean) : [],
    usedAt: null,
  };
  const store = readJson(INVITES_FILE, { schemaVersion: 1, invites: [] });
  store.invites = (Array.isArray(store.invites) ? store.invites : []).filter((i) => i && new Date(i.expiresAt).getTime() > Date.now());
  store.invites.push(invite);
  atomicWriteJson(INVITES_FILE, store, 0o600);
  const payload = Buffer.from(JSON.stringify(invite)).toString('base64url');
  return { ...invite, token: `yha-net://join?payload=${payload}` };
}

function normalizeInviteTokenInput(token) {
  let raw = String(token || '').trim();
  if (!raw) throw new Error('Invite token is required.');

  // Users often paste from chat/email/JSON, where the token may be quoted,
  // line-wrapped, or surrounded by explanatory text. Accept those forms so a
  // copied invite does not fail with a low-level JSON parse error.
  if ((raw.startsWith('\"') && raw.endsWith('\"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }
  const embedded = raw.match(/yha-net:\/\/join\?payload=([A-Za-z0-9_-]+)/);
  if (embedded) return embedded[0];
  const payloadMatch = raw.match(/payload[\s:=\"]+([A-Za-z0-9_-]+)/i);
  if (payloadMatch) return payloadMatch[1];
  return raw.replace(/\s+/g, '');
}

function decodeInviteToken(token) {
  const raw = normalizeInviteTokenInput(token);
  let payload = raw;
  if (raw.startsWith('yha-net://')) {
    let u;
    try {
      u = new URL(raw);
    } catch {
      throw new Error('Invite token URL is malformed. Copy the full invite token and try again.');
    }
    payload = u.searchParams.get('payload') || '';
  }
  payload = String(payload || '').replace(/\s+/g, '');
  if (!payload) throw new Error('Invite token payload is missing.');
  if (!/^[A-Za-z0-9_-]+$/.test(payload)) throw new Error('Invite token contains invalid characters. Copy the full invite token and try again.');
  try {
    const decoded = Buffer.from(payload, 'base64url').toString('utf8');
    const invite = JSON.parse(decoded);
    if (!invite || !invite.networkId || !invite.inviteSecret) throw new Error('Invalid invite token.');
    if (new Date(invite.expiresAt || 0).getTime() <= Date.now()) throw new Error('Invite token has expired.');
    return invite;
  } catch (e) {
    const msg = e && e.message ? String(e.message) : '';
    if (msg === 'Invalid invite token.' || msg === 'Invite token has expired.') throw e;
    throw new Error('Invite token is incomplete or malformed. Copy the full yha-net:// invite token from the inviter node and try again.');
  }
}

function readInviteStore() {
  const store = readJson(INVITES_FILE, { schemaVersion: 1, invites: [] });
  if (!Array.isArray(store.invites)) store.invites = [];
  return store;
}

function readJoinRequestStore() {
  const store = readJson(JOIN_REQUESTS_FILE, { schemaVersion: 1, requests: [] });
  if (!Array.isArray(store.requests)) store.requests = [];
  return store;
}

function readOutgoingJoinStore() {
  const store = readJson(OUTGOING_JOINS_FILE, { schemaVersion: 1, joins: [] });
  if (!Array.isArray(store.joins)) store.joins = [];
  return store;
}

function writeOutgoingJoinStore(store) {
  atomicWriteJson(OUTGOING_JOINS_FILE, store, 0o600);
  return store;
}

function writeJoinRequestStore(store) {
  atomicWriteJson(JOIN_REQUESTS_FILE, store, 0o600);
  return store;
}

function listJoinRequests() {
  const store = readJoinRequestStore();
  return store.requests.slice().sort((a, b) => String(b.requestedAt || '').localeCompare(String(a.requestedAt || '')));
}

function rememberOutgoingJoin(invite, endpoint, request) {
  const store = readOutgoingJoinStore();
  const ts = nowIso();
  const join = {
    id: request && request.id ? String(request.id) : id('outjoin'),
    networkId: invite.networkId,
    networkName: invite.networkName || '',
    inviteId: invite.id,
    inviteSecret: invite.inviteSecret,
    inviterNodeId: invite.inviterNodeId || '',
    endpoint: String(endpoint || ''),
    requestedAt: ts,
    updatedAt: ts,
    status: 'pending',
  };
  const idx = store.joins.findIndex((j) => j && j.networkId === join.networkId && j.inviteId === join.inviteId);
  if (idx >= 0) store.joins[idx] = { ...store.joins[idx], ...join, requestedAt: store.joins[idx].requestedAt || join.requestedAt };
  else store.joins.push(join);
  writeOutgoingJoinStore(store);
  return join;
}

function receiveJoinRequest(networkId, body: any = {}) {
  const inviteId = String(body.inviteId || '');
  const inviteSecret = String(body.inviteSecret || '');
  const requestingNode = body.requestingNode || {};
  if (!inviteId || !inviteSecret) throw new Error('Invite id and secret are required.');
  if (!requestingNode.id || !requestingNode.publicKey) throw new Error('Requesting node identity is incomplete.');

  const network = readNetwork(networkId);
  if (!network) throw new Error('Network not found.');
  const inviteStore = readInviteStore();
  const invite = inviteStore.invites.find((i) => i && i.id === inviteId && i.networkId === network.id);
  if (!invite) throw new Error('Invite not found on this node.');
  if (invite.usedAt) throw new Error('Invite has already been used.');
  if (new Date(invite.expiresAt || 0).getTime() <= Date.now()) throw new Error('Invite token has expired.');
  if (invite.inviteSecret !== inviteSecret) throw new Error('Invite secret is invalid.');
  if (network.members && network.members[requestingNode.id]) throw new Error('Node is already a member of this network.');

  const ts = nowIso();
  const store = readJoinRequestStore();
  const existingIdx = store.requests.findIndex((r) =>
    r && r.networkId === network.id && r.requestingNode && r.requestingNode.id === requestingNode.id && r.status === 'pending'
  );
  const request = {
    id: existingIdx >= 0 ? store.requests[existingIdx].id : id('jreq'),
    networkId: network.id,
    networkName: network.name,
    inviteId,
    inviterNodeId: invite.inviterNodeId,
    requestingNode: {
      id: String(requestingNode.id),
      label: String(requestingNode.label || requestingNode.hostname || requestingNode.id),
      hostname: String(requestingNode.hostname || ''),
      platform: String(requestingNode.platform || ''),
      publicKey: String(requestingNode.publicKey),
      endpoints: requestingNode.endpoints && typeof requestingNode.endpoints === 'object' ? requestingNode.endpoints : {},
      createdAt: requestingNode.createdAt || null,
    },
    requestedAt: existingIdx >= 0 ? store.requests[existingIdx].requestedAt : ts,
    updatedAt: ts,
    status: 'pending',
  };
  if (existingIdx >= 0) store.requests[existingIdx] = request;
  else store.requests.push(request);
  writeJoinRequestStore(store);
  return request;
}

async function requestJoin(token, endpointOverride, selfEndpoints: any = {}) {
  const invite = decodeInviteToken(token);
  const endpointHints = endpointOverride ? [endpointOverride] : (Array.isArray(invite.endpointHints) ? invite.endpointHints : []);
  const endpoints = endpointHints.filter(Boolean);
  if (endpoints.length === 0) throw new Error('Invite token has no endpoint hints. Paste the inviter URL too.');
  const body = {
    inviteId: invite.id,
    inviteSecret: invite.inviteSecret,
    networkId: invite.networkId,
    requestingNode: publicNodeIdentity({ endpoints: selfEndpoints }),
    requestedAt: nowIso(),
  };
  const errors: string[] = [];
  for (const endpoint of endpoints) {
    try {
      const base = String(endpoint).replace(/\/+$/, '');
      const r = await fetchPeerWithTimeout(`${base}/v1/peer/networks/${encodeURIComponent(invite.networkId)}/join-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d: any = await r.json().catch(() => ({}));
      if (!r.ok || !d.success) throw new Error(d.error || `${r.status} ${r.statusText}`);
      rememberOutgoingJoin(invite, base, d.request);
      return { invite: { networkId: invite.networkId, networkName: invite.networkName, inviterNodeId: invite.inviterNodeId }, endpoint: base, request: d.request };
    } catch (e) {
      errors.push(`${endpoint}: ${e && e.message ? e.message : String(e)}`);
    }
  }
  throw new Error(`Could not send join request. ${errors.join(' · ')}`);
}

function endpointReachScore(raw, key = '') {
  try {
    const u = new URL(String(raw || '').trim());
    const host = u.hostname.toLowerCase();
    if (!host || host === 'localhost' || host === '127.0.0.1' || host === '::1') return -1;
    if (u.protocol === 'https:' && (key === 'web' || key === 'funnel')) return 100;
    if (u.protocol === 'https:' && (host.endsWith('.ts.net') || host.endsWith('.tailscale.net'))) return 90;
    if (u.protocol === 'https:') return 80;
    if (host.endsWith('.ts.net') || host.endsWith('.tailscale.net')) return 70;
    return 40;
  } catch {
    return 0;
  }
}

function nodeEndpointCandidates(node) {
  const ep = node && node.endpoints && typeof node.endpoints === 'object' ? node.endpoints : {};
  const rows: any[] = [];
  for (const key of ['web', 'funnel', 'tailscaleHttps', 'tailscale', 'tailscaleHttp', 'lan', 'local']) {
    if (!ep[key]) continue;
    const value = String(ep[key]).replace(/\/+$/, '');
    const score = endpointReachScore(value, key);
    if (value && score >= 0) rows.push({ value, score });
  }
  rows.sort((a, b) => b.score - a.score);
  return Array.from(new Set(rows.map((r) => r.value)));
}

function signedHeaders(networkId, method, urlPath, body = '') {
  return signPeerRequest({ networkId, method, path: urlPath, body });
}

function memberByNodeId(network, nodeId) {
  return network && network.members && network.members[nodeId] ? network.members[nodeId] : null;
}

function verifyPeerRequest(req) {
  if (req && req._yhaPeerVerified && req._yhaPeerVerified.ok) return req._yhaPeerVerified;
  const networkId = String(req.params?.networkId || req.headers['x-yha-network'] || '');
  const nodeId = String(req.headers['x-yha-node'] || '');
  const timestamp = String(req.headers['x-yha-timestamp'] || '');
  const nonce = String(req.headers['x-yha-nonce'] || '');
  const signature = String(req.headers['x-yha-signature'] || '');
  const bodyHash = String(req.headers['x-yha-body-sha256'] || sha256Hex(''));
  if (!networkId || !nodeId || !timestamp || !nonce || !signature) return { ok: false, error: 'Missing YHA peer signature headers.' };
  if (String(req.headers['x-yha-network'] || networkId) !== networkId) return { ok: false, error: 'Peer signature network mismatch.' };
  const ts = Date.parse(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 5 * 60_000) return { ok: false, error: 'Peer signature timestamp is stale.' };
  const network = readNetwork(networkId);
  if (!network) return { ok: false, error: 'Network not found.' };
  const member = memberByNodeId(network, nodeId);
  if (!member || !member.publicKey) return { ok: false, error: 'Peer is not a member of this network.' };
  loadNonceStore();
  const nonceKey = `${networkId}:${nodeId}:${nonce}`;
  const prev = peerNonces.get(nonceKey);
  if (prev && Date.now() - prev < 10 * 60_000) return { ok: false, error: 'Peer signature nonce was already used.' };
  for (const [k, v] of peerNonces) if (Date.now() - v > 10 * 60_000) peerNonces.delete(k);
  const pathWithQuery = req.originalUrl || req.url || '/';
  const ok = verifyPeerSignature({
    publicKey: member.publicKey,
    method: req.method,
    path: pathWithQuery,
    networkId,
    timestamp,
    nonce,
    bodyHash,
    signature,
  });
  if (!ok) return { ok: false, error: 'Invalid peer signature.' };
  peerNonces.set(nonceKey, Date.now());
  persistNonceStore();
  return { ok: true, network, member };
}

function listPeerManifests(networkId) {
  const dir = peerManifestDir(networkId);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { files = []; }
  return files
    .map((f) => readJson(path.join(dir, f), null))
    .filter(Boolean)
    .sort((a, b) => String(a.node?.label || a.node?.id || '').localeCompare(String(b.node?.label || b.node?.id || '')));
}

async function fetchPeerManifest(network, member) {
  const endpoints = nodeEndpointCandidates(member);
  const errors: string[] = [];
  for (const endpoint of endpoints) {
    try {
      const urlPath = `/v1/peer/networks/${encodeURIComponent(network.id)}/manifest`;
      const r = await fetchPeerWithTimeout(`${endpoint}${urlPath}`, {
        method: 'GET',
        headers: { Accept: 'application/json', ...signedHeaders(network.id, 'GET', urlPath) },
      });
      const d: any = await r.json().catch(() => ({}));
      if (!r.ok || !d.success || !d.manifest) throw new Error(d.error || `${r.status} ${r.statusText}`);
      const manifest = {
        ...d.manifest,
        fetchedAt: nowIso(),
        fetchedFrom: endpoint,
      };
      const nodeId = manifest.node && manifest.node.id ? manifest.node.id : member.nodeId;
      atomicWriteJson(peerManifestFile(network.id, nodeId), manifest, 0o600);
      if (nodeId && network.members && network.members[nodeId] && manifest.node) {
        if (manifest.node.endpoints || manifest.fetchedFrom) {
          // A peer manifest is authoritative for newly detected endpoints, but
          // absence is not deletion: router/Tailscale restarts can make a node
          // temporarily publish only LAN/local. Keep any known-good HTTPS
          // endpoint and merge in the endpoint we actually reached.
          network.members[nodeId].endpoints = unionEndpoints(
            network.members[nodeId].endpoints || {},
            endpointHintsFromManifest(manifest),
            false,
          );
        }
        network.members[nodeId].label = manifest.node.label || network.members[nodeId].label;
        network.members[nodeId].hostname = manifest.node.hostname || network.members[nodeId].hostname;
        network.updatedAt = nowIso();
        writeNetwork(network);
      }
      return { nodeId, ok: true, endpoint, manifest };
    } catch (e) {
      errors.push(`${endpoint}: ${e && e.message ? e.message : String(e)}`);
    }
  }
  return { nodeId: member.nodeId || member.id || '', ok: false, errors };
}

async function fetchPeerJson(network, member, urlPath) {
  const endpoints = nodeEndpointCandidates(member);
  const errors: string[] = [];
  for (const endpoint of endpoints) {
    try {
      const r = await fetchPeerWithTimeout(`${endpoint}${urlPath}`, {
        method: 'GET',
        headers: { Accept: 'application/json', ...signedHeaders(network.id, 'GET', urlPath) },
      });
      const d: any = await r.json().catch(() => ({}));
      if (!r.ok || !d.success) throw new Error(d.error || `${r.status} ${r.statusText}`);
      return { ok: true, endpoint, data: d };
    } catch (e) {
      errors.push(`${endpoint}: ${e && e.message ? e.message : String(e)}`);
    }
  }
  return { ok: false, errors };
}

async function postPeerJson(network, member, urlPath, bodyObj) {
  const endpoints = nodeEndpointCandidates(member);
  const errors: string[] = [];
  const body = JSON.stringify(bodyObj || {});
  for (const endpoint of endpoints) {
    try {
      const r = await fetchPeerWithTimeout(`${endpoint}${urlPath}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...signedHeaders(network.id, 'POST', urlPath, body) },
        body,
      });
      const d: any = await r.json().catch(() => ({}));
      if (!r.ok || !d.success) throw new Error(d.error || `${r.status} ${r.statusText}`);
      return { ok: true, endpoint, data: d };
    } catch (e) {
      errors.push(`${endpoint}: ${e && e.message ? e.message : String(e)}`);
    }
  }
  return { ok: false, errors };
}


async function fetchPeerMembership(network, member) {
  const urlPath = `/v1/peer/networks/${encodeURIComponent(network.id)}/membership`;
  const result: any = await fetchPeerJson(network, member, urlPath);
  if (!result.ok || !result.data || !result.data.network) return result;
  return { ...result, network: result.data.network };
}

function adoptIncomingMembership(networkId, incoming: any = {}, reason = 'membership.pull') {
  if (!incoming || incoming.id !== networkId) return { adopted: false, reason: 'network mismatch' };
  if (!incoming.members || typeof incoming.members !== 'object') return { adopted: false, reason: 'missing members' };
  const self = getNodeIdentity();
  if (!incoming.members[self.id]) return { adopted: false, reason: 'self not included' };
  const existing = readNetwork(networkId);
  if (!existing || !existing.members || !existing.members[self.id]) return { adopted: false, reason: 'network not present' };
  const existingRev = Number(existing.revision || 0);
  const incomingRev = Number(incoming.revision || 0);
  // Always reconcile endpoints (union-merge, self stays authoritative). Only a
  // newer-or-equal incoming revision may change the member SET (adds/removes);
  // an older revision can still teach us better endpoints for members we share.
  const merged = mergeMembersAuthoritative(existing.members, incoming.members, self.id);
  let members: any;
  if (incomingRev >= existingRev) {
    members = merged;
  } else {
    members = { ...existing.members };
    for (const [nodeId, m] of Object.entries(merged)) {
      if (members[nodeId]) members[nodeId] = m;
    }
  }
  const normalizedMembers = normalizeNetworkMembers(members);
  const nextRevision = Math.max(existingRev, incomingRev) || 1;
  if (Number(existing.revision || 0) === nextRevision && sameJson(normalizeNetworkMembers(existing.members), normalizedMembers)) {
    return { adopted: false, reason: 'no change' };
  }
  const normalized = {
    schemaVersion: 1,
    id: String(incoming.id),
    name: String(incoming.name || existing.name || 'YHA Net'),
    createdAt: incoming.createdAt || existing.createdAt || nowIso(),
    createdBy: String(incoming.createdBy || existing.createdBy || ''),
    revision: nextRevision,
    updatedAt: nowIso(),
    updatedBy: String(incoming.updatedBy || existing.updatedBy || ''),
    members: normalizedMembers,
  };
  writeNetwork(normalized);
  appendNetEvent(normalized.id, 'membership.changed', { revision: normalized.revision, reason, updatedBy: normalized.updatedBy });
  return { adopted: true, network: publicNetwork(normalized) };
}

async function refreshMembershipFromPeers(networkId = '') {
  const self = getNodeIdentity();
  const networks = readNetworks().filter((n) => n && (!networkId || n.id === networkId) && n.members && n.members[self.id]);
  const results: any[] = [];
  for (const network of networks) {
    const members = Object.values(network.members || {}).filter((m: any) => m && m.nodeId && m.nodeId !== self.id);
    for (const member of members as any[]) {
      const result: any = await fetchPeerMembership(network, member);
      if (result.ok && result.network) {
        const adopted = adoptIncomingMembership(network.id, result.network, 'membership.pull');
        results.push({ networkId: network.id, nodeId: member.nodeId, ok: true, endpoint: result.endpoint, ...adopted });
        if (adopted.adopted) break;
      } else {
        results.push({ networkId: network.id, nodeId: member.nodeId, ok: false, errors: result.errors || ['membership pull failed'] });
      }
    }
  }
  return { results, networks: readNetworks() };
}

async function refreshPeerManifests(networkId) {
  const network = readNetwork(networkId);
  if (!network) throw new Error('Network not found.');
  const self = getNodeIdentity();
  if (!network.members || !network.members[self.id]) throw new Error('This node is not a member of that network.');
  hydrateNetworkEndpoints(network);
  const members = Object.values(network.members || {}).filter((m: any) => m && m.nodeId !== self.id);
  const results: any[] = [];
  for (const member of members) {
    results.push(await fetchPeerManifest(network, member));
  }
  return { results, manifests: listPeerManifests(network.id) };
}

async function probeMemberReachability(network, member, selfId) {
  const nodeId = String(member?.nodeId || member?.id || '');
  if (!nodeId) return { nodeId: '', online: false, endpoint: '', label: '' };
  if (nodeId === selfId) {
    return { nodeId, online: true, endpoint: 'self', label: member?.label || nodeId, kind: 'self' };
  }
  const endpoints = nodeEndpointCandidates(member);
  let online = false;
  let endpoint = '';
  for (const base of endpoints) {
    try {
      const r = await fetchPeerWithTimeout(`${base}/health`, { method: 'GET' }, PEER_PROBE_TIMEOUT_MS);
      if (r.ok) { online = true; endpoint = base; break; }
    } catch { /* try next endpoint */ }
  }
  return {
    nodeId,
    online,
    endpoint: endpoint || endpoints[0] || '',
    label: member?.label || member?.hostname || nodeId,
  };
}

async function probeNetworkMembers(networkId) {
  const network = readNetwork(networkId);
  if (!network) throw new Error('Network not found.');
  hydrateNetworkEndpoints(network);
  const self = getNodeIdentity();
  const members = Object.values(network.members || {}).filter(Boolean);
  const results: any[] = [];
  for (const member of members as any[]) {
    results.push(await probeMemberReachability(network, member, self.id));
  }
  return {
    networkId: network.id,
    networkName: network.name,
    total: results.length,
    online: results.filter((r) => r.online).length,
    members: results,
  };
}

async function probeAllNetworkMembers(networkId = '') {
  const networks = readNetworks().filter((n) => n && (!networkId || n.id === networkId));
  const byNetwork: Record<string, any> = {};
  for (const network of networks) {
    byNetwork[network.id] = await probeNetworkMembers(network.id);
  }
  return byNetwork;
}

function cachedPeerManifests(networkId) {
  const network = readNetwork(networkId);
  if (!network) throw new Error('Network not found.');
  return listPeerManifests(network.id);
}

async function postMembershipUpdateToNode(node, network, inviteSecret, request) {
  const endpoints = nodeEndpointCandidates(node);
  if (endpoints.length === 0) return { delivered: false, errors: ['requesting node did not advertise any endpoints'] };
  const payload = {
    inviteId: request.inviteId,
    inviteSecret,
    acceptedRequestId: request.id,
    network: publicNetwork(network),
    acceptedAt: request.acceptedAt,
  };
  const errors: string[] = [];
  for (const endpoint of endpoints) {
    try {
      const r = await fetchPeerWithTimeout(`${endpoint}/v1/peer/networks/${encodeURIComponent(network.id)}/membership-update`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const d: any = await r.json().catch(() => ({}));
      if (!r.ok || !d.success) throw new Error(d.error || `${r.status} ${r.statusText}`);
      return { delivered: true, endpoint, response: d };
    } catch (e) {
      errors.push(`${endpoint}: ${e && e.message ? e.message : String(e)}`);
    }
  }
  return { delivered: false, errors };
}


async function propagateMembershipToMembers(network, excludeNodeIds: any[] = []) {
  const self = getNodeIdentity();
  const exclude = new Set([self.id, ...excludeNodeIds.filter(Boolean)]);
  const members = Object.values(network.members || {}).filter((m: any) => m && m.nodeId && !exclude.has(m.nodeId));
  const payload = { network: publicNetwork(network), propagatedAt: nowIso(), propagatedBy: self.id };
  const results: any[] = [];
  for (const member of members as any[]) {
    const urlPath = `/v1/peer/networks/${encodeURIComponent(network.id)}/membership-update`;
    const result: any = await postPeerJson(network, member, urlPath, payload);
    results.push({ nodeId: member.nodeId, ...result });
  }
  return results;
}

async function propagateRevokeToNode(networkBeforeRemoval, removedMember, removedBy) {
  if (!removedMember) return { ok: false, errors: ['member missing'] };
  const payload = { networkId: networkBeforeRemoval.id, removedNodeId: removedMember.nodeId, removedBy, removedAt: nowIso(), finalRevision: Number(networkBeforeRemoval.revision || 1) + 1 };
  const urlPath = `/v1/peer/networks/${encodeURIComponent(networkBeforeRemoval.id)}/revoke`;
  return postPeerJson(networkBeforeRemoval, removedMember, urlPath, payload);
}

async function acceptJoinRequest(requestId) {
  const self = getNodeIdentity();
  const store = readJoinRequestStore();
  const idx = store.requests.findIndex((r) => r && r.id === requestId);
  if (idx < 0) throw new Error('Join request not found.');
  const request = store.requests[idx];
  if (request.status !== 'pending') throw new Error('Join request is not pending.');
  const network = readNetwork(request.networkId);
  if (!network) throw new Error('Network not found.');
  if (!network.members || !network.members[self.id]) throw new Error('This node is not a member of that network.');

  const ts = nowIso();
  network.members = network.members || {};
  const rn = request.requestingNode;
  network.members[rn.id] = {
    nodeId: rn.id,
    label: rn.label,
    hostname: rn.hostname,
    platform: rn.platform,
    publicKey: rn.publicKey,
    endpoints: normalizeEndpoints(rn.endpoints || {}),
    role: 'member',
    joinedAt: ts,
    addedBy: self.id,
  };
  network.revision = Number(network.revision || 1) + 1;
  network.updatedAt = ts;
  network.updatedBy = self.id;
  const inviteStore = readInviteStore();
  const invite = inviteStore.invites.find((i) => i && i.id === request.inviteId);
  const inviteSecret = invite && invite.inviteSecret ? String(invite.inviteSecret) : '';

  writeNetwork(network);
  appendNetEvent(network.id, 'membership.changed', { revision: network.revision, reason: 'join.accepted', nodeId: rn.id });

  request.status = 'accepted';
  request.updatedAt = ts;
  request.acceptedAt = ts;
  request.acceptedBy = self.id;
  store.requests[idx] = request;
  writeJoinRequestStore(store);

  if (invite) {
    invite.usedAt = ts;
    atomicWriteJson(INVITES_FILE, inviteStore, 0o600);
  }

  const propagation = await postMembershipUpdateToNode(rn, network, inviteSecret, request);
  const propagatedToMembers = await propagateMembershipToMembers(network, [rn.id]);
  return { request, network: publicNetwork(network), propagation, propagatedToMembers };
}

function rejectJoinRequest(requestId) {
  const self = getNodeIdentity();
  const store = readJoinRequestStore();
  const idx = store.requests.findIndex((r) => r && r.id === requestId);
  if (idx < 0) throw new Error('Join request not found.');
  const request = store.requests[idx];
  if (request.status !== 'pending') throw new Error('Join request is not pending.');
  const ts = nowIso();
  request.status = 'rejected';
  request.updatedAt = ts;
  request.rejectedAt = ts;
  request.rejectedBy = self.id;
  store.requests[idx] = request;
  writeJoinRequestStore(store);
  return request;
}

function sshHostFromEndpoints(endpoints: any = {}, node: any = {}) {
  try {
    for (const key of ['tailscaleHttps', 'tailscale', 'web', 'funnel']) {
      const raw = endpoints?.[key];
      if (!raw) continue;
      const u = new URL(String(raw));
      if (u.hostname) return u.hostname;
    }
  } catch { /* skip */ }
  return node?.hostname || null;
}

function manifest(networkId, endpoints: any = {}) {
  const network = readNetwork(networkId);
  if (!network) throw new Error('Network not found.');
  const netSync = require('./net-sync');
  const build = netSync.getBuildSnapshot();
  const node = publicNodeIdentity({ endpoints });
  const installPath = build.installPath || netSync.INSTALL_PATH;
  const sshHost = build.sshHost || sshHostFromEndpoints(endpoints, node);
  return {
    schemaVersion: 1,
    network: { id: network.id, name: network.name, revision: network.revision, updatedAt: network.updatedAt },
    node: {
      ...node,
      installPath,
      sshHost,
    },
    build: {
      version: build.version || null,
      commit: build.commit || null,
      branch: build.branch || null,
      describe: build.describe || null,
      dirty: !!build.dirty,
      isRepo: !!build.isRepo,
      installPath,
      sshHost,
      generatedAt: build.generatedAt || null,
    },
    updateStatus: build.updateStatus || null,
    updateSource: build.updateSource || null,
    offers: readOffers().offers.filter((o) => o && o.enabled !== false),
    generatedAt: nowIso(),
  };
}

function reconcileNetworksFromManifests(networkId = '') {
  const changed: string[] = [];
  const networks = readNetworks().filter((n) => n && (!networkId || n.id === networkId));
  for (const network of networks) {
    let networkChanged = false;
    for (const manifest of listPeerManifests(network.id)) {
      const nodeId = manifest?.node?.id;
      if (!nodeId || !network.members || !network.members[nodeId]) continue;
      const member = network.members[nodeId];
      if (manifest.node?.endpoints || manifest.fetchedFrom) {
        const next = unionEndpoints(member.endpoints || {}, endpointHintsFromManifest(manifest), false);
        if (!sameJson(member.endpoints || {}, next)) {
          member.endpoints = next;
          networkChanged = true;
        }
      }
    }
    const joins = readJoinRequestStore().requests || [];
    for (const req of joins) {
      if (!req || req.status !== 'accepted' || req.networkId !== network.id) continue;
      const nodeId = req.requestingNode?.id;
      if (!nodeId || !network.members || !network.members[nodeId]) continue;
      const next = unionEndpoints(network.members[nodeId].endpoints || {}, req.requestingNode.endpoints || {}, false);
      if (!sameJson(network.members[nodeId].endpoints || {}, next)) {
        network.members[nodeId].endpoints = next;
        networkChanged = true;
      }
    }
    if (networkChanged) {
      network.updatedAt = nowIso();
      writeNetwork(network);
      changed.push(network.id);
    }
  }
  return { changed };
}

function docsOffer() {
  const offers = readOffers();
  return (offers.offers || []).find((o) => o && o.id === 'offer_docs' && o.enabled !== false && o.capabilities && o.capabilities.read);
}

function resolveDocsPath(relPath) {
  const offer = docsOffer();
  if (!offer) throw new Error('Docs offer is not enabled.');
  const root = path.resolve(String(offer.root || PATHS.userDocsDir));
  const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const abs = path.resolve(root, rel);
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('Path escapes docs root.');
  return { root, abs, rel };
}

function listDocs(relPath = '') {
  const { abs, rel } = resolveDocsPath(relPath);
  let st;
  try { st = fs.statSync(abs); } catch { throw new Error('Docs path not found.'); }
  if (!st.isDirectory()) throw new Error('Docs path is not a directory.');
  const entries = fs.readdirSync(abs, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.'))
    .map((e) => {
      const p = path.join(abs, e.name);
      let s: any = null;
      try { s = fs.statSync(p); } catch { /* ignore */ }
      return {
        name: e.name,
        path: rel ? `${rel.replace(/\/+$/, '')}/${e.name}` : e.name,
        type: e.isDirectory() ? 'dir' : 'file',
        size: s ? s.size : 0,
        updatedAt: s ? s.mtime.toISOString() : null,
      };
    })
    .sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return { path: rel, entries };
}

function readDoc(relPath = '') {
  const { abs, rel } = resolveDocsPath(relPath);
  let st;
  try { st = fs.statSync(abs); } catch { throw new Error('Doc not found.'); }
  if (!st.isFile()) throw new Error('Doc path is not a file.');
  if (st.size > 1024 * 1024) throw new Error('Doc is too large for v1 remote read.');
  return {
    path: rel,
    size: st.size,
    updatedAt: st.mtime.toISOString(),
    content: fs.readFileSync(abs, 'utf8'),
  };
}

function publicModelData() {
  const providers = Array.isArray(state.config.providers) ? state.config.providers : [];
  return {
    schemaVersion: 1,
    generatedAt: nowIso(),
    providers: providers.map((p) => ({
      name: p.name,
      api_style: p.api_style,
      fetch_live: !!p.fetch_live,
      models: Object.fromEntries(Object.entries(p.models || {}).map(([name, m]: any) => [name, {
        model_id: m.model_id,
        type: m.type,
        context_length: m.context_length,
        supports_vision: m.supports_vision,
        supports_function_calling: m.supports_function_calling,
        supports_reasoning: m.supports_reasoning,
        supports_prompt_caching: m.supports_prompt_caching,
        supports_system_messages: m.supports_system_messages,
        userCategory: m.userCategory,
      }])),
    })),
  };
}

function publicPricingData() {
  const providers = Array.isArray(state.config.providers) ? state.config.providers : [];
  const rows: any[] = [];
  for (const p of providers) {
    for (const [name, m] of Object.entries(p.models || {}) as any) {
      const hasPrice = m.price_input !== undefined || m.price_output !== undefined || m.price_per_image !== undefined || m.price_per_second !== undefined;
      if (!hasPrice && m.context_length === undefined) continue;
      rows.push({
        provider: p.name,
        model: name,
        model_id: m.model_id,
        price_input: m.price_input,
        price_output: m.price_output,
        price_cache_read: m.price_cache_read,
        price_cache_write: m.price_cache_write,
        price_per_image: m.price_per_image,
        price_per_second: m.price_per_second,
        context_length: m.context_length,
      });
    }
  }
  return { schemaVersion: 1, generatedAt: nowIso(), pricing: rows };
}

const COSTS_FILE = path.join(__dirname, '..', 'costs.json');

function publicUsageSummary() {
  let raw: any = { allTime: { total: 0, byModel: {}, byProvider: {} }, daily: {} };
  try {
    if (fs.existsSync(COSTS_FILE)) raw = JSON.parse(fs.readFileSync(COSTS_FILE, 'utf8'));
  } catch { /* malformed → empty */ }
  // Share aggregate totals and per-model/provider rollups; daily detail is
  // limited to the last 30 days to cap payload size.
  const last30: Record<string, any> = {};
  for (let i = 0; i < 30; i++) {
    const d = new Date(Date.now() - i * 24 * 3600 * 1000).toISOString().slice(0, 10);
    if (raw.daily?.[d]) last30[d] = raw.daily[d];
  }
  return {
    schemaVersion: 1,
    generatedAt: nowIso(),
    allTime: raw.allTime || {},
    daily: last30,
  };
}

function ensureOfferCapability(kind, cap = 'read') {
  const offers = readOffers().offers || [];
  const offer = offers.find((o) => o && o.kind === kind && o.enabled !== false);
  if (!offer || !offer.capabilities || !offer.capabilities[cap]) throw new Error(`${kind} offer is not enabled.`);
  return offer;
}

async function syncPeerData(networkId, kind, nodeId = '') {
  const network = readNetwork(networkId);
  if (!network) throw new Error('Network not found.');
  const self = getNodeIdentity();
  if (!network.members || !network.members[self.id]) throw new Error('This node is not a member of that network.');
  const routeKind = kind === 'pricing' ? 'pricing' : 'model-data';
  const members = Object.values(network.members || {}).filter((m: any) => m && m.nodeId !== self.id && (!nodeId || m.nodeId === nodeId));
  const fetchResults: any[] = [];
  for (const member of members as any[]) {
    const urlPath = `/v1/peer/networks/${encodeURIComponent(network.id)}/${routeKind}`;
    const result: any = await fetchPeerJson(network, member, urlPath);
    const id = member.nodeId || member.id || '';
    if (result.ok) {
      const cached = { networkId: network.id, nodeId: id, kind: routeKind, fetchedAt: nowIso(), fetchedFrom: result.endpoint, data: result.data[routeKind === 'pricing' ? 'pricing' : 'modelData'] };
      atomicWriteJson(syncCacheFile(network.id, id, routeKind), cached, 0o600);
      fetchResults.push({ nodeId: id, ok: true, fetchedFrom: result.endpoint });
    } else {
      fetchResults.push({ nodeId: id, ok: false, errors: result.errors });
    }
  }
  // Auto-apply: merge peer data into local config right after fetching.
  const applied = await applySyncCache(networkId, routeKind, nodeId);
  return { kind: routeKind, fetchResults, applied: applied.applied, providersCreated: applied.providersCreated, changes: applied.changes };
}

async function readRemoteDocs(networkId, nodeId, relPath, mode) {
  const network = readNetwork(networkId);
  if (!network) throw new Error('Network not found.');
  const member = memberByNodeId(network, nodeId);
  if (!member) throw new Error('Peer is not a member of this network.');
  const urlPath = `/v1/peer/networks/${encodeURIComponent(network.id)}/docs/${mode}?path=${encodeURIComponent(String(relPath || ''))}`;
  const result: any = await fetchPeerJson(network, member, urlPath);
  if (!result.ok) throw new Error(result.errors.join(' · '));
  return { ...result.data, fetchedFrom: result.endpoint };
}

// ── Chat history sharing (offer: chat-history) ───────────────────────────────
// Sessions live in the sqlite sessions DB. Dedup is by session id (the PK), so
// importing the same conversation twice is a no-op; an import only replaces a
// local copy when the incoming one is strictly newer/longer.
function sessionsDb() {
  const db = require('../sessions-internal/db');
  if (!db.isOpen || !db.isOpen()) throw new Error('Session store is not open on this node.');
  return db;
}

function sessionSummary(s: any) {
  if (!s || typeof s !== 'object') return null;
  return {
    id: String(s.id || ''),
    name: s.name || null,
    createdAt: Number(s.createdAt) || 0,
    lastUsed: Number(s.lastUsed) || Number(s.createdAt) || 0,
    messageCount: Array.isArray(s.messages) ? s.messages.length : 0,
    workingDir: s.workingDir || null,
    importedFrom: s.importedFrom || null,
  };
}

function listLocalSessions() {
  const db = sessionsDb();
  const out: any[] = [];
  for (const s of db.loadAllSessions().values()) {
    const summary = sessionSummary(s);
    if (summary && summary.id) out.push(summary);
  }
  out.sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0));
  return out;
}

function exportLocalSession(sid: string) {
  const db = sessionsDb();
  const session = db.loadSession(String(sid || ''));
  if (!session) throw new Error('Session not found.');
  return session;
}

// Import policy: never overwrite an existing local session id. Only add sessions
// that are absent from the local sqlite DB. Peer list endpoints return
// summaries (messageCount, no messages[]) so duplicate checks must use id only.
function importSessionsLocally(sessions: any[], sourceNodeId = '') {
  const db = sessionsDb();
  const { emitSessionsDirty } = require('../sessions-internal/events');
  const local = db.loadAllSessions();
  const result = { imported: 0, updated: 0, duplicates: 0, skipped: 0, importedIds: [] as string[] };
  for (const incoming of Array.isArray(sessions) ? sessions : []) {
    if (!incoming || !incoming.id) { result.skipped += 1; continue; }
    const sid = String(incoming.id);
    const existing = local.get(sid);
    if (existing) {
      result.duplicates += 1;
      result.skipped += 1;
      continue;
    }
    const toWrite = {
      ...incoming,
      importedFrom: sourceNodeId || incoming.importedFrom || null,
      importedAt: nowIso(),
    };
    db.writeSessionFull(toWrite);
    local.set(sid, toWrite);
    result.imported += 1;
    result.importedIds.push(sid);
  }
  if (result.imported > 0) {
    emitSessionsDirty({ reason: 'net-import', count: result.imported, sourceNodeId: sourceNodeId || null });
  }
  return result;
}

async function readRemoteSessionList(networkId, nodeId) {
  const network = readNetwork(networkId);
  if (!network) throw new Error('Network not found.');
  const member = memberByNodeId(network, nodeId);
  if (!member) throw new Error('Peer is not a member of this network.');
  const urlPath = `/v1/peer/networks/${encodeURIComponent(network.id)}/sessions`;
  const result: any = await fetchPeerJson(network, member, urlPath);
  if (!result.ok) throw new Error(result.errors.join(' · '));
  return { sessions: result.data.sessions || [], fetchedFrom: result.endpoint };
}

async function importSessionsFromPeer(networkId, nodeId, sessionIds: string[] | null = null) {
  const db = sessionsDb();
  const network = readNetwork(networkId);
  if (!network) throw new Error('Network not found.');
  const member = memberByNodeId(network, nodeId);
  if (!member) throw new Error('Peer is not a member of this network.');
  const list = await readRemoteSessionList(networkId, nodeId);
  const wanted = new Set((sessionIds || []).map(String));
  const local = db.loadAllSessions();
  // Only pull the full transcript for sessions we'd actually import — this
  // avoids transferring conversations the local node already has in full.
  const candidates = (list.sessions as any[]).filter((s) => {
    if (!s || !s.id) return false;
    if (wanted.size && !wanted.has(String(s.id))) return false;
    return !local.has(String(s.id));
  });
  const fetched: any[] = [];
  const errors: any[] = [];
  for (const summary of candidates) {
    const urlPath = `/v1/peer/networks/${encodeURIComponent(network.id)}/sessions/${encodeURIComponent(String(summary.id))}`;
    const result: any = await fetchPeerJson(network, member, urlPath);
    if (result.ok && result.data && result.data.session) fetched.push(result.data.session);
    else errors.push({ id: summary.id, errors: result.errors || ['fetch failed'] });
  }
  const imported = importSessionsLocally(fetched, nodeId);
  appendNetEvent(network.id, 'sessions.imported', { sourceNodeId: nodeId, ...imported });
  return { ...imported, available: list.sessions.length, candidates: candidates.length, errors, fetchedFrom: list.fetchedFrom };
}

// ── Smart docs sync (offer: docs) ────────────────────────────────────────────
// Pull a peer's shared Docs folder into the local one over the same signed
// HTTPS transport the rest of YHA Net uses (no rsync/SSH dependency, so it
// works on every platform combo). "Smart" = only files that are new or newer
// on the peer are fetched; unchanged files are skipped by size + mtime.
async function collectRemoteDocFiles(networkId, nodeId, relPath, acc: any[], limit: number) {
  if (acc.length >= limit) return acc;
  const listing = await readRemoteDocs(networkId, nodeId, relPath, 'list');
  for (const e of listing.entries || []) {
    if (acc.length >= limit) break;
    if (e && e.type === 'dir') await collectRemoteDocFiles(networkId, nodeId, e.path, acc, limit);
    else if (e && e.type === 'file') acc.push(e);
  }
  return acc;
}

async function syncDocsFromPeer(networkId, nodeId) {
  const network = readNetwork(networkId);
  if (!network) throw new Error('Network not found.');
  const member = memberByNodeId(network, nodeId);
  if (!member) throw new Error('Peer is not a member of this network.');
  const off = docsOffer();
  const localRoot = path.resolve(String((off && off.root) || PATHS.userDocsDir));
  fs.mkdirSync(localRoot, { recursive: true });
  const files = await collectRemoteDocFiles(networkId, nodeId, '', [], 2000);
  const result: any = { total: files.length, synced: 0, upToDate: 0, skipped: 0, errors: [] as any[] };
  for (const f of files) {
    const abs = path.resolve(localRoot, String(f.path || '').replace(/\\/g, '/'));
    if (abs !== localRoot && !abs.startsWith(localRoot + path.sep)) { result.skipped += 1; continue; }
    let need = true;
    try {
      const st = fs.statSync(abs);
      const remoteMtime = f.updatedAt ? Date.parse(f.updatedAt) : 0;
      if (st.size === Number(f.size) && remoteMtime && st.mtimeMs >= remoteMtime) need = false;
    } catch { /* missing locally — fetch it */ }
    if (!need) { result.upToDate += 1; continue; }
    if (Number(f.size) > 1024 * 1024) {
      result.skipped += 1;
      result.errors.push({ path: f.path, error: 'file too large for v1 sync (>1MB)' });
      continue;
    }
    try {
      const doc: any = await readRemoteDocs(networkId, nodeId, f.path, 'read');
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, String(doc.content || ''), 'utf8');
      if (f.updatedAt) { const t = new Date(f.updatedAt); try { fs.utimesSync(abs, t, t); } catch { /* mtime best-effort */ } }
      result.synced += 1;
    } catch (e) {
      result.errors.push({ path: f.path, error: e && e.message ? e.message : String(e) });
    }
  }
  appendNetEvent(network.id, 'docs.synced', { sourceNodeId: nodeId, synced: result.synced, upToDate: result.upToDate, skipped: result.skipped });
  return result;
}

function receiveMembershipUpdate(networkId, body: any = {}, verified: any = null) {
  const incoming = body.network || {};
  if (!incoming || incoming.id !== networkId) throw new Error('Membership update network mismatch.');
  if (!incoming.members || typeof incoming.members !== 'object') throw new Error('Membership update is missing members.');
  const self = getNodeIdentity();
  if (!incoming.members[self.id]) throw new Error('This node is not included in the membership update.');

  const existing = readNetwork(networkId);
  const hasExisting = !!(existing && existing.members && existing.members[self.id]);
  if (hasExisting) {
    if (!verified || !verified.ok) throw new Error('Signed peer membership update is required for existing networks.');
  } else {
    const inviteId = String(body.inviteId || '');
    const inviteSecret = String(body.inviteSecret || '');
    const store = readOutgoingJoinStore();
    const idx = store.joins.findIndex((j) =>
      j && j.networkId === networkId && j.inviteId === inviteId && j.inviteSecret === inviteSecret && j.status === 'pending'
    );
    if (idx < 0) throw new Error('No pending outgoing join matches this membership update.');
    store.joins[idx].status = 'accepted';
    store.joins[idx].updatedAt = nowIso();
    store.joins[idx].acceptedAt = body.acceptedAt || nowIso();
    writeOutgoingJoinStore(store);
  }

  const existingRev = Number(existing && existing.revision || 0);
  const incomingRev = Number(incoming.revision || 0);
  let members: any;
  if (hasExisting) {
    // Union-merge endpoints (self stays authoritative); only a newer-or-equal
    // revision may change the member set.
    const merged = mergeMembersAuthoritative(existing.members, incoming.members, self.id);
    if (incomingRev >= existingRev) {
      members = merged;
    } else {
      members = { ...existing.members };
      for (const [nodeId, m] of Object.entries(merged)) {
        if (members[nodeId]) members[nodeId] = m;
      }
    }
  } else {
    members = incoming.members;
  }
  const normalizedMembers = normalizeNetworkMembers(members);
  const nextRevision = Math.max(existingRev, incomingRev) || 1;
  if (hasExisting && existingRev === nextRevision && sameJson(normalizeNetworkMembers(existing.members), normalizedMembers)) {
    return { network: publicNetwork(existing), ignored: true, reason: 'no change' };
  }
  const normalized = {
    schemaVersion: 1,
    id: String(incoming.id),
    name: String(incoming.name || (existing && existing.name) || 'YHA Net'),
    createdAt: incoming.createdAt || (existing && existing.createdAt) || nowIso(),
    createdBy: String(incoming.createdBy || (existing && existing.createdBy) || ''),
    revision: nextRevision,
    updatedAt: nowIso(),
    updatedBy: String(incoming.updatedBy || ''),
    members: normalizedMembers,
  };
  writeNetwork(normalized);
  appendNetEvent(normalized.id, 'membership.changed', { revision: normalized.revision, reason: 'membership.update', updatedBy: normalized.updatedBy });
  ensureDefaultOffers();
  return { network: publicNetwork(normalized), ignored: false };
}


async function removeNetworkMember(networkId, nodeId) {
  const self = getNodeIdentity();
  const network = readNetwork(networkId);
  if (!network) throw new Error('Network not found.');
  const selfMember = memberByNodeId(network, self.id);
  if (!selfMember) throw new Error('This node is not a member of that network.');
  if (selfMember.role !== 'owner' && network.createdBy !== self.id) throw new Error('Only the network owner can remove members in v1.');
  if (nodeId === self.id) throw new Error('Use leave network for this node.');
  const removed = memberByNodeId(network, nodeId);
  if (!removed) throw new Error('Member not found.');
  const before = JSON.parse(JSON.stringify(network));
  delete network.members[nodeId];
  network.revision = Number(network.revision || 1) + 1;
  network.updatedAt = nowIso();
  network.updatedBy = self.id;
  writeNetwork(network);
  appendNetEvent(network.id, 'membership.changed', { revision: network.revision, reason: 'member.removed', nodeId });
  const revoked = await propagateRevokeToNode(before, removed, self.id);
  const propagatedToMembers = await propagateMembershipToMembers(network, []);
  return { network: publicNetwork(network), removed: nodeId, revoked, propagatedToMembers };
}

async function leaveNetwork(networkId) {
  const self = getNodeIdentity();
  const network = readNetwork(networkId);
  if (!network) throw new Error('Network not found.');
  if (!network.members || !network.members[self.id]) throw new Error('This node is not a member of that network.');
  const selfMember = network.members[self.id];
  if ((selfMember.role === 'owner' || network.createdBy === self.id) && Object.keys(network.members || {}).length > 1) {
    throw new Error('Owner nodes must remove other members before leaving in v1.');
  }
  delete network.members[self.id];
  network.revision = Number(network.revision || 1) + 1;
  network.updatedAt = nowIso();
  network.updatedBy = self.id;
  const remaining = Object.values(network.members || {});
  const propagatedToMembers: any[] = [];
  for (const member of remaining as any[]) {
    const urlPath = `/v1/peer/networks/${encodeURIComponent(network.id)}/membership-update`;
    const result: any = await postPeerJson({ ...network, members: { ...(network.members || {}), [self.id]: memberByNodeId(readNetwork(networkId), self.id) } }, member, urlPath, { network: publicNetwork(network), propagatedAt: nowIso(), propagatedBy: self.id });
    propagatedToMembers.push({ nodeId: member.nodeId, ...result });
  }
  try { fs.unlinkSync(networkFile(network.id)); } catch (_) {}
  appendNetEvent(network.id, 'membership.changed', { revision: network.revision, reason: 'network.left', nodeId: self.id });
  return { left: true, networkId: network.id, propagatedToMembers };
}

function receiveRevoke(networkId, body: any = {}, verified: any = null) {
  if (!verified || !verified.ok) throw new Error('Signed peer revoke is required.');
  const self = getNodeIdentity();
  const removedNodeId = String(body.removedNodeId || '');
  if (removedNodeId !== self.id) throw new Error('Revoke is not for this node.');
  const existing = readNetwork(networkId);
  if (!existing || !existing.members || !existing.members[self.id]) return { ignored: true, reason: 'network not present' };
  try { fs.unlinkSync(networkFile(networkId)); } catch (_) {}
  appendNetEvent(networkId, 'membership.changed', { reason: 'network.revoked', nodeId: self.id, removedBy: body.removedBy || verified.member.nodeId });
  return { revoked: true, networkId };
}

function listSyncCache(networkId) {
  const dir = path.join(SYNC_CACHE_DIR, String(networkId || ''));
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch (_) { files = []; }
  return files.map((f) => readJson(path.join(dir, f), null)).filter(Boolean).sort((a, b) => String(b.fetchedAt || '').localeCompare(String(a.fetchedAt || '')));
}

function previewSyncCache(networkId, kind, nodeId = '') {
  const routeKind = kind === 'pricing' ? 'pricing' : 'model-data';
  const caches = listSyncCache(networkId).filter((c) => c && c.kind === routeKind && (!nodeId || c.nodeId === nodeId));
  const providers = Array.isArray(state.config.providers) ? state.config.providers : [];
  const changes: any[] = [];
  for (const cache of caches) {
    if (routeKind === 'pricing') {
      for (const row of (cache.data && cache.data.pricing) || []) {
        const provider = providers.find((p) => p.name === row.provider);
        const model = provider && provider.models ? provider.models[row.model] : null;
        const fields = ['price_input', 'price_output', 'price_cache_read', 'price_cache_write', 'price_per_image', 'price_per_second', 'context_length'];
        const diff = {};
        for (const field of fields) if (row[field] !== undefined && (!model || model[field] !== row[field])) diff[field] = { from: model ? model[field] : undefined, to: row[field] };
        if (Object.keys(diff).length) changes.push({ nodeId: cache.nodeId, provider: row.provider, model: row.model, exists: !!model, diff });
      }
    } else {
      for (const providerRow of (cache.data && cache.data.providers) || []) {
        const provider = providers.find((p) => p.name === providerRow.name);
        for (const [modelName, remoteModel] of Object.entries(providerRow.models || {}) as any) {
          const model = provider && provider.models ? provider.models[modelName] : null;
          const fields = ['model_id', 'type', 'context_length', 'supports_vision', 'supports_function_calling', 'supports_reasoning', 'supports_prompt_caching', 'supports_system_messages', 'userCategory'];
          const diff = {};
          for (const field of fields) if (remoteModel[field] !== undefined && (!model || model[field] !== remoteModel[field])) diff[field] = { from: model ? model[field] : undefined, to: remoteModel[field] };
          if (Object.keys(diff).length) changes.push({ nodeId: cache.nodeId, provider: providerRow.name, model: modelName, exists: !!model, diff });
        }
      }
    }
  }
  return { kind: routeKind, caches, changes };
}

// Build a provider-name → full provider-row map from cached model-data so that
// applySyncCache (pricing path) can create missing providers with proper api_style.
function cachedModelDataProviderMap(networkId, filterNodeId = '') {
  const caches = listSyncCache(networkId).filter((c) => c && c.kind === 'model-data' && (!filterNodeId || c.nodeId === filterNodeId));
  const map: Record<string, any> = {};
  for (const cache of caches) {
    for (const prow of (cache.data && cache.data.providers) || []) {
      if (!prow || !prow.name) continue;
      if (!map[prow.name]) map[prow.name] = prow;
    }
  }
  return map;
}

async function applySyncCache(networkId, kind, nodeId = '') {
  const preview = previewSyncCache(networkId, kind, nodeId);
  const routeKind = preview.kind;
  let applied = 0;
  let providersCreated = 0;
  state.config.providers = Array.isArray(state.config.providers) ? state.config.providers : [];
  // For pricing, we can reconstruct missing providers from the model-data cache.
  const mdProviderMap = routeKind === 'pricing' ? cachedModelDataProviderMap(networkId, nodeId) : {};
  for (const change of preview.changes) {
    let provider = state.config.providers.find((p) => p.name === change.provider);
    if (!provider) {
      if (routeKind === 'model-data') {
        // The model-data cache contains api_style / fetch_live — use them.
        const caches = listSyncCache(networkId).filter((c) => c && c.kind === 'model-data' && (!nodeId || c.nodeId === nodeId));
        let apiStyle: string | null = null;
        let fetchLive = false;
        for (const cache of caches) {
          const prow = (cache.data && cache.data.providers || []).find((p) => p.name === change.provider);
          if (prow) { apiStyle = prow.api_style || null; fetchLive = !!prow.fetch_live; break; }
        }
        provider = { name: change.provider, ...(apiStyle ? { api_style: apiStyle } : {}), fetch_live: fetchLive, models: {} };
        state.config.providers.push(provider);
        providersCreated += 1;
      } else if (routeKind === 'pricing') {
        // Use cached model-data for this provider if available; otherwise create minimal.
        const mdRow = mdProviderMap[change.provider];
        provider = {
          name: change.provider,
          ...(mdRow && mdRow.api_style ? { api_style: mdRow.api_style } : {}),
          fetch_live: !!(mdRow && mdRow.fetch_live),
          models: {},
        };
        state.config.providers.push(provider);
        providersCreated += 1;
      } else {
        continue;
      }
    }
    provider.models = provider.models || {};
    let model = provider.models[change.model];
    if (!model) { model = {}; provider.models[change.model] = model; }
    for (const [field, d] of Object.entries(change.diff) as any) if (d.to !== undefined) model[field] = d.to;
    applied += 1;
  }
  if ((applied > 0 || providersCreated > 0) && state.saveConfig) await state.saveConfig();
  appendNetEvent(networkId, routeKind === 'pricing' ? 'pricing.changed' : 'models.changed', { applied, providersCreated, sourceNodeId: nodeId || null });
  return { ...preview, applied, providersCreated };
}

module.exports = {
  NETWORKS_DIR,
  OFFERS_FILE,
  INVITES_FILE,
  JOIN_REQUESTS_FILE,
  OUTGOING_JOINS_FILE,
  PEER_MANIFESTS_DIR,
  SYNC_CACHE_DIR,
  NONCES_FILE,
  EVENTS_DIR,
  readNetworks,
  readNetwork,
  normalizeEndpoints,
  hydrateAllNetworkEndpoints,
  reconcileNetworksFromManifests,
  updateSelfEndpointsInNetworks,
  propagateMembershipToMembers,
  refreshMembershipFromPeers,
  probeNetworkMembers,
  probeAllNetworkMembers,
  createNetwork,
  readOffers,
  writeOffers,
  cachedPeerManifests,
  refreshPeerManifests,
  createInvite,
  decodeInviteToken,
  requestJoin,
  receiveJoinRequest,
  listJoinRequests,
  acceptJoinRequest,
  rejectJoinRequest,
  receiveMembershipUpdate,
  manifest,
  listDocs,
  readDoc,
  verifyPeerRequest,
  publicModelData,
  publicPricingData,
  publicUsageSummary,
  ensureOfferCapability,
  syncPeerData,
  readRemoteDocs,
  listLocalSessions,
  exportLocalSession,
  readRemoteSessionList,
  importSessionsFromPeer,
  syncDocsFromPeer,
  subscribeNetworkEvents,
  recentNetworkEvents,
  removeNetworkMember,
  leaveNetwork,
  receiveRevoke,
  listSyncCache,
  previewSyncCache,
  applySyncCache,
};
