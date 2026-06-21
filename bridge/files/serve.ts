// ── server-serve.ts ──────────────────────────────────────────────────────────
// Per-CWD live-preview mini-host. Spawns small dev servers (Static / Python /
// Node / PHP / Custom) bound to 127.0.0.1 on a port from a private pool, and
// proxies them to the frontend through /proxy/serve/<id>/ (mirrors the same
// pattern as /proxy/browser/* → KasmVNC). Auto-stops 60 s after idle or when
// the active chat session changes; both are overridable per server.
//
// Single source of truth for runtime state. Routes (routes/serve.ts) and the
// proxy middleware in server.ts read/write through the exported helpers.
'use strict';

const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn } = require('child_process');
const expressLib = require('express');
const { createProxyMiddleware: _createProxyMiddleware } = require('http-proxy-middleware');
// Shared path-confinement helper — resolved HOME (USERPROFILE on Windows) plus
// any configured `fileManagerRoots`, read fresh from prefs per call. Same
// source of truth the /v1/files/* routes use, so serve confinement tracks the
// user's actual directories dynamically instead of a hardcoded prefix.
const { confine } = require('../config/paths');

type ServeProfile = 'static' | 'python' | 'node' | 'php' | 'custom';
type ServeStatus = 'starting' | 'ready' | 'error' | 'stopped';

interface ServeShare {
  token: string;
  serveId: string;
  createdAt: number;
  expiresAt: number | null;
  label?: string;
  revokedAt?: number;
}

interface ServeStats {
  hits: number;
  pageViews: number;
  lastViewedAt: number | null;
  byIp: Record<string, { hits: number; pageViews: number; lastViewedAt: number }>;
  recent: Array<{ at: number; ip: string; method: string; path: string; status?: number; shareToken?: string }>;
}

interface ServeEntry {
  id: string;
  cwd: string;
  profile: ServeProfile;
  cmdLine: string;
  port: number;          // 0 sentinel for static (in-process)
  child: any | null;     // ChildProcess | null
  startedAt: number;
  lastTouched: number;
  sessionId: string | null;
  keepAlive: boolean;
  expiresAt: number | null;
  status: ServeStatus;
  errorMsg?: string;
  // Set when the runtime came up fine but persisting the user's profile
  // choice to prefs.json failed (disk full, permissions). The serve still
  // works for the current process lifetime; surfacing this through the
  // start response lets the frontend warn that the choice won't survive a
  // bridge restart.
  _persistError?: string;
  logBuf: string[];
  _logHead: number;      // ring-buffer write head (only meaningful once logBuf.length === LOG_RING_SIZE)
  _proxy?: Record<string, any>; // RequestHandler by mount mode/key (lazy)
  _staticHandler?: any;  // retained for compatibility; static now uses serveStaticFile()
  stats: ServeStats;
}

const PORT_RANGE_LO = 9100;
const PORT_RANGE_HI = 9199;
const IDLE_LIMIT_MS = 60_000;
const DEFAULT_TTL_MS = 60 * 60_000;
const MAX_TTL_MS = 7 * 24 * 60 * 60_000;
const VIEW_RECENT_LIMIT = 200;
const REAPER_INTERVAL_MS = 10_000;
const LOG_RING_SIZE = 256;

const serveRegistry = new Map<string, ServeEntry>();   // id  -> entry
const serveByCwd    = new Map<string, string>();        // realpath(cwd) -> id
const shareRegistry = new Map<string, ServeShare>();    // token -> share
let activeSessionId: string | null = null;
let reaperTimer: NodeJS.Timeout | null = null;

const SERVE_ACTIVITY_DIR = path.join(__dirname, '..', 'serve-activity');
const SERVE_VIEWS_LOG = path.join(SERVE_ACTIVITY_DIR, 'views.ndjson');
const SERVE_STATS_PATH = path.join(SERVE_ACTIVITY_DIR, 'stats.json');

function ensureActivityDir(): void {
  try { fs.mkdirSync(SERVE_ACTIVITY_DIR, { recursive: true }); } catch (_) {}
}

function emptyStats(): ServeStats {
  return { hits: 0, pageViews: 0, lastViewedAt: null, byIp: {}, recent: [] };
}

// ── Runtime probes (one-time, at module load) ───────────────────────────────
const RUNTIMES = {
  python: !!whichSync('python3'),
  node:   !!whichSync('node') || !!whichSync('npm'),
  php:    !!whichSync('php'),
};

