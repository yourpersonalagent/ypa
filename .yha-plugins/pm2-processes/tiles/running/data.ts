type ExecResult = { stdout: string; stderr: string; code: number };

type Ctx = {
  cwd: string;
  platform?: NodeJS.Platform;
  exec: (cmd: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<ExecResult>;
};

type Row = {
  name: string;
  status: string;
  cpuNum: number;
  cpu: string;
  mem: string;
  uptime: string;
  restarts: string;
  pid: string;
};

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

function fmtUptime(startMs: number): string {
  if (!Number.isFinite(startMs) || startMs <= 0) return '—';
  const s = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h}h`;
  return `${Math.floor(h / 24)}d`;
}

async function loadLinux(ctx: Ctx): Promise<Row[]> {
  const { stdout, code } = await ctx.exec(['pm2', 'jlist'], { timeoutMs: 8000 });
  if (code !== 0 || !stdout.trim()) return [];

  const start = stdout.indexOf('[');
  const json = start >= 0 ? stdout.slice(start) : stdout;
  let procs: any[] = [];
  try { procs = JSON.parse(json); } catch { return []; }

  return procs.map((p) => {
    const env = p?.pm2_env ?? {};
    const monit = p?.monit ?? {};
    const cpuNum = typeof monit?.cpu === 'number' ? monit.cpu : 0;
    return {
      name: String(p?.name ?? ''),
      status: String(env?.status ?? ''),
      cpuNum,
      cpu: cpuNum.toFixed(0),
      mem: fmtBytes(Number(monit?.memory ?? 0)),
      uptime: fmtUptime(Number(env?.pm_uptime ?? 0)),
      restarts: String(env?.restart_time ?? 0),
      pid: String(p?.pid ?? ''),
    };
  });
}

type WindowsPidRecord = {
  pid?: number;
  proc_name?: string;
  exe?: string;
  args?: string;
  log?: string;
  started?: string;
};

async function getProcessInfo(
  ctx: Ctx,
  pid: number,
  expectedName: string,
): Promise<{ alive: boolean; wsBytes: number; cpuSec: number; startMs: number }> {
  const psCmd =
    `Get-Process -Id ${pid} -ErrorAction SilentlyContinue | ` +
    `Select-Object Id,ProcessName,WS,CPU,StartTime | ConvertTo-Json -Compress`;
  const { stdout, code } = await ctx.exec(
    ['powershell.exe', '-NoProfile', '-Command', psCmd],
    { timeoutMs: 2000 },
  );
  const blank = { alive: false, wsBytes: 0, cpuSec: 0, startMs: 0 };
  if (code !== 0 || !stdout.trim()) return blank;
  let p: any;
  try { p = JSON.parse(stdout); } catch { return blank; }
  if (!p || typeof p !== 'object' || p.Id !== pid) return blank;
  // Defense against PID reuse: name must match what yha.ps1 recorded.
  if (expectedName && String(p.ProcessName || '').toLowerCase() !== expectedName.toLowerCase()) {
    return blank;
  }
  const startMs = (() => {
    const raw = p.StartTime;
    if (typeof raw !== 'string') return 0;
    const m = raw.match(/\/Date\((\d+)\)\//);
    if (m) return parseInt(m[1], 10);
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : 0;
  })();
  return {
    alive: true,
    wsBytes: typeof p.WS === 'number' ? p.WS : 0,
    cpuSec: typeof p.CPU === 'number' ? p.CPU : 0,
    startMs,
  };
}

async function loadWindows(ctx: Ctx): Promise<Row[]> {
  // Source of truth on Windows is the JSON pid file written by yha.ps1
  // (bridge/state/yha-tui/yha-windows.pids.json). Mirrors what the Go TUI
  // does in go-core/internal/tuid/status_windows.go:samplePM2 — read pids
  // from the file, then enrich each with Get-Process for liveness/WS/CPU.
  const fs = require('fs');
  const path = require('path');
  const pidFile = path.join(ctx.cwd, 'bridge', 'state', 'yha-tui', 'yha-windows.pids.json');
  let raw: Buffer;
  try {
    raw = fs.readFileSync(pidFile);
  } catch {
    // Not started via yha.ps1 yet — empty rows is the right answer
    // (matches "no pm2 processes" on Linux when pm2 isn't installed).
    return [];
  }
  // Strip UTF-8 BOM if PowerShell wrote one.
  if (raw.length >= 3 && raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) {
    raw = raw.subarray(3);
  }
  let recs: Record<string, WindowsPidRecord> = {};
  try {
    recs = JSON.parse(raw.toString('utf8'));
  } catch {
    return [];
  }

  const entries = Object.entries(recs);
  const enriched = await Promise.all(
    entries.map(async ([name, rec]) => {
      const pid = Number(rec?.pid ?? 0);
      if (!pid) {
        return {
          name, status: 'stopped', cpuNum: 0, cpu: '0',
          mem: fmtBytes(0), uptime: '—', restarts: '0', pid: '0',
        } as Row;
      }
      const info = await getProcessInfo(ctx, pid, String(rec?.proc_name || ''));
      return {
        name,
        status: info.alive ? 'online' : 'stopped',
        cpuNum: info.cpuSec,
        cpu: info.cpuSec.toFixed(0),
        mem: fmtBytes(info.wsBytes),
        uptime: fmtUptime(info.startMs),
        restarts: '0', // yha.ps1 doesn't track restarts
        pid: String(pid),
      } as Row;
    }),
  );
  // Stable order so rows don't shuffle every refresh.
  enriched.sort((a, b) => a.name.localeCompare(b.name));
  return enriched;
}

export default async function load(ctx: Ctx) {
  const rows = ctx.platform === 'win32' ? await loadWindows(ctx) : await loadLinux(ctx);
  rows.sort((a, b) => b.cpuNum - a.cpuNum);
  const head = rows[0];
  const top = head ? `${head.name} ${head.cpu}%` : '';
  return { rows, top };
}
