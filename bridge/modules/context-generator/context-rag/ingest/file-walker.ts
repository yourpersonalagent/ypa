// ── context-rag file walker ───────────────────────────────────────────────────
// Filesystem scanner for the `file` source kind. Walks the root(s) listed in
// each VectorDB's `source.files` filter and enqueues every matching path.
//
// Filters applied (most-specific first):
//
//   1. `.gitignore` — loaded once per encountered git-tree (the first
//      directory in the walk that has a `.gitignore` file establishes the
//      tree; nested `.gitignore` files are NOT honored in v1 — covers 95%
//      of repos without parsing the nested-fallback semantics).
//   2. Registry `ignore[]` — the per-DB list of path fragments to skip
//      (handled by `matchFile()` at enqueue time, not here, but a copy is
//      applied to directory-descent to avoid wasting walk cycles on
//      `node_modules` etc).
//   3. Hardcoded VCS / lockfile / build-output denylist — skipped at
//      directory level (`.git`, `node_modules`, `dist`, `build`, `.next`,
//      `.cache`, `target`, `vendor`, `bun.lockb`). These are dead weight
//      in any embedding corpus.
//   4. File-size cap — handled by `ingestFile()` at consumption time,
//      not here. Walker pretends a 5 MiB file is interesting; the
//      consumer drops it. Keeps walker logic simple.
//
// Walker scope:
//   - mode='cwd'   → walk one root (db.source.files.cwd)
//   - mode='roots' → walk every root in db.source.files.roots
//   - mode='off'   → produces nothing (the runner's `anyDbWantsFiles()`
//                    guard prevents this from being called anyway)
//
// Walking is sync (fs.readdirSync). The file producer runs in slot 2 of the
// chain so blocking the event loop briefly is fine — startup scan over a
// 5k-file repo takes ~30ms on the Pi.
'use strict';

const fs     = require('fs');
const path   = require('path');
const logger = require('../../../../core/logger');

import { enqueueFileForRag } from './files';
import { listDbs } from '../registry/store';
import type { VectorDB } from '../registry/types';

/** Directory names we never descend into. Hard-coded because no real corpus
 *  wants these indexed and putting them in every VectorDB's `ignore[]` is
 *  pure boilerplate. */
const HARDCODED_SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  '.next',
  '.nuxt',
  '.cache',
  '.parcel-cache',
  'dist',
  'build',
  'out',
  'target',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  'coverage',
  '.nyc_output',
  '.terraform',
  '.gradle',
  '.idea',
  '.vscode',
  '.DS_Store',
]);

/** Path fragments (relative to a walked root) that we never descend into,
 *  regardless of basename. Use this when a basename is too broad — e.g.
 *  `rewind` as a basename would skip any user dir called `rewind`, but
 *  `bridge/rewind` is specifically YHA's content-addressed store of edit
 *  snapshots and never wants RAG indexing. */
const HARDCODED_SKIP_RELPATHS = [
  'bridge/rewind',
];

/** File-name-suffix denylist — applied at file level. Same rationale as
 *  HARDCODED_SKIP_DIRS: zero corpus wants these. */
const HARDCODED_SKIP_SUFFIXES = [
  '.lock',
  '.lockb',
  '.bin',
  '.exe',
  '.so',
  '.dylib',
  '.dll',
  '.o',
  '.a',
  '.class',
  '.pyc',
  '.pyo',
  '.jar',
  '.war',
  '.zip',
  '.tar',
  '.gz',
  '.bz2',
  '.7z',
  '.rar',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
  '.svg',
  '.pdf',
  '.mp3',
  '.mp4',
  '.mov',
  '.avi',
  '.mkv',
  '.webm',
  '.wav',
  '.flac',
  '.woff',
  '.woff2',
  '.ttf',
  '.eot',
  '.sqlite',
  '.db',
  '.db-wal',
  '.db-shm',
];

interface ScanStats {
  scanned: number;
  enqueued: number;
  skipped: number;
  walkErrors: number;
}

// ── .gitignore handling ───────────────────────────────────────────────────────

interface GitignoreMatcher {
  root: string;
  /** Compiled fragments. v1 supports plain prefixes, exact basenames, and
   *  `dir/` directory-style entries. No globstar — `*` and `**` are stripped
   *  to a substring match, which over-matches but is safer than missing. */
  patterns: string[];
}

