// ── #debug subcommand registry, builders, and dispatcher ──────────────────────
// All `#debug <sub>` logic lives here so providers/special.ts stays a
// thin command router. Each builder returns a JSON-serializable payload that
// the frontend's debug-modal renders. The registry's summary() is shown as the
// one-line response in chat; the data is opened in the modal.
//
// IMPORTANT: top-level requires are restricted to leaf modules only (no
// server-chat-helpers, no providers/index.ts barrel, no sessions-internal, no
// sessions-internal/history). Those would close a cycle:
//   server-chat-helpers → providers → providers/special → server-debug
// and Node's circular-require quirk hands back partial `{}` exports, which
// silently breaks `EFFORT_LEVELS` etc. in server-chat-helpers. Anything that
// would re-enter that subgraph is required lazily inside the builders.
'use strict';

const path = require('path');
const fs = require('fs');

const {
  config,
  activeModels,
  displaySessions,
  claudeSessions,
  activeStreams,
  activeProcesses,
  mcpConnections,
  CLAUDE_BIN,
  CODEX_BIN,
  BRIDGE_INTERNAL_KEY,
} = require('../../core/state');
const { getModuleApi } = require('../../core/modules');
const rawLogs = require('../../observability/raw-logs');

// ── go-core active-stream cache ───────────────────────────────────────────────
// After Phase 7, all streams are owned by go-core; the bridge's activeStreams
// Map is empty for those turns. We poll /internal/active-streams every second
// so buildMonitoringDebug can show go-core sessions without going async. For
// each active session we also fetch /v1/sessions/:id/status (cheap, in-memory
// buffer lookup on go-core) to enrich the entry with chunk/listener counts —
// otherwise the Monitoring tab would just show empty placeholders for every
// go-core turn. _goHistorical retains a small ring of recently-finished
// go-core streams so the History tab still has something to show after a
// turn finalises (the cdaac7c8 fix wired live IDs but not history).
const _goCoreUrl = process.env.YHA_GO_CORE_URL || 'http://127.0.0.1:8443';
type GoStreamStatus = {
  id: string;
  status: 'streaming' | 'done' | 'idle';
  chunksTotal?: number;
  listeners?: number;
  startedAt?: number | null;
  doneAt?: number | null;
  finalAt?: number | null;
};
let _goStreamIds: string[] = [];
let _goStreamDetail: Map<string, GoStreamStatus> = new Map();
const _goHistorical: any[] = [];
const _GO_HISTORICAL_CAP = 50;
let _goStreamCacheTimer: any = null;

async function _fetchGoStatus(sid: string): Promise<GoStreamStatus | null> {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 750);
    const r = await fetch(`${_goCoreUrl}/v1/sessions/${encodeURIComponent(sid)}/status`, {
      headers: { 'x-bridge-key': BRIDGE_INTERNAL_KEY },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!r.ok) return null;
    const body: any = await r.json();
    if (!body || typeof body !== 'object') return null;
    return {
      id: sid,
      status: body.status || 'streaming',
      chunksTotal: typeof body.chunksCount === 'number' ? body.chunksCount : (typeof body.chunks === 'number' ? body.chunks : undefined),
      listeners: typeof body.listeners === 'number' ? body.listeners : undefined,
      startedAt: body.startedAt ?? null,
      doneAt: body.doneAt ?? null,
      finalAt: body.finalAt ?? null,
    };
  } catch (_) {
    return null;
  }
}

async function _refreshGoStreamCache(): Promise<void> {
  let nextIds: string[] = [];
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 750);
    const r = await fetch(`${_goCoreUrl}/internal/active-streams`, {
      headers: { 'x-bridge-key': BRIDGE_INTERNAL_KEY },
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!r.ok) { _goStreamIds = []; return; }
    const body: any = await r.json();
    nextIds = Array.isArray(body?.sessions) ? body.sessions : [];
  } catch (_) {
    _goStreamIds = [];
    return;
  }

  // Detect streams that disappeared since the last poll → archive their last
  // known status into _goHistorical so the History tab can show them.
  const prevIds = new Set(_goStreamIds);
  const nextSet = new Set(nextIds);
  for (const sid of prevIds) {
    if (nextSet.has(sid)) continue;
    const last = _goStreamDetail.get(sid);
    if (last) {
      _goHistorical.push({
        id: sid,
        source: 'go-core',
        status: 'done',
        chunkCount: last.chunksTotal || 0,
        startedAt: last.startedAt || null,
        doneAt: last.doneAt || last.finalAt || Date.now(),
        durationMs: last.startedAt ? Math.max(0, (last.doneAt || last.finalAt || Date.now()) - last.startedAt) : null,
      });
      if (_goHistorical.length > _GO_HISTORICAL_CAP) _goHistorical.shift();
    }
    _goStreamDetail.delete(sid);
  }

  _goStreamIds = nextIds;
  // Refresh detail for every active stream. Concurrent + short-timeout so
  // a slow status response doesn't stall the whole cache.
  if (nextIds.length > 0) {
    const detail = await Promise.all(nextIds.map((sid) => _fetchGoStatus(sid)));
    const next: Map<string, GoStreamStatus> = new Map();
    for (let i = 0; i < nextIds.length; i += 1) {
      const sid = nextIds[i];
      const d = detail[i];
      if (d) next.set(sid, d);
      else next.set(sid, { id: sid, status: 'streaming' });
    }
    _goStreamDetail = next;
  } else {
    _goStreamDetail = new Map();
  }
}

// Poll cadence for the go-core active-stream cache. Kept always-on (not gated
// on the FE monitoring panel) because the background snapshotter below also
// reads this cache to log go-core stream activity — gating on FE subscribers
// would starve that logging. unref()'d so the poll never holds the process
// open on its own (matching the prune/snapshot timers), and at 2.5s (was 1s)
// it's still well below the freshness any consumer needs.
const GO_STREAM_POLL_MS = 2500;
function _startGoStreamCacheTimer(): void {
  if (_goStreamCacheTimer) return;
  _refreshGoStreamCache();
  _goStreamCacheTimer = setInterval(() => { _refreshGoStreamCache(); }, GO_STREAM_POLL_MS);
  if (typeof _goStreamCacheTimer.unref === 'function') _goStreamCacheTimer.unref();
}

_startGoStreamCacheTimer();

function _readUpstreamRegistry() {
  return getModuleApi('mcp-client')?.readUpstreamRegistry?.() ?? { mcpServers: {} };
}

// ── helpers ───────────────────────────────────────────────────────────────────

function _basename(p) {
  return p ? path.basename(String(p)) : null;
}

function _cSidSnapshot(v) {
  // claudeSessions value may be a legacy bare string OR a future {id, dir, bin}
  // object. Accept both. Useful for the SUB1/SUB2 mismatch class of bugs.
  if (!v) return null;
  if (typeof v === 'string') return { id: v, dir: null, bin: null, legacy: true };
  return { id: v.id || null, dir: v.dir || null, bin: v.bin || null, ts: v.ts || null };
}

// ── chathistory ───────────────────────────────────────────────────────────────
// Absorbed the old "session" debug view in 2026 — the unique parts
// (display-session metadata, claude --resume binding, cwd) are about the same
// chat session, so they live here as the "Session State" tab. The redundant
// pieces (chatHistoryPreview, active-stream/process snapshots) were dropped
// because "What Models See" already shows processed history in full and
// Monitoring owns stream/process lifecycle.

function buildChathistoryDebug(sessionId) {
  const { getHistory, getMaxHistoryTurns, getHistoryMode, getMaxHistoryChars } = require('../../sessions-internal/history');
  const { getSessionCwd } = require('../../sessions-internal');
  const displaySession = displaySessions.get(sessionId);
  const displayMessages = displaySession?.messages || [];
  const processedHistory = getHistory(sessionId);
  const cSidRaw = claudeSessions.get(sessionId) || null;
  const cfgInfo = {
    maxTurns: getMaxHistoryTurns(),
    mode: getHistoryMode(),
    maxChars: getMaxHistoryChars(),
  };
  return {
    sessionId,
    cwd: getSessionCwd(sessionId),
    config: cfgInfo,
    currentModel: { ...activeModels.llm },
    displayMessages,
    processedHistory,
    display: displaySession ? {
      name: displaySession.name,
      createdAt: displaySession.createdAt,
      lastUsed: displaySession.lastUsed,
      viewedAt: displaySession.viewedAt,
      workingDir: displaySession.workingDir,
      messageCount: displaySession.messages?.length || 0,
      userMessageCount: displaySession.userMessageCount || 0,
      participants: displaySession.participants || [],
      groupMode: displaySession.groupMode || null,
      boundWorkflowName: displaySession.boundWorkflowName || null,
    } : null,
    cSid: _cSidSnapshot(cSidRaw),
    stats: {
      displayCount: displayMessages.length,
      processedCount: processedHistory.length,
      processedChars: processedHistory.reduce(
        (sum, e) => sum + String(e.content || '').length,
        0
      ),
    },
  };
}

// ── routing ───────────────────────────────────────────────────────────────────

