// ── Mention-forward chain ─────────────────────────────────────────────────────
// When a participant's assistant reply begins with `@anotherParticipant ...`,
// we re-dispatch the remainder to that participant as if the user had typed
// it. Hop count is bounded by config.defaults.partnerForwardLimit (default 25)
// so we have an upper limit; the manual stop button is the primary loop guard
// (it aborts the in-flight reply via activeProcesses.killFn).
'use strict';

const { config, displaySessions, activeStreams } = require('../../core/state');
const { getHistory, pushHistory, broadcastChunk } = require('../../sessions-internal');
const { runEmployeeInChain } = require('./runner');
const { parseLeadingMentionToParticipant } = require('../../chat/helpers');

async function runForwardMentionChain(sessionId, firstReplyText, ctxBase) {
  const limitRaw = parseInt(config.defaults?.partnerForwardLimit ?? 25, 10);
  const limit = isNaN(limitRaw) || limitRaw < 1 ? 25 : Math.min(limitRaw, 200);
  let lastReply = firstReplyText || '';
  let hop = 0;
  let totalCost = 0;

  // Single shared history fork for the whole forward chain so each forwarded
  // participant sees the full conversation up to and including the previous
  // forwarded reply.
  const chainHistoryId = `${sessionId}::fwd::${Date.now()}`;
  for (const h of getHistory(sessionId)) pushHistory(chainHistoryId, h.role, h.content);

  while (hop < limit) {
    // User pressed stop: outer stream was finalized to 'error'. Bail.
    const stream = activeStreams.get(sessionId);
    if (!stream || stream.status !== 'streaming') break;

    const session = displaySessions.get(sessionId);
    const next = parseLeadingMentionToParticipant(lastReply, session);
    if (!next) break;
    hop += 1;
    try {
      broadcastChunk(sessionId, {
        mentionForward: { hop, limit, target: next.emp.id, name: next.emp.name },
      });
    } catch (_) {}

    let result;
    try {
      result = await runEmployeeInChain(next.emp, next.cleanInput, hop, chainHistoryId, ctxBase);
    } catch (err) {
      try {
        broadcastChunk(sessionId, { error: err instanceof Error ? err.message : String(err) });
      } catch (_) {}
      break;
    }
    totalCost += result?.cost || 0;
    lastReply = result?.text || '';
    if (!lastReply) break;
  }
  return { hops: hop, cost: totalCost };
}

module.exports = { runForwardMentionChain };
