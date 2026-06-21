// ── Context Sorter — filesystem helpers ──────────────────────────────────────
// Atomic writes + keep-notes frontmatter scanner. The walker exists here
// (rather than render-pages) because it's I/O-shaped — render-pages stays
// pure-string.
'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const {
  DOCS_GENERATED_ROOT,
  DOCS_KEEP_NOTES_ROOT,
  SUBDIR_SESSIONS,
  SUBDIR_BY_CATEGORY,
  SUBDIR_BY_TYPE,
  SUBDIR_BY_DATE,
} = require('./constants');
const { _assertWithinGenerated } = require('./util');

interface _FileMember {
  abs:         string;
  basename:    string;
  title:       string;
  category:    string;
  topics:      string[];
  tags:        string[];
  keywords:    string[];
  sensitivity: string;
  mtime:       number;
}

async function _ensureDirs(): Promise<void> {
  for (const d of [DOCS_GENERATED_ROOT, SUBDIR_SESSIONS, SUBDIR_BY_CATEGORY, SUBDIR_BY_TYPE, SUBDIR_BY_DATE]) {
    await fs.promises.mkdir(d, { recursive: true });
  }
}

// Atomic-ish write — write to a temp file then rename. Avoids partial reads
// from Obsidian's file watcher when a write is interrupted.
//
// Skip the write when the existing file matches byte-for-byte. Bucket
// analysis 2026-05-10 found 1 227 of 2 497 files in `sessions/` were
// `.conflict-*.md` Syncthing conflict copies because every sorter pass
// re-rendered every page even when the content was unchanged — Syncthing
// then raced with whatever device had it open. A content-hash short-circuit
// eliminates that storm at no cost (read is cheap; equal-content writes
// were already wasted I/O).
async function _writeFileAtomic(target: string, content: string): Promise<void> {
  _assertWithinGenerated(target);
  try {
    const existing = await fs.promises.readFile(target, 'utf8');
    if (existing === content) return;
  } catch (_) { /* file doesn't exist yet — fall through to write */ }
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  const tmp = target + '.tmp-' + crypto.randomBytes(4).toString('hex');
  await fs.promises.writeFile(tmp, content, 'utf8');
  await fs.promises.rename(tmp, target);
}

// Read just the frontmatter block of a file. Returns null when the file has
// no frontmatter or no `topics:` line (i.e. file-categorizer hasn't run yet).
function _readFileFrontmatter(abs: string): _FileMember | null {
  let buf: string;
  let stat: any;
  try {
    stat = fs.statSync(abs);
    // Read at most 8 KB — frontmatter is always at the very top, and the
    // file-categorizer caps it to a few lines anyway. Avoids slurping
    // 50 MB of body text for every keep-note on every sorter pass.
    const fd = fs.openSync(abs, 'r');
    try {
      const bufObj = Buffer.alloc(8 * 1024);
      const n = fs.readSync(fd, bufObj, 0, bufObj.length, 0);
      buf = bufObj.slice(0, n).toString('utf8');
    } finally {
      try { fs.closeSync(fd); } catch { /* */ }
    }
  } catch { return null; }
  if (!buf.startsWith('---\n')) return null;
  const end = buf.indexOf('\n---', 4);
  if (end < 0) return null;
  const fm = buf.slice(4, end);
  if (!/^topics\s*:/m.test(fm)) return null;     // not yet categorised

  // Tolerant single-line YAML extractor — only the subset we write. Lists
  // like `topics: [a, b, c]` are split on `,`; quoted strings keep their
  // outer quotes off; everything else falls back to bare text.
  function extract(key: string): string {
    const m = new RegExp(`^${key}\\s*:\\s*(.*)$`, 'm').exec(fm);
    return m ? m[1].trim() : '';
  }
  function extractList(key: string): string[] {
    const raw = extract(key);
    if (!raw) return [];
    if (raw.startsWith('[') && raw.endsWith(']')) {
      return raw.slice(1, -1).split(',')
        .map((s) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    }
    return [raw];
  }
  const basename = path.basename(abs, '.md');
  return {
    abs,
    basename,
    title:       basename.replace(/[-_]+/g, ' '),
    category:    extract('category').replace(/^["']|["']$/g, '') || 'keep-notes',
    topics:      extractList('topics'),
    tags:        extractList('tags'),
    keywords:    extractList('keywords'),
    sensitivity: extract('sensitivity').replace(/^["']|["']$/g, '') || 'public',
    mtime:       stat.mtimeMs || 0,
  };
}

// mtime cache for keep-notes frontmatter. Audit 2026-05-10 found the
// previous implementation re-`open()`+`read(8 KB)`+`parse()`d every
// keep-note (4 432 files) on every sorter pass — only a handful ever
// change between passes. We keep `{abs → {mtime, parsed | null}}` in
// memory and re-stat on each pass (cheap), only re-parsing when mtime
// shifted. `null` cached entries (file had no `topics:` field at last
// scan) get re-checked on mtime change so the cache picks up newly-
// categorised files automatically.
const _fmCache = new Map<string, { mtime: number; parsed: _FileMember | null }>();

function _walkKeepNotes(dir: string, out: _FileMember[]): void {
  let entries: string[];
  try { entries = fs.readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (name.startsWith('.') || name.startsWith('_')) continue;
    const full = path.join(dir, name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      _walkKeepNotes(full, out);
    } else if (stat.isFile() && /\.md$/i.test(name)) {
      const mtime  = stat.mtimeMs || 0;
      const cached = _fmCache.get(full);
      if (cached && cached.mtime === mtime) {
        if (cached.parsed) out.push(cached.parsed);
        continue;
      }
      const parsed = _readFileFrontmatter(full);
      _fmCache.set(full, { mtime, parsed });
      if (parsed) out.push(parsed);
    }
  }
}

function _collectFileMembers(): _FileMember[] {
  if (!fs.existsSync(DOCS_KEEP_NOTES_ROOT)) return [];
  const out: _FileMember[] = [];
  _walkKeepNotes(DOCS_KEEP_NOTES_ROOT, out);
  return out;
}

module.exports = {
  _ensureDirs,
  _writeFileAtomic,
  _readFileFrontmatter,
  _walkKeepNotes,
  _collectFileMembers,
};
