// ── Session display layer + barrel re-export of split submodules ──────────────
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  config,
  saveConfig,
  displaySessions,
  activeModels,
} = require('../core/state');
const logger = require('../core/logger');
const images = require('./images');
const history = require('./history');
const streams = require('./streams');
const persistence = require('./persistence');

// ── Session helpers ───────────────────────────────────────────────────────────
// Display-side message cap. Older entries are spliced off the head whenever
// pushDisplayMsg / insertBeforeLive overruns. Config.defaults.message_max_count
// lets a deployment lift the cap without editing code; the legacy hard-coded
// 200 is the default. Read through an accessor so a hot config-reload takes
// effect on the next push.
const DEFAULT_MESSAGE_MAX_COUNT = 200;
function _messageMaxCount(): number {
  const v = Number(config.defaults?.message_max_count);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MESSAGE_MAX_COUNT;
}

function defaultWorkingDir() {
  const d = config.defaults?.workingDir;
  if (d && typeof d === 'string') {
    try {
      const abs = path.resolve(d);
      if (fs.statSync(abs).isDirectory()) return abs;
    } catch (_) {
      /* fall through to homedir */
    }
  }
  return os.homedir();
}

function getOrCreateDisplaySession(sid) {
  const isNew = !displaySessions.has(sid);
  if (isNew) {
    const now = Date.now();
    displaySessions.set(sid, {
      id: sid,
      name: `Session ${sid}`,
      messages: [],
      createdAt: now,
      lastUsed: now,
      viewedAt: now,
      workingDir: defaultWorkingDir(),
      // Ghost flag — the session is in-memory only until a real message
      // arrives. Prevents PATCHes (e.g. setting workingDir from "+ New
      // Session same dir") from permanently saving an empty chat. Stripped
      // by _promoteIfGhost() the moment pushDisplayMsg / startLiveMsg /
      // insertBeforeLive runs. Stale ghosts are GC'd by the cleanup interval.
      _inMemoryOnly: true,
    });
    // No saveIndexToDisk here — promotion to persistent happens on first message.
  }
  return displaySessions.get(sid);
}

// Promotes an in-memory ghost session to a persistent one. Called by every
// message-pushing function (pushDisplayMsg / startLiveMsg / insertBeforeLive)
// so the first real message in a session is what writes it to disk. No-op for
// sessions that are already persistent or were created by createBackgroundSession.
function _promoteIfGhost(s) {
  if (!s || !s._inMemoryOnly) return;
  delete s._inMemoryOnly;
  persistence.saveIndexToDisk();
}

// Creates a session without setting viewedAt so it appears as unread in the picker.
function createBackgroundSession(sid, name?) {
  const now = Date.now();
  displaySessions.set(sid, {
    id: sid,
    name: name || `Session ${sid}`,
    messages: [],
    createdAt: now,
    lastUsed: now,
    viewedAt: 0,
    workingDir: defaultWorkingDir(),
  });
  persistence.saveIndexToDisk();
  return displaySessions.get(sid);
}

function getSessionCwd(sessionId) {
  return displaySessions.get(sessionId)?.workingDir || defaultWorkingDir();
}

// ── Display message API ───────────────────────────────────────────────────────
function pushDisplayMsg(sid, role, text, blocks?, meta?) {
  // Guard: don't recreate a session that was deliberately deleted mid-stream.
  if (persistence.isSessionDeleted(sid)) return;
  const s = getOrCreateDisplaySession(sid);
  const ts = Date.now();
  const entry: any = { role, ts };
  if (blocks && blocks.length) {
    entry.blocks = blocks;
  } else {
    entry.text = text || '';
  }
  if (meta) entry.meta = meta;
  s.messages.push(entry);
  s.lastUsed = ts;
  // Auto-name session from first user message — track count to avoid O(n) filter each call
  if (role === 'user') {
    s.userMessageCount = (s.userMessageCount || 0) + 1;
    if (s.userMessageCount === 1) {
      s.name = text.slice(0, 50).trim() || s.name;
      // Mark as auto-named so the AI title worker knows it can safely overwrite.
      // Sessions the user renames get _nameSource = 'user' via PATCH /v1/sessions/:id.
      if (!s._nameSource) s._nameSource = 'auto';
    }
  }
  const cap = _messageMaxCount();
  if (s.messages.length > cap) s.messages.splice(0, s.messages.length - cap);
  _promoteIfGhost(s);
  persistence.saveSessionToDisk(sid);
}

