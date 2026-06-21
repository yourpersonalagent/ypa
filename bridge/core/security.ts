// security.ts — passive aggregator for the TUI Security tab.
//
// Read-only summary of signals YHA already collects. Nothing here
// probes the network or escalates privileges; we just stitch existing
// files + endpoints into one JSON envelope the TUI polls every few
// seconds. Each section is independently best-effort — if costs.json
// is missing we still surface auth events, and so on.
//
// Sections:
//   - auth        recent auth-logins.log events + WorkOS allowlist size
//   - spend       today vs 7-day avg from costs.json + flagged anomalies
//   - mcp         per-child running/error state from mcpConnections
//   - tailscale   the same publicOrigin + funnel info the link flow uses
//   - files       mtimes on .env / token store / auth log
//   - process     bridge uptime + memory

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
import type { Request, Response, Express } from 'express';

const { AUTH_LOG_PATH } = require('./auth');
const { mcpConnections } = require('./state');

// ── Auth events ──────────────────────────────────────────────────────────────
//
// auth-logins.log is one ISO-timestamped event per line:
//   [2026-05-20T18:00:00.000Z] login_success email="x@y" ...
// We tail the last ~200 lines and parse them into structured events so the
// TUI can render a table without re-parsing on every refresh.

const AUTH_TAIL_LINES = 200;
const AUTH_TAIL_BYTES = 64 * 1024;

interface AuthEvent {
  ts: string;        // ISO timestamp from the log
  event: string;     // login_success / login_failed / logout / etc
  email?: string;
  ip?: string;
  reason?: string;   // populated for login_failed
  allowed?: string;  // "true" / "false" — was the email on the allowlist?
}

