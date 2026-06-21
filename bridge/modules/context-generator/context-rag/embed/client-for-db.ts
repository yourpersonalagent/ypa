// ── Per-DB embedding-client resolver ──────────────────────────────────────────
// Given a `VectorDB` registry entry, return a fresh `EmbeddingClient` bound
// to the right provider config from `config.providers[]` and locked to the
// DB's `embedModel` / `embedDim`. This is the only file that knows the
// mapping from the registry's compact `embedProvider` enum ('nvidia' |
// 'lmstudio') to the runtime provider config (matched by `preset_id`).
//
// Clients are cached per-DB so the rate-limiter bucket key and the timeout
// timers don't get reconstructed on every call. The cache key is the DB id
// plus a fingerprint of the resolved provider record — that way a UI edit
// (api_key rotated, endpoint moved) invalidates the cached client without
// requiring an explicit invalidation API.
'use strict';

const logger = require('../../../../core/logger');
const state  = require('../../../../core/state');

import type { VectorDB } from '../registry/types';
import type { EmbeddingClient }                  from './types';
import { createNvidiaClient }                    from './nvidia';
import { createLmStudioClient }                  from './lmstudio';

interface ProviderRecord {
  name:       string;
  preset_id?: string;
  endpoint:   string;
  api_key?:   string;
  hidden?:    boolean;
}

const PROVIDER_PRESET_FOR_EMBED: Record<'nvidia' | 'lmstudio', string> = {
  nvidia:   'nvidia',
  lmstudio: 'local-lmstudio',
};

interface CacheEntry {
  fingerprint: string;
  client:      EmbeddingClient;
}

const clientCache = new Map<string, CacheEntry>();

function _findProviderForEmbed(embedProvider: 'nvidia' | 'lmstudio'): ProviderRecord | null {
  const presetId = PROVIDER_PRESET_FOR_EMBED[embedProvider];
  const list: ProviderRecord[] = state.config?.providers || [];
  // Primary: match preset_id (the configured way).
  const byPreset = list.find((p) => p && !p.hidden && p.preset_id === presetId && p.endpoint);
  if (byPreset) return byPreset;
  // Fallback: match by canonical display name (covers legacy configs that
  // pre-date preset_id being persisted).
  const byName = list.find((p) => {
    if (!p || p.hidden || !p.endpoint) return false;
    if (embedProvider === 'nvidia')   return p.name === 'NVIDIA';
    if (embedProvider === 'lmstudio') return p.name === 'LM Studio';
    return false;
  });
  return byName || null;
}

function _fingerprint(p: ProviderRecord): string {
  // Endpoint + key-presence is enough — actual key contents change rarely and
  // a UI rotation always flips the trailing presence flag at least via
  // saveConfig writing a new object. We avoid hashing the key directly so
  // the cache map can never accidentally expose it.
  return `${p.endpoint}|${p.api_key ? 'k' : '-'}`;
}

/** Resolve (and cache) an `EmbeddingClient` for a registry entry. Throws if
 *  no provider in `config.providers[]` matches the DB's `embedProvider`. */
function clientForDB(db: VectorDB): EmbeddingClient {
  const provider = _findProviderForEmbed(db.embedProvider);
  if (!provider) {
    throw new Error(
      `context-rag[${db.id}]: no provider in config.providers[] matches embedProvider '${db.embedProvider}'. ` +
      `Expected preset_id='${PROVIDER_PRESET_FOR_EMBED[db.embedProvider]}'. ` +
      `Load the preset from the providers UI or add a matching entry.`,
    );
  }
  const fp     = _fingerprint(provider);
  const cached = clientCache.get(db.id);
  if (cached && cached.fingerprint === fp
             && cached.client.modelId  === db.embedModel
             && cached.client.dim      === db.embedDim
             && cached.client.provider === db.embedProvider) {
    return cached.client;
  }
  let client: EmbeddingClient;
  if (db.embedProvider === 'nvidia') {
    client = createNvidiaClient(provider, db.embedModel, db.embedDim);
  } else if (db.embedProvider === 'lmstudio') {
    client = createLmStudioClient(provider, db.embedModel, db.embedDim);
  } else {
    throw new Error(`context-rag[${db.id}]: unsupported embedProvider '${(db as any).embedProvider}'`);
  }
  clientCache.set(db.id, { fingerprint: fp, client });
  logger.info('context-rag.embed.client-resolved', {
    dbId: db.id, provider: db.embedProvider, model: db.embedModel, dim: db.embedDim,
  });
  return client;
}

/** Drop any cached client for `dbId`. Used by the registry layer when a DB is
 *  deleted or its provider record is mutated in a way the fingerprint would
 *  miss (rare). */
function invalidateClient(dbId: string): void {
  if (clientCache.delete(dbId)) {
    logger.info('context-rag.embed.client-invalidated', { dbId });
  }
}

/** Clear the entire cache. Useful for tests and for the `/v1/models/refresh`
 *  flow when a provider record changes shape (e.g. endpoint moved). */
function invalidateAllClients(): void {
  const n = clientCache.size;
  clientCache.clear();
  if (n > 0) logger.info('context-rag.embed.cache-cleared', { dropped: n });
}

export {
  clientForDB,
  invalidateClient,
  invalidateAllClients,
  // Exposed for routes (POST /v1/context-rag/dbs) so the create-time dim
  // probe uses the same preset_id→provider mapping as runtime ingest.
  _findProviderForEmbed as findProviderForEmbed,
};
