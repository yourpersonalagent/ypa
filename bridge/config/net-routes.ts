// ── YHA Net node-identity + cross-node proxy routes (Phase 1+2) ─────────────
// GET /v1/net/self — reports THIS node's addressable identities so the
// "YHA Net" prefs tab can auto-populate the current-node entry. One logical
// node, several ways to reach it:
//   - hostname      : OS computer name (os.hostname())            "real name"
//   - tailscaleHost : this box's MagicDNS name, bare host         (if on a tailnet)
//   - tailscaleUrl  : https:// form of the MagicDNS name
//   - funnelUrl     : public Funnel/serve URL pointing at this bridge (if any)
//   - port          : bridge listen port
//   - platform      : process.platform (win32 / linux / darwin)
//
// Tailscale detection is reused from core/tui-link.ts (cached probes) so node
// identity matches the TUI-link approval URL's source of truth exactly.
// Registered via registerConfigRoutes (handler.ts) AFTER authMiddleware, so it
// inherits the same WorkOS gating as every other /v1/ route. The net-proxy
// routes (/v1/net/nodes/:id/*) are also post-auth; they work for peers because
// auth.ts now recognises net bearers (via verifyNetBearer) and mints a synthetic
// allowed user for them.
'use strict';

const os = require('os');
const fs = require('fs');
const { createProxyMiddleware } = require('http-proxy-middleware');
const { detectTailscaleMagicDNS, detectTailscalePublicURL } = require('../core/tui-link');
const { PORT: BRIDGE_PORT } = require('../core/state');
const { publicNodeIdentity } = require('../core/net-identity');
const netModel = require('../core/net-model');
const netSync = require('../core/net-sync');

// In go-mode the bridge process listens on loopback :8442, while the public
// address peers can actually reach is YHA-Core on :8443. The launchers don't
// currently export a public-port env, so keep the conventional default here and
// still allow overrides for unusual deployments.
function publicPort() {
  const explicit = Number.parseInt(process.env.YHA_PUBLIC_PORT || process.env.PUBLIC_PORT || '', 10);
  if (Number.isFinite(explicit) && explicit > 0) return explicit;
  return process.env.YHA_BACKEND === 'go' ? 8443 : BRIDGE_PORT;
}

function appendPort(origin, port) {
  if (!origin) return '';
  try {
    const u = new URL(origin);
    if (!u.port && port && u.protocol !== 'https:') u.port = String(port);
    return u.toString().replace(/\/$/, '');
  } catch (_) {
    return origin;
  }
}

// Per-user prefs (see core/paths + config/prefs-routes). We read the yhaNetNodes
// list here (server side) to resolve peer reachability + tokens for proxying.

const NET_ROUTE_SYNC_TIMEOUT_MS = Number.parseInt(process.env.YHA_NET_ROUTE_SYNC_TIMEOUT_MS || '9000', 10);

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ __timedOut: true, label }), Math.max(100, Number(ms || 0)));
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const PREFS_PATH = require('../core/paths').prefs;

function readPrefsSync() {
  try {
    return JSON.parse(fs.readFileSync(PREFS_PATH, 'utf8'));
  } catch (_) {
    return {};
  }
}

