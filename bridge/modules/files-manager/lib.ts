// ── File Manager — destructive file ops + binary uploads ─────────────────────
// Companion to the read-only routes in server-config.ts (/v1/files/, /read,
// /write, /exists). All routes here mutate the filesystem and are gated by
// the same HOME-confine check, plus optional extra roots from prefs.json
// (`fileManagerRoots`). Destructive ops route through a per-workdir
// `.trash/<timestamp>/` folder so the FileManager UI's triple-confirm flow
// can offer Undo. Binary uploads stream straight to disk (no memory
// buffering) up to MAX_FILE_BYTES per request.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const logger = require('../../core/logger');
const { getHome, getExtraRoots, safeResolve } = require('../../config/paths');

// ── Config ────────────────────────────────────────────────────────────────────

// Per-file upload cap (octet-stream body). The frontend enforces the same
// limit before queuing so users get instant feedback; the server enforces it
// during streaming as a hard backstop.
const MAX_FILE_BYTES = 500 * 1024 * 1024; // 500 MB

// Locate the host root that contains an item — i.e. the allowed-roots entry
// (HOME or one of `fileManagerRoots`) that the item sits under. Used as the
// fallback when the client doesn't pass an explicit `hostDir` to a trash
// call. The trash always lives at <hostRoot>/.trash/.
async function pickTrashHostDir(itemPath: string): Promise<string> {
  const HOME = getHome();
  const extras = await getExtraRoots();
  const allRoots = [HOME, ...extras];
  // Prefer the deepest matching root so an item under both HOME and an extra
  // root nested inside HOME goes into the more specific root's trash.
  let best = '';
  for (const root of allRoots) {
    if (itemPath === root || itemPath.startsWith(root + path.sep)) {
      if (root.length > best.length) best = root;
    }
  }
  return best || HOME;
}

// Time budget for zip / unzip subprocess. Generous default — a 5 GB archive
// over a slow disk can easily take minutes. Anything bigger should use the
// shell directly. Override by editing here; not exposed via prefs.json since
// blocking the bridge for an hour is rarely intended.
const ZIP_TIMEOUT_MS = 30 * 60 * 1000;

// Names the zip route excludes when `excludeHidden=true`. Must stay in sync
// with the FileManager UI's HIDDEN_NAMES set so a user who can't see these
// in the listing also doesn't accidentally pack them into a backup. Exposed
// from the module (and surfaced via /v1/files/hidden-names) so the frontend
// can derive its set from one source.
const HIDDEN_NAMES: string[] = ['node_modules', '.git', '.trash', '.DS_Store'];

// Glob patterns for `zip -x`. Covers both top-level and nested matches; we
// branch on '.DS_Store' because it's a file (not a directory).
const HIDDEN_ZIP_EXCLUDES: string[] = HIDDEN_NAMES.flatMap((name) =>
  name === '.DS_Store'
    ? [name, `*/${name}`]
    : [`${name}/*`, `*/${name}/*`],
);

