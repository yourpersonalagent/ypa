// ── Session, upload, and participant routes ───────────────────────────────────
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const logger = require('../core/logger');
const {
  fetchGoActiveSet,
  wasActiveRecently,
  goActiveSnapshotIsAuthoritative,
} = require('../core/go-active-streams');

const {
  displaySessions,
  activeProcesses,
  activeStreams,
  chatHistory,
  claudeSessions,
  UPLOADS_DIR,
} = require('../core/state');
const {
  defaultWorkingDir,
  getOrCreateDisplaySession,
  pushDisplayMsg,
  rebuildSessionChatHistory,
  saveSessionToDisk,
  deleteSessionFile,
  markSessionDeleted,
  saveIndexToDisk,
  finalizeStream,
  insertBeforeLive,
  broadcastChunk,
  markLiveTokenDiscarded,
  pruneDiscardedTokensForSession,
  finalizeAbandonedLiveMsgs,
} = require('../sessions-internal');
// Session-list change bus — leaf module, required directly (not via the barrel)
// so there's no import cycle. See sessions-internal/events.ts.
const { sessionsEvents } = require('../sessions-internal/events');

const _GO_CORE_URL = process.env.YHA_GO_CORE_URL || 'http://127.0.0.1:8443';

// Short response cache for /v1/sessions/ to absorb thundering-herd bursts
// (SessionPoller 10 s ticks + switchTo + picker open + streamsKey effects
// often fire within the same 100-300 ms window when N lives are running).
// goActive inside already has its own 500 ms cache; this caches the final
// built list payload so we skip the displaySessions iteration + object
// construction + sort under concurrent live pressure. 400 ms is long enough
// for bursts, short enough that a real external change (another tab rename)
// is still seen promptly.
let _listCache: { json: string; at: number } | null = null;
const LIST_CACHE_MS = 400;

function _getCachedList(): string | null {
  if (_listCache && Date.now() - _listCache.at < LIST_CACHE_MS) return _listCache.json;
  return null;
}
function _setListCache(json: string) {
  _listCache = { json, at: Date.now() };
}

// Phase-6: switched personnel + observability-plus call-sites from
// hard `require('../modules/...')` imports to `getModuleApi(...)` lookups
// so each module can be cleanly disabled in modules.json without a
// require() blowup. _getEmployee wraps the personnel lookup so in-file
// callers stay short; observability-plus is looked up at request time
// inside each route handler that needs DEBUG_REGISTRY / SUBCOMMAND_LIST
// / recordFrontendSnapshot (so a disabled module yields a clear 501 or a
// silent skip for non-critical paths).
const { getModuleApi } = require('../core/modules');
function _getEmployee(id: string) {
  const personnel = getModuleApi<any>('multichat-personnel');
  return personnel?.getEmployee?.(id) ?? null;
}
const { enqueueBtw, peekBtw, injectBtwBlock, injectInlineBlock, tryLiveStdinInject } = require('../chat/btw-queue');
const { buildChathistoryDebug } = require('../providers/special');

const ALLOWED_UPLOAD_EXTS = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.gif', 'image/gif'],
  ['.webp', 'image/webp'],
  ['.bmp', 'image/bmp'],
  ['.avif', 'image/avif'],
  ['.svg', 'image/svg+xml'],
]);

const IMAGE_MAGIC_BYTES = [
  { sig: [0xFF, 0xD8, 0xFF],              name: 'JPEG' },
  { sig: [0x89, 0x50, 0x4E, 0x47],        name: 'PNG' },
  { sig: [0x47, 0x49, 0x46, 0x38],        name: 'GIF' },
  { sig: [0x42, 0x4D],                     name: 'BMP' },
  { sig: [0x52, 0x49, 0x46, 0x46],        name: 'WebP' },
];

const TEXT_IMAGE_SIGNATURES = ['<svg', '<?xml', '<!DOCTYPE'];

function getImageMagicBytes(buffer) {
  if (!buffer || buffer.length < 2) return null;
  for (const entry of IMAGE_MAGIC_BYTES) {
    if (buffer.length < entry.sig.length) continue;
    let match = true;
    for (let i = 0; i < entry.sig.length; i++) {
      if (buffer[i] !== entry.sig[i]) { match = false; break; }
    }
    if (!match) continue;
    if (entry.name === 'WebP') {
      if (buffer.length >= 12 &&
          buffer[8] === 0x57 && buffer[9] === 0x45 &&
          buffer[10] === 0x42 && buffer[11] === 0x50) {
        return 'image/webp';
      }
      continue;
    }
    switch (entry.name) {
      case 'JPEG': return 'image/jpeg';
      case 'PNG':  return 'image/png';
      case 'GIF':  return 'image/gif';
      case 'BMP':  return 'image/bmp';
    }
  }
  // Text-based SVG detection in first 512 bytes
  const prefix = buffer.slice(0, Math.min(buffer.length, 512)).toString('utf8').toLowerCase().trimStart();
  for (const sig of TEXT_IMAGE_SIGNATURES) {
    if (prefix.startsWith(sig.toLowerCase())) return 'image/svg+xml';
  }
  return null;
}

// ── Session-list change feed: server→client push ──────────────────────────────
// The bridge persists a message / rename / delete / viewed PATCH → sessions-
// internal emits 'dirty' → we fan a coalesced nudge out to every connected web
// client over SSE. Clients respond by re-pulling /v1/sessions/ (the "confirm"
// half of the contract). No session content crosses this channel — only the
// hint that the list changed.
const _dirtyClients = new Set<any>();
let _dirtySids = new Set<string>();
let _dirtyCoalesce: ReturnType<typeof setTimeout> | null = null;

