// SessionPoller — keeps sessionStore.sessions fresh in the background.
// Polls session.fetchList() so the SessionPicker / CwdPanel always
// reflect current data, including the per-session isRunning flag.
//
// Two cadences:
//   - Idle: every 30s
//   - Busy: every 4s while ANY session is live — per the process-global
//           activity feed (covers TUI / cron / other tabs / multichat, not
//           just streams this tab opened), OR isRunning=true, OR the active
//           session has serverActive=true. This keeps the busy dot and the
//           agent message in sync when the user switches away from a
//           long-running stream and comes back.
//
// Activity-driven refetch: the list metadata (ordering / unread / existence)
// is pure-poll, so a background session starting or stopping would otherwise
// be invisible until the next idle tick. We watch the MEMBERSHIP of the live
// feed (its set of session ids, not the per-frame token counters) and pull a
// fresh fetchList() the instant it changes.
//
// Per-session reconcile: after each fetchList, walk sessions whose local
// stream state says busy but whose server isRunning=false. The bridge has
// authoritative knowledge of which streams are live (go-core's active-stream
// cache + the in-process active map). If it reports a session as idle while
// the FE still shows localLive/reconnecting, the `_end` SSE chunk was
// dropped in flight (bridge restart, network blip) and the FE never cleared
// its state. We give the discrepancy STUCK_THRESHOLD_MS to settle (covers
// the existing 12 s hysteresis in fetchList plus a slack tick for fresh
// sends fetchList hasn't observed yet), then call reconcileFromPersisted
// to restore the bubble from disk and clear the local flag.

import { useEffect, useMemo, useRef } from 'react';
import { session } from './session.js';
import { useSessionStore } from './stores/sessionStore.js';
import { useChatStore } from './stores/chatStore.js';
import { useSessionActivityStore } from './stores/sessionActivityStore.js';
import { connectSessionsDirtyFeed, disconnectSessionsDirtyFeed } from './stores/sessionsDirtyFeed.js';
import { chatStreaming } from './chat/chat-streaming.js';

const IDLE_POLL_MS = 30_000;
const BUSY_POLL_MS = 10_000; // was 4s; activity feed + dirty SSE already give immediate start/stop; list polls are now mostly for metadata freshness + stuck recovery
const STUCK_THRESHOLD_MS = 15_000;

const stuckSince = new Map<string, number>();

async function reconcileStuckSessions(): Promise<void> {
  const freshSessions = useSessionStore.getState().sessions;
  const freshStreams = useChatStore.getState().sessionStreams || {};
  const now = Date.now();
  const seen = new Set<string>();
  for (const s of freshSessions) {
    const sid = String(s.id);
    seen.add(sid);
    const local = freshStreams[sid];
    if (!local) { stuckSince.delete(sid); continue; }
    const localBusy = local.localLive || local.reconnecting || local.serverActive;
    if (!localBusy) { stuckSince.delete(sid); continue; }
    if (s.isRunning) { stuckSince.delete(sid); continue; }
    const since = stuckSince.get(sid);
    if (since === undefined) { stuckSince.set(sid, now); continue; }
    if (now - since < STUCK_THRESHOLD_MS) continue;
    stuckSince.delete(sid);
    chatStreaming.reconcileFromPersisted(sid).catch(() => {});
  }
  for (const sid of stuckSince.keys()) {
    if (!seen.has(sid)) stuckSince.delete(sid);
  }
}