function buildRoutingDebug(_sessionId) {
  const { resolveRouteType, isClaudeModel } = require('../../providers/core');
  const { resolveClaudeConfigDir, resolveCodexConfigDir, resolveClaudeBin, resolveCodexBin } = require('../../chat/helpers');
  const modelId = activeModels.llm.model;
  const providerHint = activeModels.llm.provider || undefined;
  const apProv = config.providers?.find((p) => p.name === 'Anthropic');
  const route = resolveRouteType(modelId, providerHint, {
    isSlash: false,
    apiKey: apProv?.api_key,
    apiMode: config.defaults?.anthropicApiMode,
    claudeRuntime: config.defaults?.claudeRuntime,
  });

  // Default-instance picks (no per-request HarnessInstance picker override)
  const defClaudeDir = resolveClaudeConfigDir();
  const defClaudeBin = resolveClaudeBin();
  const defCodexDir = resolveCodexConfigDir();
  const defCodexBin = resolveCodexBin();

  // Subscription-encoded provider would override the picker
  void isClaudeModel; // referenced below in the return value
  let effectiveDir = route.type === 'codex' ? defCodexDir : defClaudeDir;
  let effectiveBin =
    route.type === 'codex' ? defCodexBin || CODEX_BIN : defClaudeBin || CLAUDE_BIN;
  if (route.subscription?.instance) {
    const inst = route.subscription.instance;
    effectiveDir = inst.configDir || effectiveDir;
    if (route.type === 'codex') effectiveBin = inst.codexBin || effectiveBin;
    else effectiveBin = inst.claudeBin || effectiveBin;
  }

  const claudeRuntime = config.defaults?.claudeRuntime || 'binary';
  let actualPath;
  if (route.type === 'codex') actualPath = 'codex-binary (providers/codex)';
  else if (route.type === 'external') actualPath = 'direct-openai/gemini (tools/stream)';
  else if (route.type === 'direct-anthropic')
    actualPath = 'direct-anthropic-api (tools/stream)';
  else if (route.type === 'claude' && claudeRuntime === 'sdk')
    actualPath = 'claude-agent-sdk (server-claude-agent.streamClaudeViaSdk)';
  else actualPath = 'claude-binary (providers/claude-stream)';

  return {
    modelId,
    providerHint: providerHint || null,
    isClaudeModel: isClaudeModel(modelId),
    anthropicApiKeyPresent: !!apProv?.api_key,
    anthropicApiMode: config.defaults?.anthropicApiMode || null,
    claudeRuntime,
    route,
    bin: { full: effectiveBin, basename: _basename(effectiveBin) },
    configDir: effectiveDir,
    actualPath,
    instances: {
      claude: (config.defaults?.claudeInstances || []).map((i) => ({
        label: i.label,
        configDir: i.configDir,
        claudeBin: i.claudeBin || null,
      })),
      codex: (config.defaults?.codexInstances || []).map((i) => ({
        label: i.label,
        configDir: i.configDir,
        codexBin: i.codexBin || null,
      })),
    },
  };
}

// ── mcp ───────────────────────────────────────────────────────────────────────

function buildMcpDebug() {
  const reg = _readUpstreamRegistry().mcpServers || {};
  const servers = Object.entries(reg).map(([name, cfg]) => {
    const conn = mcpConnections.get(name) || {};
    const running = !!(conn.proc && conn.proc.exitCode === null && !conn.proc.killed);
    return {
      name,
      command: (cfg as any).command || '',
      args: (cfg as any).args || [],
      configured: true,
      running,
      ok: !!(running && conn.ok === true),
      tools: conn.tools?.length || 0,
      prompts: conn.prompts?.length || 0,
      resources: conn.resources?.length || 0,
      pendingRequests: conn.pending?.size || 0,
      error: conn.error || null,
    };
  });
  // Surface orphan connections (running but no longer in the registry)
  for (const [name] of mcpConnections) {
    if (reg[name]) continue;
    const conn = mcpConnections.get(name) || {};
    const running = !!(conn.proc && conn.proc.exitCode === null && !conn.proc.killed);
    servers.push({
      name,
      command: '',
      args: [],
      configured: false,
      running,
      ok: false,
      tools: conn.tools?.length || 0,
      prompts: conn.prompts?.length || 0,
      resources: conn.resources?.length || 0,
      pendingRequests: conn.pending?.size || 0,
      error: 'orphan: running but not in registry',
    });
  }
  const counts = {
    configured: Object.keys(reg).length,
    running: servers.filter((s) => s.running).length,
    errored: servers.filter((s) => s.error).length,
    totalTools: servers.reduce((s, x) => s + x.tools, 0),
  };
  return { servers, ...counts };
}

// ── costs ─────────────────────────────────────────────────────────────────────

function buildCostsDebug(_sessionId) {
  const { loadCosts } = require('./costs');
  const data = loadCosts() || { allTime: { total: 0, byModel: {}, byProvider: {} }, daily: {} };
  const today = new Date().toISOString().slice(0, 10);
  const todayEntry = data.daily?.[today] || { total: 0, byModel: {}, byProvider: {} };
  const sortDesc = (obj) => Object.entries(obj || {})
    .map(([k, v]) => ({ key: k, value: Number(v) || 0 }))
    .sort((a, b) => b.value - a.value);
  const recentDays = Object.entries(data.daily || {})
    .sort(([a], [b]) => (a < b ? 1 : -1))
    .slice(0, 14)
    .map(([day, entry]: [string, any]) => ({ day, total: entry?.total || 0 }));
  return {
    today,
    allTimeTotal: data.allTime?.total || 0,
    todayTotal: todayEntry.total || 0,
    allTimeByModel: sortDesc(data.allTime?.byModel),
    allTimeByProvider: sortDesc(data.allTime?.byProvider),
    todayByModel: sortDesc(todayEntry.byModel),
    todayByProvider: sortDesc(todayEntry.byProvider),
    recentDays,
  };
}

// ── tokens (raw input/cache/output token counts + perf stats per day) ────────

function buildTokensDebug(_sessionId) {
  const { loadTokens } = require('./tokens');
  const { getModelPricing } = require('../../models');
  const data = loadTokens() || { daily: {} };

  // Pricing lookup with sensible Anthropic-flavored fallbacks. Cache prices
  // aren't in config.json today, so we derive them from the input price ratio
  // (Anthropic public pricing: cache_write 1.25× input, cache_read 0.1× input).
  // OpenAI's cached_tokens is 0.5× input on most models — close enough; we
  // bias to the more conservative 0.1× ratio used by Anthropic and let users
  // upgrade later by adding price_cache_read / price_cache_write to config.
  function priceFor(key) {
    const lastSlash = key.lastIndexOf('/');
    const modelId = lastSlash >= 0 ? key.slice(lastSlash + 1) : key;
    const pricing = getModelPricing(modelId) || {};
    const pIn = pricing.price_input ?? 0;
    const pOut = pricing.price_output ?? 0;
    const pCw = pricing.price_cache_write ?? pIn * 1.25;
    const pCr = pricing.price_cache_read ?? pIn * 0.1;
    return { pIn, pOut, pCw, pCr };
  }

  // Sort days ascending and trim to last 30 — fits the chart window without
  // bloating the FE payload. Older days remain in tokens.json untouched.
  const allDays = Object.keys(data.daily || {}).sort();
  const days = allDays.slice(-30);

  // Aggregate "by model" across the visible window so the user can see which
  // model dominated their week, not just one day at a time.
  const byKey: Record<string, any> = {};
  for (const day of days) {
    const dayData = data.daily[day]?.byKey || {};
    for (const [k, v] of Object.entries(dayData) as Array<[string, any]>) {
      if (!byKey[k]) byKey[k] = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, calls: 0, durationMs: 0, toolCalls: 0, textLength: 0 };
      const a = byKey[k];
      a.input += v.input || 0;
      a.cacheWrite += v.cacheWrite || 0;
      a.cacheRead += v.cacheRead || 0;
      a.output += v.output || 0;
      a.calls += v.calls || 0;
      a.durationMs += v.durationMs || 0;
      a.toolCalls += v.toolCalls || 0;
      a.textLength += v.textLength || 0;
    }
  }

  // Per-day totals summed across all models — fuels the whole-account stacked
  // bar chart. Cost-share is computed FE-side using priceTable so the user
  // can toggle count↔cost without re-fetching.
  const dailyTotals: Record<string, any> = {};
  for (const day of days) {
    const t = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0, calls: 0, durationMs: 0, toolCalls: 0, textLength: 0 };
    for (const [, v] of Object.entries(data.daily[day]?.byKey || {}) as Array<[string, any]>) {
      t.input += v.input || 0;
      t.cacheWrite += v.cacheWrite || 0;
      t.cacheRead += v.cacheRead || 0;
      t.output += v.output || 0;
      t.calls += v.calls || 0;
      t.durationMs += v.durationMs || 0;
      t.toolCalls += v.toolCalls || 0;
      t.textLength += v.textLength || 0;
    }
    dailyTotals[day] = t;
  }

  // Resolve a price table for every key seen. The renderer multiplies token
  // counts by these to compute cost-share weights.
  const priceTable: Record<string, any> = {};
  for (const k of Object.keys(byKey)) priceTable[k] = priceFor(k);

  // Per-day, per-key matrix — needed for the "By model" stacked rows where
  // each model gets its own row of bars. Skip days with no activity so the
  // chart doesn't render empty bars on weekends.
  const matrix: Record<string, Record<string, any>> = {};
  for (const day of days) matrix[day] = data.daily[day]?.byKey || {};

  return {
    days,
    dailyTotals,
    byKey,
    matrix,
    priceTable,
  };
}

