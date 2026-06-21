// ── context-rag registry store ────────────────────────────────────────────────
// Persists the VectorDB list to `bridge/modules/context-generator/context-rag/
// dbs.json`. The file is the source of truth; in-memory state is just a cached
// parse to avoid hitting disk on every list/get. Mutations re-serialize and
// atomic-rename — same pattern as the sorter's `_writeFileAtomic`.
//
// Validation rules enforced here (not at the type layer):
//   - id matches /^[a-z0-9][a-z0-9-]{0,62}$/ and is unique
//   - sources are coherent (mode==='cwd' requires `cwd`, etc.)
//   - sensitivity include/exclude are subsets of the known tiers
//
// embedProvider / embedModel / embedDim are write-once: callers building an
// `updateDb` patch must NOT change them. The DB file on disk carries the same
// fields in `rag_meta`; a mismatch is grounds for "re-ingest required."
'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

import {
  REGISTRY_VERSION,
  makeEmptyRegistry,
  makeDefaultSensitivity,
  makeDefaultStats,
} from './types';
import type {
  Registry,
  VectorDB,
  SensitivityTier,
  EmbedProvider,
} from './types';

const logger = require('../../../../core/logger');

const MODULE_ROOT = path.resolve(__dirname, '..');
const REGISTRY_PATH = path.join(MODULE_ROOT, 'dbs.json');
const DATA_DIR      = path.join(MODULE_ROOT, 'data');

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;
const VALID_TIERS: ReadonlySet<SensitivityTier> = new Set(['public', 'private', 'system']);
const VALID_PROVIDERS: ReadonlySet<EmbedProvider> = new Set(['nvidia', 'lmstudio']);

// Cached parse of dbs.json. `null` means "not loaded yet" — we lazy-load on
// the first accessor call so module construction has no I/O side-effects.
let _cache: Registry | null = null;

function _readFromDisk(): Registry {
  let raw: string;
  try {
    raw = fs.readFileSync(REGISTRY_PATH, 'utf8');
  } catch (e: any) {
    if (e && e.code === 'ENOENT') return makeEmptyRegistry();
    throw e;
  }
  let parsed: any;
  try { parsed = JSON.parse(raw); }
  catch (e: any) {
    logger.error('[context-rag/registry] dbs.json is not valid JSON; refusing to overwrite. Fix or delete it.', { err: String(e && e.message || e) });
    throw new Error('context-rag/registry: dbs.json corrupt — refusing to start');
  }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('context-rag/registry: dbs.json root is not an object');
  }
  // Only one version exists; future versions get a migration table here.
  if (parsed.version !== REGISTRY_VERSION) {
    throw new Error(`context-rag/registry: dbs.json version ${parsed.version} is not supported (expected ${REGISTRY_VERSION})`);
  }
  if (!Array.isArray(parsed.dbs)) {
    throw new Error('context-rag/registry: dbs.json `dbs` is not an array');
  }
  for (const db of parsed.dbs) _assertVectorDBShape(db);
  return parsed as Registry;
}

function _writeToDisk(reg: Registry): void {
  fs.mkdirSync(MODULE_ROOT, { recursive: true });
  const tmp = REGISTRY_PATH + '.tmp-' + crypto.randomBytes(4).toString('hex');
  const body = JSON.stringify(reg, null, 2) + '\n';
  fs.writeFileSync(tmp, body, 'utf8');
  fs.renameSync(tmp, REGISTRY_PATH);
}

function _ensureLoaded(): Registry {
  if (_cache === null) _cache = _readFromDisk();
  return _cache;
}

// ── Validation ───────────────────────────────────────────────────────────────

