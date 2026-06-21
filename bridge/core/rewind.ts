// Rewind storage primitives — append-only edit log + content-addressed blob
// store under `bridge/rewind/`. Phase A of the grill-plan rewind feature
// (docs/grill-session-plan.md §4.2): pure observation, no UI consumer yet.
//
// On-disk layout
//   bridge/rewind/<wd-hash>.jsonl          — one record per edit
//   bridge/rewind/blobs/<sha256>           — content-addressed file blob
//   bridge/rewind/baselines/<module>.json  — last-known hashes per module
//
// Record shape (one JSON object per line):
//   { id, ts, wd, agent_turn_id, trigger, module, parent_id,
//     modules_touched, migration_script_ref?,
//     files: [{ path, op, before_hash, after_hash, diff_ref? }] }
//
// In Phase A `agent_turn_id` is always null and `diff_ref` is omitted —
// the dispatch path that knows the turn id lands in Phase B step 5
// (`/rewind` slash command), and diffs are computed on demand from the
// before/after blobs at restore time.
//
// Why persistent baselines: `bun --watch` restarts the bridge whenever a
// source file changes — exactly the moment an edit happens. Without
// persistence we'd lose the pre-edit hashes and the next observation
// would silently re-seed against the post-edit disk. Baselines on disk
// let a fresh process diff against the previous run's state and record
// the edit as a `boot`-triggered record.
//
// The writer is intentionally synchronous: a reload is already on the
// critical path, edits are bounded by what actually changed, and the
// fsync per record is the durability contract the standalone service
// (step 3) will rely on. Survives crashes mid-edit because JSONL is
// append-only and the CAS blob lands before its record references it.
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// __dirname is `bridge/core/`; one `..` lands us in `bridge/`.
// (Earlier two-`..` version landed at the repo root and silently wrote
// `<repo>/rewind/blobs/` for an entire dev session — caught only by a
// `git status` after the fact. Tests can't catch this because they pass
// a tmp dir directly; the constant is only used by the loader hook.)
const BRIDGE_DIR = path.resolve(__dirname, '..');
const REWIND_DIR = path.join(BRIDGE_DIR, 'rewind');
const BLOBS_DIR = path.join(REWIND_DIR, 'blobs');
const BASELINES_DIR = path.join(REWIND_DIR, 'baselines');

// Per-module last-known content hashes — keyed by module name, value is
// relative-path → sha256. Seeded on first observation (no record written
// for the seed); subsequent observations diff against it.
const lastHashesByModule = new Map<string, Map<string, string>>();

// Per-WD last record id (for the `parent_id` back-link). Reset on bridge
// boot — the standalone rewind service will re-derive it from disk by
// reading the last line of the JSONL on demand.
const lastRecordIdByWd = new Map<string, string>();

// Current agent-turn id. The schema field exists so a future cross-process
// flow (Go streaming loop mints an id per chat turn → posts it down to
// every /proxy/tool call → bridge calls setCurrentAgentTurnId before the
// edit lands) can populate it with true per-turn granularity. Today we
// seed it once per bridge process so every record between two bridge
// restarts shares an id — the rewind UI can use that for "edits from
// this work session" grouping even before the Go-side plumbing arrives.
let currentAgentTurnId: string = crypto.randomUUID();
function setCurrentAgentTurnId(id: string | null): void {
  currentAgentTurnId = id && typeof id === 'string' ? id : crypto.randomUUID();
}
function getCurrentAgentTurnId(): string {
  return currentAgentTurnId;
}