function whichSync(bin: string): string | null {
  const PATH = (process.env.PATH || '').split(path.delimiter);
  for (const dir of PATH) {
    const p = path.join(dir, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch (_) {}
  }
  return null;
}

// ── Persistence (frontend-facing per-cwd profile choice) ────────────────────
const PREFS_PATH = path.join(__dirname, '..', 'prefs.json');

function readPrefsSync(): Record<string, any> {
  try {
    return JSON.parse(fs.readFileSync(PREFS_PATH, 'utf8'));
  } catch (_) {
    return {};
  }
}

function writePrefs(patch: Record<string, any>): void {
  const prefs = readPrefsSync();
  prefs.serve = prefs.serve || { profiles: {} };
  for (const [cwd, value] of Object.entries(patch)) {
    if (value === null) delete prefs.serve.profiles[cwd];
    else prefs.serve.profiles[cwd] = value;
  }
  const tmp = PREFS_PATH + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(prefs, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, PREFS_PATH);
}

function loadStoredProfiles(): Record<string, any> {
  const prefs = readPrefsSync();
  return prefs.serve?.profiles || {};
}

// ── CWD validation ──────────────────────────────────────────────────────────
async function resolveCwd(cwd: string): Promise<string> {
  if (!cwd || typeof cwd !== 'string' || !path.isAbsolute(cwd)) {
    throw new Error('cwd must be an absolute path');
  }
  try {
    fs.realpathSync(cwd);
  } catch (e) {
    throw new Error(`cwd does not exist: ${cwd}`);
  }
  // Confine to the same allowed roots as the file routes (resolved HOME +
  // configured fileManagerRoots). `confine` rejects with { status, message };
  // normalise to an Error so /v1/serve/start surfaces a clean message.
  try {
    return await confine(cwd);
  } catch (e: any) {
    throw new Error(e?.message || `cwd outside allowed roots: ${cwd}`);
  }
}

// ── Port allocator ──────────────────────────────────────────────────────────
async function allocatePort(): Promise<number> {
  const inUse = new Set<number>();
  for (const e of serveRegistry.values()) if (e.port > 0) inUse.add(e.port);
  for (let p = PORT_RANGE_LO; p <= PORT_RANGE_HI; p++) {
    if (inUse.has(p)) continue;
    if (await canBind(p)) return p;
  }
  throw new Error(`no free port in range ${PORT_RANGE_LO}-${PORT_RANGE_HI}`);
}

function canBind(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

// ── Profile resolvers ───────────────────────────────────────────────────────
function resolveCmd(profile: ServeProfile, cwd: string, customCmd: string | undefined, port: number): string {
  switch (profile) {
    case 'static':
      return `(in-process express.static ${cwd})`;
    case 'python': {
      const reqs = path.join(cwd, 'requirements.txt');
      const appPy = path.join(cwd, 'app.py');
      const mainPy = path.join(cwd, 'main.py');
      const hasFlaskHint = fs.existsSync(reqs) && /flask/i.test(safeReadFile(reqs));
      const hasFastapiHint = fs.existsSync(reqs) && /(fastapi|uvicorn)/i.test(safeReadFile(reqs));
      if (hasFlaskHint && fs.existsSync(appPy)) {
        return `python3 -m flask --app app run --host 127.0.0.1 --port ${port}`;
      }
      if (hasFastapiHint && fs.existsSync(mainPy)) {
        return `python3 -m uvicorn main:app --host 127.0.0.1 --port ${port}`;
      }
      return `python3 -m http.server ${port} --bind 127.0.0.1 --directory ${quoteArg(cwd)}`;
    }
    case 'node': {
      const pkgPath = path.join(cwd, 'package.json');
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.scripts?.dev) return 'npm run dev';
        if (pkg.scripts?.start) return 'npm start';
        if (pkg.main) return `node ${quoteArg(pkg.main)}`;
      } catch (_) {}
      return `node index.js`;
    }
    case 'php':
      return `php -S 127.0.0.1:${port} -t ${quoteArg(cwd)}`;
    case 'custom':
      return (customCmd || '').trim();
  }
}

function safeReadFile(p: string): string {
  try { return fs.readFileSync(p, 'utf8'); } catch { return ''; }
}

