// tui-link.ts — TUI link-login token store and link-flow.
// Also hosts verifyNetBearer (YHA Net machine-to-machine bearer tokens from
// the yhaNetNodes registry) so authMiddleware can treat fleet peers as
// authenticated for proxied /v1/net/nodes/:id/* and future sync calls.
//
// Goal: let the Go TUI authenticate to the bridge without copy-pasting
// session cookies. Flow:
//
//   1. TUI POSTs /auth/tui-link/start (unauthenticated). Bridge mints a
//      short-lived `linkId`, returns `{linkId, url}`. URL points to a
//      confirmation page on the bridge.
//   2. User opens that URL in a browser where they're already logged
//      in (WorkOS session cookie). Confirmation page shows session/day/
//      week buttons + a Cancel.
//   3. Browser POSTs /auth/tui-confirm/<linkId>/approve {ttlSec}. Bridge
//      mints a TUI token, attaches it to the link record.
//   4. TUI (polling /v1/tui-link/poll/<linkId>) reads the token, caches
//      it at ~/.yha/tui-token.json, then uses
//      `Authorization: Bearer <token>` for subsequent requests.
//
// Tokens are stored in bridge/state/tui-tokens.json (single-owner; the
// allowlist check happens at issue time). authMiddleware in auth.ts
// calls verifyBearer() so every authenticated route accepts a TUI
// token alongside the existing WorkOS session + trust header paths.
//
// Pending links are in-memory only — they live <10 min and don't need
// to survive a bridge bounce. Tokens persist to disk because a 7-day
// token bounce-surviving is the whole point.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
import type { Request, Response, Express } from 'express';

const { PORT: BRIDGE_PORT } = require('./state');
const { timingSafeEqualStr } = require('./secure-compare');

// Per-user (Q16) — routed via bridge/core/paths.ts.
const TOKENS_PATH = require('./paths').tuiTokens;
const PREFS_PATH = require('./paths').prefs;
const LINK_TTL_MS = 10 * 60 * 1000; // pending link expires in 10 minutes
const MAX_LINKS = 32; // GC bound; we never expect to be near this in practice

// TTL choices for the browser confirmation page. Kept short and finite
// so a leaked TUI token expires on its own — the only reason 30d exists
// is for the headless box that nobody will physically touch for a week.
const TTL_PRESETS = {
  session: 12 * 60 * 60, //  12 hours  (per-day work)
  day:     24 * 60 * 60, //  24 hours
  week:  7 * 24 * 60 * 60, // 7 days
  month: 30 * 24 * 60 * 60, // 30 days
} as const;

type LinkStatus = 'pending' | 'approved' | 'expired' | 'denied';

interface PendingLink {
  id: string;
  status: LinkStatus;
  createdAt: number;
  expiresAt: number;
  // Populated when approved:
  token?: string;
  email?: string;
  name?: string;
  tokenExpiresAt?: number;
  // Optional client hint surfaced to the confirmation page so the user
  // can tell devices apart on the approve screen.
  clientLabel?: string;
}

interface TuiToken {
  token: string;
  email: string;
  name: string;
  allowed: boolean;
  userId: string;
  issuedAt: number;
  expiresAt: number;
  label: string; // device label from the TUI ("yha-tui" by default)
}

const pendingLinks = new Map<string, PendingLink>();
let tokens: TuiToken[] = loadTokens();

function loadTokens(): TuiToken[] {
  try {
    const raw = fs.readFileSync(TOKENS_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed?.tokens)) return parsed.tokens as TuiToken[];
  } catch (_) {
    /* file missing or unreadable is normal on first boot */
  }
  return [];
}

function persistTokens(): void {
  try {
    fs.mkdirSync(path.dirname(TOKENS_PATH), { recursive: true });
    fs.writeFileSync(TOKENS_PATH, JSON.stringify({ tokens }, null, 2));
  } catch (e) {
    console.warn('[tui-link] failed to write tokens:', e instanceof Error ? e.message : String(e));
  }
}

function randomToken(bytes: number): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

