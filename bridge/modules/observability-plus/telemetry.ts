// ── Bridge-wide telemetry recorder + aggregator ──────────────────────────────
// Single appender for *every* surface that the LLM (or user) can hit:
//   - mcp     — MCP tool calls (callMcpTool)
//   - tool    — bridge tools (Read/Write/Bash/Task/TodoWrite/etc. via executeBridgeTool)
//   - skill   — meta skills (renderSkillInline / meta_invoke_skill)
//   - route   — HTTP routes (express middleware)
//   - memory  — explicit semantic events for the "memory MCPs" we care about
//               (knowledge-memory, important, todos). Tagged read|write|delete.
//
// Each surface call emits one NDJSON record:
//   bridge/telemetry/<YYYY-MM-DD>.ndjson
//   {ts, surface, name, sessionId?, durationMs, ok, args_size?, result_size?, meta?}
//
// Goals (per the user's design ask):
//   1. Zero-cost when disabled (single boolean check).
//   2. Best-effort writes — telemetry MUST NOT break tool execution.
//   3. Cheap enough to leave on (ndjson append + bounded ring for aggregator).
//   4. Programmatic feedback loop: aggregator answers
//        - per-tool call frequency
//        - read-after-write ratio per memory tool
//        - p50/p95 latency
//        - error rate
//      so we can A/B tool descriptions and remove dead surfaces.
//
// Storage: disk for raw events (rotated daily, 14-day retention), in-memory
// rolling ring (last RING_CAP events) for the live debug panel.
'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../../core/logger');

// User-state dir kept at bridge/telemetry/ across the modular migration.
// __dirname is bridge/modules/observability-plus; two `..` reach bridge/.
const TELEMETRY_DIR = path.join(__dirname, '..', '..', 'telemetry');
const RING_CAP = 5000; // last 5k events held in memory for fast aggregation
const RETENTION_DAYS = 14; // disk files older than this are pruned daily

type Surface = 'mcp' | 'tool' | 'skill' | 'route' | 'memory' | 'workflow';

type TelemetryEvent = {
  ts: number; // epoch ms
  surface: Surface;
  name: string; // tool/skill/route name; for mcp it's "<server>/<tool>"
  sessionId?: string;
  durationMs: number;
  ok: boolean;
  argsSize?: number;
  resultSize?: number;
  // Surface-specific. Kept small; large blobs are dropped.
  meta?: Record<string, unknown>;
};

let _enabled = true;
const _ring: TelemetryEvent[] = [];
// Lifetime counters. Cheap, never reset, used by Overview cards in the
// monitoring modal. The ring may have evicted old events but these stay.
const _counts: Record<Surface, { calls: number; ok: number; errors: number }> = {
  mcp: { calls: 0, ok: 0, errors: 0 },
  tool: { calls: 0, ok: 0, errors: 0 },
  skill: { calls: 0, ok: 0, errors: 0 },
  route: { calls: 0, ok: 0, errors: 0 },
  memory: { calls: 0, ok: 0, errors: 0 },
  workflow: { calls: 0, ok: 0, errors: 0 },
};

function setEnabled(v: boolean): void {
  _enabled = !!v;
}

function isEnabled(): boolean {
  return _enabled;
}

function _ensureDir(): void {
  try { fs.mkdirSync(TELEMETRY_DIR, { recursive: true }); } catch (_) {}
}

function _logPath(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return path.join(TELEMETRY_DIR, `${y}-${m}-${d}.ndjson`);
}

function _approxSize(v: unknown): number {
  if (v == null) return 0;
  if (typeof v === 'string') return v.length;
  try {
    return JSON.stringify(v).length;
  } catch (_) {
    return 0;
  }
}

function _pruneOldFiles(): void {
  try {
    if (!fs.existsSync(TELEMETRY_DIR)) return;
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(TELEMETRY_DIR)) {
      if (!name.endsWith('.ndjson')) continue;
      const full = path.join(TELEMETRY_DIR, name);
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs < cutoff) fs.unlinkSync(full);
      } catch (_) {}
    }
  } catch (_) {}
}

// Cached append-mode WriteStream, re-opened when the UTC date rolls over (the
// log file is daily). One stream for the file's lifetime means per-request and
// per-tool-call writes no longer pay an open/close cycle and — the point of
// this — `fs.appendFileSync` no longer blocks the event loop on every HTTP
// response and tool/MCP call. Node buffers + flushes the write off the main
// thread. The in-memory `_ring` (what the live monitoring panel reads) is
// still updated synchronously below, so the panel is unaffected.
let _stream: any = null;
let _streamPath = '';