export function SessionPoller() {
  const currentId = useSessionStore((s) => s.currentId);
  // Subscribe only to *presence* booleans (stable while any given busy set is
  // unchanged) rather than the full sessions/streams objects. This keeps the
  // (always-mounted, returns null) poller component from re-rendering on every
  // 4 s list poll or per-chunk stream state patch while N sessions are live.
  // The anyBusy result (used for interval choice) therefore only flips the
  // effect when the *set* of busy things actually changes. Effects below that
  // need the live arrays read fresh values via getState() at call time.
  // The process-global activity feed is the only real-time signal for sessions
  // this tab never personally streamed (TUI, cron, another tab, multichat).
  // Subscribe to the sorted membership key string rather than the full sessions
  // object so this component only re-renders when sessions start/stop, not on
  // every counter-tick frame (~1 Hz while live).

  // Hold the activity feed open for the whole app lifetime — the poller is
  // mounted globally, so this guarantees background busy state is visible on
  // every layout, not only while a session-list surface happens to be mounted.
  useEffect(() => {
    useSessionActivityStore.getState().connect();
    return () => { useSessionActivityStore.getState().disconnect(); };
  }, []);

  // The "server tells" push channel: the bridge nudges us whenever it persists a
  // list-affecting change (message / rename / delete / viewed PATCH — including
  // ones from other devices, the TUI, cron, or background agents) and we pull a
  // fresh list in response. Held open app-wide for the same reason as the
  // activity feed above.
  useEffect(() => {
    connectSessionsDirtyFeed();
    return () => { disconnectSessionsDirtyFeed(); };
  }, []);

  // Sorted session-id string — stable across counter-tick frames that don't
  // add or remove sessions. Zustand compares with Object.is (primitive ===)
  // so this component skips re-renders when only token counts changed.
  const activityBusyKey = useSessionActivityStore(
    (s) => Object.keys(s.sessions).sort().join(','),
  );

  // Bool selectors: return primitive that only changes when the *fact* of
  // "any list entry running" or "any tracked stream active" flips. Keeps
  // this component quiet under steady live load (new list arrays / stream
  // patches arrive but bool stays true).
  const hasListRunning = useSessionStore((s) => s.sessions.some((sess) => sess.isRunning));
  const hasStreamActive = useChatStore((s) =>
    Object.values(s.sessionStreams || {}).some((st) => st.serverActive || st.localLive),
  );

  const anyBusy = useMemo(
    () => activityBusyKey.length > 0 || hasListRunning || hasStreamActive,
    [activityBusyKey, hasListRunning, hasStreamActive],
  );

  // Mirror the activity feed into per-session stream state. The current-session
  // busy indicators (StatusIndicator, the send/stop button via isSessionRunning,
  // ChatInput) read ONLY sessionStreams[id] — never the activity feed — so a
  // session that's live on the server but was never streamed in THIS tab
  // (switched into, or started by the TUI / another tab / an agent) shows no
  // busy state until a racy isRunning / status probe happens to catch it. That
  // race is the "switch in and it forgets it's busy until I reload" report:
  // switchTo()'s detachStream leaves the target's stream state untouched when
  // this tab holds no controller, and the isRunning/status seeds can miss
  // (go-core's active-stream cache has a 500 ms TTL). The feed is the
  // authoritative real-time presence signal and is already held open app-wide
  // above, so fold it into sessionStreams: any session it reports live gets
  // serverActive seeded, which lights every indicator AND lets AppEffects
  // reconnect the stream so live tokens resume — no reload.
  //
  // SET-only: never clears here. Clearing stays owned by fetchList()'s
  // hysteresis-protected reconcile (+ the go-core _end unregister), so a brief
  // between-turns gap in the feed can't flicker the indicator off. Keyed on
  // feed MEMBERSHIP (not per-frame counters) + currentId so a Stop — which
  // drops serverActive while go-core finishes finalizing — isn't re-seeded
  // before the session leaves the feed; the `stopped` guard belts-and-braces
  // the same window.
  useEffect(() => {
    const activity = useSessionActivityStore.getState().sessions;
    const streams = useChatStore.getState().sessionStreams || {};
    for (const sid of Object.keys(activity)) {
      const local = streams[sid];
      if (
        local &&
        (local.localLive || local.reconnecting || local.serverActive || local.status === 'stopped')
      ) {
        continue;
      }
      chatStreaming.setKnownStreamStatus(sid, { active: true, status: 'streaming' });
    }
  }, [activityBusyKey, currentId]);

  // A session started or stopped streaming (maybe one this tab has never seen).
  // Pull a fresh list so ordering / unread / existence react immediately. The
  // mount render is covered by the cadence effect's immediate poll below, so
  // skip the first run here to avoid a duplicate fetch.
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    void session?.fetchList?.();
  }, [activityBusyKey]);

  useEffect(() => {
    async function poll() {
      try { await session?.fetchList?.(); } catch (_) {}
      reconcileStuckSessions();
    }
    // Fire one poll immediately on mount AND whenever the cadence flips
    // (e.g. a stream just started → switch from 30 s to 4 s). The previous
    // setInterval-only setup waited a full interval before the first refresh,
    // so just-finished streams kept showing the busy dot for 30 s.
    poll();
    const interval = anyBusy ? BUSY_POLL_MS : IDLE_POLL_MS;
    const id = setInterval(poll, interval);
    return () => clearInterval(id);
  }, [anyBusy]);

  return null;
}
