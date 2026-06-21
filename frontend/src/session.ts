// Session management — server-backed via /v1/sessions/
// Falls back to localStorage messages if server has no history (e.g. after restart)

import { getAppState, getAppActions, getSessionActions } from './stores/index.js';
import type { SessionEntry as StoreSessionEntry } from './stores/index.js';
import { useChatStore } from './stores/chatStore.js';
import { api } from './api.js';
import { chat } from './chat.js';
import { workflow } from './workflows/workflow.js';

interface SessionMessage {
  role: string;
  text?: unknown;
  content?: string;
  ts?: number;
}

interface SessionEntry {
  id: string | number;
  name: string;
  messages?: SessionMessage[];
  messageCount?: number;
  participants: unknown[];
  groupMode: string;
  createdAt: number;
  lastUsed?: number;
  viewedAt?: number;
  workingDir?: string | null;
  boundWorkflowName?: string;
}

type HistoryMode = 'push' | 'replace' | 'none';

export const session = (() => {
  const CURRENT_KEY = 'yha.currentSession';
  const HASH_PREFIX = '#s/';
  let _cache: SessionEntry[] = [];
  let _defaultCwd = '';
  let _hostname = '';
  // IDs known to exist server-side. Anything in _cache not here is a "ghost"
  // (created locally but never persisted because no message was sent yet).
  let _serverIds: Set<string> = new Set();
  // Drives whether setCurrentId mutates browser history. Defaults to 'push' so
  // ad-hoc create()/setCurrentId() calls add a back-button entry; switchTo()
  // can override (e.g. 'replace' at boot, 'none' from popstate).
  let _hashHistoryMode: HistoryMode = 'push';
  let _hashListenerAttached = false;
  // Per-session timestamp of the last reconcile tick where the server reported
  // the session as running (or we observed it locally active). Used as
  // hysteresis when fetchList() considers clearing serverActive: Go's
  // active-stream cache has a 500 ms TTL and the set itself can briefly drop a
  // session between turns, so a single "not running" tick is not reliable
  // evidence the stream is over. We keep serverActive sticky until the
  // session has been reported not-running continuously for HYSTERESIS_MS.
  // Sized to outlast the bridge's ACTIVE_HYSTERESIS_MS (10 s in
  // bridge/core/go-active-streams.ts) so a Go-side hysteresis blip can never
  // race ahead of our local one — if Go has fully forgotten the session, the
  // bridge's wasActiveRecently() has also expired and the truth lines up.
  // Cost: a real stop is reflected in the picker up to ~12 s late.
  const STREAM_HYSTERESIS_MS = 12000;
  const _lastSeenBusyAt: Map<string, number> = new Map();
  // Latest switch wins. Rapid picker clicks can leave older switchTo() calls
  // doing list/session/status fetches and repainting messages after the user
  // has already moved on, causing progressive jank with only a few switches.
  let _switchSeq = 0;
  let _switchAbort: AbortController | null = null;

  function base(): string {
    return api.config.baseUrl || 'http://localhost:8443';
  }

  function isGhost(id: string | number): boolean {
    return !_serverIds.has(String(id));
  }

  // ── Fetch a single session with messages from server ───────────────────────
  async function fetchSession(id: string, signal?: AbortSignal): Promise<SessionEntry | null> {
    try {
      const r = await fetch(`${base()}/v1/sessions/${encodeURIComponent(id)}`, { signal });
      if (!r.ok) return null;
      const d = await r.json();
      return d.session || null;
    } catch (_) {
      return null;
    }
  }

  // ── Fetch session list from server ─────────────────────────────────────────
  async function fetchList(signal?: AbortSignal): Promise<SessionEntry[]> {
    try {
      const r = await fetch(base() + '/v1/sessions/', { signal });
      const d = await r.json();
      if (signal?.aborted) return _cache;
      const serverSessions: SessionEntry[] = d.sessions || [];
      _serverIds = new Set(serverSessions.map((s) => String(s.id)));
      // Preserve every unpersisted ghost in _cache, not just the current
      // one. create() already de-dupes consecutive empty ghosts (line ~257)
      // so the "pile up undeletable entries" risk that motivated the
      // previous current-only filter doesn't actually arise in normal use.
      // Without this, switching away from a freshly-created new session
      // drops it on the next fetchList — and because markViewed's
      // {viewed:true} PATCH no-ops on unknown sids on the bridge side
      // (bridge/routes/sessions.ts:322-332), the session never gets
      // persisted to recover it. Net effect was: new session disappears
      // the moment the user clicks any other session.
      const localOnly = _cache.filter((s) => !_serverIds.has(String(s.id)));
      _cache = [...localOnly, ...serverSessions];
      if (d.defaultWorkingDir) _defaultCwd = d.defaultWorkingDir;
      if (d.hostname) _hostname = d.hostname;
    } catch (_) {}
    getSessionActions().setSessions(_cache as StoreSessionEntry[]);
    getSessionActions().setDefaultWorkingDir(_defaultCwd || '');
    getSessionActions().setHostname(_hostname || '');
    // Reconcile sessionStreams with server isRunning state. The picker reads
    // both `s.isRunning` and `sessionStreams[sid]`, but StatusIndicator and
    // AppEffects' reconnect trigger only look at `sessionStreams[sid]`. So if
    // the server keeps a stream alive (e.g. a long-running task we missed the
    // _end for, a stream started in another tab, or one that was finalized
    // and quickly restarted) and the local state was previously cleared, the
    // chat panel goes "silent" while the picker dot still shows running. Seed
    // serverActive=true here so the indicator reappears and AppEffects can
    // reattach via reconnectStream(). Conversely clear stale serverActive
    // entries when the server has dropped the stream entirely.
    try {
      const _chatState = useChatStore.getState();
      const _streams = _chatState.sessionStreams || {};
      const now = Date.now();
      const _seenSids = new Set<string>();
      for (const s of _cache) {
        const sid = String(s.id);
        _seenSids.add(sid);
        const local = _streams[sid];
        const serverRunning = (s as { isRunning?: boolean }).isRunning === true;
        // Update the last-seen-running timestamp on any signal that the
        // session is alive — server-reported, local POST in flight, or a
        // reconnecting state. Without seeding from localLive/reconnecting,
        // sessions started by a local send (which the bridge may not have
        // observed yet) would have no hysteresis baseline and could flicker
        // on their very first reconcile tick.
        if (serverRunning || local?.localLive || local?.reconnecting) {
          _lastSeenBusyAt.set(sid, now);
        }
        if (serverRunning && (!local || local.status !== 'streaming')) {
          // Server has a live stream but FE has nothing (or stale status) — reseed.
          // setKnownStreamStatus now bails if there's an active POST controller AND
          // active=false, so it's safe to call even while a send is in flight.
          chat?.setKnownStreamStatus?.(sid, { active: true, status: 'streaming' });
        } else if (!serverRunning && local && local.serverActive && !local.localLive && !local.reconnecting) {
          // Hysteresis: don't clear serverActive on the first not-running
          // tick. Go's active-stream cache (500 ms TTL) plus brief gaps
          // between turns can yield a stale "not running" answer for one
          // poll cycle even while the stream is still alive — clearing here
          // makes the picker dot flicker every few seconds. Only clear once
          // we've seen not-running continuously for STREAM_HYSTERESIS_MS.
          const lastAlive = _lastSeenBusyAt.get(sid) ?? 0;
          if (now - lastAlive >= STREAM_HYSTERESIS_MS) {
            chat?.setKnownStreamStatus?.(sid, { active: false });
            _lastSeenBusyAt.delete(sid);
          }
        }
      }
      // Drop hysteresis entries for sessions no longer in _cache so the
      // map can't grow unbounded across delete()/restart cycles.
      for (const sid of _lastSeenBusyAt.keys()) {
        if (!_seenSids.has(sid)) _lastSeenBusyAt.delete(sid);
      }
    } catch (_) { /* best-effort sync; never block fetchList */ }
    // Update cwd for the currently active session
    const currentId = String(
      getAppState().currentSession || localStorage.getItem('yha.currentSession') || ''
    );
    const current = _cache.find((s) => String(s.id) === currentId);
    if (current?.workingDir) {
      getAppActions().setSessionWorkingDir(current.workingDir);
    } else if (_defaultCwd) {
      // New/unknown session — fall back to server default working directory
      getAppActions().setSessionWorkingDir(_defaultCwd);
    }
    // Sync background-added messages into the active chat view.
    // messageCount tells us if the server has more messages than the chat store.
    // If so, fetch the full session to get the new messages (avoids sending all
    // message content in every list poll).
    const chatState = useChatStore.getState();
    const streamState = chatState.sessionStreams?.[currentId];
    const isStreaming = streamState?.localLive || streamState?.serverActive;
    if (!isStreaming && current?.messageCount != null && current.messageCount > chatState.messages.length) {
      const full = await fetchSession(currentId, signal);
      if (full?.messages) chatState.setMessages(full.messages as any);
    }
    return _cache;
  }

  function getCached(): SessionEntry[] {
    return _cache;
  }

  function ensureCachedSession(id: string | number, patch: Partial<SessionEntry> = {}): SessionEntry | null {
    const sid = String(id || '');
    if (!sid) return null;
    let existing = _cache.find((s) => String(s.id) === sid);
    if (!existing) {
      existing = {
        id: sid,
        name: patch.name || 'New session',
        messages: [],
        participants: [],
        groupMode: 'sequential',
        createdAt: Date.now(),
        lastUsed: Date.now(),
        viewedAt: Date.now(),
      };
      _cache.unshift(existing);
    }
    Object.assign(existing, patch || {});
    if (!Array.isArray(existing.messages)) existing.messages = [];
    if (!Array.isArray(existing.participants)) existing.participants = [];
    if (!existing.groupMode) existing.groupMode = 'sequential';
    return existing;
  }

  // ── Current session ID ─────────────────────────────────────────────────────
  function getCurrentId(): string {
    let id = localStorage.getItem(CURRENT_KEY);
    if (!id) {
      id = `s${Date.now()}`;
      localStorage.setItem(CURRENT_KEY, id);
    }
    getAppActions().setCurrentSession(id);
    return id;
  }

  function setCurrentId(id: string | number): void {
    localStorage.setItem(CURRENT_KEY, String(id));
    getAppActions().setCurrentSession(id);
    getSessionActions().setCurrentId(id);
    _updateHash(id, _hashHistoryMode);
  }

  function _readHashSession(): string | null {
    const h = window.location.hash || '';
    if (!h.startsWith(HASH_PREFIX)) return null;
    const sid = decodeURIComponent(h.slice(HASH_PREFIX.length).split(/[?&]/)[0]);
    return sid || null;
  }

  function _updateHash(id: string | number, mode: HistoryMode): void {
    if (mode === 'none') return;
    const sid = String(id || '');
    const target = sid ? HASH_PREFIX + encodeURIComponent(sid) : '';
    if ((window.location.hash || '') === target) return;
    const url = (window.location.pathname + window.location.search + target) || window.location.href;
    try {
      if (mode === 'replace') history.replaceState({ sid }, '', url);
      else history.pushState({ sid }, '', url);
    } catch (_) {
      // Last resort — direct hash assignment always pushes a history entry.
      if (target) window.location.hash = target;
    }
  }

  async function _onPopState(): Promise<void> {
    const sid = _readHashSession();
    if (!sid) return;
    if (String(getCurrentId()) === sid) return;
    await switchTo(sid, { historyMode: 'none' });
  }

  function initHashRouting(): void {
    if (_hashListenerAttached) return;
    _hashListenerAttached = true;
    window.addEventListener('popstate', _onPopState);
  }

  function parseHashSession(): string | null {
    return _readHashSession();
  }

  function sessionExists(id: string | number): boolean {
    return _serverIds.has(String(id));
  }

  async function markViewed(sessionId: string | number, viewedAt = Date.now()): Promise<void> {
    if (!sessionId) return;
    const sid = String(sessionId);
    try {
      await fetch(base() + `/v1/sessions/${encodeURIComponent(sid)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ viewed: true }),
      });
    } catch (_) {}
    const cached = _cache.find((s) => String(s.id) === sid);
    if (cached) {
      cached.viewedAt = viewedAt;
      // Repaint now instead of waiting for the next poll. setSessions compares
      // by reference (Object.is on the array), and we mutated `cached` in
      // place, so hand it a fresh array ref or the unread badge won't clear.
      getSessionActions().setSessions([..._cache] as StoreSessionEntry[]);
    }
  }

  // ── Create new session ─────────────────────────────────────────────────────
  function create(): string {
    // If we're already in an empty, unpersisted ghost session, just reuse it
    // instead of creating yet another ghost entry.
    const currentId = String(getCurrentId());
    const current = _cache.find((s) => String(s.id) === currentId);
    if (current && isGhost(currentId) && (current.messages?.length ?? 0) === 0) {
      Object.assign(current, {
        workingDir: _defaultCwd || null,
        messages: [],
        participants: [],
        groupMode: 'sequential',
        lastUsed: Date.now(),
      });
      useChatStore.getState().setMessages([]);
      getAppActions().setSessionWorkingDir(_defaultCwd || null);
      getSessionActions().setSessions(_cache as StoreSessionEntry[]);
      return currentId;
    }

    const id = `s${Date.now()}`;
    setCurrentId(id);
    useChatStore.getState().setMessages([]);
    getAppActions().setSessionWorkingDir(_defaultCwd || null);
    ensureCachedSession(id, {
      workingDir: _defaultCwd || null,
      messages: [],
      participants: [],
      groupMode: 'sequential',
    });
    // Sync to Zustand immediately so React effects see the new session
    getSessionActions().setSessions(_cache as StoreSessionEntry[]);
    return id;
  }

  // ── Switch to session: load messages from server ───────────────────────────
  async function switchTo(
    sessionId: string | number,
    options?: { historyMode?: HistoryMode }
  ): Promise<void> {
    const switchSeq = ++_switchSeq;
    try { _switchAbort?.abort(); } catch (_) {}
    const switchAbort = new AbortController();
    _switchAbort = switchAbort;
    const { signal } = switchAbort;
    const targetSid = String(sessionId);
    // Detach client-side stream for the session we're leaving
    // (server-side activeStreams keeps buffering independently)
    const oldSid = String(getCurrentId());
    if (oldSid !== targetSid && chat?.detachStream) {
      chat.detachStream(oldSid);
    }
    if (oldSid !== targetSid) {
      // Best-effort only. Waiting here keeps currentSession on oldSid while
      // the user can keep clicking, so several stale switch pipelines pile up.
      void markViewed(oldSid).catch(() => {});
    }
    // Kill any existing passive EventSource we might have for the session
    // we're switching INTO — AppEffects below will re-spawn it in active
    // rendering mode now that it's the focused session. Without this the
    // current-session reconnect effect short-circuits on `localLive: true`
    // (the passive listener) and the visible chat keeps rendering whatever
    // setMessages loaded from disk instead of streaming live tokens.
    if (oldSid !== targetSid && chat?.detachStream) {
      chat.detachStream(targetSid);
    }
    // Pre-seed local stream state from the cached server view BEFORE flipping
    // currentSession. StatusIndicator + updateStreamingUI subscribe only to
    // sessionStreams[currentId], so if the target has no local entry yet (most
    // common when the user has never streamed it in this tab — fresh load,
    // another tab started it, etc.) flipping the id first leaves a visible
    // blank until `await fetchList()` finishes its network round-trip and the
    // reconcile loop seeds an entry. For a freshly-started session, where Go
    // can take a beat to register the stream in /internal/active-streams, the
    // gap is long enough that the indicator visibly drops and the picker dot
    // races behind. Seeding eagerly closes the window — and the reconcile loop
    // / hysteresis below will correct us if we're wrong.
    const cachedTarget = _cache.find((s) => String(s.id) === targetSid);
    if (cachedTarget && (cachedTarget as { isRunning?: boolean }).isRunning === true) {
      const existing = useChatStore.getState().sessionStreams[targetSid];
      if (!existing || (!existing.localLive && !existing.reconnecting && existing.status !== 'streaming')) {
        chat?.setKnownStreamStatus?.(targetSid, { active: true, status: 'streaming' });
      }
      _lastSeenBusyAt.set(targetSid, Date.now());
    }
    const prevHashMode = _hashHistoryMode;
    if (options?.historyMode) _hashHistoryMode = options.historyMode;
    setCurrentId(targetSid);
    _hashHistoryMode = prevHashMode;
    // After currentId flips, spin up a passive listener for the leaving
    // session so its `_end` chunk + trailing chunks land while we're
    // elsewhere. reconnectStream self-gates on stream-status — it returns
    // immediately if oldSid isn't actually running on the server.
    if (oldSid !== targetSid && chat?.reconnectStream) {
      Promise.resolve().then(() => chat.reconnectStream(oldSid).catch(() => {}));
    }
    // Mark session as viewed (clears unread indicator)
    void markViewed(targetSid).catch(() => {});
    await fetchList(signal);
    if (signal.aborted) return;
    if (switchSeq !== _switchSeq || String(getAppState().currentSession || '') !== targetSid) return;
    const s = _cache.find((s) => String(s.id) === targetSid);
    // Fetch full session (with messages) separately — list endpoint no longer sends messages
    const full = !isGhost(targetSid) ? await fetchSession(targetSid, signal) : null;
    if (signal.aborted) return;
    if (switchSeq !== _switchSeq || String(getAppState().currentSession || '') !== targetSid) return;
    const _msgs = ((full?.messages ?? s?.messages) || []).map((m) => {
      const next: Record<string, unknown> = {
        ...m,
        role: m.role === 'assistant' ? 'agent' : m.role,
      };
      // Disk-persisted `streaming: true` placeholders (from the bridge's
      // updateLiveMsg debounce) carry the latest partial blocks. Without
      // surfacing them as typing-placeholders the FE would push a SECOND
      // typing bubble on reconnect → user sees the stale persisted reply +
      // a new empty placeholder filling in below it. Flagging typing:true
      // lets reconnectStream's reuse path latch onto the existing message
      // so the live bubble grows in place.
      if ((m as unknown as Record<string, unknown>)['streaming'] === true) {
        next['typing'] = true;
      }
      return next;
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    useChatStore.getState().setMessages(_msgs as any);
    if (chat?.syncMessageCounter) chat.syncMessageCounter();
    if (chat && chat.renderAll) chat.renderAll();
    // Restore session working directory — fall back to server default if session not yet persisted
    const newCwd = s?.workingDir ? s.workingDir : (_defaultCwd || null);
    getAppActions().setSessionWorkingDir(newCwd);

    // Update send/stop button state for this session from the authoritative server
    // stream state. React AppEffects now owns the reconnect trigger.
    //
    // We only WRITE on a positive answer: an `active:false` here can be a
    // transient miss (the bridge's /v1/sessions/:id/status hits Go's active
    // set via a 500 ms cache that may have just refreshed empty even though
    // the session genuinely IS streaming — Go's hysteresis only kicks in
    // after one positive sighting, which may not have happened yet for a
    // brand-new session). Clearing serverActive here would blank the
    // indicator and flicker the picker for ~one poll cycle until fetchList's
    // own hysteresis-protected reconcile re-seeds. fetchList()'s reconcile
    // loop owns the clearing path with STREAM_HYSTERESIS_MS protection, so
    // we don't need a parallel clear here.
    const status = await streamStatus(targetSid, signal);
    if (signal.aborted) return;
    if (switchSeq !== _switchSeq || String(getAppState().currentSession || '') !== targetSid) return;
    if (chat?.setKnownStreamStatus && status?.active) chat.setKnownStreamStatus(targetSid, status);
    // RELOAD/SWITCH-BACK race fix: fetchList()'s reconcile loop may have
    // already called setKnownStreamStatus(targetSid, {active:true,...}) before
    // we reached the setMessages() call above. That early state-change
    // triggered AppEffects → reconnectStream, which pushed its typing
    // placeholder into the chat store — and setMessages() then *wiped* that
    // placeholder when it overwrote messages with the disk snapshot. The
    // in-flight EventSource ended up writing chunks into a detached DOM
    // element that no React-rendered <Message> mid pointed at, so the user
    // saw the persisted partial reply but the live stream "never picked up".
    //
    // Tear the racing reconnect down and open a fresh one now, AFTER
    // setMessages, so the reuse path resolves to the freshly-loaded
    // persisted-typing msg in the store.
    if (status?.active && chat?.reconnectStream) {
      // Snapshot the persisted assistant message BEFORE detachStream runs,
      // because detachStream's ctrl.abort() invokes finish('detached')
      // inside the orphan reconnect's closure, which mutates the visible
      // agent entry: it overwrites blocks with the orphan's local (often
      // empty) blocks AND deletes the typing flag. After that, the next
      // reconnect's processChunk would write to streamingSegments[mid]
      // but MessageList — seeing typing:false — renders the static path
      // and ignores the live segment. Net effect: snapshot stays visible
      // but chunks land in limbo. Exactly the "shows current state once,
      // no further updates" reload symptom.
      type AnyMsg = { role?: string; streaming?: boolean; typing?: boolean; blocks?: unknown; text?: string };
      const preMsgs = useChatStore.getState().messages as AnyMsg[];
      let preBlocks: unknown = undefined;
      let preText: string | undefined = undefined;
      for (let i = preMsgs.length - 1; i >= 0; i--) {
        const m = preMsgs[i];
        if (m && m.role === 'agent') {
          preBlocks = m.blocks;
          preText = m.text;
          break;
        }
      }
      if (chat.detachStream) chat.detachStream(targetSid);
      // Restore the persisted snapshot blocks AND re-flag typing:true on
      // the in-flight assistant entry so the upcoming reconnect's reuse
      // latches onto it and live chunks render via streamingSegments.
      const postMsgs = useChatStore.getState().messages as AnyMsg[];
      let mutated = false;
      for (let i = postMsgs.length - 1; i >= 0; i--) {
        const m = postMsgs[i];
        if (m && m.role === 'agent') {
          if (preBlocks !== undefined) m.blocks = preBlocks as never;
          if (preText !== undefined && preText !== '') m.text = preText;
          if ((m as Record<string, unknown>)['streaming'] === true) {
            m.typing = true;
            mutated = true;
          }
          break;
        }
      }
      if (mutated) {
        useChatStore.setState((s) => ({ messages: [...s.messages] as never }));
      }
      chat.invalidateReconnect?.(targetSid);
      Promise.resolve().then(() => chat.reconnectStream?.(targetSid, status).catch(() => {}));
    }

    // Auto-load bound workflow if split-view is visible
    if (s?.boundWorkflowName && getAppState().viewMode !== 'chat') {
      if (workflow?.load) workflow.load(s.boundWorkflowName);
    }
  }

  // ── Delete session ─────────────────────────────────────────────────────────
  async function delete_(sessionId: string | number): Promise<void> {
    const sid = String(sessionId);
    const wasCurrent = String(getCurrentId()) === sid;
    if (isGhost(sid)) {
      // Ghost session — never persisted, so DELETE on server is a no-op.
      // Drop it from the local cache directly so the picker actually updates.
      _cache = _cache.filter((s) => String(s.id) !== sid);
      if (chat?.detachStream) chat.detachStream(String(sessionId));
      if (wasCurrent) {
        if (_cache.length > 0) {
          const nextId = _cache[0].id;
          setCurrentId(nextId);
          await switchTo(nextId);
        } else {
          create();
          if (chat && chat.renderAll) chat.renderAll();
        }
      } else {
        getSessionActions().setSessions(_cache as StoreSessionEntry[]);
      }
      return;
    }

    await fetch(base() + `/v1/sessions/${encodeURIComponent(sid)}`, { method: 'DELETE' });
    if (wasCurrent) {
      // Detach stream before switching so the deleted session is cleanly abandoned.
      if (chat?.detachStream) chat.detachStream(String(sessionId));
      await fetchList();
      if (_cache.length > 0) {
        const nextId = _cache[0].id;
        // Set currentId BEFORE calling switchTo so switchTo sees no "old session" to
        // markViewed — otherwise it would PATCH the just-deleted session and recreate it.
        setCurrentId(nextId);
        await switchTo(nextId);
      } else {
        create();
        if (chat && chat.renderAll) chat.renderAll();
      }
    } else {
      await fetchList();
    }
  }

  // ── Rename session ─────────────────────────────────────────────────────────
  async function rename(sessionId: string | number, newName: string): Promise<void> {
    await fetch(base() + `/v1/sessions/${encodeURIComponent(String(sessionId))}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName }),
    });
    const s = _cache.find((s) => String(s.id) === String(sessionId));
    if (s) s.name = newName;
  }

  // ── Legacy-compat shims (sync, use cache) ──────────────────────────────────
  function list(): Record<string, SessionEntry> {
    const obj: Record<string, SessionEntry> = {};
    for (const s of _cache) obj[String(s.id)] = s;
    return obj;
  }

  function getAllSessions(): SessionEntry[] {
    return [..._cache];
  }

  // No-op: server stores display history automatically
  function updateCurrent(): void {}

  // ── Create new session with specific working directory ─────────────────────
  function createWithDir(cwd: string): string {
    const id = `s${Date.now()}`;
    setCurrentId(id);
    useChatStore.getState().setMessages([]);
    getAppActions().setSessionWorkingDir(cwd || null);
    ensureCachedSession(id, {
      workingDir: cwd || null,
      messages: [],
      participants: [],
      groupMode: 'sequential',
    });
    // Sync to Zustand immediately so React effects see the new session
    getSessionActions().setSessions(_cache as StoreSessionEntry[]);
    if (cwd) {
      fetch(base() + `/v1/sessions/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: cwd }),
      }).catch(() => {});
    }
    return id;
  }

  // The session picker UI lives in frontend/src/SessionPicker.tsx
  // (Zustand-driven React popover). No DOM implementation here.

  // ── Stream status check — is there an active (or recently finished) stream? ─
  async function streamStatus(
    sessionId: string,
    signal?: AbortSignal,
  ): Promise<{ active: boolean; status?: string; chunksCount?: number }> {
    try {
      const r = await fetch(base() + `/v1/sessions/${encodeURIComponent(sessionId)}/status`, { signal });
      return await r.json();
    } catch (_) {
      return { active: false };
    }
  }

  // ── Set working directory for a session ────────────────────────────────────
  // Centralised helper: PATCHes the server, updates `_cache` (so the next
  // fetchList() poll doesn't overwrite the freshly-set value with a stale
  // entry), and mirrors to appStore.sessionWorkingDir IFF the target session
  // is the active one (so changing another tab/session's cwd doesn't yank
  // this tab's panel).
  //
  // Why _cache must be updated: ghost (in-memory only) sessions are filtered
  // out of /v1/sessions/ by the server. The PATCH endpoint doesn't promote
  // them. So the only place the FE knows about a ghost's workingDir is the
  // local cache — and SessionPoller polls every 4 s while any session is
  // running, calling setSessionWorkingDir(_cache.workingDir) each time. If
  // we don't sync _cache here, every poll resets the user's just-picked dir
  // back to whatever was on the cache entry at create() time.
  async function setWorkingDir(
    sessionId: string | number,
    dir: string | null,
  ): Promise<{ success: boolean; workingDir?: string; error?: string }> {
    const sid = String(sessionId);
    try {
      const r = await fetch(`${base()}/v1/sessions/${encodeURIComponent(sid)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ workingDir: dir }),
      });
      const d = (await r.json()) as { success: boolean; workingDir?: string; error?: string };
      if (d.success) {
        const wd = d.workingDir ?? dir ?? null;
        const cached = _cache.find((s) => String(s.id) === sid);
        if (cached) cached.workingDir = wd;
        else ensureCachedSession(sid, { workingDir: wd });
        getSessionActions().setSessions(_cache as StoreSessionEntry[]);
        const activeId = String(getAppState().currentSession || '');
        if (activeId === sid) {
          getAppActions().setSessionWorkingDir(wd);
        }
      }
      return d;
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  }

  return {
    fetchList,
    fetchSession,
    getCached,
    getCurrentId,
    setCurrentId,
    create,
    createWithDir,
    switchTo,
    delete: delete_,
    rename,
    list,
    getAllSessions,
    updateCurrent,
    streamStatus,
    setWorkingDir,
    initHashRouting,
    parseHashSession,
    sessionExists,
    markViewed,
    get _cache() {
      return _cache;
    },
  };
})();
