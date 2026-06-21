#!/usr/bin/env bun
// YHA Bridge Server — entry point
'use strict';

const fs = require('fs');
const path = require('path');

{
  const envPath = path.join(__dirname, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      const val = t
        .slice(eq + 1)
        .trim()
        .replace(/^(['"])(.*)\1$/, '$2');
      if (key && !(key in process.env)) process.env[key] = val;
    }
  }
}

const express = require('express');
const session = require('express-session');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const { authMiddleware, trustMiddleware, registerAuthRoutes, AUTH_ENABLED } = require('./core/auth');
const { registerSecurityRoutes } = require('./core/security');

const os = require('os');
const { PORT, CLAUDE_BIN, config, UPLOADS_DIR } = require('./core/state');
const { loadSessionsFromDisk } = require('./sessions-internal');
const { buildModelList } = require('./models');
const { getModuleApi } = require('./core/modules');
// `registerMcpRoutes` and `registerMcpBridgeRoutes` were here. Moved
// into the `mcp-client` module — activated via bridge/modules.json.
// MCP autostart now reads the lib through getModuleApi('mcp-client')
// inside `server.listen` so disabling mcp-client cleanly skips the
// autostart block instead of failing at file-load time.
const { createProxyMiddleware: _createProxyMiddleware } = require('http-proxy-middleware');
const { LOG_DIR, SESSION_FILE_PATH, closeAllStreams: _closeRawLogStreams } = require('./observability/raw-logs');
const { registerConfigRoutes } = require('./config/handler');
const { registerConfigVersionRoutes } = require('./config/versions');
// `registerFileManagerRoutes` was here. Moved into the `files-manager`
// module — activated via bridge/modules.json + the loader.
// `initTriggers` + `registerTriggerRoutes` and `initWorkflows` +
// `registerWorkflowRoutes` were here. Moved into the
// `workflows-and-triggers` module — activated via bridge/modules.json.
// `initEmployees` + `registerEmployeeRoutes` were here. Moved into the
// `multichat-personnel` module — activated via bridge/modules.json. The
// `getEmployee` export is still pulled by bridge/routes/sessions.ts and
// bridge/chat/helpers.ts from the new path.
const { registerProxyRoutes } = require('./routes/proxy');
const { registerInternalRoutes } = require('./routes/internal');
const { registerYhaTuiRoutes } = require('./routes/yha-tui');
const { registerChatRoutes } = require('./routes/chat');
const { registerCommandRoute } = require('./routes/command');
const { registerHashToolRoute } = require('./routes/hash-tool');
const { registerImportantRoutes } = require('./routes/important');
const { registerCodeViewRoutes } = require('./routes/code-view');
const { registerCwdContextRoutes } = require('./routes/cwd-context');
const { registerContextRagRoutes } = require('./routes/context-rag');
// `registerInputHistoryRoutes` + `registerDraftRoutes` were here. Moved
// into the `chat-extras` module — activated via bridge/modules.json.
// `registerContextItemRoutes` + `registerContextSensitivityRoutes` were
// here. Moved into the `context` module — activated via bridge/modules.json
// + the loader.
// `registerPetConsoleRoutes` was here. Moved into the `pet` module —
// activated via bridge/modules.json + the loader.
// `registerLinkRoutes` was here. Moved into the `link` module —
// activated via bridge/modules.json + the loader.
// `registerServeRoutes` was here. Moved into the `files-serve-preview`
// module — activated via bridge/modules.json. The `serveLib` runtime
// library stays in core because the /proxy/serve/:id middleware, WS
// upgrade hook, and shutdown drain (`killAllSync`) below are wired
// directly into server.ts and can't move without breaking the proxy.
const serveLib = require('./files/serve');
// `promoteMcpTools` was a top-level require here. Moved to a
// getModuleApi('mcp-client').promoteMcpTools lookup inside
// `server.listen` so disabling mcp-client cleanly skips MCP fan-out.
const { registerSessionRoutes } = require('./routes/sessions');
// `registerMetaBridgeRoutes` + `metaLib` were here. Moved into the
// `skills-editor` module — activated via bridge/modules.json + the loader.
// The first-boot migration of legacy bridge/skills/*.md now runs inside
// the module's activate() instead of from server.ts.
const { registerSystemRoutes, refreshAllModels } = require('./routes/system');
// `registerTodoRoutes` was here. Moved into the `todos` module —
// activated via bridge/modules.json + the loader.
// `registerGithubRoutes` was here. Moved into the `files-github` module —
// activated via bridge/modules.json + the loader.
// `registerCostRoutes` was here. Moved into the `observability-plus` module —
// activated via bridge/modules.json + the loader.
// `registerSearchRoutes` was here. Moved into the `search` module —
// activated via bridge/modules.json + the loader.
const { registerApiKeyRoutes } = require('./config/api-keys');
// `loadGreetings` + `registerGreetingsRoutes` were here. Moved into
// the `welcome-messages` module — activated via bridge/modules.json.
// `registerPetHatchRoutes` was here. Moved into the `pet` module.
const { startInternalApiServer } = require('./chat/openai-internal');
// `partners-internal/routes` was here. Moved into the
// `multichat-partners` module — activated via bridge/modules.json. The
// module's activate() does what `registerPartnerRoutes(app)` +
// `initPartners()` did from server.ts, so neither call survives below.

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '5mb' }));
app.use(
  compression({
    filter: (req, res) => {
      const ct = String(res.getHeader('Content-Type') || '');
      if (ct.includes('text/event-stream')) return false;
      if (String(req.headers.accept || '').includes('text/event-stream')) return false;
      return compression.filter(req, res);
    },
  })
);

// ── Request timeout ───────────────────────────────────────────────────────
// Prevent slowloris / hanging connections from exhausting the connection pool.
// SSE / event-stream connections are long-lived; everything else gets 60s.
//
// MCP proxy paths (yha-bridge-stub.js → /proxy/mcp-bridge/rpc) carry tool
// calls that may legitimately run for many minutes — media gen (Lyria audio,
// Veo video), long-running agent tools (mcp__agent-tools__call_agent), and
// future agent-style operations. They get a 20-minute ceiling so the actual
// timeout enforcement lives one layer down (Go's per-server callTimeoutFor
// in go-core/internal/mcp/routes.go, currently media-gen=5m, agent-tools=20m).
//
// Phase 7 note: the old `/v1/stream/` path-prefix check is gone — the Node
// POST stream route was deleted, and Go now owns /v1/stream-direct/. The
// reverse proxy at /v1/* still forwards arbitrary requests Node-ward, so
// the Accept-based SSE check below stays as the catch-all for any
// long-lived response a module might emit.
app.use((req, _res, next) => {
  const isSSE = String(req.headers.accept || '').includes('text/event-stream');
  const isMcpProxy = req.url?.startsWith('/proxy/mcp-bridge/') === true;
  const ms = isSSE ? 0 : isMcpProxy ? 20 * 60_000 : 60_000;
  req.setTimeout(ms, () => {
    if (!req.destroyed) req.destroy(new Error('Request timeout'));
  });
  next();
});

