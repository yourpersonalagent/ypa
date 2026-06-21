// ── Inbound API keys — keys YHA issues so external clients (Hermes, etc.)
//    can authenticate to a future OpenAI-compatible /v1/chat/completions proxy.
//    Stored as sha256 hashes; plaintext is shown to the user exactly once.
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeJsonSync } = require('../core/state');

// Per-user (Q16) — routed via bridge/core/paths.ts.
const _paths = require('../core/paths');
const KEYS_FILE = _paths.apiKeys;
const PREFS_FILE = _paths.openaiProxyPrefs;

// Subscription proxy modes — see _proxyClaudeBinary in server-openai-internal.ts.
//   sdk    — full YHA setup (MCP servers, claude_code preset, skills, plugins)
//   binary — bare Claude binary spawn, no MCP / no skills (legacy fallback)
type ProxyMode = 'sdk' | 'binary';
interface ProxyPrefs {
  subscriptionMode: ProxyMode;
}
const DEFAULT_PREFS: ProxyPrefs = { subscriptionMode: 'sdk' };
let _prefs: ProxyPrefs | null = null;

function _loadPrefs(): ProxyPrefs {
  if (_prefs) return _prefs;
  try {
    if (fs.existsSync(PREFS_FILE)) {
      const raw = JSON.parse(fs.readFileSync(PREFS_FILE, 'utf8')) || {};
      _prefs = { ...DEFAULT_PREFS, ...raw };
      return _prefs!;
    }
  } catch { /* fall through */ }
  _prefs = { ...DEFAULT_PREFS };
  return _prefs!;
}

function _savePrefs(): void {
  try {
    writeJsonSync(PREFS_FILE, _prefs);
  } catch { /* swallow */ }
}

function getProxyPrefs(): ProxyPrefs {
  return _loadPrefs();
}

interface KeyUsageEntry {
  promptTokens: number;
  completionTokens: number;
  cost: number;
  calls: number;
}

interface KeyRecord {
  id: string;
  label: string;
  hash: string;
  hint: string;            // e.g. "yha_abcd…wxyz" (safe to display)
  createdAt: string;
  lastUsedAt: string | null;
  usage: { byModel: Record<string, KeyUsageEntry> };
}

let _keys: KeyRecord[] = [];
let _loaded = false;

function _load(): void {
  if (_loaded) return;
  _loaded = true;
  try {
    if (fs.existsSync(KEYS_FILE)) {
      _keys = JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8')) || [];
    }
  } catch {
    _keys = [];
  }
}

function _save(): void {
  try {
    writeJsonSync(KEYS_FILE, _keys);
  } catch {
    /* swallow — non-fatal */
  }
}

function _publicView(k: KeyRecord) {
  // Strip the hash before sending to the client
  const totals = Object.values(k.usage.byModel).reduce(
    (acc, e) => {
      acc.promptTokens += e.promptTokens;
      acc.completionTokens += e.completionTokens;
      acc.cost += e.cost;
      acc.calls += e.calls;
      return acc;
    },
    { promptTokens: 0, completionTokens: 0, cost: 0, calls: 0 }
  );
  return {
    id: k.id,
    label: k.label,
    hint: k.hint,
    createdAt: k.createdAt,
    lastUsedAt: k.lastUsedAt,
    usage: k.usage,
    totals,
  };
}

function _generateToken(): { token: string; hash: string; hint: string } {
  const raw = crypto.randomBytes(32).toString('base64url');
  const token = `yha_${raw}`;
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  const hint = `${token.slice(0, 8)}…${token.slice(-4)}`;
  return { token, hash, hint };
}

// ── Public API ────────────────────────────────────────────────────────────────

function verifyApiKey(token: string): KeyRecord | null {
  if (!token || typeof token !== 'string') return null;
  _load();
  const hash = crypto.createHash('sha256').update(token).digest('hex');
  return _keys.find((k) => k.hash === hash) || null;
}

function recordKeyUsage(
  keyId: string,
  model: string,
  promptTokens: number,
  completionTokens: number,
  cost: number
): void {
  _load();
  const k = _keys.find((x) => x.id === keyId);
  if (!k) return;
  const m = (k.usage.byModel[model] ||= {
    promptTokens: 0,
    completionTokens: 0,
    cost: 0,
    calls: 0,
  });
  m.promptTokens += promptTokens || 0;
  m.completionTokens += completionTokens || 0;
  m.cost += cost || 0;
  m.calls += 1;
  k.lastUsedAt = new Date().toISOString();
  _save();
}

function registerApiKeyRoutes(app) {
  // List — never returns the plaintext token
  app.get('/v1/api-keys', (_req, res) => {
    _load();
    res.json({ keys: _keys.map(_publicView) });
  });

  // Generate — returns plaintext token ONCE; never retrievable again
  app.post('/v1/api-keys', (req, res) => {
    _load();
    const label = String((req.body && req.body.label) || '').trim() || 'Unnamed key';
    const { token, hash, hint } = _generateToken();
    const rec: KeyRecord = {
      id: crypto.randomUUID(),
      label,
      hash,
      hint,
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      usage: { byModel: {} },
    };
    _keys.push(rec);
    _save();
    res.json({ key: { ..._publicView(rec), token } });
  });

  // Revoke
  app.delete('/v1/api-keys/:id', (req, res) => {
    _load();
    const before = _keys.length;
    _keys = _keys.filter((k) => k.id !== req.params.id);
    if (_keys.length === before) return res.status(404).json({ error: 'Not found' });
    _save();
    res.json({ success: true });
  });

  // Reset usage counters (keeps the key)
  app.post('/v1/api-keys/:id/reset-usage', (req, res) => {
    _load();
    const k = _keys.find((x) => x.id === req.params.id);
    if (!k) return res.status(404).json({ error: 'Not found' });
    k.usage = { byModel: {} };
    _save();
    res.json({ success: true });
  });

  // Proxy preferences (Subscription Claude routing mode)
  app.get('/v1/api-keys/proxy-prefs', (_req, res) => {
    res.json(_loadPrefs());
  });
  app.patch('/v1/api-keys/proxy-prefs', (req, res) => {
    const cur = _loadPrefs();
    const mode = req.body?.subscriptionMode;
    if (mode !== 'sdk' && mode !== 'binary') {
      return res.status(400).json({ error: 'subscriptionMode must be "sdk" or "binary"' });
    }
    _prefs = { ...cur, subscriptionMode: mode };
    _savePrefs();
    res.json(_prefs);
  });
}

module.exports = { registerApiKeyRoutes, verifyApiKey, recordKeyUsage, getProxyPrefs };