// Files/dirs we never snapshot. Mirrors the .gitignore-ish list the plan
// calls for: build output, deps, logs, hidden dirs.
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  '.cache',
  '.next',
  '__pycache__',
]);
// Extensions we never snapshot. Two reasons a file ends up here:
//   1. Runtime data, not source — sqlite DBs and their WAL/SHM/journal
//      sidecars churn every commit and are not what "rewind" is for.
//   2. Build artifacts / generated bundles — rebuildable, large, churny.
// The 2.4 GB sqlite under context-generator/context-rag/data/ taught us
// what happens without this list: 19 GB of CAS in a single day.
const SKIP_EXTS = new Set([
  '.log',
  '.db', '.db-wal', '.db-shm', '.db-journal',
  '.sqlite', '.sqlite-wal', '.sqlite-shm', '.sqlite-journal',
  '.tmp', '.lock', '.pid',
  '.map', '.pyc', '.o', '.so', '.wasm', '.zip',
]);

// Per-file size cap. Files larger than this are skipped entirely (no hash,
// no CAS, no record). Defaults to 50 MiB which comfortably covers source
// files and small assets while keeping a 2.4 GB sqlite out of memory.
// Set YHA_REWIND_MAX_FILE_MB=0 to disable the cap (not recommended on a Pi).
const MAX_FILE_MB = (() => {
  const raw = process.env.YHA_REWIND_MAX_FILE_MB;
  if (raw === undefined || raw === '') return 50;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 50;
  return n;
})();
const MAX_FILE_BYTES = MAX_FILE_MB > 0 ? MAX_FILE_MB * 1024 * 1024 : Infinity;

// Warn once per oversized path per process — saves the log from spamming
// the same 2 GB file every reload.
const warnedOversize = new Set<string>();

// In-flight tool-call counter. `/rewind` waits for this to reach zero
// before reading + restoring so we never snap files mid-write while a
// model tool call is still streaming output to disk. The mcp-client
// module increments on /proxy/tool entry and decrements on exit.
let inFlightTools = 0;
function markToolStart(): void { inFlightTools++; }
function markToolEnd(): void { if (inFlightTools > 0) inFlightTools--; }
function getInFlightToolCount(): number { return inFlightTools; }

/**
 * Block (with a max wait) until no tool calls are in flight. Resolves true
 * on quiet, false on timeout (caller can still proceed — quiescence is
 * best-effort: a runaway never-returning tool would otherwise pin /rewind
 * forever).
 */
async function waitForQuiescence(maxMs = 2000): Promise<boolean> {
  const deadline = Date.now() + Math.max(0, maxMs);
  while (inFlightTools > 0) {
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
  return true;
}

interface FileEntry {
  path: string;
  op: 'create' | 'modify' | 'delete';
  before_hash: string | null;
  after_hash: string | null;
}

interface RewindRecord {
  id: string;
  ts: number;
  wd: string;
  agent_turn_id: string | null;
  trigger: 'reload' | 'enable' | 'boot';
  module: string;
  modules_touched: string[];
  parent_id: string | null;
  files: FileEntry[];
}

function ensureDirs(): void {
  if (!fs.existsSync(BLOBS_DIR)) fs.mkdirSync(BLOBS_DIR, { recursive: true });
  if (!fs.existsSync(BASELINES_DIR)) fs.mkdirSync(BASELINES_DIR, { recursive: true });
}

function baselineFileFor(moduleName: string): string {
  // Module names are bridge-internal identifiers (e.g. "knowledge-mcp",
  // "mcp-layer"); they're safe path segments by construction. Sanitize
  // anyway so a malformed manifest can't escape the baselines dir.
  const safe = moduleName.replace(/[^A-Za-z0-9_.-]/g, '_');
  return path.join(BASELINES_DIR, `${safe}.json`);
}

function loadBaselineFromDisk(moduleName: string): Map<string, string> | null {
  const file = baselineFileFor(moduleName);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const obj = JSON.parse(raw) as { files?: Record<string, string> };
    const out = new Map<string, string>();
    if (obj.files) {
      for (const [rel, hash] of Object.entries(obj.files)) {
        if (typeof hash === 'string') out.set(rel, hash);
      }
    }
    return out;
  } catch (e) {
    console.warn(`[rewind] loadBaselineFromDisk(${moduleName}): ${(e as Error).message}`);
    return null;
  }
}

