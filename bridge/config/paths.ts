// ── Shared path-confinement helpers ──────────────────────────────────────────
// Used by /v1/files/* routes (server-config.ts read-only routes and
// server-file-manager.ts mutating routes) so HOME / extra-roots clamping is
// implemented once. The helpers throw `{ status, message }` on rejection so
// route handlers can short-circuit with the right HTTP status:
//
//   try { resolved = await safeResolve(reqPath); }
//   catch (e) { return res.status(e.status || 400).json({ success: false, error: e.message }); }
//
// `safeResolve` accepts the user-supplied path string (with optional `~`
// expansion) and returns the realpath-resolved absolute path that lives
// inside HOME or one of the configured extra roots.

const fs = require('fs');
const path = require('path');

// Per-user (Q16) — routed via bridge/core/paths.ts.
const PREFS_PATH = require('../core/paths').prefs;

function getHome(): string {
  // HOME first (Linux/macOS convention), then USERPROFILE (Windows),
  // then os.homedir() as the cross-platform last resort. The literal
  // "/home/user" fallback is kept for catastrophic-misconfig recovery
  // on a unix host where every env var is somehow empty — on Windows
  // it would just yield "outside allowed roots" for every real path,
  // which is what triggered this fix.
  const os = require('os');
  return process.env.HOME || process.env.USERPROFILE || os.homedir() || '/home/user';
}

async function readPrefs() {
  try {
    return JSON.parse(await fs.promises.readFile(PREFS_PATH, 'utf8'));
  } catch (_) {
    return {};
  }
}

function isWithinRoot(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return rel === '' || (!!rel && !rel.startsWith('..') && !path.isAbsolute(rel));
}

function configDefaultRoots(): string[] {
  try {
    const { config } = require('../core/state');
    const defaults = config && config.defaults ? config.defaults : {};
    const roots: string[] = [];
    if (typeof defaults.workingDir === 'string' && defaults.workingDir) roots.push(defaults.workingDir);
    if (Array.isArray(defaults.workingDirs)) {
      for (const r of defaults.workingDirs) {
        if (typeof r === 'string' && r) roots.push(r);
      }
    }
    return roots;
  } catch (_) {
    return [];
  }
}

// `fileManagerRoots` in bridge/prefs.json is an absolute-path array of extra
// roots the FileManager + read-only file routes are allowed to touch. Read
// fresh per-request so prefs edits take effect without restart. The configured
// standard/additional working directories are also roots: the Preferences
// "homebase" must immediately become valid for the file picker and manager.
async function getExtraRoots(): Promise<string[]> {
  const prefs = await readPrefs();
  const prefRoots = Array.isArray(prefs?.fileManagerRoots) ? prefs.fileManagerRoots : [];
  const raw = [...configDefaultRoots(), ...prefRoots];
  const seen = new Set<string>();
  // Accept any absolute path (cross-platform). Old check insisted on
  // a leading "/" which rejected every Windows path like "C:\Users\…".
  return raw
    .filter((r) => typeof r === 'string' && path.isAbsolute(r))
    .map((r) => path.resolve(r))
    .filter((r) => {
      const key = process.platform === 'win32' ? r.toLowerCase() : r;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

async function getAllowedRoots(): Promise<string[]> {
  return [getHome(), ...(await getExtraRoots())].map((r) => path.resolve(r));
}

function expandPath(p: string): string {
  if (!p) return '';
  let out = p;
  if (out === '~' || out.startsWith('~/')) out = getHome() + out.slice(1);
  return path.resolve(out);
}

// Confine a resolved absolute path to allowed roots. Falls back to
// confining the parent directory when the path itself doesn't exist (so
// e.g. mkdir / upload can target a not-yet-existing leaf).
async function confine(absPath: string): Promise<string> {
  const HOME = getHome();
  let resolved: string;
  try {
    resolved = await fs.promises.realpath(absPath);
  } catch (_) {
    const parent = path.dirname(absPath);
    let resolvedParent: string;
    try {
      resolvedParent = await fs.promises.realpath(parent);
    } catch (_) {
      throw { status: 400, message: 'Parent directory does not exist' };
    }
    resolved = path.join(resolvedParent, path.basename(absPath));
  }
  if (isWithinRoot(HOME, resolved)) return resolved;
  for (const root of await getExtraRoots()) {
    if (isWithinRoot(root, resolved)) return resolved;
  }
  throw { status: 403, message: 'Access denied: path outside allowed roots' };
}

async function safeResolve(p: string): Promise<string> {
  if (!p || typeof p !== 'string') throw { status: 400, message: 'path required' };
  return confine(expandPath(p));
}

module.exports = {
  getHome,
  expandPath,
  confine,
  safeResolve,
  getExtraRoots,
  getAllowedRoots,
  isWithinRoot,
};