// ── monitoring (process + stream telemetry) ──────────────────────────────────
// Lightweight runtime metrics for the #debug monitoring panel. Two paths:
//   1. _sampleCpuPercent() — instant percent since last call (used by the
//      "Backend" tab fill-bar so the user sees current load).
//   2. _resourceSampler — runs unconditionally every SAMPLE_INTERVAL_MS,
//      keeping a rolling 15 min ring of {at, cpuPct, rssMb, heapUsedMb,
//      load1}. The "History" tab renders this as a sparkline so heap-creep
//      / cpu-spikes / load-bursts become visible without the user babysitting
//      the modal.

let _lastCpuSnap = process.cpuUsage();
let _lastCpuAt = Date.now();
function _sampleCpuPercent() {
  const now = Date.now();
  const cpu = process.cpuUsage(_lastCpuSnap);
  const elapsedMs = now - _lastCpuAt;
  _lastCpuSnap = process.cpuUsage();
  _lastCpuAt = now;
  if (elapsedMs <= 0) return 0;
  // cpu.user / cpu.system are microseconds across all cores; divide by 1000
  // to get ms then by elapsedMs to get fraction. Multiply by 100 for %.
  const cpuMs = (cpu.user + cpu.system) / 1000;
  return Math.round((cpuMs / elapsedMs) * 1000) / 10; // one decimal place
}

const _resourceSamples: Array<{ at: number; cpuPct: number; rssMb: number; heapUsedMb: number; heapTotalMb: number; load1: number }> = [];
const RESOURCE_CAP = 60;
const SAMPLE_INTERVAL_MS = 15_000;

// ── /proc system samples (parallel ring to _resourceSamples) ─────────────────
// What `top` shows, read directly from /proc — no shelling out (a `top -bn1`
// spawn would take ~1-2s of wall time and itself show up in the CPU it's
// measuring). Each sample captures four buckets so the user can see *where*
// CPU went, not just that yha's Node process used N%:
//   (a) system-wide CPU breakdown (us/sy/id/wa/st …) from /proc/stat
//   (b) load avg + task counts (running/total) from /proc/loadavg
//   (c) memory pressure from /proc/meminfo
//   (d) top-N processes by CPU from /proc/[pid]/stat + /proc/[pid]/status
//
// Per-process CPU uses the kernel's utime+stime jiffies (what `top` shows),
// NOT Node's process.cpuUsage() — they're close for the bridge PID but not
// identical (different counters, different rounding). The Monitoring tab
// renders both side-by-side so the discrepancy is visible, not hidden.
//
// Telemetry correlation: we also stash a 15s window snapshot of the
// telemetry aggregator so a CPU spike can be matched against "which
// tools/routes ran hot during this tick" without a second backend round-trip.
type SystemSample = {
  at: number;
  cpu: {
    userPct: number; nicePct: number; systemPct: number; idlePct: number;
    iowaitPct: number; irqPct: number; softirqPct: number; stealPct: number;
    nonIdlePct: number; // (1 - idle - iowait) — the "system busy" number
  };
  load: { l1: number; l5: number; l15: number; running: number; total: number };
  mem: {
    totalMb: number; freeMb: number; availableMb: number;
    buffersMb: number; cachedMb: number; usedMb: number;
    swapTotalMb: number; swapFreeMb: number; swapUsedMb: number;
  };
  topProcs: Array<{ pid: number; cpuPct: number; memPct: number; rssMb: number; command: string; isYha: boolean }>;
  telemetry15s: {
    totalCalls: number;
    topByP95: Array<{ surface: string; name: string; p95Ms: number; calls: number }>;
    topByCalls: Array<{ surface: string; name: string; calls: number; p95Ms: number }>;
  };
};
const _systemSamples: SystemSample[] = [];

// Persisted snapshots for delta computation. First tick after process boot
// has no previous snapshot, so we emit zeroes for that single sample.
let _lastSystemCpuRaw: number[] | null = null;
let _lastSystemCpuTotal = 0;
let _lastProcCpu: Map<number, number> = new Map();
let _clockTicks = 100; // fallback; queried lazily

function _readClockTicks(): number {
  try {
    const cp = require('child_process');
    const out = cp.execSync('getconf CLK_TCK', { encoding: 'utf8', timeout: 500 }).trim();
    const n = parseInt(out, 10);
    if (Number.isFinite(n) && n > 0) return n;
  } catch (_) {}
  return 100;
}

function _readProcStatCpu(): { buckets: number[]; total: number } | null {
  try {
    const txt = fs.readFileSync('/proc/stat', 'utf8');
    const line = txt.split('\n', 1)[0]; // "cpu  u n s i w irq sirq st g gn"
    const parts = line.trim().split(/\s+/).slice(1).map((s: string) => parseInt(s, 10));
    if (!parts.length || parts.some((n: number) => !Number.isFinite(n))) return null;
    const total = parts.reduce((a: number, b: number) => a + b, 0);
    return { buckets: parts, total };
  } catch (_) { return null; }
}

function _readLoadAvg(): { l1: number; l5: number; l15: number; running: number; total: number } | null {
  try {
    const txt = fs.readFileSync('/proc/loadavg', 'utf8').trim();
    // "0.10 0.20 0.30 2/345 12345"
    const parts = txt.split(/\s+/);
    const tasks = (parts[3] || '0/0').split('/');
    return {
      l1: parseFloat(parts[0]) || 0,
      l5: parseFloat(parts[1]) || 0,
      l15: parseFloat(parts[2]) || 0,
      running: parseInt(tasks[0], 10) || 0,
      total: parseInt(tasks[1], 10) || 0,
    };
  } catch (_) { return null; }
}

function _readMemInfo(): SystemSample['mem'] | null {
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const get = (key: string): number => {
      const m = txt.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'));
      return m ? parseInt(m[1], 10) : 0;
    };
    const totalKb = get('MemTotal');
    const freeKb = get('MemFree');
    const availKb = get('MemAvailable');
    const buffersKb = get('Buffers');
    const cachedKb = get('Cached');
    const swapTotalKb = get('SwapTotal');
    const swapFreeKb = get('SwapFree');
    const toMb = (kb: number) => Math.round(kb / 1024);
    return {
      totalMb: toMb(totalKb),
      freeMb: toMb(freeKb),
      availableMb: toMb(availKb),
      buffersMb: toMb(buffersKb),
      cachedMb: toMb(cachedKb),
      usedMb: toMb(totalKb - availKb), // matches `free`/`top` "used" definition
      swapTotalMb: toMb(swapTotalKb),
      swapFreeMb: toMb(swapFreeKb),
      swapUsedMb: toMb(swapTotalKb - swapFreeKb),
    };
  } catch (_) { return null; }
}

function _readProcStat(pid: number): { cpuJiffies: number; comm: string } | null {
  try {
    const txt = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // /proc/[pid]/stat fields are space-separated, but field 2 (comm) is
    // enclosed in parentheses and may contain spaces — find the LAST ')' and
    // split fields after that, so a process named "Web Content (Foo Bar)"
    // doesn't mis-parse.
    const closeParen = txt.lastIndexOf(')');
    if (closeParen < 0) return null;
    const commStart = txt.indexOf('(') + 1;
    const comm = txt.slice(commStart, closeParen);
    const tail = txt.slice(closeParen + 2).split(/\s+/);
    // After field 2: state(3) ppid(4) pgrp(5) … utime(14) stime(15). Index
    // into `tail` is shifted: tail[0] = state, so utime = tail[11], stime = tail[12].
    const utime = parseInt(tail[11], 10) || 0;
    const stime = parseInt(tail[12], 10) || 0;
    return { cpuJiffies: utime + stime, comm };
  } catch (_) { return null; }
}

function _readProcRssKb(pid: number): number {
  try {
    const txt = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = txt.match(/^VmRSS:\s+(\d+)/m);
    return m ? parseInt(m[1], 10) : 0;
  } catch (_) { return 0; }
}

