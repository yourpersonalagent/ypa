// server-pet-hatch — receive PNG frames + manifests from the YHA frontend
// hatch wizard and persist them under frontend/public/pets/<id>/.
//
// The bridge does NOT generate images. The user copies prompts from the
// wizard into Grok's web UI manually, downloads the resulting PNGs, drops
// them onto the wizard, and the wizard slices/chroma-keys/uploads them
// here. Persistence is the bridge's only job.
//
// Endpoints:
//   POST   /v1/pets/:id/files     — batch upload PNG files (base64 in JSON)
//   PUT    /v1/pets/:id/manifest  — write the YHA pet manifest JSON
//   GET    /v1/pets               — list known pets
//   DELETE /v1/pets/:id           — delete a pet (frames + manifest)
//
// :id must match `^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]?$` — lowercase
// alphanumeric + hyphen, 1–32 chars. Paths inside batches must end in
// `.png` and contain no slashes. This prevents path traversal and keeps
// the public/pets/ folder clean.
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const https = require('https');
const http = require('http');

// __dirname here is `bridge/modules/pet/lib`; go up four levels to
// reach the repo root, then into frontend/public/pets. (Was
// `..', '..'` before the file moved out of bridge/features/.)
const PETS_PUBLIC_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'frontend', 'public', 'pets');

const PET_ID_RE = /^[a-z0-9][a-z0-9-]{0,30}[a-z0-9]?$/;
const FILE_NAME_RE = /^[a-z0-9_-]+\.png$/i;
const MAX_FILE_BYTES = 4 * 1024 * 1024; // 4 MB per PNG, comfortably above any 960×960 sprite

interface UploadEntry {
  path: string;
  base64: string;
}

function isValidPetId(id: unknown): id is string {
  return typeof id === 'string' && PET_ID_RE.test(id);
}

function isValidFileName(name: unknown): name is string {
  return typeof name === 'string' && FILE_NAME_RE.test(name) && !name.includes('/') && !name.includes('..');
}

async function ensureDir(p: string): Promise<void> {
  await fsp.mkdir(p, { recursive: true });
}

async function listPetIds(): Promise<{ id: string; label: string; thumb?: string }[]> {
  let entries: string[] = [];
  try {
    entries = await fsp.readdir(PETS_PUBLIC_DIR);
  } catch {
    return [];
  }
  const out: { id: string; label: string; thumb?: string }[] = [];
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const id = entry.slice(0, -5);
    if (!isValidPetId(id)) continue;
    let label = id;
    let thumb: string | undefined;
    try {
      const raw = await fsp.readFile(path.join(PETS_PUBLIC_DIR, entry), 'utf8');
      const parsed = JSON.parse(raw);
      const lbl = parsed.label || parsed.displayName || parsed.name;
      if (typeof lbl === 'string' && lbl.trim()) {
        label = lbl.trim();
      }
      // Extract idle thumbnail: prefer dedicated src, fall back to first frame.
      const idle = parsed?.poses?.idle;
      const src: unknown = idle?.src ?? idle?.frames?.[0]?.src;
      if (typeof src === 'string' && src) thumb = src;
    } catch {
      // Manifest unreadable — keep id as label, no thumb.
    }
    out.push({ id, label, ...(thumb !== undefined ? { thumb } : {}) });
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
}

async function deletePet(id: string): Promise<void> {
  const dir = path.join(PETS_PUBLIC_DIR, id);
  const json = path.join(PETS_PUBLIC_DIR, `${id}.json`);
  await fsp.rm(dir, { recursive: true, force: true });
  await fsp.rm(json, { force: true });
}

function decodeBase64(b64: string): Buffer {
  // Strip data URL prefix if present.
  const stripped = b64.replace(/^data:image\/png;base64,/i, '');
  return Buffer.from(stripped, 'base64');
}

// ── Codex pet import helpers ──────────────────────────────────────────────────