function gcLinks(): void {
  const now = Date.now();
  for (const [id, link] of pendingLinks) {
    if (link.expiresAt <= now) pendingLinks.delete(id);
  }
  // Hard cap so a misbehaving client can't grow the map without bound.
  if (pendingLinks.size > MAX_LINKS) {
    const sorted = Array.from(pendingLinks.entries()).sort(
      (a, b) => a[1].createdAt - b[1].createdAt
    );
    for (const [id] of sorted.slice(0, sorted.length - MAX_LINKS)) {
      pendingLinks.delete(id);
    }
  }
}

function gcTokens(): void {
  const now = Math.floor(Date.now() / 1000);
  const live = tokens.filter((t) => t.expiresAt > now);
  if (live.length !== tokens.length) {
    tokens = live;
    persistTokens();
  }
}

// verifyBearer is the authMiddleware hook. Returns a user-shaped object
// when the Authorization header carries a valid live token; otherwise
// null so the middleware can fall through to other auth strategies.
function verifyBearer(headerValue: string | undefined): {
  email: string;
  name: string;
  allowed: boolean;
  id: string;
} | null {
  if (!headerValue || typeof headerValue !== 'string') return null;
  const m = headerValue.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  if (!token) return null;
  const now = Math.floor(Date.now() / 1000);
  // Constant-time match: compare every live token with timingSafeEqualStr and
  // never break early, so probe timing doesn't leak which/whether a token
  // matched. (verifyBearer is reachable by unauthenticated callers.)
  let found: (typeof tokens)[number] | null = null;
  for (const t of tokens) {
    if (t.expiresAt > now && timingSafeEqualStr(t.token, token)) found = t;
  }
  if (!found) return null;
  return {
    email: found.email,
    name: found.name,
    allowed: found.allowed,
    id: found.userId,
  };
}

// startLink mints a pending link. Public endpoint — the link by itself
// is useless until the browser side approves it.
function startLink(clientLabel?: string): PendingLink {
  gcLinks();
  const id = randomToken(16);
  const now = Date.now();
  const link: PendingLink = {
    id,
    status: 'pending',
    createdAt: now,
    expiresAt: now + LINK_TTL_MS,
    clientLabel: typeof clientLabel === 'string' && clientLabel.trim() ? clientLabel.trim().slice(0, 40) : undefined,
  };
  pendingLinks.set(id, link);
  return link;
}

function pollLink(id: string): PendingLink | null {
  gcLinks();
  const link = pendingLinks.get(id);
  if (!link) return null;
  return link;
}

// approveLink is called from the browser-side confirmation handler after
// the user (already logged in via WorkOS) picks a TTL preset. We mint a
// fresh token, persist it, and attach the token to the pending link so
// the polling TUI picks it up on the next poll.
function approveLink(opts: {
  id: string;
  ttlSec: number;
  user: { email: string; name: string; allowed: boolean; id: string };
  label?: string;
}): PendingLink | null {
  gcLinks();
  const link = pendingLinks.get(opts.id);
  if (!link || link.status !== 'pending') return null;
  const now = Math.floor(Date.now() / 1000);
  const ttl = Math.max(60, Math.min(opts.ttlSec, TTL_PRESETS.month));
  const token: TuiToken = {
    token: randomToken(32),
    email: opts.user.email,
    name: opts.user.name || opts.user.email,
    allowed: opts.user.allowed,
    userId: opts.user.id,
    issuedAt: now,
    expiresAt: now + ttl,
    label: opts.label || link.clientLabel || 'yha-tui',
  };
  tokens.push(token);
  persistTokens();
  link.status = 'approved';
  link.token = token.token;
  link.email = token.email;
  link.name = token.name;
  link.tokenExpiresAt = token.expiresAt;
  return link;
}

function denyLink(id: string): PendingLink | null {
  gcLinks();
  const link = pendingLinks.get(id);
  if (!link || link.status !== 'pending') return null;
  link.status = 'denied';
  return link;
}