function _flushDirty() {
  _dirtyCoalesce = null;
  if (_dirtyClients.size === 0) { _dirtySids.clear(); return; }
  const sids = [..._dirtySids];
  _dirtySids.clear();
  const frame = `data: ${JSON.stringify({ type: 'dirty', sids })}\n\n`;
  for (const res of _dirtyClients) {
    try { res.write(frame); } catch (_) { /* the socket's own 'close' removes it */ }
  }
}

// Attached once at module load (the require cache makes this a singleton).
// Coalesces a burst — many sessions, rapid PATCHes — into one frame per ~200 ms
// so the wire stays quiet and clients refetch at most ~5×/s under heavy load.
sessionsEvents.on('dirty', (payload: any) => {
  if (payload && payload.sid) _dirtySids.add(String(payload.sid));
  if (!_dirtyCoalesce) _dirtyCoalesce = setTimeout(_flushDirty, 200);
});

function registerSessionRoutes(app) {
  app.get('/v1/sessions/', async (req, res) => {
    // Fast path under live pressure: serve a recent snapshot so that
    // concurrent polls (poller + switch + picker) don't each re-walk the
    // entire displaySessions map and re-fetch goActive. See _listCache above.
    const cached = _getCachedList();
    if (cached) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.send(cached);
      return;
    }

    // Go-side active streams snapshot. Phase 7 moved /v1/stream-direct/
    // ownership to Go, so its in-process activeStreams Map is the
    // authoritative source for "this session is currently being
    // generated" — Node's own activeStreams Map is empty for every
    // Go-owned turn. Without this hop the FE picker shows "not
    // running" for any session that was streaming on Go when the user
    // switched away, even though Go is still emitting chunks.
    const goActive = await fetchGoActiveSet();
    const goSnapshotAuthoritative = goActiveSnapshotIsAuthoritative();
    const sessions = [];
    for (const [, data] of displaySessions) {
      // Hide ghost sessions (created by getOrCreateDisplaySession but never
      // promoted by a real message) from the picker. The frontend keeps the
      // *current* ghost in its local _cache so the active session is still
      // visible to the user as "New session" until they type something.
      if (data._inMemoryOnly) continue;
      const stream = activeStreams.get(data.id);
      // wasActiveRecently masks brief drops in Go's active-stream set
      // (slow/timed-out /internal/active-streams fetches, turn-boundary
      // gaps, GC pauses) so the picker dot stops flickering mid-stream.
      // See bridge/core/go-active-streams.ts for the hysteresis window.
      const isRunning = stream?.status === 'streaming' || goActive.has(data.id) || wasActiveRecently(data.id);
      if (!isRunning && goSnapshotAuthoritative && data.messages?.some((m: any) =>
        m?.streaming && Date.now() - Number(m.ts || 0) > 30_000)) {
        // A successful Go snapshot says this session has no active stream,
        // and Node has none either. Clear restart/crash leftovers now instead
        // of leaving message.streaming=true until the one-hour live deadline.
        finalizeAbandonedLiveMsgs(data.id, 'aborted', true);
      }
      sessions.push({
        id: data.id,
        name: data.name,
        messageCount: data.messages?.length ?? 0,
        createdAt: data.createdAt,
        lastUsed: data.lastUsed,
        viewedAt: data.viewedAt || data.createdAt || 0,
        participants: data.participants || [],
        groupMode: data.groupMode || 'sequential',
        boundWorkflowName: data.boundWorkflowName || null,
        workingDir: data.workingDir || os.homedir(),
        isRunning,
        runningSince: isRunning ? (stream?._startedAt ?? null) : null,
        // Whether this session is pinned as a "todo" in the picker. Stored on
        // the session object so it syncs across browsers/devices instead of
        // living in per-browser localStorage (yha.sessionTodos legacy key).
        isTodo: data.isTodo === true,
        multichatGroupId: data.multichatGroupId || null,
      });
    }
    sessions.sort((a, b) => b.lastUsed - a.lastUsed);
    const payload = { success: true, sessions, defaultWorkingDir: defaultWorkingDir(), hostname: os.hostname() };
    const json = JSON.stringify(payload);
    _setListCache(json);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.send(json);
  });

  // Must be registered before /:id so Express doesn't treat "notes" as an id param.
  // Returns every message with role === 'note' across all sessions, optionally
  // filtered by query. Replaces the old client-side scan that walked
  // session.messages in the frontend store — now that the session list ships
  // metadata only, the store has no message bodies to scan.
  app.get('/v1/sessions/notes', (req, res) => {
    const q = String(req.query.q || '').toLowerCase().trim();
    const hits = [];
    for (const [, data] of displaySessions) {
      const msgs = data.messages || [];
      for (let idx = 0; idx < msgs.length; idx++) {
        const m = msgs[idx];
        if (m.role !== 'note') continue;
        let text = '';
        if (typeof m.text === 'string' && m.text) {
          text = m.text;
        } else if (Array.isArray(m.blocks)) {
          text = m.blocks
            .filter((b) => b.type === 'text')
            .map((b) => b.content || '')
            .join('\n')
            .trim();
        }
        if (!text) continue;
        if (q && !text.toLowerCase().includes(q) && !data.name.toLowerCase().includes(q)) continue;
        hits.push({
          text,
          ts: m.ts ?? data.lastUsed ?? data.createdAt ?? 0,
          mid: m._mid,
          sessionId: String(data.id),
          sessionName: data.name || String(data.id),
          msgIdx: idx,
        });
      }
    }
    hits.sort((a, b) => b.ts - a.ts);
    res.json({ success: true, notes: hits });
  });

  // Must be registered before /:id so Express doesn't treat "search" as an id param
  app.get('/v1/sessions/search', (req, res) => {
    const q = String(req.query.q || '').toLowerCase().trim();
    if (!q) return res.json({ success: true, sessions: [] });
    const results = [];
    for (const [, data] of displaySessions) {
      const nameMatch = data.name.toLowerCase().includes(q);
      let snippet = null;
      if (!nameMatch) {
        for (const msg of data.messages ?? []) {
          const parts = [];
          if (msg.text) parts.push(typeof msg.text === 'string' ? msg.text : JSON.stringify(msg.text));
          if (msg.reasoning) parts.push(msg.reasoning);
          for (const b of msg.blocks ?? []) {
            if (b.content) parts.push(b.content);
            if (b.text) parts.push(b.text);
          }
          const text = parts.join(' ');
          const idx = text.toLowerCase().indexOf(q);
          if (idx !== -1) {
            const start = Math.max(0, idx - 60);
            const end = Math.min(text.length, idx + q.length + 60);
            snippet = text.slice(start, end);
            break;
          }
        }
      }
      if (nameMatch || snippet !== null) {
        results.push({ id: data.id, name: data.name, lastUsed: data.lastUsed, snippet });
      }
    }
    results.sort((a, b) => b.lastUsed - a.lastUsed);
    res.json({ success: true, sessions: results });
  });

  // Must be registered before /:id so Express doesn't treat "events" as an id
  // param. SSE feed of session-list changes — see the _dirty* bus above.
  // Auth-gated like every other /v1/ route (authMiddleware); EventSource carries
  // the same-origin session cookie, so no header handling is needed here.
  app.get('/v1/sessions/events', (req, res) => {
    res.statusCode = 200;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    // Defeat proxy buffering (nginx etc.) so frames flush immediately.
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders?.();
    // First byte now — some proxies buffer a response until they see one, which
    // would delay EventSource's open event.
    res.write(': connected\n\n');
    _dirtyClients.add(res);
    // Keep-alive comment so idle intermediaries don't reap the socket; a throw
    // here means the peer is gone and the 'close' handler cleans up.
    const hb = setInterval(() => {
      try { res.write(': hb\n\n'); } catch (_) { /* cleaned up on close */ }
    }, 25_000);
    req.on('close', () => {
      clearInterval(hb);
      _dirtyClients.delete(res);
    });
  });

  app.get('/v1/sessions/:id', async (req, res) => {
    const sid = req.params.id;
    const data = displaySessions.get(sid);
    if (!data) return res.status(404).json({ success: false, error: 'Session not found' });
    const stream = activeStreams.get(data.id);
    // Same Go-side enrichment as the list endpoint — see /v1/sessions/
    // handler above. Single-session lookup is cheaper but still uses
    // the same TTL cache.
    const goActive = await fetchGoActiveSet();
    const isRunning = stream?.status === 'streaming' || goActive.has(data.id) || wasActiveRecently(data.id);
    res.json({
      success: true,
      session: {
        id: data.id,
        name: data.name,
        messages: data.messages,
        messageCount: data.messages?.length ?? 0,
        createdAt: data.createdAt,
        lastUsed: data.lastUsed,
        viewedAt: data.viewedAt || data.createdAt || 0,
        participants: data.participants || [],
        groupMode: data.groupMode || 'sequential',
        boundWorkflowName: data.boundWorkflowName || null,
        workingDir: data.workingDir || os.homedir(),
        isRunning,
        runningSince: isRunning ? (stream?._startedAt ?? null) : null,
        isTodo: data.isTodo === true,
        multichatGroupId: data.multichatGroupId || null,
      },
    });
  });

  app.post('/v1/uploads/', async (req, res) => {
    const { sessionId, name, data } = req.body;
    if (!sessionId || !name || !data) {
      return res.status(400).json({ success: false, error: 'Missing fields' });
    }

    const safeSid = String(sessionId)
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 80);
    const safeName = path
      .basename(name)
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(0, 200);
    const ext = path.extname(safeName).toLowerCase();

    if (!ALLOWED_UPLOAD_EXTS.has(ext)) {
      return res
        .status(400)
        .json({
          success: false,
          error: `File type "${ext}" not allowed. Only images: ${[...ALLOWED_UPLOAD_EXTS.keys()].join(', ')}`,
        });
    }

    const b64 = data.replace(/^data:[^;]+;base64,/, '');
    const fileBuf = Buffer.from(b64, 'base64');
    const detectedMime = getImageMagicBytes(fileBuf);
    if (!detectedMime) {
      return res.status(400).json({ success: false, error: 'File content does not match a supported image format' });
    }
    if (detectedMime !== ALLOWED_UPLOAD_EXTS.get(ext)) {
      return res.status(400).json({ success: false, error: `File extension ".${ext}" does not match content type (${detectedMime})` });
    }

    const sessionDir = path.resolve(UPLOADS_DIR, safeSid);
    if (!sessionDir.startsWith(path.resolve(UPLOADS_DIR))) {
      return res.status(400).json({ success: false, error: 'Invalid sessionId' });
    }

    const filePath = path.join(sessionDir, safeName);
    if (!filePath.startsWith(sessionDir)) {
      return res.status(400).json({ success: false, error: 'Invalid filename' });
    }

    try {
      await fs.promises.mkdir(sessionDir, { recursive: true });
      await fs.promises.writeFile(filePath, fileBuf);
      res.json({ success: true, url: `/uploads/${safeSid}/${safeName}` });
    } catch (e) {
      logger.error('upload.write-failed', { error: e instanceof Error ? e.message : String(e) });
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.delete('/v1/sessions/:id', (req, res) => {
    const sid = req.params.id;
    const existing = displaySessions.get(sid);
    if (existing?.standard)
      return res.status(403).json({ success: false, error: 'Cannot delete standard session' });
    markSessionDeleted(sid);
    const proc = activeProcesses.get(sid);
    if (proc?.killFn) {
      try {
        proc.killFn();
      } catch (_) {}
    }
    activeProcesses.delete(sid);
    // Forward to Go's own /v1/stop too — Phase 7 Go-owned streams aren't in
    // the Node activeProcesses map, so the local kill above is a no-op for
    // them and the claude-binary subprocess keeps running (and spending
    // tokens) until natural completion, writing to a session that no longer
    // exists on disk. Fire-and-forget; Go's handler is idempotent. Mirrors
    // the existing forward at line 551.
    fetch(`${_GO_CORE_URL}/v1/stop/${encodeURIComponent(sid)}`, { method: 'POST' }).catch(() => {});
    finalizeStream(sid, 'done', {});
    displaySessions.delete(sid);
    chatHistory.delete(sid);
    claudeSessions.delete(sid);
    try { pruneDiscardedTokensForSession(sid); } catch (_) {}
    deleteSessionFile(sid);
    const safeSid = String(sid)
      .replace(/[^a-zA-Z0-9_-]/g, '_')
      .slice(0, 80);
    const sessionUploadsDir = path.join(UPLOADS_DIR, safeSid);
    try {
      fs.rmSync(sessionUploadsDir, { recursive: true, force: true });
    } catch (_) {}
    saveIndexToDisk();
    res.json({ success: true });
  });

  app.patch('/v1/sessions/:id', (req, res) => {
    const sid = req.params.id;
    const { name, workingDir, viewed, boundWorkflowName, isTodo, multichatGroupId } = req.body;
    if (
      !displaySessions.has(sid) &&
      viewed &&
      name === undefined &&
      workingDir === undefined &&
      boundWorkflowName === undefined &&
      isTodo === undefined &&
      multichatGroupId === undefined
    ) {
      return res.json({ success: true });
    }
    const session = getOrCreateDisplaySession(sid);
    if (name) {
      session.name = String(name).slice(0, 60);
      // Mark as user-renamed so the AI title worker never overwrites it.
      session._nameSource = 'user';
    }
    if (viewed) session.viewedAt = Math.max(Date.now(), session.lastUsed || 0);
    if (boundWorkflowName !== undefined) session.boundWorkflowName = boundWorkflowName || null;
    // Picker "todo" pin — server-side so it syncs across browsers/devices.
    // Persisted in the per-session JSON file via saveSessionToDisk below.
    if (isTodo !== undefined) session.isTodo = !!isTodo;
    // null/empty string clears the tag; non-empty string sets it. Used by the
    // multichat overlay so explicit ✕ exit can drop the host-session tag and
    // turn the session back into a normal chat for future visits.
    if (multichatGroupId !== undefined) {
      session.multichatGroupId = multichatGroupId ? String(multichatGroupId) : null;
    }
    if (workingDir !== undefined) {
      if (!workingDir) {
        session.workingDir = defaultWorkingDir();
      } else {
        const absPath = path.resolve(String(workingDir));
        try {
          const stat = fs.statSync(absPath);
          if (!stat.isDirectory())
            return res.status(400).json({ success: false, error: 'Not a directory' });
          session.workingDir = absPath;
        } catch (e) {
          return res.status(400).json({ success: false, error: e.message });
        }
      }
    }
    saveSessionToDisk(sid);
    res.json({
      success: true,
      workingDir: session.workingDir,
      name: session.name,
      isTodo: session.isTodo === true,
    });
  });

  // ── #btw mid-response queue ─────────────────────────────────────────────
  // Plan: while a stream is active, frontend POSTs `#btw <text>` here. The
  // queue is drained by the tool-loop in tools/stream.ts at each
  // tool-result boundary and prepended as a synthetic user message before
  // the next API roundtrip. See server-btw-queue.ts for limitations.
  app.post('/v1/sessions/:id/btw', (req, res) => {
    const sid = req.params.id;
    const text = String(req.body?.text || '').trim();
    if (!text) return res.status(400).json({ success: false, error: 'text required' });
    // Forward to Go too — Phase 7 Go-owned tool loops drain Go's btw queue,
    // not Node's, so without this the `#btw` bubble appears in the UI (from
    // Node's `injectBtwBlock` when Node owns the stream) but the model never
    // sees the text on a Go-owned turn. Go's handler is self-contained: it
    // tries its own live-stdin sink, falls back to its queue, emits the
    // `btwBlock` chunk into the live SSE stream, and persists a fallback
    // note when no emit sink is registered. Fire-and-forget; mirrors the
    // forward at line 551 above.
    fetch(`${_GO_CORE_URL}/v1/sessions/${encodeURIComponent(sid)}/btw`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    }).catch(() => {});
    // Harness path (claude-binary stream-json) registers a live stdin sink
    // when its spawn is mid-turn. If present, splice the JSONL user message
    // straight into the running process — no queue, no next-turn wait. If
    // the sink rejects (stdin closed, race with `result`), fall back to the
    // queue so the next turn picks it up.
    const liveStdin = tryLiveStdinInject(sid, text);
    if (!liveStdin) enqueueBtw(sid, text);
    // Inline-inject the `btw` block into the active stream's blocks regardless,
    // so the UI shows it in chronological position alongside tool calls.
    // Pass `liveStdin` so the badge reflects actual delivery: harness routes
    // that took the live stdin path are tagged 'direct' (live this turn).
    const activeStream = activeStreams.get(sid);
    const injected = injectBtwBlock(sid, text, broadcastChunk, activeStream?.routeType, liveStdin);
    // Gate the persist-fallback on Node actually owning the stream — for
    // Go-owned streams Go runs its own equivalent fallback, so doing it
    // here too would double-persist the same `#btw` note to disk.
    if (!injected && activeStream?.status === 'streaming') {
      try { insertBeforeLive(sid, 'note', `#btw ${text}`); rebuildSessionChatHistory(sid); } catch (_) {}
    }
    res.json({ success: true, queued: peekBtw(sid).length, injected, liveStdin });
  });

  app.get('/v1/sessions/:id/btw', (req, res) => {
    res.json({ success: true, items: peekBtw(req.params.id) });
  });

  // Answer a pending AskUser question. The bridge virtual tool
  // mcp__MCP-Tools__bridge__AskUser broadcast an `askUserQuestion` chunk and
  // is awaiting this resolver. Body: { questionId, answers: AnswerEntry[] }
  // where each AnswerEntry is { questionIndex, selected: string[], notes? }.
  // We format a human-readable summary string and resolve the Promise — the
  // tool handler returns it as the MCP tool_result content.
  app.post('/v1/sessions/:id/answer-question', (req, res) => {
    const sid = req.params.id;
    const body = (req.body as any) || {};
    const questionId = String(body.questionId || '').trim();
    if (!questionId) return res.status(400).json({ success: false, error: 'questionId required' });
    const answers = Array.isArray(body.answers) ? body.answers : null;
    if (!answers) return res.status(400).json({ success: false, error: 'answers array required' });
    const { answerQuestion, peekQuestion } = require('../chat/ask-user');
    const peek = peekQuestion(questionId);
    if (!peek) return res.status(404).json({ success: false, error: 'question not pending (already answered or expired)' });
    if (peek.sessionId !== sid) return res.status(403).json({ success: false, error: 'question belongs to a different session' });
    // Format: one block per question with header, selected labels, optional notes.
    const lines: string[] = [];
    for (const a of answers) {
      const idx = Number(a?.questionIndex);
      const q = peek.questions[idx];
      if (!q) continue;
      const sel = Array.isArray(a.selected) ? a.selected.filter((s: any) => typeof s === 'string') : [];
      lines.push(`Q (${q.header || 'question'}): ${q.question || ''}`);
      lines.push(`A: ${sel.length ? sel.join(', ') : '(no selection)'}`);
      const notes = String(a.notes || '').trim();
      if (notes) lines.push(`Notes: ${notes}`);
      lines.push('');
    }
    const summary = lines.join('\n').trim() || '(empty answer)';
    const ok = answerQuestion(questionId, sid, summary);
    if (!ok) return res.status(409).json({ success: false, error: 'failed to resolve (raced with timeout?)' });
    // Flip the bridge-side persisted block to answered state. The live stream
    // is still streaming at this point (the MCP tool is awaiting our resolve
    // → binary is awaiting MCP), so we mutate the live stream's blocks and
    // force a snapshot persist. Without this the persisted message keeps
    // `answered:false` and a session-switch reload renders the empty form
    // (or shows nothing, depending on whether handleChunk got the question
    // chunk in the first place). The frontend chunk handler also mutates
    // its own local copy — this is the matching server-side mutation.
    try {
      const { getLiveStreamRef } = require('../chat/btw-queue');
      const ref = getLiveStreamRef(sid);
      if (ref) {
        for (const b of ref.blocks) {
          if (b.type === 'ask-user-question' && b.questionId === questionId) {
            b.answered = true;
            b.answerSummary = summary;
            break;
          }
        }
        try { ref.persistSnapshot(); } catch (_) { /* tolerate persist hiccups */ }
      }
    } catch (_) { /* btw-queue unavailable — frontend still flips its view */ }
    // Echo the summary back over the SSE stream so other client tabs see the
    // answered state immediately (the tool_result will follow when the model
    // finishes its next turn).
    broadcastChunk(sid, { askUserQuestionAnswered: { id: questionId, summary } });
    res.json({ success: true });
  });

  // Complete a Frontend tool request that was delivered to this session's
  // visible YPA tab over SSE. Only the first matching tab response wins.
  app.post('/v1/sessions/:id/frontend-agent-response', (req, res) => {
    const sid = req.params.id;
    const body = (req.body as any) || {};
    const requestId = String(body.requestId || '').trim();
    if (!requestId) return res.status(400).json({ success: false, error: 'requestId required' });
    const { peekFrontendRequest, resolveFrontendRequest } = require('../chat/frontend-agent');
    const peek = peekFrontendRequest(requestId);
    if (!peek) return res.status(404).json({ success: false, error: 'frontend request is not pending' });
    if (peek.sessionId !== sid) {
      return res.status(403).json({ success: false, error: 'frontend request belongs to a different session' });
    }
    const result = body.result && typeof body.result === 'object'
      ? body.result
      : { ok: false, error: 'invalid frontend response' };
    const encodedSize = Buffer.byteLength(JSON.stringify(result), 'utf8');
    if (encodedSize > 512 * 1024) {
      return res.status(413).json({ success: false, error: 'frontend response exceeds 512 KiB' });
    }
    const ok = resolveFrontendRequest(requestId, sid, result);
    if (!ok) return res.status(409).json({ success: false, error: 'frontend request already resolved' });
    res.json({ success: true });
  });

  // Dedicated control stream for the visible YPA tab. This is deliberately
  // separate from the model-output SSE, whose owner may be Go or Node and
  // which only exists while a turn is running.
  app.get('/v1/sessions/:id/frontend-agent-events', (req, res) => {
    const sid = req.params.id;
    const { subscribeFrontendRequests } = require('../chat/frontend-agent');
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write('retry: 1000\nevent: ready\ndata: {}\n\n');

    const unsubscribe = subscribeFrontendRequests(sid, (request) => {
      res.write(`event: request\ndata: ${JSON.stringify(request)}\n\n`);
    });
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 15_000);
    req.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  });

  app.post('/v1/sessions/:id/messages', (req, res) => {
    const sid = req.params.id;
    const { role, text } = req.body;
    if (!role || !text)
      return res.status(400).json({ success: false, error: 'role and text required' });
    const stream = activeStreams.get(sid);
    if (role === 'note' && stream?.status === 'streaming') {
      const trimmed = String(text || '').trim();
      const now = Date.now();
      const injected = injectInlineBlock(
        sid,
        {
          type: 'interrupt',
          kind: 'note',
          text: trimmed,
          ts: now,
        },
        broadcastChunk,
        {
          interruptBlock: {
            kind: 'note',
            text: trimmed,
            ts: now,
          },
        }
      );
      if (injected) {
        try { rebuildSessionChatHistory(sid); } catch (_) {}
        return res.json({ success: true, inline: true });
      }
    }
    pushDisplayMsg(sid, role, text);
    rebuildSessionChatHistory(sid);
    res.json({ success: true });
  });

  app.delete('/v1/sessions/:id/messages', (req, res) => {
    const sid = req.params.id;
    const { index } = req.body;
    const session = displaySessions.get(sid);
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
    if (typeof index !== 'number' || index < 0 || index >= session.messages.length) {
      return res.status(400).json({ success: false, error: 'Invalid index' });
    }
    // If we're deleting a still-streaming assistant entry, kill the upstream
    // run AND mark its live-token as discarded so the trailing phase=update
    // / phase=final from Go (which arrive at /internal/persist-broadcast-message
    // after the splice) don't fall back to pushDisplayMsg and resurrect a
    // ghost bubble with the accumulated answer. See the matching guard in
    // sessions-internal/index.ts:updateLiveMsg/finalizeLiveMsg.
    const target = session.messages[index];
    if (target && target.streaming && typeof target._liveToken === 'number') {
      markLiveTokenDiscarded(sid, target._liveToken);
      const proc = activeProcesses.get(sid);
      if (proc?.killFn) {
        try { proc.killFn(); } catch (_) {}
        activeProcesses.delete(sid);
      }
      // Forward to Go's own /v1/stop too — Phase 7 Go-owned streams aren't in
      // the Node activeProcesses map, so the Node-side kill alone is a no-op
      // for them. Fire-and-forget; Go's handler is idempotent.
      fetch(`${_GO_CORE_URL}/v1/stop/${encodeURIComponent(sid)}`, { method: 'POST' }).catch(() => {});
      const stream = activeStreams.get(sid);
      if (stream && stream.status === 'streaming') {
        try { finalizeStream(sid, 'error', { error: 'stopped' }); } catch (_) {}
      }
    }
    session.messages.splice(index, 1);
    session.lastUsed = Date.now();
    rebuildSessionChatHistory(sid);
    saveSessionToDisk(sid);
    res.json({ success: true });
  });

  app.patch('/v1/sessions/:id/messages/:index', (req, res) => {
    const sid = req.params.id;
    const rawIdx = req.params.index;
    const { text, blocks, meta } = req.body;
    const session = displaySessions.get(sid);
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
    let index;
    if (rawIdx === 'last') {
      index = session.messages.length - 1;
    } else {
      index = parseInt(rawIdx, 10);
      if (isNaN(index)) return res.status(400).json({ success: false, error: 'Invalid index' });
      if (index < 0) index = session.messages.length + index;
    }
    if (index < 0 || index >= session.messages.length) {
      return res.status(400).json({ success: false, error: 'Invalid index' });
    }
    const msg = session.messages[index];
    if (blocks !== undefined) {
      msg.blocks = blocks;
      msg.ts = Date.now();
      delete msg.text;
    } else if (text !== undefined) {
      msg.text = text;
      msg.ts = Date.now();
      delete msg.blocks;
    }
    if (meta !== undefined) msg.meta = { ...msg.meta, ...meta };
    session.lastUsed = Date.now();
    rebuildSessionChatHistory(sid);
    saveSessionToDisk(sid);
    res.json({ success: true });
  });

  app.post('/v1/sessions/:id/branch', (req, res) => {
    const sid = req.params.id;
    const { upToIndex, name, workingDir } = req.body;
    const session = displaySessions.get(sid);
    if (!session) return res.status(404).json({ success: false, error: 'Session not found' });
    const endIdx = typeof upToIndex === 'number' ? upToIndex + 1 : session.messages.length;
    const messages = structuredClone(session.messages.slice(0, endIdx));
    const newSid = `branch_${Date.now()}`;
    const baseBranchName = `Branch of ${session.name}`;
    const existingCount = [...displaySessions.values()].filter(
      (sess) =>
        sess.name === baseBranchName ||
        sess.name.match(
          new RegExp(`^Branch \\d+ of ${session.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`)
        )
    ).length;
    const branchName =
      name ||
      (existingCount === 0 ? baseBranchName : `Branch ${existingCount + 1} of ${session.name}`);
    // Prefer the client-supplied workingDir (matches the user's *current* cwd
    // for the source session) over the persisted session.workingDir, which can
    // be stale if the user changed cwd mid-session without re-saving.
    const branchCwd = workingDir || session.workingDir;
    const newSession = {
      id: newSid,
      name: branchName.slice(0, 60),
      messages,
      createdAt: Date.now(),
      lastUsed: Date.now(),
      workingDir: branchCwd,
    };
    displaySessions.set(newSid, newSession);
    saveIndexToDisk();
    saveSessionToDisk(newSid);
    rebuildSessionChatHistory(newSid);
    res.json({ success: true, sessionId: newSid, name: newSession.name });
  });

  app.get('/v1/sessions/:id/export.md', (req, res) => {
    const session = displaySessions.get(req.params.id);
    if (!session) return res.status(404).send('# Not found\n');
    const lines = [
      '---',
      `id: ${session.id}`,
      `name: ${(session.name || '').replace(/:/g, ' -')}`,
      `createdAt: ${new Date(session.createdAt || 0).toISOString()}`,
      `updatedAt: ${new Date(session.lastUsed || 0).toISOString()}`,
      `participants: [${(session.participants || []).join(', ')}]`,
      `boundWorkflowName: ${session.boundWorkflowName || ''}`,
      '---',
      '',
      `# ${session.name || session.id}`,
      '',
      '## Messages',
      '',
    ];
    for (const msg of session.messages || []) {
      const ts = msg.ts ? new Date(msg.ts).toISOString() : '';
      const role =
        msg.role === 'assistant' ? `assistant (${msg.meta?.author?.id || 'default'})` : msg.role;
      lines.push(`### ${role}${ts ? `  — ${ts}` : ''}`, '');
      if (msg.text) lines.push(msg.text, '');
      else if (msg.blocks) {
        for (const block of msg.blocks) {
          if (block.type === 'text') lines.push(block.content, '');
          else if (block.type === 'tool-call')
            lines.push(
              `**Tool:** \`${block.name}\``,
              '```json',
              JSON.stringify(block.detail, null, 2),
              '```',
              ''
            );
        }
      }
    }
    res.setHeader('Content-Disposition', `attachment; filename="session-${session.id}.md"`);
    res.type('text/markdown').send(lines.join('\n'));
  });

  app.post('/v1/sessions/:id/participants', (req, res) => {
    const sid = req.params.id;
    const { employeeId } = req.body || {};
    if (!employeeId) return res.status(400).json({ success: false, error: 'employeeId required' });
    const emp = _getEmployee(employeeId);
    if (!emp) return res.status(404).json({ success: false, error: 'employee not found' });
    const session = getOrCreateDisplaySession(sid);
    session.participants = session.participants || [];
    if (!session.participants.includes(employeeId)) session.participants.push(employeeId);
    saveSessionToDisk(sid);
    res.json({ success: true, participants: session.participants });
  });

  app.delete('/v1/sessions/:id/participants/:empId', (req, res) => {
    const { id: sid, empId } = req.params;
    const session = displaySessions.get(sid);
    if (!session) return res.status(404).json({ success: false, error: 'session not found' });
    const parts = Array.isArray(session.participants) ? [...session.participants] : [];
    const idx = parts.indexOf(empId);
    if (idx !== -1) parts.splice(idx, 1);
    session.participants = parts;
    saveSessionToDisk(sid);
    res.json({ success: true, participants: session.participants });
  });

  app.patch('/v1/sessions/:id/group-mode', (req, res) => {
    const sid = req.params.id;
    const { mode } = req.body || {};
    if (mode !== 'sequential' && mode !== 'moderator' && mode !== 'versus') {
      return res
        .status(400)
        .json({ success: false, error: 'mode must be sequential, moderator, or versus' });
    }
    const session = getOrCreateDisplaySession(sid);
    session.groupMode = mode;
    saveSessionToDisk(sid);
    res.json({ success: true, groupMode: session.groupMode });
  });

  app.get('/v1/debug/chathistory/:id', (req, res) => {
    const sid = req.params.id;
    res.json({ success: true, data: buildChathistoryDebug(sid) });
  });

  // Generic debug endpoint — same builders as `#debug <type>` from chat input.
  // Frontend's debug-modal calls this directly when it needs to refetch a tab
  // (e.g. clicking a card in the overview grid) without going through the chat.
  app.get('/v1/debug/:type/:id', (req, res) => {
    const sid = req.params.id;
    const type = String(req.params.type || '').toLowerCase();
    // Phase-6: pull DEBUG_REGISTRY / SUBCOMMAND_LIST off the
    // observability-plus api instead of hard-requiring `./debug`. With
    // the module disabled the whole debug surface 501s cleanly.
    const obs = getModuleApi<any>('observability-plus');
    const DEBUG_REGISTRY = obs?.debug?.DEBUG_REGISTRY;
    const SUBCOMMAND_LIST = obs?.debug?.SUBCOMMAND_LIST;
    if (!DEBUG_REGISTRY || !SUBCOMMAND_LIST) {
      return res.status(501).json({ success: false, error: 'observability-plus disabled' });
    }
    const entry = DEBUG_REGISTRY[type];
    if (!entry) {
      return res.status(404).json({ success: false, error: `unknown debug type: ${type}`, available: SUBCOMMAND_LIST });
    }
    try {
      res.json({ success: true, type, data: entry.build(sid) });
    } catch (e) {
      const stack = e instanceof Error ? (e.stack || e.message || String(e)) : String(e);
      console.error(`[debug] builder for type="${type}" sid="${sid}" threw:`, stack);
      res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e), stack });
    }
  });

  // FE pushes its own monitoring snapshot here so backend can interleave it
  // with its own periodic snapshots in monitoring-log/YYYY-MM-DD.ndjson —
  // gives a chat-driven debugging session a single grep-able history of both
  // sides instead of needing the user to paste a new snapshot every iteration.
  app.post('/v1/debug/snapshot/fe', (req, res) => {
    try {
      // Phase-6: silent-skip if observability-plus is disabled — FE
      // monitoring-snapshot recording is non-critical and the FE keeps
      // posting at its normal cadence regardless of backend support.
      const obs = getModuleApi<any>('observability-plus');
      obs?.debug?.recordFrontendSnapshot?.(req.body || {});
      res.json({ success: true });
    } catch (e) {
      res.status(500).json({ success: false, error: e instanceof Error ? e.message : String(e) });
    }
  });

  // Resolve the mode (dev/build) and backend (go/node) the bridge is
  // currently running under. Prefers env vars exported by yha.sh; falls back
  // to inferring from YHA_USE_DIST (set on every boot) and PORT (8442 = Node
  // sitting behind Go, 8443 = Node fronting directly).
  function currentRuntime(): { mode: 'dev' | 'build'; backend: 'go' | 'node' } {
    const envMode = (process.env.YHA_MODE || '').toLowerCase();
    const mode: 'dev' | 'build' =
      envMode === 'dev' || envMode === 'build'
        ? (envMode as 'dev' | 'build')
        : process.env.YHA_USE_DIST === 'false' ? 'dev' : 'build';
    const envBackend = (process.env.YHA_BACKEND || '').toLowerCase();
    const backend: 'go' | 'node' =
      envBackend === 'go' || envBackend === 'node'
        ? (envBackend as 'go' | 'node')
        : process.env.PORT === '8442' ? 'go' : 'node';
    return { mode, backend };
  }

  app.get('/v1/runtime/mode', (_req, res) => {
    res.json({ success: true, ...currentRuntime() });
  });

  app.post('/v1/restart', (req, res) => {
    const cur = currentRuntime();
    const body = (req.body || {}) as { mode?: string; backend?: string };
    const reqMode = (body.mode || '').toLowerCase();
    const reqBackend = (body.backend || '').toLowerCase();
    const mode: 'dev' | 'build' =
      reqMode === 'dev' || reqMode === 'build' ? (reqMode as 'dev' | 'build') : cur.mode;
    const backend: 'go' | 'node' =
      reqBackend === 'go' || reqBackend === 'node' ? (reqBackend as 'go' | 'node') : cur.backend;
    res.json({ ok: true, mode, backend });

    const { spawn } = require('child_process');
    const fss = require('fs');
    const scriptDir = path.join(__dirname, '..', '..');
    const logPath = path.join(scriptDir, 'restart.log');
    // Mode-only switch (vite-HMR dev ⇄ frontend-dist build) → route through
    // ./yha.sh restart-bridge so YHA-Core keeps streaming. Any chat in
    // flight at the moment of the toggle survives the bounce because the
    // ring buffer lives in YHA-Core, not in the bridge process being cycled.
    //
    // Backend switch (go ⇄ node) → fall back to ./yha.sh restart-all so
    // the front-door rewires correctly. This kills the chat stream, same
    // as the legacy behaviour, but backend switching is rare and the user
    // who triggers it is consenting to the heavier bounce.
    const backendChanged = backend !== cur.backend;
    const args = backendChanged
      ? (() => {
          const a = ['/bin/bash', './yha.sh', 'restart-all', mode];
          if (backend === 'node') a.push('node');
          return a;
        })()
      : ['/bin/bash', './yha.sh', 'restart-bridge', mode];
    setTimeout(() => {
      let logFd: number;
      try { logFd = fss.openSync(logPath, 'w'); } catch (_) { logFd = -1; }
      const stdio: any = logFd >= 0 ? ['ignore', logFd, logFd] : 'ignore';
      const nvmBin = '/home/user/.nvm/versions/node/v24.15.0/bin';
      const childEnv = {
        ...process.env,
        PATH: `${nvmBin}:${process.env.PATH || '/usr/local/bin:/usr/bin:/bin'}`,
      };
      // setsid creates a new session so the script survives when pm2 kills
      // this bridge process (otherwise the bash child inherits the process
      // group and gets SIGHUP'd along with us).
      const child = spawn('setsid', args, {
        cwd: scriptDir,
        detached: true,
        stdio,
        env: childEnv,
      });
      child.unref();
      if (logFd >= 0) {
        // close the fd in the parent after spawn — child keeps its own copy
        child.on('spawn', () => { try { fss.closeSync(logFd); } catch (_) {} });
        child.on('error', () => { try { fss.closeSync(logFd); } catch (_) {} });
      }
    }, 200);
  });

  app.patch('/v1/sessions/:id/participants/order', (req, res) => {
    const sid = req.params.id;
    const { order } = req.body || {};
    if (!Array.isArray(order))
      return res.status(400).json({ success: false, error: 'order array required' });
    const session = displaySessions.get(sid);
    if (!session) return res.status(404).json({ success: false, error: 'session not found' });
    const existing = new Set(session.participants || []);
    const valid = order.filter((id) => existing.has(id));
    session.participants = valid;
    saveSessionToDisk(sid);
    res.json({ success: true, participants: session.participants });
  });
}

module.exports = {
  registerSessionRoutes,
};
