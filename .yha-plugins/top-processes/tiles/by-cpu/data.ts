type ExecResult = { stdout: string; stderr: string; code: number };

type Ctx = {
  cwd: string;
  platform?: NodeJS.Platform;
  exec: (cmd: string[], opts?: { cwd?: string; timeoutMs?: number }) => Promise<ExecResult>;
};

type Row = { cpu: string; mem: string; command: string };

async function loadLinux(ctx: Ctx): Promise<Row[]> {
  const { stdout } = await ctx.exec([
    'ps', '-eo', 'pcpu,pmem,comm', '--sort=-pcpu', '--no-headers',
  ]);
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 10)
    .map((line) => {
      const m = line.match(/^(\S+)\s+(\S+)\s+(.*)$/);
      if (!m) return null;
      return { cpu: m[1], mem: m[2], command: m[3] };
    })
    .filter(Boolean) as Row[];
}

async function loadWindows(ctx: Ctx): Promise<Row[]> {
  // Mirrors go-core/internal/tuid/status_windows.go:sampleTop. CPU here is
  // cumulative seconds since process start (not instantaneous %), since
  // computing true % would need two samples with a delta. Sorting by it
  // still surfaces the heaviest processes.
  const psCmd =
    "Get-Process | Where-Object { $_.WS -gt 0 } | Sort-Object CPU -Descending | " +
    "Select-Object -First 10 ProcessName,WS,CPU | ConvertTo-Json -Compress";
  const { stdout, code } = await ctx.exec(
    ['powershell.exe', '-NoProfile', '-Command', psCmd],
    { timeoutMs: 5000 },
  );
  if (code !== 0 || !stdout.trim()) return [];
  // ConvertTo-Json returns a single object when only one match — wrap it.
  let trimmed = stdout.trim();
  if (trimmed.startsWith('{')) trimmed = '[' + trimmed + ']';
  let arr: any[] = [];
  try { arr = JSON.parse(trimmed); } catch { return []; }
  return arr.map((p) => {
    const cpuSec = typeof p?.CPU === 'number' ? p.CPU : 0;
    const wsBytes = typeof p?.WS === 'number' ? p.WS : 0;
    // Synthesize a mem% by dividing WS against total physical mem would
    // need another PS call — show MiB instead, prefixed so it's clear.
    const memMiB = Math.round(wsBytes / (1024 * 1024));
    return {
      cpu: cpuSec.toFixed(0),
      mem: `${memMiB}M`,
      command: String(p?.ProcessName ?? ''),
    };
  });
}

export default async function load(ctx: Ctx) {
  const rows = ctx.platform === 'win32' ? await loadWindows(ctx) : await loadLinux(ctx);
  const head = rows[0];
  const top = head ? `${head.command.split('/').pop()} ${head.cpu}%` : '';
  return { rows, top };
}
