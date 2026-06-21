// ── #btw queue: mid-response user injections ─────────────────────────────────
//
// Plan / how this works:
//
//   The user can drop additional context into a session WHILE the LLM is still
//   responding (ähnlich wie /btw in Claude Code). Frontend sends the text via
//   POST /v1/sessions/:id/btw → enqueueBtw(sessionId, text). The active tool
//   loop in tools/stream.ts (and the Anthropic / OpenAI-compat / Gemini
//   variants) calls drainBtw(sessionId) AFTER each tool-result roundtrip but
//   BEFORE the next API call, then prepends the drained items as a synthetic
//   user message:
//
//     [User added mid-response: <text>]
//
//   Limits of this approach (documented for future work):
//     - injection only happens at tool-call boundaries, never mid-token-stream
//     - reine Text-Antworten ohne Tools bekommen die btw erst beim nächsten Turn
//     - Claude Agent SDK + Codex CLI Harness sind eigene Blackboxes — the queue
//       is read but cannot be injected into the running harness session yet
//       (siehe TODO in server-claude-agent.ts / providers/codex.ts).
//       Workaround dort: btw bleibt in der Queue und wird beim nächsten /v1/stream
//       Aufruf in der History sichtbar.

'use strict';

const queues: Map<string, string[]> = new Map();

// ── Live-stream reference registry ──────────────────────────────────────────
// Phase 7 owners: sessions-internal/index.ts:startLiveMsg registers itself
// here when Go-core opens a streaming live message via the
// /internal/persist-broadcast-message?phase=start hop. The /btw endpoint (and
// other side-channel injectors: interrupt/note, ask-user-question) push their
// blocks into `ref.blocks` — a per-session **side buffer** distinct from the
// persisted entry's `blocks` field. Reason: Go-core periodically POSTs
// phase=update with its own complete blocks array, which would otherwise
// wipe anything we wrote directly into the entry. updateLiveMsg /
// finalizeLiveMsg re-merge the side buffer at the tail of Go's view on
// every update, so injections survive across Go's wholesale overwrites.
// The pre-Phase-7 in-process chat handler used to keep its own local blocks
// array and let updateLiveMsg pull the merged view from there — the side
// buffer is the moral replacement now that the blocks-builder lives in Go.
type LiveStreamRef = {
  blocks: any[];
  flushBlockText: () => void;
  persistSnapshot: () => void;
};
const liveStreamRefs: Map<string, LiveStreamRef> = new Map();

function registerLiveStream(sessionId: string, ref: LiveStreamRef): void {
  liveStreamRefs.set(String(sessionId || 'default'), ref);
}

function unregisterLiveStream(sessionId: string): void {
  liveStreamRefs.delete(String(sessionId || 'default'));
}

function getLiveStreamRef(sessionId: string): LiveStreamRef | null {
  return liveStreamRefs.get(String(sessionId || 'default')) || null;
}

function injectInlineBlock(sessionId: string, block: any, broadcast?: (sessionId: string, chunk: any) => void, chunk?: any): boolean {
  const ref = liveStreamRefs.get(String(sessionId || 'default'));
  if (!ref) return false;
  try {
    ref.flushBlockText();
    ref.blocks.push(block);
    ref.persistSnapshot();
    if (broadcast && chunk) broadcast(String(sessionId || 'default'), chunk);
  } catch (_) { return false; }
  return true;
}

// ── Live-stdin sink registry ────────────────────────────────────────────────
// Harness providers (currently only claude-binary in stream-json input mode)
// register a writer that splices a JSONL user message directly into the
// running child process's stdin. When set, /btw bypasses the queue and
// writes live; the binary applies the message at its next turn boundary.
//
// Sinks return true on a successful write. Returning false (or throwing)
// signals the caller to fall back to enqueueBtw + next-turn fold-in.
type LiveStdinSink = (text: string) => boolean;
const liveStdinSinks: Map<string, LiveStdinSink> = new Map();

function registerLiveStdin(sessionId: string, sink: LiveStdinSink): void {
  liveStdinSinks.set(String(sessionId || 'default'), sink);
}

function unregisterLiveStdin(sessionId: string): void {
  liveStdinSinks.delete(String(sessionId || 'default'));
}

function tryLiveStdinInject(sessionId: string, text: string): boolean {
  const sink = liveStdinSinks.get(String(sessionId || 'default'));
  if (!sink) return false;
  try { return sink(text) === true; } catch (_) { return false; }
}

// `livePath` tells the UI whether the model will see this btw THIS turn:
//   'direct'  → live this turn. Either a direct-API tool-loop drain will pick
//                it up at the next tool boundary, OR the claude-binary harness
//                accepted it via the live stdin sink (real mid-turn injection).
//   'harness' → queued. No active live sink at injection time (codex CLI, or
//                claude-binary spawn that already finished). Will be folded
//                into the NEXT turn's prompt via rebuildSessionChatHistory.
//   'unknown' → no active stream tagged with a routeType.
function _livePathFromRoute(routeType?: string | null, liveStdin?: boolean): 'direct' | 'harness' | 'unknown' {
  if (liveStdin) return 'direct';
  if (routeType === 'direct-anthropic' || routeType === 'external') return 'direct';
  if (routeType === 'claude' || routeType === 'codex') return 'harness';
  return 'unknown';
}

function injectBtwBlock(sessionId: string, text: string, broadcast?: (sessionId: string, chunk: any) => void, routeType?: string | null, liveStdin?: boolean): boolean {
  const trimmed = String(text || '').trim();
  if (!trimmed) return false;
  const formatted = `#btw ${trimmed}`;
  const livePath = _livePathFromRoute(routeType, liveStdin);
  return injectInlineBlock(
    sessionId,
    { type: 'btw', text: formatted, ts: Date.now(), livePath },
    broadcast,
    { btwBlock: { text: formatted, livePath } }
  );
}

function enqueueBtw(sessionId: string, text: string): void {
  const sid = String(sessionId || 'default');
  const trimmed = String(text || '').trim();
  if (!trimmed) return;
  const list = queues.get(sid) || [];
  list.push(trimmed);
  queues.set(sid, list);
}

function drainBtw(sessionId: string): string[] {
  const sid = String(sessionId || 'default');
  const list = queues.get(sid);
  if (!list || !list.length) return [];
  queues.delete(sid);
  return list;
}

function peekBtw(sessionId: string): string[] {
  const sid = String(sessionId || 'default');
  return [...(queues.get(sid) || [])];
}

function clearBtw(sessionId: string): void {
  const sid = String(sessionId || 'default');
  queues.delete(sid);
}

// Format drained items into a single user-message string for injection.
function formatBtwInjection(items: string[]): string {
  if (!items.length) return '';
  if (items.length === 1) return `[User added mid-response: ${items[0]}]`;
  return items.map((t) => `[User added mid-response: ${t}]`).join('\n');
}

module.exports = {
  enqueueBtw,
  drainBtw,
  peekBtw,
  clearBtw,
  formatBtwInjection,
  registerLiveStream,
  unregisterLiveStream,
  getLiveStreamRef,
  injectInlineBlock,
  injectBtwBlock,
  registerLiveStdin,
  unregisterLiveStdin,
  tryLiveStdinInject,
};