function saveBaselineToDisk(moduleName: string, hashes: Map<string, string>): void {
  try {
    ensureDirs();
    const file = baselineFileFor(moduleName);
    const obj: { files: Record<string, string>; ts: number } = { files: {}, ts: Date.now() };
    for (const [rel, hash] of hashes) obj.files[rel] = hash;
    const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(obj));
    fs.renameSync(tmp, file);
  } catch (e) {
    console.warn(`[rewind] saveBaselineToDisk(${moduleName}): ${(e as Error).message}`);
  }
}

/**
 * Read the last record id from the per-WD JSONL. Used to rehydrate the
 * parent_id chain after a bridge restart. Returns null if the file is
 * missing or empty.
 */
function tailLastRecordId(wd: string): string | null {
  const file = logFileFor(wd);
  if (!fs.existsSync(file)) return null;
  try {
    // Per-WD JSONL files stay small for hand-edited projects (tens of KB
    // typical, growing slowly). Reading the whole file once at boot is
    // simpler than a windowed tail and the cost is negligible. If a
    // pathological WD ever produces a multi-MB log we can revisit.
    const raw = fs.readFileSync(file, 'utf8');
    let i = raw.length - 1;
    if (i < 0) return null;
    // Skip trailing newline(s)
    while (i >= 0 && (raw[i] === '\n' || raw[i] === '\r')) i--;
    if (i < 0) return null;
    let j = i;
    while (j >= 0 && raw[j] !== '\n') j--;
    const line = raw.slice(j + 1, i + 1);
    const obj = JSON.parse(line) as { id?: string };
    return typeof obj.id === 'string' ? obj.id : null;
  } catch (e) {
    console.warn(`[rewind] tailLastRecordId: ${(e as Error).message}`);
    return null;
  }
}

function wdHash(wd: string): string {
  return crypto.createHash('sha256').update(wd).digest('hex').slice(0, 16);
}

function logFileFor(wd: string): string {
  return path.join(REWIND_DIR, `${wdHash(wd)}.jsonl`);
}

