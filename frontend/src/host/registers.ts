import { getToastActions } from '../stores/toastStore.js';

// Frontend-side register infrastructure.
//
// Mirror of `bridge/core/registers/index.ts` with the same semantics —
// see that file for the design rationale (`YHA-modular-registers.md`
// §1). Two halves are split because the bridge runs CommonJS and the
// frontend runs ESM under Vite, so shared imports aren't possible
// without a bundler shim. The contract is identical and PR-tested
// against the bridge half.
//
// Slot components subscribe to a register's `change` event via the
// `useRegisterList()` hook (see `./useRegisterList.ts`) so a module's
// `host.registers.<key>.add(entry)` automatically re-renders the
// affected slot.

// ── Types ────────────────────────────────────────────────────────────────

export interface RegisterEntryMeta {
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
  /** Pinned core entry; not removed by `removeAllByModule()`. */
  core?: boolean;
}

export type Entry<T> = T & RegisterEntryMeta;

type ChangeListener<T> = (entries: ReadonlyArray<Entry<T>>) => void;

export interface Register<T> {
  readonly id: string;
  add(entry: Entry<T>, callerModule?: string): () => void;
  list(): ReadonlyArray<Entry<T>>;
  listAll(): ReadonlyArray<Entry<T>>;
  on(event: 'change', cb: ChangeListener<T>): () => void;
  removeAllByModule(moduleName: string): number;
  size(): number;
}

// ── Implementation ───────────────────────────────────────────────────────

export function createRegister<T>(id: string): Register<T> {
  const entries: Entry<T>[] = [];
  const listeners = new Set<ChangeListener<T>>();
  let changeScheduled = false;
  // Dedupe toast surfaces so a misbehaving entry doesn't fire a toast on
  // every render. Keyed by `<kind>|<entryId>` — the same entry can hit both
  // a `when()` throw and a `listener` throw and we want both surfaced once.
  const _toastedFailures = new Set<string>();
  function _surfaceFailure(kind: 'when' | 'listener', entryId: string, _err: unknown): void {
    const key = `${kind}|${entryId}`;
    if (_toastedFailures.has(key)) return;
    _toastedFailures.add(key);
    const msg = kind === 'when'
      ? `Register entry "${entryId}" hidden — predicate threw (see console)`
      : `Register listener for "${entryId}" threw (see console)`;
    try {
      getToastActions().show(msg, 'warning', { duration: 6000 });
    } catch (_) { /* toast store may not be ready during early boot */ }
  }
  // Cached snapshots — invalidated immediately on any mutation so that
  // useSyncExternalStore's getSnapshot() returns a stable reference between
  // mutations. Without caching every call creates a new array, which React
  // treats as a changed store and schedules a re-render, causing an infinite
  // loop (React error #185).
  let cachedFiltered: ReadonlyArray<Entry<T>> | null = null;
  let cachedAll: ReadonlyArray<Entry<T>> | null = null;

  function emitChange() {
    // Invalidate caches synchronously so the next list()/listAll() call
    // after an add/remove produces a fresh snapshot.
    cachedFiltered = null;
    cachedAll = null;
    if (changeScheduled) return;
    changeScheduled = true;
    queueMicrotask(() => {
      changeScheduled = false;
      const snapshot = sortedSnapshot(false);
      for (const cb of listeners) {
        try { cb(snapshot); }
        catch (e) {
          console.warn(`[register:${id}] listener threw:`, e);
          // Listeners don't carry an entry id, so we key the dedupe on the
          // register id — one toast per register per process is enough to
          // tell the user "something downstream of <id> broke; check console".
          _surfaceFailure('listener', id, e);
        }
      }
    });
  }

  function safeWhen(e: Entry<T>): boolean {
    try { return e.when!() !== false; }
    catch (err) {
      console.warn(`[register:${id}] when() of ${e.id} threw:`, err);
      _surfaceFailure('when', e.id, err);
      return false;
    }
  }

  function sortedSnapshot(filtered: boolean): ReadonlyArray<Entry<T>> {
    if (filtered) {
      if (cachedFiltered === null) {
        const items = entries.filter((e) => (e.when ? safeWhen(e) : true));
        cachedFiltered = topoSort(items);
      }
      return cachedFiltered;
    }
    if (cachedAll === null) {
      cachedAll = topoSort(entries.slice());
    }
    return cachedAll;
  }

  function add(entry: Entry<T>, callerModule?: string): () => void {
    if (!entry || typeof entry.id !== 'string' || !entry.id) {
      throw new Error(`[register:${id}] add(): entry.id is required`);
    }
    const existing = entries.find((e) => e.id === entry.id);
    if (existing) {
      console.warn(
        `[register:${id}] duplicate entry id="${entry.id}" from module="${callerModule || entry.module || '<unknown>'}" — ` +
        `existing entry from module="${existing.module}" kept.`
      );
      return () => { /* loser no-op */ };
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

  return {
    id,
    add,
    list: () => sortedSnapshot(true),
    listAll: () => sortedSnapshot(false),
    on(_event, cb) { listeners.add(cb); return () => listeners.delete(cb); },
    removeAllByModule(moduleName) {
      let removed = 0;
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e.module === moduleName && !e.core) { entries.splice(i, 1); removed++; }
      }
      if (removed > 0) emitChange();
      return removed;
    },
    size() { return entries.length; },
  };
}

