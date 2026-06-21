// ── Disk persistence, debounced writes, cleanup, deleted-session tracking ─────
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  claudeSessions,
  chatHistory,
  displaySessions,
  SESSIONS_DIR,
  SESSIONS_INDEX,
} = require('../core/state');
const logger = require('../core/logger');
const { _gcStaleStreams } = require('./streams');
const { emitSessionsDirty } = require('./events');

// ── SQLite write hooks (canonical store; Steps 4–6 complete) ──────────────────
// Session writes go to bridge/data/sessions.db only — the legacy JSON tree
// under bridge/sessions/ is no longer written. It survives read-only, solely
// for the boot-time migration safety check in server.ts. SQLite is canonical
// (see sessions-internal/db.ts). _dbMirrorSave is named for the old Step-3
// dual-write era; it is no longer a mirror but THE durable write. It no-ops
// only when the handle is closed, which in normal operation never happens —
// server.ts opens it unconditionally. Failures are logged; there is no second
// store to fall back to.
const _db = require('./db');

function _dbMirrorSave(s: any): void {
  if (!_db.isOpen()) return;
  try {
    _db.writeSessionFull(s);
  } catch (e) {
    logger.warn('sqlite.mirror-save-failed', {
      sid: s?.id,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

function _dbMirrorDelete(sid: string): void {
  if (!_db.isOpen()) return;
  try {
    _db.deleteSession(sid);
  } catch (e) {
    logger.warn('sqlite.mirror-delete-failed', {
      sid,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

function _dbMirrorClaudeSessions(): void {
  if (!_db.isOpen()) return;
  try {
    _db.replaceClaudeSessions(claudeSessions);
  } catch (e) {
    logger.warn('sqlite.mirror-claude-failed', {
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

// ── Session TTL and cleanup ────────────────────────────────────────────────────
const SESSION_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days default
const SESSION_CLEANUP_INTERVAL_MS = 1 * 60 * 60 * 1000; // every hour
// Mirrors LIVE_MSG_MAX_DURATION_MS in sessions-internal/index.ts. Duplicated
// here to avoid a circular require (index.ts already requires this module);
// keep both in sync if you change the ceiling.
const _LIVE_MSG_MAX_DURATION_MS = 60 * 60 * 1000;

function _isCodexLiveMsg(msg: any): boolean {
  const model = String(msg?.meta?.model || msg?.model || '').toLowerCase();
  const provider = String(msg?.meta?.provider || msg?.provider || '');
  return model.startsWith('codex/') ||
    provider === 'OpenAI Subscription' ||
    /^OpenAI-SUB/i.test(provider) ||
    String(msg?.harness || '').toLowerCase() === 'codex';
}

function _extractCodexRolloutText(file: string): { text: string; completed: boolean } | null {
  let raw = '';
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  let lastText = '';
  let completed = false;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let ev: any;
    try { ev = JSON.parse(line); } catch { continue; }
    const payload = ev && typeof ev.payload === 'object' ? ev.payload : null;
    if (payload?.type === 'task_complete') {
      completed = true;
      if (typeof payload.last_agent_message === 'string' && payload.last_agent_message.trim()) {
        lastText = payload.last_agent_message;
      }
      continue;
    }
    if (payload?.type === 'message' && payload.role === 'assistant' && Array.isArray(payload.content)) {
      const txt = payload.content.map((c: any) => typeof c?.text === 'string' ? c.text : '').join('');
      if (txt.trim()) lastText = txt;
      continue;
    }
    if (ev?.type === 'item.completed' && ev.item?.type === 'agent_message') {
      const txt = typeof ev.item.text === 'string'
        ? ev.item.text
        : Array.isArray(ev.item.content)
          ? ev.item.content.map((c: any) => typeof c?.text === 'string' ? c.text : '').join('')
          : '';
      if (txt.trim()) lastText = txt;
      continue;
    }
    if (typeof ev?.last_agent_message === 'string' && ev.last_agent_message.trim()) {
      lastText = ev.last_agent_message;
    }
  }
  return lastText.trim() ? { text: lastText, completed } : null;
}

function _walkCodexRollouts(root: string, out: Array<{ file: string; mtimeMs: number }>, minMs: number, maxMs: number, depth: number = 0): void {
  if (depth > 5) return;
  let entries: any[] = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) {
      _walkCodexRollouts(p, out, minMs, maxMs, depth + 1);
      continue;
    }
    if (!e.isFile() || !/^rollout-.*\.jsonl$/.test(e.name)) continue;
    try {
      const st = fs.statSync(p);
      if (st.mtimeMs >= minMs && st.mtimeMs <= maxMs) out.push({ file: p, mtimeMs: st.mtimeMs });
    } catch {}
  }
}

function _salvageCodexRolloutText(startMs: number | null, endMs: number = Date.now()): { text: string; file: string; completed: boolean } | null {
  const roots = new Set<string>();
  if (process.env.CODEX_HOME) roots.add(path.join(process.env.CODEX_HOME, 'sessions'));
  roots.add(path.join(os.homedir(), '.codex', 'sessions'));

  const minMs = (startMs || (endMs - _LIVE_MSG_MAX_DURATION_MS)) - 10 * 60 * 1000;
  const maxMs = endMs + 5 * 60 * 1000;
  const candidates: Array<{ file: string; mtimeMs: number }> = [];
  for (const root of roots) _walkCodexRollouts(root, candidates, minMs, maxMs);
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const c of candidates.slice(0, 30)) {
    const got = _extractCodexRolloutText(c.file);
    if (got?.text && got.completed) return { ...got, file: c.file };
  }
  for (const c of candidates.slice(0, 30)) {
    const got = _extractCodexRolloutText(c.file);
    if (got?.text) return { ...got, file: c.file };
  }
  return null;
}

function _normalizeAbandonedLiveMessages(session, interruptBlock?: any, force: boolean = false) {
  if (!Array.isArray(session?.messages)) return false;
  let changed = false;
  const now = Date.now();
  for (const msg of session.messages) {
    if (!msg?.streaming) continue;
    // Step 6: only normalize streaming rows whose live deadline has
    // already passed. Go-core finalize writes (Step 6) clear streaming
    // on the SQLite row directly — but the in-memory displaySessions Map
    // loaded from the DB at boot still reflects the pre-finalize state
    // for any turn that completed in the window between Go's write and
    // the bridge's next save. Within the 30 min grace period
    // (LIVE_MSG_MAX_DURATION_MS in sessions-internal/index.ts), assume
    // the row is either truly live in Go-core or about to be finalized.
    // Past the deadline, treat as genuinely abandoned.
    // `force` bypasses the deadline guard — used by explicit user stop,
    // where the caller already proved the subprocess is gone (or is
    // telling us to give up regardless).
    //
    // NOTE: codex is NOT special-cased here. Since Phase 7 codex runs as a
    // child of go-core (not the bridge) and survives a bridge-only restart,
    // exactly like grok/claude. go-core writes its finalize straight to the
    // shared SQLite (sqlite_finalize.go) and finalizes a wedged turn via its
    // own silence watchdog (codex/codex.go). So a `codex/` streaming row seen
    // at bridge boot may be genuinely live in go-core — the deadline guard
    // must protect it the same as any other go-core-backed turn. Finalizing it
    // early here would inject a false "Bridge restarted…" interrupt into a
    // turn that is still streaming.
    if (!force && typeof msg._liveDeadline === 'number' && msg._liveDeadline > now) {
      continue;
    }
    const partialBlocks = Array.isArray(msg.blocks) ? [...msg.blocks] : [];
    if (!partialBlocks.length && msg.text) partialBlocks.push({ type: 'text', content: msg.text });
    partialBlocks.push(interruptBlock || {
      type: 'interrupt',
      kind: 'server-restart',
      text: 'Bridge restarted before this reply could finish. Stream replay buffers are in-memory only, so this turn could not resume.',
      ts: now,
      postFinishGraceMs: 60_000,
    });
    msg.blocks = partialBlocks;
    delete msg.text;
    delete msg.streaming;
    delete msg._liveToken;
    delete msg._liveDeadline;
    delete msg._liveStartedPerfMs;
    changed = true;
  }
  return changed;
}

// Runtime sweep — finalizes any in-memory message whose _liveDeadline has
// passed. Called periodically; safe to call against the live displaySessions
// Map because we never touch messages whose deadline is still in the future.
// The synthetic interrupt block surfaces the wedge to the user instead of
// silently rewriting state. Returns the list of (sid, idx) that were swept
// so the caller can broadcast a synthetic _end on the matching stream.
function sweepExpiredLiveMsgs(now: number = Date.now()): Array<{ sid: string; idx: number }> {
  const swept: Array<{ sid: string; idx: number }> = [];
  const perfNow = performance.now();
  for (const [sid, s] of displaySessions) {
    if (!s || !Array.isArray(s.messages)) continue;
    for (let i = 0; i < s.messages.length; i++) {
      const msg = s.messages[i];
      if (!msg?.streaming) continue;
      // Prefer the monotonic clock for in-process entries: Date.now()-based
      // _liveDeadline is vulnerable to NTP adjustments and suspend/resume,
      // which can both delay and prematurely trigger expiry. _liveStartedPerfMs
      // is process-local (not persisted), so messages loaded from disk after
      // a restart legitimately lack it and fall back to wall-clock comparison.
      if (typeof msg._liveStartedPerfMs === 'number') {
        if (perfNow - msg._liveStartedPerfMs <= _LIVE_MSG_MAX_DURATION_MS) continue;
      } else {
        // Backfill deadline on entries that predate the field — at most one
        // sweep cycle of false negatives, never a runaway.
        if (typeof msg._liveDeadline !== 'number') continue;
        if (msg._liveDeadline > now) continue;
      }
      const partialBlocks = Array.isArray(msg.blocks) ? [...msg.blocks] : [];
      if (!partialBlocks.length && msg.text) {
        partialBlocks.push({ type: 'text', content: msg.text });
      }
      const elapsedMs = (typeof msg._liveStartedPerfMs === 'number')
        ? Math.round(perfNow - msg._liveStartedPerfMs)
        : (typeof msg._liveDeadline === 'number' ? (now - (msg._liveDeadline - _LIVE_MSG_MAX_DURATION_MS)) : null);
      let textLen = (msg.text ? String(msg.text).length : 0) + (Array.isArray(msg.blocks) ? msg.blocks.reduce((n, b) => n + (b && b.text ? String(b.text).length : 0) + (b && b.content ? String(b.content).length : 0), 0) : 0);
      let salvaged: { text: string; file: string; completed: boolean } | null = null;
      if (_isCodexLiveMsg(msg)) {
        const startMs = (typeof msg._liveDeadline === 'number')
          ? msg._liveDeadline - _LIVE_MSG_MAX_DURATION_MS
          : (elapsedMs ? now - elapsedMs : null);
        salvaged = _salvageCodexRolloutText(startMs, now);
        if (salvaged?.text && !textLen) {
          partialBlocks.push({
            type: 'text',
            content: salvaged.text,
            _salvagedFrom: 'codex-rollout',
          });
          textLen += salvaged.text.length;
          logger.warn('sessions.timeout.codex-rollout-salvaged', {
            sid,
            idx: i,
            file: salvaged.file,
            chars: salvaged.text.length,
            completed: salvaged.completed,
          });
        }
      }
      partialBlocks.push({
        type: 'interrupt',
        kind: 'timeout',
        text: salvaged?.text
          ? 'Stream exceeded its maximum duration without finalizing, but the completed Codex answer was recovered from the local rollout log.'
          : 'Stream exceeded its maximum duration without finalizing — closed automatically.',
        ts: now,
        elapsedMs: elapsedMs || undefined,
        partialLen: textLen || undefined,
        model: msg.meta && msg.meta.model ? String(msg.meta.model) : undefined,
        provider: msg.meta && msg.meta.provider ? String(msg.meta.provider) : undefined,
        salvagedFrom: salvaged?.file,
      });
      msg.blocks = partialBlocks;
      delete msg.text;
      delete msg.streaming;
      delete msg._liveToken;
      delete msg._liveDeadline;
      delete msg._liveStartedPerfMs;
      swept.push({ sid, idx: i });
    }
    if (swept.some((e) => e.sid === sid)) saveSessionToDisk(sid);
  }
  return swept;
}

// Runtime variant of _normalizeAbandonedLiveMessages: clears the streaming flag
// on any abandoned live placeholder for `sid` and appends a reason-tagged
// interrupt block. Used by POST /v1/stop so an explicit stop clears both the
// in-memory stream and the on-disk message half (without it, the message stays
// streaming=true on disk until the next bridge restart triggers the load-time
// normalize).
function finalizeAbandonedLiveMsgs(sid, reason: 'stopped' | 'aborted' = 'stopped', force: boolean = false): boolean {
  const s = displaySessions.get(sid);
  if (!s) return false;
  const block = reason === 'stopped'
    ? { type: 'interrupt', kind: 'stopped', text: 'Stream stopped by user.', ts: Date.now() }
    : { type: 'interrupt', kind: 'aborted', text: 'Stream aborted before finalize.', ts: Date.now() };
  const changed = _normalizeAbandonedLiveMessages(s, block, force);
  if (changed) saveSessionToDisk(sid);
  return changed;
}

function sessionFilePath(sid) {
  const safe = String(sid)
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 80);
  return path.join(SESSIONS_DIR, `${safe}.json`);
}

function validateSessionId(sid) {
  if (typeof sid !== 'string' || sid.length === 0) {
    return { ok: false, error: 'SessionId must be a non-empty string' };
  }
  if (sid.length > 128) {
    return { ok: false, error: 'SessionId exceeds maximum length of 128 characters' };
  }
  if (/[/\\]/.test(sid)) {
    return { ok: false, error: 'SessionId must not contain path separators' };
  }
  if (/\0/.test(sid)) {
    return { ok: false, error: 'SessionId must not contain null bytes' };
  }
  if (/[^a-zA-Z0-9_-]/.test(sid)) {
    return { ok: false, error: 'SessionId must contain only alphanumeric characters, dashes, and underscores' };
  }
  return { ok: true, sanitized: sid };
}

// Serialize index.json writes. Concurrent callers (promote, delete, cleanup,
// claude-session bookkeeping) used to fire parallel atomic temp+rename
// writes. The rename is atomic per-call but two callers reading
// `displaySessions` at different points could land last-write-wins —
// e.g. a delete that ran before a promotion's read could be overwritten by
// the promotion's later write. Chaining each call onto the previous one
// ensures every write observes the latest in-memory snapshot.
let _indexSaveChain: Promise<void> = Promise.resolve();

async function saveIndexToDisk(): Promise<void> {
  // Step 4: there is no longer an on-disk index file. The session list is
  // implicit in `SELECT id FROM sessions` and the claude-session mapping is
  // the `claude_sessions` table. The function is kept (same name, same
  // serialization point) so callers don't need to know about the storage
  // change. The promise-chain `_indexSaveChain` still serializes concurrent
  // callers so two writers can't race on the same DB transaction either.
  const next = _indexSaveChain.then(async () => {
    try {
      _dbMirrorClaudeSessions();
    } catch (e) {
      logger.warn('sessions.index-save-failed', { error: e instanceof Error ? e.message : String(e) });
    }
  });
  // Swallow the chain's rejection so a single failing write can't poison the
  // queue for subsequent callers. The actual await above still surfaces the
  // error to the immediate caller via `next`.
  _indexSaveChain = next.catch(() => {});
  return next;
}

// ── Debounced session writes ──────────────────────────────────────────────────
// Coalesces rapid saveSessionToDisk calls for the same session into one write.
const _saveTimers = new Map(); // sid → timer handle

async function saveSessionToDisk(sid) {
  // Debounce: cancel pending write for this session
  const existing = _saveTimers.get(sid);
  if (existing) clearTimeout(existing);

  return new Promise<void>((resolve) => {
    _saveTimers.set(
      sid,
      setTimeout(async () => {
        _saveTimers.delete(sid);
        try {
          const s = displaySessions.get(sid);
          if (!s) return resolve();
          // Ghost sessions live only in memory. The write helper short-circuits
          // on _inMemoryOnly so they never reach storage; the explicit check
          // here keeps the early return cheap and lets us skip the function
          // call entirely for the common ghost-PATCH case.
          if (s._inMemoryOnly) return resolve();
          _dbMirrorSave(s);
          // List metadata (message count, lastUsed/ordering, name, viewed)
          // may have changed — nudge SSE listeners to refetch. Coalesced to
          // the 500 ms debounce above; emit is fire-and-forget internally.
          emitSessionsDirty({ sid, reason: 'save' });
        } catch (e) {
          logger.warn('sessions.save-failed', { sid, error: e instanceof Error ? e.message : String(e) });
        }
        resolve();
      }, 500)
    ); // 500ms debounce
  });
}

// Force-flush a session write immediately (bypasses debounce)
async function flushSessionToDisk(sid) {
  const existing = _saveTimers.get(sid);
  if (existing) {
    clearTimeout(existing);
    _saveTimers.delete(sid);
  }
  try {
    const s = displaySessions.get(sid);
    if (!s) return;
    if (s._inMemoryOnly) return; // see saveSessionToDisk — same rationale
    _dbMirrorSave(s);
    emitSessionsDirty({ sid, reason: 'flush' });
  } catch (e) {
    logger.warn('sessions.save-failed', { sid, error: e instanceof Error ? e.message : String(e) });
  }
}

// Mid-stream live-message persistence. Writes ONLY the streaming row via a
// single-row UPDATE instead of the full O(messages) session rewrite that
// _dbMirrorSave performs. The live-checkpoint path (updateLiveMsg) runs every
// ~2 s per active stream for the whole length of a turn; on big sessions with
// several streams in parallel the full rewrite holds the shared-DB write lock
// long enough to wedge the event loop and time out go-core's persist
// callbacks. The delta keeps that path O(1).
//
// Falls back to the normal debounced full write when the row can't be targeted
// (placeholder not yet flushed, missing live_token) so content is never lost.
function saveLiveMsgDelta(sid, msg): void {
  if (!_db.isOpen()) return;
  let updated = false;
  try {
    updated = _db.updateLiveMessageRow(sid, msg);
  } catch (e) {
    logger.warn('sessions.live-delta-failed', { sid, error: e instanceof Error ? e.message : String(e) });
  }
  if (!updated) saveSessionToDisk(sid);
}

// Flush all pending debounced session writes immediately
async function flushAllPendingSaves() {
  const pending = [..._saveTimers.keys()];
  if (!pending.length) return;
  await Promise.all(pending.map((sid) => flushSessionToDisk(sid)));
}

async function deleteSessionFile(sid) {
  // Step 4: name kept for caller compatibility, but there is no per-session
  // file anymore — the DELETE on sessions cascades to messages and
  // claude_sessions. The historical .json file (if any) in bridge/sessions/
  // is now archive-only and intentionally left in place.
  try {
    _dbMirrorDelete(sid);
    emitSessionsDirty({ sid, reason: 'delete' });
  } catch (e) {
    logger.warn('sessions.delete-failed', { sid, error: e instanceof Error ? e.message : String(e) });
  }
}

function saveSessionsToDisk() {
  // Legacy alias — saves index only; per-session files are written individually
  saveIndexToDisk();
}

function loadSessionsFromDisk() {
  // Step 4: read from SQLite instead of walking bridge/sessions/*.json.
  // Same shape comes out — the rest of the bridge (which iterates
  // displaySessions, reads session.messages[], etc.) is unchanged.
  // Boot safety: the bridge refuses to start in server.ts before reaching
  // this function if the DB is missing/empty while JSON files exist, so by
  // the time we get here the DB is authoritative.
  try {
    if (!_db.isOpen()) {
      // Defensive: server.ts should always have openDB()'d by now. If we
      // ever land here, log and leave displaySessions empty — the in-memory
      // Map will populate as sessions are touched.
      logger.warn('sessions.load-skipped-db-closed');
      return;
    }
    // claudeSessions Map first, so any per-session bookkeeping that reads it
    // during load sees the current state.
    const claude = _db.loadClaudeSessions();
    for (const [k, v] of claude.entries()) claudeSessions.set(k, v);

    const sessions = _db.loadAllSessions();
    let normalizedCount = 0;
    for (const [sid, s] of sessions.entries()) {
      // Backfills retained for parity with the legacy JSON loader. Newly
      // written sessions always have viewedAt + _nameSource; these touch
      // only rows that predate those fields.
      if (!s.viewedAt) s.viewedAt = s.createdAt || 0;
      if (!s._nameSource) s._nameSource = 'auto';
      const normalized = _normalizeAbandonedLiveMessages(s);
      displaySessions.set(sid, s);
      if (normalized) {
        normalizedCount++;
        // Mirror the in-memory normalization back to the DB so the next
        // boot sees a clean row. Same semantic as the legacy
        // `writeJsonSync(fp, s)` call.
        _dbMirrorSave(s);
      }
    }
    logger.info('sessions.loaded', { count: displaySessions.size, normalized: normalizedCount });
  } catch (e) {
    logger.warn('sessions.load-failed', { error: e instanceof Error ? e.message : String(e) });
  }
}

function clearHistory(sid) {
  chatHistory.delete(sid);
  claudeSessions.delete(sid);
  saveIndexToDisk();
}

// ── Deleted-session tracking ──────────────────────────────────────────────────
// Session IDs that were explicitly deleted — pushDisplayMsg checks this to avoid
// recreating a session that is still receiving stream chunks at the time of deletion.
// Periodically GC'd in startSessionCleanupInterval.
const _deletedSessions = new Map(); // sid → deleteTimestamp

function isSessionDeleted(sid) {
  return _deletedSessions.has(sid);
}

function markSessionDeleted(sid) {
  _deletedSessions.set(sid, Date.now());
  // Cancel any pending debounced save for the deleted session
  const timer = _saveTimers.get(sid);
  if (timer) {
    clearTimeout(timer);
    _saveTimers.delete(sid);
  }
}

function _gcDeletedSessions() {
  const cutoff = Date.now() - 5 * 60 * 1000; // 5 min retention
  for (const [sid, ts] of _deletedSessions) {
    if (ts < cutoff) _deletedSessions.delete(sid);
  }
}

// In-memory ghost sessions (created by getOrCreateDisplaySession but never
// promoted by a real message) accumulate in displaySessions across the day —
// every "+ New Session same dir" PATCH leaves one behind if the user never
// types. Drop ghosts older than 24 h so RAM doesn't grow unbounded for users
// who open and abandon many empty chats. The 24 h window is generous enough
// that a session left open in a tab for the workday still survives.
const _GHOST_TTL_MS = 24 * 60 * 60 * 1000;

function _gcStaleGhosts() {
  const cutoff = Date.now() - _GHOST_TTL_MS;
  let removed = 0;
  for (const [sid, s] of displaySessions) {
    if (!s || !s._inMemoryOnly) continue;
    if ((s.createdAt || 0) >= cutoff) continue;
    displaySessions.delete(sid);
    chatHistory.delete(sid);
    claudeSessions.delete(sid);
    removed++;
  }
  if (removed > 0) logger.info('sessions.ghost-cleanup', { removed });
}

// ── Periodic cleanup ──────────────────────────────────────────────────────────
async function deleteOldSessions() {
  let removed = 0;
  const cutoff = Date.now() - SESSION_MAX_AGE_MS;
  for (const [sid, session] of displaySessions) {
    if ((session.lastUsed || 0) < cutoff) {
      await deleteSessionFile(sid);
      displaySessions.delete(sid);
      chatHistory.delete(sid);
      claudeSessions.delete(sid);
      removed++;
    }
  }
  if (removed > 0) {
    saveIndexToDisk();
    logger.info('sessions.cleanup', { removed });
  }
}

async function deleteOrphanedSessionFiles() {
  // Step 4: the JSON tree is archive-only after the canonicity flip. The
  // legacy job here was "walk bridge/sessions/*.json, unlink anything older
  // than SESSION_MAX_AGE_MS, rewrite index.json." None of that applies now —
  // `deleteOldSessions` already prunes the DB on the same cutoff, and the
  // archive directory is intentionally not auto-pruned (operators rotate it
  // explicitly per the plan's Step 5 / backup notes).
  //
  // Kept as a no-op so the periodic cleanup chain in
  // startSessionCleanupInterval and any future callers can still invoke it
  // unconditionally.
}

function startSessionCleanupInterval() {
  const cleanup = async () => {
    await deleteOldSessions();
    await deleteOrphanedSessionFiles();
    _gcDeletedSessions();
    _gcStaleStreams();
    _gcStaleGhosts();
  };
  cleanup();
  setInterval(cleanup, SESSION_CLEANUP_INTERVAL_MS);

  // Live-msg deadline sweep. Decoupled from the hourly cleanup because the
  // LIVE_MSG_MAX_DURATION_MS ceiling is shorter than that interval. When an
  // expired message is swept we also finalize the matching activeStream
  // (broadcasts `_end` error to any attached SSE listener) and proactively
  // POST /v1/stop to Go-core so the adapter/Run goroutine (and any in-flight
  // model call or tool) is cancelled promptly instead of leaking until the
  // 1h zombie GC or natural end. The in-mem + on-disk message already got
  // the kind=timeout interrupt + streaming cleared by sweepExpiredLiveMsgs.
  setInterval(() => {
    let swept: Array<{ sid: string; idx: number }>;
    try { swept = sweepExpiredLiveMsgs(); } catch (e) {
      logger.warn('sessions.live-msg-sweep.error', { error: e instanceof Error ? e.message : String(e) });
      return;
    }
    if (!swept.length) return;
    const sids = [...new Set(swept.map((e) => e.sid))];
    logger.warn('sessions.live-msg-sweep', { sweptCount: swept.length, sids });
    try {
      const streams = require('./streams');
      const { activeStreams } = require('../core/state');
      const goCore = process.env.YHA_GO_CORE_URL || 'http://127.0.0.1:8443';
      for (const sid of sids) {
        const stream = activeStreams.get(sid);
        if (stream && stream.status === 'streaming') {
          streams.finalizeStream(sid, 'error', { error: 'live-msg-deadline-exceeded' });
        }
        // Also abort the Go-side work (model loop / harness / tools).
        fetch(`${goCore}/v1/stop/${encodeURIComponent(sid)}`, { method: 'POST' }).catch(() => {});
      }
    } catch (e) {
      logger.warn('sessions.live-msg-sweep.finalize-failed', { error: e instanceof Error ? e.message : String(e) });
    }
  }, 5 * 60 * 1000);
}

module.exports = {
  sessionFilePath,
  validateSessionId,
  saveIndexToDisk,
  saveSessionToDisk,
  flushSessionToDisk,
  saveLiveMsgDelta,
  flushAllPendingSaves,
  deleteSessionFile,
  saveSessionsToDisk,
  loadSessionsFromDisk,
  clearHistory,
  isSessionDeleted,
  markSessionDeleted,
  deleteOldSessions,
  deleteOrphanedSessionFiles,
  startSessionCleanupInterval,
  finalizeAbandonedLiveMsgs,
  sweepExpiredLiveMsgs,
};