function sha256Hex(buf: Buffer): string {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function shouldSkip(name: string): boolean {
  if (name.startsWith('.') && name !== '.') return true;
  if (SKIP_DIRS.has(name)) return true;
  return false;
}

/**
 * Walk a module tree, returning a relative-path → sha256 map. Reads file
 * contents to compute hashes; for the per-reload diff path we also stash
 * the buffer in `bufs` so the caller can CAS-store new content without a
 * second read.
 */
function snapshotTree(
  root: string,
  bufs?: Map<string, Buffer>,
): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(root)) return out;

  const stack: Array<{ abs: string; rel: string }> = [{ abs: root, rel: '' }];
  while (stack.length) {
    const { abs, rel } = stack.pop()!;
    let entries: any[];
    try {
      entries = fs.readdirSync(abs, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (shouldSkip(ent.name)) continue;
      const childAbs = path.join(abs, ent.name);
      const childRel = rel ? `${rel}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        stack.push({ abs: childAbs, rel: childRel });
      } else if (ent.isFile()) {
        const ext = path.extname(ent.name);
        if (SKIP_EXTS.has(ext)) continue;
        // Size cap: stat first so we never `readFileSync` a multi-GB
        // sqlite into V8 heap. Cap is 50 MiB by default (see MAX_FILE_BYTES
        // above) which covers all source files but excludes generated DBs.
        try {
          const st = fs.statSync(childAbs);
          if (st.size > MAX_FILE_BYTES) {
            if (!warnedOversize.has(childAbs)) {
              warnedOversize.add(childAbs);
              const mb = (st.size / (1024 * 1024)).toFixed(1);
              console.warn(
                `[rewind] skipping oversize file ${childRel} (${mb} MB > ${MAX_FILE_MB} MB cap; ` +
                `set YHA_REWIND_MAX_FILE_MB=0 to disable cap or raise it)`,
              );
            }
            continue;
          }
        } catch {
          continue;
        }
        let buf: Buffer;
        try {
          buf = fs.readFileSync(childAbs);
        } catch {
          continue;
        }
        const hash = sha256Hex(buf);
        out.set(childRel, hash);
        if (bufs) bufs.set(childRel, buf);
      }
    }
  }
  return out;
}

/**
 * Write a content blob to CAS. No-op if the blob already exists.
 * Atomic via tmp-then-rename so a crash mid-write can't leave a partial
 * blob that a later record references.
 */
function writeBlob(hash: string, buf: Buffer): void {
  const dst = path.join(BLOBS_DIR, hash);
  if (fs.existsSync(dst)) return;
  const tmp = `${dst}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dst);
}

function appendRecord(wd: string, record: RewindRecord): void {
  const file = logFileFor(wd);
  const line = JSON.stringify(record) + '\n';
  // Open with O_APPEND so concurrent writers from parallel chats interleave
  // safely at line granularity (POSIX guarantees atomic appends up to
  // PIPE_BUF, well above one record's size for our purposes).
  const fd = fs.openSync(file, 'a');
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Observe a module activation. First call for a given module seeds the
 * in-memory baseline and writes nothing. Subsequent calls diff against
 * the baseline; if anything changed, blobs are written to CAS and a
 * record is appended to the per-WD JSONL.
 *
 * Returns the record id on success, null if nothing changed (or this
 * was the baseline seed).
 */
function observeActivation(
  moduleName: string,
  moduleDir: string,
  opts: { wd: string; trigger: 'reload' | 'enable' | 'boot'; agentTurnId?: string | null },
): string | null {
  try {
    ensureDirs();
  } catch (e) {
    // Don't block the loader on a rewind-store failure. Future: surface
    // via observability so the user knows the safety net is degraded.
    console.warn('[rewind] ensureDirs failed:', (e as Error).message);
    return null;
  }

  let prev = lastHashesByModule.get(moduleName);
  if (!prev) {
    // No in-memory baseline. Try disk before falling back to a fresh
    // silent seed — this is what lets the next observation after a
    // bridge restart still produce a diff record.
    const fromDisk = loadBaselineFromDisk(moduleName);
    if (fromDisk) {
      lastHashesByModule.set(moduleName, fromDisk);
      prev = fromDisk;
    } else {
      // True cold start — seed silently. The on-disk log only records
      // actual diffs; the initial state is implicit (it's whatever was
      // on disk at first observation).
      const bufs = new Map<string, Buffer>();
      const seed = snapshotTree(moduleDir, bufs);
      // Strict deletion-safety: CAS every file we just hashed so a
      // future deletion of a never-modified file can still restore.
      for (const [rel, hash] of seed) {
        const buf = bufs.get(rel);
        if (buf) { try { writeBlob(hash, buf); } catch { /* swallow */ } }
      }
      lastHashesByModule.set(moduleName, seed);
      saveBaselineToDisk(moduleName, seed);
      return null;
    }
  }

  const bufs = new Map<string, Buffer>();
  const current = snapshotTree(moduleDir, bufs);

  const files: FileEntry[] = [];
  // Modified / created
  for (const [rel, hash] of current) {
    const before = prev.get(rel);
    if (before === hash) continue;
    files.push({
      path: rel,
      op: before === undefined ? 'create' : 'modify',
      before_hash: before ?? null,
      after_hash: hash,
    });
  }
  // Deleted — the before_hash blob was CAS'd on a previous observation
  // (cold seed or modify), so a restore can re-create the file. Files
  // whose extension is now in SKIP_EXTS get filtered out: a path that
  // used to be tracked but moved to the ignore list (e.g. when we added
  // .db / .db-wal / .sqlite after the 19 GB sqlite incident) is not a
  // user-visible deletion and shouldn't appear as a "delete" op that
  // pins the old blob in CAS forever.
  for (const [rel, hash] of prev) {
    if (current.has(rel)) continue;
    if (SKIP_EXTS.has(path.extname(rel))) continue;
    files.push({ path: rel, op: 'delete', before_hash: hash, after_hash: null });
  }

  // Update the in-memory baseline whether or not we wrote a record.
  // Empty-diff updates are still a no-op but cost nothing.
  lastHashesByModule.set(moduleName, current);

  if (files.length === 0) {
    // Disk matched the persisted baseline exactly — keep the on-disk
    // baseline as-is (no rewrite needed).
    return null;
  }

  // Write all new blobs to CAS before the record references them.
  for (const f of files) {
    if (f.after_hash) {
      const buf = bufs.get(f.path);
      if (buf) writeBlob(f.after_hash, buf);
    }
  }

  const id = crypto.randomUUID();
  // Lazy-rehydrate the parent chain on first record per WD after restart.
  let parent_id: string | null;
  const mem = lastRecordIdByWd.get(opts.wd);
  if (mem !== undefined) parent_id = mem;
  else parent_id = tailLastRecordId(opts.wd);

  const record: RewindRecord = {
    id,
    ts: Date.now(),
    wd: opts.wd,
    agent_turn_id: opts.agentTurnId ?? currentAgentTurnId,
    trigger: opts.trigger,
    module: moduleName,
    modules_touched: [moduleName],
    parent_id,
    files,
  };

  try {
    appendRecord(opts.wd, record);
  } catch (e) {
    console.warn('[rewind] appendRecord failed:', (e as Error).message);
    return null;
  }
  lastRecordIdByWd.set(opts.wd, id);
  // Persist the new baseline so a crash before the next observation
  // doesn't re-record the same edit.
  saveBaselineToDisk(moduleName, current);
  return id;
}

/**
 * Boot-time entry point. Two paths:
 *
 * - Cold boot (no persisted baseline): scan disk, write each file's
 *   content to CAS (so the very first edit to a never-before-modified
 *   file — especially a *deletion* — can be undone), persist the
 *   baseline. Returns null.
 *
 * - Warm boot (persisted baseline exists): load the persisted hashes,
 *   diff against current disk, write a `boot`-triggered record if
 *   anything changed. This is what catches edits that happened while
 *   the bridge was down — including the very edit that triggered the
 *   `bun --watch` restart. Returns the record id when a diff was
 *   recorded, null when disk matched.
 *
 * Errors are swallowed and warned — a degraded safety net must never
 * block a working module load.
 */
function seedBaselineWithBlobs(
  moduleName: string,
  moduleDir: string,
  opts?: { wd?: string; agentTurnId?: string | null },
): string | null {
  try {
    ensureDirs();
  } catch (e) {
    console.warn('[rewind] ensureDirs failed:', (e as Error).message);
    return null;
  }

  const fromDisk = loadBaselineFromDisk(moduleName);
  if (fromDisk && opts && opts.wd) {
    // Warm boot: seed in-memory from disk, then diff via observe.
    lastHashesByModule.set(moduleName, fromDisk);
    return observeActivation(moduleName, moduleDir, {
      wd: opts.wd,
      trigger: 'boot',
      agentTurnId: opts.agentTurnId ?? null,
    });
  }

  // Cold boot (or callers that didn't pass a wd — defensive). Scan disk,
  // CAS every file, persist.
  const bufs = new Map<string, Buffer>();
  const seed = snapshotTree(moduleDir, bufs);
  for (const [rel, hash] of seed) {
    const buf = bufs.get(rel);
    if (buf) {
      try { writeBlob(hash, buf); }
      catch (e) { console.warn(`[rewind] writeBlob ${rel}: ${(e as Error).message}`); }
    }
  }
  lastHashesByModule.set(moduleName, seed);
  saveBaselineToDisk(moduleName, seed);
  return null;
}

// ── Read + restore primitives (consumed by chat-side `/rewind`) ──────────────
// The Go service in cmd/yha-rewind/main.go has parallel implementations of
// these — that copy is for the offline-recovery scenario (bridge down).
// While the bridge is up, the chat command path uses these in-process
// helpers: no extra HTTP hop, no async refactor of handleSpecial.

function readAllRecords(wd: string): RewindRecord[] {
  const file = logFileFor(wd);
  if (!fs.existsSync(file)) return [];
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    console.warn(`[rewind] readAllRecords: ${(e as Error).message}`);
    return [];
  }
  const out: RewindRecord[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // tolerate a partial trailing line from a crash mid-append.
    }
  }
  return out;
}