// Promisified execFile. We never use shell-string `exec()` here so user paths
// are passed as argv elements and can't be interpreted. Output is tiny under
// `-q` so Node's default maxBuffer (1 MB) is plenty.
function execFileP(cmd: string, args: string[], opts: any = {}): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: ZIP_TIMEOUT_MS, ...opts }, (err, stdout, stderr) => {
      if (err) {
        // Surface the binary's stderr to callers — `zip` and `unzip` emit
        // useful messages there (bad-zip, write-error, …).
        const e: any = new Error(stderr ? String(stderr).trim() : err.message);
        e.code = (err as any).code;
        e.signal = (err as any).signal;
        return reject(e);
      }
      resolve({ stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

// Pick the deepest common-parent directory among `items`. zip stores paths
// relative to its cwd; running zip from the common-parent makes the archive
// contain "<name>/..." entries instead of "/home/user/foo/<name>/..." which
// nobody wants when they unzip.
function commonParent(items: string[]): string {
  if (!items.length) return '/';
  const parts = items.map((p) => path.dirname(p).split(path.sep).filter(Boolean));
  let i = 0;
  outer: while (true) {
    const seg = parts[0][i];
    if (seg === undefined) break;
    for (const arr of parts) {
      if (arr[i] !== seg) break outer;
    }
    i++;
  }
  const common = '/' + parts[0].slice(0, i).join('/');
  return common || '/';
}

// ── Trash helpers ─────────────────────────────────────────────────────────────

// trashPath = where the file now lives, originalPath = where it came from.
interface TrashItem {
  trashPath: string;
  originalPath: string;
}

interface TrashGroup {
  id: string;
  createdAt: string;
  hostDir: string;
  items: TrashItem[];
}

interface TrashIndex {
  groups: TrashGroup[];
}

function trashDirOf(hostDir: string): string {
  return path.join(hostDir, '.trash');
}
function trashIndexPath(hostDir: string): string {
  return path.join(trashDirOf(hostDir), 'index.json');
}

async function readTrashIndex(hostDir: string): Promise<TrashIndex> {
  try {
    const raw = await fs.promises.readFile(trashIndexPath(hostDir), 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.groups)) return parsed as TrashIndex;
  } catch (_) {}
  return { groups: [] };
}
async function writeTrashIndex(hostDir: string, idx: TrashIndex): Promise<void> {
  await fs.promises.mkdir(trashDirOf(hostDir), { recursive: true });
  await fs.promises.writeFile(trashIndexPath(hostDir), JSON.stringify(idx, null, 2), 'utf8');
}

function newTrashId(): string {
  const now = new Date();
  const ts = [
    now.getUTCFullYear(),
    String(now.getUTCMonth() + 1).padStart(2, '0'),
    String(now.getUTCDate()).padStart(2, '0'),
  ].join('') + '-' + [
    String(now.getUTCHours()).padStart(2, '0'),
    String(now.getUTCMinutes()).padStart(2, '0'),
    String(now.getUTCSeconds()).padStart(2, '0'),
  ].join('') + '-' + crypto.randomBytes(3).toString('hex');
  return ts;
}

// ── Conflict resolution ───────────────────────────────────────────────────────

type ConflictMode = 'skip' | 'overwrite' | 'rename';

function isConflictMode(v: unknown): v is ConflictMode {
  return v === 'skip' || v === 'overwrite' || v === 'rename';
}

// Suffix-based unique-name generator for the 'rename' conflict policy.
// "foo.txt" -> "foo (1).txt" -> "foo (2).txt" ...
async function findFreeName(dir: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 9999; i++) {
    const candidate = `${stem} (${i})${ext}`;
    try {
      await fs.promises.access(path.join(dir, candidate));
    } catch (_) {
      return candidate;
    }
  }
  // Pathological case — fall back to timestamp suffix
  return `${stem} (${Date.now()})${ext}`;
}

// ── Recursive helpers ─────────────────────────────────────────────────────────

async function copyRecursive(src: string, dst: string): Promise<void> {
  // Node 16.7+: fs.cp() with recursive does the right thing including symlinks.
  await fs.promises.cp(src, dst, { recursive: true, errorOnExist: false, force: true });
}

async function moveRecursive(src: string, dst: string): Promise<void> {
  // rename() works for same-filesystem; fall back to copy+remove across
  // filesystems (EXDEV).
  try {
    await fs.promises.rename(src, dst);
  } catch (e: any) {
    if (e?.code !== 'EXDEV') throw e;
    await copyRecursive(src, dst);
    await fs.promises.rm(src, { recursive: true, force: true });
  }
}

async function dirSize(p: string): Promise<{ totalBytes: number; fileCount: number }> {
  let totalBytes = 0;
  let fileCount = 0;
  async function walk(d: string) {
    let entries;
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) {
        try {
          const st = await fs.promises.stat(full);
          totalBytes += st.size;
          fileCount++;
        } catch (_) {}
      }
    }
  }
  const stat = await fs.promises.stat(p);
  if (stat.isDirectory()) await walk(p);
  else if (stat.isFile()) { totalBytes = stat.size; fileCount = 1; }
  return { totalBytes, fileCount };
}