function _readTopProcs(systemCpuDelta: number, totalMemKb: number, limit: number): SystemSample['topProcs'] {
  // Pass 1: snapshot CPU jiffies for every PID. Cheap (single stat read each)
  // — we need *all* PIDs to compute deltas, can't skip any without losing
  // accuracy on a process that briefly dropped out of the top-N.
  let pids: number[] = [];
  try {
    pids = fs.readdirSync('/proc')
      .filter((n: string) => /^\d+$/.test(n))
      .map((n: string) => parseInt(n, 10));
  } catch (_) { return []; }
  const nextCpu = new Map<number, number>();
  const commByPid = new Map<number, string>();
  const cpuPctByPid: Array<{ pid: number; cpuPct: number; comm: string }> = [];
  const ncpu = Math.max(1, require('os').cpus()?.length || 1);
  for (const pid of pids) {
    const st = _readProcStat(pid);
    if (!st) continue;
    nextCpu.set(pid, st.cpuJiffies);
    commByPid.set(pid, st.comm);
    if (systemCpuDelta > 0 && _lastProcCpu.size) {
      const prev = _lastProcCpu.get(pid);
      if (prev != null) {
        // Irix mode (default `top`): % can exceed 100 on multi-core boxes.
        const cpuPct = ((st.cpuJiffies - prev) / systemCpuDelta) * 100 * ncpu;
        if (cpuPct > 0.1) cpuPctByPid.push({ pid, cpuPct, comm: st.comm });
      }
    }
  }
  _lastProcCpu = nextCpu;
  if (!cpuPctByPid.length) return [];
  // Pass 2: take top-N by CPU and enrich with RSS. We only stat() RSS for the
  // top entries — keeps the per-tick cost ~constant regardless of how many
  // processes are on the box.
  cpuPctByPid.sort((a, b) => b.cpuPct - a.cpuPct);
  const top = cpuPctByPid.slice(0, limit);
  const yhaPid = process.pid;
  return top.map((p) => {
    const rssKb = _readProcRssKb(p.pid);
    const memPct = totalMemKb > 0 ? (rssKb / totalMemKb) * 100 : 0;
    return {
      pid: p.pid,
      cpuPct: Math.round(p.cpuPct * 10) / 10,
      memPct: Math.round(memPct * 10) / 10,
      rssMb: Math.round(rssKb / 1024),
      command: p.comm,
      isYha: p.pid === yhaPid,
    };
  });
}

function _sampleTelemetry15s(): SystemSample['telemetry15s'] {
  // Aggregate over a window that matches the system-sample cadence so the row
  // is "what ran in the same 15s slice as this CPU sample". Top-by-p95 surfaces
  // slow individual calls; top-by-calls surfaces high-volume ones — both are
  // legitimate ways CPU disappears.
  try {
    const telemetry = require('./telemetry');
    const agg = telemetry.aggregate({ windowMs: SAMPLE_INTERVAL_MS });
    const rows = (agg.rows || []).filter((r: any) => r.surface === 'tool' || r.surface === 'route' || r.surface === 'mcp');
    const byP95 = rows.slice().sort((a: any, b: any) => (b.p95DurationMs || 0) - (a.p95DurationMs || 0));
    const byCalls = rows.slice().sort((a: any, b: any) => (b.calls || 0) - (a.calls || 0));
    return {
      totalCalls: agg.totalEvents || 0,
      topByP95: byP95.slice(0, 5).map((r: any) => ({ surface: r.surface, name: r.name, p95Ms: r.p95DurationMs || 0, calls: r.calls })),
      topByCalls: byCalls.slice(0, 5).map((r: any) => ({ surface: r.surface, name: r.name, calls: r.calls, p95Ms: r.p95DurationMs || 0 })),
    };
  } catch (_) {
    return { totalCalls: 0, topByP95: [], topByCalls: [] };
  }
}

function _sampleSystem(): SystemSample | null {
  const cpu = _readProcStatCpu();
  if (!cpu) return null;
  const load = _readLoadAvg() || { l1: 0, l5: 0, l15: 0, running: 0, total: 0 };
  const mem = _readMemInfo() || { totalMb: 0, freeMb: 0, availableMb: 0, buffersMb: 0, cachedMb: 0, usedMb: 0, swapTotalMb: 0, swapFreeMb: 0, swapUsedMb: 0 };
  // CPU bucket order from /proc/stat: user nice system idle iowait irq softirq steal [guest guest_nice]
  const totalDelta = _lastSystemCpuTotal > 0 ? cpu.total - _lastSystemCpuTotal : 0;
  const bucketDelta = (_lastSystemCpuRaw && totalDelta > 0)
    ? cpu.buckets.map((v, i) => v - (_lastSystemCpuRaw![i] || 0))
    : cpu.buckets.map(() => 0);
  _lastSystemCpuRaw = cpu.buckets;
  _lastSystemCpuTotal = cpu.total;
  const pct = (n: number) => totalDelta > 0 ? Math.round((n / totalDelta) * 1000) / 10 : 0;
  const cpuPcts = {
    userPct: pct(bucketDelta[0] || 0),
    nicePct: pct(bucketDelta[1] || 0),
    systemPct: pct(bucketDelta[2] || 0),
    idlePct: pct(bucketDelta[3] || 0),
    iowaitPct: pct(bucketDelta[4] || 0),
    irqPct: pct(bucketDelta[5] || 0),
    softirqPct: pct(bucketDelta[6] || 0),
    stealPct: pct(bucketDelta[7] || 0),
    nonIdlePct: 0,
  };
  cpuPcts.nonIdlePct = Math.max(0, Math.round((100 - cpuPcts.idlePct - cpuPcts.iowaitPct) * 10) / 10);
  // totalMemKb for %MEM: /proc/meminfo MemTotal in KB. We rounded to MB above
  // for display; recover the KB number once for proc-pct calculation.
  let totalMemKb = 0;
  try {
    const txt = fs.readFileSync('/proc/meminfo', 'utf8');
    const m = txt.match(/^MemTotal:\s+(\d+)/m);
    totalMemKb = m ? parseInt(m[1], 10) : 0;
  } catch (_) {}
  const topProcs = _readTopProcs(totalDelta, totalMemKb, 10);
  return {
    at: Date.now(),
    cpu: cpuPcts,
    load,
    mem,
    topProcs,
    telemetry15s: _sampleTelemetry15s(),
  };
}

// Independent CPU baseline for the background sampler — must NOT share
// _lastCpuSnap with the on-demand fill-bar, otherwise both samplers steal
// each other's deltas and report ~0% alternately.
let _bgCpuSnap = process.cpuUsage();
let _bgCpuAt = Date.now();
let _resourceTimer: any = null;
function _startResourceSampler(): void {
  if (_resourceTimer) return;
  // One-time clock-tick query so per-process CPU math can convert jiffies
  // <-> seconds if needed later. We don't currently surface per-second
  // numbers but cache the value so a future renderer doesn't have to.
  _clockTicks = _readClockTicks();
  void _clockTicks; // intentionally unused for now; retained for symmetry
  const tick = () => {
    const os = require('os');
    const now = Date.now();
    const cpu = process.cpuUsage(_bgCpuSnap);
    const elapsedMs = now - _bgCpuAt;
    _bgCpuSnap = process.cpuUsage();
    _bgCpuAt = now;
    const cpuMs = (cpu.user + cpu.system) / 1000;
    const cpuPct = elapsedMs > 0 ? Math.round((cpuMs / elapsedMs) * 1000) / 10 : 0;
    const mem = process.memoryUsage();
    _resourceSamples.push({
      at: now,
      cpuPct,
      rssMb: Math.round(mem.rss / 1024 / 1024),
      heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      heapTotalMb: Math.round(mem.heapTotal / 1024 / 1024),
      load1: os.loadavg()[0],
    });
    if (_resourceSamples.length > RESOURCE_CAP) _resourceSamples.shift();
    // System sample is wrapped — a transient /proc read failure must not
    // break the existing Node-side ring.
    try {
      const s = _sampleSystem();
      if (s) {
        _systemSamples.push(s);
        if (_systemSamples.length > RESOURCE_CAP) _systemSamples.shift();
      }
    } catch (e) {
      // First failure logs; silent afterwards to avoid noisy logs on systems
      // without /proc (macOS dev box etc.).
      if (!(_startResourceSampler as any)._sysWarned) {
        (_startResourceSampler as any)._sysWarned = true;
        console.warn('[debug.system-sampler] /proc read failed:', e instanceof Error ? e.message : String(e));
      }
    }
  };
  // Take an initial sample immediately so the first panel open isn't empty.
  tick();
  _resourceTimer = setInterval(tick, SAMPLE_INTERVAL_MS);
  // Don't keep the process alive just for the sampler.
  if (typeof _resourceTimer.unref === 'function') _resourceTimer.unref();
}

// Boot the sampler at module load — server-debug is required by the routes
// barrel during server bootstrap, so this fires once per process.
_startResourceSampler();

// ── monitoring snapshot logger ───────────────────────────────────────────────
// Periodically writes a full monitoring snapshot to disk so a Claude Code
// session helping debug streaming issues can `tail` / `grep` historical state
// instead of asking the user to paste another live snapshot every iteration.
// FE-side metrics (browser net + reconnect counters) come in via
// POST /v1/debug/snapshot/fe and are interleaved into the same file by ts.
// Format: NDJSON, one record per line, {ts, source: 'be'|'fe', data}.
// Daily file rotation keeps individual files small and easy to grep.
// (fs is required at the top of the module.)
// Per-user (Q16) — routed via bridge/core/paths.ts.
// Falls back to bridge/monitoring-log/ pre-migration.
const MONITORING_LOG_DIR = require('../../core/paths').monitoringLogDir;
const SNAPSHOT_INTERVAL_MS = 60_000;
const MONITORING_LOG_RETENTION_DAYS = 7;

function _ensureMonitoringDir(): void {
  try { fs.mkdirSync(MONITORING_LOG_DIR, { recursive: true }); } catch (_) {}
}

function _monitoringLogPath(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return path.join(MONITORING_LOG_DIR, `${y}-${m}-${d}.ndjson`);
}

function _appendMonitoringLog(record: Record<string, unknown>): void {
  try {
    _ensureMonitoringDir();
    fs.appendFileSync(_monitoringLogPath(), JSON.stringify(record) + '\n');
  } catch (_) {}
}

