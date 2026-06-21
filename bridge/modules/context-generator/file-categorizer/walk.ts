// ── File-Categorizer disk scan ────────────────────────────────────────────────
// Walks `docs/keep-notes/` recursively (subdirs allowed — Google Keep imports
// can come in nested via the user's vault layout). Cheap because we only
// open files that look candidate-y.
'use strict';

const fs   = require('fs');
const path = require('path');

const { KEEP_NOTES_ROOT } = require('./constants');
const { _isUncategorised, _readCategorizerStatus } = require('./frontmatter');

interface FileCandidate {
  abs:   string;
  mtime: number;
}

function _walkMd(dir: string, out: string[]): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch { return; }
  for (const name of entries) {
    if (name.startsWith('.')) continue;          // skip hidden / Obsidian internals
    if (name.startsWith('_')) continue;          // skip aggregate index files
    const full = path.join(dir, name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      _walkMd(full, out);
    } else if (stat.isFile() && /\.md$/i.test(name)) {
      out.push(full);
    }
  }
}

function _getNextBatch(size: number, skip: ReadonlySet<string> = new Set()): FileCandidate[] {
  if (!fs.existsSync(KEEP_NOTES_ROOT)) return [];
  const all: string[] = [];
  _walkMd(KEEP_NOTES_ROOT, all);

  const out: FileCandidate[] = [];
  for (const abs of all) {
    if (skip.has(abs)) continue;
    let stat, content;
    try {
      stat = fs.statSync(abs);
      // Only open the file if we still need more candidates — opening 4k
      // files when we only need 20 candidates would be wasteful.
      if (out.length >= size) {
        // We already have enough; record mtime cheaply for the sort below.
        out.push({ abs, mtime: stat.mtimeMs || 0 });
        continue;
      }
      content = fs.readFileSync(abs, 'utf8');
    } catch { continue; }

    if (out.length >= size) continue; // sort+slice happens after the loop
    if (!_isUncategorised(content)) continue;
    out.push({ abs, mtime: stat.mtimeMs || 0 });
  }

  // Most-recently-modified first — the user usually cares about whatever
  // they touched on the phone today before historical notes from 2018.
  out.sort((a, b) => b.mtime - a.mtime);
  return out.slice(0, size);
}

// Exposed for the dashboard / status-card. Counts how many files are still
// pending — does NOT open them all (a `topics:` substring check would be
// cheap-ish, but for a true count we have to open). Capped to keep this
// quick: the caller asks for max N and we stop counting once we hit the cap.
function _countPending(cap: number = 9_999): number {
  if (!fs.existsSync(KEEP_NOTES_ROOT)) return 0;
  const all: string[] = [];
  _walkMd(KEEP_NOTES_ROOT, all);
  let pending = 0;
  for (const abs of all) {
    let content;
    try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    if (_isUncategorised(content)) {
      pending++;
      if (pending >= cap) return pending;
    }
  }
  return pending;
}

// Counts files marked auto-skipped or user-skipped. Capped to avoid scanning
// the entire 60k corpus on every status poll.
function _countAbandoned(cap: number = 9_999): number {
  if (!fs.existsSync(KEEP_NOTES_ROOT)) return 0;
  const all: string[] = [];
  _walkMd(KEEP_NOTES_ROOT, all);
  let n = 0;
  for (const abs of all) {
    let content: string;
    try { content = fs.readFileSync(abs, 'utf8'); } catch { continue; }
    const status = _readCategorizerStatus(content);
    if (status === 'auto-skipped' || status === 'user-skipped') {
      n++;
      if (n >= cap) return n;
    }
  }
  return n;
}

module.exports = {
  _walkMd,
  _getNextBatch,
  _countPending,
  _countAbandoned,
};