// Read vs write limiters on /v1/. Polled GETs (mcp status, sessions list,
// monitoring, knowledge status, etc.) easily produce 80+ requests/min on
// boot or while a stream is running — the old combined 120/min limit
// tripped instantly. Writes stay tight because they're user-driven and
// expensive.
// Bucket key for every limiter. `trust proxy: 1` (above) makes req.ip derive
// from the right-most X-Forwarded-For hop. An external funnel client can rotate
// that header to mint a fresh bucket per request and slip the limit entirely.
// The TCP peer (req.socket.remoteAddress) is unspoofable: under the go-core
// reverse proxy all funnel traffic collapses onto the loopback peer — one
// shared bucket, intentionally coarse on a single-user box — while direct
// local clients still bucket on their own address. Keying on the socket peer
// also sidesteps express-rate-limit's trust-proxy permissive-IP validation,
// which only runs inside its default (req.ip-based) generator.
const limiterKey = (req: any) => req.socket?.remoteAddress || req.ip || 'unknown';

const apiReadLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_API_READ_WINDOW_MS || 60_000),
  max: Number(process.env.RATE_LIMIT_API_READ_MAX || 600),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: limiterKey,
  message: { success: false, error: 'Too many read requests — slow down polling.' },
});

const apiWriteLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_API_WRITE_WINDOW_MS || 60_000),
  max: Number(process.env.RATE_LIMIT_API_WRITE_MAX || 120),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: limiterKey,
  message: { success: false, error: 'Too many write requests — try again in a minute.' },
});

const llmLimiter = rateLimit({
  windowMs: Number(process.env.RATE_LIMIT_LLM_WINDOW_MS || 60_000),
  max: Number(process.env.RATE_LIMIT_LLM_MAX || 30),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: limiterKey,
  message: { success: false, error: 'Too many LLM requests — slow down.' },
});

app.use('/v1/', (req, res, next) => {
  const limiter = req.method === 'GET' || req.method === 'HEAD' ? apiReadLimiter : apiWriteLimiter;
  return limiter(req, res, next);
});
app.use('/proxy/', (req, res, next) => {
  // /proxy/serve/* (reverse proxy to per-CWD live-preview servers) and
  // /proxy/browser/* (KasmVNC stream) are not LLM traffic — they can
  // fire 30+ requests per page load for static assets and would exhaust
  // the LLM budget instantly. Bypass the LLM rate limiter for those.
  if (req.path.startsWith('/serve/') || req.path.startsWith('/browser/')) return next();
  return llmLimiter(req, res, next);
});

// Route-level telemetry — fires once per response so the "Routes" tab in the
// monitoring modal can show per-endpoint call frequency, latency, and error
// rate. We collapse `/v1/sessions/<id>/...` style paths to a stable key by
// preferring req.route.path (set by Express after match) and falling back to
// the literal request path. Polled GETs dominate volume; per-method
// disambiguation is done by the aggregator.
app.use((req, res, next) => {
  const t0 = Date.now();
  const obs = getModuleApi('observability-plus');
  res.once('finish', () => {
    if (!obs) return;
    // Skip very-noisy paths that would drown out everything else. Static
    // assets and the generic /v1/ aggregate ratelimit middleware already
    // do their own logging.
    const p = req.path || '';
    if (
      p === '/health' ||
      p === '/' ||
      p.startsWith('/uploads') ||
      p.startsWith('/exchange') ||
      p === '/yha' ||
      p === '/yha.html' ||
      p === '/ypa' ||
      p === '/ypa.html' ||
      p.startsWith('/local-image')
    ) return;
    // Prefer the matched route pattern (e.g. /v1/sessions/:id) over the raw
    // path so dashboards group hits properly. Falls back to a coarse-grained
    // bucket (`/v1/<first segment>`) for unmatched requests so the panel
    // still shows something.
    const routeKey = (req as any).route?.path || _coarseBucket(p);
    const status = res.statusCode;
    obs.telemetry.record({
      surface: 'route',
      name: `${req.method} ${routeKey}`,
      durationMs: Date.now() - t0,
      ok: status < 400,
      meta: { status, path: p },
    });
  });
  next();
});
function _coarseBucket(p: string): string {
  // /v1/sessions/abc → /v1/sessions/*  ; /proxy/foo → /proxy/*
  const segs = p.split('/').filter(Boolean);
  if (segs.length <= 2) return '/' + segs.join('/');
  return '/' + segs.slice(0, 2).join('/') + '/*';
}

