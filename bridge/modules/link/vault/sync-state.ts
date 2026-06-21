// ── LINK Sync Engine — State persistence & FS helpers ───────────────────────
// `link-state.json` (atomic rename), local-tree walking and content hashing
// utilities. Sensitivity-tier extraction lives here too because it's pure
// content parsing — no I/O, no policy.
'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const { STATE_PATH, MAX_SYNC_FILE_BYTES } = require('./sync-constants');

interface SyncFileState {
  serverSha:   string | null;
  serverMtime: number;
  desktopSha?: string | null;
  desktopMtime: number;
  lastSyncAt:  number;
}

interface LinkState {
  version: 1;
  files:   Record<string, SyncFileState>;
}

// ── State persistence ────────────────────────────────────────────────────────

function _readState(): LinkState {
  try {
    const raw = fs.readFileSync(STATE_PATH, 'utf8');
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && obj.version === 1) {
      return { version: 1, files: obj.files || {} };
    }
  } catch { /* fresh state */ }
  return { version: 1, files: {} };
}

function _writeStateAtomic(state: LinkState): void {
  const tmp = STATE_PATH + '.tmp-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, JSON.stringify(state, null, 0), 'utf8');
  fs.renameSync(tmp, STATE_PATH);
}

// ── Filesystem walking (server-side) ─────────────────────────────────────────

function _sha1(content: string | Buffer): string {
  return crypto.createHash('sha1').update(content as any).digest('hex');
}

// `foo.md` → false; `foo.conflict-<ts>.md` / `foo.conflict-<ts>.png` /
// `foo.conflict-<ts>` (no ext) / `foo.conflict-<a>.conflict-<b>.png` → true.
// Matches a `.conflict-<digits>` segment for ANY extension (or none),
// including nested re-conflicts. The sidecar writer (_conflictSidecar)
// preserves the SOURCE extension, so the old `.md`-only check silently failed
// to skip binary (.png …) sidecars — letting them re-enter the walk, get
// re-conflicted, and multiply (`foo.conflict-A.conflict-B.png`) without bound
// until the folder OOM'd the bridge. Shared by the walk here and the per-path
// loop in sync-folder.ts (covers the desktop side too).
function _isConflictSidecar(nameOrRel: string): boolean {
  const base = String(nameOrRel).replace(/^.*[\\/]/, '');
  return /\.conflict-\d+(\.|$)/.test(base);
}

function _walkLocalDir(absDir: string, relPrefix: string, out: Array<{ rel: string; abs: string; mtime: number; size: number; sha1: string }>): void {
  let entries: any[];
  try {
    entries = fs.readdirSync(absDir, { withFileTypes: true });
  } catch { return; }
  for (const ent of entries) {
    const childAbs = path.join(absDir, ent.name);
    const childRel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) {
      _walkLocalDir(childAbs, childRel, out);
      continue;
    }
    if (!ent.isFile()) continue;
    // Skip conflict sidecars and tmp-write artefacts so we don't bounce them
    // back and forth between desktop and server. The sidecar test must cover
    // EVERY extension (and nested re-conflicts), not just `.md` — keep-notes
    // syncs binary assets and the old `.md`-only check let image sidecars
    // re-enter the walk and multiply without bound.
    if (_isConflictSidecar(ent.name)) continue;
    if (/\.tmp-[0-9a-f]+$/.test(ent.name)) continue;
    let stat: any;
    try { stat = fs.statSync(childAbs); } catch { continue; }
    // Size ceiling BEFORE we read: the adapter would reject an over-cap file
    // anyway, and synchronously reading multi-MB binaries here is what OOM'd
    // the bridge (and blocked its event loop) on the 8 GB host. Skip without
    // ever loading the content.
    if (typeof stat.size === 'number' && stat.size > MAX_SYNC_FILE_BYTES) continue;
    let content: Buffer;
    try { content = fs.readFileSync(childAbs); } catch { continue; }
    out.push({
      rel:   childRel,
      abs:   childAbs,
      mtime: Math.floor(stat.mtimeMs ?? Date.now()),
      size:  stat.size,
      sha1:  _sha1(content),
    });
  }
}

// ── Sensitivity filter ───────────────────────────────────────────────────────
// Reads frontmatter `sensitivity: <tier>` from the file content; falls back
// to `'public'`. This is a defence-in-depth check — the Sorter already
// writes the frontmatter and the Categorizer assigns the tier, so by the
// time LINK runs the value is always present. We re-read it here to make
// the filter immune to upstream bugs.

function _readSensitivityFromContent(content: string): string {
  const fmEnd = content.indexOf('\n---', 4);
  const fm = content.startsWith('---\n') && fmEnd > 0 ? content.slice(4, fmEnd) : '';
  const m = fm.match(/^sensitivity:\s*"?([a-z]+)"?\s*$/m);
  return m ? m[1] : 'public';
}

module.exports = {
  _readState,
  _writeStateAtomic,
  _sha1,
  _isConflictSidecar,
  _walkLocalDir,
  _readSensitivityFromContent,
};
