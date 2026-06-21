// cwd-manager — per-CWD config + runtime snapshot persistence.
//
// One JSON index file at ctx.dataDir/state.json, keyed by normalized
// absolute cwd. The loader does NOT mkdir ctx.dataDir, so createStore()
// does it itself (best-effort). Writes are debounced-synchronous: cheap
// and crash-safe enough for an opt-in supervisor's bookkeeping.
'use strict';

const fs = require('fs');
const path = require('path');

type CwdManagerEntry = import('./types').CwdManagerEntry;
type CwdManagerStore = import('./types').CwdManagerStore;

// 0.5 / 1 / 2 min — the three user-selectable active cadences.
const ACTIVE_INTERVALS = [30_000, 60_000, 120_000] as const;
const IDLE_INTERVAL_MS = 300_000; // 5 min programmatic-only
const DEFAULT_ACTIVE_INTERVAL_MS = 60_000;

function normalizeCwd(cwd: string | undefined): string {
  if (!cwd) return '';
  let p = String(cwd).trim();
  try {
    p = path.resolve(p);
  } catch (_) {
    /* keep raw */
  }
  // Strip a single trailing separator (but keep root "/").
  if (p.length > 1 && (p.endsWith('/') || p.endsWith('\\'))) p = p.slice(0, -1);
  return p;
}

function defaultEntry(cwd: string): CwdManagerEntry {
  return {
    cwd,
    enabled: false,
    activeIntervalMs: DEFAULT_ACTIVE_INTERVAL_MS,
    idleIntervalMs: IDLE_INTERVAL_MS,
    mode: 'off',
    lastProgrammaticAt: 0,
    lastAgentAt: 0,
    lastTodoHash: '',
    openTodoCount: 0,
    inProgressCount: 0,
    needsAgent: null,
    needsAgentReason: '',
    agentEnabled: false,
    workerEnabled: false,
    lastAction: 'none',
  };
}

function createStore(dataDir: string): CwdManagerStore {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (_) {
    /* best-effort */
  }
  const file = path.join(dataDir, 'state.json');

  const byCwd = new Map<string, CwdManagerEntry>();
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw);
    const arr: CwdManagerEntry[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.entries) ? parsed.entries : [];
    for (const e of arr) {
      if (!e || typeof e.cwd !== 'string') continue;
      const key = normalizeCwd(e.cwd);
      if (!key) continue;
      byCwd.set(key, { ...defaultEntry(key), ...e, cwd: key });
    }
  } catch (_) {
    /* fresh */
  }

  function save(): void {
    try {
      fs.writeFileSync(file, JSON.stringify([...byCwd.values()], null, 2) + '\n', 'utf8');
    } catch (_) {
      /* best-effort; a failed write just loses bookkeeping, not correctness */
    }
  }

  return {
    normalizeCwd,
    list() {
      return [...byCwd.values()];
    },
    get(cwd: string) {
      return byCwd.get(normalizeCwd(cwd));
    },
    ensure(cwd: string) {
      const key = normalizeCwd(cwd);
      return byCwd.get(key) || defaultEntry(key);
    },
    upsert(entry: CwdManagerEntry) {
      const key = normalizeCwd(entry.cwd);
      const next = { ...entry, cwd: key };
      byCwd.set(key, next);
      save();
      return next;
    },
    remove(cwd: string) {
      const ok = byCwd.delete(normalizeCwd(cwd));
      if (ok) save();
      return ok;
    },
    save,
  };
}

module.exports = {
  createStore,
  normalizeCwd,
  ACTIVE_INTERVALS,
  IDLE_INTERVAL_MS,
  DEFAULT_ACTIVE_INTERVAL_MS,
};