const allowedOrigins = new Set([
  `http://localhost:${PORT}`,
  `http://127.0.0.1:${PORT}`,
  'http://localhost:5173',
  'http://127.0.0.1:5173',
  `https://${os.hostname()}`,
  ...(process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(',').map((s) => s.trim()) : []),
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin) {
    try {
      const parsed = new URL(origin);
      if (allowedOrigins.has(parsed.origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
      }
    } catch {
      /* invalid origin — skip */
    }
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

const USE_HTTP = process.env.USE_HTTP === 'true';

if (!USE_HTTP) {
  app.use((req, res, next) => {
    if (req.headers['x-forwarded-proto'] === 'http' || req.protocol === 'http') {
      const host = req.get('host');
      if (host) return res.redirect(301, `https://${host}${req.originalUrl}`);
    }
    next();
  });
  app.use((req, res, next) => {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    next();
  });
}

const SESSION_SECRET = process.env.SESSION_SECRET;
if (!SESSION_SECRET) {
  console.error('FATAL: SESSION_SECRET environment variable is not set.');
  console.error('Generate one with: openssl rand -hex 32');
  console.error('Then add to bridge/.env: SESSION_SECRET=<your-random-string>');
  process.exit(1);
}

// ── Bind host (fail-closed when auth is disabled) ───────────────────────────
// authMiddleware passes every request through when AUTH_ENABLED is false
// (WorkOS env unset). Listening on 0.0.0.0 in that state would publish an
// unauthenticated bridge to the LAN / tailnet / public internet. So unless
// auth is enabled, we refuse to bind anywhere but loopback. An operator who
// explicitly points YHA_BIND_HOST at a non-loopback address with auth off is
// almost certainly making a mistake — fail fast rather than expose the bridge.
const _isLoopbackHost = (h: string) =>
  h === '127.0.0.1' || h === '::1' || h === 'localhost' || h === '';
const BIND_HOST: string =
  process.env.YHA_BIND_HOST || (AUTH_ENABLED ? '0.0.0.0' : '127.0.0.1');
if (!AUTH_ENABLED && !_isLoopbackHost(BIND_HOST)) {
  console.error(
    `FATAL: auth is disabled (WORKOS_API_KEY / WORKOS_CLIENT_ID unset) but ` +
      `YHA_BIND_HOST="${BIND_HOST}" is not loopback.`
  );
  console.error(
    'Refusing to expose an unauthenticated bridge to the network. Configure ' +
      'WorkOS auth, or bind to 127.0.0.1.'
  );
  process.exit(1);
}
if (!AUTH_ENABLED) {
  console.warn(
    `[auth] WorkOS auth DISABLED — binding to loopback (${BIND_HOST}) only. ` +
      'Set WORKOS_API_KEY + WORKOS_CLIENT_ID to enable auth and non-loopback binds.'
  );
}

// HSTS — Strict-Transport-Security. Tells the browser "for this origin,
// always use HTTPS, even if the user types http://". Only emitted when
// the request came in over HTTPS (direct or via TLS-terminating proxy
// like tailscale funnel — go-core stamps X-Forwarded-Host; funnel hosts
// always serve HTTPS). Sending HSTS over plain HTTP is a no-op per spec,
// but skipping it avoids noise.
//
// max-age: 6 months. Long enough that the upgrade-to-HTTPS sticks across
// browser sessions; short enough that a misconfigured deploy unwinds
// reasonably fast. includeSubDomains intentionally omitted — tailnet
// siblings may or may not have funnel TLS configured.
app.use((req: any, res: any, next: any) => {
  const fwdProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const fwdHost = String(req.headers['x-forwarded-host'] || req.headers['host'] || '');
  const tlsFronted =
    fwdHost.endsWith('.ts.net') ||
    fwdHost.endsWith('.tailscale.net') ||
    fwdHost.endsWith('.tailnet.ts.net');
  const isHttps = req.secure || fwdProto === 'https' || tlsFronted;
  if (isHttps) {
    res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  }
  next();
});

app.use(
  session({
    secret: SESSION_SECRET,
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: !USE_HTTP,
      httpOnly: true,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      sameSite: 'lax',
    },
  })
);
// Phase 2d: accept Go-issued X-Yha-Trust headers so /v1/* works for
// users authenticated via yha-core's /auth/* (yha.sid) without needing
// a Node-side connect.sid. Runs after express-session so it can write
// into req.session.user.
app.use(trustMiddleware);
registerAuthRoutes(app);
// Go-callback endpoints — gated by x-bridge-key (BRIDGE_INTERNAL_KEY).
// Must mount BEFORE authMiddleware so Go's stream loop can hit them
// without a WorkOS session. See bridge/routes/internal.ts for the
// list and bridge/modules/mcp-client/lib/bridge.ts for /proxy/tool.
registerInternalRoutes(app);
// Public temporary Serve shares intentionally bypass normal app auth; the
// unguessable token + expiry/revoke state is the authorization boundary.
app.use('/share/:token', serveLib.buildServeProxyMiddleware('share'));
app.use(authMiddleware);

const frontendDir = path.join(__dirname, '..', 'frontend');
const frontendDistDir = path.join(frontendDir, 'dist');
const useFrontendDist = process.env.YHA_USE_DIST === 'true' && fs.existsSync(frontendDistDir);
const appFrontendDir = useFrontendDist ? frontendDistDir : frontendDir;
const exchangeDir = path.join(__dirname, 'mcp', 'exchange');

app.get('/', (req, res, next) => {
  if (!AUTH_ENABLED) return res.redirect('/ypa');
  next();
});

// Vite dev middleware — when no built dist is in use, the bridge embeds Vite
// in middleware mode so the frontend is served on the SAME port as the API.
// Removes the address-bar :5173 jump the previous redirect introduced and
// keeps dev URLs identical to prod. Actual createServer() runs in bootHttp()
// below because Vite's HMR wants the http server reference.
let viteDevServer: { middlewares: any; close: () => Promise<void> } | null = null;
const viteHandler = (req: any, res: any, next: any) =>
  viteDevServer ? viteDevServer.middlewares(req, res, next) : next();

// ── Internal app-naming rebrand ──────────────────────────────────────────
// `/brand.js` emits `window.__YHA_BRAND` synchronously from the
// INTERNAL_APP_NAMING / INTERNAL_APP_SLOGAN env vars (read at server-boot
// time; reflected in the shipped JS without an extra HTTP fetch). When
// neither is set, the script body is a no-op and the frontend falls back
// to its compiled-in defaults ("YHA" / "Your Home Agent · Home is where
// your agent lives.").
//
// Loaded synchronously in both yha.html and index.html so the first
// React render — and any text-node DOM-walker pass — sees the configured
// name and slogan. Designed as a small private rebrand switch for
// pre-launch naming experiments; documented inline.
app.get('/brand.js', (_req, res) => {
  const name = (process.env.INTERNAL_APP_NAMING || '').trim();
  const slogan = (process.env.INTERNAL_APP_SLOGAN || '').trim();
  const payload = { name: name || null, slogan: slogan || null };
  // Set explicit no-cache: when a developer changes their .env mid-session,
  // the next page reload should pick the new value up without a hard reload.
  res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache');
  res.end(`window.__YHA_BRAND = ${JSON.stringify(payload)};`);
});

if (useFrontendDist) {
  // Production-style: serve the pre-built HTML directly.
  // `/ypa` is the canonical frontend route ("Your Personal Agent"). `/yha`
  // (the backend's name) 301s to it so existing bookmarks, PWA installs,
  // and any out-of-repo wiring continue to work during the transition.
  app.get('/ypa', (_req, res) => res.sendFile(path.join(appFrontendDir, 'yha.html')));
  app.get('/ypa.html', (_req, res) => res.sendFile(path.join(appFrontendDir, 'yha.html')));
  app.get(['/yha', '/yha.html'], (_req, res) => res.redirect(301, '/ypa'));
  app.use(express.static(appFrontendDir));
} else {
  // Dev mode notes:
  //
  //   We use appType: 'custom' in initViteMiddleware below — NOT 'mpa'. In
  //   'spa'/'mpa' modes Vite's middleware chain ends with notFoundMiddleware
  //   which 404s anything Vite doesn't own (see Vite v8 source: src/node/
  //   server/middlewares/notFound.ts). That blackholes /v1/*, /auth/*, etc.
  //   In 'custom' the chain calls next() for unmatched paths, so API routes
  //   below this point actually receive requests.
  //
  //   Trade-off: 'custom' also disables Vite's automatic HTML serving, so we
  //   reproduce /ypa (and /ypa.html) ourselves below — read yha.html, run it
  //   through vite.transformIndexHtml (injects HMR client + rewrites imports),
  //   respond. This is the canonical pattern from Vite's own SSR/custom docs.
  app.use(viteHandler);

  const yhaHtmlPath = path.join(frontendDir, 'yha.html');
  app.get(['/ypa', '/ypa.html'], async (req: any, res: any, next: any) => {
    if (!viteDevServer) return next();
    try {
      const raw = fs.readFileSync(yhaHtmlPath, 'utf-8');
      const transformed = await (viteDevServer as any).transformIndexHtml(req.originalUrl || req.url, raw);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(transformed);
    } catch (e) {
      (viteDevServer as any).ssrFixStacktrace?.(e);
      next(e);
    }
  });
  app.get(['/yha', '/yha.html'], (_req, res) => res.redirect(301, '/ypa'));
}

// Fallback static for the unbundled frontend dir. Catches:
//   - `/` → frontend/index.html (the landing page that view-transitions into /yha)
//   - /favicon.svg, /restricted.html, /manifest.webmanifest, etc.
// In BUILD mode (appFrontendDir = dist) the dist static above wins for
// bundled assets; this catches everything not emitted into dist. In DEV mode
// (appFrontendDir = frontendDir) the viteHandler above wins for /src/* + /yha
// + node_modules; this only runs for paths Vite calls next() on.
app.use(express.static(frontendDir));
// Pet sprites + manifests need explicit Cache-Control so the browser
// re-validates after every save in the FrameNudgeModal. Without this,
// express.static omits Cache-Control entirely, the browser falls back to
// heuristic freshness (typically 10 % of Last-Modified age), and a sprite
// edited 5 seconds after upload can stay cached for hours despite the file
// having changed on disk. The wizard already query-string cache-busts
// (?nudge=<ts>) for the live pet, but a hard-reload re-fetches the
// manifest with bare URLs — at which point the browser would happily
// serve the stale cached PNG. `no-cache` forces a conditional GET (the
// 304 path is cheap), and we apply it BEFORE the broader public-static
// handler so it wins for /pets/* paths only.
app.use(
  '/pets',
  express.static(path.join(frontendDir, 'public', 'pets'), {
    setHeaders: (res) => {
      // `no-cache` = "always revalidate", not "never store". The browser
      // still reuses bytes when the server replies 304, so this is cheap.
      res.setHeader('Cache-Control', 'no-cache');
    },
  })
);
// Always serve frontend/public/ live so files written after build (e.g.
// hatch-wizard pet uploads → frontend/public/pets/<id>/) appear without a rebuild.
app.use(express.static(path.join(frontendDir, 'public')));
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/exchange', express.static(exchangeDir));

// Serve local files generated by tools/AI — validated against allowed roots, auth required
app.get('/local-image', (req, res) => {
  const filePath = typeof req.query.path === 'string' ? req.query.path : '';
  // path.isAbsolute accepts both POSIX (/var/...) and Windows drive paths
  // (C:\...). The old `startsWith('/')` rejected every legitimate Windows path.
  if (!filePath || !path.isAbsolute(filePath)) return res.status(400).send('Bad path');
  const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
  // os.tmpdir() instead of a hardcoded '/tmp/' (dead on Windows, where temp
  // lives under %LOCALAPPDATA%\Temp).
  const roots = [os.tmpdir(), HOME, UPLOADS_DIR].map((r) => path.resolve(r));
  const within = (child: string, parent: string) => child.startsWith(parent + path.sep);
  // Lexical authorization first (no FS access) so a clearly out-of-bounds path
  // gets 403 without leaking whether the file exists.
  const lexical = path.resolve(filePath);
  if (!roots.some((r) => within(lexical, r))) return res.status(403).send('Forbidden');
  // Canonicalize to defeat symlink escapes: a path that is lexically inside an
  // allowed root but symlinks out must still be rejected. realpathSync also
  // throws when the target is missing, which doubles as the 404 check.
  let real: string;
  try { real = fs.realpathSync(lexical); }
  catch { return res.status(404).send('Not found'); }
  const realRoots = roots.map((r) => { try { return fs.realpathSync(r); } catch { return r; } });
  if (!realRoots.some((r) => within(real, r))) return res.status(403).send('Forbidden');
  return res.sendFile(real);
});

app.use('/proxy/', express.json({ limit: '2mb' }));
registerProxyRoutes(app);
registerImportantRoutes(app);
registerCodeViewRoutes(app);
registerCwdContextRoutes(app);
registerContextRagRoutes(app);
// `registerInputHistoryRoutes(app)` + `registerDraftRoutes(app)` were
// here. Now in `bridge/modules/chat-extras/`.
// `registerContextItemRoutes(app)` + `registerContextSensitivityRoutes(app)`
// were here. Now in `bridge/modules/context/`.
// `registerPetConsoleRoutes(app)` was here. Now in `bridge/modules/pet/`.
// `registerLinkRoutes(app)` was here. Now in `bridge/modules/link/`.
registerChatRoutes(app);
registerCommandRoute(app);
registerHashToolRoute(app);
registerSessionRoutes(app);
registerSystemRoutes(app);
registerSecurityRoutes(app);
// `registerTodoRoutes(app)` was here. Now in `bridge/modules/todos/`.
// `registerGithubRoutes(app)` was here. Now in `bridge/modules/files-github/`.
// `registerCostRoutes(app)` was here. Now in `bridge/modules/observability-plus/`.
// `registerSearchRoutes(app)` was here. Now in `bridge/modules/search/`.
registerApiKeyRoutes(app);
// loadGreetings() + registerGreetingsRoutes(app) were here. Now the
// `welcome-messages` module owns them.
// `registerPetHatchRoutes(app)` was here. Now in `bridge/modules/pet/`.

// First-boot migration of legacy bridge/skills/*.md and
// `registerMetaBridgeRoutes(app)` were here. Both moved into the
// `skills-editor` module — the migration now runs in that module's
// activate() so disabling skills-editor also stops the migration.

// ── Telemetry control surface ─────────────────────────────────────────────
// GET  /v1/telemetry          — return current state + lifetime counters
// POST /v1/telemetry          — { enabled: bool } toggle (used by the debug
//                                modal "Tools, Skills & MCP" Overview tab).
{
  app.get('/v1/telemetry', (_req, res) => {
    const obs = getModuleApi('observability-plus');
    if (!obs) return res.status(501).json({ success: false, error: 'observability-plus module is disabled' });
    res.json({ success: true, enabled: obs.telemetry.isEnabled(), lifetime: obs.telemetry.lifetimeCounts() });
  });
  app.post('/v1/telemetry', (req, res) => {
    const obs = getModuleApi('observability-plus');
    if (!obs) return res.status(501).json({ success: false, error: 'observability-plus module is disabled' });
    const enabled = req.body?.enabled !== false;
    obs.telemetry.setEnabled(enabled);
    res.json({ success: true, enabled });
  });
}

// `registerMcpRoutes(app)` + `registerMcpBridgeRoutes(app)` were here.
// Now in `bridge/modules/mcp-client/index.ts` (activated by the loader
// below).

// /proxy/browser/* — reverse proxy to the desktop-browser MCP's KasmVNC
// surface (Chromium-in-Docker on 127.0.0.1:3011). Same-origin under YHA's
// HTTPS so the BrowserWindow iframe avoids mixed-content blocking.
const _browserProxy = _createProxyMiddleware({
  target: 'http://127.0.0.1:3011',
  ws: true,
  changeOrigin: true,
  pathRewrite: { '^/proxy/browser': '' },
  logger: undefined,
});
app.use('/proxy/browser', _browserProxy);

// /proxy/serve/:id/* — reverse proxy to per-CWD live-preview servers spawned
// by server-serve.ts. Same-origin under YHA's HTTPS so iframe avoids
// mixed-content blocking. WebSocket upgrades handled below in server.on('upgrade').
app.use('/serve/:id', serveLib.buildServeProxyMiddleware('serve'));
app.use('/proxy/serve/:id', serveLib.buildServeProxyMiddleware('proxy'));

// /__rewind/* — reverse proxy to the standalone yha-rewind service
// (pm2 process, default :8445). Lets the frontend watchdog overlay and
// the App-Command-Palette `/rewind` shortcut reach the recovery UI
// through the bridge's own TLS / Tailscale Funnel without needing the
// rewind port to be exposed separately. The rewind service is the
// authoritative target — if the bridge itself dies, the user opens
// :8445 directly (which is the whole reason it lives in its own
// process; see go-core/cmd/yha-rewind/main.go).
const _rewindPort = process.env.YHA_REWIND_PORT || '8445';
const _rewindProxy = _createProxyMiddleware({
  target: `http://127.0.0.1:${_rewindPort}`,
  changeOrigin: true,
  pathRewrite: { '^/__rewind': '' },
  logger: undefined,
});
app.use('/__rewind', _rewindProxy);

// /__yha/api/* — operator console HTTP shim. POSTs translate into
// YHA-TUI-Daemon unix-socket envelopes (bridge/state/yha-tui/daemon.sock).
// Same auth gate as the rest of /v1/*; the loopback socket itself is
// mode 0600 so this route is the only network-reachable surface.
// See bridge/routes/yha-tui.ts and docs/YHA-TUI-Replacement-Plan.md.
registerYhaTuiRoutes(app);

// `registerServeRoutes(app)` was here. Now in `bridge/modules/files-serve-preview/`.
registerConfigRoutes(app);
// Boot-time harness path self-heal — re-detect claude/codex binaries and
// rewrite config.json wherever the stored path no longer exists. Survives
// Claude Code auto-updates that move the exe to a new versioned subdir.
// Fire-and-forget; failures log but don't block startup.
if (typeof (app as any)._initHarnessAutoFix === 'function') {
  void (app as any)._initHarnessAutoFix();
}
registerConfigVersionRoutes(app);
// `registerFileManagerRoutes(app)` was here. Now in `bridge/modules/files-manager/`.
// `registerTriggerRoutes(app)` + `initTriggers()` and
// `registerWorkflowRoutes(app)` + `initWorkflows()` were here. Now in
// `bridge/modules/workflows-and-triggers/`.
// `registerEmployeeRoutes(app)` + `initEmployees()` were here. Now in
// `bridge/modules/multichat-personnel/`.
// `serverPartnerRoutes.registerPartnerRoutes(app)` + `.initPartners()`
// were here. Now in `bridge/modules/multichat-partners/`.
// `_ftpMod.registerFtpRoutes(app)` + `_ftpMod.initFtp()` were here. Now
// owned by the `files-ftp` module — activated via bridge/modules.json.
// `_ftpMod.registerRcloneRoutes(app)` was here. Now owned by the
// `files-rclone` module — activated via bridge/modules.json.

// Step 4 of docs/SQL-migration-plan.md: SQLite is now the canonical session
// store. The DB is opened unconditionally; loadSessionsFromDisk reads from
// it (not from bridge/sessions/*.json). The pre-Step-4 YHA_SQLITE_PREP flag
// is no longer consulted — there is no "JSON-only" mode anymore.
//
// Safety: if the historical JSON tree has sessions but the DB is missing or
// empty, we refuse to start. This catches the "forgot to run the migration
// after wiping bridge/data/" footgun, which would otherwise boot the bridge
// into an empty in-memory state and then start writing fresh sessions while
// the user's actual chat history sits unreferenced in bridge/sessions/.
{
  const dbMod = require('./sessions-internal/db');
  const fsBoot = require('fs');
  const pathBoot = require('path');
  const SESSIONS_INDEX_JSON = pathBoot.join(__dirname, 'sessions', 'index.json');

  try {
    dbMod.openDB();
  } catch (e) {
    console.error('[server] FATAL: failed to open sessions.db:', e instanceof Error ? e.message : String(e));
    console.error('         path:', dbMod.DEFAULT_DB_PATH);
    console.error('         run: bun tools/migrate-sessions-to-sqlite.mjs');
    process.exit(1);
  }

  const dbSessionCount = dbMod.countSessions();
  let jsonSessionCount = 0;
  try {
    if (fsBoot.existsSync(SESSIONS_INDEX_JSON)) {
      const idx = JSON.parse(fsBoot.readFileSync(SESSIONS_INDEX_JSON, 'utf8'));
      jsonSessionCount = Array.isArray(idx.sessions) ? idx.sessions.length : 0;
    }
  } catch (_) {
    /* index unreadable — treat as 0 */
  }

  if (dbSessionCount === 0 && jsonSessionCount > 0) {
    console.error('[server] FATAL: bridge/data/sessions.db has 0 rows but');
    console.error(`         bridge/sessions/index.json lists ${jsonSessionCount} sessions.`);
    console.error('         The legacy JSON history would be silently abandoned if we booted.');
    console.error('         Run the migration to import them:');
    console.error('           bun tools/migrate-sessions-to-sqlite.mjs --force');
    console.error('         Or, if you intentionally want a clean start, remove or move');
    console.error('         bridge/sessions/ out of the way before booting.');
    process.exit(1);
  }

  // Soft warning: if any JSON session file is newer than the DB's newest
  // updated_at, dual-write may have been disabled for some writes and the
  // DB is behind. Not fatal — operators sometimes re-migrate intentionally
  // — but worth surfacing.
  try {
    const dbLatest = dbMod.latestSessionUpdatedAt();
    const sessionsDir = pathBoot.join(__dirname, 'sessions');
    if (fsBoot.existsSync(sessionsDir)) {
      let newestJsonMtime = 0;
      let newerCount = 0;
      for (const file of fsBoot.readdirSync(sessionsDir)) {
        if (!file.endsWith('.json') || file === 'index.json') continue;
        try {
          const st = fsBoot.statSync(pathBoot.join(sessionsDir, file));
          if (st.mtimeMs > newestJsonMtime) newestJsonMtime = st.mtimeMs;
          if (st.mtimeMs > dbLatest) newerCount++;
        } catch (_) { /* skip unreadable file */ }
      }
      if (newerCount > 0 && newestJsonMtime > dbLatest + 60_000) {
        console.warn(`[server] WARNING: ${newerCount} session JSON file(s) newer than DB`);
        console.warn(`         newest JSON mtime: ${new Date(newestJsonMtime).toISOString()}`);
        console.warn(`         newest DB updated_at: ${new Date(dbLatest).toISOString()}`);
        console.warn(`         If those JSON writes matter, re-run:`);
        console.warn(`           bun tools/migrate-sessions-to-sqlite.mjs --force`);
        console.warn(`         (Safe to ignore if the JSON tree is the now-frozen archive.)`);
      }
    }
  } catch (_) {
    /* best-effort */
  }
}

loadSessionsFromDisk();

// Background workers — Phase 0 of the modular migration moved the
// previously-inline `start*Worker()` chain into one function. See
// `bridge/core/bootstrap-workers.ts` for the full list (sessions
// cleanup, auto-title, categorizer, sorter, file-categorizer, LINK).
const { startBackgroundWorkers } = require('./core/bootstrap-workers');
startBackgroundWorkers();

// ── Core harness register population ──────────────────────────────────────
// Phase 3 of the modular migration: the dispatch ladder in
// routes/chat.ts + routes/command.ts now reads from the `harnesses`
// register instead of importing the harness functions directly. This
// pins the four built-in harnesses (claude-sdk, claude-binary, codex,
// direct-api) with `core: true` so they are always present.
//
// Must run BEFORE the module loader so any module that reads from
// the harness register (e.g. a future MCP-config materializer that
// fans the registry into per-harness configs) sees the populated
// list.
const { registerCoreHarnesses } = require('./core/bootstrap-harnesses');
registerCoreHarnesses();

// ── Module loader ─────────────────────────────────────────────────────────
// Reads bridge/modules.json, boots every enabled module's activate(ctx),
// mounts each module's sub-router at /v1/<name>. Failure isolation: a
// bad module is logged + skipped, the bridge keeps booting (plan §4.4).
//
// Synchronous on purpose — Express's error-handling middleware (the
// `app.use((err, req, res, _next) => …)` block farther down) only
// catches errors from routes registered BEFORE it. Module routes must
// be mounted before that handler, so boot() runs to completion here.
const _modules = require('./core/modules');
_modules.registerModuleRoutes(app);
_modules.boot({ app });
// File watcher → auto-reload on edits under bridge/modules/**. The watcher
// is a no-op in production (YHA_USE_DIST=true) and can be disabled with
// YHA_NO_WATCH=1. Each module's lifecycle.reload posture controls whether
// a change triggers an immediate reload, an idle-only deferral, or is
// flagged as restart-required.
_modules.startWatcher(app);

const { BridgeError: _BridgeError } = require('./core/errors');
const _errLogger = require('./core/logger');

// ── Global error handler — catch BridgeErrors thrown by routes ─────────────
// Must come AFTER all route registration and BEFORE server.listen.
// Express identifies this as an error handler via the 4-param signature.

app.use((err, req, res, _next) => {
  if (err instanceof _BridgeError) {
    return res.status((err as any).statusCode).json({ success: false, error: err.message });
  }
  _errLogger.error('unhandled-error', {
    method: req.method,
    path: req.path,
    error: err instanceof Error ? err.message : String(err),
  });
  if (!res.headersSent) {
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

const proto = USE_HTTP ? 'http' : 'https';

let server;
if (USE_HTTP) {
  server = require('http').createServer(app);
} else {
  const certPath =
    process.env.TLS_CERT_PATH || path.join(__dirname, 'certs', 'server.crt');
  const keyPath =
    process.env.TLS_KEY_PATH || path.join(__dirname, 'certs', 'server.key');
  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    console.error(
      'FATAL: TLS cert or key not found. Set TLS_CERT_PATH and TLS_KEY_PATH in .env,\n' +
        `  or place files at: ${certPath} and ${keyPath}\n` +
        '  Or set USE_HTTP=true for plain HTTP (dev only).'
    );
    process.exit(1);
  }
  server = require('https').createServer(
    {
      cert: fs.readFileSync(certPath),
      key: fs.readFileSync(keyPath),
    },
    app
  );
}

// WS upgrade for /proxy/browser/* — KasmVNC streams the framebuffer over
// WebSocket. The proxy middleware exposes an upgrade handler we attach to
// the underlying HTTP/HTTPS server.
server.on('upgrade', (req, socket, head) => {
  if (req.url && req.url.startsWith('/proxy/browser')) {
    _browserProxy.upgrade(req, socket, head);
    return;
  }
  if (req.url && (req.url.startsWith('/proxy/serve/') || req.url.startsWith('/serve/'))) {
    if (serveLib.handleProxyUpgrade(req, socket, head)) return;
  }
});

const _lastExitPath = path.join(__dirname, 'last-exit.json');

// In dev mode, initialize Vite's middleware *before* listening so the first
// request can never fall through to express.static and serve a raw .tsx as
// text. Vite is dynamically imported (ESM-only since v8) and only on dev
// boots; prod boots skip the import entirely.
async function initViteMiddleware() {
  if (useFrontendDist) return;
  // Tell vite.config.js to skip the BACKEND_TARGET proxy block — in middleware
  // mode the bridge itself serves the API, so the proxy would loop forever
  // (bridge → vite-proxy → go-core → bridge → vite-proxy → …). Must be set
  // BEFORE vite.config.js is evaluated, i.e. before createServer runs.
  process.env.VITE_BRIDGE_MIDDLEWARE = '1';
  try {
    // @ts-ignore — vite resolves at runtime from hoisted node_modules; bridge's
    // tsconfig (moduleResolution: node) predates Vite's exports-map types.
    const vite = (await import('vite')) as { createServer: (opts: any) => Promise<any> };
    viteDevServer = await vite.createServer({
      root: path.join(__dirname, '..', 'frontend'),
      server: { middlewareMode: true, hmr: { server } },
      // 'custom' (not 'mpa') — see the comment in the frontend-serving block
      // above. 'mpa' would mount Vite's notFoundMiddleware which 404s every
      // /v1/* request before Express's API routes can run.
      appType: 'custom',
    });
    console.log('[vite] dev middleware ready (single-port; HMR via main http server)');
  } catch (e) {
    // Silent fall-through would mean express.static serves raw .tsx as text,
    // which the browser can't execute → 404 cascade of missing module imports.
    // In dev mode Vite is mandatory; fail fast so the operator sees the real
    // error instead of debugging a phantom asset-loading problem.
    console.error(`[vite] FATAL: middleware init failed:`, e);
    console.error(`[vite] dev mode requires Vite to serve the frontend. Set YHA_USE_DIST=true to run the built bundle instead.`);
    process.exit(1);
  }
}

async function bootHttp() {
  await initViteMiddleware();
  server.listen(PORT, BIND_HOST, async () => {
  // Record this startup and preserve previous exit context for monitoring.
  let _prevExit: Record<string, unknown> | null = null;
  try { _prevExit = JSON.parse(fs.readFileSync(_lastExitPath, 'utf8')); } catch (_) {}
  try {
    fs.writeFileSync(_lastExitPath, JSON.stringify({
      event: 'startup',
      startedAt: new Date().toISOString(),
      pid: process.pid,
      mode: process.env.YHA_USE_DIST === 'true' ? 'production' : 'dev',
      port: PORT,
      nodeVersion: process.version,
      prevExit: (_prevExit?.event === 'shutdown' || _prevExit?.event === 'crash') ? _prevExit : null,
    }, null, 2));
  } catch (_) {}

  startInternalApiServer();
  const providerNames = config.providers.map((p) => p.name).join(', ');
  console.log(`\nYHA Bridge running → ${proto}://localhost:${PORT}`);
  console.log(`Claude binary : ${CLAUDE_BIN}`);
  console.log(`Providers     : ${providerNames}`);
  console.log(`Default model : ${config.defaults?.model}`);
  console.log(`API raw logs  : ${LOG_DIR} (session file: ${SESSION_FILE_PATH})`);
  refreshAllModels().then(() => {
    console.log(`Models ready  : ${buildModelList().length} total\n`);
  });
  // Fan the canonical MCP registry out to every registered harness instance's
  // config dir so a Claude/Codex binary spawned for any account sees the same
  // mcpServers as the directly-launched binary. See bridge/mcp-registry.json.
  const mcp = getModuleApi('mcp-client');
  if (!mcp) {
    console.warn('mcp-client module disabled — skipping MCP autostart');
    return;
  }
  // Sweep MCP child PIDs left over from a previous bridge process. If `bun
  // --watch` re-execed without giving the gracefulShutdown handler time to
  // run (or if PM2 SIGKILL'd us), the persisted registry still holds the
  // PIDs of detached:true children that survived. Kill any that are still
  // alive AND whose recorded script path is either still in the current
  // mcp-registry.json (authoritative — we own the binding) or whose
  // /proc/<pid>/cmdline references the recorded script path (fallback for
  // entries whose config name was removed).
  try {
    // Build the set of script-path arg0 values currently registered. The
    // upstream registry shape is { mcpServers: { name: { command, args[] } } };
    // arg0 in `args` is the script the registerMcpPid writer records.
    const reg = mcp.readUpstreamRegistry?.()?.mcpServers || {};
    const knownScripts = new Set<string>();
    for (const cfg of Object.values(reg) as any[]) {
      const arg0 = Array.isArray(cfg?.args) && cfg.args.length ? String(cfg.args[0]) : '';
      if (arg0) knownScripts.add(arg0);
    }
    const swept = mcp.sweepOrphans?.(knownScripts) || [];
    const killed = swept.filter((s: any) => s.action === 'killed');
    if (killed.length) {
      console.log(`[mcp] swept ${killed.length} orphaned child process(es) from prior boot: ` +
        killed.map((s: any) => `${s.name}(${s.pid})`).join(', '));
    }
  } catch (e) {
    console.warn('[mcp] orphan sweep failed:', e instanceof Error ? e.message : String(e));
  }
  // Boot-time synth-status probe: surface stale synthesis pages once at startup
  // so the operator (and any session that reads the bridge log) sees that the
  // knowledge bucket is drifting from HEAD. Fire-and-forget — never blocks boot.
  // 10 s delay so the bridge is already serving when the check runs.
  setTimeout(() => {
    try {
      const { execFile } = require('child_process');
      const synthTool = path.join(__dirname, 'modules/context-generator/tools/synth-status.mjs');
      if (!fs.existsSync(synthTool)) return;
      execFile(process.execPath, [synthTool, '--cwd', process.cwd()], { timeout: 30_000 }, (err: any, stdout: string, stderr: string) => {
        // Exit 0 = current; 1 = stale pages; 2 = error. Non-zero is a heads-up,
        // not a failure — only log a banner so the operator can decide whether
        // to trigger a refresh via the cwd-synthesize skill / knowledge MCP.
        const code = err?.code ?? 0;
        if (code === 0) return;
        const head = (stdout || '').split('\n').slice(0, 3).join(' | ');
        console.warn(`[synth-status] bucket for ${process.cwd()} is ${code === 1 ? 'STALE' : 'unreadable'} — ${head}`);
      });
    } catch (e) {
      console.warn('[synth-status] boot probe failed:', e instanceof Error ? e.message : String(e));
    }
  }, 10_000);
  // Always run promoteMcpTools so that claude/codex/grok *harness instance*
  // configs (settings.json, config.toml, mcp-bridge.json) receive the
  // MCP-Tools stub entry. This client-side injection is required for the
  // harness CLIs (even when Go owns the upstream MCP servers via
  // YHA_MCP_AUTOSTART + YHA_GO_OWNS_MCP) so that `claude`/`codex`/`grok`
  // see the YHA tools when they start.
  try { mcp.promoteMcpTools(config); }
  catch (e) { console.warn(`MCP materialize failed: ${e instanceof Error ? e.message : String(e)}`); }

  // Phase 4 cutover guard: when YHA_GO_OWNS_MCP=1 the Go core's
  // mcp.Autostart is authoritative — Node must not spawn duplicate child
  // MCP servers. Only the server-autostart/reconcile part is skipped here;
  // promote (above) still ran.
  if (process.env.YHA_GO_OWNS_MCP === '1') {
    console.log('[mcp] YHA_GO_OWNS_MCP=1 — Go core owns MCP autostart; Node skipping server management.');
  } else {
    // Convert any legacy mcp-state.json (a running[] liveness snapshot) to the
    // declared disabled[]/enabled[] shape on disk and refresh the derived running
    // mirror that the Go autostart path reads.
    try { mcp.reconcileMcpStateFile?.(); } catch (_) { /* best-effort */ }
    const mcpCfgs = mcp.readUpstreamRegistry().mcpServers || {};
    // Desired-ON set = registry default ± the user's explicit enable/disable
    // overrides. This is declared intent, never "what was alive last time", so a
    // crash, a bridge restart, or a partial reload can't shrink it.
    const toStart = [...mcp.getDesiredOnServers()];
    // If the search-tab surface routes to MCP, make sure the websearch server
    // boots even when the user hasn't explicitly toggled it on in the MCP tab.
    try {
      const _searchCfg = getModuleApi('search')?.searchConfig?.load();
      if (_searchCfg && (_searchCfg.surface === 'mcp' || _searchCfg.surface === 'both') && !toStart.includes('websearch')) {
        toStart.push('websearch');
      }
    } catch (_) { /* search config missing — skip autostart */ }
    if (toStart.length) {
      console.log(`Auto-starting ${toStart.length} MCP server(s): ${toStart.join(', ')}`);
    }
    for (const srvName of toStart) {
      const cfg = mcpCfgs[srvName];
      if (!cfg) {
        console.warn(`Skipping auto-start of "${srvName}" — not found in ~/.claude/settings.json`);
        continue;
      }
      const resolvedPath = (cfg as any).args?.[0] ?? '(no args[0])';
      mcp.startMcpServer(srvName, cfg)
        .then((s) => console.log(`Auto-started MCP: ${srvName} (${s.tools.length} tools)`))
        .catch((e) => console.warn(`Auto-start MCP "${srvName}" failed [${resolvedPath}]:`, e instanceof Error ? e.message : String(e)));
    }
  }
}); // close listen(..., () => { ... })
}
bootHttp().catch((e) => {
  console.error(`[server] bootHttp failed: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(1);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
let shuttingDown = false;

async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[server] ${signal} received — shutting down gracefully...`);

  // Kill MCP child process groups FIRST, before any async cleanup. `bun
  // --watch` sends SIGHUP and then SIGKILL after ~1s — if the SIGTERM to
  // children is queued behind awaits and the file flushes, the SIGKILL
  // arrives before we get to it and the children orphan. Running this
  // synchronously up front sidesteps that race.
  try {
    const { mcpConnections } = require('./core/state');
    for (const [, conn] of mcpConnections) {
      if (!conn?.proc) continue;
      try { process.kill(-conn.proc.pid, 'SIGTERM'); } catch (_) {
        try { conn.proc.kill('SIGTERM'); } catch (_) {}
      }
    }
  } catch (_) {}

  try {
    let _startedAt: string | null = null;
    try { _startedAt = (JSON.parse(fs.readFileSync(_lastExitPath, 'utf8')) as any)?.startedAt || null; } catch (_) {}
    fs.writeFileSync(_lastExitPath, JSON.stringify({
      event: 'shutdown',
      exitAt: new Date().toISOString(),
      signal,
      via: signal === 'SIGTERM' ? 'yha.sh/pm2' : signal === 'SIGHUP' ? 'bun --watch reload' : 'ctrl+c',
      pid: process.pid,
      uptimeMs: Math.round(process.uptime() * 1000),
      startedAt: _startedAt,
    }));
  } catch (_) {}

  server.close(() => console.log('[server] HTTP server closed'));

  // Close Vite dev server (if active) so its file watchers + HMR WS don't
  // linger after shutdown. No-op in prod boots (viteDevServer stays null).
  if (viteDevServer) {
    try { await viteDevServer.close(); } catch (_) {}
  }

  // Stop the module file-watcher so its pending debounce timers don't keep
  // the event loop alive past shutdown.
  try { _modules.stopWatcher(); } catch (_) {}

  // Kill any per-CWD preview servers spawned by /v1/serve so no node/python/php
  // children linger across bridge restarts.
  try { serveLib.killAllSync(); } catch (_) {}

  // MCP child kill moved to the top of this function so it runs before any
  // awaited cleanup — see the comment up there for why.

  const { flushAllPendingSaves } = require('./sessions-internal');
  try {
    await flushAllPendingSaves();
    console.log('[server] pending session saves flushed');
  } catch (e) {
    console.warn('[server] error flushing session saves:', e instanceof Error ? e.message : String(e));
  }

  // Step 1 of docs/SQL-migration-plan.md: close the SQLite handle if Step 1
  // opened one. No-op on normal boots (flag off).
  try {
    const dbMod = require('./sessions-internal/db');
    if (dbMod.isOpen()) dbMod.closeDB();
  } catch (e) {
    console.warn('[server] error closing sqlite:', e instanceof Error ? e.message : String(e));
  }

  // Cost/token writes are debounced into the observability-plus cache; flush
  // before exit so an increment landed in the last 500 ms isn't lost.
  try {
    const obs = getModuleApi('observability-plus');
    obs?.flushCosts?.();
    obs?.flushTokens?.();
  } catch (_) {}

  // Flush + close the raw-log WriteStream(s). With async writes we may have
  // bytes buffered in userland; the previous appendFileSync path didn't need
  // this. Bounded by the 3s force-exit below.
  try {
    await _closeRawLogStreams();
  } catch (e) {
    console.warn('[server] error closing raw-log streams:', e instanceof Error ? e.message : String(e));
  }

  // Force exit after timeout in case something hangs
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
// `bun --watch` sends SIGHUP before SIGKILL on file-change reload. Without
// a SIGHUP handler the shutdown path doesn't fire, leaving MCP children
// with half-closed stdio pipes — the source of the hot-CPU orphan bug.
process.on('SIGHUP', () => gracefulShutdown('SIGHUP'));
process.on('uncaughtException', (e) => {
  try {
    let _startedAt: string | null = null;
    try { _startedAt = (JSON.parse(fs.readFileSync(_lastExitPath, 'utf8')) as any)?.startedAt || null; } catch (_) {}
    fs.writeFileSync(_lastExitPath, JSON.stringify({
      event: 'crash',
      exitAt: new Date().toISOString(),
      signal: 'uncaughtException',
      error: e?.message || String(e),
      pid: process.pid,
      uptimeMs: Math.round(process.uptime() * 1000),
      startedAt: _startedAt,
    }));
  } catch (_) {}
  console.error('[server] uncaughtException:', e);
  process.exit(1);
});