function quoteArg(s: string): string {
  if (/^[a-zA-Z0-9_./-]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// ── Logs (ring buffer) ──────────────────────────────────────────────────────
// Crash-spam children can write thousands of lines in a tight loop. The old
// push-then-shift loop transiently held all of them in V8 heap before
// truncating. Now we cap each call as we go: once the buffer is full, every
// new line overwrites the oldest in place — no transient spike, no O(N) shift.
function appendLog(entry: ServeEntry, channel: 'stdout' | 'stderr' | 'meta', text: string): void {
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    if (!raw) continue;
    const line = `[${channel}] ${raw}`;
    if (entry.logBuf.length < LOG_RING_SIZE) {
      entry.logBuf.push(line);
    } else {
      entry.logBuf[entry._logHead % LOG_RING_SIZE] = line;
      entry._logHead = (entry._logHead + 1) % LOG_RING_SIZE;
    }
  }
}

// ── Public: list / get ──────────────────────────────────────────────────────
function entryToPublic(entry: ServeEntry): any {
  return {
    id: entry.id,
    cwd: entry.cwd,
    profile: entry.profile,
    cmdLine: entry.cmdLine,
    port: entry.port,
    startedAt: entry.startedAt,
    lastTouched: entry.lastTouched,
    sessionId: entry.sessionId,
    keepAlive: entry.keepAlive,
    expiresAt: entry.expiresAt,
    status: entry.status,
    errorMsg: entry.errorMsg,
    // `persisted` defaults to true; flips false only when the prefs write
    // failed during startServe. Frontends can warn the user that their
    // profile selection won't survive a bridge restart.
    persisted: !entry._persistError,
    ...(entry._persistError ? { persistError: entry._persistError } : {}),
    proxyPath: `/serve/${entry.id}/`,
    legacyProxyPath: `/proxy/serve/${entry.id}/`,
    shares: listSharesForEntry(entry.id),
    stats: entry.stats,
  };
}

function listEntries(): any[] {
  return [...serveRegistry.values()].map(entryToPublic);
}

function findByCwd(cwd: string): ServeEntry | null {
  let resolved: string;
  try { resolved = fs.realpathSync(cwd); } catch { return null; }
  const id = serveByCwd.get(resolved);
  return id ? serveRegistry.get(id) || null : null;
}

function findById(id: string): ServeEntry | null {
  return serveRegistry.get(id) || null;
}

// ── Start ───────────────────────────────────────────────────────────────────
interface StartOpts {
  cwd: string;
  profile: ServeProfile;
  cmdLine?: string;     // custom only (overrides resolved cmd)
  sessionId: string | null;
  keepAlive?: boolean;
  ttlMs?: number | null;
}

async function startServe(opts: StartOpts): Promise<ServeEntry> {
  const cwd = await resolveCwd(opts.cwd);
  const profile = opts.profile;
  if (!['static', 'python', 'node', 'php', 'custom'].includes(profile)) {
    throw new Error(`invalid profile: ${profile}`);
  }
  if (profile === 'python' && !RUNTIMES.python) throw new Error('python3 not found on PATH');
  if (profile === 'node'   && !RUNTIMES.node)   throw new Error('node not found on PATH');
  if (profile === 'php'    && !RUNTIMES.php)    throw new Error('php not found on PATH (try: sudo apt install php-cli)');
  if (profile === 'custom' && !opts.cmdLine?.trim()) throw new Error('custom profile requires cmdLine');

  // Stop any prior server for the same cwd
  const prior = findByCwd(cwd);
  if (prior) await stopServe(prior.id, 'replaced');

  const id = crypto.randomUUID();
  const port = profile === 'static' ? 0 : await allocatePort();
  const cmdLine = profile === 'custom' ? (opts.cmdLine || '').trim() : resolveCmd(profile, cwd, opts.cmdLine, port);

  const entry: ServeEntry = {
    id,
    cwd,
    profile,
    cmdLine,
    port,
    child: null,
    startedAt: Date.now(),
    lastTouched: Date.now(),
    sessionId: opts.sessionId,
    keepAlive: !!opts.keepAlive,
    expiresAt: normalizeExpiresAt(opts.ttlMs),
    status: 'starting',
    logBuf: [],
    _logHead: 0,
    stats: emptyStats(),
  };

  serveRegistry.set(id, entry);
  serveByCwd.set(cwd, id);

  if (profile === 'static') {
    entry._staticHandler = expressLib.static(cwd, { fallthrough: false });
    entry.status = 'ready';
    appendLog(entry, 'meta', `static profile mounted: ${cwd}`);
  } else {
    spawnChild(entry);
  }

  // Persist the choice (not runtime state) — overlay onto prefs.json/serve/profiles
  try {
    writePrefs({ [cwd]: { profile, cmdLine: profile === 'custom' ? cmdLine : undefined, keepAlive: entry.keepAlive, ttlMs: opts.ttlMs ?? DEFAULT_TTL_MS } });
  } catch (e) {
    const msg = (e as Error).message;
    appendLog(entry, 'meta', `[warn] prefs write failed: ${msg}`);
    entry._persistError = msg;
  }

  ensureReaperRunning();
  return entry;
}

function spawnChild(entry: ServeEntry): void {
  const env = { ...process.env, PORT: String(entry.port), HOST: '127.0.0.1' };
  const child = spawn(entry.cmdLine, [], { cwd: entry.cwd, env, shell: true });
  entry.child = child;

  child.stdout?.on('data', (chunk: Buffer) => appendLog(entry, 'stdout', chunk.toString('utf8')));
  child.stderr?.on('data', (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    appendLog(entry, 'stderr', text);
    if (/EADDRINUSE/.test(text) && entry.status === 'starting') {
      entry.status = 'error';
      entry.errorMsg = `port ${entry.port} already in use`;
    }
  });

  child.on('exit', (code: number | null, signal: string | null) => {
    appendLog(entry, 'meta', `child exited (code=${code} signal=${signal})`);
    if (entry.status === 'starting' || entry.status === 'ready') {
      entry.status = code === 0 ? 'stopped' : 'error';
      if (code !== 0 && !entry.errorMsg) entry.errorMsg = `exited with code ${code}`;
    }
  });

  child.on('error', (err: Error) => {
    appendLog(entry, 'meta', `[spawn-error] ${err.message}`);
    entry.status = 'error';
    entry.errorMsg = err.message;
  });

  // Promote starting → ready as soon as the port answers, or after a generous
  // grace period. We don't probe ourselves — the frontend polls /proxy/serve/<id>/
  // directly (mirrors BrowserWindow's pattern). But mark ready optimistically so
  // status reads useful info while polling happens.
  setTimeout(() => {
    if (entry.status === 'starting') entry.status = 'ready';
  }, 400);
}

// ── Stop ────────────────────────────────────────────────────────────────────
async function stopServe(id: string, reason: string): Promise<void> {
  const entry = serveRegistry.get(id);
  if (!entry) return;

  appendLog(entry, 'meta', `stopping (reason=${reason})`);
  if (entry.child) {
    try { entry.child.kill('SIGTERM'); } catch (_) {}
    setTimeout(() => {
      if (entry.child && !entry.child.killed) {
        try { entry.child.kill('SIGKILL'); } catch (_) {}
      }
    }, 3000).unref();
  }
  entry.status = 'stopped';

  for (const share of shareRegistry.values()) {
    if (share.serveId === id && !share.revokedAt) share.revokedAt = Date.now();
  }
  serveRegistry.delete(id);
  if (serveByCwd.get(entry.cwd) === id) serveByCwd.delete(entry.cwd);
}

// Synchronous variant for the SIGINT/SIGTERM shutdown path — fire SIGTERM at
// every child immediately, no async/await, no setTimeout escalation.
function killAllSync(): void {
  for (const entry of serveRegistry.values()) {
    if (entry.child) {
      try { entry.child.kill('SIGTERM'); } catch (_) {}
    }
  }
}

// ── Idle reaper + session-switch reaper ─────────────────────────────────────
function reap(): void {
  const now = Date.now();
  for (const entry of [...serveRegistry.values()]) {
    if (entry.expiresAt !== null && now > entry.expiresAt) { stopServe(entry.id, 'ttl-expired'); continue; }
    if (entry.keepAlive || entry.expiresAt !== null) continue;
    const idle     = now - entry.lastTouched > IDLE_LIMIT_MS;
    const orphaned = entry.sessionId !== null && activeSessionId !== null && entry.sessionId !== activeSessionId;
    if (idle || orphaned) stopServe(entry.id, idle ? 'idle' : 'session-switch');
  }
}

function ensureReaperRunning(): void {
  if (reaperTimer) return;
  reaperTimer = setInterval(reap, REAPER_INTERVAL_MS);
  reaperTimer.unref();
}

// ── Active session tracking ─────────────────────────────────────────────────
function setActiveSession(sessionId: string | null): void {
  activeSessionId = sessionId;
}

function getActiveSession(): string | null {
  return activeSessionId;
}

// ── Touch (manual heartbeat from frontend) ──────────────────────────────────
function touch(id: string): boolean {
  const e = serveRegistry.get(id);
  if (!e) return false;
  e.lastTouched = Date.now();
  return true;
}

// ── Keep-alive toggle ───────────────────────────────────────────────────────
function setKeepAlive(id: string, keepAlive: boolean): boolean {
  const e = serveRegistry.get(id);
  if (!e) return false;
  e.keepAlive = !!keepAlive;
  try {
    writePrefs({ [e.cwd]: { profile: e.profile, cmdLine: e.profile === 'custom' ? e.cmdLine : undefined, keepAlive: e.keepAlive } });
  } catch (_) {}
  return true;
}

function normalizeExpiresAt(ttlMs: any): number | null {
  if (ttlMs === null || ttlMs === 'manual') return null;
  let n = Number(ttlMs);
  if (!Number.isFinite(n) || n <= 0) n = DEFAULT_TTL_MS;
  n = Math.min(Math.max(n, 60_000), MAX_TTL_MS);
  return Date.now() + n;
}

function clientIp(req: any): string {
  const xff = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || String(req.headers?.['x-real-ip'] || req.ip || req.socket?.remoteAddress || 'unknown');
}

function isPageView(req: any, relPath: string): boolean {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  const accept = String(req.headers?.accept || '');
  if (accept.includes('text/html')) return true;
  return relPath === '/' || relPath.endsWith('/');
}

function recordView(entry: ServeEntry, req: any, relPath: string, opts: { shareToken?: string } = {}): void {
  const at = Date.now();
  const ip = clientIp(req);
  const page = isPageView(req, relPath);
  entry.stats.hits++;
  if (page) entry.stats.pageViews++;
  entry.stats.lastViewedAt = at;
  const bucket = entry.stats.byIp[ip] || { hits: 0, pageViews: 0, lastViewedAt: at };
  bucket.hits++;
  if (page) bucket.pageViews++;
  bucket.lastViewedAt = at;
  entry.stats.byIp[ip] = bucket;
  entry.stats.recent.push({ at, ip, method: req.method, path: relPath, shareToken: opts.shareToken });
  if (entry.stats.recent.length > VIEW_RECENT_LIMIT) entry.stats.recent.splice(0, entry.stats.recent.length - VIEW_RECENT_LIMIT);
  ensureActivityDir();
  const line = JSON.stringify({ at, serveId: entry.id, cwd: entry.cwd, profile: entry.profile, ip, method: req.method, path: relPath, ua: req.headers?.['user-agent'] || '', referer: req.headers?.referer || '', shareToken: opts.shareToken || null }) + '\n';
  fs.appendFile(SERVE_VIEWS_LOG, line, () => {});
  fs.writeFile(SERVE_STATS_PATH, JSON.stringify({ updatedAt: Date.now(), entries: Object.fromEntries([...serveRegistry.values()].map((e) => [e.id, { cwd: e.cwd, profile: e.profile, stats: e.stats }])) }, null, 2) + '\n', () => {});
}

function stripRoutePrefix(req: any, mode: 'serve' | 'proxy' | 'share', key: string): string {
  const base = mode === 'serve' ? `/serve/${key}` : mode === 'share' ? `/share/${key}` : `/proxy/serve/${key}`;
  const original = req.originalUrl || req.url || '/';
  let rel = original.startsWith(base) ? original.slice(base.length) : (req.url || '/');
  if (!rel.startsWith('/')) rel = '/' + rel;
  return rel || '/';
}

function sendStaticWithRewrite(entry: ServeEntry, req: any, res: any, next: any, relUrl: string, mountBase: string, shareToken?: string): any {
  const q = relUrl.indexOf('?');
  const relPathOnly = decodeURIComponent((q === -1 ? relUrl : relUrl.slice(0, q)).split('#')[0] || '/');
  const safeRel = path.normalize(relPathOnly).replace(/^([.][.][/\\])+/, '').replace(/^[/\\]+/, '');
  let filePath = path.join(entry.cwd, safeRel);
  try {
    const st = fs.statSync(filePath);
    if (st.isDirectory()) {
      if (!relPathOnly.endsWith('/')) {
        const qs = q === -1 ? '' : relUrl.slice(q);
        return res.redirect(301, mountBase + relPathOnly.slice(1) + '/' + qs);
      }
      filePath = path.join(filePath, 'index.html');
    }
  } catch (_) {}
  let real: string;
  try { real = fs.realpathSync(filePath); } catch (_) { recordView(entry, req, relPathOnly, { shareToken }); return res.status(404).send('Not found'); }
  if (real !== entry.cwd && !real.startsWith(entry.cwd + path.sep)) return res.status(403).send('Forbidden');
  recordView(entry, req, relPathOnly, { shareToken });
  const isHtml = /\.html?$/i.test(real);
  if (isHtml) {
    try {
      let html = fs.readFileSync(real, 'utf8');
      html = rewriteHtmlForMount(html, mountBase);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache');
      return res.end(html);
    } catch (_) {}
  }
  return res.sendFile(real);
}

function rewriteHtmlForMount(html: string, mountBase: string): string {
  // `<base>` fixes relative links from nested folders (`sub/page.html` →
  // `/serve/id/sub/page.html`), but it does not affect root-relative URLs like
  // `/style.css`. For static previews we can cheaply rewrite common HTML/CSS
  // references so simple hand-written sites work behind the path multiplexer.
  const base = mountBase.endsWith('/') ? mountBase : mountBase + '/';
  let out = html;
  if (!/<base\s/i.test(out)) {
    out = out.replace(/<head(\s[^>]*)?>/i, (m) => `${m}<base href="${base}">`);
  }

  const rewriteUrl = (raw: string): string => {
    if (!raw.startsWith('/') || raw.startsWith('//')) return raw;
    if (raw.startsWith(base)) return raw;
    return base + raw.replace(/^\/+/, '');
  };

  out = out.replace(
    /\b(href|src|action|poster)=("|')([^"']*)\2/gi,
    (_m, attr: string, quote: string, value: string) => `${attr}=${quote}${rewriteUrl(value)}${quote}`,
  );
  out = out.replace(/\b(srcset)=("|')([^"']*)\2/gi, (_m, attr: string, quote: string, value: string) => {
    const rewritten = value.split(',').map((part) => {
      const trimmed = part.trim();
      const bits = trimmed.split(/\s+/);
      if (bits.length === 0) return part;
      bits[0] = rewriteUrl(bits[0]);
      return bits.join(' ');
    }).join(', ');
    return `${attr}=${quote}${rewritten}${quote}`;
  });
  out = out.replace(/\burl\((['"]?)(\/(?!\/)[^)'" ]+)\1\)/gi, (_m, quote: string, value: string) => `url(${quote}${rewriteUrl(value)}${quote})`);
  return out;
}

function listSharesForEntry(id: string): any[] {
  const now = Date.now();
  return [...shareRegistry.values()]
    .filter((s) => s.serveId === id)
    .map((s) => ({ ...s, active: !s.revokedAt && (s.expiresAt === null || s.expiresAt > now), publicPath: `/share/${s.token}/` }));
}

function listShares(): any[] {
  return [...shareRegistry.values()].flatMap((s) => {
    const e = serveRegistry.get(s.serveId);
    return [{ ...s, cwd: e?.cwd || null, active: !s.revokedAt && (s.expiresAt === null || s.expiresAt > Date.now()), publicPath: `/share/${s.token}/` }];
  });
}

function createShare(serveId: string, ttlMs: any, label?: string): ServeShare {
  if (!serveRegistry.has(serveId)) throw new Error('serve session not found');
  const token = crypto.randomBytes(12).toString('base64url');
  const share: ServeShare = { token, serveId, createdAt: Date.now(), expiresAt: normalizeExpiresAt(ttlMs), label: label || undefined };
  shareRegistry.set(token, share);
  ensureReaperRunning();
  return share;
}

function revokeShare(token: string): boolean {
  const s = shareRegistry.get(token);
  if (!s) return false;
  s.revokedAt = Date.now();
  return true;
}

function resolveShare(token: string): { share: ServeShare; entry: ServeEntry } | null {
  const s = shareRegistry.get(token);
  if (!s || s.revokedAt || (s.expiresAt !== null && s.expiresAt < Date.now())) return null;
  const entry = serveRegistry.get(s.serveId);
  if (!entry) return null;
  return { share: s, entry };
}

// ── Proxy middleware factory (called from server.ts) ────────────────────────
function buildServeProxyMiddleware(mode: 'proxy' | 'serve' | 'share' = 'proxy') {
  return (req: any, res: any, next: any) => {
    let id = req.params?.id;
    let shareToken: string | undefined;
    if (mode === 'share') {
      shareToken = req.params?.token;
      const resolved = shareToken ? resolveShare(shareToken) : null;
      if (!resolved) return res.status(404).send('share link not found or expired');
      id = resolved.entry.id;
    }
    if (!id) return res.status(404).send('serve session not found');
    const entry = serveRegistry.get(id);
    if (!entry) return res.status(404).send('serve session not found');

    entry.lastTouched = Date.now();
    const routeKey = mode === 'share' ? shareToken! : id;
    const relUrl = stripRoutePrefix(req, mode, routeKey);
    const mountBase = mode === 'share' ? `/share/${shareToken}/` : mode === 'serve' ? `/serve/${id}/` : `/proxy/serve/${id}/`;

    if (entry.profile === 'static') {
      return sendStaticWithRewrite(entry, req, res, next, relUrl, mountBase, shareToken);
    }

    const proxyKey = mode === 'share' ? `share:${shareToken}` : mode;
    if (!entry._proxy) entry._proxy = {};
    if (!entry._proxy[proxyKey]) {
      entry._proxy[proxyKey] = _createProxyMiddleware({
        target: `http://127.0.0.1:${entry.port}`,
        ws: true,
        changeOrigin: true,
        pathRewrite: (pathReq: string) => stripRoutePrefix({ originalUrl: pathReq, url: pathReq }, mode, mode === 'share' ? (shareToken || '') : id),
        on: { proxyReq: (_proxyReq: any, req2: any) => recordView(entry, req2, stripRoutePrefix(req2, mode, mode === 'share' ? (shareToken || '') : id), { shareToken }) },
        logger: undefined,
      });
    }
    return entry._proxy[proxyKey](req, res, next);
  };
}

// Called from server.ts upgrade handler so HMR/WebSocket dev servers work.
function handleProxyUpgrade(req: any, socket: any, head: any): boolean {
  const m = /^(?:\/proxy\/serve|\/serve|\/share)\/([^\/]+)/.exec(req.url || '');
  if (!m) return false;
  const isShare = String(req.url || '').startsWith('/share/');
  const resolved = isShare ? resolveShare(m[1]) : null;
  const id = isShare ? resolved?.entry.id : m[1];
  if (!id) return false;
  const entry = serveRegistry.get(id);
  if (!entry || !entry._proxy || entry.profile === 'static') return false;
  entry.lastTouched = Date.now();
  try {
    const proxyKey = isShare ? `share:${m[1]}` : (String(req.url || '').startsWith('/serve/') ? 'serve' : 'proxy');
    const proxy = entry._proxy[proxyKey] || entry._proxy.serve || entry._proxy.proxy || Object.values(entry._proxy)[0];
    if (!proxy) return false;
    proxy.upgrade(req, socket, head);
  } catch (e) {
    appendLog(entry, 'meta', `[ws-upgrade] ${(e as Error).message}`);
  }
  return true;
}

// ── Logs accessor ───────────────────────────────────────────────────────────
function getLogs(id: string): string[] | null {
  const e = serveRegistry.get(id);
  if (!e) return null;
  // Once the ring has wrapped, `_logHead` is the index of the *oldest* entry;
  // before that, entries 0..length-1 are already in arrival order.
  if (e.logBuf.length < LOG_RING_SIZE) return [...e.logBuf];
  return [...e.logBuf.slice(e._logHead), ...e.logBuf.slice(0, e._logHead)];
}

module.exports = {
  // public API
  startServe,
  stopServe,
  touch,
  setKeepAlive,
  setActiveSession,
  getActiveSession,
  findByCwd,
  findById,
  listEntries,
  listShares,
  createShare,
  revokeShare,
  entryToPublic,
  loadStoredProfiles,
  getLogs,
  killAllSync,

  // wiring
  buildServeProxyMiddleware,
  handleProxyUpgrade,

  // probes
  RUNTIMES,
};
