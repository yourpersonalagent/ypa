// ── Server-side file/folder browser routes ─────────────────────────────────
// Extracted from handler.ts (registerConfigRoutes) — see ./handler.ts.
'use strict';

const fs = require('fs');
const path = require('path');
const { getHome, getAllowedRoots, isWithinRoot, safeResolve } = require('./paths');
const { BRIDGE_ROOT, canonicalEmailFor, isAdminEmail } = require('../users/resolver');

// `bridge/users/` holds one subfolder per human (canonical email = folder
// name). Non-admin requests must only see / read inside their own folder;
// admins see everything. Role gate is a single env var (ADMIN_EMAILS) read
// fresh per request via resolver.isAdminEmail so flipping the var takes
// effect without restart.
const USERS_ROOT: string = path.join(BRIDGE_ROOT, 'users');

// pathCase: Windows compares paths case-insensitively, POSIX case-sensitively.
function eqPath(a: string, b: string): boolean {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// usersFolderGate returns a decision about a resolved path for the current
// requester. Three outcomes:
//   - { mode: 'open' }                — admin, or path isn't under users/
//   - { mode: 'list-own', own }       — listing users/ itself; show only `own`
//   - { mode: 'deny' }                — non-admin reading into another user
function usersFolderGate(req: any, resolved: string): { mode: 'open' } | { mode: 'list-own'; own: string | null } | { mode: 'deny' } {
  const email: string = req?.session?.user?.email || '';
  if (isAdminEmail(email)) return { mode: 'open' };
  // Outside users/ entirely → unaffected.
  if (!eqPath(resolved, USERS_ROOT) && !isWithinRoot(USERS_ROOT, resolved)) {
    return { mode: 'open' };
  }
  const own = canonicalEmailFor(email); // may be null for net-peer / unrecognised
  // Listing users/ root → caller will filter items to only `own`.
  if (eqPath(resolved, USERS_ROOT)) return { mode: 'list-own', own };
  // Inside users/<x>/... → x must equal `own`, otherwise deny.
  const rel = path.relative(USERS_ROOT, resolved);
  const top = rel.split(/[\\/]+/)[0] || '';
  if (!own || !top || top.toLowerCase() !== own.toLowerCase()) return { mode: 'deny' };
  return { mode: 'open' };
}

function registerFilesRoutes(app) {
  // ── GET /v1/files/ — server-side file/folder browser ───────────────────────
  app.get('/v1/files/', async (req, res) => {
    const reqPath = req.query.path || getHome();
    let resolved;
    try {
      resolved = await safeResolve(reqPath);
    } catch (e: any) {
      return res.status(e?.status || 400).json({ success: false, error: e?.message || String(e) });
    }
    const showHidden = req.query.hidden === '1';
    const gate = usersFolderGate(req, resolved);
    if (gate.mode === 'deny') {
      return res.status(403).json({ success: false, error: 'Access denied: other users\' folders are private' });
    }
    try {
      const entries = await fs.promises.readdir(resolved, { withFileTypes: true });
      let visible = entries.filter((e) => showHidden || !e.name.startsWith('.'));
      if (gate.mode === 'list-own') {
        // Listing bridge/users/ as a non-admin: keep only the requester's own
        // canonical folder. Null `own` (no recognized email) → empty list.
        const own = gate.own;
        visible = own
          ? visible.filter((e) => e.isDirectory() && e.name.toLowerCase() === own.toLowerCase())
          : [];
      }
      // The dirent already gives us file-vs-dir; the per-entry stat() below is
      // ONLY to fill the size column. A plain Promise.all over every entry
      // initiates one stat syscall per file synchronously — on a large folder
      // (thousands of entries) that burst stalls the event loop and the picker
      // appears to freeze. So: skip sizes entirely on very large dirs, and
      // otherwise stat with bounded concurrency.
      const SKIP_SIZE_ABOVE = 2000;
      const STAT_CONCURRENCY = 64;
      const items = visible.map((e) => ({
        name: e.name,
        type: e.isDirectory() ? 'dir' : 'file',
        path: path.join(resolved, e.name),
        size: null as number | null,
      }));
      if (items.length <= SKIP_SIZE_ABOVE) {
        let next = 0;
        const worker = async () => {
          while (next < items.length) {
            const i = next++;
            if (!visible[i].isFile()) continue;
            try {
              items[i].size = (await fs.promises.stat(items[i].path)).size;
            } catch (_) {}
          }
        };
        await Promise.all(
          Array.from({ length: Math.min(STAT_CONCURRENCY, items.length) }, worker)
        );
      }
      items.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
      const parent = path.dirname(resolved);
      const roots = await getAllowedRoots();
      const parentAllowed = parent !== resolved && roots.some((root) => isWithinRoot(root, parent));
      res.json({
        success: true,
        path: resolved,
        parent: parentAllowed ? parent : null,
        items,
      });
    } catch (e) {
      res.status(400).json({ success: false, error: e.message });
    }
  });

  // ── GET /v1/files/read — read text file content ──────────────────────────────
  app.get('/v1/files/read', async (req, res) => {
    const reqPath = req.query.path || '';
    if (!reqPath) return res.status(400).json({ success: false, error: 'path required' });
    let resolved;
    try {
      resolved = await safeResolve(reqPath);
    } catch (e: any) {
      return res.status(e?.status || 400).json({ success: false, error: e?.message || String(e) });
    }
    const readGate = usersFolderGate(req, resolved);
    if (readGate.mode === 'deny') {
      return res.status(403).json({ success: false, error: 'Access denied: other users\' files are private' });
    }
    try {
      const stat = await fs.promises.stat(resolved);
      if (!stat.isFile()) return res.status(400).json({ success: false, error: 'Not a file' });
      if (stat.size > 2 * 1024 * 1024)
        return res.status(400).json({ success: false, error: 'File too large (max 2 MB)' });
      const content = await fs.promises.readFile(resolved, 'utf8');
      res.json({ success: true, path: resolved, content, size: stat.size });
    } catch (e) {
      res.status(400).json({ success: false, error: e.message });
    }
  });

  // ── POST /v1/files/exists — batch existence check for chat file mentions ────
  // Body: { paths: string[], cwd?: string }
  // Returns: { success, files: { [raw]: { exists, resolved?, isFile?, size? } } }
  // Resolves `~`, `~/`, and relative paths against `cwd` (defaults to HOME).
  // Limits to paths that resolve under HOME or /tmp; everything else is
  // reported as exists:false so renderers can drop it.
  app.post('/v1/files/exists', async (req, res) => {
    const HOME = getHome();
    const rawPaths = Array.isArray(req.body && req.body.paths) ? req.body.paths : [];
    const cwd = typeof (req.body && req.body.cwd) === 'string' && req.body.cwd ? req.body.cwd : HOME;
    const roots = await getAllowedRoots();
    const out = {};
    const seen = new Set();
    for (const raw of rawPaths) {
      if (typeof raw !== 'string') continue;
      const trimmed = raw.trim();
      if (!trimmed || trimmed.length > 500) continue;
      if (seen.has(trimmed)) continue;
      seen.add(trimmed);
      // Hard skip: any URL-looking thing is never a local file.
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) { out[trimmed] = { exists: false }; continue; }

      let p = trimmed;
      if (p === '~') p = HOME;
      else if (p.startsWith('~/')) p = HOME + p.slice(1);

      const absPath = path.isAbsolute(p) ? p : path.resolve(cwd, p);
      let resolved;
      try { resolved = await fs.promises.realpath(absPath); }
      catch (_) { out[trimmed] = { exists: false }; continue; }
      const inHome = roots.some((root) => isWithinRoot(root, resolved));
      const inTmp = resolved === '/tmp' || resolved.startsWith('/tmp/');
      if (!inHome && !inTmp) { out[trimmed] = { exists: false }; continue; }
      try {
        const stat = await fs.promises.stat(resolved);
        out[trimmed] = { exists: true, resolved, isFile: stat.isFile(), size: stat.size };
      } catch (_) {
        out[trimmed] = { exists: false };
      }
    }
    res.json({ success: true, files: out });
  });

  // ── PUT /v1/files/write — overwrite text file content ───────────────────────
  app.put('/v1/files/write', async (req, res) => {
    const { path: reqPath, content } = req.body || {};
    if (!reqPath || content === undefined) {
      return res.status(400).json({ success: false, error: 'path and content required' });
    }
    let resolved;
    try {
      resolved = await safeResolve(reqPath);
    } catch (e: any) {
      return res.status(e?.status || 400).json({ success: false, error: e?.message || String(e) });
    }
    const writeGate = usersFolderGate(req, resolved);
    if (writeGate.mode === 'deny') {
      return res.status(403).json({ success: false, error: 'Access denied: other users\' folders are private' });
    }
    try {
      await fs.promises.writeFile(resolved, content, 'utf8');
      res.json({ success: true, path: resolved });
    } catch (e) {
      res.status(400).json({ success: false, error: e.message });
    }
  });
}

module.exports = { registerFilesRoutes };
