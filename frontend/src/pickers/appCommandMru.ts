// Recently-used command tracking for the `/` App Command Palette.
//
// Persisted in localStorage as `yha.appCmdMru` — a small array of `{ id,
// ts }` records, capped to `MAX_ENTRIES`. The palette injects an
// auto-expanded "Recent" group at the top of the hierarchical (rest)
// view; flat-mode (when the user is filtering) ignores MRU so a typed
// query always ranks against the full catalog.
//
// We track only command *ids* — not the AppCommand object — so a module
// can unregister/replace a command without leaving dead entries (the
// palette filters MRU ids against the current catalog on read).

const LS_KEY = 'yha.appCmdMru';
const MAX_ENTRIES = 24;
const SURFACE_LIMIT = 6;

interface MruRecord {
  id: string;
  ts: number;
}

function readAll(): MruRecord[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((r): r is MruRecord =>
      r && typeof r.id === 'string' && typeof r.ts === 'number',
    );
  } catch {
    return [];
  }
}

function writeAll(records: MruRecord[]): void {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(records.slice(0, MAX_ENTRIES)));
  } catch { /* quota, no-op */ }
}

/**
 * Record a command as just-used. De-duped by id (latest timestamp wins).
 * Capped to MAX_ENTRIES so the list can't grow unbounded.
 */
export function recordCommandUse(id: string): void {
  const now = Date.now();
  const filtered = readAll().filter((r) => r.id !== id);
  writeAll([{ id, ts: now }, ...filtered]);
  window.dispatchEvent(new CustomEvent('yha:app-cmd-mru-changed'));
}

/**
 * Return the ids of the most-recently-used commands, newest first, capped
 * to `SURFACE_LIMIT`. Filtered against `availableIds` so vanished commands
 * (uninstalled modules) don't surface.
 */
export function listMruIds(availableIds: Set<string>): string[] {
  return readAll()
    .filter((r) => availableIds.has(r.id))
    .slice(0, SURFACE_LIMIT)
    .map((r) => r.id);
}

/** Wipe the MRU log entirely (debug helper; not currently surfaced). */
export function clearMru(): void {
  writeAll([]);
  window.dispatchEvent(new CustomEvent('yha:app-cmd-mru-changed'));
}
