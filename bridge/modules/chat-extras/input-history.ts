'use strict';

const fs = require('fs');
const path = require('path');
const { config } = require('../../core/state');
const PATHS = require('../../core/paths');
const resolver = require('../../users/resolver');

// Request-scoped per-user input history. Do not resolve this once at module
// load via PATHS.inputHistory: that pins the bridge to the first/default user
// (or to bridge/input-history.json) for every browser session. Instead each
// route derives the canonical user folder from the active request user and
// writes bridge/users/<email>/input-history.json. The legacy bridge-root file
// is never written; it is only a one-time read seed for users that do not yet
// have their own file.
const LEGACY_FILE = path.join(PATHS.bridgeRoot, 'input-history.json');
const DEFAULT_MAX = 100;
// Read through an accessor so a hot config-reload takes effect on the next
// write. Power users with deep workflows can lift the cap via
// `config.defaults.input_history_max_count`; default stays at 100 entries.
function _maxCount(): number {
  const v = Number(config.defaults?.input_history_max_count);
  return Number.isFinite(v) && v > 0 ? v : DEFAULT_MAX;
}

interface HistoryFile { history: string[] }

type HistoryTarget = {
  file: string;
  legacySeedFile?: string | null;
};

const LOCAL_DEV_EMAIL = 'local@localhost.test';

function validUserPathFor(email: string): string | null {
  try { return resolver.userPath('input-history', email); } catch { return null; }
}

function activeEmail(req): string {
  const raw = String(req?.session?.user?.email || req?.user?.email || '').trim();
  if (raw && raw !== 'net-peer' && raw !== 'net-peer@localhost') {
    const canonical = resolver.canonicalEmailFor(raw) || raw;
    if (validUserPathFor(canonical)) return canonical;
  }
  // Synthetic/non-browser callers (notably YHA Net peers) do not have their
  // own human user folder. If this node is configured for a single/default
  // user, keep their history reads/writes under that user's folder too. If no
  // auth/default user exists (local no-auth dev), use an explicit local user
  // folder rather than recreating bridge/input-history.json as a global file.
  try {
    const email = resolver.defaultUserEmail();
    if (validUserPathFor(email)) return email;
  } catch { /* ALLOWED_EMAILS unset */ }
  return LOCAL_DEV_EMAIL;
}

function targetForReq(req): HistoryTarget {
  const email = activeEmail(req);
  const file = validUserPathFor(email) || validUserPathFor(LOCAL_DEV_EMAIL);
  if (!file) throw new Error('input-history: could not resolve a user-scoped file');
  return { file, legacySeedFile: LEGACY_FILE };
}

// ── Read cache (mtime-keyed, per target file) ────────────────────────────────
// Avoid re-parsing the 38 KB file on every GET. Cache keyed on filename+mtime;
// write() refreshes the cache + mtime after the atomic rename so a read
// immediately after a write doesn't return a stale snapshot.
// TODO: the file is rewritten on every POST. Consider debounced flush (see
// observability-plus/costs.ts for the pattern) if write rate becomes hot.
const _cache: Map<string, { mtimeMs: number; value: string[] }> = new Map();

function readFile(file: string, warnPrefix = '[input-history]'): string[] {
  try {
    const st = fs.statSync(file);
    const cached = _cache.get(file);
    if (cached && cached.mtimeMs === st.mtimeMs) return cached.value;
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as HistoryFile;
    const value = Array.isArray(parsed?.history) ? parsed.history.filter((s) => typeof s === 'string') : [];
    _cache.set(file, { mtimeMs: st.mtimeMs, value });
    return value;
  } catch (e: any) {
    if (e?.code !== 'ENOENT') {
      console.warn(`${warnPrefix} read failed (${file}):`, e?.code || '', e?.message || String(e));
    }
    return [];
  }
}

function read(target: HistoryTarget): string[] {
  const current = readFile(target.file);
  if (fs.existsSync(target.file) || !target.legacySeedFile || target.legacySeedFile === target.file) return current;
  // Back-compat seed: if a user has no per-user file yet, show the old global
  // list once. The next POST/DELETE/merge writes only the per-user file.
  return readFile(target.legacySeedFile, '[input-history] legacy seed');
}

function write(target: HistoryTarget, history: string[]): void {
  fs.mkdirSync(path.dirname(target.file), { recursive: true });
  const tmp = target.file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ history }, null, 2));
  fs.renameSync(tmp, target.file);
  try {
    const st = fs.statSync(target.file);
    _cache.set(target.file, { mtimeMs: st.mtimeMs, value: history });
  } catch (_) {
    _cache.delete(target.file);
  }
}

function unshiftDedupe(history: string[], text: string): string[] {
  const filtered = history.filter((h) => h !== text);
  filtered.unshift(text);
  return filtered.slice(0, _maxCount());
}

function registerInputHistoryRoutes(app): void {
  app.get('/v1/input-history', (req, res) => {
    res.json({ history: read(targetForReq(req)) });
  });

  app.post('/v1/input-history', (req, res) => {
    const text = String((req.body?.text ?? '')).trim();
    if (!text) return res.status(400).json({ error: 'text required' });
    const target = targetForReq(req);
    const next = unshiftDedupe(read(target), text);
    write(target, next);
    res.json({ history: next });
  });

  app.delete('/v1/input-history', (req, res) => {
    write(targetForReq(req), []);
    res.json({ history: [] });
  });

  app.post('/v1/input-history/merge', (req, res) => {
    const incoming = Array.isArray(req.body?.history) ? req.body.history.filter((s: unknown) => typeof s === 'string') : [];
    const target = targetForReq(req);
    const current = read(target);
    const merged: string[] = [];
    const seen = new Set<string>();
    for (const h of [...incoming, ...current]) {
      if (!seen.has(h)) { seen.add(h); merged.push(h); }
      if (merged.length >= _maxCount()) break;
    }
    write(target, merged);
    res.json({ history: merged });
  });
}

module.exports = { registerInputHistoryRoutes };
