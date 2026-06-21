// ── Context Categorizer worker (barrel) ──────────────────────────────────────
// Phase 1a / Adaption 3 of the ContextGenerator pipeline. The implementation
// lives in ./categorizer/{constants,extract,llm,runner,admin}.ts — this file
// is a thin re-export so existing callers (`require('./categorizer')`) keep
// working unchanged.
'use strict';

const runner = require('./categorizer/runner');
const admin  = require('./categorizer/admin');
const { VALID_CATEGORIES } = require('./categorizer/constants');

module.exports = {
  startContextCategorizerWorker: runner.startContextCategorizerWorker,
  stopContextCategorizerWorker:  runner.stopContextCategorizerWorker,
  scanAndEnqueueOnStartup:       runner.scanAndEnqueueOnStartup,
  enqueueForCategorization:      runner.enqueueForCategorization,
  getCategorizerStatus:          admin.getCategorizerStatus,
  VALID_CATEGORIES,
  isClear:                       runner.isClear,
  kickCategorizer:               runner.kickCategorizer,
  runNow:                        admin.runNow,
  forceRebuild:                  admin.forceRebuild,
  // Phase 5.1 — stuck-session UX
  skipStuck:                     admin.skipStuck,
  forceRetryAbandoned:           admin.forceRetryAbandoned,
  applyManualCategory:           admin.applyManualCategory,
  getDebugInfo:                  admin.getDebugInfo,
  _countStuckSessions:           admin._countStuckSessions,
};
