// ── context-rag file watcher ──────────────────────────────────────────────────
// Recursive fs.watch on every DB root whose source.files.watch is true.
// Coalesces bursts via a per-path debounce window, then hands paths off to
// `enqueueFileForRag()`. The rest of the pipeline (matchFile, sensitivity
// gate, embed, upsert) is the same as the boot-scan path.
//
// Why fs.watch (not chokidar): we don't ship chokidar in bridge already and
// adding 80+ files of polyfills for a feature that only matters on dev
// machines isn't worth it. fs.watch's known quirks (event coalescing, no
// recursive on linux <4.7) are handled here.
//
// Linux recursion: Node's fs.watch is non-recursive on linux. We fall back
// to a re-scan-on-directory-change approach: when a top-level dir emits a
// change event, we walk it. This is heavier than chokidar but ok for the
// "active CWD" Q-A=c slice (one watched root per session, usually small).
'use strict';

const fs     = require('fs');
const path   = require('path');
const os     = require('os');
const logger = require('../../../../core/logger');

import { enqueueFileForRag } from './files';
import { listDbs } from '../registry/store';
import { scanAndEnqueueForDb } from './file-walker';
import {
  HARDCODED_SKIP_DIRS,
  HARDCODED_SKIP_SUFFIXES,
} from './file-walker';

const DEBOUNCE_MS = 750;
/** Resync the whole root if we see this many distinct paths within
 *  a debounce window — cheaper than chasing every individual event. */
const RESYNC_BURST_THRESHOLD = 20;
const IS_LINUX = os.platform() === 'linux';

interface ActiveWatcher {
  dbId: string;
  root: string;
  /** fs.watch handle, or array thereof when we polyfilled recursion on Linux
   *  by attaching one watcher per subdir. */
  handles: any[];
  pendingPaths: Set<string>;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

const _active = new Map<string, ActiveWatcher>(); // key = `${dbId}:${root}`

function _isSkippableFile(name: string): boolean {
  if (name === '.DS_Store') return true;
  const lower = name.toLowerCase();
  for (const suf of HARDCODED_SKIP_SUFFIXES) {
    if (lower.endsWith(suf)) return true;
  }
  return false;
}

function _isSkippableSegment(seg: string): boolean {
  if (HARDCODED_SKIP_DIRS.has(seg)) return true;
  if (seg.startsWith('.') && seg !== '.' && seg !== '..') return true;
  return false;
}

function _relUnderRoot(root: string, abs: string): string | null {
  const r = root.replace(/\/+$/, '');
  if (abs === r) return '';
  if (!abs.startsWith(r + '/')) return null;
  return abs.slice(r.length + 1);
}

function _shouldDropEvent(rel: string): boolean {
  if (!rel) return true; // root-level event with no name — ignore
  const segs = rel.split('/');
  for (const s of segs) {
    if (_isSkippableSegment(s)) return true;
  }
  // The last segment can also be a file with a skipped suffix.
  const last = segs[segs.length - 1];
  if (_isSkippableFile(last)) return true;
  return false;
}

function _scheduleFlush(w: ActiveWatcher): void {
  if (w.flushTimer) return;
  w.flushTimer = setTimeout(() => {
    w.flushTimer = null;
    const paths = Array.from(w.pendingPaths);
    w.pendingPaths.clear();
    if (paths.length === 0) return;
    if (paths.length >= RESYNC_BURST_THRESHOLD) {
      logger.info('context-rag.file-watcher.burst-resync', {
        dbId: w.dbId, root: w.root, paths: paths.length,
      });
      try { scanAndEnqueueForDb(w.dbId); } catch (e) {
        logger.warn('context-rag.file-watcher.resync-failed', {
          dbId: w.dbId, error: e instanceof Error ? e.message : String(e),
        });
      }
      return;
    }
    let enqueued = 0;
    for (const p of paths) {
      if (enqueueFileForRag(p, 'fs-change')) enqueued++;
    }
    if (enqueued > 0) {
      logger.info('context-rag.file-watcher.enqueued', {
        dbId: w.dbId, root: w.root, enqueued, eventCount: paths.length,
      });
      // Surface a runner kick so the watcher isn't blocked behind the 3-min
      // watchdog tick for changes the user is actively making.
      try {
        const { kickContextRag } = require('./runner');
        if (typeof kickContextRag === 'function') kickContextRag();
      } catch (_) { /* runner not loaded yet — fine, watchdog will catch up */ }
    }
  }, DEBOUNCE_MS);
}

function _onEvent(w: ActiveWatcher, _evt: string, filename: string | null): void {
  if (!filename) return;
  // fs.watch hands us a path RELATIVE to the watched dir, not the root.
  // We can't reliably reconstruct the abs path without knowing which
  // sub-watcher fired. Caller passes the right base.
  // For root-level watchers, filename IS relative to the root.
  const abs = path.join(w.root, filename);
  const rel = _relUnderRoot(w.root, abs);
  if (rel === null) return;
  if (_shouldDropEvent(rel)) return;
  w.pendingPaths.add(abs);
  _scheduleFlush(w);
}

function _onSubdirEvent(w: ActiveWatcher, subdir: string, _evt: string, filename: string | null): void {
  if (!filename) return;
  const abs = path.join(subdir, filename);
  const rel = _relUnderRoot(w.root, abs);
  if (rel === null) return;
  if (_shouldDropEvent(rel)) return;
  w.pendingPaths.add(abs);
  _scheduleFlush(w);
}

function _walkSubdirs(root: string): string[] {
  const dirs: string[] = [root];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: any[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (_isSkippableSegment(e.name)) continue;
      const full = path.join(dir, e.name);
      dirs.push(full);
      stack.push(full);
    }
  }
  return dirs;
}