function _assertVectorDBShape(db: any): asserts db is VectorDB {
  if (!db || typeof db !== 'object') throw new Error('VectorDB is not an object');
  if (typeof db.id !== 'string' || !ID_PATTERN.test(db.id)) {
    throw new Error(`VectorDB.id "${db.id}" is not a valid kebab-case id`);
  }
  if (typeof db.displayName !== 'string' || db.displayName.length === 0) {
    throw new Error(`VectorDB[${db.id}].displayName must be a non-empty string`);
  }
  if (!VALID_PROVIDERS.has(db.embedProvider)) {
    throw new Error(`VectorDB[${db.id}].embedProvider "${db.embedProvider}" not in {nvidia,lmstudio}`);
  }
  if (typeof db.embedModel !== 'string' || db.embedModel.length === 0) {
    throw new Error(`VectorDB[${db.id}].embedModel must be a non-empty string`);
  }
  if (!Number.isInteger(db.embedDim) || db.embedDim <= 0 || db.embedDim > 8192) {
    throw new Error(`VectorDB[${db.id}].embedDim ${db.embedDim} out of range (1..8192)`);
  }
  _assertSourceShape(db.id, db.source);
  _assertSensitivityShape(db.id, db.sensitivity);
  if (!Number.isFinite(db.createdAt)) {
    throw new Error(`VectorDB[${db.id}].createdAt must be a number`);
  }
  if (!db.stats || typeof db.stats !== 'object') {
    throw new Error(`VectorDB[${db.id}].stats must be an object`);
  }
  // Migration links are optional, but if present must be strings matching
  // the id pattern so a malformed entry can't snowball into a dangling ref.
  for (const key of ['migratedFrom', 'migratedTo'] as const) {
    if (db[key] != null) {
      if (typeof db[key] !== 'string' || !ID_PATTERN.test(db[key])) {
        throw new Error(`VectorDB[${db.id}].${key} "${db[key]}" is not a valid kebab-case id`);
      }
    }
  }
}

function _assertSourceShape(id: string, source: any): void {
  if (!source || typeof source !== 'object') throw new Error(`VectorDB[${id}].source must be an object`);

  const s = source.sessions;
  if (!s || !['all', 'cwd', 'off'].includes(s.mode)) {
    throw new Error(`VectorDB[${id}].source.sessions.mode must be one of all|cwd|off`);
  }
  if (s.mode === 'cwd' && (typeof s.cwd !== 'string' || !s.cwd.startsWith('/'))) {
    throw new Error(`VectorDB[${id}].source.sessions.cwd must be an absolute path when mode==='cwd'`);
  }

  const f = source.files;
  if (!f || !['cwd', 'roots', 'off'].includes(f.mode)) {
    throw new Error(`VectorDB[${id}].source.files.mode must be one of cwd|roots|off`);
  }
  if (f.mode === 'cwd' && (typeof f.cwd !== 'string' || !f.cwd.startsWith('/'))) {
    throw new Error(`VectorDB[${id}].source.files.cwd must be an absolute path when mode==='cwd'`);
  }
  if (f.mode === 'roots') {
    if (!Array.isArray(f.roots) || f.roots.length === 0) {
      throw new Error(`VectorDB[${id}].source.files.roots must be a non-empty array when mode==='roots'`);
    }
    for (const r of f.roots) {
      if (typeof r !== 'string' || !r.startsWith('/')) {
        throw new Error(`VectorDB[${id}].source.files.roots[*] must be absolute paths`);
      }
    }
  }
  if (f.ignore != null && (!Array.isArray(f.ignore) || f.ignore.some((x: any) => typeof x !== 'string'))) {
    throw new Error(`VectorDB[${id}].source.files.ignore must be string[] when set`);
  }

  const k = source.knowledge;
  if (!k || !['all', 'off'].includes(k.mode)) {
    throw new Error(`VectorDB[${id}].source.knowledge.mode must be one of all|off`);
  }

  // synthesis is optional — DBs created before the field landed simply omit it.
  if (source.synthesis != null) {
    const syn = source.synthesis;
    if (typeof syn !== 'object' || !['all', 'cwd', 'off'].includes(syn.mode)) {
      throw new Error(`VectorDB[${id}].source.synthesis.mode must be one of all|cwd|off`);
    }
    if (syn.mode === 'cwd' && (typeof syn.cwd !== 'string' || !syn.cwd.startsWith('/'))) {
      throw new Error(`VectorDB[${id}].source.synthesis.cwd must be an absolute path when mode==='cwd'`);
    }
  }
}

