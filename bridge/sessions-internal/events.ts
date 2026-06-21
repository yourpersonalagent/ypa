// ── Session-list change bus ──────────────────────────────────────────────────
// Process-global EventEmitter for SESSION-LIST METADATA changes (names,
// ordering, unread/viewed, message count, existence) — NOT stream content.
//
// Emitted from the persistence commit chokepoints (saveSessionToDisk /
// flushSessionToDisk / deleteSessionFile) so any persisted message, rename,
// delete, or viewed/unread PATCH produces a signal. Consumed by the
// GET /v1/sessions/events SSE route (routes/sessions.ts), which fans it out to
// connected web clients as a "refetch the list" hint: the server says
// something changed, the client confirms by re-pulling /v1/sessions/. This is
// the push half of that contract.
//
// Kept as a dependency-free leaf module so persistence.ts and the route file
// can both require it without an import cycle.
'use strict';

const { EventEmitter } = require('events');

const sessionsEvents = new EventEmitter();
// The SSE route attaches a single 'dirty' listener at module load; this ceiling
// is just headroom for any future consumer so we never trip Node's default
// max-listeners warning.
sessionsEvents.setMaxListeners(32);

// Fire-and-forget: a notification must never break the disk write that triggered
// it, so swallow any listener error here rather than let it propagate back into
// the persistence call site.
function emitSessionsDirty(payload = {}) {
  try {
    sessionsEvents.emit('dirty', payload || {});
  } catch (_) {
    /* never let a notify failure break a persistence write */
  }
}

module.exports = { sessionsEvents, emitSessionsDirty };
