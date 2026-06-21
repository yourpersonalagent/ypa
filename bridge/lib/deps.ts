// ── External-dependency scanner ───────────────────────────────────────────────
// Single source of truth for "is this external dependency present on THIS box?".
// Reads the repo-root dependencies.json manifest and probes each entry live, so
// the Preferences -> Dependencies tab (GET /v1/system/deps) and MCP/core code
// share one detection path. MCPs/core call `assertDep(id)` to fail with an
// actionable message ("Docker is not available — ... See Preferences ->
// Dependencies.") instead of a raw spawn ENOENT.
//
// CommonJS on purpose: this module is `require`d both by the bridge route
// (routes/system.ts) and by the stdio MCP servers (bridge/mcp/*.js), all of
// which run under bun.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const os = require('node:os');
const { execFile } = require('node:child_process');

// This file sits at bridge/lib/deps.ts → bridge/ is one up, repo root two up.
const BRIDGE_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(BRIDGE_DIR, '..');
const MANIFEST_PATH = path.join(REPO_ROOT, 'dependencies.json');
const ENV_FILE = path.join(BRIDGE_DIR, '.env');
const CONFIG_FILE = path.join(BRIDGE_DIR, 'config.json');

const IS_WINDOWS = process.platform === 'win32';
// Executable extensions to try when a bare name (no extension) is looked up on
// Windows. '' is included so an already-suffixed name still matches.
const PATHEXT = (process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM')
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);

// ── small cached file loaders (re-read only when mtime changes) ───────────────

function readJsonCached(file, cache) {
  try {
    const stat = fs.statSync(file);
    if (cache.value && stat.mtimeMs === cache.mtime) return cache.value;
    cache.value = JSON.parse(fs.readFileSync(file, 'utf8'));
    cache.mtime = stat.mtimeMs;
  } catch {
    if (!cache.value) cache.value = {};
  }
  return cache.value;
}

const _manifestCache = { value: null, mtime: 0 };
function loadManifest() {
  const parsed = readJsonCached(MANIFEST_PATH, _manifestCache);
  return Array.isArray(parsed?.dependencies) ? parsed.dependencies : [];
}

const _configCache = { value: null, mtime: 0 };
function loadConfig() {
  return readJsonCached(CONFIG_FILE, _configCache);
}

// bun auto-loads bridge/.env into process.env, but the file is parsed directly
// too so a key present only on disk (not yet exported) is still detected.
const _envCache = { value: null, mtime: 0 };
function loadEnvFile() {
  try {
    const stat = fs.statSync(ENV_FILE);
    if (_envCache.value && stat.mtimeMs === _envCache.mtime) return _envCache.value;
    const out = {};
    for (const line of fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      out[m[1]] = v;
    }
    _envCache.value = out;
    _envCache.mtime = stat.mtimeMs;
  } catch {
    if (!_envCache.value) _envCache.value = {};
  }
  return _envCache.value;
}

function dottedGet(obj, dotted) {
  if (!obj || !dotted) return undefined;
  return String(dotted)
    .split('.')
    .reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

// ── detection primitives ──────────────────────────────────────────────────────

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

// Portable `which`: scan PATH (PATHEXT-aware on Windows). Returns the resolved
// absolute path, or null. No external dep, fully synchronous.
function resolveOnPath(name) {
  if (!name) return null;
  const hasExt = path.extname(name) !== '';
  const tryNames = IS_WINDOWS && !hasExt ? ['', ...PATHEXT].map((ext) => name + ext) : [name];
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    for (const cand of tryNames) {
      const full = path.join(dir, cand);
      if (isFile(full)) return full;
    }
  }
  return null;
}

function detectBinarySync(d) {
  // Explicit candidate locations are tried before the PATH search:
  //   envPath    — env var holding an absolute exe path (e.g. CLAUDE_BIN)
  //   configPath — dotted key into config.json holding an absolute exe path
  //   paths      — hardcoded absolute candidates (e.g. Program Files install)
  const candidates = [];
  if (d.envPath && process.env[d.envPath]) candidates.push(process.env[d.envPath]);
  if (d.configPath) {
    const v = dottedGet(loadConfig(), d.configPath);
    // Ignore the example-config placeholder ("/path/to/...").
    if (v && typeof v === 'string' && !/\/path\/to\//i.test(v)) candidates.push(v);
  }
  if (Array.isArray(d.paths)) candidates.push(...d.paths);

  for (const c of candidates) {
    if (!c) continue;
    if (isFile(c)) return { present: true, detail: c };
    // A bare command name (no separator) still gets a PATH lookup.
    if (!c.includes(path.sep) && !c.includes('/')) {
      const f = resolveOnPath(c);
      if (f) return { present: true, detail: f };
    }
  }

  const names = [d.name, ...(Array.isArray(d.altNames) ? d.altNames : [])].filter(Boolean);
  for (const n of names) {
    const found = resolveOnPath(n);
    if (found) return { present: true, detail: found };
  }
  return { present: false, detail: null };
}

function detectEnvSync(d) {
  const fileEnv = loadEnvFile();
  for (const name of d.names || []) {
    const live = process.env[name];
    const val = live != null && live !== '' ? live : fileEnv[name];
    if (val != null && String(val).trim() !== '') {
      // Report only the matched NAME — never the secret value.
      return { present: true, detail: name };
    }
  }
  return { present: false, detail: null };
}

function expandPath(p, envOverride) {
  let out = p;
  if (envOverride && process.env[envOverride]) out = process.env[envOverride];
  if (out.startsWith('~')) out = path.join(os.homedir(), out.slice(1));
  if (!path.isAbsolute(out)) out = path.join(REPO_ROOT, out);
  return path.normalize(out);
}

function detectPathSync(d) {
  const full = expandPath(d.path, d.envOverride);
  return { present: fs.existsSync(full), detail: full };
}

function detectPort(d) {
  return new Promise((resolve) => {
    const host = d.host || '127.0.0.1';
    const sock = new net.Socket();
    let settled = false;
    const finish = (present) => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve({ present, detail: `${host}:${d.port}` });
    };
    sock.setTimeout(700);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(d.port, host);
  });
}

