// ── Chat route registration (Phase 7: /v1/stream/ removed) ────────────────────
//
// Phase 7 of the GO-Ownership plan deleted the Node-side POST /v1/stream/
// chat handler. The frontend now POSTs to Go's /v1/stream-direct/ for every
// model/harness path, and Go's in-process adapter ladder
// (claude-binary, codex, openclaw, hermes, broadcast, direct-api) is
// default-on with per-label YHA_GO_<UPPER>=0 opt-outs.
//
// What used to live here was a ~900-line dispatcher that fanned a single
// POST across direct-api / external-llm / claude-binary / claude-sdk /
// codex / hermes-partner / openclaw-partner / broadcast. All of that is
// now inside go-core/internal/stream and go-core/internal/harness/*.
//
// This file remains the registration entry point only so the boot sequence
// in bridge/server.ts (`registerChatRoutes(app)`) keeps working. It
// forwards to the still-Node-owned session lifecycle routes (status, stop,
// detach, btw — see chat-lifecycle.ts).
'use strict';

const { registerChatLifecycleRoutes } = require('../routes/chat-lifecycle');

function registerChatRoutes(app) {
  registerChatLifecycleRoutes(app);
}

module.exports = {
  registerChatRoutes,
};
