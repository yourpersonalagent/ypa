// ── context-rag (slot-2 chain leg) barrel ─────────────────────────────────────
// Public surface for the rest of the bridge:
//   - lifecycle:  startContextRagWorker / stopContextRagWorker
//   - chain:      kickContextRag (called by auto-title end-of-loop),
//                 isClear (surfaced to any future downstream leg)
//   - producers:  enqueueForRag (sessions kind, called by chain),
//                 plus the same hook on the queue for files/knowledge
//                 producers (wired in step 10)
//   - admin:      scanAndEnqueueOnStartup, getStatus, runNow
//
// The module loader instantiates this file via the parent context-generator
// module's `activate(ctx)` — see ../index.ts.
'use strict';

const runner           = require('./ingest/runner');
const sessions         = require('./ingest/sessions');
const files            = require('./ingest/files');
const fileWalker       = require('./ingest/file-walker');
const fileWatcher      = require('./ingest/file-watcher');
const knowledge        = require('./ingest/knowledge');
const knowledgeWatcher = require('./ingest/knowledge-watcher');
const synthesis        = require('./ingest/synthesis');
const queue            = require('./ingest/queue');
const query            = require('./retrieve/query');
const autoRoute        = require('./retrieve/auto-route');
const dbInstance       = require('./vector-store/db-instance');

module.exports = {
  // Lifecycle
  startContextRagWorker:   runner.startContextRagWorker,
  stopContextRagWorker:    runner.stopContextRagWorker,
  scanAndEnqueueOnStartup: runner.scanAndEnqueueOnStartup,

  // Chain
  kickContextRag:          runner.kickContextRag,
  isClear:                 runner.isClear,

  // Producers
  enqueueForRag:           sessions.enqueueForRag,
  enqueueFileForRag:       files.enqueueFileForRag,
  enqueueKnowledgeForRag:  knowledge.enqueueKnowledgeForRag,
  scanAndEnqueueAllFileDbs: fileWalker.scanAndEnqueueAllFileDbs,
  scanAndEnqueueForDb:     fileWalker.scanAndEnqueueForDb,
  scanAndEnqueueAllKnowledgeDbs: knowledge.scanAndEnqueueAllKnowledgeDbs,
  enqueueSynthesisForRag:    synthesis.enqueueSynthesisForRag,
  scanAndEnqueueAllSynthesisDbs: synthesis.scanAndEnqueueAllSynthesisDbs,
  bucketDirForCwd:           synthesis.bucketDirForCwd,
  reconcileWatchers:       fileWatcher.reconcileWatchers,
  stopAllWatchers:         fileWatcher.stopAllWatchers,
  activeWatcherCount:      fileWatcher.activeWatcherCount,
  reconcileKnowledgeWatcher: knowledgeWatcher.reconcileKnowledgeWatcher,
  stopKnowledgeWatcher:    knowledgeWatcher.stopKnowledgeWatcher,
  isKnowledgeWatcherActive: knowledgeWatcher.isKnowledgeWatcherActive,

  // Retrieve (read path) — called by the chat composer's ⚡ picker
  //  and the MCP `rag_search` tool (wired in step 8).
  searchRag:               query.searchRag,
  routeByIds:              autoRoute.routeByIds,
  routeAll:                autoRoute.routeAll,
  routeFromCwd:            autoRoute.routeFromCwd,

  // Admin / status
  getStatus:               runner.getStatus,
  runNow:                  runner.runNow,
  verifyIntegrity:         dbInstance.verifyIntegrity,

  // Test-only / internal surface
  _queue:                  queue,
};
