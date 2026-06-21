// ── context-rag ingest queue ──────────────────────────────────────────────────
// Unified in-memory FIFO over the three source kinds (session | file |
// knowledge). The runner is the only consumer; producers are:
//
//   - ingest/sessions.ts  → enqueue('session', sessionId) on auto-title finalize
//                           or startup scan.
//   - ingest/files.ts     → enqueue('file', absPath) on fs.watch change.
//                           (Wired in build-order step 10.)
//   - ingest/knowledge.ts → enqueue('knowledge', noteId) on context/keep-note
//                           write. (Wired in build-order step 10.)
//
// Coalescing: an item already in the queue is NOT re-enqueued — `enqueue()`
// returns `false`. Re-ingesting on a quick second change costs an embedding
// pass that the upsert layer would just throw away. The runner sees the item
// once; if a third change lands after dequeue, the next enqueue runs through.
//
// Persistence: none. On restart, the sessions/files/knowledge enqueuers each
// run a `scanAndEnqueueOnStartup()` pass that walks their corpus and finds
// items matching at least one VectorDB's source filter that aren't already
// represented in the matching DB(s). Same pattern as the categorizer's boot
// scan.
'use strict';

type SourceKind = 'session' | 'file' | 'knowledge' | 'synthesis';

interface QueueItem {
  kind:       SourceKind;
  /** Stable identifier in its corpus: session id, absolute file path, or
   *  knowledge entry id. */
  sourceId:   string;
  /** Why the item landed in the queue — useful for logging and debugging.
   *  'finalize'  : auto-title chain handoff for a session
   *  'startup'   : boot-time scan picked it up
   *  'manual'    : operator force-ingest via UI/MCP
   *  'fs-change' : files watcher debounce fired
   *  'write'     : knowledge entry was just persisted */
  reason?:    'finalize' | 'startup' | 'manual' | 'fs-change' | 'write';
  enqueuedAt: number;
}

// Insertion order is preserved by JS Map iteration, so the underlying store
// doubles as the FIFO.
const _items = new Map<string, QueueItem>();

function _key(kind: SourceKind, sourceId: string): string {
  return `${kind}:${sourceId}`;
}

/** Adds an item if not already queued. Returns `true` on insert, `false` if
 *  a same-kind/same-id item is already pending. */
function enqueue(kind: SourceKind, sourceId: string, reason?: QueueItem['reason']): boolean {
  if (!sourceId || typeof sourceId !== 'string') return false;
  const k = _key(kind, sourceId);
  if (_items.has(k)) return false;
  _items.set(k, { kind, sourceId, reason, enqueuedAt: Date.now() });
  return true;
}

/** Removes and returns the oldest item, or undefined when empty. */
function dequeue(): QueueItem | undefined {
  const it = _items.values().next();
  if (it.done) return undefined;
  const value = it.value as QueueItem;
  _items.delete(_key(value.kind, value.sourceId));
  return value;
}

/** Look at the next item without removing it. */
function peek(): QueueItem | undefined {
  const it = _items.values().next();
  return it.done ? undefined : (it.value as QueueItem);
}

function size(): number { return _items.size; }

function has(kind: SourceKind, sourceId: string): boolean {
  return _items.has(_key(kind, sourceId));
}

/** Snapshot for debug endpoints / UI. Does not drain the queue. */
function snapshot(): QueueItem[] {
  return Array.from(_items.values());
}

/** Count by source kind, for the management UI's queue-depth indicator. */
function depthByKind(): Record<SourceKind, number> {
  const out: Record<SourceKind, number> = { session: 0, file: 0, knowledge: 0, synthesis: 0 };
  for (const it of _items.values()) out[it.kind]++;
  return out;
}

/** Test/admin helper — empties the queue. */
function clear(): void { _items.clear(); }

export {
  enqueue,
  dequeue,
  peek,
  size,
  has,
  snapshot,
  depthByKind,
  clear,
};
export type { SourceKind, QueueItem };
