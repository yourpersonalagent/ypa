// ── File-Categorizer worker (barrel) ─────────────────────────────────────────
// The implementation lives under `./file-categorizer/`. This barrel preserves
// the historical `require('./context/file-categorizer')` entry-point so all
// existing callers (server.ts, config/handler.ts, sorter.ts, …) keep working
// unchanged. Public API is byte-identical to the pre-split contract.
'use strict';

const { TOPIC_SLUGS } = require('./file-categorizer/constants');
const {
  _parseFrontmatter,
  _writeCategorizerFrontmatter,
  _isUncategorised,
} = require('./file-categorizer/frontmatter');
const {
  startFileCategorizerWorker,
  stopFileCategorizerWorker,
  scanAndEnqueueOnStartup,
  isClear,
  kickFileCategorizer,
} = require('./file-categorizer/runner');
const {
  getFileCategorizerStatus,
  runNow,
  forceRebuild,
  skipStuck,
  forceRetryAbandoned,
  applyManualCategory,
  getDebugInfo,
} = require('./file-categorizer/admin');

module.exports = {
  startFileCategorizerWorker,
  stopFileCategorizerWorker,
  scanAndEnqueueOnStartup,
  getFileCategorizerStatus,
  TOPIC_SLUGS,
  isClear,
  kickFileCategorizer,
  runNow,
  forceRebuild,
  // Phase 5.2 — stuck-file UX
  skipStuck,
  forceRetryAbandoned,
  applyManualCategory,
  getDebugInfo,
  // Exposed for tests:
  _parseFrontmatter,
  _writeCategorizerFrontmatter,
  _isUncategorised,
};
