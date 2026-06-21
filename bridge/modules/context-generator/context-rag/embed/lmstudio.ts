// ── LM Studio embedding adapter ───────────────────────────────────────────────
// LM Studio exposes an OpenAI-compatible /v1/embeddings endpoint on a local
// HTTP server (default http://localhost:1234/v1). Same wire format as NIM,
// no Bearer auth required by default.
//
// Differences from `nvidia.ts`:
//   • No `input_type` hint (LM Studio rejects unknown fields on some
//     embedder backends; passages and queries embed identically).
//   • No rerank endpoint — `rerank` is omitted entirely so retrieve.ts falls
//     back to vector-only ordering.
//   • Listing of available models is NOT done here; it reuses the bridge's
//     existing `/v1/models/refresh` flow via `bridge/models/fetch.ts`. The
//     DB-create form fetches the cached list and probes the user-picked id
//     through `probeEmbedDim()` below.
'use strict';

const logger      = require('../../../../core/logger');
const rateLimiter = require('../../../../core/rate-limiter');

function _recordEmbedUsage(
  usage: any,
  model: string,
  providerName: string,
): void {
  try {
    if (!usage) return;
    const inTok = usage.prompt_tokens || usage.total_tokens || 0;
    if (!inTok) return;
    const { recordTokens }    = require('../../../observability-plus/tokens');
    const { recordCost }      = require('../../../observability-plus/costs');
    const { getModelPricing } = require('../../../../models/config');
    recordTokens({ inputTokens: inTok, model, provider: providerName });
    const pricing = getModelPricing(model);
    if (pricing) {
      const cost = (inTok / 1_000_000) * (pricing.price_input || 0);
      if (cost > 0) recordCost(cost, model, providerName);
    }
  } catch (_) {}
}

import type { EmbeddingClient, ProbeResult } from './types';

interface LmStudioProviderRef {
  /** Display name (e.g. "LM Studio") — used as the rate-limiter bucket key. */
  name: string;
  /** Base URL, e.g. http://localhost:1234/v1 . */
  endpoint: string;
  /** Optional bearer token. LM Studio accepts any string when auth is
   *  enabled in its server settings; ignored otherwise. */
  api_key?: string;
}

const EMBED_TIMEOUT_MS = 60_000; // local server, but big batches on a Pi can be slow

function _trim(url: string): string {
  return String(url || '').replace(/\/$/, '');
}

async function _fetchEmbeddings(
  provider: LmStudioProviderRef,
  model:    string,
  texts:    string[],
  signal?:  AbortSignal,
): Promise<{ data: Array<{ embedding: number[]; index: number }> }> {
  const url = _trim(provider.endpoint) + '/embeddings';
  const { response: resp } = await rateLimiter.withRateLimit(
    provider.name || 'LM Studio',
    () => fetch(url, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(provider.api_key ? { Authorization: `Bearer ${provider.api_key}` } : {}),
      },
      body: JSON.stringify({ model, input: texts }),
      signal,
    }),
    { signal },
  );
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(`lmstudio embeddings http ${resp.status}: ${body.slice(0, 200)}`);
  }
  const json: any = await resp.json();
  if (!Array.isArray(json?.data)) {
    throw new Error(`lmstudio embeddings: malformed response (no .data array)`);
  }
  _recordEmbedUsage(json.usage, model, provider.name || 'LM Studio');
  return json;
}

async function probeEmbedDim(
  provider: LmStudioProviderRef,
  model:    string,
): Promise<ProbeResult> {
  const ac    = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('lmstudio probe timeout')), EMBED_TIMEOUT_MS);
  try {
    const json = await _fetchEmbeddings(provider, model, ['x'], ac.signal);
    const vec  = json.data[0]?.embedding;
    if (!Array.isArray(vec) || vec.length === 0) {
      throw new Error('lmstudio probe: empty embedding returned');
    }
    return { dim: vec.length, modelId: model };
  } finally {
    clearTimeout(timer);
  }
}

function createLmStudioClient(
  provider: LmStudioProviderRef,
  model:    string,
  dim:      number,
): EmbeddingClient {
  if (!provider?.endpoint) throw new Error('lmstudio client: provider.endpoint required');
  if (!model)              throw new Error('lmstudio client: model required');
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new Error(`lmstudio client: dim must be positive integer, got ${dim}`);
  }

  // LM Studio's /v1/embeddings has no `input_type` knob, so `opts.kind` is
  // accepted (for interface parity with the NVIDIA adapter) and ignored.
  async function embedBatch(
    texts: string[],
    _opts?: { kind?: 'passage' | 'query' },
  ): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const ac    = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('lmstudio embed timeout')), EMBED_TIMEOUT_MS);
    try {
      const json = await _fetchEmbeddings(provider, model, texts, ac.signal);
      const out  = new Array<Float32Array>(texts.length);
      for (const row of json.data) {
        const idx = typeof row.index === 'number' ? row.index : -1;
        if (idx < 0 || idx >= texts.length) {
          throw new Error(`lmstudio embeddings: row index ${idx} out of range [0..${texts.length - 1}]`);
        }
        if (!Array.isArray(row.embedding) || row.embedding.length !== dim) {
          throw new Error(
            `lmstudio embeddings: dim mismatch — expected ${dim}, got ${row.embedding?.length ?? '?'} ` +
            `for model ${model}. The DB's embedDim was locked at create time; the local model's ` +
            `output shape changed, which usually means a different model was loaded under the same id.`,
          );
        }
        out[idx] = new Float32Array(row.embedding);
      }
      for (let i = 0; i < out.length; i++) {
        if (!out[i]) throw new Error(`lmstudio embeddings: missing row for index ${i}`);
      }
      return out;
    } finally {
      clearTimeout(timer);
    }
  }

  logger.info('context-rag.embed.lmstudio.created', { model, dim, endpoint: _trim(provider.endpoint) });

  return {
    provider: 'lmstudio',
    modelId:  model,
    dim,
    embedBatch,
    // no rerank
  };
}

export { createLmStudioClient, probeEmbedDim };
export type { LmStudioProviderRef };