// ── Live-streaming message persistence ───────────────────────────────────────
// Writes a placeholder assistant entry the moment streaming begins so partial
// content survives a crash, server restart, or API disconnect mid-stream.

// Token-based live-msg lookup: returned value is a unique token, not an array
// index — that lets us splice other entries (like #btw notes) before the live
// entry without breaking the update/finalize calls. Returns -1 if no session.
let _liveTokenCounter = 1;
// JS numbers are doubles so the counter doesn't truncate-wrap at 2^31 the way
// a typed int would — but the Go-side mirror (go-core/internal/stream uses
// int64) and the persist-broadcast wire format treat the value as a 64-bit
// int. We never go anywhere near that ceiling in practice (millions of
// turns/year × decades to even approach 2^53), but a runaway loop bug could,
// so warn loudly once we cross MAX_SAFE_INTEGER. The increment continues so
// existing in-flight tokens still finalize; the new tokens just become less
// trustworthy and the warning gives an operator something to grep for.
const LIVE_TOKEN_SAFE_CEILING = Number.MAX_SAFE_INTEGER;
let _liveTokenCeilingWarned = false;

function _findLiveIdx(s, token) {
  if (token < 0) return -1;
  for (let i = 0; i < s.messages.length; i++) {
    if (s.messages[i]._liveToken === token) return i;
  }
  return -1;
}

// Tokens whose target message was deliberately deleted while the stream was
// still in flight. update/final calls that arrive after the splice would
// otherwise hit _findLiveIdx === -1 and fall back to pushDisplayMsg —
// resurrecting the deleted bubble. Keyed by sid → Set<token>. Cleared when
// the session itself is deleted (pruneDiscardedTokensForSession).
const _discardedLiveTokens: Map<string, Set<number>> = new Map();

function markLiveTokenDiscarded(sid: string, token: number): void {
  if (!sid || !Number.isFinite(token) || token <= 0) return;
  let set = _discardedLiveTokens.get(sid);
  if (!set) {
    set = new Set();
    _discardedLiveTokens.set(sid, set);
  }
  set.add(token);
}

function _isLiveTokenDiscarded(sid: string, token: number): boolean {
  const set = _discardedLiveTokens.get(sid);
  return !!(set && set.has(token));
}

function pruneDiscardedTokensForSession(sid: string): void {
  _discardedLiveTokens.delete(sid);
}

// Hard ceiling for how long a single assistant turn may stay streaming:true
// before any reader treats it as abandoned. Defensive cap against silent
// pipeline wedges (proc never closed, finalize callback swallowed, etc.).
// 60 min accommodates long reasoning-model "thinking" (o1/o3/o4 etc can
// legitimately pause before first token or produce slowly) + multi-step
// agent/tool runs. Still safely below the 1 h active-stream zombie GC.
// When hit, the sweeper injects a kind=timeout interrupt and aborts the
// backend goroutine via /v1/stop so resources aren't leaked.
const LIVE_MSG_MAX_DURATION_MS = 60 * 60 * 1000;

// Side-channel injections (btw / interrupt-note / ask-user-question) live in
// a per-session buffer tied to the LiveStreamRef registered below. updateLive
// Msg / finalizeLiveMsg re-merge it onto the tail of Go-core's wholesale view
// so injections survive across phase=update overwrites. Reference compare on
// elements avoids dupes when persistSnapshot fires between Go updates.
function _mergeInjectedIntoEntry(entry: any, sideBuffer: any[]): void {
  if (!sideBuffer.length) return;
  let goView: any[];
  if (Array.isArray(entry.blocks) && entry.blocks.length > 0) {
    const sideSet = new Set(sideBuffer);
    goView = entry.blocks.filter((b: any) => !sideSet.has(b));
  } else if (typeof entry.text === 'string' && entry.text.length > 0) {
    goView = [{ type: 'text', text: entry.text }];
  } else {
    goView = [];
  }
  entry.blocks = [...goView, ...sideBuffer];
  delete entry.text;
}

function _peekSideBuffer(sid: string): any[] {
  try {
    const { getLiveStreamRef } = require('../chat/btw-queue');
    return getLiveStreamRef(sid)?.blocks || [];
  } catch (_) {
    return [];
  }
}

