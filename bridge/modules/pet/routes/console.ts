// ── /v1/pet-console/* — Quick-chat console for the floating pet ──────────────
// Phase 1.5a of the ContextGenerator pipeline.
//
//   POST /v1/pet-console/ask     — { input, history? } → { ok, answer, … }
//   GET  /v1/pet-console/status  — health snapshot (configured? which model?)
//
// Why two endpoints and not a single combined one:
//   • Status is polled by the Hub Generator tab (see ContextHub) to surface
//     whether the cheap-model lane is alive without sending real traffic.
//   • Ask is rate-limited indirectly via the global apiWriteLimiter — no
//     per-pet limit because the pet is single-user and a panicked button-mash
//     hits the upstream timeout before it strains anything local.
'use strict';

function registerPetConsoleRoutes(app): void {
  const petConsole = require('../lib/console');

  // ── POST /v1/pet-console/ask ─────────────────────────────────────────────
  // Body: { input: string, history?: { role: 'user'|'assistant', text: string }[] }
  // The frontend keeps the rolling 5-turn history in-memory and forwards it
  // each time so the bridge stays stateless w.r.t. the pet conversation.
  app.post('/v1/pet-console/ask', async (req, res) => {
    const input = String(req.body?.input || '');
    if (!input.trim()) {
      return res.status(400).json({ ok: false, error: 'input required' });
    }
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    // Per-request model/provider/caps override forwarded by the frontend's
    // PetQuickChatSection (the 🐾 Pet Chat popover block). Validated in
    // pet-console.ts; we just pass-through here.
    const override =
      req.body && typeof req.body === 'object' && req.body.override && typeof req.body.override === 'object'
        ? req.body.override
        : undefined;
    // Pet session id (yha.pet.chat.sessionId) — when present, pet-console.ts
    // appends both the user input and the assistant answer to the session via
    // pushDisplayMsg() so the pet conversation actually persists. When absent
    // the pet stays ephemeral (legacy behaviour, in-memory frontend history
    // only). We sanity-check the type but leave existence/validity to the
    // sessions module — pushDisplayMsg auto-creates sessions on first message.
    const sessionId = typeof req.body?.sessionId === 'string' && req.body.sessionId.trim()
      ? req.body.sessionId.trim()
      : undefined;
    try {
      const r = await petConsole.ask({ input, history, override, sessionId });
      // Surface upstream error as a 502 so the frontend can react with a
      // "model offline" badge — but keep the JSON shape the same so the UI
      // can read .error either way without branching on status.
      if (!r.ok) {
        return res.status(502).json(r);
      }
      return res.json(r);
    } catch (e) {
      return res.status(500).json({
        ok:    false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  // ── GET /v1/pet-console/status ───────────────────────────────────────────
  // Cheap, sync — just inspects config. Used by the Hub Generator tab and the
  // pet console's "model" sub-line.
  app.get('/v1/pet-console/status', (_req, res) => {
    res.json({ ok: true, ...petConsole.getStatus() });
  });
}

module.exports = { registerPetConsoleRoutes };