function _loadGitignore(rootDir: string): GitignoreMatcher | null {
  const giPath = path.join(rootDir, '.gitignore');
  let text: string;
  try {
    text = fs.readFileSync(giPath, 'utf8');
  } catch {
    return null;
  }
  const patterns: string[] = [];
  for (const lineRaw of text.split(/\r?\n/)) {
    const line = lineRaw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('!')) continue; // negation patterns not supported in v1
    // Normalize: strip leading slash (everything is rooted), strip trailing
    // slash (we treat dir/ same as dir), strip glob wildcards to their
    // surrounding literal.
    let p = line.replace(/^\/+/, '').replace(/\/+$/, '');
    p = p.replace(/\*\*/g, '').replace(/\*/g, '');
    p = p.trim();
    if (!p) continue;
    patterns.push(p);
  }
  return { root: rootDir, patterns };
}

function _gitignoreSkips(matcher: GitignoreMatcher, relPath: string): boolean {
  if (matcher.patterns.length === 0) return false;
  // Match against the relative path AND each segment — covers both
  // `foo/bar.txt` style globs and bare-name entries.
  const segs = relPath.split('/');
  for (const pat of matcher.patterns) {
    if (relPath === pat) return true;
    if (relPath.startsWith(pat + '/')) return true;
    if (relPath.endsWith('/' + pat)) return true;
    if (relPath.includes('/' + pat + '/')) return true;
    if (segs.includes(pat)) return true;
  }
  return false;
}

// ── Walk one root ─────────────────────────────────────────────────────────────

function _shouldSkipDir(name: string, ignore: readonly string[]): boolean {
  if (HARDCODED_SKIP_DIRS.has(name)) return true;
  if (name.startsWith('.') && name !== '.') {
    // Hidden dirs other than the ones explicitly above — be conservative,
    // skip them. Users who want a hidden dir indexed can name it without
    // a leading dot.
    return true;
  }
  // Q16-migrator backup dirs: `<legacy>.bak-<TS>` (always timestamped for
  // dirs) and `<legacy>.bak` (file form occasionally used). Indexing these
  // re-ingests every legacy snapshot as fresh content, polluting code/notes
  // DBs after every folder move. Tools/migrate-to-users-folder.mjs and any
  // future rename-to-bak operation use this convention.
  if (/\.bak(-.+)?$/.test(name)) return true;
  for (const pat of ignore) {
    if (pat === name) return true;
  }
  return false;
}

function _shouldSkipRelPath(rel: string): boolean {
  for (const pat of HARDCODED_SKIP_RELPATHS) {
    if (rel === pat) return true;
    if (rel.startsWith(pat + '/')) return true;
  }
  return false;
}

function _shouldSkipFile(name: string): boolean {
  if (name.startsWith('.')) {
    // dotfiles ARE walked (.gitignore, .env, etc) — sensitivity gate
    // throws away the secrets ones. Only skip true noise.
    if (name === '.DS_Store') return true;
  }
  const lower = name.toLowerCase();
  for (const suf of HARDCODED_SKIP_SUFFIXES) {
    if (lower.endsWith(suf)) return true;
  }
  return false;
}

function _walkOneRoot(
  rootAbs: string,
  ignore: readonly string[],
  onFile: (absPath: string) => void,
  stats: ScanStats,
): void {
  if (!rootAbs || !rootAbs.startsWith('/')) return;
  let rootStat: any;
  try {
    rootStat = fs.statSync(rootAbs);
  } catch {
    stats.walkErrors++;
    return;
  }
  if (!rootStat.isDirectory()) return;

  const gi = _loadGitignore(rootAbs);

  // Iterative DFS — avoids JS recursion depth issues on deep trees and lets
  // us bail early on a tight time budget if we ever need to.
  const stack: string[] = [rootAbs];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: any[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      stats.walkErrors++;
      continue;
    }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const rel = full.slice(rootAbs.length + 1);
      if (e.isDirectory()) {
        if (_shouldSkipDir(e.name, ignore)) { stats.skipped++; continue; }
        if (_shouldSkipRelPath(rel)) { stats.skipped++; continue; }
        if (gi && _gitignoreSkips(gi, rel)) { stats.skipped++; continue; }
        stack.push(full);
      } else if (e.isFile()) {
        stats.scanned++;
        if (_shouldSkipFile(e.name)) { stats.skipped++; continue; }
        if (_shouldSkipRelPath(rel)) { stats.skipped++; continue; }
        if (gi && _gitignoreSkips(gi, rel)) { stats.skipped++; continue; }
        onFile(full);
      } else if (e.isSymbolicLink()) {
        // Don't follow — symlinks are a common foot-gun for walkers (loops,
        // out-of-tree escapes). The user can index the real path directly
        // if they want it.
        stats.skipped++;
      }
    }
  }
}

