// Bridge-side register infrastructure.
//
// A `Register<T>` is a typed, ordered list of entries that modules add
// to during `activate()` and remove during `deactivate()`. The plan
// (`YHA-modular-registers.md` §1) requires this exact shape on both
// the bridge and the frontend; the frontend half lives at
// `frontend/src/host/registers.ts` with the same semantics.
//
// Why one shared file: every today-hardcoded enumeration in core
// (tools, system-prompt fragments, harnesses, MCP servers, …) becomes
// a register call. Putting the contract in one place means the
// migration is mechanical: `array.push` → `register.add`,
// `array.forEach` → `register.list().forEach`. Done criterion 9 of
// the plan checks for this directly.
//
// Two non-obvious rules from the plan §1 (do not relax these without
// updating the doc):
//   - Adding twice is a fault, not a no-op. The first registrant
//     wins; the loader logs the conflict so the user can resolve it
//     in modules.json.
//   - `when()` returning false ≠ unregistered. It hides the entry
//     for one render only. Use it for "show only when CWD is set",
//     not for module on/off.
'use strict';

// ── Types ────────────────────────────────────────────────────────────────

interface RegisterEntryMeta {
  /** Unique within the register. */
  id: string;
  /** Auto-populated by `Register.add()` based on the calling module. */
  module?: string;
  /** Primary sort key, default 100. */
  order?: number;
  /** Ids this entry should sort before. */
  before?: string[] | null;
  /** Ids this entry should sort after. */
  after?: string[] | null;
  /** Dynamic predicate, re-evaluated per `list()` call. */
  when?: () => boolean;
  /**
   * `true` = pinned core entry, cannot be removed by `removeAllByModule()`.
   * Used by core for "must always have at least one" registers like
   * `harnesses` or `welcomeMessages`.
   */
  core?: boolean;
}

type Entry<T> = T & RegisterEntryMeta;

interface ChangeListener<T> {
  (entries: ReadonlyArray<Entry<T>>): void;
}

interface Register<T> {
  /** Register-wide name; matches the manifest key. */
  readonly id: string;
  /** Add an entry; returns a `dispose()` that removes it. */
  add(entry: Entry<T>, callerModule?: string): () => void;
  /** Get the current entries, sorted, with `when()` filtering applied. */
  list(): ReadonlyArray<Entry<T>>;
  /** Get the current entries, sorted, **without** `when()` filtering. */
  listAll(): ReadonlyArray<Entry<T>>;
  /** Subscribe to entry-set changes. Returns an `unsubscribe()`. */
  on(event: 'change', cb: ChangeListener<T>): () => void;
  /** Remove every non-core entry contributed by a module. */
  removeAllByModule(moduleName: string): number;
  /** Total entry count (includes filtered-out). */
  size(): number;
}

// ── Implementation ───────────────────────────────────────────────────────

function createRegister<T>(id: string): Register<T> {
  const entries: Entry<T>[] = [];
  const listeners = new Set<ChangeListener<T>>();
  let changeScheduled = false;

  function emitChange() {
    if (changeScheduled) return;
    changeScheduled = true;
    // Coalesce bursts: a module's `activate()` typically registers
    // many entries in a row. Flushing once at the end of the tick
    // avoids N notifications per add.
    queueMicrotask(() => {
      changeScheduled = false;
      const snapshot = sortedSnapshot();
      for (const cb of listeners) {
        try { cb(snapshot); }
        catch (e) { console.warn(`[register:${id}] change listener threw:`, e); }
      }
    });
  }

  function sortedSnapshot(filtered = false): ReadonlyArray<Entry<T>> {
    const items = filtered
      ? entries.filter((e) => (e.when ? safeWhen(e) : true))
      : entries.slice();
    return topoSort(items);
  }

  function safeWhen(e: Entry<T>): boolean {
    try { return e.when!() !== false; }
    catch (err) { console.warn(`[register:${id}] when() of ${e.id} threw:`, err); return false; }
  }

  function add(entry: Entry<T>, callerModule?: string): () => void {
    if (!entry || typeof entry.id !== 'string' || !entry.id) {
      throw new Error(`[register:${id}] add(): entry.id is required`);
    }
    const resolvedModule = callerModule || entry.module || '<core>';
    _checkProvides(id, resolvedModule);
    const existing = entries.find((e) => e.id === entry.id);
    if (existing) {
      // Plan §1: duplicate registrations are a fault, not a no-op.
      // The first registrant wins.
      console.warn(
        `[register:${id}] duplicate entry id="${entry.id}" from module="${callerModule || entry.module || '<unknown>'}" — ` +
        `existing entry from module="${existing.module}" kept. ` +
        `Resolve via bridge/modules.json (disable one provider).`
      );
      return () => { /* no-op for the loser */ };
    }
    const stored: Entry<T> = {
      ...entry,
      module: callerModule || entry.module || '<core>',
      order: entry.order ?? 100,
    };
    entries.push(stored);
    emitChange();

    let disposed = false;
    return function dispose() {
      if (disposed) return;
      disposed = true;
      const idx = entries.indexOf(stored);
      if (idx >= 0) {
        entries.splice(idx, 1);
        emitChange();
      }
    };
  }

  function list(): ReadonlyArray<Entry<T>> { return sortedSnapshot(true); }
  function listAll(): ReadonlyArray<Entry<T>> { return sortedSnapshot(false); }

  function on(_event: 'change', cb: ChangeListener<T>): () => void {
    listeners.add(cb);
    return () => listeners.delete(cb);
  }

  function removeAllByModule(moduleName: string): number {
    let removed = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.module === moduleName && !e.core) {
        entries.splice(i, 1);
        removed++;
      }
    }
    if (removed > 0) emitChange();
    return removed;
  }

  function size(): number { return entries.length; }

  return { id, add, list, listAll, on, removeAllByModule, size };
}

