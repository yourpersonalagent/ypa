// ── context-rag entitlements cache ────────────────────────────────────────────
// Persists the result of "which embedding models are actually entitled on the
// account behind this provider record" to `data/entitlements.json`.
//
// Why a separate file:
//   - dbs.json is the source of truth and migration target. Mixing transient
//     probe state in there would force a registry version bump on every
//     probe-format tweak.
//   - The cache is keyed by provider (`nvidia` | `lmstudio`) — there's
//     exactly one record per provider type per bridge install (see
//     client-for-db.ts's preset_id mapping), so per-record fingerprinting is
//     overkill.
//
// 24h TTL is the freshness contract we promise the UI; the entitlement-status
// pill on HubRagTab uses `isStale()` to decide whether to nudge for a re-probe.
'use strict';

const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

import type { EmbedProvider } from './types';

// Per-user (Q16) — routed via bridge/core/paths.ts.
// Falls back to bridge/modules/.../data/entitlements.json pre-migration.
const _paths           = require('../../../../core/paths');
const DATA_DIR         = _paths.contextRagDataDir;
const ENTITLEMENTS_PATH = _paths.contextRagEntitlements;

const CACHE_VERSION = 1 as const;
const TTL_MS        = 24 * 60 * 60 * 1_000;

interface ProviderEntitlement {
  /** ms-since-epoch when the probe ran. */
  probedAt: number;
  /** Model ids that returned a usable embedding from a 1-token probe. */
  available: string[];
  /** Model ids that responded but did not return an embedding (404 entitlement,
   *  schema mismatch, etc). Distinct from "never probed" — these are known-bad. */
  unavailable: string[];
  /** Per-model error message. Only populated for `unavailable` entries; helps
   *  the UI distinguish "not entitled" from "transient network error" via
   *  message inspection. */
  errors: Record<string, string>;
}

interface EntitlementsCache {
  version: typeof CACHE_VERSION;
  providers: Partial<Record<EmbedProvider, ProviderEntitlement>>;
}

let _cache: EntitlementsCache | null = null;

function _emptyCache(): EntitlementsCache {
  return { version: CACHE_VERSION, providers: {} };
}

function _readFromDisk(): EntitlementsCache {
  let raw: string;
  try {
    raw = fs.readFileSync(ENTITLEMENTS_PATH, 'utf8');
  } catch (e: any) {
    if (e && e.code === 'ENOENT') return _emptyCache();
    throw e;
  }
  let parsed: any;
  try { parsed = JSON.parse(raw); }
  catch { return _emptyCache(); }
  if (!parsed || parsed.version !== CACHE_VERSION || !parsed.providers) {
    return _emptyCache();
  }
  return parsed as EntitlementsCache;
}

function _writeToDisk(c: EntitlementsCache): void {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = ENTITLEMENTS_PATH + '.tmp-' + crypto.randomBytes(4).toString('hex');
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, ENTITLEMENTS_PATH);
}

function _ensureLoaded(): EntitlementsCache {
  if (_cache === null) _cache = _readFromDisk();
  return _cache;
}

/** Full cache snapshot. UI calls this via the entitlements GET route. */
function readCache(): EntitlementsCache {
  return _ensureLoaded();
}

/** Replace one provider's entry. Used by the probe route after a fresh probe.
 *  Writes through to disk synchronously so a crash mid-loop doesn't leave
 *  stale memory state. */
function setProviderEntitlement(
  provider: EmbedProvider,
  entry:    ProviderEntitlement,
): void {
  const c = _ensureLoaded();
  c.providers[provider] = entry;
  _writeToDisk(c);
}

function getProviderEntitlement(provider: EmbedProvider): ProviderEntitlement | null {
  return _ensureLoaded().providers[provider] || null;
}

/** True when the entry is older than the 24h TTL (or missing). */
function isStale(provider: EmbedProvider): boolean {
  const entry = getProviderEntitlement(provider);
  if (!entry) return true;
  return Date.now() - entry.probedAt > TTL_MS;
}

/** Status of a (provider, model) tuple against the cache. `unknown` means
 *  no probe has ever recorded this model — the UI should NOT use this to
 *  mark a DB as "broken", only to nudge for a probe. */
type EntitlementStatus = 'available' | 'unavailable' | 'unknown';
function statusFor(provider: EmbedProvider, model: string): EntitlementStatus {
  const entry = getProviderEntitlement(provider);
  if (!entry) return 'unknown';
  if (entry.available.includes(model)) return 'available';
  if (entry.unavailable.includes(model)) return 'unavailable';
  return 'unknown';
}

/** Test-only: drop in-memory cache so the next call re-reads disk. */
function _reset(): void {
  _cache = null;
}

export {
  ENTITLEMENTS_PATH,
  CACHE_VERSION,
  TTL_MS,
  readCache,
  setProviderEntitlement,
  getProviderEntitlement,
  isStale,
  statusFor,
  _reset,
};
export type {
  ProviderEntitlement,
  EntitlementsCache,
  EntitlementStatus,
};
