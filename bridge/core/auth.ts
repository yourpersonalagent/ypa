const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WorkOS } = require('@workos-inc/node');
const { registerTuiLinkRoutes, verifyBearer, verifyNetBearer, isTuiLinkPublicPath } = require('./tui-link');
import type { Request, Response, NextFunction, Express } from 'express';

// Auth is only active when WorkOS env vars are present
const AUTH_ENABLED = !!(process.env.WORKOS_API_KEY && process.env.WORKOS_CLIENT_ID);

// Only these emails get full access — loaded from ALLOWED_EMAILS env var.
// Supports multi-user grouping: `{a;b},{c;d}` → all four aliases allowed,
// with a/c being canonical per-user folder names. Parser lives in
// bridge/users/resolver.ts; we just need the flat allowed-set here.
const _resolver = require('../users/resolver');
const ALLOWED_EMAILS = _resolver.allAllowedEmails();

let workos: InstanceType<typeof WorkOS> | null = null;
let CLIENT_ID: string | undefined;
let REDIRECT_URI: string | undefined;
if (AUTH_ENABLED) {
  workos = new WorkOS(process.env.WORKOS_API_KEY);
  CLIENT_ID = process.env.WORKOS_CLIENT_ID;
  REDIRECT_URI = process.env.WORKOS_REDIRECT_URI;
}

// resolveRedirectUri picks the WorkOS callback URL to send a login flow
// to. Each YHA node (Pi, laptop, ...) sees the user on its own URL; the
// callback must come back to THAT URL or WorkOS rejects it. We derive
// from the request's Host header so each node Just Works without a
// per-host env override.
//
// Every host you reach the bridge from must be registered in the WorkOS
// dashboard (Authentication → AuthKit → Redirects). Add as many as you
// need; the per-request derivation will pick the matching one.
//
// HTTPS heuristic: tailscale funnel and similar reverse proxies
// terminate TLS and forward as plain HTTP (USE_HTTP=true is the bridge's
// signal it's behind one), so req.protocol returns "http" even though
// the user's URL is "https". Force https for known TLS-fronted hosts
// (.ts.net, .tailscale.net) — extend the list if you proxy through
// other domains.
//
// Loopback is special: the bridge is an internal upstream in the normal
// Go-frontdoor topology. A browser (or browser-control client) can still hit
// :8442 accidentally, but that must not mint an unregistered
// http://localhost:8442 callback. When an operator configured the canonical
// WorkOS callback, prefer it for every loopback request. This also makes a
// localhost Go-frontdoor entry bounce through the registered public origin
// instead of failing at AuthKit.
//
// WORKOS_REDIRECT_URI remains the fallback when there's no Host header.
function resolveRedirectUri(req: import('express').Request): string {
  const o = resolveOrigin(req);
  if (o) {
    if (REDIRECT_URI && isLocalOnlyHost(o.host)) return REDIRECT_URI;
    return `${o.proto}://${o.host}/auth/callback`;
  }
  return REDIRECT_URI || '';
}

function canonicalLoginUrlFor(req: import('express').Request): string | null {
  if (!REDIRECT_URI) return null;
  const o = resolveOrigin(req);
  if (!o || !isLocalOnlyHost(o.host)) return null;
  try {
    const canonical = new URL(REDIRECT_URI);
    const currentHost = new URL(`${o.proto}://${o.host}`).host.toLowerCase();
    if (canonical.host.toLowerCase() === currentHost) return null;
    canonical.pathname = '/auth/login';
    canonical.search = '';
    const prompt = typeof req.query.prompt === 'string' && req.query.prompt.trim() ? req.query.prompt.trim() : '';
    if (prompt) canonical.searchParams.set('prompt', prompt);
    return canonical.toString();
  } catch {
    return null;
  }
}

function isLoopbackHost(host: string): boolean {
  try {
    const hostname = new URL(`http://${host}`).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  } catch {
    return /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host.trim());
  }
}

function isLocalOnlyHost(host: string): boolean {
  if (isLoopbackHost(host)) return true;
  try {
    const hostname = new URL(`http://${host}`).hostname.toLowerCase();
    if (!hostname) return false;
    if (hostname.endsWith('.local') || hostname.endsWith('.lan')) return true;
    if (!hostname.includes('.')) return true;
    if (/^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(hostname)) return true;
  } catch {
    const h = String(host || '').split(':')[0].toLowerCase();
    if (h.endsWith('.local') || h.endsWith('.lan')) return true;
    if (h && !h.includes('.')) return true;
  }
  return false;
}

