// ── context-rag knowledge watcher ─────────────────────────────────────────────
// Always-on fs.watch over `docs/keep-notes/` when at least one DB has
// `knowledge.mode === 'all'`. Unlike the file-watcher, knowledge is a single
// shared corpus (one dir on disk, binary include/exclude per DB), so the
// watcher is also single-instance: one handle, N consuming DBs.
//
// Why fs.watch (not opt-in): the corpus is small (tens to low-thousands of
// notes) and the writer surface is wide — vault-import, LINK sync,
// file-categorizer, admin frontmatter, manual user edits. Hooking each
// writer individually is brittle; a single watcher catches them all,
// including the human-in-the-loop case. Debounced 750ms; bursts trigger a
// full re-scan (covers cases like an Obsidian vault re-sync that touches
// hundreds of files at once).
'use strict';

const fs     = require('fs');
const path   = require('path');
const logger = require('../../../../core/logger');

import { enqueueKnowledgeForRag, scanAndEnqueueAllKnowledgeDbs, KEEP_NOTES_DIR } from './knowledge';
import { anyDbWantsKnowledge } from '../registry/matcher';

const DEBOUNCE_MS = 750;
const RESYNC_BURST_THRESHOLD = 20;

interface ActiveKnowledgeWatcher {
  handle: any;
  pendingPaths: Set<string>;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

let _active: ActiveKnowledgeWatcher | null = null;

function _scheduleFlush(): void {
  if (!_active || _active.flushTimer) return;
  _active.flushTimer = setTimeout(() => {
    if (!_active) return;
    _active.flushTimer = null;
    const paths = Array.from(_active.pendingPaths);
    _active.pendingPaths.clear();
    if (paths.length === 0) return;
    if (paths.length >= RESYNC_BURST_THRESHOLD) {
      logger.info('context-rag.knowledge-watcher.burst-resync', { paths: paths.length });
      try { scanAndEnqueueAllKnowledgeDbs(); } catch (e) {
        logger.warn('context-rag.knowledge-watcher.resync-failed', {
          error: e instanceof Error ? e.message : String(e),
        });
      }
      _kickRunner();
      return;
    }
    let enqueued = 0;
    for (const p of paths) {
      if (enqueueKnowledgeForRag(p, 'fs-change')) enqueued++;
    }
    if (enqueued > 0) {
      logger.info('context-rag.knowledge-watcher.enqueued', {
        enqueued, eventCount: paths.length,
      });
      _kickRunner();
    }
  }, DEBOUNCE_MS);
}

function _kickRunner(): void {
  try {
    const { kickContextRag } = require('./runner');
    if (typeof kickContextRag === 'function') kickContextRag();
  } catch (_) { /* runner not loaded — watchdog catches up */ }
}

function _onEvent(_evt: string, filename: string | null): void {
  if (!_active) return;
  if (!filename) return;
  // Skip hidden + non-md.
  if (filename.startsWith('.') || filename.startsWith('_')) return;
  if (!filename.endsWith('.md')) return;
  const abs = path.join(KEEP_NOTES_DIR, filename);
  _active.pendingPaths.add(abs);
  _scheduleFlush();
}

/** Idempotent: starts the watcher if at least one DB wants knowledge AND
 *  no watcher is active; stops it if the registry no longer wants knowledge. */
function reconcileKnowledgeWatcher(): void {
  const want = anyDbWantsKnowledge();
  if (!want) {
    if (_active) stopKnowledgeWatcher();
    return;
  }
  if (_active) return;
  // Ensure the directory exists before watching — fs.watch on a missing
  // path throws ENOENT. The boot scan handles the same case gracefully.
  try {
    fs.mkdirSync(KEEP_NOTES_DIR, { recursive: true });
  } catch (e) {
    logger.warn('context-rag.knowledge-watcher.mkdir-failed', {
      path: KEEP_NOTES_DIR, error: e instanceof Error ? e.message : String(e),
    });
    return;
  }
  let handle: any;
  try {
    // Shallow watch — keep-notes is a flat dir (per the QuickPicker's
    // `_scanFileCategory` shallow read). If that ever changes, this should
    // grow `{recursive: true}` to match.
    handle = fs.watch(KEEP_NOTES_DIR, (evt: string, fname: string | null) => _onEvent(evt, fname));
    handle.on?.('error', (err: any) => {
      logger.warn('context-rag.knowledge-watcher.error', { error: err?.message });
    });
  } catch (e) {
    logger.warn('context-rag.knowledge-watcher.start-failed', {
      error: e instanceof Error ? e.message : String(e),
    });
    return;
  }
  _active = {
    handle,
    pendingPaths: new Set(),
    flushTimer: null,
  };
  logger.info('context-rag.knowledge-watcher.started', { root: KEEP_NOTES_DIR });
}

function stopKnowledgeWatcher(): void {
  if (!_active) return;
  try { _active.handle.close?.(); } catch (_) { /* ignore */ }
  if (_active.flushTimer) { clearTimeout(_active.flushTimer); _active.flushTimer = null; }
  _active = null;
  logger.info('context-rag.knowledge-watcher.stopped');
}

function isKnowledgeWatcherActive(): boolean {
  return _active !== null;
}

export {
  reconcileKnowledgeWatcher,
  stopKnowledgeWatcher,
  isKnowledgeWatcherActive,
  DEBOUNCE_MS,
  RESYNC_BURST_THRESHOLD,
};