function tailAuthLog(): { events: AuthEvent[]; logPath: string; logExists: boolean } {
  const events: AuthEvent[] = [];
  let exists = false;
  try {
    const stat = fs.statSync(AUTH_LOG_PATH);
    exists = true;
    const start = Math.max(0, stat.size - AUTH_TAIL_BYTES);
    const fd = fs.openSync(AUTH_LOG_PATH, 'r');
    try {
      const buf = Buffer.alloc(stat.size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      const text = buf.toString('utf8');
      const lines = text.split('\n').filter(Boolean);
      const tail = lines.slice(-AUTH_TAIL_LINES);
      for (const line of tail) {
        const parsed = parseAuthLine(line);
        if (parsed) events.push(parsed);
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch (_) {
    /* missing log file is normal on fresh installs */
  }
  return { events, logPath: AUTH_LOG_PATH, logExists: exists };
}

function parseAuthLine(line: string): AuthEvent | null {
  // [2026-05-20T18:00:00.000Z] event key="value" key="value"
  const m = line.match(/^\[([^\]]+)\]\s+(\S+)\s*(.*)$/);
  if (!m) return null;
  const ev: AuthEvent = { ts: m[1], event: m[2] };
  const kvRe = /(\w+)="([^"]*)"/g;
  let kv: RegExpExecArray | null;
  while ((kv = kvRe.exec(m[3])) !== null) {
    (ev as any)[kv[1]] = kv[2];
  }
  return ev;
}

function summarizeAuth(events: AuthEvent[]) {
  let successes = 0;
  let failures = 0;
  let logouts = 0;
  let lastSuccess: AuthEvent | undefined;
  const rejectedAllowlist: AuthEvent[] = [];
  for (const e of events) {
    if (e.event === 'login_success') {
      successes++;
      if (!lastSuccess || e.ts > lastSuccess.ts) lastSuccess = e;
      if (e.allowed === 'false') rejectedAllowlist.push(e);
    } else if (e.event === 'login_failed') {
      failures++;
    } else if (e.event === 'logout') {
      logouts++;
    }
  }
  const allowlist = (process.env.ALLOWED_EMAILS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    successes,
    failures,
    logouts,
    lastSuccess,
    rejectedAllowlist: rejectedAllowlist.slice(-5),
    allowlistSize: allowlist.length,
    authEnabled: !!(process.env.WORKOS_API_KEY && process.env.WORKOS_CLIENT_ID),
  };
}

// ── Spend anomaly detection ──────────────────────────────────────────────────
//
// Read bridge/costs.json directly so this stays independent of the
// observability-plus module (which may or may not be loaded). Compare today's
// $ against the rolling 7-day average; flag when today > max(avg*3, $0.50).

const COSTS_FILE = path.join(__dirname, '..', 'costs.json');

interface SpendSummary {
  today: number;
  yesterday: number;
  sevenDayAvg: number;
  allTime: number;
  anomaly: boolean;
  anomalyReason?: string;
  topProvidersToday: Array<{ provider: string; amount: number }>;
}

function summarizeSpend(): SpendSummary {
  let raw: any = { allTime: { total: 0, byProvider: {} }, daily: {} };
  try {
    if (fs.existsSync(COSTS_FILE)) raw = JSON.parse(fs.readFileSync(COSTS_FILE, 'utf8'));
  } catch (_) { /* malformed cost file → empty summary */ }

  const today = new Date().toISOString().slice(0, 10);
  const yesterday = new Date(Date.now() - 24 * 3600 * 1000).toISOString().slice(0, 10);
  const todayBucket = raw.daily?.[today] || { total: 0, byProvider: {} };
  const yesterdayBucket = raw.daily?.[yesterday] || { total: 0 };

  const last7: number[] = [];
  for (let i = 1; i <= 7; i++) {
    const d = new Date(Date.now() - i * 24 * 3600 * 1000).toISOString().slice(0, 10);
    last7.push(raw.daily?.[d]?.total || 0);
  }
  const sevenDayAvg = last7.reduce((a, b) => a + b, 0) / 7;

  const topProvidersToday = Object.entries(todayBucket.byProvider || {})
    .map(([provider, amount]) => ({ provider, amount: Number(amount) || 0 }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 5);

  const todayTotal = Number(todayBucket.total) || 0;
  const anomalyThreshold = Math.max(sevenDayAvg * 3, 0.5);
  const anomaly = todayTotal > anomalyThreshold && sevenDayAvg > 0.01;
  const anomalyReason = anomaly
    ? `today $${todayTotal.toFixed(4)} > 3× 7-day avg $${sevenDayAvg.toFixed(4)}`
    : undefined;

  return {
    today: todayTotal,
    yesterday: Number(yesterdayBucket.total) || 0,
    sevenDayAvg,
    allTime: Number(raw.allTime?.total) || 0,
    anomaly,
    anomalyReason,
    topProvidersToday,
  };
}

// ── MCP child health ─────────────────────────────────────────────────────────
//
// Read straight from the live mcpConnections Map in core/state so we don't
// have to round-trip through the /v1/mcp/ HTTP route from inside the bridge.

interface McpHealth {
  total: number;
  running: number;
  failed: number;
  servers: Array<{ name: string; running: boolean; ok: boolean; error: string | null }>;
}

function summarizeMcp(): McpHealth {
  const servers: McpHealth['servers'] = [];
  let running = 0;
  let failed = 0;
  for (const [name, conn] of mcpConnections as Map<string, any>) {
    const alive = !!(conn?.proc && conn.proc.exitCode === null && !conn.proc.killed);
    const ok = alive && conn?.ok === true;
    const error = conn?.error ? String(conn.error) : null;
    if (alive) running++;
    if (error) failed++;
    servers.push({ name, running: alive, ok, error });
  }
  servers.sort((a, b) => {
    // Errors first, then by name.
    if (!!a.error !== !!b.error) return a.error ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { total: servers.length, running, failed, servers };
}

// ── Tailscale surface ────────────────────────────────────────────────────────
//
// Reuse the same `tailscale serve status --json` parse the tui-link flow
// uses. Surfacing the raw Web map lets the TUI show every funnel hostport
// the box currently exposes, not just the one our bridge proxies.

const { execFileSync } = require('child_process');
const { PORT: BRIDGE_PORT } = require('./state');

interface TailscaleSummary {
  available: boolean;
  funnelOn: boolean;
  hosts: Array<{ host: string; proto: string; proxy: string; matchesBridge: boolean }>;
  error?: string;
}

let _tsSecCache: { value: TailscaleSummary; expires: number } | null = null;
const TS_SEC_CACHE_MS = 30 * 1000;

function summarizeTailscale(): TailscaleSummary {
  const now = Date.now();
  if (_tsSecCache && _tsSecCache.expires > now) return _tsSecCache.value;
  const value = probeTailscaleSec();
  _tsSecCache = { value, expires: now + TS_SEC_CACHE_MS };
  return value;
}

function probeTailscaleSec(): TailscaleSummary {
  try {
    const raw = execFileSync('tailscale', ['serve', 'status', '--json'], {
      timeout: 1500,
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
    });
    const parsed = JSON.parse(raw);
    const web = parsed && typeof parsed === 'object' ? parsed.Web : null;
    if (!web || typeof web !== 'object') {
      return { available: true, funnelOn: false, hosts: [] };
    }
    const hosts: TailscaleSummary['hosts'] = [];
    const targetPort = String(BRIDGE_PORT);
    for (const [hostPort, handlersWrap] of Object.entries(web)) {
      const handlers = (handlersWrap as any)?.Handlers;
      if (!handlers || typeof handlers !== 'object') continue;
      const colon = hostPort.lastIndexOf(':');
      if (colon < 0) continue;
      const host = hostPort.slice(0, colon);
      const port = hostPort.slice(colon + 1);
      const isTls = port === '443' || (parsed.TCP && parsed.TCP[port]?.HTTPS === true);
      const proto = isTls ? 'https' : 'http';
      for (const [pth, h] of Object.entries(handlers)) {
        const proxy = (h as any)?.Proxy || '';
        let matchesBridge = false;
        try {
          const u = new URL(proxy);
          if (u.port === targetPort) matchesBridge = true;
        } catch { /* malformed proxy URL */ }
        hosts.push({
          host: `${host}${pth === '/' ? '' : pth}`,
          proto,
          proxy: String(proxy),
          matchesBridge,
        });
      }
    }
    return { available: true, funnelOn: hosts.length > 0, hosts };
  } catch (e: any) {
    return {
      available: false,
      funnelOn: false,
      hosts: [],
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

// ── File integrity (mtimes on secret-bearing files) ──────────────────────────

interface FileEntry {
  label: string;
  path: string;
  exists: boolean;
  mtime?: string;     // ISO
  ageHuman?: string;  // "3h12m ago"
  size?: number;
  mode?: string;      // octal "0600"
  worldReadable?: boolean;
}

function statFile(label: string, p: string): FileEntry {
  try {
    const s = fs.statSync(p);
    const mtimeMs = s.mtimeMs;
    return {
      label,
      path: p,
      exists: true,
      mtime: new Date(mtimeMs).toISOString(),
      ageHuman: humanAge(Date.now() - mtimeMs),
      size: s.size,
      mode: (s.mode & 0o777).toString(8).padStart(4, '0'),
      worldReadable: (s.mode & 0o004) !== 0,
    };
  } catch (_) {
    return { label, path: p, exists: false };
  }
}

function humanAge(ms: number): string {
  if (ms < 0) ms = 0;
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 48) return `${hr}h${min % 60}m ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

function summarizeFiles(): FileEntry[] {
  const BRIDGE_ROOT = path.join(__dirname, '..');
  return [
    statFile('.env',            path.join(BRIDGE_ROOT, '.env')),
    statFile('tui-tokens.json', path.join(BRIDGE_ROOT, 'state', 'tui-tokens.json')),
    statFile('auth-logins.log', AUTH_LOG_PATH),
    statFile('mcp-pids.json',   path.join(BRIDGE_ROOT, 'data', 'mcp-pids.json')),
    statFile('costs.json',      path.join(BRIDGE_ROOT, 'costs.json')),
  ];
}

// ── Process self-report ──────────────────────────────────────────────────────

interface ProcSummary {
  pid: number;
  uptimeSec: number;
  memMb: number;
  nodeVersion: string;
  loadAvg1: number;
}

function summarizeProcess(): ProcSummary {
  const mem = process.memoryUsage();
  return {
    pid: process.pid,
    uptimeSec: Math.floor(process.uptime()),
    memMb: Math.round((mem.rss / 1024 / 1024) * 10) / 10,
    nodeVersion: process.version,
    loadAvg1: Math.round(os.loadavg()[0] * 100) / 100,
  };
}

// ── Route ────────────────────────────────────────────────────────────────────

function registerSecurityRoutes(app: Express): void {
  app.get('/v1/security/overview', (_req: Request, res: Response) => {
    try {
      const { events, logPath, logExists } = tailAuthLog();
      const recentEvents = events.slice(-50);
      res.json({
        success: true,
        generatedAt: new Date().toISOString(),
        auth: {
          ...summarizeAuth(events),
          logPath,
          logExists,
          recent: recentEvents,
        },
        spend: summarizeSpend(),
        mcp: summarizeMcp(),
        tailscale: summarizeTailscale(),
        files: summarizeFiles(),
        process: summarizeProcess(),
      });
    } catch (e: any) {
      res.status(500).json({
        success: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });
}

module.exports = { registerSecurityRoutes };
