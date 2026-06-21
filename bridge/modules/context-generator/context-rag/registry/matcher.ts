// ── context-rag registry matcher ──────────────────────────────────────────────
// Given a corpus item (session, file, or knowledge entry), return the list of
// VectorDBs whose `source` filter accepts it. The runner uses this at process
// time to fan a single queue item out across N matching DBs — same item,
// different embed adapters, different physical .db files.
//
// Match rules per kind:
//
//   session    mode='off'  → never
//              mode='all'  → always
//              mode='cwd'  → session.cwd === db.source.sessions.cwd (path-normalized)
//
//   file       mode='off'  → never
//              mode='cwd'  → path is inside db.source.files.cwd, AND
//                            no relative-path segment matches db.source.files.ignore
//              mode='roots'→ path is inside any of db.source.files.roots (+ ignore)
//
//   knowledge  mode='off'  → never
//              mode='all'  → always
//
// Path matching is path-prefix only (no symlink resolution; the watcher
// produces absolute paths via fs.realpath upstream). All inputs are trusted
// to be absolute; the assertion is best-effort.
'use strict';

import type { VectorDB } from './types';
import { listDbs } from './store';

interface SessionMatchInput {
  /** The session's working_dir, or null if it was an in-place chat with no
   *  working dir set. `null` only matches `mode==='all'` DBs. */
  cwd: string | null;
}

interface FileMatchInput {
  /** Absolute path. Required to start with `/`. */
  path: string;
}

function _normalize(p: string): string {
  // Strip trailing slashes (a/b/ === a/b) and collapse duplicate slashes.
  return p.replace(/\/+/g, '/').replace(/\/$/, '');
}

function _isInside(parent: string, child: string): boolean {
  if (!parent || !child) return false;
  const P = _normalize(parent);
  const C = _normalize(child);
  if (C === P) return true;
  return C.startsWith(P + '/');
}

/** Path fragments (relative to a walked root) that we never index, regardless
 *  of any DB's `ignore[]` config. Mirrors HARDCODED_SKIP_RELPATHS in
 *  ingest/file-walker.ts — kept here too so files arriving via fs-watcher or
 *  any observer (not just the bulk walker) get rejected before they cost an
 *  embed call. */
const HARDCODED_SKIP_RELPATHS = [
  'bridge/rewind',
];

function _hasHardcodedRelPathSkip(relPath: string): boolean {
  for (const pat of HARDCODED_SKIP_RELPATHS) {
    if (relPath === pat) return true;
    if (relPath.startsWith(pat + '/')) return true;
    if (relPath.includes('/' + pat + '/')) return true;
    if (relPath.endsWith('/' + pat)) return true;
  }
  return false;
}

function _hasIgnoredSegment(relPath: string, ignore: readonly string[] | undefined): boolean {
  if (!ignore || ignore.length === 0) return false;
  // Each ignore entry is treated as a path fragment: it matches the start of
  // the relative path or any internal segment. Globs are NOT supported in v1.
  for (const pat of ignore) {
    if (!pat) continue;
    const norm = pat.replace(/^\/+|\/+$/g, '');
    if (!norm) continue;
    if (relPath === norm) return true;
    if (relPath.startsWith(norm + '/')) return true;
    if (relPath.includes('/' + norm + '/')) return true;
    if (relPath.endsWith('/' + norm)) return true;
  }
  return false;
}

/** All DBs whose `source.sessions` accepts this session's cwd. */
function matchSession(input: SessionMatchInput): VectorDB[] {
  return listDbs().filter((db) => {
    const s = db.source.sessions;
    if (s.mode === 'off') return false;
    if (s.mode === 'all') return true;
    if (s.mode === 'cwd') {
      if (!input.cwd || !s.cwd) return false;
      return _normalize(input.cwd) === _normalize(s.cwd);
    }
    return false;
  });
}

