// ── LINK Sync Engine — Secrets & Adapter Loader ──────────────────────────────
// Auth material lives in `bridge/secrets/contextLink.json` (chmod 600), kept
// out of the standard `config.json` so that config-history backups and
// Settings-export flows never carry the API key.
'use strict';

const fs     = require('fs');
const crypto = require('crypto');
const logger = require('../../../core/logger');

const { SECRETS_DIR, SECRETS_FILE } = require('./sync-constants');

// ── Secrets ──────────────────────────────────────────────────────────────────

function _ensureSecretsDir(): void {
  try {
    fs.mkdirSync(SECRETS_DIR, { recursive: true, mode: 0o700 });
    // Belt-and-braces — re-chmod in case mkdirSync inherited a wider umask.
    try { fs.chmodSync(SECRETS_DIR, 0o700); } catch { /* non-fatal on Windows */ }
  } catch { /* non-fatal */ }
}

function _readSecret(key: string): string {
  try {
    const raw = fs.readFileSync(SECRETS_FILE, 'utf8');
    const obj = JSON.parse(raw);
    return typeof obj?.[key] === 'string' ? obj[key] : '';
  } catch { return ''; }
}

function writeLinkSecret(key: string, value: string): void {
  _ensureSecretsDir();
  let obj: Record<string, string> = {};
  try {
    obj = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
  } catch { /* fresh file */ }
  if (value) obj[key] = value;
  else delete obj[key];
  const tmp = SECRETS_FILE + '.tmp-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmp, SECRETS_FILE);
  try { fs.chmodSync(SECRETS_FILE, 0o600); } catch { /* non-fatal on Windows */ }
}

function maskedLinkSecret(key: string): string {
  const v = _readSecret(key);
  if (!v) return '';
  // Show only fingerprint — never the raw token. The 8-char hex prefix lets
  // ops correlate logs without exposing the secret.
  const hash = crypto.createHash('sha1').update(v).digest('hex').slice(0, 8);
  return `••••••••••••${hash}`;
}

// ── Adapter selection ────────────────────────────────────────────────────────

function _getAdapter(): null | { kind: string; list: Function; read: Function; write: Function; remove: Function; ping: Function } {
  const { config } = require('../../../core/state');
  const cfg = config.defaults?.contextLink || {};
  const kind = cfg.adapter || 'mock';
  if (cfg.enabled !== true) return null;
  if (kind === 'mock') {
    return require('./adapter-mock');
  }
  if (kind === 'obsidian-rest') {
    const apiKey = _readSecret('obsidianApiKey') || cfg.obsidianApiKey || '';
    if (!apiKey) {
      logger.warn('link.adapter.no-api-key', { kind });
      return null;
    }
    const { createObsidianRestAdapter } = require('./adapter-obsidian');
    return createObsidianRestAdapter({
      baseUrl:          cfg.obsidianHost || 'http://127.0.0.1:27123',
      apiKey,
      vaultRoot:        cfg.vaultRoot || '',
      acceptSelfSigned: cfg.acceptSelfSigned === true,
      timeoutMs:        cfg.timeoutMs ?? 10_000,
    });
  }
  logger.warn('link.adapter.unknown-kind', { kind });
  return null;
}

module.exports = {
  _readSecret,
  writeLinkSecret,
  maskedLinkSecret,
  _getAdapter,
};