function _pruneOldMonitoringLogs(): void {
  try {
    if (!fs.existsSync(MONITORING_LOG_DIR)) return;
    const cutoff = Date.now() - MONITORING_LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(MONITORING_LOG_DIR)) {
      if (!name.endsWith('.ndjson')) continue;
      const full = path.join(MONITORING_LOG_DIR, name);
      const stat = fs.statSync(full);
      if (stat.mtimeMs < cutoff) fs.unlinkSync(full);
    }
  } catch (_) {}
}

let _snapshotTimer: any = null;
function _startMonitoringSnapshotter(): void {
  if (_snapshotTimer) return;
  const tick = () => {
    try {
      // Skip writes when truly idle (no streams, no processes, no listeners
      // since last snapshot) — keeps the log focused on periods where there
      // was actually something to observe.
      const data = buildMonitoringDebug(null);
      const t = (data as any).totals || {};
      const idle = t.activeStreams === 0 && t.activeProcesses === 0 && t.streamingNow === 0;
      // Always write at least one heartbeat per 5 min so timestamps don't
      // disappear from the log during long quiet spells (lets us bisect
      // "did the bridge crash, or was nothing happening?").
      const now = Date.now();
      const lastWrite = (_startMonitoringSnapshotter as any)._lastWriteAt || 0;
      if (idle && now - lastWrite < 5 * 60_000) return;
      (_startMonitoringSnapshotter as any)._lastWriteAt = now;
      _appendMonitoringLog({ ts: new Date(now).toISOString(), source: 'be', data });
    } catch (_) {}
  };
  // First tick immediately so the file is populated even if the user grabs
  // it within the first minute of bridge boot.
  tick();
  _snapshotTimer = setInterval(tick, SNAPSHOT_INTERVAL_MS);
  if (typeof _snapshotTimer.unref === 'function') _snapshotTimer.unref();
  // Daily prune — runs alongside the snapshot tick at low frequency.
  const pruneTimer = setInterval(_pruneOldMonitoringLogs, 24 * 60 * 60_000);
  if (typeof pruneTimer.unref === 'function') pruneTimer.unref();
  _pruneOldMonitoringLogs();
}

_startMonitoringSnapshotter();

function recordFrontendSnapshot(payload: Record<string, unknown>): void {
  _appendMonitoringLog({ ts: new Date().toISOString(), source: 'fe', data: payload });
}

// ── tools/skills/mcp/route monitoring (server-telemetry aggregation) ─────────
// Builds the data feed for the "Tools, Skills & MCP monitoring" tab in the
// debug modal. Splits the aggregator output into per-surface views the FE
// can render as separate sub-tabs, and adds derived signals:
//   - which MCP servers exist and how many tools they expose (joined from
//     mcpConnections so the panel can show "configured but unused" rows)
//   - which meta tools/skills exist (joined from meta-lib) so we can flag
//     "defined but never invoked" — the article's actual valid point
//
// All data comes from the in-memory ring (24h window by default). The
// aggregator is cheap; we recompute on each panel open / refresh.

function buildToolsMonitoringDebug(_sessionId) {
  // Each section is wrapped in _section() so one subsystem failing
  // (skills-editor missing on disk, mcp connection with malformed tools[],
  // telemetry ring corrupted, etc.) degrades to an empty array instead of
  // 500ing the whole #debug toolsmon view. The first failure also prints a
  // stack to stderr so pm2 logs surface the cause on next click.
  const _sectionErrors: Record<string, string> = {};
  const _section = <T,>(name: string, fallback: T, fn: () => T): T => {
    try { return fn(); }
    catch (e) {
      const msg = e instanceof Error ? (e.stack || e.message || String(e)) : String(e);
      _sectionErrors[name] = msg.split('\n')[0] || 'unknown';
      console.error(`[debug.toolsmon] section "${name}" failed:`, msg);
      return fallback;
    }
  };

  const telemetry = require('./telemetry');
  const meta = require('../skills-editor/lib');

  const agg = _section('telemetry.aggregate', {
    windowMs: 24 * 60 * 60 * 1000, totalEvents: 0, rows: [],
    bySurface: { mcp: {calls:0,ok:0,errors:0,errorRate:0}, tool: {calls:0,ok:0,errors:0,errorRate:0}, skill: {calls:0,ok:0,errors:0,errorRate:0}, route: {calls:0,ok:0,errors:0,errorRate:0}, memory: {calls:0,ok:0,errors:0,errorRate:0}, workflow: {calls:0,ok:0,errors:0,errorRate:0} },
    ringSize: 0, ringCap: 0, enabled: false,
  }, () => telemetry.aggregate({ windowMs: 24 * 60 * 60 * 1000 }));
  const lifetime = _section('telemetry.lifetimeCounts', {}, () => telemetry.lifetimeCounts());

  // Surface partitioning. Each tab on the FE consumes one of these.
  const byTool = (agg.rows || []).filter((r) => r.surface === 'tool');
  const bySkill = (agg.rows || []).filter((r) => r.surface === 'skill');
  const byMcp = (agg.rows || []).filter((r) => r.surface === 'mcp');
  const byRoute = (agg.rows || []).filter((r) => r.surface === 'route');
  const byMemory = (agg.rows || []).filter((r) => r.surface === 'memory');
  const byWorkflow = (agg.rows || []).filter((r) => r.surface === 'workflow');

  // Cross-reference MCP rows with running connections so the FE can show
  // "this server is up + has N tools" alongside the call counts.
  const mcpServers = _section('mcpServers', [] as any[], () => {
    const out: any[] = [];
    for (const [name, conn] of mcpConnections as Map<string, any>) {
      const running = !!(conn?.proc && conn.proc.exitCode === null && !conn.proc.killed);
      // Filter null/undefined tool entries defensively — a half-initialised
      // MCP connection can have placeholder entries before the first
      // tools/list response lands.
      const toolsArr = Array.isArray(conn?.tools) ? conn.tools.filter((t) => t && typeof t.name === 'string') : [];
      const exposedTools = toolsArr.map((t) => t.name);
      const exposedToolDescs = toolsArr.reduce((acc, t) => {
        acc[t.name] = t.desc || '';
        return acc;
      }, {} as Record<string, string>);
      const exposedToolDescHashes = toolsArr.reduce((acc, t) => {
        acc[t.name] = t.descHash || 'unknown';
        return acc;
      }, {} as Record<string, string>);
      const calls: Record<string, number> = {};
      let serverCalls = 0;
      let serverErrors = 0;
      for (const r of byMcp) {
        const rname = String(r?.name || '');
        const slash = rname.indexOf('/');
        if (slash < 0) continue;
        const sName = rname.slice(0, slash);
        const tName = rname.slice(slash + 1);
        if (sName !== name) continue;
        calls[tName] = r.calls;
        serverCalls += r.calls;
        serverErrors += r.errors;
      }
      const unused = exposedTools.filter((t) => !calls[t]);
      out.push({
        name,
        running,
        ok: !!conn?.ok,
        tools: exposedTools.length,
        calls: serverCalls,
        errors: serverErrors,
        unusedTools: unused,
        perTool: calls,
        toolDescs: exposedToolDescs,
        toolDescHashes: exposedToolDescHashes,
      });
    }
    out.sort((a, b) => b.calls - a.calls);
    return out;
  });

  // Meta tool/skill cross-reference. We can flag tools/skills the user has
  // mounted but the model has never invoked.
  const metaTools = _section('metaTools', [] as any[], () => {
    return meta.listTools().map((t) => {
      const row = byTool.find((r) => r.name === `meta:${t.name}`);
      return {
        name: t.name,
        runtime: t.runtime,
        description: t.description,
        mounted: t.mounted,
        calls: row?.calls || 0,
        errors: row?.errors || 0,
        p95Ms: row?.p95DurationMs || 0,
        lastCallAt: row?.lastCallAt || 0,
      };
    });
  });
  const metaSkills = _section('metaSkills', [] as any[], () => {
    // Skills go through meta_invoke_skill (an MCP tool on meta-bridge), so
    // their telemetry shows up under byMcp rather than bySkill. We surface a
    // synthetic per-skill row counted from byMcp matches.
    const skillInvokeRow = byMcp.find((r) => r.name === 'meta-bridge/meta_invoke_skill');
    const ringCalls = skillInvokeRow?.calls || 0;
    return meta.listSkills().map((s) => ({
      name: s.name,
      description: s.description,
      mounted: s.mounted,
      // Aggregate count is across all skills — without sniffing args we
      // can't separate per-skill. We still surface mounted + description so
      // the FE can show "ever invoked at all" in totals.
      ringCallsAcrossAllSkills: ringCalls,
    }));
  });

  const mcpHealth = _section('mcpHealth', { servers: [], configured: 0, running: 0, errored: 0, totalTools: 0 }, () => buildMcpDebug());
  const recent = _section('recent', [] as any[], () => telemetry.recentEvents(200));

  return {
    bySurface: agg.bySurface,
    lifetime,
    windowMs: agg.windowMs,
    totalEvents: agg.totalEvents,
    ringSize: agg.ringSize,
    ringCap: agg.ringCap,
    enabled: agg.enabled,
    byTool,
    bySkill,
    byMcp,
    byRoute,
    byMemory,
    byWorkflow,
    mcpServers,
    mcpHealth,
    metaTools,
    metaSkills,
    recent,
    _sectionErrors: Object.keys(_sectionErrors).length ? _sectionErrors : undefined,
  };
}