function revokeToken(token: string): boolean {
  const before = tokens.length;
  tokens = tokens.filter((t) => t.token !== token);
  if (tokens.length === before) return false;
  persistTokens();
  return true;
}

function listTokens(): Array<Omit<TuiToken, 'token'> & { tokenSuffix: string }> {
  gcTokens();
  return tokens.map((t) => ({
    tokenSuffix: t.token.slice(-6),
    email: t.email,
    name: t.name,
    allowed: t.allowed,
    userId: t.userId,
    issuedAt: t.issuedAt,
    expiresAt: t.expiresAt,
    label: t.label,
  }));
}

// renderConfirmPage produces the browser-side approval page. Kept as a
// single self-contained HTML blob (no external assets) so it works in
// dev and prod without depending on the frontend build state.
function renderConfirmPage(opts: {
  linkId: string;
  user: { email: string; name: string; allowed: boolean };
  clientLabel?: string;
  status: LinkStatus;
}): string {
  const safe = (s: string) =>
    String(s || '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c as any] || c
    );
  const label = opts.clientLabel ? safe(opts.clientLabel) : 'yha-tui';
  const allowedBanner = opts.user.allowed
    ? ''
    : `<p class="warn">⚠ Your email (${safe(opts.user.email)}) is not on ALLOWED_EMAILS. Approval will still mint a token but the bridge will gate /v1/ as 403.</p>`;
  if (opts.status !== 'pending') {
    const msg =
      opts.status === 'approved'
        ? 'Already approved. The TUI should be authenticated. You can close this tab.'
        : opts.status === 'denied'
        ? 'This link has been denied. Restart the TUI to request a new one.'
        : 'This link is no longer valid. Restart the TUI to request a new one.';
    return `<!doctype html><html><head><meta charset=utf-8><title>YHA TUI — ${safe(opts.status)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:600px;margin:60px auto;padding:24px;background:#0e1116;color:#dfe3ea}
h1{font-weight:600;letter-spacing:.5px}.muted{color:#888}</style></head>
<body><h1>YHA TUI · ${safe(opts.status)}</h1><p class=muted>${msg}</p></body></html>`;
  }
  return `<!doctype html><html><head><meta charset=utf-8><title>Authorise YHA TUI</title>
<style>
  body{font-family:system-ui,sans-serif;max-width:640px;margin:60px auto;padding:24px;background:#0e1116;color:#dfe3ea}
  h1{font-weight:600;letter-spacing:.5px;margin:0 0 .5em}
  .muted{color:#9aa3ad}
  .row{display:flex;gap:12px;flex-wrap:wrap;margin:24px 0}
  button{font:inherit;padding:10px 20px;border:1px solid #3b4453;background:#1a1f29;color:#dfe3ea;border-radius:6px;cursor:pointer}
  button:hover{background:#22293a;border-color:#5fafff}
  button.deny{border-color:#7a3030}button.deny:hover{background:#3a1a1a;border-color:#ff5f5f}
  .warn{color:#ffaf5f;border:1px solid #5a4020;background:#2a1f10;padding:10px 14px;border-radius:6px}
  code{background:#0a0d12;padding:2px 6px;border-radius:4px}
  .done{margin-top:24px;padding:16px;border:1px solid #305a30;background:#0f1f0f;border-radius:6px;color:#87ff87;display:none}
  .done.show{display:block}
  .err{color:#ff5f5f;margin-top:12px}
</style></head>
<body>
<h1>Authorise YHA TUI</h1>
<p>Sign-in as <strong>${safe(opts.user.name || opts.user.email)}</strong> (<code>${safe(opts.user.email)}</code>).</p>
<p class=muted>Device label: <code>${label}</code></p>
${allowedBanner}
<p>Pick a token lifetime. The TUI is currently polling and will pick this up within a second.</p>
<div class=row>
  <button data-ttl="${TTL_PRESETS.session}">12 hours</button>
  <button data-ttl="${TTL_PRESETS.day}">1 day</button>
  <button data-ttl="${TTL_PRESETS.week}">7 days</button>
  <button data-ttl="${TTL_PRESETS.month}">30 days</button>
  <button class=deny data-ttl="0">Deny</button>
</div>
<div class=err id=err></div>
<div class=done id=done>✓ Token issued · the TUI should be online. You can close this tab.</div>
<script>
const linkId = ${JSON.stringify(opts.linkId)};
for (const b of document.querySelectorAll('button')) {
  b.addEventListener('click', async () => {
    const ttl = parseInt(b.dataset.ttl, 10);
    const url = ttl > 0
      ? '/auth/tui-confirm/' + encodeURIComponent(linkId) + '/approve'
      : '/auth/tui-confirm/' + encodeURIComponent(linkId) + '/deny';
    try {
      const res = await fetch(url, {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ttlSec: ttl }),
      });
      if (!res.ok) {
        document.getElementById('err').textContent = 'Request failed: ' + res.status + ' ' + (await res.text());
        return;
      }
      document.getElementById('done').classList.add('show');
      for (const x of document.querySelectorAll('button')) x.disabled = true;
    } catch (e) {
      document.getElementById('err').textContent = 'Network error: ' + (e && e.message ? e.message : e);
    }
  });
}
</script>
</body></html>`;
}