function _assertSensitivityShape(id: string, sens: any): void {
  if (!sens || typeof sens !== 'object') throw new Error(`VectorDB[${id}].sensitivity must be an object`);
  for (const key of ['include', 'exclude'] as const) {
    const arr = sens[key];
    if (!Array.isArray(arr)) throw new Error(`VectorDB[${id}].sensitivity.${key} must be an array`);
    for (const t of arr) {
      if (!VALID_TIERS.has(t)) throw new Error(`VectorDB[${id}].sensitivity.${key} has invalid tier "${t}"`);
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

function listDbs(): VectorDB[] {
  return _ensureLoaded().dbs.slice();
}

function getDb(id: string): VectorDB | null {
  return _ensureLoaded().dbs.find((d) => d.id === id) || null;
}

/** Path the sqlite-vec file for `id` is/will be stored at. Callers can stat
 *  this to check existence without going through the vector-store layer. */
function getDbFilePath(id: string): string {
  if (!ID_PATTERN.test(id)) throw new Error(`invalid db id: ${id}`);
  return path.join(DATA_DIR, `${id}.db`);
}

/** Adds a new DB. Throws if the id collides or the shape is invalid. */
function addDb(input: Omit<VectorDB, 'createdAt' | 'stats'> & Partial<Pick<VectorDB, 'createdAt' | 'stats'>>): VectorDB {
  const reg = _ensureLoaded();
  if (reg.dbs.some((d) => d.id === input.id)) {
    throw new Error(`context-rag/registry: db id "${input.id}" already exists`);
  }
  const db: VectorDB = {
    ...input,
    sensitivity: input.sensitivity ?? makeDefaultSensitivity(),
    createdAt: input.createdAt ?? Date.now(),
    stats: input.stats ?? makeDefaultStats(),
  };
  _assertVectorDBShape(db);
  reg.dbs.push(db);
  _writeToDisk(reg);
  return db;
}

/** Patches a DB in place. The write-once fields (embedProvider/embedModel/
 *  embedDim/id/createdAt) are silently dropped from `patch` — callers
 *  shouldn't include them, but if they do we ignore rather than fail-loud,
 *  because the UI form sends the full object back. */
function updateDb(id: string, patch: Partial<VectorDB>): VectorDB {
  const reg = _ensureLoaded();
  const idx = reg.dbs.findIndex((d) => d.id === id);
  if (idx < 0) throw new Error(`context-rag/registry: db id "${id}" not found`);
  const current = reg.dbs[idx];
  const next: VectorDB = {
    ...current,
    ...patch,
    // write-once fields — restore from current regardless of patch
    id: current.id,
    embedProvider: current.embedProvider,
    embedModel: current.embedModel,
    embedDim: current.embedDim,
    createdAt: current.createdAt,
  };
  _assertVectorDBShape(next);
  reg.dbs[idx] = next;
  _writeToDisk(reg);
  return next;
}

/** Removes a DB entry. The on-disk `.db` file is NOT deleted here — the
 *  vector-store layer owns its lifecycle (a future "force delete" route
 *  unlinks both). */
function removeDb(id: string): boolean {
  const reg = _ensureLoaded();
  const idx = reg.dbs.findIndex((d) => d.id === id);
  if (idx < 0) return false;
  reg.dbs.splice(idx, 1);
  _writeToDisk(reg);
  return true;
}

/** Test-only: drop the in-memory cache so the next call re-reads disk. */
function _reset(): void {
  _cache = null;
}

export {
  REGISTRY_PATH,
  DATA_DIR,
  listDbs,
  getDb,
  getDbFilePath,
  addDb,
  updateDb,
  removeDb,
  _reset,
};