/** All DBs whose `source.files` accepts this absolute path. */
function matchFile(input: FileMatchInput): VectorDB[] {
  if (typeof input.path !== 'string' || !input.path.startsWith('/')) return [];
  return listDbs().filter((db) => {
    const f = db.source.files;
    if (f.mode === 'off') return false;
    if (f.mode === 'cwd') {
      if (!f.cwd) return false;
      if (!_isInside(f.cwd, input.path)) return false;
      const rel = _normalize(input.path).slice(_normalize(f.cwd).length + 1);
      if (_hasHardcodedRelPathSkip(rel)) return false;
      if (_hasIgnoredSegment(rel, f.ignore)) return false;
      return true;
    }
    if (f.mode === 'roots') {
      if (!Array.isArray(f.roots) || f.roots.length === 0) return false;
      const inside = f.roots.find((r) => _isInside(r, input.path));
      if (!inside) return false;
      const rel = _normalize(input.path).slice(_normalize(inside).length + 1);
      if (_hasHardcodedRelPathSkip(rel)) return false;
      if (_hasIgnoredSegment(rel, f.ignore)) return false;
      return true;
    }
    return false;
  });
}

/** All DBs that accept knowledge entries — currently mode in {'all','off'}. */
function matchKnowledge(): VectorDB[] {
  return listDbs().filter((db) => db.source.knowledge.mode === 'all');
}

interface SynthesisMatchInput {
  /** Absolute path of the bucket the file came from (the .../synthesis/
   *  directory itself, not the file). Used to scope `mode==='cwd'` DBs by
   *  resolving the bucket back to its source cwd. */
  bucketCwd: string;
}

/** DBs that accept a synthesis page from a given bucket. `mode==='all'`
 *  matches every bucket; `mode==='cwd'` matches only when the DB's cwd equals
 *  the bucket's source cwd. */
function matchSynthesis(input: SynthesisMatchInput): VectorDB[] {
  return listDbs().filter((db) => {
    const s = db.source.synthesis;
    if (!s || s.mode === 'off') return false;
    if (s.mode === 'all') return true;
    if (s.mode === 'cwd') {
      if (!input.bucketCwd || !s.cwd) return false;
      return _normalize(input.bucketCwd) === _normalize(s.cwd);
    }
    return false;
  });
}

/** True iff at least one DB anywhere in the registry has `sessions.mode != 'off'`.
 *  Used by the runner's startup guard: no point scanning sessions if no DB
 *  wants them. */
function anyDbWantsSessions(): boolean {
  return listDbs().some((db) => db.source.sessions.mode !== 'off');
}

function anyDbWantsFiles(): boolean {
  return listDbs().some((db) => db.source.files.mode !== 'off');
}

function anyDbWantsKnowledge(): boolean {
  return listDbs().some((db) => db.source.knowledge.mode === 'all');
}

function anyDbWantsSynthesis(): boolean {
  return listDbs().some((db) => {
    const s = db.source.synthesis;
    return !!s && s.mode !== 'off';
  });
}

/** Distinct cwds across every DB that opts into synthesis. The boot scan
 *  uses this to know which buckets to walk: 'all'-mode DBs widen the set to
 *  every bucket on disk, 'cwd'-mode DBs add just their one. */
function synthesisCwdsForScan(): { allBuckets: boolean; cwds: string[] } {
  let allBuckets = false;
  const cwds = new Set<string>();
  for (const db of listDbs()) {
    const s = db.source.synthesis;
    if (!s || s.mode === 'off') continue;
    if (s.mode === 'all') { allBuckets = true; continue; }
    if (s.mode === 'cwd' && s.cwd) cwds.add(_normalize(s.cwd));
  }
  return { allBuckets, cwds: Array.from(cwds) };
}

export {
  matchSession,
  matchFile,
  matchKnowledge,
  matchSynthesis,
  anyDbWantsSessions,
  anyDbWantsFiles,
  anyDbWantsKnowledge,
  anyDbWantsSynthesis,
  synthesisCwdsForScan,
};
export type { SessionMatchInput, FileMatchInput, SynthesisMatchInput };
