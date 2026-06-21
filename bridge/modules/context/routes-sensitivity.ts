// ── /v1/context/items/:id/sensitivity & /v1/context/sensitivity/confirm ──────
// Phase 1a / Adaption 6 of the ContextGenerator pipeline.
//
// Two surface area concerns:
//   1. Persisting a tier override on a context item (manual user choice).
//   2. Maintaining the in-memory whitelist that the read endpoints consult to
//      decide whether to release content for a non-public item.
//
// Item-id format (forward-compatible):
//   "session:<sid>"  → live session in displaySessions; written to session JSON
//   "file:<...>"     → reserved for Phase 2/3 (notes/, mail/, calendar/)
//
// Whitelist persistence: server-memory only, 30-min TTL for `scope: 'session'`,
// single-use for `scope: 'once'`. Cleared on bridge restart by design — see
// .ContextGenerator.MD §8 ("Sensitivity Whitelist-Persistenz").
'use strict';

const VALID_TIERS = new Set(['public', 'private', 'system']);

// Parse "session:abc-123" → { kind: 'session', ref: 'abc-123' } and similar.
// Unknown kinds return null so the caller can 400 cleanly.
function _parseItemId(id: string): { kind: 'session' | 'file'; ref: string } | null {
  if (!id || typeof id !== 'string') return null;
  const m = /^(session|file):(.+)$/.exec(id);
  if (!m) return null;
  return { kind: m[1] as 'session' | 'file', ref: m[2] };
}

function registerContextSensitivityRoutes(app): void {
  // ── PATCH /v1/context/items/:id/sensitivity ─────────────────────────────────
  // Body: { sensitivity: 'public' | 'private' | 'system' }
  // Sets `sensitivity` on the target item with `sensitivitySource: 'user'`,
  // which is the highest-priority source — auto-detection will never override.
  app.patch('/v1/context/items/:id/sensitivity', (req, res) => {
    const parsed = _parseItemId(req.params.id);
    if (!parsed) {
      return res.status(400).json({ success: false, error: 'invalid item id (expected session:<sid> or file:<path>)' });
    }
    const tier = String(req.body?.sensitivity || '').toLowerCase();
    if (!VALID_TIERS.has(tier)) {
      return res.status(400).json({ success: false, error: 'sensitivity must be one of public, private, system' });
    }

    if (parsed.kind === 'session') {
      const { displaySessions } = require('./../../core/state');
      const { saveSessionToDisk } = require('./../../sessions-internal/persistence');
      const s = displaySessions.get(parsed.ref);
      if (!s) return res.status(404).json({ success: false, error: 'session not found' });
      s.sensitivity        = tier;
      s.sensitivitySource  = 'user';
      s.sensitivityAt      = Date.now();
      saveSessionToDisk(parsed.ref);
      // Broadcast so any open Hub/Picker UI reflects the change live.
      try {
        const { broadcastEvent } = require('./../workflows-and-triggers/triggers');
        broadcastEvent('context:sensitivity-changed', {
          itemId:      req.params.id,
          sensitivity: tier,
          source:      'user',
        });
      } catch (_) { /* non-fatal */ }
      return res.json({ success: true, itemId: req.params.id, sensitivity: tier, source: 'user' });
    }

    // File-targeted overrides arrive in Phase 2 (sidecar JSON / frontmatter).
    return res.status(501).json({
      success: false,
      error:   'file: sensitivity overrides not implemented yet (Phase 2)',
    });
  });

  // ── POST /v1/context/sensitivity/confirm ────────────────────────────────────
  // Body: { itemId: string, scope: 'once' | 'session' }
  // Adds the item to the in-memory whitelist. The read endpoints (e.g.
  // /v1/context/file) consult `checkAndConsumeWhitelist(itemId)` before
  // releasing content for a non-public item.
  app.post('/v1/context/sensitivity/confirm', (req, res) => {
    const itemId = String(req.body?.itemId || '');
    const scope  = String(req.body?.scope  || 'once');
    if (!itemId) return res.status(400).json({ success: false, error: 'itemId required' });
    if (scope !== 'once' && scope !== 'session') {
      return res.status(400).json({ success: false, error: 'scope must be "once" or "session"' });
    }
    const sensitivity = require('../context-generator/sensitivity');
    const entry = sensitivity.addWhitelistEntry(itemId, scope);
    return res.json({
      success:   true,
      itemId,
      scope,
      // 0 = single-use; otherwise epoch-ms when the entry expires.
      expiresAt: entry.expiresAt,
    });
  });

  // ── DELETE /v1/context/sensitivity/confirm ──────────────────────────────────
  // Operator/test escape hatch: drop the whitelist entirely. Useful when a
  // user "locks" the session manually (e.g. before lunch break).
  app.delete('/v1/context/sensitivity/confirm', (_req, res) => {
    const sensitivity = require('../context-generator/sensitivity');
    sensitivity.clearWhitelist();
    res.json({ success: true });
  });

  // ── GET /v1/context/sensitivity/whitelist ───────────────────────────────────
  // Diagnostic — returns the live size of the whitelist (no item-id leak).
  // Used by the Hub Settings tab to show "X items unlocked for the next Y min".
  app.get('/v1/context/sensitivity/whitelist', (_req, res) => {
    const sensitivity = require('../context-generator/sensitivity');
    res.json({
      success:   true,
      size:      sensitivity.whitelistSize(),
      ttlMs:     sensitivity.SESSION_TTL_MS,
    });
  });
}

module.exports = { registerContextSensitivityRoutes };