function startLiveMsg(sid, role, meta?) {
  if (persistence.isSessionDeleted(sid)) return -1;
  const s = getOrCreateDisplaySession(sid);
  const ts = Date.now();
  const token = _liveTokenCounter++;
  if (token > LIVE_TOKEN_SAFE_CEILING && !_liveTokenCeilingWarned) {
    _liveTokenCeilingWarned = true;
    console.warn(`[sessions-internal] _liveTokenCounter crossed Number.MAX_SAFE_INTEGER (${LIVE_TOKEN_SAFE_CEILING}); subsequent live-msg tokens may collide on equality. Restart the bridge to reset.`);
  }
  const entry: any = {
    role, ts, text: '', streaming: true,
    _liveToken: token,
    _liveDeadline: ts + LIVE_MSG_MAX_DURATION_MS,
    // Monotonic-clock start used by the in-process sweep. Survives suspend/
    // resume and NTP jumps that mutate Date.now() under the deadline. Not
    // persisted (see MESSAGE_PROMOTED_KEYS) — meaningless across processes.
    _liveStartedPerfMs: performance.now(),
  };
  if (meta) entry.meta = meta;
  s.messages.push(entry);
  s.lastUsed = ts;
  _promoteIfGhost(s);
  persistence.flushSessionToDisk(sid); // immediate — not debounced
  // Register a LiveStreamRef so /btw, /messages?role=note, and the bridge
  // virtual AskUser tool can splice blocks into this live entry. ref.blocks
  // is a side buffer scoped to this token — distinct from the persisted
  // entry's blocks, which Go-core overwrites wholesale on every phase=update.
  // updateLiveMsg / finalizeLiveMsg re-merge the buffer at the tail of Go's
  // view so injections survive. Cleared at finalizeLiveMsg + finalizeStream.
  const sideBuffer: any[] = [];
  try {
    const { registerLiveStream } = require('../chat/btw-queue');
    registerLiveStream(sid, {
      blocks: sideBuffer,
      flushBlockText: () => { /* no-op: text accumulation lives in Go-core */ },
      persistSnapshot: () => {
        if (_isLiveTokenDiscarded(sid, token)) return;
        const live = displaySessions.get(sid);
        if (!live) return;
        const i = _findLiveIdx(live, token);
        if (i < 0) return;
        _mergeInjectedIntoEntry(live.messages[i], sideBuffer);
        persistence.flushSessionToDisk(sid);
      },
    });
  } catch (_) { /* btw-queue unavailable — Node path degrades to insertBeforeLive */ }
  return token;
}

function updateLiveMsg(sid, token, text, blocks?, liveMetaPatch?) {
  const s = displaySessions.get(sid);
  if (!s) return;
  if (_isLiveTokenDiscarded(sid, token)) return;
  const idx = _findLiveIdx(s, token);
  if (idx < 0) return;
  const entry = s.messages[idx];
  const sideBuffer = _peekSideBuffer(sid);
  if (blocks && blocks.length) {
    entry.blocks = sideBuffer.length ? [...blocks, ...sideBuffer] : blocks;
    delete entry.text;
  } else if (sideBuffer.length) {
    // Go shipped text-only but injected blocks exist — force blocks mode so
    // they don't get clobbered by the text/blocks toggle.
    const synth = text ? [{ type: 'text', text }] : [];
    entry.blocks = [...synth, ...sideBuffer];
    delete entry.text;
  } else {
    entry.text = text || '';
    delete entry.blocks;
  }
  if (liveMetaPatch && typeof liveMetaPatch === 'object') {
    entry.meta = { ...(entry.meta || {}), ...liveMetaPatch };
  }
  // Single-row delta write — NOT the full O(messages) session rewrite. This
  // runs on every mid-stream checkpoint (~every 2 s per active stream); the
  // full rewrite here was what wedged the event loop + the shared SQLite write
  // lock under multiple big parallel sessions. Falls back to a debounced full
  // write internally when the streaming row can't be targeted.
  persistence.saveLiveMsgDelta(sid, entry);
}