// publicOrigin resolves the host the BROWSER should reach the bridge on,
// not the host the TUI used. The TUI usually hits 127.0.0.1 (or a Unix
// socket via Go-core); returning that to the browser is useless because
// the user wants to approve from a desktop machine.
//
// Dynamic precedence — no hardcoded URLs, no env-var pre-config:
//   1. Tailscale `serve status --json` — look up a funnel/serve entry
//      whose Proxy targets this box's loopback stack. This is the
//      canonical source of truth for "how the public reaches this box".
//   2. Reverse-proxy hint headers (X-Forwarded-Host/-Proto) — set by
//      anything in front of the bridge (Caddy, nginx, etc.).
//   3. req.headers.origin — present when a browser made the call.
//   4. Tailscale `status --json` Self.DNSName — THIS machine's own
//      MagicDNS name. Available even before a funnel is configured, and
//      it follows the box, so a repo/.env copied in from another host
//      can never leak a stale hostname here. Ranked above the env-var
//      override for exactly that reason.
//   5. YHA_PUBLIC_URL / WORKOS_REDIRECT_URI — operator overrides for
//      non-Tailscale setups. Below auto-detection on purpose.
//   6. req.protocol://host — last-resort fallback (legacy path).
function publicOrigin(req: Request): string {
  const ts = detectTailscalePublicURL();
  if (ts) return ts;

  const xfHost = (req.headers['x-forwarded-host'] || '').toString().trim();
  if (xfHost && !isLoopback(xfHost)) {
    const xfProto = (req.headers['x-forwarded-proto'] || 'https').toString().split(',')[0].trim();
    return `${xfProto}://${xfHost.split(',')[0].trim()}`;
  }

  const origin = String(req.headers.origin || '').trim();
  if (origin && !isLoopback(origin)) return origin;

  // This machine's own Tailscale identity. The TUI hits us over loopback
  // (steps 2–3 above are empty for it), so without this a box whose funnel
  // is momentarily down — or not yet configured — would fall through to a
  // copied-in env var pointing at a *different* machine.
  const magic = detectTailscaleMagicDNS();
  if (magic) return magic;

  const explicit = (process.env.YHA_PUBLIC_URL || '').trim().replace(/\/$/, '');
  if (explicit) return explicit;
  const wo = (process.env.WORKOS_REDIRECT_URI || '').trim();
  if (wo) {
    try {
      const u = new URL(wo);
      return `${u.protocol}//${u.host}`;
    } catch {
      /* malformed — fall through */
    }
  }

  return (req.headers['x-forwarded-proto'] || req.protocol) + '://' + req.get('host');
}

function isLoopback(s: string): boolean {
  const lower = s.toLowerCase();
  return lower.includes('127.0.0.1') || lower.includes('localhost') || lower.includes('[::1]');
}