function buildMonitoringDebug(sessionId) {
  const os = require('os');
  const { getGlobalStreamMetrics, getHistoricalStreams } = require('../../sessions-internal/streams');
  const memUsage = process.memoryUsage();
  const cpuPercent = _sampleCpuPercent();
  let _lastExitInfo: Record<string, unknown> | null = null;
  try { _lastExitInfo = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'last-exit.json'), 'utf8')); } catch (_) {}
  const streams: any[] = [];
  for (const [sid, s] of activeStreams) {
    streams.push({
      id: sid,
      isCurrent: sid === sessionId,
      status: s.status,
      chunks: s.chunks?.length || 0,
      chunksTotal: s._chunkCount || 0,
      listeners: s.listeners?.size || 0,
      bytesOut: s._bytesOut || 0,
      textLength: (s.text || '').length,
      ageMs: s._startedAt ? Date.now() - s._startedAt : null,
      doneAgeMs: s.doneAt ? Date.now() - s.doneAt : null,
      model: s.model || null,
      provider: s.provider || null,
      cost: s.cost || 0,
      inputTokens: s.inputTokens || 0,
      outputTokens: s.outputTokens || 0,
      idleGapsMs: s._idleGapsMs ? s._idleGapsMs.slice() : [],
      reconnectsHere: s._reconnectsHere || 0,
      silentClose: !!s._silentClose,
      listenerHistory: s._listenerHistory ? s._listenerHistory.slice(-10) : [],
      chunkRateBuckets: s._chunkRateBuckets ? s._chunkRateBuckets.slice() : [],
    });
  }
  // Merge go-core active streams (Phase 7+): bridge's local map is empty for
  // those turns so we pull from the 1-second-TTL cache of /internal/active-streams.
  // _goStreamDetail enriches each entry with chunk/listener counts pulled
  // from go-core's /v1/sessions/:id/status — same Buffer state the FE reattach
  // path reads from, so the numbers match what the user actually sees.
  const bridgeSids = new Set(streams.map((s) => s.id));
  for (const gSid of _goStreamIds) {
    if (bridgeSids.has(gSid)) continue;
    const d = _goStreamDetail.get(gSid);
    streams.push({
      id: gSid,
      isCurrent: gSid === sessionId,
      status: 'streaming',
      source: 'go-core',
      chunks: d?.chunksTotal ?? null,
      chunksTotal: d?.chunksTotal ?? null,
      listeners: d?.listeners ?? null,
      bytesOut: null,
      textLength: null,
      ageMs: d?.startedAt ? Date.now() - d.startedAt : null,
      doneAgeMs: null,
      model: null,
      provider: null,
      cost: 0,
      inputTokens: 0,
      outputTokens: 0,
      idleGapsMs: [],
      reconnectsHere: 0,
      silentClose: false,
      listenerHistory: [],
      chunkRateBuckets: [],
    });
  }
  // Sort: streaming first, then by age desc
  streams.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'streaming' ? -1 : 1;
    return (b.ageMs || 0) - (a.ageMs || 0);
  });
  const procs: any[] = [];
  for (const sid of activeProcesses.keys()) {
    procs.push({ id: sid, isCurrent: sid === sessionId });
  }
  const totalBytesOut = streams.reduce((acc, x) => acc + (x.bytesOut || 0), 0);
  const totalChunks = streams.reduce((acc, x) => acc + (x.chunks || 0), 0);
  const streamingNow = streams.filter((s) => s.status === 'streaming').length;
  const global = getGlobalStreamMetrics();
  // Bridge-tracked historical streams + go-core archived streams. Post-Phase 7
  // the bridge's _historicalStreams is empty (chat owned by go-core) so the
  // History tab was always blank. _goHistorical is populated as go-core
  // streams disappear from /internal/active-streams.
  const bridgeHistorical = getHistoricalStreams();
  const historical = bridgeHistorical.concat(_goHistorical.slice()).sort((a, b) => {
    const aTs = a.doneAt || a.startedAt || 0;
    const bTs = b.doneAt || b.startedAt || 0;
    return bTs - aTs;
  });
  return {
    sessionId,
    backend: {
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      nodeVersion: process.version,
      platform: process.platform,
      arch: process.arch,
      memRssMb: Math.round(memUsage.rss / 1024 / 1024),
      memHeapUsedMb: Math.round(memUsage.heapUsed / 1024 / 1024),
      memHeapTotalMb: Math.round(memUsage.heapTotal / 1024 / 1024),
      memExternalMb: Math.round(memUsage.external / 1024 / 1024),
      cpuPercent,
      loadAvg1: os.loadavg()[0],
      loadAvg5: os.loadavg()[1],
      loadAvg15: os.loadavg()[2],
      cpuCount: os.cpus()?.length || 0,
      startedAt: _lastExitInfo?.event === 'startup' ? (_lastExitInfo.startedAt as string | null) ?? null : null,
      prevExitSignal: _lastExitInfo?.event === 'startup' && _lastExitInfo.prevExit
        ? ((_lastExitInfo.prevExit as any)?.signal ?? null) : null,
      prevExitVia: _lastExitInfo?.event === 'startup' && _lastExitInfo.prevExit
        ? ((_lastExitInfo.prevExit as any)?.via ?? null) : null,
      prevExitError: _lastExitInfo?.event === 'startup' && _lastExitInfo.prevExit
        ? ((_lastExitInfo.prevExit as any)?.error ?? null) : null,
    },
    streams,
    processes: procs,
    historicalStreams: historical,
    resourceSamples: _resourceSamples.slice(),
    systemSamples: _systemSamples.slice(),
    totals: {
      activeStreams: streams.length,
      activeProcesses: procs.length,
      streamingNow,
      totalBytesOutLive: totalBytesOut,
      totalChunksLive: totalChunks,
      globalBytesBroadcast: global.totalBytesBroadcast,
      globalChunksBroadcast: global.totalChunksBroadcast,
      globalListenerCalls: global.totalListenerCalls,
      silentDisconnects: global.silentDisconnects || 0,
      reconnectsObserved: global.reconnectsObserved || 0,
      gcEvictions: global.gcEvictions || 0,
      peakActiveStreams: global.peakActiveStreams || 0,
      peakListenersPerStream: global.peakListenersPerStream || 0,
      historicalCount: historical.length,
      sinceMs: Date.now() - global.startedAt,
    },
  };
}

// ── modeltracker (provider model lifecycle log) ───────────────────────────────
// Surfaces the NDJSON event log written by bridge/modules/model-tracker/.
// Lets the user see when models appeared, disappeared, or were re-categorised
// without grep'ing the daily files. The builder is pure read; the events
// themselves are emitted from the fetchers in bridge/models/fetch.ts.

function buildModelTrackerDebug(_sessionId) {
  let tracker: any;
  try {
    tracker = require('../model-tracker/tracker');
  } catch (e) {
    return { providers: [], events: [], snapshot: { providers: {} }, error: e instanceof Error ? e.message : String(e) };
  }
  const summary = tracker.summary();
  const events = tracker.recentEvents(300);
  const snapshot = tracker.snapshot();
  // Per-provider category breakdown for the snapshot tab.
  const byProvider: Array<{ provider: string; categories: Record<string, number>; models: Array<{ id: string; categoryAuto: string; firstSeen: number; lastSeen: number }> }> = [];
  for (const [provider, data] of Object.entries(snapshot.providers || {})) {
    const models = Object.entries((data as any).models || {}).map(([id, m]: any) => ({
      id,
      categoryAuto: m.categoryAuto,
      firstSeen: m.firstSeen,
      lastSeen: m.lastSeen,
    }));
    const categories: Record<string, number> = {};
    for (const m of models) {
      categories[m.categoryAuto] = (categories[m.categoryAuto] || 0) + 1;
    }
    models.sort((a, b) => a.id.localeCompare(b.id));
    byProvider.push({ provider, categories, models });
  }
  byProvider.sort((a, b) => a.provider.localeCompare(b.provider));
  return {
    summary,
    events,
    byProvider,
    totals: {
      providers: byProvider.length,
      models: byProvider.reduce((n, p) => n + p.models.length, 0),
      events24h: summary.reduce((n: number, s: any) => n + (s.recentEvents24h || 0), 0),
    },
  };
}

// ── rawlog (api-inout-log debug view) ─────────────────────────────────────────
// Structured view of the current raw API call/response log (bridge/api-inout-log/session-*.log).
// Written by observability/raw-logs.ts on every model in/out, tool call, proxy hop, etc.
// The #debug rawlog entry + tab renders blocks with kind/phase/meta/payload so you can
// inspect exact prompts, tool I/O, and wire payloads without leaving the app or tailing files.