// ── Routes ────────────────────────────────────────────────────────────────────

function registerFileManagerRoutes(app) {
  // ── POST /v1/files/mkdir ────────────────────────────────────────────────────
  // Body: { path, recursive? }  Creates a single directory (or full path tree
  // if recursive). 409 if it already exists and recursive=false.
  app.post('/v1/files/mkdir', async (req, res) => {
    const { path: reqPath, recursive } = req.body || {};
    try {
      const resolved = await safeResolve(reqPath);
      const wantRecursive = !!recursive;
      try {
        await fs.promises.mkdir(resolved, { recursive: wantRecursive });
      } catch (e: any) {
        // EEXIST is only thrown when recursive=false and the path already
        // exists; map it to a clean 409 with the right message based on
        // whether the existing entry is a dir or a file.
        if (e?.code === 'EEXIST') {
          let isDir = false;
          try { isDir = (await fs.promises.stat(resolved)).isDirectory(); } catch (_) {}
          return res.status(409).json({
            success: false,
            error: isDir ? 'Directory already exists' : 'Path exists and is not a directory',
          });
        }
        throw e;
      }
      logger.info('files.mkdir', { path: resolved, recursive: wantRecursive });
      res.json({ success: true, path: resolved });
    } catch (e: any) {
      const status = e?.status || 400;
      res.status(status).json({ success: false, error: e?.message || String(e) });
    }
  });

  // ── POST /v1/files/rename ───────────────────────────────────────────────────
  // Body: { from, to }  `to` may be in a different directory (rename = move).
  app.post('/v1/files/rename', async (req, res) => {
    const { from, to } = req.body || {};
    if (!from || !to) {
      return res.status(400).json({ success: false, error: 'from and to required' });
    }
    try {
      const src = await safeResolve(from);
      const dst = await safeResolve(to);
      // 409 if target already exists — rename is the strict op; users wanting
      // overwrite use /move with conflict='overwrite'.
      try {
        await fs.promises.access(dst);
        return res.status(409).json({ success: false, error: 'Target already exists' });
      } catch (_) {}
      await moveRecursive(src, dst);
      logger.info('files.rename', { from: src, to: dst });
      res.json({ success: true, path: dst });
    } catch (e: any) {
      const status = e?.status || 400;
      res.status(status).json({ success: false, error: e?.message || String(e) });
    }
  });

  // Per-item batch op shared by /move and /copy. Resolves each src under the
  // confine, applies the conflict policy at the destination, and runs `op`
  // (which differs only in fs.rename vs fs.cp). Per-item errors are captured
  // in the results array so a single bad path doesn't abort the batch.
  async function batchOp(req, res, label: 'move' | 'copy', op: (src: string, dst: string) => Promise<void>) {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const destDirRaw = req.body?.destDir;
    const conflictMode: ConflictMode = isConflictMode(req.body?.conflict) ? req.body.conflict : 'rename';
    if (!items.length || !destDirRaw) {
      return res.status(400).json({ success: false, error: 'items and destDir required' });
    }
    try {
      const destDir = await safeResolve(destDirRaw);
      try {
        const st = await fs.promises.stat(destDir);
        if (!st.isDirectory()) return res.status(400).json({ success: false, error: 'destDir is not a directory' });
      } catch (_) {
        return res.status(400).json({ success: false, error: 'destDir does not exist' });
      }
      const results: any[] = [];
      for (const raw of items) {
        try {
          const src = await safeResolve(raw);
          let targetName = path.basename(src);
          let dst = path.join(destDir, targetName);
          let conflict = false;
          try { await fs.promises.access(dst); conflict = true; } catch (_) {}
          if (conflict) {
            if (conflictMode === 'skip') { results.push({ from: src, skipped: true }); continue; }
            if (conflictMode === 'rename') {
              targetName = await findFreeName(destDir, targetName);
              dst = path.join(destDir, targetName);
            } else if (conflictMode === 'overwrite') {
              await fs.promises.rm(dst, { recursive: true, force: true });
            }
          }
          await op(src, dst);
          results.push({ from: src, to: dst });
        } catch (e: any) {
          results.push({ from: raw, error: e?.message || String(e) });
        }
      }
      logger.info(`files.${label}`, { count: results.length, destDir });
      res.json({ success: true, destDir, results });
    } catch (e: any) {
      const status = e?.status || 400;
      res.status(status).json({ success: false, error: e?.message || String(e) });
    }
  }

  // ── POST /v1/files/move ─────────────────────────────────────────────────────
  // Body: { items: string[], destDir, conflict?: 'skip'|'overwrite'|'rename' }
  // Returns per-item results so partial failures don't take down the batch.
  app.post('/v1/files/move', (req, res) => batchOp(req, res, 'move', moveRecursive));

  // ── POST /v1/files/copy ─────────────────────────────────────────────────────
  // Same shape as /move, but recursive copy preserves the source.
  app.post('/v1/files/copy', (req, res) => batchOp(req, res, 'copy', copyRecursive));

  // ── POST /v1/files/trash ────────────────────────────────────────────────────
  // Body: { items: string[], hostDir? }  Moves items into <hostDir>/.trash/
  // <id>/ and records them in <hostDir>/.trash/index.json. Returns the
  // trashId so the FileManager UI can offer an "Undo" toast. If hostDir is
  // omitted, falls back to the deepest allowed root that contains the item
  // (typically HOME) — this is fine for simple cases but the FileManager
  // always passes hostDir = <currentWorkdir> so trash is per-workdir.
  app.post('/v1/files/trash', async (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const hostDirOverrideRaw = req.body?.hostDir;
    if (!items.length) return res.status(400).json({ success: false, error: 'items required' });
    try {
      let hostDirOverride: string | null = null;
      if (hostDirOverrideRaw) hostDirOverride = await safeResolve(String(hostDirOverrideRaw));
      // All items in a single trash call must share the same host root so
      // the index file makes sense. If they don't, we group per-host.
      const byHost = new Map<string, string[]>();
      for (const raw of items) {
        const src = await safeResolve(raw);
        const host = hostDirOverride || (await pickTrashHostDir(src));
        if (!byHost.has(host)) byHost.set(host, []);
        byHost.get(host)!.push(src);
      }
      const groups: TrashGroup[] = [];
      for (const [hostDir, srcs] of byHost) {
        const id = newTrashId();
        const groupDir = path.join(trashDirOf(hostDir), id);
        await fs.promises.mkdir(groupDir, { recursive: true });
        const trashItems: TrashItem[] = [];
        for (const src of srcs) {
          const name = path.basename(src);
          let trashName = name;
          // Same-name collisions inside the group: dedupe.
          let candidate = path.join(groupDir, trashName);
          for (let i = 1; ; i++) {
            try { await fs.promises.access(candidate); }
            catch (_) { break; }
            trashName = `${name}.${i}`;
            candidate = path.join(groupDir, trashName);
          }
          await moveRecursive(src, candidate);
          trashItems.push({ trashPath: candidate, originalPath: src });
        }
        const idx = await readTrashIndex(hostDir);
        const group: TrashGroup = {
          id,
          createdAt: new Date().toISOString(),
          hostDir,
          items: trashItems,
        };
        idx.groups.push(group);
        await writeTrashIndex(hostDir, idx);
        groups.push(group);
      }
      logger.info('files.trash', { count: items.length, groups: groups.length });
      // For the "common case" of all items under one host, surface the
      // single trashId at the top level for convenience.
      const trashId = groups.length === 1 ? groups[0].id : null;
      res.json({ success: true, trashId, groups });
    } catch (e: any) {
      const status = e?.status || 400;
      res.status(status).json({ success: false, error: e?.message || String(e) });
    }
  });

  // ── POST /v1/files/untrash ──────────────────────────────────────────────────
  // Body: { trashId, hostDir? }  Restores a trash group to its original
  // paths. If `hostDir` is omitted, scans HOME and extra roots looking for
  // the group. Conflict policy on restore: 'rename' (always — never clobber
  // newer files at the original path).
  app.post('/v1/files/untrash', async (req, res) => {
    const trashId = String(req.body?.trashId || '').trim();
    const hostDirRaw = req.body?.hostDir;
    if (!trashId) return res.status(400).json({ success: false, error: 'trashId required' });
    try {
      const hostsToCheck: string[] = [];
      if (hostDirRaw) {
        hostsToCheck.push(await safeResolve(String(hostDirRaw)));
      } else {
        hostsToCheck.push(getHome(), ...(await getExtraRoots()));
      }
      let foundIdx: TrashIndex | null = null;
      let foundHost = '';
      let group: TrashGroup | null = null;
      for (const host of hostsToCheck) {
        const idx = await readTrashIndex(host);
        const g = idx.groups.find((x) => x.id === trashId);
        if (g) { foundIdx = idx; foundHost = host; group = g; break; }
      }
      if (!group || !foundIdx) {
        return res.status(404).json({ success: false, error: 'trashId not found' });
      }
      const restored: any[] = [];
      for (const it of group.items) {
        let target = it.originalPath;
        try { await fs.promises.access(target); }
        catch (_) {
          // path is free — restore directly
          await moveRecursive(it.trashPath, target);
          restored.push({ trashPath: it.trashPath, restoredTo: target });
          continue;
        }
        // conflict — pick a free name in the original dir
        const dir = path.dirname(target);
        const name = await findFreeName(dir, path.basename(target));
        target = path.join(dir, name);
        await moveRecursive(it.trashPath, target);
        restored.push({ trashPath: it.trashPath, restoredTo: target, renamed: true });
      }
      // Remove the (now empty) group dir + index entry.
      try {
        await fs.promises.rm(path.join(trashDirOf(foundHost), trashId), { recursive: true, force: true });
      } catch (_) {}
      foundIdx.groups = foundIdx.groups.filter((g) => g.id !== trashId);
      await writeTrashIndex(foundHost, foundIdx);
      logger.info('files.untrash', { trashId, hostDir: foundHost, count: restored.length });
      res.json({ success: true, restored });
    } catch (e: any) {
      const status = e?.status || 400;
      res.status(status).json({ success: false, error: e?.message || String(e) });
    }
  });

  // ── POST /v1/files/empty-trash ──────────────────────────────────────────────
  // Body: { hostDir }  Permanently deletes everything under <hostDir>/.trash.
  app.post('/v1/files/empty-trash', async (req, res) => {
    const hostDirRaw = req.body?.hostDir;
    if (!hostDirRaw) return res.status(400).json({ success: false, error: 'hostDir required' });
    try {
      const hostDir = await safeResolve(String(hostDirRaw));
      const trash = trashDirOf(hostDir);
      let exists = false;
      try { await fs.promises.access(trash); exists = true; } catch (_) {}
      if (exists) {
        await fs.promises.rm(trash, { recursive: true, force: true });
      }
      logger.info('files.empty-trash', { hostDir });
      res.json({ success: true, hostDir });
    } catch (e: any) {
      const status = e?.status || 400;
      res.status(status).json({ success: false, error: e?.message || String(e) });
    }
  });

  // ── GET /v1/files/list-trash ────────────────────────────────────────────────
  // Query: ?hostDir=<dir>  Lists trash groups under hostDir for an "Empty
  // trash" / "Restore from trash" UI panel.
  app.get('/v1/files/list-trash', async (req, res) => {
    const hostDirRaw = typeof req.query.hostDir === 'string' ? req.query.hostDir : '';
    if (!hostDirRaw) return res.status(400).json({ success: false, error: 'hostDir required' });
    try {
      const hostDir = await safeResolve(hostDirRaw);
      const idx = await readTrashIndex(hostDir);
      res.json({ success: true, hostDir, groups: idx.groups });
    } catch (e: any) {
      const status = e?.status || 400;
      res.status(status).json({ success: false, error: e?.message || String(e) });
    }
  });

  // ── POST /v1/files/upload-binary ────────────────────────────────────────────
  // Streams the request body to disk at ?path=. Body content-type is treated
  // as opaque — anything except application/json (which the global json
  // parser would consume) works. We bypass the parser by reading req as a
  // stream. Per-file cap is MAX_FILE_BYTES; the connection is killed on
  // overrun so an attacker can't pump the disk.
  //
  // Query params:
  //   path       — destination absolute or `~/...` path (required)
  //   overwrite  — '1' to allow replacing an existing file (default: 0)
  app.post('/v1/files/upload-binary', async (req, res) => {
    const ct = String(req.headers['content-type'] || '').toLowerCase();
    if (ct.startsWith('application/json')) {
      // The global json parser already consumed the body — refuse.
      return res.status(400).json({
        success: false,
        error: "Use Content-Type: application/octet-stream (or any non-JSON type) for binary uploads",
      });
    }
    const reqPath = typeof req.query.path === 'string' ? req.query.path : '';
    const overwrite = req.query.overwrite === '1' || req.query.overwrite === 'true';
    if (!reqPath) return res.status(400).json({ success: false, error: 'path query param required' });
    let dst: string;
    try { dst = await safeResolve(reqPath); }
    catch (e: any) {
      const status = e?.status || 400;
      return res.status(status).json({ success: false, error: e?.message || String(e) });
    }
    try {
      const exists = await fs.promises.access(dst).then(() => true).catch(() => false);
      if (exists && !overwrite) {
        return res.status(409).json({ success: false, error: 'File exists (use overwrite=1 to replace)' });
      }
      await fs.promises.mkdir(path.dirname(dst), { recursive: true });
      const tmp = dst + '.upload-' + crypto.randomBytes(4).toString('hex');
      const out = fs.createWriteStream(tmp);
      let written = 0;
      let aborted = false;
      const abortWith = (status: number, message: string) => {
        if (aborted) return;
        aborted = true;
        try { req.destroy(); } catch (_) {}
        try { out.destroy(); } catch (_) {}
        fs.promises.unlink(tmp).catch(() => {});
        if (!res.headersSent) res.status(status).json({ success: false, error: message });
      };
      req.on('data', (chunk) => {
        written += chunk.length;
        if (written > MAX_FILE_BYTES) {
          abortWith(413, `File exceeds ${MAX_FILE_BYTES} byte limit`);
        }
      });
      req.on('error', (e) => abortWith(400, e?.message || 'Stream error'));
      out.on('error', (e) => abortWith(500, e?.message || 'Write error'));
      req.pipe(out);
      out.on('finish', async () => {
        if (aborted) return;
        try {
          await fs.promises.rename(tmp, dst);
          logger.info('files.upload-binary', { path: dst, size: written });
          res.json({ success: true, path: dst, size: written });
        } catch (e: any) {
          await fs.promises.unlink(tmp).catch(() => {});
          if (!res.headersSent) res.status(500).json({ success: false, error: e?.message || String(e) });
        }
      });
    } catch (e: any) {
      const status = e?.status || 400;
      if (!res.headersSent) res.status(status).json({ success: false, error: e?.message || String(e) });
    }
  });

  // ── GET /v1/files/disk-usage ────────────────────────────────────────────────
  // ?path=<dir or file>  Returns total bytes + file count for the subtree.
  // Used by the FileManager UI's confirm-delete dialog to show "5 items, 12
  // MB" so users know what they're about to lose.
  app.get('/v1/files/disk-usage', async (req, res) => {
    const reqPath = typeof req.query.path === 'string' ? req.query.path : '';
    if (!reqPath) return res.status(400).json({ success: false, error: 'path required' });
    try {
      const resolved = await safeResolve(reqPath);
      const usage = await dirSize(resolved);
      res.json({ success: true, path: resolved, ...usage });
    } catch (e: any) {
      const status = e?.status || 400;
      res.status(status).json({ success: false, error: e?.message || String(e) });
    }
  });

  // ── POST /v1/files/zip ──────────────────────────────────────────────────────
  // Body:
  //   items[]              — files/folders to include (absolute or `~/...`)
  //   archivePath          — output .zip path (must end in .zip)
  //   overwrite?           — boolean; default false → 409 if archive exists
  //   excludeHidden?       — boolean; default true → skip node_modules, .git,
  //                          .trash, .DS_Store anywhere in the tree (matches
  //                          the FileManager UI's hidden-toggle defaults)
  //   baseDir?             — string; if set, names inside the archive are
  //                          relative to this path. Defaults to the deepest
  //                          common parent of `items` so single-folder backups
  //                          have clean "<name>/..." entries.
  //
  // Implementation: shells out to `/usr/bin/zip -r` via execFile (no shell
  // interpolation). All paths are confined to HOME / extra roots before the
  // child process runs, so even a malicious zip name can't escape.
  app.post('/v1/files/zip', async (req, res) => {
    const items = Array.isArray(req.body?.items) ? req.body.items : [];
    const archivePathRaw = req.body?.archivePath;
    const overwrite = !!req.body?.overwrite;
    const excludeHidden = req.body?.excludeHidden !== false; // default true
    const baseDirRaw = req.body?.baseDir;
    if (!items.length || !archivePathRaw) {
      return res.status(400).json({ success: false, error: 'items and archivePath required' });
    }
    if (!String(archivePathRaw).toLowerCase().endsWith('.zip')) {
      return res.status(400).json({ success: false, error: 'archivePath must end in .zip' });
    }
    try {
      const archivePath = await safeResolve(String(archivePathRaw));
      // Existence check before zip runs — `zip` would otherwise APPEND to an
      // existing archive, which is almost never what the user wants.
      let archiveExists = false;
      try { await fs.promises.access(archivePath); archiveExists = true; } catch (_) {}
      if (archiveExists) {
        if (!overwrite) {
          return res.status(409).json({ success: false, error: 'Archive exists (set overwrite=true to replace)' });
        }
        await fs.promises.unlink(archivePath);
      }
      const resolvedItems = await Promise.all(items.map((raw) => safeResolve(String(raw))));
      // Verify each item exists — `zip` would otherwise return non-zero with
      // a per-item warning and we'd rather fail fast with a clean message.
      const accessChecks = await Promise.all(resolvedItems.map((it) =>
        fs.promises.access(it).then(() => null).catch(() => it)
      ));
      const missing = accessChecks.find((x) => x !== null);
      if (missing) return res.status(404).json({ success: false, error: `Item not found: ${missing}` });
      // Pick base dir: explicit > deepest common parent. Confine the explicit
      // value too so a malicious baseDir can't escape.
      let baseDir: string;
      if (baseDirRaw) {
        baseDir = await safeResolve(String(baseDirRaw));
        // Every item must live under baseDir, otherwise zip would emit
        // "../../<name>" entries which break extraction on most systems.
        for (const it of resolvedItems) {
          if (!(it === baseDir || it.startsWith(baseDir + path.sep))) {
            return res.status(400).json({ success: false, error: `Item ${it} is outside baseDir ${baseDir}` });
          }
        }
      } else {
        baseDir = commonParent(resolvedItems);
      }
      // Make sure baseDir exists and is a dir (could be the case when only
      // one file is selected and its parent was deleted in a race).
      try {
        const st = await fs.promises.stat(baseDir);
        if (!st.isDirectory()) baseDir = path.dirname(baseDir);
      } catch (_) {
        baseDir = path.dirname(resolvedItems[0]);
      }
      // mkdir parent of the archive — convenient for `archive backups/foo.zip`
      await fs.promises.mkdir(path.dirname(archivePath), { recursive: true });
      // Build args: -r recursive, -q quiet, -y store symlinks as-is, then
      // archive path, then each item's path *relative to baseDir*. Excludes
      // come last with -x. We never let users pass -<flag> values.
      const relItems = resolvedItems.map((it) => path.relative(baseDir, it) || path.basename(it));
      const args: string[] = ['-r', '-q', '-y', archivePath, ...relItems];
      if (excludeHidden) args.push('-x', ...HIDDEN_ZIP_EXCLUDES);
      try {
        await execFileP('/usr/bin/zip', args, { cwd: baseDir });
      } catch (e: any) {
        // zip exits non-zero on partial failures (e.g. unreadable file). Best
        // effort: clean up the half-written archive so the next attempt isn't
        // blocked by the existence check.
        await fs.promises.unlink(archivePath).catch(() => {});
        throw e;
      }
      const stat = await fs.promises.stat(archivePath);
      logger.info('files.zip', { archivePath, items: items.length, size: stat.size });
      res.json({ success: true, archivePath, size: stat.size, itemCount: items.length });
    } catch (e: any) {
      const status = e?.status || 500;
      res.status(status).json({ success: false, error: e?.message || String(e) });
    }
  });

  // ── POST /v1/files/unzip ────────────────────────────────────────────────────
  // Body:
  //   archivePath          — .zip file to extract
  //   destDir              — destination directory (created if missing)
  //   overwrite?           — boolean; default false → /usr/bin/unzip -n
  //                          (never overwrite). True → -o (always overwrite).
  //
  // ZIP-slip protection: /usr/bin/unzip 6.x rejects entries with absolute
  // paths or `../` segments by default — defense-in-depth on top of the
  // path-confine we apply before calling it.
  app.post('/v1/files/unzip', async (req, res) => {
    const archivePathRaw = req.body?.archivePath;
    const destDirRaw = req.body?.destDir;
    const overwrite = !!req.body?.overwrite;
    if (!archivePathRaw || !destDirRaw) {
      return res.status(400).json({ success: false, error: 'archivePath and destDir required' });
    }
    try {
      const archivePath = await safeResolve(String(archivePathRaw));
      const destDir = await safeResolve(String(destDirRaw));
      try {
        const st = await fs.promises.stat(archivePath);
        if (!st.isFile()) return res.status(400).json({ success: false, error: 'archivePath is not a file' });
      } catch (_) {
        return res.status(404).json({ success: false, error: 'archivePath does not exist' });
      }
      await fs.promises.mkdir(destDir, { recursive: true });
      // -q quiet, -n never-overwrite OR -o always-overwrite, archive, -d dest.
      // We don't tally the extracted tree on the response — a full
      // recursive walk after extraction can take 5–30 seconds on a big
      // archive and would block the request that whole time. The
      // FileManager refreshes the listing on success, which is enough.
      const args: string[] = ['-q', overwrite ? '-o' : '-n', archivePath, '-d', destDir];
      await execFileP('/usr/bin/unzip', args);
      logger.info('files.unzip', { archivePath, destDir });
      res.json({ success: true, destDir });
    } catch (e: any) {
      const status = e?.status || 500;
      res.status(status).json({ success: false, error: e?.message || String(e) });
    }
  });

  // ── GET /v1/files/find-free-name ────────────────────────────────────────────
  // ?dir=<parent>&name=<original>  Returns a name in <parent> that doesn't
  // exist yet, suffixed " (1)", " (2)" etc. Used by the FileManager upload
  // queue's rename-on-conflict path so it can pick a safe target in a single
  // round-trip instead of N probes.
  app.get('/v1/files/find-free-name', async (req, res) => {
    const dirRaw = typeof req.query.dir === 'string' ? req.query.dir : '';
    const name = typeof req.query.name === 'string' ? req.query.name : '';
    if (!dirRaw || !name) return res.status(400).json({ success: false, error: 'dir and name required' });
    try {
      const dir = await safeResolve(dirRaw);
      const free = await findFreeName(dir, path.basename(name));
      res.json({ success: true, dir, name: free, path: path.join(dir, free) });
    } catch (e: any) {
      const status = e?.status || 400;
      res.status(status).json({ success: false, error: e?.message || String(e) });
    }
  });
}

module.exports = { registerFileManagerRoutes };