// One-shot warn dedupe so each (entry, missing-target) pair surfaces exactly
// once per process. The previous topo-sort silently dropped non-resolving
// before/after references, leaving authors to wonder why their ordering
// declaration didn't take effect.
const _missingRefWarned = new Set<string>();
function _warnMissingRef(direction: 'before' | 'after', entryId: string, missingId: string): void {
  const key = `${direction}|${entryId}|${missingId}`;
  if (_missingRefWarned.has(key)) return;
  _missingRefWarned.add(key);
  console.warn(`[register] entry "${entryId}" declares ${direction}: "${missingId}", but "${missingId}" does not exist — order constraint ignored`);
}

function topoSort<T>(items: Entry<T>[]): Entry<T>[] {
  if (items.length <= 1) return items;
  const byOrder = items.slice().sort((a, b) => (a.order ?? 100) - (b.order ?? 100));
  const idIndex = new Map(byOrder.map((e, i) => [e.id, i] as const));
  const incoming: number[][] = byOrder.map(() => []);
  const outDegree = new Array(byOrder.length).fill(0);

  for (let i = 0; i < byOrder.length; i++) {
    const e = byOrder[i];
    for (const targetId of e.before || []) {
      const j = idIndex.get(targetId);
      if (j !== undefined) { incoming[j].push(i); outDegree[i]++; }
      else _warnMissingRef('before', e.id, targetId);
    }
    for (const sourceId of e.after || []) {
      const j = idIndex.get(sourceId);
      if (j !== undefined) { incoming[i].push(j); outDegree[j]++; }
      else _warnMissingRef('after', e.id, sourceId);
    }
  }

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
    console.warn(`[register] before/after cycle detected — falling back to insertion order`);
    for (let i = 0; i < byOrder.length; i++) if (!seen.has(i)) out.push(byOrder[i]);
  }
  return out;
}

// ── Registry of registers ────────────────────────────────────────────────

const REGISTRY = new Map<string, Register<unknown>>();

export function declareRegister<T>(id: string): Register<T> {
  const existing = REGISTRY.get(id);
  if (existing) return existing as Register<T>;
  const r = createRegister<T>(id);
  REGISTRY.set(id, r as Register<unknown>);
  return r;
}

export function getRegister<T>(id: string): Register<T> | undefined {
  return REGISTRY.get(id) as Register<T> | undefined;
}

export function listRegisters(): string[] {
  return [...REGISTRY.keys()].sort();
}

export function removeModuleEverywhere(moduleName: string): number {
  let total = 0;
  for (const r of REGISTRY.values()) total += r.removeAllByModule(moduleName);
  return total;
}
