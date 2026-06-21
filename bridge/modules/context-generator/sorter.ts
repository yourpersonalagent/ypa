// ── Context Sorter / Wiki-Generator (barrel) ─────────────────────────────────
// Phase 2 of the ContextGenerator pipeline. Implementation lives in
// `./sorter/<submodule>.ts`; this file is a CommonJS barrel that re-exports
// the public API so external callers (server.ts, config/handler.ts,
// routes/context-items.ts, file-categorizer.ts, categorizer.ts) keep working
// against the same `require('./context/sorter')` entry point.
//
// Sub-layout:
//   constants.ts    — pure constants + paths (no state)
//   util.ts         — slug / fingerprint / yaml helpers (pure)
//   slug-graph.ts   — related-map + JSON context-graph builder/reader
//   render-pages.ts — Markdown page renderers (pure strings)
//   file-io.ts      — atomic-write + keep-notes frontmatter walker
//   batch.ts        — candidate selection + index-member collection
//   runner.ts       — singleton state, _runLoop, _startProcess, public lifecycle
//   admin.ts        — getSorterStatus / runNow / forceRebuild / skip-stuck UX
//
// Contract: every name listed in the original `module.exports` (the legacy
// monolithic sorter.ts as of 2026-05-07) is re-exported here unchanged.
'use strict';

const constants    = require('./sorter/constants');
const util         = require('./sorter/util');
const slugGraph    = require('./sorter/slug-graph');
const renderPages  = require('./sorter/render-pages');
const runner       = require('./sorter/runner');
const admin        = require('./sorter/admin');

module.exports = {
  startContextSorterWorker: runner.startContextSorterWorker,
  stopContextSorterWorker:  runner.stopContextSorterWorker,
  scanAndEnqueueOnStartup:  runner.scanAndEnqueueOnStartup,
  enqueueForSort:           runner.enqueueForSort,
  getSorterStatus:          admin.getSorterStatus,
  isClear:                  runner.isClear,
  kickSorter:               runner.kickSorter,
  runNow:                   admin.runNow,
  forceRebuild:             admin.forceRebuild,
  readContextGraph:         slugGraph.readContextGraph,
  buildLiveContextGraph:    slugGraph.buildLiveContextGraph,
  CONTEXT_GRAPH_PATH:       constants.CONTEXT_GRAPH_PATH,
  // Phase 5.3 — stuck-session UX
  skipStuck:                admin.skipStuck,
  forceRetryAbandoned:      admin.forceRetryAbandoned,
  getDebugInfo:             admin.getDebugInfo,
  // Exposed for tests / smoke checks:
  _slugify:                 util._slugify,
  _sessionTypePrefix:       util._sessionTypePrefix,
  _quarterFromTs:           util._quarterFromTs,
  _fingerprint:             util._fingerprint,
  _computeAllSlugs:         slugGraph._computeAllSlugs,
  _computeRelatedMap:       slugGraph._computeRelatedMap,
  _relatedKey:              util._relatedKey,
  _renderSessionPage:       renderPages._renderSessionPage,
  DOCS_GENERATED_ROOT:      constants.DOCS_GENERATED_ROOT,
};
