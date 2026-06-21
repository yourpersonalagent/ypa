// ── Model Tracker — append-only event log + snapshot ─────────────────────────
//
// Tracks the lifecycle of provider models across YHA restarts so a user can
// see (a) when a model first appeared in a provider's /models response,
// (b) when it disappeared (sunset), (c) when its detected category changed,
// (d) when the user manually overrode its category.
//
// Storage layout — mirrors the telemetry pattern at one level up
// (bridge/telemetry/, bridge/monitoring-log/) so ops tooling works the same:
//
//   bridge/model-tracker-events/YYYY-MM-DD.ndjson   — daily event log
//   bridge/model-tracker-events/_snapshot.json      — last-known state per provider
//
// Snapshot is the source of truth for "what was visible the last time we
// fetched?". On the next fetch we diff `currentIds` against
// snapshot[provider].models to emit first_seen / last_seen events. The
// snapshot also remembers the auto-detected category so we can emit
// category_auto_changed if the heuristic re-classifies a model.
//
// Events are best-effort writes — never throw into the fetch path. Failed
// disk appends still update the in-memory ring, so the debug screen stays
// useful even when the disk is read-only.
'use strict';

const fs = require('fs');
const path = require('path');
const logger = require('../../core/logger');

const TRACKER_DIR = path.join(__dirname, '..', '..', 'model-tracker-events');
const SNAPSHOT_PATH = path.join(TRACKER_DIR, '_snapshot.json');
const RING_CAP = 2000;
const RETENTION_DAYS = 90;

type TrackerEventKind =
  | 'first_seen'
  | 'last_seen'
  | 'category_auto_changed'
  | 'override_set'
  | 'override_cleared';

type TrackerEvent = {
  ts: number;
  provider: string;
  model: string;
  event: TrackerEventKind;
  // Optional payload depending on event kind.
  category?: string;
  categoryFrom?: string;
  categoryTo?: string;
  note?: string;
};

type SnapshotModel = {
  firstSeen: number;
  lastSeen: number;
  categoryAuto: string;
};

type Snapshot = {
  providers: Record<string, { lastFetch: number; models: Record<string, SnapshotModel> }>;
};

const _ring: TrackerEvent[] = [];
let _snapshot: Snapshot | null = null;

function _ensureDir(): void {
  try { fs.mkdirSync(TRACKER_DIR, { recursive: true }); } catch (_) {}
}

function _logPath(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return path.join(TRACKER_DIR, `${y}-${m}-${d}.ndjson`);
}