/** Allowed URL host patterns for codex-pet downloads. Extend as needed. */
const ALLOWED_PET_HOSTS: RegExp[] = [
  /^[a-zA-Z0-9-]+\.supabase\.co$/,
  /^codex-pets\.net$/,
  /^[a-zA-Z0-9-]+\.codex-pets\.net$/,
];

function isAllowedPetHost(hostname: string): boolean {
  return ALLOWED_PET_HOSTS.some((re) => re.test(hostname));
}

/** Download a URL to a local file, following up to 5 redirects. */
async function downloadPetZip(url: string, dest: string, redirectsLeft = 5): Promise<void> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return reject(new Error(`Invalid download URL: ${url}`));
    }
    // Re-validate EVERY hop (the initial URL and each redirect target): the
    // scheme must be http(s) and the host must be on the pet-download
    // allowlist. The route handler only checks the first URL, so without this
    // a 302 from an allowed host (or an open redirect on one, e.g. *.supabase.co)
    // could bounce the download to an internal or unlisted target.
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return reject(new Error(`Blocked redirect scheme: ${parsed.protocol}`));
    }
    if (!isAllowedPetHost(parsed.hostname)) {
      return reject(new Error(`Blocked redirect to disallowed host: ${parsed.hostname}`));
    }
    const mod = parsed.protocol === 'https:' ? https : http;
    const req = (mod as any).get(url, { timeout: 20_000 }, (res: any) => {
      const status: number = res.statusCode;
      if (status >= 300 && status < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('Too many redirects'));
        // Location may be relative — resolve it against the current URL before
        // recursing. The recursive call re-runs the scheme + host checks above.
        let nextUrl: string;
        try {
          nextUrl = new URL(res.headers.location, url).href;
        } catch {
          return reject(new Error('Invalid redirect location'));
        }
        downloadPetZip(nextUrl, dest, redirectsLeft - 1).then(resolve).catch(reject);
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        return reject(new Error(`HTTP ${status} downloading pet zip`));
      }
      const out = fs.createWriteStream(dest);
      res.pipe(out);
      out.on('finish', () => { (out as any).close(); resolve(); });
      out.on('error', (e: Error) => { fsp.unlink(dest).catch(() => {}); reject(e); });
      res.on('error', (e: Error) => { fsp.unlink(dest).catch(() => {}); reject(e); });
    });
    req.on('error', (e: Error) => reject(e));
    req.setTimeout(20_000, () => { req.destroy(new Error('Download timeout')); });
  });
}

/** List archive member names (one per line) via zipinfo mode. */
async function listZipEntries(zipPath: string): Promise<string[]> {
  return new Promise((resolve, reject) => {
    execFile(
      'unzip',
      ['-Z1', zipPath],
      { timeout: 15_000, maxBuffer: 8 * 1024 * 1024 },
      (err: any, stdout: string, stderr: string) => {
        if (err) return reject(new Error(`unzip -Z1 failed (is 'unzip' installed?): ${stderr || err.message}`));
        resolve(stdout.split('\n').map((s) => s.trim()).filter(Boolean));
      },
    );
  });
}

/**
 * Reject zip-slip: any member whose path is absolute, contains a `..`
 * segment, or otherwise resolves outside targetDir. System `unzip` does not
 * guard against traversal entries, so we validate the listing first and only
 * extract when every member is confined to targetDir.
 */
function assertSafeZipEntries(entries: string[], targetDir: string): void {
  const baseResolved = path.resolve(targetDir);
  for (const entry of entries) {
    // Backslashes / drive letters: treat as hostile (Linux unzip would keep a
    // literal backslash, but normalise defensively rather than guess).
    if (entry.includes('\\') || /^[a-zA-Z]:/.test(entry)) {
      throw new Error(`unsafe zip entry (windows path): ${entry}`);
    }
    if (path.isAbsolute(entry)) {
      throw new Error(`unsafe zip entry (absolute path): ${entry}`);
    }
    const resolved = path.resolve(baseResolved, entry);
    const rel = path.relative(baseResolved, resolved);
    if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
      throw new Error(`unsafe zip entry (path traversal): ${entry}`);
    }
  }
}

