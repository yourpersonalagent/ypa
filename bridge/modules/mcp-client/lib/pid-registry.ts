// ── Persistent MCP child-PID registry ─────────────────────────────────────────
// Bridge children are spawned with `detached:true`, which keeps them alive
// across the bridge's own process replacement (notably `bun --watch`). When
// the new bridge process boots, the original spawning code's `proc.on('exit')`
// handler has been blown away with the JS state, so we lose track of those
// PIDs — they become orphan daemons that hot-loop on a half-closed stdio
// pipe and peg a CPU. The defensive watchdog in bridge/mcp/_parent-watchdog.js
// gives each child the *ability* to self-rescue, but a child that hits an
// edge case (or that predates the patch) needs a sweeper on the next bridge
// boot.
//
// This module persists the list of PIDs the bridge has spawned to
// `bridge/data/mcp-pids.json`. The boot sweep in server.ts reads it before
// the autostart loop and kills any survivors whose /proc/<pid>/cmdline still
// matches the recorded script path — that fingerprint check prevents us from
// nuking a recycled PID that now belongs to some unrelated process.

'use strict';

const fs = require('fs');
const path = require('path');

const PID_FILE = path.join(__dirname, '..', '..', '..', 'data', 'mcp-pids.json');

type Entry = {
  pid: number;
  name: string;
  scriptPath: string;
  spawnedAt: string;
};

function _read(): Entry[] {
  try {
    const raw = JSON.parse(fs.readFileSync(PID_FILE, 'utf8'));
    return Array.isArray(raw) ? raw.filter((e) => e && typeof e.pid === 'number') : [];
  } catch (_) {
    return [];
  }
}

function _write(entries: Entry[]): void {
  try {
    const tmp = PID_FILE + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(entries, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, PID_FILE);
  } catch (_) {
    // Best-effort — losing the registry is non-fatal; the watchdog inside
    // each child is the primary self-rescue.
  }
}

function registerMcpPid(name: string, pid: number, scriptPath: string): void {
  if (!pid || pid <= 0) return;
  const entries = _read().filter((e) => e.pid !== pid);
  entries.push({
    pid,
    name,
    scriptPath: String(scriptPath || ''),
    spawnedAt: new Date().toISOString(),
  });
  _write(entries);
}

function unregisterMcpPid(pid: number): void {
  if (!pid) return;
  const entries = _read();
  const next = entries.filter((e) => e.pid !== pid);
  if (next.length !== entries.length) _write(next);
}

function _isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

// Read /proc/<pid>/cmdline (null-separated argv) and check whether the
// recorded scriptPath appears in any argument. We compare on basename to
// tolerate symlinks/different cwds, but we require the *full* recorded
// scriptPath to substring-match somewhere — that's strong enough to avoid
// killing a recycled PID belonging to an unrelated process.
function _cmdlineMatches(pid: number, scriptPath: string): boolean {
  if (!scriptPath) return false;
  try {
    const raw = fs.readFileSync(`/proc/${pid}/cmdline`);
    const cmdline = raw.toString('utf8').replace(/\0/g, ' ');
    return cmdline.indexOf(scriptPath) !== -1;
  } catch (_) {
    return false;
  }
}

// Sweep the persisted registry: kill any PIDs that are still alive AND
// whose cmdline still references the recorded script path. Returns a list
// of `{name, pid, action}` entries describing what we did. Always truncates
// the file at the end — entries that survived their writer's exit are no
// longer authoritative.
//
// `knownScriptPaths` is the optional set of script paths still configured in
// the current `bridge/mcp-registry.json`. When an entry's scriptPath is in
// that set we KNOW we own that binding (the config still lists it), so we
// skip the cmdline check — that check fires false-negatives whenever a child
// argv changes between bridge versions (different node interpreter path,
// added `--inspect`, repacked .js). The cmdline check remains as the
// fallback when we can't confirm authority through the current config.
function sweepOrphans(
  knownScriptPaths?: Set<string> | string[] | null,
): Array<{ name: string; pid: number; action: 'killed' | 'gone' | 'mismatch' | 'self' }> {
  const known = knownScriptPaths
    ? (knownScriptPaths instanceof Set ? knownScriptPaths : new Set(knownScriptPaths))
    : null;
  const entries = _read();
  const report: Array<{ name: string; pid: number; action: 'killed' | 'gone' | 'mismatch' | 'self' }> = [];
  for (const e of entries) {
    if (e.pid === process.pid) {
      report.push({ name: e.name, pid: e.pid, action: 'self' });
      continue;
    }
    if (!_isAlive(e.pid)) {
      report.push({ name: e.name, pid: e.pid, action: 'gone' });
      continue;
    }
    const inCurrentConfig = !!(known && e.scriptPath && known.has(e.scriptPath));
    if (!inCurrentConfig && !_cmdlineMatches(e.pid, e.scriptPath)) {
      report.push({ name: e.name, pid: e.pid, action: 'mismatch' });
      continue;
    }
    // It's one of ours and still alive — kill the whole process group.
    try { process.kill(-e.pid, 'SIGTERM'); } catch (_) {
      try { process.kill(e.pid, 'SIGTERM'); } catch (_) {}
    }
    report.push({ name: e.name, pid: e.pid, action: 'killed' });
  }
  _write([]);
  return report;
}

module.exports = {
  registerMcpPid,
  unregisterMcpPid,
  sweepOrphans,
  PID_FILE,
};