function _startWatch(dbId: string, root: string): ActiveWatcher | null {
  const key = `${dbId}:${root}`;
  if (_active.has(key)) return _active.get(key)!;
  let rootStat: any;
  try {
    rootStat = fs.statSync(root);
  } catch {
    logger.warn('context-rag.file-watcher.root-missing', { dbId, root });
    return null;
  }
  if (!rootStat.isDirectory()) return null;

  const w: ActiveWatcher = {
    dbId, root, handles: [], pendingPaths: new Set(), flushTimer: null,
  };

  try {
    if (!IS_LINUX) {
      // macOS / Windows support recursive watch natively.
      const h = fs.watch(root, { recursive: true }, (evt: string, fname: string | null) => _onEvent(w, evt, fname));
      h.on?.('error', (err: any) => {
        logger.warn('context-rag.file-watcher.error', { dbId, root, error: err?.message });
      });
      w.handles.push(h);
    } else {
      // Linux fallback: one non-recursive watcher per subdir.
      const dirs = _walkSubdirs(root);
      for (const d of dirs) {
        try {
          const h = fs.watch(d, (evt: string, fname: string | null) => _onSubdirEvent(w, d, evt, fname));
          h.on?.('error', (err: any) => {
            logger.warn('context-rag.file-watcher.error', { dbId, root, dir: d, error: err?.message });
          });
          w.handles.push(h);
        } catch (e) {
          // EMFILE on a very deep tree — log once and move on; the watcher
          // will still cover the dirs it could attach to.
          logger.warn('context-rag.file-watcher.attach-failed', {
            dbId, root, dir: d, error: e instanceof Error ? e.message : String(e),
          });
        }
      }
    }
  } catch (e) {
    logger.warn('context-rag.file-watcher.start-failed', {
      dbId, root, error: e instanceof Error ? e.message : String(e),
    });
    return null;
  }

  _active.set(key, w);
  logger.info('context-rag.file-watcher.started', {
    dbId, root, handles: w.handles.length, linuxFallback: IS_LINUX,
  });
  return w;
}

function _stopWatch(key: string): void {
  const w = _active.get(key);
  if (!w) return;
  for (const h of w.handles) {
    try { h.close?.(); } catch (_) { /* ignore */ }
  }
  if (w.flushTimer) { clearTimeout(w.flushTimer); w.flushTimer = null; }
  _active.delete(key);
  logger.info('context-rag.file-watcher.stopped', { dbId: w.dbId, root: w.root });
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Reconcile active watchers with the current registry. Called on boot and
 *  whenever the registry changes (DB created / deleted / source flipped).
 *  Idempotent — already-active watchers are left alone. */
function reconcileWatchers(): void {
  const desired = new Map<string, { dbId: string; root: string }>();
  for (const db of listDbs()) {
    const f = db.source.files;
    if (!f || f.mode === 'off') continue;
    if (!f.watch) continue;
    if (f.mode === 'cwd' && f.cwd) {
      desired.set(`${db.id}:${f.cwd}`, { dbId: db.id, root: f.cwd });
    } else if (f.mode === 'roots' && Array.isArray(f.roots)) {
      for (const r of f.roots) {
        desired.set(`${db.id}:${r}`, { dbId: db.id, root: r });
      }
    }
  }
  // Stop watchers that are no longer desired.
  for (const key of Array.from(_active.keys())) {
    if (!desired.has(key)) _stopWatch(key);
  }
  // Start watchers that are newly desired.
  for (const [key, spec] of desired) {
    if (!_active.has(key)) _startWatch(spec.dbId, spec.root);
  }
}

function stopAllWatchers(): void {
  for (const key of Array.from(_active.keys())) _stopWatch(key);
}

function activeWatcherCount(): number {
  return _active.size;
}

export {
  reconcileWatchers,
  stopAllWatchers,
  activeWatcherCount,
  DEBOUNCE_MS,
  RESYNC_BURST_THRESHOLD,
};