/** Extract zip to targetDir via system `unzip` (standard on Linux). */
async function unzipPet(zipPath: string, targetDir: string): Promise<void> {
  const entries = await listZipEntries(zipPath);
  assertSafeZipEntries(entries, targetDir);
  return new Promise((resolve, reject) => {
    execFile(
      'unzip',
      ['-o', zipPath, '-d', targetDir],
      { timeout: 15_000 },
      (err: any, _stdout: string, stderr: string) => {
        if (err) reject(new Error(`unzip failed (is 'unzip' installed?): ${stderr || err.message}`));
        else resolve();
      },
    );
  });
}

/** Recursively list all files under a directory. */
async function collectFiles(dir: string): Promise<string[]> {
  const results: string[] = [];
  async function scan(d: string): Promise<void> {
    let entries: any[];
    try { entries = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) await scan(full);
      else results.push(full);
    }
  }
  await scan(dir);
  return results;
}

/** Find and parse the pet manifest from extracted files.
 *  Prefers manifest.json / pet.json; falls back to any .json with a `name` or `id` field.
 *  Accepts both YHA format (name) and Codex Original format (id + displayName). */
async function findPetManifest(files: string[]): Promise<any> {
  const jsonFiles = files.filter((f) => /\.json$/i.test(f));
  const preferred = jsonFiles.filter((f) => {
    const base = path.basename(f).toLowerCase();
    return base === 'manifest.json' || base === 'pet.json';
  });
  const candidates = preferred.length ? preferred : jsonFiles;
  for (const f of candidates) {
    try {
      const raw = await fsp.readFile(f, 'utf8');
      const parsed = JSON.parse(raw);
      const hasName = typeof parsed.name === 'string' && parsed.name;
      const hasId   = typeof parsed.id   === 'string' && parsed.id;
      if (hasName || hasId) return parsed;
    } catch {}
  }
  throw new Error('No valid manifest found in zip (expected manifest.json or pet.json with a name or id field)');
}

// ── Codex spritesheet constants ────────────────────────────────────────────────
// Codex pets ship a single spritesheet.webp at 1536×1872 px:
//   8 columns × 192 px wide, 9 rows × 208 px tall.
// Each row is one animation; each column is one frame.
const CODEX_DEFAULT_EFFECT_ZONE = { width: 300, height: 300, top: -80, left: -60 };
const CODEX_COLS = 8;
const CODEX_CELL_W = 192;
const CODEX_CELL_H = 208;

// Row order verified against the codex-pets spritesheet atlas (8 cols × 9 rows).
// Rows 1↔5 (running/thinking) and rows 3↔4 (happy/error) were swapped in the
// original assumption — corrected by visual frame-by-frame inspection.
const CODEX_ROW_MOODS: Array<{ mood: string; duration: number }> = [
  { mood: 'idle',      duration: 140 }, // row 0 — breathing loop
  { mood: 'running',   duration: 125 }, // row 1 — force-sprint (crouched locomotion)
  { mood: 'streaming', duration:  90 }, // row 2 — busy working
  { mood: 'happy',     duration: 140 }, // row 3 — lightsaber wave / celebrate
  { mood: 'error',     duration:  90 }, // row 4 — stumble / reaction
  { mood: 'thinking',  duration: 110 }, // row 5 — deep meditation / force trance
  { mood: 'jumping',   duration: 105 }, // row 6 — jump arc (locomotion)
  { mood: 'powermove', duration: 140 }, // row 7 — power move action
  { mood: 'xpeffect',  duration:  90 }, // row 8 — xp burst / victory bow
];

// Codex sprites are drawn facing LEFT. YHA's flip logic expects RIGHT-facing
// sprites (scaleX(-1) = face left). We hflip every cell at import so the
// resulting frames behave like any native YHA pet.
const CODEX_HFLIP = true;

// PNG files smaller than this after cropping are blank / fully-transparent
// cells — the spritesheet pads unused frames with empty space.
const CODEX_EMPTY_THRESHOLD_BYTES = 2000;