// ── Topological sort ────────────────────────────────────────────────────
// Sort by `order` first, then resolve `before`/`after` constraints with
// a small DAG. Cycles fall back to insertion order with a warning so a
// misbehaving module can't lock the register.

function topoSort<T>(items: Entry<T>[]): Entry<T>[] {
  if (items.length <= 1) return items;
  // Pre-sort by order so the DAG result is deterministic when no
  // before/after edges exist.
  const byOrder = items.slice().sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  const idIndex = new Map(byOrder.map((e, i) => [e.id, i] as const));
  const incoming: number[][] = byOrder.map(() => []);
  const outDegree = new Array(byOrder.length).fill(0);

  for (let i = 0; i < byOrder.length; i++) {
    const e = byOrder[i];
    for (const targetId of e.before || []) {
      const j = idIndex.get(targetId);
      if (j !== undefined) {
        incoming[j].push(i);
        outDegree[i]++;
      }
    }
    for (const sourceId of e.after || []) {
      const j = idIndex.get(sourceId);
      if (j !== undefined) {
        incoming[i].push(j);
        outDegree[j]++;
      }
    }
  }

  // Kahn's algorithm; ties broken by `byOrder` index.
  const ready: number[] = [];
  for (let i = 0; i < byOrder.length; i++) if (outDegree[i] === 0) ready.push(i);
  const out: Entry<T>[] = [];
  const seen = new Set<number>();
  while (ready.length) {
    const i = ready.shift()!;
    if (seen.has(i)) continue;
    seen.add(i);
    out.push(byOrder[i]);
    for (const j of incoming[i]) {
      outDegree[j]--;
      if (outDegree[j] === 0) ready.push(j);
    }
  }
  if (out.length !== byOrder.length) {
    // Cycle detected. Append the rest in insertion order; warn once.
    console.warn(`[register] before/after cycle detected — falling back to insertion order`);
    for (let i = 0; i < byOrder.length; i++) if (!seen.has(i)) out.push(byOrder[i]);
  }
  return out;
}

// ── Module-provides side-table ──────────────────────────────────────────
// Populated by the loader after manifest validation: each enabled module's
// declared `provides.bridgeRegisters` (or null if it didn't declare one).
// `Register.add` consults this to detect schema drift — a module writing to
// a register its manifest didn't promise. Under `YHA_STRICT_MODULES=1` the
// mismatch throws; otherwise it warns once per (module, register) pair.
const _moduleProvides = new Map<string, string[] | null>();
const _providesWarned = new Set<string>();
function setModuleProvides(moduleName: string, ids: string[] | null): void {
  if (!moduleName) return;
  _moduleProvides.set(moduleName, ids);
}
function _checkProvides(registerId: string, callerModule: string): void {
  if (!callerModule || callerModule === '<core>') return;
  const declared = _moduleProvides.get(callerModule);
  // `undefined` means the loader hasn't recorded this module yet (boot
  // race or non-module caller). `null` means the module's manifest didn't
  // declare a provides.bridgeRegisters list — permissive by design so the
  // schema field stays opt-in.
  if (declared == null) return;
  if (declared.includes(registerId)) return;
  const key = `${callerModule}|${registerId}`;
  if (_providesWarned.has(key)) return;
  _providesWarned.add(key);
  const msg = `[register:${registerId}] module "${callerModule}" wrote to a register its manifest did not declare in provides.bridgeRegisters (declared: ${declared.length ? declared.join(', ') : '(empty)'})`;
  if (process.env.YHA_STRICT_MODULES === '1' || process.env.YHA_STRICT_MODULES === 'true') {
    throw new Error(msg + ' — YHA_STRICT_MODULES=1');
  }
  console.warn(msg);
}

// ── Registry of registers ────────────────────────────────────────────────
// One container so the loader can look up a register by id without core
// having to import every register module.

const REGISTRY = new Map<string, Register<unknown>>();

function declareRegister<T>(id: string): Register<T> {
  const existing = REGISTRY.get(id);
  if (existing) return existing as Register<T>;
  const r = createRegister<T>(id);
  REGISTRY.set(id, r as Register<unknown>);
  return r;
}

function getRegister<T>(id: string): Register<T> | undefined {
  return REGISTRY.get(id) as Register<T> | undefined;
}

function listRegisters(): string[] {
  return [...REGISTRY.keys()].sort();
}

/** Remove every non-core entry of every register contributed by `moduleName`. */
function removeModuleEverywhere(moduleName: string): number {
  let total = 0;
  for (const r of REGISTRY.values()) total += r.removeAllByModule(moduleName);
  return total;
}

module.exports = {
  createRegister,
  declareRegister,
  getRegister,
  listRegisters,
  removeModuleEverywhere,
  setModuleProvides,
};