function _loadSnapshot(): Snapshot {
  if (_snapshot) return _snapshot;
  try {
    if (fs.existsSync(SNAPSHOT_PATH)) {
      const raw = fs.readFileSync(SNAPSHOT_PATH, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && parsed.providers) {
        _snapshot = parsed as Snapshot;
        return _snapshot;
      }
    }
  } catch (e) {
    logger.warn('model-tracker.snapshot-read-failed', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
  _snapshot = { providers: {} };
  return _snapshot;
}

function _writeSnapshot(): void {
  if (!_snapshot) return;
  try {
    _ensureDir();
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(_snapshot, null, 2));
  } catch (e) {
    logger.warn('model-tracker.snapshot-write-failed', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

function _append(ev: TrackerEvent): void {
  _ring.push(ev);
  if (_ring.length > RING_CAP) _ring.shift();
  try {
    _ensureDir();
    fs.appendFileSync(_logPath(), JSON.stringify(ev) + '\n');
  } catch (e) {
    logger.warn('model-tracker.append-failed', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// Hydrate the in-memory ring with the last N events from the current and
// previous day, so the #debug screen has a useful tail even right after a
// restart. Capped at RING_CAP.
function _hydrateRing(): void {
  try {
    if (!fs.existsSync(TRACKER_DIR)) return;
    const files = fs
      .readdirSync(TRACKER_DIR)
      .filter((n) => n.endsWith('.ndjson'))
      .sort();
    const recent = files.slice(-2);
    for (const name of recent) {
      try {
        const full = path.join(TRACKER_DIR, name);
        const txt = fs.readFileSync(full, 'utf8');
        for (const line of txt.split('\n')) {
          if (!line.trim()) continue;
          try {
            const ev = JSON.parse(line) as TrackerEvent;
            _ring.push(ev);
            if (_ring.length > RING_CAP) _ring.shift();
          } catch (_) {}
        }
      } catch (_) {}
    }
  } catch (_) {}
}

function _pruneOldFiles(): void {
  try {
    if (!fs.existsSync(TRACKER_DIR)) return;
    const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const name of fs.readdirSync(TRACKER_DIR)) {
      if (!name.endsWith('.ndjson')) continue;
      const full = path.join(TRACKER_DIR, name);
      try {
        const stat = fs.statSync(full);
        if (stat.mtimeMs < cutoff) fs.unlinkSync(full);
      } catch (_) {}
    }
  } catch (_) {}
}

// ── Public surface ────────────────────────────────────────────────────────────

// Called by every provider fetcher after it refreshes its model cache.
// `incoming` is the freshly fetched list (id + auto-detected category).
//
// Diff rules:
//   - id present in incoming, absent in snapshot         → first_seen
//   - id absent in incoming, present in snapshot         → last_seen
//   - id present in both, categoryAuto changed           → category_auto_changed
//
// Snapshot is updated in place and persisted. The diff for a single provider
// is at most O(|models|) and runs once per fetch, so the cost is negligible.
function recordFetch(
  provider: string,
  incoming: Array<{ id: string; categoryAuto: string }>
): { added: number; removed: number; reclassified: number } {
  const snap = _loadSnapshot();
  const prev = snap.providers[provider]?.models || {};
  const now = Date.now();
  const incomingIds = new Set(incoming.map((m) => m.id));

  let added = 0;
  let removed = 0;
  let reclassified = 0;

  // first_seen + category_auto_changed
  for (const m of incoming) {
    const before = prev[m.id];
    if (!before) {
      _append({
        ts: now,
        provider,
        model: m.id,
        event: 'first_seen',
        category: m.categoryAuto,
      });
      added += 1;
    } else if (before.categoryAuto && before.categoryAuto !== m.categoryAuto) {
      _append({
        ts: now,
        provider,
        model: m.id,
        event: 'category_auto_changed',
        categoryFrom: before.categoryAuto,
        categoryTo: m.categoryAuto,
      });
      reclassified += 1;
    }
  }

  // last_seen — anything in snapshot but missing from incoming
  for (const id of Object.keys(prev)) {
    if (!incomingIds.has(id)) {
      _append({
        ts: now,
        provider,
        model: id,
        event: 'last_seen',
        category: prev[id].categoryAuto,
      });
      removed += 1;
    }
  }

  // Rebuild snapshot for this provider from `incoming`. Models that vanished
  // are dropped (their lifecycle is captured by the last_seen event); if they
  // reappear later they'll get a fresh first_seen and we know the model went
  // away and came back. This matches user intent — show me sunsets, not a
  // permanently-growing log of every model ever seen.
  const nextModels: Record<string, SnapshotModel> = {};
  for (const m of incoming) {
    const before = prev[m.id];
    nextModels[m.id] = {
      firstSeen: before?.firstSeen ?? now,
      lastSeen: now,
      categoryAuto: m.categoryAuto,
    };
  }
  snap.providers[provider] = { lastFetch: now, models: nextModels };
  _writeSnapshot();

  return { added, removed, reclassified };
}

function recordOverride(
  provider: string,
  model: string,
  categoryTo: string | null,
  categoryFrom: string | null
): void {
  if (categoryTo) {
    _append({
      ts: Date.now(),
      provider,
      model,
      event: 'override_set',
      categoryFrom: categoryFrom || undefined,
      categoryTo,
    });
  } else {
    _append({
      ts: Date.now(),
      provider,
      model,
      event: 'override_cleared',
      categoryFrom: categoryFrom || undefined,
    });
  }
}

function recentEvents(limit = 200, provider: string | null = null): TrackerEvent[] {
  const arr = provider ? _ring.filter((e) => e.provider === provider) : _ring;
  return arr.slice(-limit).reverse();
}

function snapshot(): Snapshot {
  return _loadSnapshot();
}

// Per-provider summary for the debug screen.
function summary(): Array<{
  provider: string;
  lastFetch: number;
  modelCount: number;
  oldestFirstSeen: number;
  newestFirstSeen: number;
  recentEvents24h: number;
}> {
  const snap = _loadSnapshot();
  const cutoff24h = Date.now() - 24 * 60 * 60 * 1000;
  const out: ReturnType<typeof summary> = [];
  for (const [provider, data] of Object.entries(snap.providers)) {
    const models = Object.values(data.models);
    if (!models.length) {
      out.push({
        provider,
        lastFetch: data.lastFetch,
        modelCount: 0,
        oldestFirstSeen: 0,
        newestFirstSeen: 0,
        recentEvents24h: _ring.filter((e) => e.provider === provider && e.ts >= cutoff24h).length,
      });
      continue;
    }
    let oldest = models[0].firstSeen;
    let newest = models[0].firstSeen;
    for (const m of models) {
      if (m.firstSeen < oldest) oldest = m.firstSeen;
      if (m.firstSeen > newest) newest = m.firstSeen;
    }
    out.push({
      provider,
      lastFetch: data.lastFetch,
      modelCount: models.length,
      oldestFirstSeen: oldest,
      newestFirstSeen: newest,
      recentEvents24h: _ring.filter((e) => e.provider === provider && e.ts >= cutoff24h).length,
    });
  }
  out.sort((a, b) => a.provider.localeCompare(b.provider));
  return out;
}

// Daily prune timer + boot hydrate.
let _pruneTimer: any = null;
function startPruneTimer(): void {
  if (_pruneTimer) return;
  _pruneTimer = setInterval(_pruneOldFiles, 24 * 60 * 60_000);
  if (typeof _pruneTimer.unref === 'function') _pruneTimer.unref();
  _pruneOldFiles();
}
_hydrateRing();
startPruneTimer();

module.exports = {
  TRACKER_DIR,
  recordFetch,
  recordOverride,
  recentEvents,
  snapshot,
  summary,
};
