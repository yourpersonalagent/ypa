// ── /v1/hash-tool/ route — direct bridge execution of `#<tool> args` ─────────
//
// Restores the pre-Phase-7 behaviour where `#bash ls` typed into chat ran
// the Bash tool immediately and pushed the result into chat history without
// involving a model. The old call site lived in the monolithic
// `bridge/server.js` `/v1/stream/` handler; when that route was deleted in
// Phase 7 the direct-execution path was lost for the frontend (only the
// workflow runner kept calling `handleHashTool`).
//
// This route is intentionally a thin wrapper: it forwards the raw input to
// `handleHashTool()` in `bridge/tools/exec.ts`, which is the dynamic
// registry of "what `#word` means right now" — every built-in tool, every
// Codex alias, and every currently-connected MCP tool. Adding a new tool
// there (or just connecting a new MCP server) makes it reachable from chat
// automatically; no edit to this file or the frontend is required.
//
// Contract: `{ input, sessionId }` → `{ handled: boolean, result?: string }`.
// `handled: false` means `#word` is unknown to the bridge — the frontend is
// expected to fall back to the normal model-driven send in that case.
'use strict';

const { handleHashTool } = require('../tools/exec');
const { pushDisplayMsg } = require('../sessions-internal');
const logger = require('../core/logger');

function registerHashToolRoute(app) {
  app.post('/v1/hash-tool/', async (req, res) => {
    const body = req.body || {};
    const input = typeof body.input === 'string' ? body.input.trim() : '';
    const sessionId = body.sessionId || null;
    if (!input) {
      return res.status(400).json({ handled: false, error: 'input required' });
    }
    try {
      const out = await handleHashTool(input, sessionId);
      // Persist successful hash-tool invocations to session history so they
      // survive page reload. Frontend still renders locally via pushMessage
      // for instant feedback — this is the symmetric write to sessions.db,
      // matching the workflow-runner (workflow-runner.ts) and /v1/command/
      // (command.ts) patterns.
      if (out && out.handled && sessionId) {
        pushDisplayMsg(sessionId, 'user', input);
        pushDisplayMsg(sessionId, 'assistant', String(out.result ?? ''));
      }
      return res.json(out);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error('hash-tool.error', { error: msg });
      if (sessionId) {
        pushDisplayMsg(sessionId, 'user', input);
        pushDisplayMsg(sessionId, 'assistant', `Hash tool error: ${msg}`);
      }
      return res.json({ handled: true, result: `Hash tool error: ${msg}` });
    }
  });
}

module.exports = { registerHashToolRoute };