function listRecentRecords(wd: string, n: number): RewindRecord[] {
  if (!Number.isFinite(n) || n <= 0) return [];
  const all = readAllRecords(wd);
  all.sort((a, b) => b.ts - a.ts);
  return all.slice(0, n);
}

function readRecordById(wd: string, id: string): RewindRecord | null {
  for (const r of readAllRecords(wd)) {
    if (r.id === id) return r;
  }
  return null;
}

interface RestoreResult {
  written: string[];
  deleted: string[];
  errors: string[];
}

function readBlob(hash: string): Buffer | null {
  const p = path.join(BLOBS_DIR, hash);
  try {
    return fs.readFileSync(p);
  } catch {
    return null;
  }
}

/**
 * Reverse a single edit record. Path resolution: <wd>/modules/<module>/<file.path>.
 * `record.wd` is the bridge process's cwd (so already the bridge dir on
 * the running system); modules live directly under it as `modules/<name>/`.
 * Hard prefix-check refuses traversal (`../../etc/foo`).
 *
 * Restore semantics (mirrors plan §4.2 and yha-rewind):
 *   modify → write before_hash blob back to disk.
 *   create → delete the file (it didn't exist before the edit).
 *   delete → re-create the file from before_hash blob.
 */
function restoreRecord(record: RewindRecord): RestoreResult {
  const out: RestoreResult = { written: [], deleted: [], errors: [] };
  const moduleDir = path.resolve(record.wd, 'modules', record.module);
  const moduleDirWithSep = moduleDir + path.sep;
  for (const f of record.files) {
    const target = path.resolve(moduleDir, f.path);
    if (target !== moduleDir && !target.startsWith(moduleDirWithSep)) {
      out.errors.push(`${f.path}: path escapes module dir`);
      continue;
    }
    try {
      if (f.op === 'create') {
        if (fs.existsSync(target)) fs.unlinkSync(target);
        out.deleted.push(f.path);
      } else if (f.op === 'modify' || f.op === 'delete') {
        if (!f.before_hash) {
          out.errors.push(`${f.path}: missing before_hash`);
          continue;
        }
        const buf = readBlob(f.before_hash);
        if (!buf) {
          out.errors.push(`${f.path}: blob ${f.before_hash.slice(0, 8)} missing from CAS`);
          continue;
        }
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, buf);
        out.written.push(f.path);
      } else {
        out.errors.push(`${f.path}: unknown op ${f.op}`);
      }
    } catch (e) {
      out.errors.push(`${f.path}: ${(e as Error).message}`);
    }
  }
  return out;
}

/** Best-effort working dir for the running bridge. Matches the value the
 *  loader hook passes into observeActivation/seedBaselineWithBlobs, so
 *  reads see the same JSONL the writes append to. */
function defaultWd(): string {
  return process.cwd();
}

// Test-only reset; not part of the public API contract.
function _resetForTests(): void {
  lastHashesByModule.clear();
  lastRecordIdByWd.clear();
}

module.exports = {
  observeActivation,
  seedBaselineWithBlobs,
  readAllRecords,
  listRecentRecords,
  readRecordById,
  restoreRecord,
  defaultWd,
  setCurrentAgentTurnId,
  getCurrentAgentTurnId,
  markToolStart,
  markToolEnd,
  getInFlightToolCount,
  waitForQuiescence,
  REWIND_DIR,
  BLOBS_DIR,
  _resetForTests,
};