// Tailscale funnel/serve detection cache. `tailscale serve status --json`
// is cheap (~30ms) but we still cache so each TUI-link request doesn't
// pay the cost. Five minutes is long enough that the user could re-run
// `tailscale serve` and see the change reflected without a bridge bounce.
let _tsCache: { value: string | null; expires: number } | null = null;
const TS_CACHE_TTL_MS = 5 * 60 * 1000;

function detectTailscalePublicURL(): string | null {
  const now = Date.now();
  if (_tsCache && _tsCache.expires > now) return _tsCache.value;
  const value = probeTailscale();
  _tsCache = { value, expires: now + TS_CACHE_TTL_MS };
  return value;
}

function probeTailscale(): string | null {
  try {
    // execFileSync — no shell interpolation, hard timeout so a stuck
    // tailscaled can't wedge a bridge request thread.
    const raw = execFileSync('tailscale', ['serve', 'status', '--json'], {
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    const parsed = JSON.parse(raw);
    const web = parsed && typeof parsed === 'object' ? parsed.Web : null;
    if (!web || typeof web !== 'object') return null;
    const targetPort = String(BRIDGE_PORT);
    let match: string | null = null;       // funnel → our exact bridge port
    let loopbackMatch: string | null = null; // funnel → any loopback (our box)
    let fallback: string | null = null;      // any served public host
    for (const [hostPort, handlersWrap] of Object.entries(web)) {
      const handlers = (handlersWrap as any)?.Handlers;
      if (!handlers || typeof handlers !== 'object') continue;
      // Each handler entry's Proxy looks like "http://127.0.0.1:8443".
      // A proxy at the bridge's own port is the strongest signal; but in
      // go-mode the funnel targets the Go front door (:8443) which then
      // proxies to this Node process (:8442), so the ports differ. On a
      // single-owner box every loopback funnel is still part of OUR stack,
      // so treat any loopback target as a (slightly weaker) match.
      let pointsAtBridge = false;
      let pointsAtLoopback = false;
      for (const h of Object.values(handlers)) {
        const proxy = (h as any)?.Proxy;
        if (typeof proxy !== 'string') continue;
        try {
          const u = new URL(proxy);
          if (isLoopback(u.hostname)) {
            pointsAtLoopback = true;
            if (u.port === targetPort) {
              pointsAtBridge = true;
              break;
            }
          }
        } catch {
          /* malformed Proxy — skip */
        }
      }
      const colon = hostPort.lastIndexOf(':');
      if (colon < 0) continue;
      const host = hostPort.slice(0, colon);
      const port = hostPort.slice(colon + 1);
      const isTls = port === '443' || (parsed.TCP && parsed.TCP[port]?.HTTPS === true);
      const proto = isTls ? 'https' : 'http';
      const url = isTls && port === '443' ? `${proto}://${host}` : `${proto}://${host}:${port}`;
      if (pointsAtBridge) {
        match = url;
        break;
      }
      if (pointsAtLoopback && !loopbackMatch) loopbackMatch = url;
      if (!fallback) fallback = url; // any served public host, even if we couldn't confirm the target
    }
    return match || loopbackMatch || fallback;
  } catch {
    return null; // tailscale missing, not running, or unparseable
  }
}

// MagicDNS fallback. `serve status` only yields a host once a funnel/serve
// is actually configured; `status --json` reports this node's own MagicDNS
// name (Self.DNSName) the moment it's on a tailnet at all. That name is how
// every other tailnet device — and Funnel, once enabled — reaches THIS box,
// so it's the right "works on every system" answer: it follows the machine
// rather than a hostname copied in from a previous install. Same 5-minute
// cache as the funnel probe.
let _tsDnsCache: { value: string | null; expires: number } | null = null;

function detectTailscaleMagicDNS(): string | null {
  const now = Date.now();
  if (_tsDnsCache && _tsDnsCache.expires > now) return _tsDnsCache.value;
  const value = probeTailscaleMagicDNS();
  _tsDnsCache = { value, expires: now + TS_CACHE_TTL_MS };
  return value;
}

function probeTailscaleMagicDNS(): string | null {
  try {
    const raw = execFileSync('tailscale', ['status', '--json'], {
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    const parsed = JSON.parse(raw);
    const dnsName = parsed?.Self?.DNSName;
    if (typeof dnsName !== 'string' || !dnsName) return null;
    // DNSName carries a trailing dot ("host.tailnet.ts.net."); strip it.
    const host = dnsName.replace(/\.+$/, '');
    if (!host) return null;
    // Tailnet hosts are HTTPS-fronted (Funnel and `tailscale serve` both
    // terminate TLS), so an https origin is the correct construction.
    return `https://${host}`;
  } catch {
    return null; // tailscale missing, not running, or unparseable
  }
}

// ── YHA Net peer bearer verification (for cross-node proxy /v1/net/nodes/:id/*)
// Net tokens live in the yhaNetNodes[] array inside prefs.json (the self entry's
// .token is *this* node's secret; peer entries hold the secrets of others).
// We load on-demand (sync, cheap) and cache only until prefs.json changes. That
// keeps the "Regen" button honest: a fresh self token is accepted immediately
// without a bridge restart, and the previous token stops working immediately
// once peers are updated.
let _netSelfTokenCache: string | null = null;
let _netSelfTokenMtimeMs = -1;

function loadNetSelfToken(): string | null {
  try {
    const st = fs.statSync(PREFS_PATH);
    if (_netSelfTokenMtimeMs === st.mtimeMs) return _netSelfTokenCache;
    _netSelfTokenMtimeMs = st.mtimeMs;
    const raw = fs.readFileSync(PREFS_PATH, 'utf8');
    const p = JSON.parse(raw);
    const nodes = Array.isArray(p && p.yhaNetNodes) ? p.yhaNetNodes : [];
    let self = nodes.find((n: any) => n && n.isSelf);
    if (!self && nodes.length > 0) self = nodes[0]; // tolerate pre-isSelf data
    const t = self && typeof self.token === 'string' ? String(self.token).trim() : '';
    _netSelfTokenCache = t || null;
    return _netSelfTokenCache;
  } catch (_) {
    _netSelfTokenMtimeMs = -1;
    _netSelfTokenCache = null;
    return null;
  }
}

function verifyNetBearer(headerValue: string | undefined): {
  email: string;
  name: string;
  allowed: boolean;
  id: string;
} | null {
  if (!headerValue || typeof headerValue !== 'string') return null;
  const m = headerValue.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  if (!token) return null;
  const selfTok = loadNetSelfToken();
  if (!selfTok) return null;
  if (timingSafeEqualStr(selfTok, token)) {
    return {
      email: 'net-peer@localhost',
      name: 'YHA Net peer',
      allowed: true,
      id: 'yha-net',
    };
  }
  return null;
}

function registerTuiLinkRoutes(app: Express): void {
  // 1. PUBLIC — TUI starts a link.
  app.post('/auth/tui-link/start', (req: Request, res: Response) => {
    // Best-effort client label from body; we don't trust it for anything
    // privileged, just for display on the approval page.
    let label: string | undefined;
    try {
      label = (req.body && typeof req.body.label === 'string') ? req.body.label : undefined;
    } catch (_) {}
    const link = startLink(label);
    const origin = publicOrigin(req);
    res.json({
      linkId: link.id,
      url: `${origin}/auth/tui-confirm/${encodeURIComponent(link.id)}`,
      expiresAt: link.expiresAt,
    });
  });

  // 2. PUBLIC — TUI polls for approval.
  app.get('/v1/tui-link/poll/:id', (req: Request, res: Response) => {
    const link = pollLink(String(req.params.id));
    if (!link) return res.status(404).json({ status: 'expired' });
    if (link.status === 'approved') {
      return res.json({
        status: 'approved',
        token: link.token,
        email: link.email,
        name: link.name,
        expiresAt: link.tokenExpiresAt,
      });
    }
    return res.json({ status: link.status });
  });

  // 3. AUTHENTICATED — browser-side confirmation page. Gated by the
  // existing authMiddleware because we register the route alongside the
  // other auth routes; if no session is present the middleware redirects
  // to /auth/login first and brings the user back here.
  app.get('/auth/tui-confirm/:id', (req: Request, res: Response) => {
    const id = String(req.params.id);
    const link = pollLink(id);
    const u = (req as any).session?.user;
    if (!u) {
      // Bounce through WorkOS, then we'll land back here with a session.
      return res.redirect('/auth/login?returnTo=' + encodeURIComponent(req.originalUrl));
    }
    if (!link) {
      res.status(404).type('html').send(
        renderConfirmPage({
          linkId: id,
          user: u,
          status: 'expired',
        })
      );
      return;
    }
    res.type('html').send(
      renderConfirmPage({
        linkId: link.id,
        user: u,
        clientLabel: link.clientLabel,
        status: link.status,
      })
    );
  });

  // 4. AUTHENTICATED — browser-side approve POST.
  app.post('/auth/tui-confirm/:id/approve', (req: Request, res: Response) => {
    const u = (req as any).session?.user;
    if (!u) return res.status(401).json({ error: 'Unauthorized' });
    const ttlSec = Number(req.body?.ttlSec || TTL_PRESETS.day);
    if (!Number.isFinite(ttlSec) || ttlSec < 60) {
      return res.status(400).json({ error: 'ttlSec must be ≥ 60' });
    }
    const link = approveLink({
      id: String(req.params.id),
      ttlSec,
      user: { email: u.email, name: u.name, allowed: !!u.allowed, id: u.id || '' },
    });
    if (!link) return res.status(404).json({ error: 'link not found or already settled' });
    res.json({ ok: true, status: link.status, expiresAt: link.tokenExpiresAt });
  });

  // 5. AUTHENTICATED — browser-side deny POST.
  app.post('/auth/tui-confirm/:id/deny', (req: Request, res: Response) => {
    const u = (req as any).session?.user;
    if (!u) return res.status(401).json({ error: 'Unauthorized' });
    const link = denyLink(String(req.params.id));
    if (!link) return res.status(404).json({ error: 'link not found or already settled' });
    res.json({ ok: true, status: link.status });
  });

  // 6. AUTHENTICATED — list / revoke active tokens. Backs a future
  // "active TUI tokens" page; for now exposes the data so the user can
  // audit / yank from curl if needed.
  app.get('/v1/tui-tokens', (_req: Request, res: Response) => {
    res.json({ tokens: listTokens() });
  });

  app.post('/v1/tui-tokens/revoke', (req: Request, res: Response) => {
    const tok = typeof req.body?.token === 'string' ? req.body.token : '';
    if (!tok) return res.status(400).json({ error: 'token required' });
    const ok = revokeToken(tok);
    if (!ok) return res.status(404).json({ error: 'not found' });
    res.json({ ok: true });
  });
}

// Public paths the bridge must serve WITHOUT a WorkOS session — the TUI
// has no cookie when it pings these, and the confirmation-page redirect
// to /auth/login already routes the user through WorkOS if needed.
const TUI_LINK_PUBLIC_PATHS = new Set<string>([
  '/auth/tui-link/start',
]);

function isTuiLinkPublicPath(reqPath: string): boolean {
  if (TUI_LINK_PUBLIC_PATHS.has(reqPath)) return true;
  // Poll endpoint has a dynamic id segment.
  return reqPath.startsWith('/v1/tui-link/poll/');
}

module.exports = {
  registerTuiLinkRoutes,
  verifyBearer,
  isTuiLinkPublicPath,
  // YHA Net peer auth (accepts a fleet node's bearer as a synthetic allowed user
  // so /v1/* proxy routes work server-to-server without browser cookies).
  verifyNetBearer,
  // Exposed for the YHA Net self-detect route (config/net-routes.ts). Both are
  // pure, cached read-only probes — reused so node identity is derived from the
  // same source of truth as the TUI-link approval URL, never a duplicate guess.
  detectTailscaleMagicDNS,
  detectTailscalePublicURL,
};