function addPoseDefaults(pose: any): any {
  return { hotspotAnchor: 'bottom-center', effectZone: CODEX_DEFAULT_EFFECT_ZONE, ...pose };
}

/** Crop (and optionally flip) one cell from a spritesheet using ffmpeg. */
function cropCell(src: string, dest: string, x: number, y: number, hflip: boolean): Promise<void> {
  const filter = hflip
    ? `crop=${CODEX_CELL_W}:${CODEX_CELL_H}:${x}:${y},hflip`
    : `crop=${CODEX_CELL_W}:${CODEX_CELL_H}:${x}:${y}`;
  return new Promise((resolve, reject) => {
    execFile(
      'ffmpeg',
      ['-y', '-i', src, '-vf', filter, '-frames:v', '1', dest],
      { timeout: 15_000 },
      (err: any) => { if (err) reject(new Error(`ffmpeg crop failed: ${err.message}`)); else resolve(); },
    );
  });
}

/** Slice a Codex 8×9 spritesheet into individual frame PNGs.
 *  All 72 crops run in parallel. Empty cells (< CODEX_EMPTY_THRESHOLD_BYTES)
 *  are deleted and omitted from the frames list. Poses with no surviving
 *  frames are skipped — petStore's withPoseFallbacks() fills them at runtime. */
async function sliceCodexSpritesheet(
  spritesheetPath: string,
  targetDir: string,
  petId: string,
): Promise<Record<string, any>> {
  // Build crop jobs: one per cell, all run in parallel.
  type CellMeta = { mood: string; duration: number; framePath: string; frameSrc: string };
  const cells: CellMeta[] = [];
  const jobs: Promise<void>[] = [];

  for (let row = 0; row < CODEX_ROW_MOODS.length; row++) {
    const { mood, duration } = CODEX_ROW_MOODS[row];
    for (let col = 0; col < CODEX_COLS; col++) {
      const frameName = `${mood}_f${String(col + 1).padStart(2, '0')}.png`;
      const framePath = path.join(targetDir, frameName);
      cells.push({ mood, duration, framePath, frameSrc: `/pets/${petId}/${frameName}` });
      jobs.push(cropCell(spritesheetPath, framePath, col * CODEX_CELL_W, row * CODEX_CELL_H, CODEX_HFLIP));
    }
  }
  await Promise.all(jobs);

  // Post-process: check each file size. Delete blank frames; skip in manifest.
  const poseFrames: Record<string, { src: string; duration: number }[]> = {};
  for (const cell of cells) {
    let size = 0;
    try { size = (await fsp.stat(cell.framePath)).size; } catch { /* file missing */ }
    if (size < CODEX_EMPTY_THRESHOLD_BYTES) {
      await fsp.unlink(cell.framePath).catch(() => {});
      continue;
    }
    if (!poseFrames[cell.mood]) poseFrames[cell.mood] = [];
    poseFrames[cell.mood].push({ src: cell.frameSrc, duration: cell.duration });
  }

  const poses: Record<string, any> = {};
  for (const [mood, frames] of Object.entries(poseFrames)) {
    if (frames.length > 0) poses[mood] = addPoseDefaults({ frames });
  }
  return poses;
}

/** Ensure every pose in a YHA manifest has hotspotAnchor + effectZone. */
function normalizeCodexManifest(m: any, petId: string): any {
  const label = String(m.displayName || m.label || m.name || petId).trim();
  if (!m.poses || typeof m.poses !== 'object') return { ...m, name: petId, label };
  const fixedPoses: Record<string, any> = {};
  for (const [key, val] of Object.entries(m.poses)) {
    fixedPoses[key] = addPoseDefaults(val);
  }
  return { ...m, name: petId, label, poses: fixedPoses };
}