function parseRawLogContent(text: string): any[] {
  if (!text || typeof text !== 'string') return [];
  // Split on block separators. Payloads are JSON (pretty) or text and shouldn't
  // contain a standalone '---' line at column 0 in practice.
  const blocks = text.split(/^\s*---\s*$/m);
  const out: any[] = [];
  for (const block of blocks) {
    if (!block || !block.trim()) continue;
    const lines = block.split(/\r?\n/);
    let ts = '';
    let kind = '';
    let phase = '';
    let metaRaw = '';
    let payloadIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const m = /^([a-zA-Z0-9_-]+):\s*(.*)$/.exec(ln);
      if (m) {
        const k = m[1].toLowerCase();
        const v = m[2] || '';
        if (k === 'ts') ts = v.trim();
        else if (k === 'kind') kind = v.trim();
        else if (k === 'phase') phase = v.trim();
        else if (k === 'meta') metaRaw = v;
        else if (k === 'payload') {
          payloadIdx = i + 1;
          break;
        }
      }
    }
    let payloadText = '';
    if (payloadIdx >= 0) {
      payloadText = lines.slice(payloadIdx).join('\n').trim();
    }
    let meta: any = null;
    if (metaRaw) {
      try { meta = JSON.parse(metaRaw); } catch { meta = metaRaw; }
    }
    let payloadJson: any = null;
    const t = payloadText.trim();
    if (t && (t[0] === '{' || t[0] === '[')) {
      try { payloadJson = JSON.parse(t); } catch {}
    }
    if (kind || phase) {
      out.push({ ts, kind, phase, meta, payload: payloadText, payloadJson });
    }
  }
  return out;
}

function buildRawlogDebug(_sessionId) {
  const enabled = !!(rawLogs.isLoggingEnabled && rawLogs.isLoggingEnabled());
  let currentFile: string | null = null;
  let fullPath: string | null = null;
  let rawTail = '';
  let entries: any[] = [];
  try {
    fullPath = rawLogs.SESSION_FILE_PATH || null;
    currentFile = fullPath ? path.basename(fullPath) : null;
    if (fullPath && fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, 'utf8');
      rawTail = content.split(/\r?\n/).slice(-300).join('\n');
      const all = parseRawLogContent(content);
      entries = all.slice(-60).reverse(); // newest first, cap for UI
    }
  } catch (e) {
    // surface gracefully
  }
  return {
    enabled,
    currentFile,
    fullPath,
    entryCount: entries.length,
    totalParsed: /* recompute cheap */ (fullPath && fs.existsSync(fullPath) ? parseRawLogContent(fs.readFileSync(fullPath,'utf8')).length : 0),
    entries,
    rawTail,
    note: enabled ? null : 'API logging disabled. Toggle in Settings → System (advanced).',
  };
}

// ── overview (cards grid + drift indicators) ──────────────────────────────────
// Each card runs the cheap parts of one builder and emits a status (ok/warn/fail)
// plus a one-line preview. Frontend renders them as a clickable grid; clicking
// opens that subcommand's detailed view. Drift indicators surface invariants
// being violated (e.g. display > 0 but processed = 0 — the bug we just fixed).

function buildOverviewDebug(sessionId) {
  const cards: any[] = [];
  // Per-card safety net. Without this any single sub-builder throwing
  // (e.g. an undefined field on a fresh-boot stat snapshot) wedges the
  // whole #debug modal with no surfaced cause. Surface the failed card
  // as drift=fail with the error message so the user can still see the
  // rest of the overview.
  const safe = (label: string, type: string, fn: () => void) => {
    try { fn(); }
    catch (e) {
      const stack = e instanceof Error ? (e.stack || e.message || String(e)) : String(e);
      console.error(`[debug.overview] card "${label}" (type="${type}") failed:`, stack);
      cards.push({
        type, label,
        preview: '(error)',
        drift: 'fail',
        hint: `card builder failed: ${e instanceof Error ? (e.message || e.name || 'unknown error') : String(e)}`,
      });
    }
  };
  // chathistory drift
  safe('Chat Session History', 'chathistory', () => {
    const ch = buildChathistoryDebug(sessionId);
    cards.push({
      type: 'chathistory',
      label: 'Chat Session History',
      preview: `${ch.stats.displayCount} display • ${ch.stats.processedCount} processed`,
      drift:
        ch.stats.displayCount > 0 && ch.stats.processedCount === 0 ? 'fail' :
        ch.stats.displayCount > 4 && ch.stats.processedCount < 2 ? 'warn' : 'ok',
      hint:
        ch.stats.displayCount > 0 && ch.stats.processedCount === 0
          ? 'Display has messages but the model sees zero. Provider write-side likely missing pushHistory.'
          : null,
    });
  });

  // routing — flag SDK-vs-binary mismatches and instance/binary path issues
  safe('Routing', 'routing', () => {
    const rt = buildRoutingDebug(sessionId);
    const subLabel = rt.route.subscription?.instance?.label
      ? ` (${rt.route.subscription.instance.label})`
      : '';
    cards.push({
      type: 'routing',
      label: 'Routing',
      preview: `${rt.modelId} → ${rt.route.type}${subLabel} • ${rt.bin.basename || '-'}`,
      drift: !rt.bin.full ? 'fail' : rt.route.type === 'claude' && rt.claudeRuntime === 'sdk' ? 'ok' : 'ok',
      hint: !rt.bin.full ? 'No binary resolved for this route.' : null,
    });
  });

  // costs — current spend snapshot
  safe('Costs', 'costs', () => {
    const costs = buildCostsDebug(sessionId);
    cards.push({
      type: 'costs',
      label: 'Costs',
      preview: `today $${costs.todayTotal.toFixed(4)} • all-time $${costs.allTimeTotal.toFixed(2)}`,
      drift: 'ok',
      hint: null,
    });
  });

  // tokens — daily token-mix breakdown
  safe('Tokens', 'tokens', () => {
    const tokens = buildTokensDebug(sessionId);
    const lastDay = tokens.days[tokens.days.length - 1];
    const lastTotals = tokens.dailyTotals?.[lastDay];
    const totalToday = lastTotals
      ? (lastTotals.input + lastTotals.cacheWrite + lastTotals.cacheRead + lastTotals.output)
      : 0;
    const cacheReadShare = lastTotals && totalToday > 0
      ? Math.round((lastTotals.cacheRead / totalToday) * 100)
      : 0;
    const keyCount = Object.keys(tokens.byKey || {}).length;
    cards.push({
      type: 'tokens',
      label: 'Tokens',
      preview: `today ${totalToday.toLocaleString()} tok • ${cacheReadShare}% cache-read • ${keyCount} model${keyCount === 1 ? '' : 's'}`,
      drift: 'ok',
      hint: null,
    });
  });

  // mcp — configured vs running drift
  safe('MCP Servers', 'toolsmon', () => {
    const mcp = buildMcpDebug();
    const mcpOrphans = (mcp.servers || []).filter((s) => !s.configured && s.running).length;
    const mcpMissing = (mcp.servers || []).filter((s) => s.configured && !s.running).length;
    cards.push({
      type: 'toolsmon',
      label: 'MCP Servers',
      preview: `${mcp.running}/${mcp.configured} running • ${mcp.totalTools} tools • ${mcp.errored} errored`,
      drift: mcp.errored > 0 || mcpOrphans > 0 ? 'fail' : mcpMissing > 0 ? 'warn' : 'ok',
      hint:
        mcp.errored > 0
          ? `${mcp.errored} MCP server(s) have errors.`
          : mcpOrphans > 0
          ? `${mcpOrphans} orphan MCP server(s) running but not in registry.`
          : mcpMissing > 0
          ? `${mcpMissing} configured MCP server(s) not running.`
          : null,
    });
  });

  // toolsmon — tool/skill/MCP/route usage telemetry. Surfaces the new
  // monitoring panel as a card on the overview grid so a fresh user can
  // discover it from the same place as everything else.
  safe('Tools / Skills / MCP', 'toolsmon', () => {
    const tm = buildToolsMonitoringDebug(sessionId);
    const tmEnabled = !!tm.enabled;
    const bySurface = tm.bySurface || {};
    const totalCalls = (bySurface.tool?.calls || 0) + (bySurface.mcp?.calls || 0) + (bySurface.skill?.calls || 0);
    const memWrites = (tm.byMemory || []).reduce((n, x) => n + (x.writes || 0), 0);
    const memReads = (tm.byMemory || []).reduce((n, x) => n + (x.reads || 0), 0);
    const memRatio = memWrites > 0 ? memReads / memWrites : null;
    const tmDrift =
      !tmEnabled ? 'warn' :
      memRatio !== null && memRatio < 0.25 && memWrites > 5 ? 'warn' :
      'ok';
    cards.push({
      type: 'toolsmon',
      label: 'Tools / Skills / MCP',
      preview: `${totalCalls} calls (24h) • mcp ${bySurface.mcp?.calls || 0} • tool ${bySurface.tool?.calls || 0} • mem R/W ${memRatio === null ? '—' : memRatio.toFixed(2)}`,
      drift: tmDrift,
      hint:
        !tmEnabled
          ? 'Telemetry disabled — turn it back on to capture tool/skill/MCP usage.'
          : memRatio !== null && memRatio < 0.25 && memWrites > 5
            ? `Low read-after-write ratio (${memRatio.toFixed(2)}) — memory is being written but rarely read. Possible write-only memory.`
            : null,
    });
  });

  // modeltracker — provider /models lifecycle log (first/last seen, category drift)
  safe('Model Tracker', 'modeltracker', () => {
    const mt = buildModelTrackerDebug(sessionId);
    if (mt.error) {
      cards.push({
        type: 'modeltracker',
        label: 'Model Tracker',
        preview: '(unavailable)',
        drift: 'fail',
        hint: `tracker module not loadable: ${mt.error}`,
      });
      return;
    }
    const summary = (mt.summary || []) as Array<{ lastFetch: number; recentEvents24h: number }>;
    const totals = mt.totals || { providers: 0, models: 0, events24h: 0 };
    const newestFetch = summary.reduce((n, s) => Math.max(n, s.lastFetch || 0), 0);
    const ageMs = newestFetch ? Date.now() - newestFetch : Infinity;
    // No providers fetched yet → warn (likely no provider keys configured, or
    // fetchers haven't run since restart). Stale last-fetch (>7d) also warn.
    const mtDrift =
      summary.length === 0 ? 'warn' :
      ageMs > 7 * 86_400_000 ? 'warn' :
      'ok';
    cards.push({
      type: 'modeltracker',
      label: 'Model Tracker',
      preview: `${totals.providers} provider${totals.providers === 1 ? '' : 's'} • ${totals.models} model${totals.models === 1 ? '' : 's'} • ${totals.events24h} event${totals.events24h === 1 ? '' : 's'} (24h)`,
      drift: mtDrift,
      hint:
        summary.length === 0
          ? 'No provider /models fetches recorded yet — tracker fills in once a fetcher runs.'
          : ageMs > 7 * 86_400_000
            ? 'Newest provider fetch is >7 days old — fetchers may have stopped.'
            : null,
    });
  });

  // monitoring — heap pressure, zombies, silent disconnects
  safe('Monitoring', 'monitoring', () => {
    const mon = buildMonitoringDebug(sessionId);
    const heapPct = mon.backend.memHeapTotalMb > 0
      ? Math.round((mon.backend.memHeapUsedMb / mon.backend.memHeapTotalMb) * 100)
      : 0;
    const zombies = (mon.streams || []).filter((s) => s.status === 'streaming' && s.ageMs && s.ageMs > 30 * 60_000).length;
    const silent = mon.totals?.silentDisconnects || 0;
    const monDrift = zombies > 0 || heapPct > 95 ? 'fail' : heapPct > 85 || silent > 0 ? 'warn' : 'ok';
    const monHint = zombies > 0
      ? `${zombies} stream(s) "streaming" >30 min — likely zombies.`
      : heapPct > 95
      ? `Heap at ${heapPct}% — GC pressure.`
      : silent > 0
      ? `${silent} silent disconnect(s) since restart.`
      : null;
    cards.push({
      type: 'monitoring',
      label: 'Monitoring',
      preview: `cpu ${mon.backend.cpuPercent}% • heap ${mon.backend.memHeapUsedMb}/${mon.backend.memHeapTotalMb} MB • ${mon.totals?.streamingNow || 0}/${mon.totals?.activeStreams || 0} streams • ${mon.totals?.silentDisconnects || 0} silent`,
      drift: monDrift,
      hint: monHint,
    });
  });

  // rawlog — the api-inout debug capture (prompts, responses, tool I/O). New users
  // discover the trace viewer from overview the same way they find monitoring.
  safe('API In/Out Log', 'rawlog', () => {
    const rl = buildRawlogDebug(sessionId);
    const n = rl.entryCount || 0;
    const drift = rl.enabled ? (n > 0 ? 'ok' : 'warn') : 'warn';
    cards.push({
      type: 'rawlog',
      label: 'API In/Out Log',
      preview: `${n} entries${rl.currentFile ? ` • ${rl.currentFile}` : ''}${rl.enabled ? '' : ' (disabled)'}`,
      drift,
      hint: !rl.enabled
        ? 'Logging disabled — enable in Settings → System (advanced) to capture traces for this view.'
        : (n === 0 ? 'No entries yet — first model turn (or tool/proxy) will populate.' : null),
    });
  });

  return { sessionId, cards };
}

