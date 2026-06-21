// ── Session lifecycle routes: status, stop, intentional-detach ─────────────────
//
// Phase 7 deleted the GET /v1/sessions/:id/stream reattach handler — the
// frontend now reattaches via Go's GET /v1/sessions/:id/stream-direct
// (mounted in go-core/internal/stream/route.go alongside the Pascal-cased
// /v1/sessions/:id/stream pattern that the FE keeps using). The replay
// buffer lives in Go's stream.SessionBuffer.
//
// What remains here is the small set of session-lifecycle endpoints the
// Go side does NOT own yet:
//   - GET  /v1/sessions/:id/status         — quick "is this stream alive"
//   - POST /v1/sessions/:id/stream/detach  — FE flags intentional detach
//                                            so the next close isn't logged
//                                            as a network drop.
//   - POST /v1/stop/:sessionId             — hard stop on an active stream.
'use strict';

const { activeStreams, activeProcesses, displaySessions } = require('../core/state');
const { finalizeStream, markIntentionalDetach, finalizeAbandonedLiveMsgs } = require('../sessions-internal');
const {
  fetchGoActiveSet,
  wasActiveRecently,
  goActiveSnapshotIsAuthoritative,
} = require('../core/go-active-streams');

const _GO_CORE_URL = process.env.YHA_GO_CORE_URL || 'http://127.0.0.1:8443';

function registerChatLifecycleRoutes(app) {
  app.get('/v1/sessions/:id/status', async (req, res) => {
    const sid = req.params.id;
    const stream = activeStreams.get(sid);
    if (stream) {
      return res.json({
        active: stream.status === 'streaming',
        status: stream.status,
        chunksCount: stream.chunks.length,
        textLength: stream.text.length,
        cost: stream.cost,
        error: stream.error,
      });
    }
    // No Node-side entry — could still be a Go-owned stream. Phase 7 moved
    // /v1/stream-direct/ ownership to Go, so for those turns activeStreams
    // is empty here even while the turn is live. /v1/sessions/ already
    // consults Go's active set to populate isRunning; if this endpoint
    // didn't, reconnectStream's per-session status check returned
    // active:false → cleared serverActive → the very next /v1/sessions/
    // poll reseeded it → AppEffects re-triggered reconnect → cleared
    // again. Result: the chat panel flickered between Stop and Send
    // every couple of seconds for the entire duration of a Go-owned
    // turn (especially visible with multiple concurrent running chats
    // keeping the SessionPoller in fast 4-s mode). Asking Go directly
    // makes the two endpoints agree.
    const goActive = await fetchGoActiveSet();
    // Hysteresis: see bridge/core/go-active-streams.ts. Without it,
    // reconnectStream's status check could hit the brief window where
    // Go's active set transiently dropped the session and return
    // active:false → AppEffects cleared serverActive → the next poll
    // reseeded it. Trusting wasActiveRecently keeps the two paths in
    // agreement through short Go-side hiccups.
    if (goActive.has(sid) || wasActiveRecently(sid)) {
      return res.json({ active: true, status: 'streaming', chunksCount: 0 });
    }
    const display = displaySessions.get(sid);
    const hasOldLivePlaceholder = display?.messages?.some((m: any) =>
      m?.streaming && Date.now() - Number(m.ts || 0) > 30_000);
    if (goActiveSnapshotIsAuthoritative() && hasOldLivePlaceholder) {
      // The authoritative owners both report idle. Reconcile any durable
      // streaming placeholder left by a Go/core restart immediately; the
      // hour-long timeout remains only for cases where liveness is unknown.
      finalizeAbandonedLiveMsgs(sid, 'aborted', true);
    }
    return res.json({ active: false });
  });

  // FE signals "I'm about to abort the EventSource on purpose" (session
  // switch / session delete) so the upcoming res.on('close') in the GET
  // /stream-direct replay route — owned by Go since Phase 7 — doesn't get
  // logged as a silent disconnect and doesn't surface a "Connection lost" /
  // "Stream resumed" interrupt block in the persisted chat. Flag is
  // one-shot with a 2 s window: real network drops outside that window still
  // surface normally. fire-and-forget from the FE (no body required).
  app.post('/v1/sessions/:id/stream/detach', (req, res) => {
    const sid = req.params.id;
    const ok = markIntentionalDetach(sid);
    // Forward to Go too — Phase 7 reattach lives in Go's stream-direct route,
    // and the close that consumes the "is this intentional?" flag fires inside
    // Go's subscriber unsub. Without this, Go-owned streams surface phantom
    // "Connection lost" / "Stream resumed" interrupt blocks and bump
    // silentDisconnects on every session switch / delete. Fire-and-forget;
    // Go's handler is idempotent and 2 s windowed. Mirrors sessions.ts:551.
    fetch(`${_GO_CORE_URL}/v1/sessions/${encodeURIComponent(sid)}/stream/detach`, { method: 'POST' }).catch(() => {});
    res.json({ ok });
  });

  app.post('/v1/stop/:sessionId', (req, res) => {
    const sid = req.params.sessionId;
    const entry = activeProcesses.get(sid);
    if (entry) {
      try {
        entry.killFn();
      } catch (_) {}
      activeProcesses.delete(sid);
    }
    // Forward to Go's own /v1/stop too — Phase 7 Go-owned streams aren't in
    // the Node activeProcesses map, so the Node-side kill alone is a no-op
    // for them and the user's Stop click never reaches the live adapter.
    // Fire-and-forget; Go's handler is idempotent. Mirrors sessions.ts:551.
    fetch(`${_GO_CORE_URL}/v1/stop/${encodeURIComponent(sid)}`, { method: 'POST' }).catch(() => {});
    const stream = activeStreams.get(sid);
    if (stream && stream.status === 'streaming') finalizeStream(sid, 'error', { error: 'stopped' });
    // Symmetrical with claudeStreamError: clear streaming=true / _liveToken on
    // any abandoned live message so the picker stops showing the session as
    // running and the next reload doesn't re-normalize it as a server-restart
    // casualty. Without this the in-memory side flips to 'error' but the
    // on-disk message half stays streaming=true until the bridge restarts.
    // force=true: explicit user stop bypasses the 30-min _liveDeadline guard.
    // The guard exists for the background sweep and boot-time normalize to
    // avoid prematurely clearing a turn Go-core might still be working on.
    // On an explicit Stop click the user is telling us to give up now — and
    // we've already fired the Go-side /v1/stop above, so any genuinely-live
    // subprocess is being killed in parallel. Without force, a Stop click
    // landing on a session whose subprocess already died on its own (e.g.
    // post-crash, post-OOM) leaves streaming=1 in the DB until next bridge
    // restart, and the FE keeps showing the Stop button indefinitely.
    finalizeAbandonedLiveMsgs(sid, 'stopped', true);
    res.json({ ok: true, stopped: !!entry });
  });
}

module.exports = { registerChatLifecycleRoutes };