function registerPetHatchRoutes(app: any): void {
  // Make sure the public/pets directory exists at startup so listing works
  // even before the first hatch.
  try {
    fs.mkdirSync(PETS_PUBLIC_DIR, { recursive: true });
  } catch (e) {
    console.warn('[pet-hatch] public/pets ensure failed:', (e as Error).message);
  }

  app.get('/v1/pets', async (_req: any, res: any) => {
    try {
      const pets = await listPetIds();
      res.json({ pets });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.post('/v1/pets/:id/files', async (req: any, res: any) => {
    const id = String(req.params.id || '');
    if (!isValidPetId(id)) {
      return res.status(400).json({ error: 'Invalid pet id' });
    }
    const body = req.body;
    const files: UploadEntry[] = Array.isArray(body?.files) ? body.files : [];
    if (!files.length) {
      return res.status(400).json({ error: 'files[] required' });
    }
    const targetDir = path.join(PETS_PUBLIC_DIR, id);
    try {
      await ensureDir(targetDir);
      const written: string[] = [];
      for (const entry of files) {
        if (!entry || typeof entry !== 'object') {
          return res.status(400).json({ error: 'Invalid file entry' });
        }
        if (!isValidFileName(entry.path)) {
          return res.status(400).json({ error: `Invalid file path "${entry.path}"` });
        }
        if (typeof entry.base64 !== 'string') {
          return res.status(400).json({ error: `Missing base64 data for "${entry.path}"` });
        }
        const buf = decodeBase64(entry.base64);
        if (buf.length === 0) {
          return res.status(400).json({ error: `Empty file "${entry.path}"` });
        }
        if (buf.length > MAX_FILE_BYTES) {
          return res.status(413).json({ error: `File "${entry.path}" exceeds ${MAX_FILE_BYTES} bytes` });
        }
        // Sanity: PNG signature.
        if (
          buf.length < 8 ||
          buf[0] !== 0x89 ||
          buf[1] !== 0x50 ||
          buf[2] !== 0x4e ||
          buf[3] !== 0x47
        ) {
          return res.status(400).json({ error: `File "${entry.path}" is not a PNG` });
        }
        await fsp.writeFile(path.join(targetDir, entry.path), buf);
        written.push(entry.path);
      }
      res.json({ id, written });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  app.put('/v1/pets/:id/manifest', async (req: any, res: any) => {
    const id = String(req.params.id || '');
    if (!isValidPetId(id)) {
      return res.status(400).json({ error: 'Invalid pet id' });
    }
    const manifest = req.body;
    if (!manifest || typeof manifest !== 'object') {
      return res.status(400).json({ error: 'Manifest body required' });
    }
    if (manifest.name !== id) {
      return res.status(400).json({ error: 'Manifest name must match pet id' });
    }
    if (!manifest.poses || typeof manifest.poses !== 'object') {
      return res.status(400).json({ error: 'Manifest must define poses' });
    }
    try {
      await ensureDir(PETS_PUBLIC_DIR);
      const json = JSON.stringify(manifest, null, 2) + '\n';
      await fsp.writeFile(path.join(PETS_PUBLIC_DIR, `${id}.json`), json, 'utf8');
      res.json({ id, ok: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  /** List all animation-frame PNGs in a pet's folder.
   *  Returns filenames matching <row>-NN.png, sorted.
   *  Excludes _base.png and other utility files (underscore prefix). */
  app.get('/v1/pets/:id/list-frames', async (req: any, res: any) => {
    const id = String(req.params.id || '');
    if (!isValidPetId(id)) {
      return res.status(400).json({ error: 'Invalid pet id' });
    }
    try {
      const dir = path.join(PETS_PUBLIC_DIR, id);
      let entries: string[] = [];
      try {
        entries = await fsp.readdir(dir);
      } catch (_) { /* dir may not exist yet */ }
      const files = entries
        .filter((f) => /^[a-z][a-z0-9-]*-\d{2}\.png$/i.test(f))
        .sort();
      res.json({ id, files });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });

  // ── Import a Codex pet from a download URL (curl-command or bare URL) ──────
  // Accepts: POST /v1/pets/import-codex  { url: "https://..." }
  // Downloads the zip, unzips it, extracts the manifest + PNG frames,
  // and installs the pet into frontend/public/pets/<id>/.
  app.post('/v1/pets/import-codex', async (req: any, res: any) => {
    const { url } = (req.body ?? {}) as { url?: unknown };
    if (!url || typeof url !== 'string') {
      return res.status(400).json({ error: 'url required' });
    }
    let parsed: URL;
    try { parsed = new URL(url); } catch {
      return res.status(400).json({ error: 'Invalid URL' });
    }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return res.status(400).json({ error: 'Only http(s) URLs allowed' });
    }
    if (!isAllowedPetHost(parsed.hostname)) {
      return res.status(400).json({ error: `Host not allowed: ${parsed.hostname}` });
    }
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'codex-pet-'));
    const tmpZip = path.join(tmpDir, 'pet.zip');
    const extractDir = path.join(tmpDir, 'extracted');
    try {
      await downloadPetZip(url, tmpZip);
      await ensureDir(extractDir);
      await unzipPet(tmpZip, extractDir);
      const allFiles = await collectFiles(extractDir);
      const manifest = await findPetManifest(allFiles);
      // Accept both Codex format (id) and YHA format (name) as the pet identifier.
      const petId: string = String(manifest.id || manifest.name || '').trim();
      if (!isValidPetId(petId)) {
        return res.status(400).json({ error: `Invalid pet id in manifest: "${petId}"` });
      }
      const targetDir = path.join(PETS_PUBLIC_DIR, petId);
      await ensureDir(targetDir);
      // Copy all image files: PNG frames (YHA) or WebP spritesheets (Codex).
      const imageFiles = allFiles.filter((f: string) => /\.(png|webp)$/i.test(f));
      const written: string[] = [];
      for (const src of imageFiles) {
        const base = path.basename(src).toLowerCase();
        // Basic path-safety check — no slashes, no dotdot, only safe chars.
        if (!/^[a-z0-9][a-z0-9_.-]*\.(png|webp)$/i.test(base) || base.includes('..')) continue;
        await fsp.copyFile(src, path.join(targetDir, base));
        written.push(base);
      }
      // Build YHA manifest. Codex format (spritesheetPath, no poses) needs
      // spritesheet slicing; YHA format (poses already present) just needs
      // hotspotAnchor/effectZone normalization.
      let normalizedManifest: any;
      const label = String(manifest.displayName || manifest.label || manifest.name || petId).trim();
      if (!manifest.poses && typeof manifest.spritesheetPath === 'string') {
        // Codex format — slice the 8×9 spritesheet into per-frame PNGs.
        const sheetSrc = path.join(targetDir, path.basename(manifest.spritesheetPath));
        const poses = await sliceCodexSpritesheet(sheetSrc, targetDir, petId);
        normalizedManifest = {
          name: petId,
          label,
          description: String(manifest.description || '').trim(),
          homeSpot: { x: null, y: 420 },
          spriteFormat: 'codex-imported',
          spriteSize: CODEX_CELL_W,
          poses,
          // Codex pets ship the 9 canonical Codex rows — V3's wander+perch
          // repertoire is the cleaner Codex-aligned default; V1's richer
          // behaviour set was tuned around the /hedge animation set.
          preferredProfile: 'petV3',
        };
      } else {
        normalizedManifest = normalizeCodexManifest(manifest, petId);
      }
      const manifestJson = JSON.stringify(normalizedManifest, null, 2) + '\n';
      await fsp.writeFile(path.join(PETS_PUBLIC_DIR, `${petId}.json`), manifestJson, 'utf8');
      res.json({ ok: true, manifest: normalizedManifest, written });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    } finally {
      fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  app.delete('/v1/pets/:id', async (req: any, res: any) => {
    const id = String(req.params.id || '');
    if (!isValidPetId(id)) {
      return res.status(400).json({ error: 'Invalid pet id' });
    }
    try {
      await deletePet(id);
      res.json({ id, deleted: true });
    } catch (e) {
      res.status(500).json({ error: (e as Error).message });
    }
  });
}

module.exports = { registerPetHatchRoutes };
