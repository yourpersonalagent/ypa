// ── Config versioning ─────────────────────────────────────────────────────────
// Watches the internal JSON config files in bridge/ and creates timestamped
// snapshots into bridge/config-history/<profile>/<id>/. Snapshots are smart-
// bundled: the first change after a quiet period opens a 5-minute window;
// every subsequent change inside that window is folded into the same snapshot
// (variant 1). The ringbuffer keeps the last 50 snapshots per profile.
//
// API endpoints (all under /v1/config-versions):
//   GET    /list                         — current profile + snapshots
//   POST   /snapshot-now                 — force-flush pending bundle now
//   POST   /restore/:id                  — restore a snapshot (auto-snapshots first if dirty)
//   POST   /label/:id                    — set/clear a human label on a snapshot
//   DELETE /:id                          — delete a snapshot
//   GET    /profiles                     — list profiles + active
//   POST   /profiles/:name               — create a profile (copies current)
//   POST   /profiles/:name/switch        — switch to profile (auto-snapshots if dirty)
//   DELETE /profiles/:name               — delete a profile (must not be active)
//   POST   /test-defaults                — wipe configs to example/empty defaults (auto-snapshots first)
'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const BRIDGE_DIR: string = path.join(__dirname, '..');
const HISTORY_ROOT: string = path.join(BRIDGE_DIR, 'config-history');
const PROFILES_STATE_FILE: string = path.join(HISTORY_ROOT, '_state.json');
const MAX_SNAPSHOTS_PER_PROFILE = 50;
const BUNDLE_WINDOW_MS = 5 * 60 * 1000;

// Internal config files we version. Anything not in this list (api-keys.json,
// .env, runtime state like costs.json/search-usage.json/mcp-state.json) is
// intentionally excluded. Add new internal config files here.
const VERSIONED_FILES: string[] = [
  'config.json',
  'prefs.json',
  'partners.json',
  'search-config.json',
  'mcp-registry.json',
  'ftp-connections.json',
  'openai-proxy-prefs.json',
];

// Files matched by the example-restore. Empty target => file is removed.
const DEFAULT_TEMPLATE: Record<string, string | null> = {
  'config.json': 'config.example.json', // restored from this template if present
  'prefs.json': null, // empty {}
  'partners.json': null,
  'search-config.json': null,
  'mcp-registry.json': null,
  'ftp-connections.json': null,
  'openai-proxy-prefs.json': null,
};

type SnapshotMeta = {
  id: string;
  createdAt: number;
  updatedAt: number;
  changeCount: number;
  label: string;
  files: { name: string; sha256: string; size: number }[];
  trigger: 'auto' | 'manual' | 'pre-restore' | 'pre-defaults' | 'pre-profile-switch';
};

type ProfilesState = {
  active: string;
  profiles: string[];
};

// ── filesystem helpers ────────────────────────────────────────────────────────
function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}
async function ensureDirAsync(p: string) {
  await fsp.mkdir(p, { recursive: true });
}

function sha256OfFile(p: string): string | null {
  try {
    const buf = fs.readFileSync(p);
    return crypto.createHash('sha256').update(buf).digest('hex');
  } catch {
    return null;
  }
}

function safeProfileName(name: string): string {
  const cleaned = String(name || '').trim().replace(/[^a-zA-Z0-9_\- ]/g, '_').slice(0, 64);
  return cleaned || 'default';
}

// ── profiles state ────────────────────────────────────────────────────────────
function loadProfilesState(): ProfilesState {
  try {
    const raw = fs.readFileSync(PROFILES_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.profiles) && typeof parsed.active === 'string') {
      const profiles: string[] = parsed.profiles.map(safeProfileName).filter(Boolean);
      const unique: string[] = Array.from(new Set(profiles));
      const active = unique.includes(parsed.active) ? parsed.active : (unique[0] || 'default');
      if (!unique.length) unique.push('default');
      return { active, profiles: unique };
    }
  } catch {}
  return { active: 'default', profiles: ['default'] };
}