const PUBLIC_PATHS = ['/', '/login', '/auth/login', '/auth/callback', '/auth/logout', '/health'];
const PUBLIC_PREFIXES = [
  '/assets/', '/css/', '/js/', '/lib/', '/src/', '/uploads/', '/exchange/',
  // Vite dev-server emits these — HMR client, fs-resolved deps, plugin
  // runtimes, pre-bundled node_modules. They only appear in dev mode (when
  // the bridge embeds Vite's middleware); in prod the bundle is hashed
  // under /assets/ and these prefixes simply don't exist on disk.
  '/@vite/', '/@id/', '/@fs/', '/node_modules/',
];
const PUBLIC_EXACT = new Set([
  '/favicon.svg', '/manifest.json',
  // Vite's React Refresh runtime is served at this exact path (no slash).
  '/@react-refresh',
]);
// Per-user (Q16) — routed via bridge/core/paths.ts.
const AUTH_LOG_PATH = require('./paths').authLoginsLog;

function ensureAuthLogDir(): void {
  fs.mkdirSync(path.dirname(AUTH_LOG_PATH), { recursive: true });
}

function sanitizeLogValue(value: unknown): string {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim();
}

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.trim()) {
    return forwarded.split(',')[0].trim();
  }
  if (Array.isArray(forwarded) && forwarded.length) {
    return String(forwarded[0] || '')
      .split(',')[0]
      .trim();
  }
  return req.ip || req.socket?.remoteAddress || '';
}