function finalizeLiveMsg(sid, token, text, blocks?, meta?) {
  const s = displaySessions.get(sid);
  if (!s) return pushDisplayMsg(sid, 'assistant', text, blocks, meta);
  if (_isLiveTokenDiscarded(sid, token)) return;
  const idx = _findLiveIdx(s, token);
  if (idx < 0) {
    // Placeholder was lost (e.g. session deleted mid-stream) — fall back.
    pushDisplayMsg(sid, 'assistant', text, blocks, meta);
    return;
  }
  const entry = s.messages[idx];
  delete entry.streaming;
  delete entry._liveToken;
  delete entry._liveDeadline;
  delete entry._liveStartedPerfMs;
  const sideBuffer = _peekSideBuffer(sid);
  if (blocks && blocks.length) {
    entry.blocks = sideBuffer.length ? [...blocks, ...sideBuffer] : [...blocks];
    delete entry.text;
  } else if (sideBuffer.length) {
    const synth = text ? [{ type: 'text', text }] : [];
    entry.blocks = [...synth, ...sideBuffer];
    delete entry.text;
  } else {
    entry.text = text || '';
    delete entry.blocks;
  }
  if (meta) entry.meta = meta;
  s.lastUsed = Date.now();
  // Unregister the side-buffer ref now that the entry is finalized — late
  // /btw POSTs (after this point but before finalizeStream fires) will hit
  // the no-ref path in injectInlineBlock and fall back to insertBeforeLive.
  // finalizeStream also unregisters defensively; both calls are idempotent.
  try {
    const { unregisterLiveStream } = require('../chat/btw-queue');
    unregisterLiveStream(sid);
  } catch (_) {}
  // Flush bypasses the 500ms debounce so the persisted snapshot lands on
  // disk before finalizeStream emits `_end` to listeners. Without this the
  // FE could race the debounce timer when reading the persisted state right
  // after a stream completes (snapshot reconcile in chat-streaming.ts), or
  // a process crash within that 500ms window would lose the trailing tokens.
  persistence.flushSessionToDisk(sid);
}

// Inserts a non-streaming entry chronologically BEFORE the active live message.
// Used for #btw so the note slots into the right position when the chathistory
// is reloaded later (rather than dangling at the very bottom under the entire
// finalized assistant turn). Falls back to append if no live message is active.
function insertBeforeLive(sid, role, text) {
  if (persistence.isSessionDeleted(sid)) return;
  const s = getOrCreateDisplaySession(sid);
  const ts = Date.now();
  const entry: any = { role, ts, text: text || '' };
  // Find latest streaming entry
  let liveIdx = -1;
  for (let i = s.messages.length - 1; i >= 0; i--) {
    if (s.messages[i].streaming) { liveIdx = i; break; }
  }
  if (liveIdx < 0) s.messages.push(entry);
  else s.messages.splice(liveIdx, 0, entry);
  s.lastUsed = ts;
  const cap = _messageMaxCount();
  if (s.messages.length > cap) s.messages.splice(0, s.messages.length - cap);
  _promoteIfGhost(s);
  persistence.saveSessionToDisk(sid);
}

async function persistActiveModels() {
  try {
    config.defaults = config.defaults || {};
    if (activeModels.llm?.model) {
      config.defaults.model = activeModels.llm.model;
      config.defaults.llm_provider = activeModels.llm.provider || '';
    }
    if (activeModels.image?.model) {
      config.defaults.image_model = activeModels.image.model;
      config.defaults.image_provider = activeModels.image.provider || '';
    }
    if (activeModels.video?.model) {
      config.defaults.video_model = activeModels.video.model;
      config.defaults.video_provider = activeModels.video.provider || '';
    }
    if (activeModels.audio?.model) {
      config.defaults.audio_model = activeModels.audio.model;
      config.defaults.audio_provider = activeModels.audio.provider || '';
    }
    await saveConfig();
  } catch (e) {
    logger.warn('sessions.persist-active-models-failed', { error: e instanceof Error ? e.message : String(e) });
  }
}

module.exports = {
  // images
  ...images,
  // history
  ...history,
  // streams
  ...streams,
  // persistence
  ...persistence,
  // display layer (this file)
  defaultWorkingDir,
  getOrCreateDisplaySession,
  createBackgroundSession,
  getSessionCwd,
  pushDisplayMsg,
  startLiveMsg,
  updateLiveMsg,
  finalizeLiveMsg,
  insertBeforeLive,
  markLiveTokenDiscarded,
  pruneDiscardedTokensForSession,
  persistActiveModels,
};