// ── Public producers ──────────────────────────────────────────────────────────

/** Compute the set of roots a given DB wants walked. mode='cwd' → one root;
 *  mode='roots' → every root in the array. mode='off' returns []. */
function _rootsForDb(db: VectorDB): string[] {
  const f = db.source.files;
  if (f.mode === 'off') return [];
  if (f.mode === 'cwd') return f.cwd ? [f.cwd] : [];
  if (f.mode === 'roots') return Array.isArray(f.roots) ? f.roots : [];
  return [];
}

/** Scan every file-mode DB in the registry, enqueueing matching paths.
 *  Called on boot from runner.scanAndEnqueueOnStartup() AND from the per-DB
 *  force-refresh endpoint. Returns aggregate stats for logging.
 *
 *  The walker enqueues each unique path once, even if multiple DBs want
 *  it — `matchFile()` will fan that one queue item out across all matching
 *  DBs at consumption time. */
function scanAndEnqueueAllFileDbs(): ScanStats {
  const stats: ScanStats = { scanned: 0, enqueued: 0, skipped: 0, walkErrors: 0 };
  const dbs = listDbs().filter((d) => d.source.files.mode !== 'off');
  if (dbs.length === 0) return stats;

  // Union the roots so we walk each unique tree once even when 3 DBs all
  // point at the same repo. ignore[] is unioned too so a heavy
  // node_modules gets skipped if ANY DB declared it.
  const rootToIgnore = new Map<string, Set<string>>();
  for (const db of dbs) {
    const roots = _rootsForDb(db);
    const ig = db.source.files.ignore || [];
    for (const r of roots) {
      if (!rootToIgnore.has(r)) rootToIgnore.set(r, new Set());
      const set = rootToIgnore.get(r)!;
      for (const p of ig) set.add(p);
    }
  }

  const seen = new Set<string>();
  for (const [root, ignoreSet] of rootToIgnore) {
    _walkOneRoot(root, Array.from(ignoreSet), (absPath) => {
      if (seen.has(absPath)) return;
      seen.add(absPath);
      if (enqueueFileForRag(absPath, 'startup')) stats.enqueued++;
    }, stats);
  }
  if (stats.enqueued > 0 || stats.walkErrors > 0) {
    logger.info('context-rag.file-walker.scan-complete', stats);
  }
  return stats;
}

/** Scan a single VectorDB's roots. Used by the per-DB force-refresh route
 *  so an admin can re-ingest one DB without touching the others. */
function scanAndEnqueueForDb(dbId: string): ScanStats {
  const stats: ScanStats = { scanned: 0, enqueued: 0, skipped: 0, walkErrors: 0 };
  const db = listDbs().find((d) => d.id === dbId);
  if (!db) return stats;
  if (db.source.files.mode === 'off') return stats;
  const roots = _rootsForDb(db);
  if (roots.length === 0) return stats;
  const ignore = db.source.files.ignore || [];
  const seen = new Set<string>();
  for (const root of roots) {
    _walkOneRoot(root, ignore, (absPath) => {
      if (seen.has(absPath)) return;
      seen.add(absPath);
      if (enqueueFileForRag(absPath, 'startup')) stats.enqueued++;
    }, stats);
  }
  if (stats.enqueued > 0) {
    logger.info('context-rag.file-walker.scan-complete', { dbId, ...stats });
  }
  return stats;
}

export {
  scanAndEnqueueAllFileDbs,
  scanAndEnqueueForDb,
  HARDCODED_SKIP_DIRS,
  HARDCODED_SKIP_SUFFIXES,
};
export type { ScanStats };