// ── registry + dispatcher ─────────────────────────────────────────────────────

const REGISTRY = {
  chathistory: {
    label: 'Chat Session History',
    build: buildChathistoryDebug,
    summary: (d) =>
      `${d.stats.displayCount} display → ${d.stats.processedCount} processed (mode: ${d.config.mode}, max_turns: ${d.config.maxTurns})`,
  },
  routing: {
    label: 'Routing',
    build: buildRoutingDebug,
    summary: (d) =>
      `${d.modelId} → ${d.route.type}${d.route.subscription ? ` (${d.route.subscription.instance.label})` : ''} • ${d.bin.basename || '-'} • ${d.actualPath}`,
  },
  mcp: {
    label: 'MCP Servers',
    build: () => buildMcpDebug(),
    summary: (d) => `${d.running}/${d.configured} running, ${d.errored} errored, ${d.totalTools} tools`,
  },
  costs: {
    label: 'Costs',
    build: buildCostsDebug,
    summary: (d) =>
      `today $${d.todayTotal.toFixed(4)} • all-time $${d.allTimeTotal.toFixed(2)} • top: ${d.allTimeByModel[0]?.key || '-'}`,
  },
  tokens: {
    label: 'Tokens',
    build: buildTokensDebug,
    summary: (d) => {
      const dayCount = d.days.length;
      const lastDay = d.days[d.days.length - 1];
      const lastTotals = d.dailyTotals[lastDay];
      const totalLast = lastTotals
        ? (lastTotals.input + lastTotals.cacheWrite + lastTotals.cacheRead + lastTotals.output)
        : 0;
      const calls = lastTotals?.calls || 0;
      const keyCount = Object.keys(d.byKey).length;
      return `${dayCount}d window • ${keyCount} model${keyCount === 1 ? '' : 's'} • today ${totalLast.toLocaleString()} tok / ${calls} calls`;
    },
  },
  overview: {
    label: 'Overview',
    build: buildOverviewDebug,
    summary: (d) => {
      const fails = d.cards.filter((c) => c.drift === 'fail').length;
      const warns = d.cards.filter((c) => c.drift === 'warn').length;
      return `${d.cards.length} cards • ${fails} fail • ${warns} warn`;
    },
  },
  monitoring: {
    label: 'Monitoring',
    build: buildMonitoringDebug,
    summary: (d) =>
      `cpu ${d.backend.cpuPercent}% • heap ${d.backend.memHeapUsedMb}/${d.backend.memHeapTotalMb}MB • ${d.totals.streamingNow}/${d.totals.activeStreams} streams • ${d.totals.silentDisconnects} silent • ${d.totals.reconnectsObserved} reconnects • ${d.totals.historicalCount} archived`,
  },
  rawlog: {
    label: 'API In/Out Log',
    build: buildRawlogDebug,
    summary: (d) =>
      `${d.entryCount || 0} entries${d.currentFile ? ` (${d.currentFile})` : ''}${d.enabled ? '' : ' [disabled]'}`,
  },
  toolsmon: {
    label: 'Tools, Skills & MCP',
    build: buildToolsMonitoringDebug,
    summary: (d) => {
      const t = d.bySurface.tool || {};
      const m = d.bySurface.mcp || {};
      const r = d.bySurface.route || {};
      const me = d.bySurface.memory || {};
      const memWrites = (d.byMemory || []).reduce((n, x) => n + (x.writes || 0), 0);
      const memReads = (d.byMemory || []).reduce((n, x) => n + (x.reads || 0), 0);
      const ratio = memWrites > 0 ? (memReads / memWrites).toFixed(2) : '—';
      return `tools ${t.calls || 0} • mcp ${m.calls || 0} • routes ${r.calls || 0} • memory ${me.calls || 0} (R/W ratio ${ratio})`;
    },
  },
  modeltracker: {
    label: 'Model Tracker',
    build: buildModelTrackerDebug,
    summary: (d) =>
      `${d.totals?.providers || 0} providers • ${d.totals?.models || 0} models • ${d.totals?.events24h || 0} events (24h)`,
  },
};

const SUBCOMMAND_LIST = Object.keys(REGISTRY);

function runDebugCommand(sessionId, subcmd, _args = []) {
  const sub = subcmd ? String(subcmd).toLowerCase() : 'overview';
  const entry = REGISTRY[sub];
  if (!entry) {
    const help = `#debug subcommands: ${SUBCOMMAND_LIST.join(', ')}`;
    return { handled: true, silent: true, response: help, chatHistory: [help] };
  }
  let data;
  try {
    data = entry.build(sessionId);
  } catch (e) {
    const err = `[debug] ${sub} failed: ${e instanceof Error ? e.message : String(e)}`;
    return { handled: true, silent: true, response: err, chatHistory: [err] };
  }
  const summary = `[debug] ${sub}: ${entry.summary(data)}`;
  return {
    handled: true,
    silent: true,
    response: summary,
    chatHistory: [summary],
    debugModal: sub,
    debugData: data,
  };
}

module.exports = {
  runDebugCommand,
  SUBCOMMAND_LIST,
  DEBUG_REGISTRY: REGISTRY,
  buildChathistoryDebug,
  buildRoutingDebug,
  buildMcpDebug,
  buildCostsDebug,
  buildTokensDebug,
  buildOverviewDebug,
  buildToolsMonitoringDebug,
  buildModelTrackerDebug,
  buildRawlogDebug,
  recordFrontendSnapshot,
  MONITORING_LOG_DIR,
};
