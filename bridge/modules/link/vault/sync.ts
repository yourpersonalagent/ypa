// ── LINK Sync Engine — Barrel ────────────────────────────────────────────────
// Phase 3.1c of the ContextGenerator pipeline. The original 1106-LOC
// implementation now lives split across `sync-{constants,secrets,state,
// policy,folder,runner,import}.ts`. This file re-exports the public
// surface so external callers (`routes/link.ts`, `server.ts`) keep working
// unchanged.
'use strict';

const { STATE_PATH, SECRETS_FILE }                      = require('./sync-constants');
const { writeLinkSecret, maskedLinkSecret }             = require('./sync-secrets');
const { _readState, _readSensitivityFromContent }       = require('./sync-state');
const { _isPushAllowed }                                = require('./sync-policy');
const {
  startLinkWorker,
  stopLinkWorker,
  kickLink,
  runNow,
  isClear,
  getLinkStatus,
  pingAdapterNow,
  _runOnce,
} = require('./sync-runner');
const { importVaultFolder }                             = require('./sync-import');

module.exports = {
  startLinkWorker,
  stopLinkWorker,
  kickLink,
  runNow,
  isClear,
  getLinkStatus,
  pingAdapterNow,
  importVaultFolder,
  writeLinkSecret,
  maskedLinkSecret,
  // Exposed for tests:
  _runOnce,
  _readState,
  _isPushAllowed,
  _readSensitivityFromContent,
  STATE_PATH,
  SECRETS_FILE,
};