// Constant-time string compare. crypto.timingSafeEqual throws on
// length-mismatched buffers, so guard length first (the length itself is
// not secret here — both sides are fixed-width base64url tokens).
function timingSafeEqualStr(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function appendAuthLog(event: string, details: Record<string, unknown> = {}): void {
  const line = [
    `[${new Date().toISOString()}]`,
    event,
    ...Object.entries(details)
      .filter(([, value]) => value !== undefined && value !== null && value !== '')
      .map(([key, value]) => `${key}="${sanitizeLogValue(value)}"`),
  ].join(' ');
  try {
    ensureAuthLogDir();
    fs.appendFileSync(AUTH_LOG_PATH, `${line}\n`, 'utf8');
  } catch (e) {
    console.warn('[auth] failed to write auth log:', e instanceof Error ? e.message : String(e));
  }
}

function base64UrlDecode(value: unknown): string {
  const normalized = String(value || '')
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function extractSessionIdFromAccessToken(accessToken: unknown): string | null {
  if (!accessToken || typeof accessToken !== 'string') return null;
  try {
    const [, payload] = accessToken.split('.');
    if (!payload) return null;
    const decoded = JSON.parse(base64UrlDecode(payload));
    return typeof decoded?.sid === 'string' && decoded.sid ? decoded.sid : null;
  } catch {
    return null;
  }
}

// resolveOrigin returns the public origin the BROWSER sees, accounting
// for reverse-proxy chains. Order of preference:
//   1. X-Forwarded-Host — stamped by go-core when it proxies to bun on
//      :8442. The raw Host header is "127.0.0.1:8442" (the upstream),
//      useless for building a returnTo URL.
//   2. Host header — direct connections to the bridge.
//
// Proto resolution mirrors the host logic plus a .ts.net heuristic for
// tailscale funnel (which terminates TLS and forwards as plain HTTP):
//   1. X-Forwarded-Proto — set by some reverse proxies
//   2. .ts.net / .tailscale.net host suffix → "https" (funnel is always TLS)
//   3. req.protocol fallback
function resolveOrigin(req: Request): { proto: string; host: string } | null {
  const fwdHost = req.headers['x-forwarded-host'];
  const rawFwdHost = typeof fwdHost === 'string' ? fwdHost.split(',')[0].trim() : '';
  const host = rawFwdHost || req.get('host') || '';
  if (!host) return null;
  const protoHeader = req.headers['x-forwarded-proto'];
  const rawFwdProto = typeof protoHeader === 'string' ? protoHeader.split(',')[0].trim() : '';
  const tlsFronted =
    host.endsWith('.ts.net') ||
    host.endsWith('.tailscale.net') ||
    host.endsWith('.tailnet.ts.net');
  const proto = rawFwdProto || (tlsFronted ? 'https' : req.protocol || 'http');
  return { proto, host };
}

function getRequestOrigin(req: Request): string | null {
  const o = resolveOrigin(req);
  return o ? `${o.proto}://${o.host}` : null;
}

function isPublicAssetPath(req: Request): boolean {
  if (PUBLIC_EXACT.has(req.path)) return true;
  if (PUBLIC_PREFIXES.some((p) => req.path.startsWith(p))) return true;
  // Built assets can have hashed names under /assets/*.json, *.js, *.css, etc.
  return /\.(css|js|mjs|map|json|svg|png|jpg|jpeg|gif|webp|avif|ico|woff2?|mp4|webm|ogg|mov|mp3|m4a|aac|wav|flac)$/i.test(req.path);
}

// ── Phase 2d trust header (X-Yha-Trust) ──────────────────────────────────────
// Go core stamps this header on every request it forwards after
// authenticating via yha.sid. Format: <base64url-payload>.<base64url-sig>
// signed with SESSION_SECRET so only Go (which knows the secret) can mint
// it. We verify before authMiddleware runs so legacy /v1/* endpoints see
// req.session.user even without connect.sid.
//
// SECURITY: signature verification is mandatory. Loopback alone isn't
// enough — Tailscale Funnel forwards external traffic from 127.0.0.1
// after TLS termination, so a malicious caller could otherwise inject
// a header from outside.
const TRUST_HEADER = 'x-yha-trust';

function verifyTrustHeader(value: string): { email: string; name: string; allowed: boolean; id: string } | null {
  if (!value || typeof value !== 'string') return null;
  const dot = value.indexOf('.');
  if (dot <= 0 || dot >= value.length - 1) return null;
  const payload = value.slice(0, dot);
  const sig = value.slice(dot + 1);
  const secret = process.env.SESSION_SECRET;
  if (!secret) return null;

  let expected: Buffer;
  let actual: Buffer;
  try {
    expected = crypto.createHmac('sha256', secret).update(payload).digest();
    actual = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  if (expected.length !== actual.length) return null;
  if (!crypto.timingSafeEqual(expected, actual)) return null;

  let parsed: any;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed.e !== 'string' || typeof parsed.x !== 'number') return null;
  if (Math.floor(Date.now() / 1000) > parsed.x) return null;
  return {
    email: parsed.e,
    name: typeof parsed.n === 'string' ? parsed.n : parsed.e,
    allowed: parsed.a === true,
    id: typeof parsed.u === 'string' ? parsed.u : '',
  };
}

// trustMiddleware runs after express-session and before authMiddleware.
// When a valid trust header is present, it overwrites req.session.user
// so the rest of the pipeline (allowlist gating, /v1/me, etc.) sees the
// Go-authenticated user.
function trustMiddleware(req: Request, _res: Response, next: NextFunction): void {
  const raw = req.headers[TRUST_HEADER];
  const header = Array.isArray(raw) ? raw[0] : raw;
  if (!header) return next();
  const user = verifyTrustHeader(header);
  if (!user) return next();
  // saveUninitialized:false means no connect.sid → no req.session object even
  // though Go stamped a valid X-Yha-Trust. Synthesize one (same as bearer).
  const session = (req as any).session;
  if (session) {
    session.user = user;
  } else {
    (req as any).session = {
      user: {
        email: user.email,
        name: user.name,
        allowed: user.allowed,
        id: user.id,
      },
    };
  }
  return next();
}

function authMiddleware(req: Request, res: Response, next: NextFunction): void | Response {
  if (!AUTH_ENABLED) return next();
  if (PUBLIC_PATHS.some((p) => req.path === p || req.path.startsWith(p + '/'))) return next();
  if (isPublicAssetPath(req)) return next();
  // TUI link-flow public paths (link start + poll). The browser-side
  // approval handler still flows through the WorkOS-session path below.
  if (isTuiLinkPublicPath(req.path)) return next();
  // YHA Net pairing bootstrap: this route is intentionally reachable by a
  // not-yet-paired remote node. It does not grant membership; the route body
  // must present a valid 10-minute invite id + secret, then the owner still
  // accepts/rejects the request in Preferences.
  if (req.method === 'POST' && /^\/v1\/peer\/networks\/[^/]+\/join-request$/.test(req.path)) return next();
  // YHA Net pairing bootstrap, second half: after the owner accepts a join
  // request, the inviter pushes the signed-ish membership document back to the
  // new node. The route itself validates that this node has a matching pending
  // outgoing invite secret before storing the network.
  if (req.method === 'POST' && /^\/v1\/peer\/networks\/[^/]+\/membership-update$/.test(req.path)) return next();
  // YHA Net accepted-peer APIs. These are reachable without browser cookies
  // over Funnel, but only with an Ed25519 request signature from a current
  // network member. Pairing bootstrap above stays invite-secret based.
  if (req.method === 'GET' && /^\/v1\/peer\/networks\/[^/]+\/(membership|manifest|offers|model-data|pricing|usage-cost-summary|events)$/.test(req.path)) {
    try {
      const netModel = require('./net-model');
      const v = netModel.verifyPeerRequest(req);
      if (v && v.ok) { (req as any)._yhaPeerVerified = v; return next(); }
      return res.status(401).json({ success: false, error: v && v.error ? v.error : 'Invalid YHA peer signature.' });
    } catch (e) {
      return res.status(401).json({ success: false, error: e && e.message ? e.message : 'Invalid YHA peer signature.' });
    }
  }
  if (req.method === 'POST' && /^\/v1\/peer\/networks\/[^/]+\/revoke$/.test(req.path)) {
    try {
      const netModel = require('./net-model');
      const v = netModel.verifyPeerRequest(req);
      if (v && v.ok) { (req as any)._yhaPeerVerified = v; return next(); }
      return res.status(401).json({ success: false, error: v && v.error ? v.error : 'Invalid YHA peer signature.' });
    } catch (e) {
      return res.status(401).json({ success: false, error: e && e.message ? e.message : 'Invalid YHA peer signature.' });
    }
  }
  if (req.method === 'GET' && /^\/v1\/peer\/networks\/[^/]+\/docs\/(list|read)$/.test(req.path)) {
    try {
      const netModel = require('./net-model');
      const v = netModel.verifyPeerRequest(req);
      if (v && v.ok) { (req as any)._yhaPeerVerified = v; return next(); }
      return res.status(401).json({ success: false, error: v && v.error ? v.error : 'Invalid YHA peer signature.' });
    } catch (e) {
      return res.status(401).json({ success: false, error: e && e.message ? e.message : 'Invalid YHA peer signature.' });
    }
  }
  // YHA Net chat-history offer: list sessions (/sessions) or fetch one full
  // transcript (/sessions/<id>). Same Ed25519 signature requirement as above.
  if (req.method === 'GET' && /^\/v1\/peer\/networks\/[^/]+\/sessions(\/[^/]+)?$/.test(req.path)) {
    try {
      const netModel = require('./net-model');
      const v = netModel.verifyPeerRequest(req);
      if (v && v.ok) { (req as any)._yhaPeerVerified = v; return next(); }
      return res.status(401).json({ success: false, error: v && v.error ? v.error : 'Invalid YHA peer signature.' });
    } catch (e) {
      return res.status(401).json({ success: false, error: e && e.message ? e.message : 'Invalid YHA peer signature.' });
    }
  }

  // Claude Code binary calls /proxy/* from localhost — let it through
  const ip = req.socket?.remoteAddress || req.ip || '';
  const isLocal = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  if (isLocal && req.path.startsWith('/proxy/')) return next();
  // Local /v1/modules access — needed for the yha-reload skill (curl from the
  // same box) and the file-watcher's status reads. Any process that can write
  // to bridge/modules/** already has shell-level access, so a loopback bypass
  // here doesn't widen the attack surface meaningfully.
  if (isLocal && req.path.startsWith('/v1/modules')) return next();
  // Read-only active-model state — MCP children (e.g. media-server) poll this
  // without session cookies. PATCH still requires auth; GET is non-sensitive.
  if (isLocal && req.method === 'GET' && req.path === '/v1/active-models/') return next();
  // Version endpoints from loopback — go-core proxies authenticated browser
  // requests from 127.0.0.1; bridge only binds loopback so this is safe.
  if (isLocal && req.method === 'GET' && req.path === '/v1/version') return next();
  if (isLocal && req.method === 'POST' && req.path === '/v1/version/check') return next();
  if (isLocal && req.method === 'POST' && req.path === '/v1/version/apply') return next();

  // Bearer-token path (TUI link-login + YHA Net peer tokens). When a valid
  // token is present synthesize req.session.user so downstream code (allowlist
  // gate, /v1/me) sees the same shape as a WorkOS session login. Net peers get
  // a synthetic "net-peer" user with allowed:true.
  if (!(req as any).session?.user) {
    const authHeader = req.headers['authorization'];
    const bearerUser = verifyBearer(Array.isArray(authHeader) ? authHeader[0] : authHeader);
    if (bearerUser) {
      const session = (req as any).session;
      if (session) session.user = bearerUser;
      else (req as any).session = { user: bearerUser };
    } else {
      // YHA Net: a peer node presenting the bearer we issued for it (the .token
      // from *our* yhaNetNodes self entry). Lets server-to-server proxy calls
      // (files, later sessions) pass as an allowed synthetic user.
      const netUser = verifyNetBearer(Array.isArray(authHeader) ? authHeader[0] : authHeader);
      if (netUser) {
        const session = (req as any).session;
        if (session) session.user = netUser;
        else (req as any).session = { user: netUser };
      }
    }
  }

  if (!(req as any).session?.user) {
    if (req.path.startsWith('/v1/') || req.headers.accept?.includes('text/event-stream')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    return res.redirect('/');
  }

  // Logged in but not on the allowlist → restricted page only
  if (!(req as any).session.user.allowed) {
    if (req.path === '/restricted') return next();
    if (req.path.startsWith('/v1/') || req.headers.accept?.includes('text/event-stream')) {
      return res.status(403).json({ error: 'Access denied' });
    }
    return res.redirect('/restricted');
  }

  next();
}

function registerAuthRoutes(app: Express): void {
  // TUI link-login routes — must register here so the public start/poll
  // endpoints land before authMiddleware runs.
  registerTuiLinkRoutes(app);

  // Legacy /login URL still works as a fallback — redirect to the new root.
  app.get('/login', (req: Request, res: Response) => {
    if (AUTH_ENABLED && (req as any).session?.user) {
      return res.redirect((req as any).session.user.allowed ? '/ypa' : '/restricted');
    }
    return res.redirect('/');
  });

  app.get('/restricted', (_req: Request, res: Response) => {
    res.sendFile(path.join(__dirname, '..', '..', 'frontend', 'restricted.html'));
  });

  app.get('/auth/logout', (req: Request, res: Response) => {
    const user = (req as any).session?.user || null;
    const sessionId = (req as any).session?.workosSessionId || null;
    const switchAccount = String(req.query.switch || '') === '1';
    const loginRedirect = switchAccount ? '/auth/login?prompt=select_account' : '/';
    const requestOrigin = getRequestOrigin(req);
    const returnTo = requestOrigin ? `${requestOrigin}${loginRedirect}` : undefined;
    appendAuthLog('logout', {
      email: user?.email,
      name: user?.name,
      userId: user?.id,
      allowed: typeof user?.allowed === 'boolean' ? String(user.allowed) : undefined,
      sessionId,
      switchAccount: switchAccount ? 'true' : undefined,
      ip: getClientIp(req),
    });
    (req as any).session.destroy(() => {
      if (switchAccount && AUTH_ENABLED && sessionId) {
        try {
          const logoutUrl = workos!.userManagement.getLogoutUrl({ sessionId, returnTo });
          return res.redirect(logoutUrl);
        } catch (e) {
          console.warn('[auth] failed to build WorkOS logout URL:', e instanceof Error ? e.message : String(e));
        }
      }
      res.redirect(loginRedirect);
    });
  });

  app.get('/v1/me', (req: Request, res: Response) => {
    const u = (req as any).session?.user;
    if (!u) {
      if (AUTH_ENABLED) return res.status(401).json({ error: 'Unauthorized' });
      return res.json({});
    }
    res.json({ name: u.name, email: u.email, id: u.id, allowed: u.allowed });
  });

  // ── /internal/whoami — Phase 2b hybrid auth bridge to Go core ─────────────
  // Authenticated callers (Go's yha-core) forward the user's connect.sid
  // cookie + an X-Yha-Internal-Key header. Express-session middleware has
  // already populated req.session.user by the time this handler runs.
  // Returns the same shape Go's auth.WhoAmIResult expects.
  //
  // The shared secret comes from $YHA_INTERNAL_KEY in the bridge env.
  // If unset, this endpoint returns 503 — Go's lookup degrades to "no
  // session" and the gate stays advisory.
  app.post('/internal/whoami', (req: Request, res: Response) => {
    const expected = process.env.YHA_INTERNAL_KEY;
    if (!expected) {
      return res.status(503).json({ error: 'YHA_INTERNAL_KEY not configured on bridge' });
    }
    if (req.headers['x-yha-internal-key'] !== expected) {
      return res.status(403).json({ error: 'Bad internal key' });
    }
    const u = (req as any).session?.user;
    if (!u) {
      return res.json({ hasSession: false });
    }
    return res.json({
      hasSession: true,
      email: u.email || '',
      allowed: !!u.allowed,
      name: u.name || '',
      id: u.id || '',
    });
  });

  if (!AUTH_ENABLED) {
    console.log('[auth] WorkOS env vars not set — auth disabled, running open');
    return;
  }

  app.get('/auth/login', (req: Request, res: Response) => {
    // If already logged in and not explicitly switching accounts, skip the OAuth
    // round-trip — the Sign-in buttons on the public landing page should act as
    // "Enter YHA" for an authenticated session.
    const wantsPrompt = typeof req.query.prompt === 'string' && req.query.prompt.trim();
    if ((req as any).session?.user && !wantsPrompt) {
      return res.redirect((req as any).session.user.allowed ? '/ypa' : '/restricted');
    }
    // If a node is reached through a LAN/Windows hostname, bounce to the
    // configured canonical HTTPS origin before minting the OAuth state cookie.
    // Otherwise WorkOS would callback to http://LAPTOP-... and the state cookie
    // would be scoped to the wrong host.
    const canonicalLogin = canonicalLoginUrlFor(req);
    if (canonicalLogin) return res.redirect(canonicalLogin);
    // CSRF: mint a state token, stash it in the session, and pass it to
    // WorkOS. The callback rejects any response whose `state` doesn't match.
    const state = crypto.randomBytes(32).toString('base64url');
    (req as any).session.oauthState = state;
    const url = workos!.userManagement.getAuthorizationUrl({
      clientId: CLIENT_ID!,
      redirectUri: resolveRedirectUri(req),
      provider: 'authkit',
      prompt: wantsPrompt ? (req.query.prompt as string).trim() : undefined,
      state,
    });
    // Commit the session (and its Set-Cookie) before the browser leaves for
    // WorkOS, so the state is persisted when the callback comes back.
    (req as any).session.save((saveErr: unknown) => {
      if (saveErr) {
        console.error('[auth] login session save error:', saveErr);
        return res.redirect('/?error=auth_failed');
      }
      res.redirect(url);
    });
  });

  app.get('/auth/callback', async (req: Request, res: Response) => {
    // CSRF: the `state` echoed by WorkOS must match what we planted in the
    // session at /auth/login. Consume it (single-use) before validating, so a
    // replay can't reuse it — the deletion is persisted by the session store on
    // response end (and explicitly on the success path's session.save).
    const returnedState = typeof req.query.state === 'string' ? req.query.state : '';
    const expectedState =
      typeof (req as any).session?.oauthState === 'string' ? (req as any).session.oauthState : '';
    if ((req as any).session) delete (req as any).session.oauthState;
    if (!expectedState || !returnedState || !timingSafeEqualStr(returnedState, expectedState)) {
      appendAuthLog('login_failed', {
        reason: 'state_mismatch',
        ip: getClientIp(req),
      });
      return res.redirect('/?error=bad_state');
    }

    const { code } = req.query;
    if (!code) {
      appendAuthLog('login_failed', {
        reason: 'missing_code',
        ip: getClientIp(req),
      });
      return res.redirect('/?error=missing_code');
    }
    try {
      const { user, accessToken } = await workos!.userManagement.authenticateWithCode({
        clientId: CLIENT_ID!,
        code: String(code),
      });
      const email = (user.email || '').toLowerCase();
      const allowed = ALLOWED_EMAILS.has(email);
      const workosSessionId = extractSessionIdFromAccessToken(accessToken);
      (req as any).session.user = {
        id: user.id,
        email: user.email,
        name: user.firstName || user.email,
        allowed,
      };
      (req as any).session.workosSessionId = workosSessionId;
      appendAuthLog('login_success', {
        email: user.email,
        name: user.firstName || user.email,
        userId: user.id,
        allowed: String(allowed),
        sessionId: workosSessionId,
        ip: getClientIp(req),
      });
      // Explicitly save before redirect so the session is committed before the
      // browser follows the Location header (avoids a race with async stores).
      (req as any).session.save((saveErr: unknown) => {
        if (saveErr) {
          console.error('[auth] session save error:', saveErr);
          return res.redirect('/?error=auth_failed');
        }
        res.redirect(allowed ? '/ypa' : '/restricted');
      });
    } catch (e) {
      console.error('[auth] callback error:', e instanceof Error ? e.message : String(e));
      appendAuthLog('login_failed', {
        reason: e instanceof Error ? e.message : String(e),
        ip: getClientIp(req),
      });
      res.redirect('/?error=auth_failed');
    }
  });
}

module.exports = { authMiddleware, trustMiddleware, registerAuthRoutes, AUTH_ENABLED, AUTH_LOG_PATH };