function _appender(): any {
  const p = _logPath();
  if (_stream && _streamPath === p) return _stream;
  // First open, or the date rolled to a new day → rotate to the new file.
  if (_stream) {
    try { _stream.end(); } catch (_) {}
    _stream = null;
  }
  try {
    _ensureDir();
    const s = fs.createWriteStream(p, { flags: 'a', encoding: 'utf8' });
    s.on('error', (e: unknown) => {
      logger.warn('telemetry.stream-error', { error: e instanceof Error ? e.message : String(e) });
      // Drop the broken stream so the next record() reopens it.
      if (_stream === s) { _stream = null; _streamPath = ''; }
    });
    _stream = s;
    _streamPath = p;
  } catch (e) {
    logger.warn('telemetry.stream-open-failed', { error: e instanceof Error ? e.message : String(e) });
    _stream = null;
    _streamPath = '';
  }
  return _stream;
}

// Record a single event. Always best-effort — failing telemetry must never
// surface as a tool/route error. Large args/results have their `size` recorded
// but their values are not persisted, to keep the file small + private.
function record(ev: Omit<TelemetryEvent, 'ts'>): void {
  if (!_enabled) return;
  const full: TelemetryEvent = { ts: Date.now(), ...ev };
  _ring.push(full);
  if (_ring.length > RING_CAP) _ring.shift();
  const c = _counts[full.surface];
  if (c) {
    c.calls += 1;
    if (full.ok) c.ok += 1;
    else c.errors += 1;
  }
  try {
    const s = _appender();
    if (s) s.write(JSON.stringify(full) + '\n');
  } catch (e) {
    logger.warn('telemetry.append-failed', { error: e instanceof Error ? e.message : String(e) });
  }
}

// Wrap an async fn so its outcome (ok/error + duration + sizes) is recorded.
// Returns the original result; rethrows on error.
async function track<T>(
  surface: Surface,
  name: string,
  fn: () => Promise<T> | T,
  opts: { sessionId?: string; argsSize?: number; meta?: Record<string, unknown> } = {}
): Promise<T> {
  const t0 = Date.now();
  try {
    const out = await fn();
    record({
      surface,
      name,
      sessionId: opts.sessionId,
      durationMs: Date.now() - t0,
      ok: true,
      argsSize: opts.argsSize,
      resultSize: _approxSize(out),
      meta: opts.meta,
    });
    return out;
  } catch (e) {
    record({
      surface,
      name,
      sessionId: opts.sessionId,
      durationMs: Date.now() - t0,
      ok: false,
      argsSize: opts.argsSize,
      meta: { ...(opts.meta || {}), error: e instanceof Error ? e.message : String(e) },
    });
    throw e;
  }
}

// ── Aggregator ────────────────────────────────────────────────────────────
// Builds per-name summaries from the in-memory ring. The frontend modal calls
// this directly via /v1/debug/monitoring-tools.
//
// Read-after-write ratio: for memory surfaces, we compute reads / writes. If
// a synthesis page is written but never read in the window, ratio < 1 — that
// page is wasted cost. Target >= 0.5 (article's claim).

type AggRow = {
  surface: Surface;
  name: string;
  calls: number;
  ok: number;
  errors: number;
  errorRate: number; // 0..1
  totalArgsSize: number;
  totalResultSize: number;
  p50DurationMs: number;
  p95DurationMs: number;
  maxDurationMs: number;
  lastCallAt: number;
  firstCallAt: number;
  // memory-specific (only set when surface === 'memory')
  reads?: number;
  writes?: number;
  deletes?: number;
  readWriteRatio?: number | null; // reads / max(1, writes); null if no writes
};

function _percentile(sorted: number[], pct: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((pct / 100) * sorted.length)));
  return sorted[idx];
}