// SSRF guard for proxy targets. The proxy injects this node's bearer token and
// forwards to whatever host a node entry resolves to, so a node whose endpoint
// was set (via PATCH /v1/prefs or a poisoned membership) to a loopback or
// link-local address would turn the proxy into an SSRF primitive against
// 127.0.0.1 internal routes or the 169.254.169.254 cloud-metadata service.
// We reject those literal host forms. LAN (192.168/10.x) and Tailscale
// (100.64/10) hosts are legitimate peer endpoints and are left reachable —
// blocking them would break cross-node files/sessions entirely. Hostnames that
// aren't IP literals (MagicDNS names, mDNS .local) are allowed; resolving them
// here would require async DNS and would block legitimate tailnet names.
function isUnsafeProxyHost(host) {
  const h = String(host || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  // IPv4 loopback (127.0.0.0/8), unspecified, and link-local/metadata.
  if (/^127\./.test(h)) return true;
  if (h === '0.0.0.0') return true;
  if (/^169\.254\./.test(h)) return true;
  // IPv6 loopback / unspecified / IPv4-mapped loopback / link-local (fe80::).
  if (h === '::1' || h === '::' || h === '::ffff:127.0.0.1') return true;
  if (/^::ffff:127\./.test(h)) return true;
  if (/^fe80:/.test(h)) return true;
  return false;
}

function isSafeProxyTarget(url) {
  if (!url) return false;
  try {
    return !isUnsafeProxyHost(new URL(url).hostname);
  } catch (_) {
    return false;
  }
}

// Resolve the best-effort origin to reach a registered node (honours its
// preferredMode, falls back like the FE TabNodes.resolveUrl). No port — the
// values from detect* are already the front-door origins (go-core :8443 or
// funnel 443) that terminate TLS and forward to the local bridge.
function resolveTargetUrl(n) {
  if (!n) return null;
  const port = n.port || publicPort();
  const lan = n.computerName ? `http://${n.computerName}:${port}` : '';
  // Direct MagicDNS reachability is the public YHA HTTP front door on :8443.
  // If the node has Tailscale Serve/Funnel at 443, that URL belongs in
  // webserviceUrl and is preferred/fallback below.
  const ts = n.tailscaleName ? `http://${n.tailscaleName}:${port}` : '';
  const web = (n.webserviceUrl || '').trim();
  const mode = n.preferredMode || 'tailscale';
  const order = {
    lan: [lan, ts, web],
    tailscale: [ts, web, lan],
    webservice: [web, ts, lan],
  }[mode] || [ts, web, lan];
  for (const u of order) if (u && isSafeProxyTarget(u)) return u;
  return null;
}

function lookupNode(id) {
  const p = readPrefsSync();
  const nodes = Array.isArray(p.yhaNetNodes) ? p.yhaNetNodes : [];
  return nodes.find((n) => n && n.id === id) || null;
}

// The proxy is created once. router() + pathRewrite + onProxyReq let us do
// per-node target + token injection + path cleanup dynamically.
let _netProxy = null;
function getNetProxy() {
  if (_netProxy) return _netProxy;
  _netProxy = createProxyMiddleware({
    changeOrigin: true,
    ws: false,
    logger: undefined,
    secure: false, // tailscale certs are normally valid; tolerate edge cases
    router: (req) => {
      // Support both mounted-param and raw url forms.
      let nodeId = (req.params && req.params.nodeId) || null;
      if (!nodeId) {
        const m = (req.url || '').match(/^\/v1\/net\/nodes\/([^/]+)/);
        if (m) nodeId = m[1];
      }
      if (!nodeId) return null;
      const node = lookupNode(nodeId);
      return resolveTargetUrl(node);
    },
    pathRewrite: (path, req) => {
      // Turn /v1/net/nodes/n_xxx/anything  -> /anything  (so upstream sees its own /v1/files etc)
      const m = (path || '').match(/^\/v1\/net\/nodes\/([^/]+)(.*)$/);
      if (m) {
        const rest = m[2] || '/';
        return rest.startsWith('/') ? rest : '/' + rest;
      }
      return path;
    },
    onProxyReq: (proxyReq, req, _res) => {
      let nodeId = (req.params && req.params.nodeId) || null;
      if (!nodeId) {
        const m = (req.url || '').match(/^\/v1\/net\/nodes\/([^/]+)/);
        if (m) nodeId = m[1];
      }
      if (!nodeId) return;
      const node = lookupNode(nodeId);
      if (node && node.token) {
        proxyReq.setHeader('authorization', 'Bearer ' + node.token);
      }
      proxyReq.removeHeader('host');
    },
    onError: (err, _req, res) => {
      // eslint-disable-next-line no-console
      console.warn('[net-proxy] proxy error:', err && err.message);
      if (res && !res.headersSent) {
        try { res.status(502).json({ success: false, error: 'net proxy failed: ' + (err && err.message) }); } catch (_) {}
      }
    },
  });
  return _netProxy;
}

function registerNetRoutes(app) {
  function requirePeerSignature(req) {
    const v = netModel.verifyPeerRequest(req);
    if (!v || !v.ok) {
      const err: any = new Error(v && v.error ? v.error : 'Invalid YHA peer signature.');
      err.statusCode = 401;
      throw err;
    }
    return v;
  }

  function detectedEndpoints() {
    let hostname = '';
    try { hostname = os.hostname() || ''; } catch (_) { /* hostname unavailable */ }
    const tailscaleUrl = detectTailscaleMagicDNS() || '';
    const funnelUrl = detectTailscalePublicURL() || '';
    const tailscaleHost = tailscaleUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '');
    const port = publicPort();
    const tailscaleHttpUrl = tailscaleHost ? `http://${tailscaleHost}:${port}` : '';
    return {
      hostname,
      tailscaleHost,
      // Browser-facing Tailscale Serve/MagicDNS URL. Keep https://... as-is;
      // don't rewrite it to http://...:8443.
      tailscaleUrl,
      tailscaleHttpUrl,
      funnelUrl: appendPort(funnelUrl, port),
      port,
      platform: process.platform,
      endpoints: {
        local: `http://localhost:${port}`,
        lan: hostname ? `http://${hostname}:${port}` : '',
        // Browser-facing MagicDNS/Serve URL. Keep a dedicated alias so newer
        // clients can prefer HTTPS even if older memberships also contain
        // tailscaleHttp for peer/direct fallback.
        tailscaleHttps: tailscaleUrl,
        tailscale: tailscaleUrl,
        tailscaleHttp: tailscaleHttpUrl,
        web: appendPort(funnelUrl, port),
      },
    };
  }

  app.get('/v1/net/self', (_req, res) => {
    const detected = detectedEndpoints();
    const identity = publicNodeIdentity({ endpoints: detected.endpoints });
    res.json({
      success: true,
      self: {
        ...detected,
        identity,
        // Convenience aliases for the prefs-backed YHA Net UI that existed
        // before durable net identity landed.
        nodeId: identity.id,
        label: identity.label,
        publicKey: identity.publicKey,
      },
    });
  });

  app.post('/v1/net/create', (req, res) => {
    try {
      const network = netModel.createNetwork({ ...(req.body || {}), endpoints: detectedEndpoints().endpoints });
      res.json({ success: true, network });
    } catch (e) {
      res.status(e && e.statusCode ? e.statusCode : 400).json({ success: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.get('/v1/net/networks', async (req, res) => {
    const warnings: any[] = [];
    try {
      const detected = detectedEndpoints();
      const snap = netSync.getBuildSnapshot();
      if (String(req.query.sync || '') === '1' || !snap.generatedAt) {
        const r: any = await withTimeout(netSync.refreshBuildSnapshot(detected), NET_ROUTE_SYNC_TIMEOUT_MS, 'build snapshot refresh timed out');
        if (r && r.__timedOut) warnings.push(r.label);
      }
      try {
        netModel.updateSelfEndpointsInNetworks(detected.endpoints);
        netModel.hydrateAllNetworkEndpoints();
        netModel.reconcileNetworksFromManifests();
      } catch (e) {
        warnings.push(`local reconciliation failed: ${e && e.message ? e.message : String(e)}`);
      }
      if (String(req.query.sync || '') === '1') {
        const syncTask = (async () => {
          // Push our own (authoritative) entry to every reachable peer before
          // pulling — this is the only way peers that hold a stale/unreachable
          // endpoint for us ever learn the correct one, since they can't reach us
          // to pull our manifest. Idempotent: peers ignore a no-change update.
          for (const network of netModel.readNetworks()) {
            try {
              await netModel.propagateMembershipToMembers(network, []);
            } catch { /* peer unreachable — pull below still runs */ }
          }
          await netModel.refreshMembershipFromPeers('');
          netModel.hydrateAllNetworkEndpoints();
          netModel.reconcileNetworksFromManifests();
        })();
        const r: any = await withTimeout(syncTask, NET_ROUTE_SYNC_TIMEOUT_MS, 'membership sync timed out; showing cached network');
        if (r && r.__timedOut) warnings.push(r.label);
      } else {
        // Best-effort anti-entropy: if another existing member accepted a node
        // while this node was not watching, pull the latest signed-network
        // membership from known peers in the background. Never block the UI on it.
        setTimeout(() => { netModel.refreshMembershipFromPeers('').catch(() => {}); }, 1);
      }
      const networks = netModel.readNetworks();
      const out: any = { success: true, networks, build: netSync.getBuildSnapshot() };
      if (String(req.query.probe || '') === '1') {
        const r: any = await withTimeout(netModel.probeAllNetworkMembers(''), NET_ROUTE_SYNC_TIMEOUT_MS, 'reachability probe timed out; showing cached network');
        if (r && r.__timedOut) {
          warnings.push(r.label);
          out.reachability = {};
        } else {
          out.reachability = r;
        }
      }
      if (warnings.length) out.warnings = warnings;
      res.json(out);
    } catch (e) {
      // Router restarts / DNS outages must not make the network disappear from
      // the switcher. Return durable membership even when live sync/probe fails.
      try {
        const out: any = { success: true, networks: netModel.readNetworks(), build: netSync.getBuildSnapshot(), warnings: [e && e.message ? e.message : String(e)] };
        res.json(out);
      } catch (fallbackErr) {
        res.status(400).json({ success: false, error: fallbackErr && fallbackErr.message ? fallbackErr.message : String(fallbackErr) });
      }
    }
  });

  app.get('/v1/net/networks/:networkId', (req, res) => {
    const network = netModel.readNetwork(req.params.networkId);
    if (!network) return res.status(404).json({ success: false, error: 'Network not found.' });
    res.json({ success: true, network });
  });


  app.delete('/v1/net/networks/:networkId/members/:nodeId', async (req, res) => {
    try {
      const result = await netModel.removeNetworkMember(req.params.networkId, req.params.nodeId);
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(e && e.statusCode ? e.statusCode : 400).json({ success: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.post('/v1/net/networks/:networkId/leave', async (req, res) => {
    try {
      const result = await netModel.leaveNetwork(req.params.networkId);
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(e && e.statusCode ? e.statusCode : 400).json({ success: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.get('/v1/net/networks/:networkId/manifests', (req, res) => {
    try {
      const manifests = netModel.cachedPeerManifests(req.params.networkId);
      res.json({ success: true, manifests });
    } catch (e) {
      res.status(404).json({ success: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.get('/v1/net/networks/:networkId/peers/:nodeId/docs/list', async (req, res) => {
    try {
      const out = await netModel.readRemoteDocs(req.params.networkId, req.params.nodeId, req.query.path || '', 'list');
      res.json({ success: true, ...out });
    } catch (e) {
      res.status(e && e.statusCode ? e.statusCode : 400).json({ success: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.get('/v1/net/networks/:networkId/peers/:nodeId/docs/read', async (req, res) => {
    try {
      const out = await netModel.readRemoteDocs(req.params.networkId, req.params.nodeId, req.query.path || '', 'read');
      res.json({ success: true, ...out });
    } catch (e) {
      res.status(e && e.statusCode ? e.statusCode : 400).json({ success: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.get('/v1/net/networks/:networkId/peers/:nodeId/sessions/list', async (req, res) => {
    try {
      const out = await netModel.readRemoteSessionList(req.params.networkId, req.params.nodeId);
      res.json({ success: true, ...out });
    } catch (e) {
      res.status(e && e.statusCode ? e.statusCode : 400).json({ success: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.post('/v1/net/networks/:networkId/peers/:nodeId/sessions/import', async (req, res) => {
    try {
      const ids = Array.isArray((req.body || {}).sessionIds) ? (req.body || {}).sessionIds : null;
      const out = await netModel.importSessionsFromPeer(req.params.networkId, req.params.nodeId, ids);
      res.json({ success: true, ...out });
    } catch (e) {
      res.status(e && e.statusCode ? e.statusCode : 400).json({ success: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.post('/v1/net/networks/:networkId/peers/:nodeId/docs/sync', async (req, res) => {
    try {
      const out = await netModel.syncDocsFromPeer(req.params.networkId, req.params.nodeId);
      res.json({ success: true, ...out });
    } catch (e) {
      res.status(e && e.statusCode ? e.statusCode : 400).json({ success: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.post('/v1/net/networks/:networkId/sync/model-data', async (req, res) => {
    try {
      const result = await netModel.syncPeerData(req.params.networkId, 'model-data', (req.body || {}).nodeId || '');
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(e && e.statusCode ? e.statusCode : 400).json({ success: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.post('/v1/net/networks/:networkId/sync/pricing', async (req, res) => {
    try {
      const result = await netModel.syncPeerData(req.params.networkId, 'pricing', (req.body || {}).nodeId || '');
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(e && e.statusCode ? e.statusCode : 400).json({ success: false, error: e && e.message ? e.message : String(e) });
    }
  });


  app.get('/v1/net/networks/:networkId/sync-cache', (req, res) => {
    try {
      res.json({ success: true, caches: netModel.listSyncCache(req.params.networkId) });
    } catch (e) {
      res.status(e && e.statusCode ? e.statusCode : 400).json({ success: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.get('/v1/net/networks/:networkId/sync/:kind/preview', (req, res) => {
    try {
      const result = netModel.previewSyncCache(req.params.networkId, req.params.kind, req.query.nodeId || '');
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(e && e.statusCode ? e.statusCode : 400).json({ success: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.post('/v1/net/networks/:networkId/sync/:kind/apply', async (req, res) => {
    try {
      const result = await netModel.applySyncCache(req.params.networkId, req.params.kind, (req.body || {}).nodeId || '');
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(e && e.statusCode ? e.statusCode : 400).json({ success: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.post('/v1/net/networks/:networkId/refresh', async (req, res) => {
    const warnings: any[] = [];
    try {
      const task = (async () => {
        await netModel.refreshMembershipFromPeers(req.params.networkId);
        return netModel.refreshPeerManifests(req.params.networkId);
      })();
      const result: any = await withTimeout(task, NET_ROUTE_SYNC_TIMEOUT_MS, 'peer refresh timed out; showing cached manifests');
      if (result && result.__timedOut) {
        warnings.push(result.label);
        return res.json({ success: true, results: [], manifests: netModel.cachedPeerManifests(req.params.networkId), warnings });
      }
      res.json({ success: true, ...result });
    } catch (e) {
      try {
        res.json({ success: true, results: [], manifests: netModel.cachedPeerManifests(req.params.networkId), warnings: [e && e.message ? e.message : String(e)] });
      } catch (_) {
        res.status(e && e.statusCode ? e.statusCode : 400).json({ success: false, error: e && e.message ? e.message : String(e) });
      }
    }
  });

  app.post('/v1/net/networks/:networkId/invites', (req, res) => {
    try {
      const detected = detectedEndpoints();
      const body = req.body || {};
      const defaultHints = ['web', 'funnelUrl', 'tailscaleHttps', 'tailscale', 'tailscaleHttp', 'lan']
        .map((k) => (detected.endpoints && detected.endpoints[k]) || detected[k])
        .filter(Boolean);
      const endpointHints = Array.isArray(body.endpointHints) ? body.endpointHints : defaultHints;
      const invite = netModel.createInvite(req.params.networkId, { ...body, endpointHints });
      res.json({ success: true, invite });
    } catch (e) {
      res.status(400).json({ success: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.post('/v1/net/join', async (req, res) => {
    try {
      const body = req.body || {};
      const result = await netModel.requestJoin(body.token, body.endpoint, detectedEndpoints().endpoints);
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(400).json({ success: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.get('/v1/net/join-requests', (_req, res) => {
    res.json({ success: true, requests: netModel.listJoinRequests() });
  });

  app.post('/v1/net/join-requests/:requestId/accept', async (req, res) => {
    try {
      const result = await netModel.acceptJoinRequest(req.params.requestId);
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(400).json({ success: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.post('/v1/net/join-requests/:requestId/reject', (req, res) => {
    try {
      const request = netModel.rejectJoinRequest(req.params.requestId);
      res.json({ success: true, request });
    } catch (e) {
      res.status(400).json({ success: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.get('/v1/net/offers', (_req, res) => {
    res.json({ success: true, offers: netModel.readOffers() });
  });

  app.put('/v1/net/offers', (req, res) => {
    try {
      const offers = netModel.writeOffers(req.body || {});
      res.json({ success: true, offers });
    } catch (e) {
      res.status(400).json({ success: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.get('/v1/peer/networks/:networkId/membership', (req, res) => {
    try {
      requirePeerSignature(req);
      const network = netModel.readNetwork(req.params.networkId);
      if (!network) return res.status(404).json({ success: false, error: 'Network not found.' });
      res.json({ success: true, network });
    } catch (e) {
      res.status(e && e.statusCode ? e.statusCode : 404).json({ success: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.get('/v1/peer/networks/:networkId/manifest', (req, res) => {
    try {
      requirePeerSignature(req);
      const detected = detectedEndpoints();
      res.json({ success: true, manifest: netModel.manifest(req.params.networkId, detected.endpoints) });
    } catch (e) {
      res.status(e && e.statusCode ? e.statusCode : 404).json({ success: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.post('/v1/peer/networks/:networkId/join-request', (req, res) => {
    try {
      const request = netModel.receiveJoinRequest(req.params.networkId, req.body || {});
      res.json({ success: true, request });
    } catch (e) {
      res.status(400).json({ success: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.post('/v1/peer/networks/:networkId/membership-update', (req, res) => {
    try {
      let verified = null;
      if (req.headers['x-yha-signature']) {
        const v = netModel.verifyPeerRequest(req);
        if (!v || !v.ok) return res.status(401).json({ success: false, error: v && v.error ? v.error : 'Invalid YHA peer signature.' });
        verified = v;
      }
      const result = netModel.receiveMembershipUpdate(req.params.networkId, req.body || {}, verified);
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(400).json({ success: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.post('/v1/peer/networks/:networkId/revoke', (req, res) => {
    try {
      const verified = requirePeerSignature(req);
      const result = netModel.receiveRevoke(req.params.networkId, req.body || {}, verified);
      res.json({ success: true, ...result });
    } catch (e) {
      res.status(e && e.statusCode ? e.statusCode : 400).json({ success: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.get('/v1/peer/networks/:networkId/offers', (req, res) => {
    try {
      requirePeerSignature(req);
      const m = netModel.manifest(req.params.networkId, detectedEndpoints().endpoints);
      res.json({ success: true, node: m.node, offers: m.offers });
    } catch (e) {
      res.status(e && e.statusCode ? e.statusCode : 404).json({ success: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.get('/v1/peer/networks/:networkId/docs/list', (req, res) => {
    try {
      requirePeerSignature(req);
      // Confirms the network exists locally; docs access is still constrained to
      // the explicit offer_docs root in netModel.listDocs().
      netModel.manifest(req.params.networkId, detectedEndpoints().endpoints);
      const out = netModel.listDocs(req.query.path || '');
      res.json({ success: true, ...out });
    } catch (e) {
      res.status(e && e.statusCode ? e.statusCode : 400).json({ success: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.get('/v1/peer/networks/:networkId/docs/read', (req, res) => {
    try {
      requirePeerSignature(req);
      netModel.manifest(req.params.networkId, detectedEndpoints().endpoints);
      const out = netModel.readDoc(req.query.path || '');
      res.json({ success: true, ...out });
    } catch (e) {
      res.status(e && e.statusCode ? e.statusCode : 400).json({ success: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.get('/v1/peer/networks/:networkId/sessions', (req, res) => {
    try {
      requirePeerSignature(req);
      netModel.manifest(req.params.networkId, detectedEndpoints().endpoints);
      netModel.ensureOfferCapability('chat-history', 'list');
      res.json({ success: true, sessions: netModel.listLocalSessions() });
    } catch (e) {
      res.status(e && e.statusCode ? e.statusCode : 400).json({ success: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.get('/v1/peer/networks/:networkId/sessions/:sid', (req, res) => {
    try {
      requirePeerSignature(req);
      netModel.manifest(req.params.networkId, detectedEndpoints().endpoints);
      netModel.ensureOfferCapability('chat-history', 'read');
      res.json({ success: true, session: netModel.exportLocalSession(req.params.sid) });
    } catch (e) {
      res.status(e && e.statusCode ? e.statusCode : 400).json({ success: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.get('/v1/peer/networks/:networkId/model-data', (req, res) => {
    try {
      requirePeerSignature(req);
      netModel.manifest(req.params.networkId, detectedEndpoints().endpoints);
      netModel.ensureOfferCapability('model-data', 'read');
      res.json({ success: true, modelData: netModel.publicModelData() });
    } catch (e) {
      res.status(e && e.statusCode ? e.statusCode : 400).json({ success: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.get('/v1/peer/networks/:networkId/pricing', (req, res) => {
    try {
      requirePeerSignature(req);
      netModel.manifest(req.params.networkId, detectedEndpoints().endpoints);
      netModel.ensureOfferCapability('price-costs', 'read');
      res.json({ success: true, pricing: netModel.publicPricingData() });
    } catch (e) {
      res.status(e && e.statusCode ? e.statusCode : 400).json({ success: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.get('/v1/peer/networks/:networkId/usage-cost-summary', (req, res) => {
    try {
      requirePeerSignature(req);
      netModel.manifest(req.params.networkId, detectedEndpoints().endpoints);
      netModel.ensureOfferCapability('usage-cost-summary', 'read');
      res.json({ success: true, usageCostSummary: netModel.publicUsageSummary() });
    } catch (e) {
      res.status(e && e.statusCode ? e.statusCode : 400).json({ success: false, error: e && e.message ? e.message : String(e) });
    }
  });

  app.get('/v1/peer/networks/:networkId/events', (req, res) => {
    try {
      requirePeerSignature(req);
      const m = netModel.manifest(req.params.networkId, detectedEndpoints().endpoints);
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      });
      const send = (type, data) => {
        res.write(`event: ${type}\n`);
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      };
      send('hello', { nodeId: m.node.id, networkId: req.params.networkId, revision: m.network.revision, generatedAt: new Date().toISOString() });
      for (const event of netModel.recentNetworkEvents(req.params.networkId, 25)) send(event.type || 'event', event);
      const unsubscribe = netModel.subscribeNetworkEvents(req.params.networkId, (event) => send(event.type || 'event', event));
      const timer = setInterval(() => {
        try {
          const next = netModel.manifest(req.params.networkId, detectedEndpoints().endpoints);
          send('heartbeat', { nodeId: next.node.id, networkId: req.params.networkId, revision: next.network.revision, generatedAt: new Date().toISOString() });
        } catch (_) {
          send('error', { error: 'network unavailable', generatedAt: new Date().toISOString() });
        }
      }, 30_000);
      req.on('close', () => { clearInterval(timer); unsubscribe(); });
    } catch (e) {
      if (!res.headersSent) res.status(e && e.statusCode ? e.statusCode : 400).json({ success: false, error: e && e.message ? e.message : String(e) });
    }
  });

  // GET /v1/net/nodes — lightweight directory of the fleet (no tokens).
  // Useful for server-side or future Go pieces; FE primarily uses its prefs copy.
  app.get('/v1/net/nodes', (_req, res) => {
    const p = readPrefsSync();
    const raw = Array.isArray(p.yhaNetNodes) ? p.yhaNetNodes : [];
    const nodes = raw.map((n) => ({
      id: n.id,
      label: n.label,
      computerName: n.computerName,
      tailscaleName: n.tailscaleName,
      webserviceUrl: n.webserviceUrl,
      port: n.port,
      preferredMode: n.preferredMode,
      enabled: !!n.enabled,
      isSelf: !!n.isSelf,
      profile: n.profile,
      availability: n.availability,
      owner: n.owner,
      serving: n.serving,
      // deliberately no .token
    }));
    res.json({ success: true, nodes });
  });

  // /v1/net/nodes/:nodeId/*  — reverse proxy to a fleet peer.
  // The browser (and later internal agents) only ever call *this* origin.
  // We resolve the target from the live yhaNetNodes prefs, inject the node's
  // token as bearer (so the far side's auth accepts us via verifyNetBearer),
  // rewrite the path so the peer sees its native /v1/files etc, and forward.
  // Supports GET/POST/PUT/DELETE etc + streaming bodies for uploads.
  // Mounted after auth so net-bearers have already been turned into users.
  app.use('/v1/net/nodes/:nodeId', (req, res, next) => {
    // Ensure param is visible to the proxy's router fn even under nested mounts.
    if (req.params && req.params.nodeId) {
      // express 4/5 style
    }
    next();
  }, getNetProxy());

  netSync.startNetBackgroundSync(() => detectedEndpoints());
}

module.exports = { registerNetRoutes };