function probeVersion(bin, args) {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 4000, windowsHide: true, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) {
        resolve(null);
        return;
      }
      const line = String(stdout || stderr || '')
        .split(/\r?\n/)[0]
        .trim();
      resolve(line ? line.slice(0, 80) : null);
    });
  });
}

// ── status assembly ───────────────────────────────────────────────────────────

// status ∈ 'present' | 'missing' | 'na' | 'unknown'
function platformApplies(dep) {
  return !Array.isArray(dep.platforms) || dep.platforms.includes(process.platform);
}

// Synchronous detect for the kinds that don't need I/O latency (binary/env/
// path). Port detection needs the network and is handled only in detectOne.
function detectSync(dep) {
  if (!platformApplies(dep)) return { status: 'na', detail: 'not applicable on ' + process.platform };
  const d = dep.detect || {};
  let r;
  switch (d.kind) {
    case 'binary':
      r = detectBinarySync(d);
      break;
    case 'env':
      r = detectEnvSync(d);
      break;
    case 'path':
      r = detectPathSync(d);
      break;
    default:
      return { status: 'unknown', detail: null };
  }
  return { status: r.present ? 'present' : 'missing', detail: r.detail };
}

function row(dep, status, detail, version) {
  return {
    id: dep.id,
    label: dep.label,
    category: dep.category || 'other',
    optional: dep.optional !== false,
    requiredBy: Array.isArray(dep.requiredBy) ? dep.requiredBy : [],
    installHint: dep.installHint || '',
    status,
    detail: detail || null,
    version: version || null,
  };
}

async function detectOne(dep) {
  if (!platformApplies(dep)) return row(dep, 'na', 'not applicable on ' + process.platform, null);
  const d = dep.detect || {};

  if (d.kind === 'port') {
    const r = await detectPort(d);
    return row(dep, r.present ? 'present' : 'missing', r.detail, null);
  }

  const s = detectSync(dep);
  let version = null;
  if (s.status === 'present' && d.kind === 'binary' && Array.isArray(d.versionArgs) && d.versionArgs.length) {
    version = await probeVersion(s.detail || d.name, d.versionArgs);
  }
  return row(dep, s.status, s.detail, version);
}

// ── public API ────────────────────────────────────────────────────────────────

let _scanCache = null; // { at:number, data:object }
const SCAN_TTL_MS = 30_000;

async function scan(opts) {
  const force = !!(opts && opts.force);
  if (!force && _scanCache && Date.now() - _scanCache.at < SCAN_TTL_MS) return _scanCache.data;

  const deps = loadManifest();
  const rows = await Promise.all(deps.map(detectOne));

  const summary = { total: rows.length, present: 0, missingRequired: 0, missingOptional: 0, na: 0, unknown: 0 };
  for (const r of rows) {
    if (r.status === 'present') summary.present++;
    else if (r.status === 'na') summary.na++;
    else if (r.status === 'unknown') summary.unknown++;
    else if (r.optional) summary.missingOptional++;
    else summary.missingRequired++;
  }

  const data = { generatedAt: new Date().toISOString(), platform: process.platform, summary, deps: rows };
  _scanCache = { at: Date.now(), data };
  return data;
}

function findDep(id) {
  return loadManifest().find((d) => d.id === id) || null;
}

// Best-effort synchronous presence check for binary/env/path deps. Unknown ids,
// n/a platforms, and async-only kinds (port) return true so callers never block
// on an indeterminate result.
function isPresentSync(id) {
  const dep = findDep(id);
  if (!dep) return true;
  return detectSync(dep).status !== 'missing';
}

// Throw an actionable Error when a required dep is missing. The thrown error
// carries code 'EDEPMISSING' so callers can distinguish a clean dependency gap
// from an unexpected failure. No-op for unknown ids / n/a platforms / async-only
// kinds (which detectSync can't resolve).
function assertDep(id) {
  const dep = findDep(id);
  if (!dep) return;
  if (detectSync(dep).status !== 'missing') return;
  const by = Array.isArray(dep.requiredBy) && dep.requiredBy.length ? ` — required by ${dep.requiredBy.join(', ')}` : '';
  const hint = dep.installHint ? ` ${dep.installHint}` : '';
  const err = new Error(`${dep.label} is not available${by}.${hint} (See Preferences -> Dependencies.)`);
  (err as any).code = 'EDEPMISSING';
  (err as any).depId = id;
  throw err;
}

module.exports = {
  loadManifest,
  findDep,
  scan,
  detectOne,
  isPresentSync,
  assertDep,
  MANIFEST_PATH,
};