function aggregate(opts: { windowMs?: number; surface?: Surface | null } = {}): {
  windowMs: number;
  totalEvents: number;
  rows: AggRow[];
  bySurface: Record<Surface, { calls: number; ok: number; errors: number; errorRate: number }>;
  ringSize: number;
  ringCap: number;
  enabled: boolean;
} {
  const windowMs = opts.windowMs ?? 24 * 60 * 60 * 1000; // default: last 24h in ring
  const cutoff = Date.now() - windowMs;
  const filterSurface = opts.surface ?? null;
  const events = _ring.filter((e) => e.ts >= cutoff && (!filterSurface || e.surface === filterSurface));

  // Group by surface+name
  type Bucket = {
    surface: Surface;
    name: string;
    calls: number;
    ok: number;
    errors: number;
    totalArgsSize: number;
    totalResultSize: number;
    durations: number[];
    lastCallAt: number;
    firstCallAt: number;
    reads: number;
    writes: number;
    deletes: number;
  };
  const buckets = new Map<string, Bucket>();
  for (const e of events) {
    const key = `${e.surface}::${e.name}`;
    let b = buckets.get(key);
    if (!b) {
      b = {
        surface: e.surface,
        name: e.name,
        calls: 0,
        ok: 0,
        errors: 0,
        totalArgsSize: 0,
        totalResultSize: 0,
        durations: [],
        lastCallAt: 0,
        firstCallAt: e.ts,
        reads: 0,
        writes: 0,
        deletes: 0,
      };
      buckets.set(key, b);
    }
    b.calls += 1;
    if (e.ok) b.ok += 1; else b.errors += 1;
    b.totalArgsSize += e.argsSize || 0;
    b.totalResultSize += e.resultSize || 0;
    b.durations.push(e.durationMs);
    if (e.ts > b.lastCallAt) b.lastCallAt = e.ts;
    if (e.ts < b.firstCallAt) b.firstCallAt = e.ts;
    const op = e.meta?.['op'];
    if (op === 'read') b.reads += 1;
    else if (op === 'write') b.writes += 1;
    else if (op === 'delete') b.deletes += 1;
  }
  const rows: AggRow[] = [];
  for (const b of buckets.values()) {
    const sorted = b.durations.slice().sort((a, b) => a - b);
    const row: AggRow = {
      surface: b.surface,
      name: b.name,
      calls: b.calls,
      ok: b.ok,
      errors: b.errors,
      errorRate: b.calls > 0 ? b.errors / b.calls : 0,
      totalArgsSize: b.totalArgsSize,
      totalResultSize: b.totalResultSize,
      p50DurationMs: _percentile(sorted, 50),
      p95DurationMs: _percentile(sorted, 95),
      maxDurationMs: sorted.length ? sorted[sorted.length - 1] : 0,
      lastCallAt: b.lastCallAt,
      firstCallAt: b.firstCallAt,
    };
    if (b.surface === 'memory') {
      row.reads = b.reads;
      row.writes = b.writes;
      row.deletes = b.deletes;
      row.readWriteRatio = b.writes > 0 ? b.reads / b.writes : null;
    }
    rows.push(row);
  }
  rows.sort((a, b) => b.calls - a.calls);

  const bySurface: Record<Surface, { calls: number; ok: number; errors: number; errorRate: number }> = {
    mcp: { calls: 0, ok: 0, errors: 0, errorRate: 0 },
    tool: { calls: 0, ok: 0, errors: 0, errorRate: 0 },
    skill: { calls: 0, ok: 0, errors: 0, errorRate: 0 },
    route: { calls: 0, ok: 0, errors: 0, errorRate: 0 },
    memory: { calls: 0, ok: 0, errors: 0, errorRate: 0 },
    workflow: { calls: 0, ok: 0, errors: 0, errorRate: 0 },
  };
  for (const r of rows) {
    const s = bySurface[r.surface];
    if (!s) continue; // unknown surface (e.g. 'stream-finalize') — skip totaling
    s.calls += r.calls;
    s.ok += r.ok;
    s.errors += r.errors;
  }
  for (const k of Object.keys(bySurface) as Surface[]) {
    const s = bySurface[k];
    s.errorRate = s.calls > 0 ? s.errors / s.calls : 0;
  }

  return {
    windowMs,
    totalEvents: events.length,
    rows,
    bySurface,
    ringSize: _ring.length,
    ringCap: RING_CAP,
    enabled: _enabled,
  };
}

// Recent events tail (newest-first). Used by the debug modal "Live tail" tab.
function recentEvents(limit = 200, surface: Surface | null = null): TelemetryEvent[] {
  const arr = surface ? _ring.filter((e) => e.surface === surface) : _ring;
  return arr.slice(-limit).reverse();
}

// ── Lifetime counters ──────────────────────────────────────────────────────
// Pre-emptied at module load; survive ring evictions.
function lifetimeCounts(): typeof _counts {
  return {
    mcp: { ..._counts.mcp },
    tool: { ..._counts.tool },
    skill: { ..._counts.skill },
    route: { ..._counts.route },
    memory: { ..._counts.memory },
    workflow: { ..._counts.workflow },
  };
}

// ── Daily prune timer (best-effort) ────────────────────────────────────────
let _pruneTimer: any = null;
function startPruneTimer(): void {
  if (_pruneTimer) return;
  _pruneTimer = setInterval(_pruneOldFiles, 24 * 60 * 60_000);
  if (typeof _pruneTimer.unref === 'function') _pruneTimer.unref();
  _pruneOldFiles();
}
startPruneTimer();

module.exports = {
  TELEMETRY_DIR,
  setEnabled,
  isEnabled,
  record,
  track,
  aggregate,
  recentEvents,
  lifetimeCounts,
};