function saveProfilesState(state: ProfilesState) {
  ensureDir(HISTORY_ROOT);
  fs.writeFileSync(PROFILES_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function profileDir(name: string): string {
  return path.join(HISTORY_ROOT, safeProfileName(name));
}

// ── snapshot directory listing ────────────────────────────────────────────────
function listSnapshotIds(profile: string): string[] {
  const dir = profileDir(profile);
  try {
    return fs
      .readdirSync(dir)
      .filter((n: string) => /^\d{4}-\d{2}-\d{2}T/.test(n))
      .sort();
  } catch {
    return [];
  }
}

function readSnapshotMeta(profile: string, id: string): SnapshotMeta | null {
  try {
    const raw = fs.readFileSync(path.join(profileDir(profile), id, 'meta.json'), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function writeSnapshotMeta(profile: string, id: string, meta: SnapshotMeta) {
  fs.writeFileSync(path.join(profileDir(profile), id, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
}

// ── change detection: hash the live VERSIONED_FILES set ───────────────────────
function liveFingerprint(): { name: string; sha256: string; size: number }[] {
  const out: { name: string; sha256: string; size: number }[] = [];
  for (const name of VERSIONED_FILES) {
    const p = path.join(BRIDGE_DIR, name);
    let size = 0;
    let sha = '';
    try {
      const st = fs.statSync(p);
      size = st.size;
      const buf = fs.readFileSync(p);
      sha = crypto.createHash('sha256').update(buf).digest('hex');
    } catch {
      // missing file → record as absent (sha empty)
      sha = '';
      size = 0;
    }
    out.push({ name, sha256: sha, size });
  }
  return out;
}

function fingerprintsEqual(a: { name: string; sha256: string }[], b: { name: string; sha256: string }[]): boolean {
  if (a.length !== b.length) return false;
  const ma = new Map(a.map((x) => [x.name, x.sha256]));
  for (const e of b) {
    if (ma.get(e.name) !== e.sha256) return false;
  }
  return true;
}

function lastSnapshotFingerprint(profile: string): { name: string; sha256: string }[] | null {
  const ids = listSnapshotIds(profile);
  for (let i = ids.length - 1; i >= 0; i--) {
    const meta = readSnapshotMeta(profile, ids[i]);
    if (meta) return meta.files;
  }
  return null;
}

function isDirty(profile: string): boolean {
  const live = liveFingerprint();
  const last = lastSnapshotFingerprint(profile);
  if (!last) return live.some((f) => f.sha256); // any non-empty file ⇒ dirty
  return !fingerprintsEqual(live, last);
}

// ── snapshot creation ─────────────────────────────────────────────────────────
function buildId(d: Date): string {
  // 2026-05-01T14-23-07-512Z (filesystem-safe ISO)
  return d.toISOString().replace(/:/g, '-').replace(/\.(\d{3})Z$/, '-$1Z');
}

function createSnapshot(opts: {
  profile: string;
  trigger: SnapshotMeta['trigger'];
  label?: string;
}): SnapshotMeta | null {
  const { profile, trigger, label } = opts;
  const live = liveFingerprint();
  const last = lastSnapshotFingerprint(profile);
  if (last && fingerprintsEqual(live, last)) {
    return null; // no-op, nothing changed
  }
  const id = buildId(new Date());
  const dir = path.join(profileDir(profile), id);
  ensureDir(dir);
  for (const f of live) {
    const src = path.join(BRIDGE_DIR, f.name);
    const dst = path.join(dir, f.name);
    if (f.sha256) {
      try { fs.copyFileSync(src, dst); } catch {}
    } else {
      // Mark absent files explicitly so restore can remove them.
      // We just don't copy — meta records the empty hash and restore handles it.
    }
  }
  const meta: SnapshotMeta = {
    id,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    changeCount: 1,
    label: label || '',
    files: live,
    trigger,
  };
  writeSnapshotMeta(profile, id, meta);
  pruneOldSnapshots(profile);
  return meta;
}

function pruneOldSnapshots(profile: string) {
  const ids = listSnapshotIds(profile);
  const overflow = ids.length - MAX_SNAPSHOTS_PER_PROFILE;
  if (overflow <= 0) return;
  for (let i = 0; i < overflow; i++) {
    const dir = path.join(profileDir(profile), ids[i]);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
}

// ── bundle window (variant 1: 5-min from first change) ────────────────────────
let bundleTimer: NodeJS.Timeout | null = null;
let bundleOpenedAt = 0;
let bundleChangeCount = 0;
let lastSeenFingerprint: string | null = null;

function fingerprintHash(fp: { name: string; sha256: string }[]): string {
  return fp.map((x) => `${x.name}:${x.sha256}`).join('|');
}

function watchedFilePaths(): string[] {
  return VERSIONED_FILES.map((n) => path.join(BRIDGE_DIR, n));
}

function noteChange() {
  // Only react if something actually changed since last seen
  const live = liveFingerprint();
  const h = fingerprintHash(live);
  if (h === lastSeenFingerprint) return;
  lastSeenFingerprint = h;

  const profile = loadProfilesState().active;
  // Ignore if not actually different from the last snapshot
  const last = lastSnapshotFingerprint(profile);
  if (last && fingerprintsEqual(live, last)) return;

  if (!bundleTimer) {
    bundleOpenedAt = Date.now();
    bundleChangeCount = 1;
    bundleTimer = setTimeout(() => flushBundle(), BUNDLE_WINDOW_MS);
  } else {
    bundleChangeCount++;
  }
}

function flushBundle() {
  if (bundleTimer) {
    clearTimeout(bundleTimer);
    bundleTimer = null;
  }
  const profile = loadProfilesState().active;
  const meta = createSnapshot({ profile, trigger: 'auto' });
  if (meta) {
    meta.changeCount = Math.max(1, bundleChangeCount);
    writeSnapshotMeta(profile, meta.id, meta);
  }
  bundleChangeCount = 0;
  bundleOpenedAt = 0;
}

// ── watcher ───────────────────────────────────────────────────────────────────
let watchersStarted = false;
function startWatchers() {
  if (watchersStarted) return;
  watchersStarted = true;
  ensureDir(HISTORY_ROOT);

  // Seed lastSeenFingerprint so watchers don't flag the initial state as a change.
  lastSeenFingerprint = fingerprintHash(liveFingerprint());

  // Make sure default profile exists in state.
  const st = loadProfilesState();
  saveProfilesState(st);

  for (const file of watchedFilePaths()) {
    try {
      // fs.watch may fire 'rename' on atomic writes (tmp → rename); re-attaching is cheap.
      const setup = () => {
        try {
          fs.watch(file, { persistent: false }, () => {
            // small debounce against double-fires (rename then change)
            setTimeout(noteChange, 50);
          });
        } catch {}
      };
      setup();
    } catch {}
  }

  // Safety net: poll every 30s in case watch missed anything (rename+atomic-write).
  setInterval(() => {
    try { noteChange(); } catch {}
  }, 30_000).unref?.();
}

// ── restore ───────────────────────────────────────────────────────────────────
async function restoreSnapshot(profile: string, id: string): Promise<void> {
  const meta = readSnapshotMeta(profile, id);
  if (!meta) throw new Error('snapshot not found');
  // Suspend the change-detector during restore by temporarily marking the
  // "last seen" fingerprint to whatever we're about to write.
  const dir = path.join(profileDir(profile), id);
  for (const f of meta.files) {
    const dst = path.join(BRIDGE_DIR, f.name);
    const src = path.join(dir, f.name);
    if (!f.sha256) {
      // file was absent at snapshot-time → remove the live one
      try { await fsp.unlink(dst); } catch {}
    } else {
      try {
        const buf = await fsp.readFile(src);
        await fsp.writeFile(dst + '.tmp', buf);
        await fsp.rename(dst + '.tmp', dst);
      } catch (e) {
        throw new Error(`failed to restore ${f.name}: ${(e as Error).message}`);
      }
    }
  }
  // Re-seed fingerprint to suppress an immediate auto-snapshot.
  lastSeenFingerprint = fingerprintHash(liveFingerprint());
}

// ── reset to defaults (test fresh install) ────────────────────────────────────
async function resetToDefaults(): Promise<void> {
  for (const [name, template] of Object.entries(DEFAULT_TEMPLATE)) {
    const dst = path.join(BRIDGE_DIR, name);
    if (template) {
      const src = path.join(BRIDGE_DIR, template);
      try {
        const buf = await fsp.readFile(src);
        await fsp.writeFile(dst + '.tmp', buf);
        await fsp.rename(dst + '.tmp', dst);
      } catch {
        // template missing → fall back to empty {}
        await fsp.writeFile(dst, '{}\n', 'utf8');
      }
    } else {
      await fsp.writeFile(dst, '{}\n', 'utf8');
    }
  }
  lastSeenFingerprint = fingerprintHash(liveFingerprint());
}

// ── REST routes ───────────────────────────────────────────────────────────────
function registerConfigVersionRoutes(app: any) {
  startWatchers();

  app.get('/v1/config-versions/list', (_req: any, res: any) => {
    try {
      const state = loadProfilesState();
      const ids = listSnapshotIds(state.active);
      const snapshots = ids
        .map((id) => readSnapshotMeta(state.active, id))
        .filter(Boolean) as SnapshotMeta[];
      const dirty = isDirty(state.active);
      const pendingBundle = bundleTimer
        ? { since: bundleOpenedAt, changes: bundleChangeCount, willFlushAt: bundleOpenedAt + BUNDLE_WINDOW_MS }
        : null;
      res.json({
        success: true,
        activeProfile: state.active,
        profiles: state.profiles,
        snapshots: snapshots.reverse(), // newest first
        dirty,
        pendingBundle,
        bundleWindowMs: BUNDLE_WINDOW_MS,
        maxSnapshots: MAX_SNAPSHOTS_PER_PROFILE,
        versionedFiles: VERSIONED_FILES,
      });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/v1/config-versions/snapshot-now', (_req: any, res: any) => {
    try {
      flushBundle();
      const profile = loadProfilesState().active;
      // If still no diff vs last, force a snapshot (manual = explicit user intent).
      const last = lastSnapshotFingerprint(profile);
      const live = liveFingerprint();
      if (!last || !fingerprintsEqual(live, last)) {
        const m = createSnapshot({ profile, trigger: 'manual' });
        return res.json({ success: true, snapshot: m });
      }
      res.json({ success: true, snapshot: null, note: 'no changes since last snapshot' });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/v1/config-versions/restore/:id', async (req: any, res: any) => {
    try {
      const profile = loadProfilesState().active;
      // pre-restore safety snapshot if dirty
      if (isDirty(profile)) {
        createSnapshot({ profile, trigger: 'pre-restore' });
      }
      await restoreSnapshot(profile, req.params.id);
      res.json({ success: true, note: 'config restored — bridge restart may be required for some changes to take effect' });
    } catch (e: any) {
      res.status(400).json({ success: false, error: e.message });
    }
  });

  app.post('/v1/config-versions/label/:id', (req: any, res: any) => {
    try {
      const profile = loadProfilesState().active;
      const meta = readSnapshotMeta(profile, req.params.id);
      if (!meta) return res.status(404).json({ success: false, error: 'not found' });
      meta.label = String((req.body && req.body.label) || '').slice(0, 200);
      meta.updatedAt = Date.now();
      writeSnapshotMeta(profile, meta.id, meta);
      res.json({ success: true, snapshot: meta });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.delete('/v1/config-versions/:id', (req: any, res: any) => {
    try {
      const profile = loadProfilesState().active;
      const dir = path.join(profileDir(profile), req.params.id);
      if (!fs.existsSync(dir)) return res.status(404).json({ success: false, error: 'not found' });
      fs.rmSync(dir, { recursive: true, force: true });
      res.json({ success: true });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.get('/v1/config-versions/profiles', (_req: any, res: any) => {
    res.json({ success: true, ...loadProfilesState() });
  });

  app.post('/v1/config-versions/profiles/:name', (req: any, res: any) => {
    try {
      const name = safeProfileName(req.params.name);
      const state = loadProfilesState();
      if (state.profiles.includes(name)) return res.status(409).json({ success: false, error: 'already exists' });
      state.profiles.push(name);
      saveProfilesState(state);
      ensureDir(profileDir(name));
      // Seed the new profile with a snapshot of the current live config so
      // it has a baseline to compare against later.
      createSnapshot({ profile: name, trigger: 'manual', label: 'profile-init' });
      res.json({ success: true, ...loadProfilesState() });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/v1/config-versions/profiles/:name/switch', async (req: any, res: any) => {
    try {
      const name = safeProfileName(req.params.name);
      const state = loadProfilesState();
      if (!state.profiles.includes(name)) return res.status(404).json({ success: false, error: 'unknown profile' });
      if (state.active === name) return res.json({ success: true, ...state, note: 'already active' });
      // Snapshot the *current* profile if dirty so its working state is safe.
      if (isDirty(state.active)) {
        createSnapshot({ profile: state.active, trigger: 'pre-profile-switch' });
      }
      // Switch active and restore the latest snapshot of the target profile (if any).
      state.active = name;
      saveProfilesState(state);
      const ids = listSnapshotIds(name);
      if (ids.length) {
        await restoreSnapshot(name, ids[ids.length - 1]);
      }
      res.json({ success: true, ...state, note: 'profile switched — bridge restart may be needed for some changes' });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.delete('/v1/config-versions/profiles/:name', (req: any, res: any) => {
    try {
      const name = safeProfileName(req.params.name);
      const state = loadProfilesState();
      if (state.active === name) return res.status(409).json({ success: false, error: 'cannot delete active profile' });
      if (!state.profiles.includes(name)) return res.status(404).json({ success: false, error: 'unknown profile' });
      state.profiles = state.profiles.filter((p) => p !== name);
      saveProfilesState(state);
      try { fs.rmSync(profileDir(name), { recursive: true, force: true }); } catch {}
      res.json({ success: true, ...state });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });

  app.post('/v1/config-versions/test-defaults', async (_req: any, res: any) => {
    try {
      const profile = loadProfilesState().active;
      // Always snapshot current state first so it can be restored.
      if (isDirty(profile)) {
        createSnapshot({ profile, trigger: 'pre-defaults', label: 'before reset to defaults' });
      } else {
        // Even if not dirty vs last snapshot, we still want a clearly labeled
        // marker so the user can roll back from the list easily.
        createSnapshot({ profile, trigger: 'pre-defaults', label: 'before reset to defaults' });
      }
      await resetToDefaults();
      res.json({ success: true, note: 'configs reset to defaults — bridge restart recommended' });
    } catch (e: any) {
      res.status(500).json({ success: false, error: e.message });
    }
  });
}

module.exports = { registerConfigVersionRoutes };
