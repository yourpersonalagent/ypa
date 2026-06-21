// ── NIM (NVIDIA) embedding adapter ────────────────────────────────────────────
// Wraps NIM's OpenAI-compat /v1/embeddings endpoint and (optionally) its
// reranking endpoint. The adapter is constructed against a resolved provider
// record from `config.providers[]` (preset_id === 'nvidia') and a model id
// validated at registry-create time. Both are frozen at construction; the
// `assertMetaMatch` lock in sqlite-vec.ts guarantees no caller can ever pass
// a mismatched model down here.
//
// Auth + endpoint pattern mirrors `bridge/modules/context-generator/auto-title.ts`:
//   • Bearer ${api_key} when present
//   • base URL trimmed of trailing slash
//   • routed through the shared `core/rate-limiter` per provider name so the
//     embeddings bucket shares throttling with chat/title calls.
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

interface NvidiaProviderRef {
  /** Display name (e.g. "NVIDIA") — used as the rate-limiter bucket key. */
  name: string;
  /** Base URL, e.g. https://integrate.api.nvidia.com/v1 . */
  endpoint: string;
  /** Bearer token, optional. NIM rejects unauthenticated calls in practice,
   *  but we don't enforce here — let the upstream return 401 and surface it. */
  api_key?: string;
}

const EMBED_TIMEOUT_MS  = 30_000;
const RERANK_TIMEOUT_MS = 15_000;

function _trim(url: string): string {
  return String(url || '').replace(/\/$/, '');
}

/** Translate NIM's per-account-entitlement 404 into actionable guidance.
 *  The raw body is e.g.
 *    {"status":404,"title":"Not Found","detail":"Function '<uuid>': Not
 *     found for account '<acct>'"}
 *  which is opaque to operators. We surface the model id they tried and
 *  point them at one that's universally free, so the next attempt likely
 *  succeeds without them having to spelunk NVIDIA's docs. */
function _friendlyError(status: number, body: string, model: string): string {
  if (status === 404 && /Function\s.*not found for account/i.test(body)) {
    return (
      `NVIDIA model "${model}" is not enabled on your NVIDIA account. ` +
      `Try "nvidia/nv-embedqa-e5-v5" (universal free tier) instead, or pick ` +
      `from the curated list in the setup form's default view.`
    );
  }
  return `nvidia embeddings http ${status}: ${body.slice(0, 200)}`;
}

async function _fetchEmbeddings(
  provider: NvidiaProviderRef,
  model:    string,
  texts:    string[],
  signal?:  AbortSignal,
  kind:     'passage' | 'query' = 'passage',
): Promise<{ data: Array<{ embedding: number[]; index: number }>; usage?: any }> {
  const url = _trim(provider.endpoint) + '/embeddings';
  const { response: resp } = await rateLimiter.withRateLimit(
    provider.name || 'NVIDIA',
    () => fetch(url, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(provider.api_key ? { Authorization: `Bearer ${provider.api_key}` } : {}),
      },
      body: JSON.stringify({
        model,
        input: texts,
        // NIM expects this hint for retrieval-style embedders (e5/nv-embedqa/
        // nv-embedcode). Using 'passage' for queries silently degrades recall.
        input_type: kind,
      }),
      signal,
    }),
    { signal },
  );
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    throw new Error(_friendlyError(resp.status, body, model));
  }
  const json: any = await resp.json();
  if (!Array.isArray(json?.data)) {
    throw new Error(`nvidia embeddings: malformed response (no .data array)`);
  }
  _recordEmbedUsage(json.usage, model, provider.name || 'NVIDIA');
  return json;
}

/** Probe `dim` by embedding a 1-token throwaway string. Used at DB-create
 *  time to lock the dimension into the registry. */
async function probeEmbedDim(
  provider: NvidiaProviderRef,
  model:    string,
): Promise<ProbeResult> {
  const ac    = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('nvidia probe timeout')), EMBED_TIMEOUT_MS);
  try {
    const json = await _fetchEmbeddings(provider, model, ['x'], ac.signal);
    const vec  = json.data[0]?.embedding;
    if (!Array.isArray(vec) || vec.length === 0) {
      throw new Error('nvidia probe: empty embedding returned');
    }
    return { dim: vec.length, modelId: model };
  } finally {
    clearTimeout(timer);
  }
}

function createNvidiaClient(
  provider: NvidiaProviderRef,
  model:    string,
  dim:      number,
): EmbeddingClient {
  if (!provider?.endpoint) throw new Error('nvidia client: provider.endpoint required');
  if (!model)              throw new Error('nvidia client: model required');
  if (!Number.isInteger(dim) || dim <= 0) {
    throw new Error(`nvidia client: dim must be positive integer, got ${dim}`);
  }

  async function embedBatch(
    texts: string[],
    opts?: { kind?: 'passage' | 'query' },
  ): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const kind = opts?.kind === 'query' ? 'query' : 'passage';
    const ac    = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('nvidia embed timeout')), EMBED_TIMEOUT_MS);
    try {
      const json = await _fetchEmbeddings(provider, model, texts, ac.signal, kind);
      const out  = new Array<Float32Array>(texts.length);
      for (const row of json.data) {
        const idx = typeof row.index === 'number' ? row.index : -1;
        if (idx < 0 || idx >= texts.length) {
          throw new Error(`nvidia embeddings: row index ${idx} out of range [0..${texts.length - 1}]`);
        }
        if (!Array.isArray(row.embedding) || row.embedding.length !== dim) {
          throw new Error(
            `nvidia embeddings: dim mismatch — expected ${dim}, got ${row.embedding?.length ?? '?'} ` +
            `for model ${model}. The DB's embedDim was locked at create time; this means the ` +
            `upstream model changed shape underneath us.`,
          );
        }
        out[idx] = new Float32Array(row.embedding);
      }
      for (let i = 0; i < out.length; i++) {
        if (!out[i]) throw new Error(`nvidia embeddings: missing row for index ${i}`);
      }
      return out;
    } finally {
      clearTimeout(timer);
    }
  }

  async function rerank(query: string, candidates: string[]): Promise<number[]> {
    if (candidates.length === 0) return [];
    // NVIDIA's rerank API lives on a different host root than embeddings —
    // OpenAI-compat endpoints sit at integrate.api.nvidia.com/v1, but rerank
    // is on the NeMo retrieval host at ai.api.nvidia.com.
    const url = 'https://ai.api.nvidia.com/v1/retrieval/nvidia/reranking';
    const ac    = new AbortController();
    const timer = setTimeout(() => ac.abort(new Error('nvidia rerank timeout')), RERANK_TIMEOUT_MS);
    try {
      const { response: resp } = await rateLimiter.withRateLimit(
        provider.name || 'NVIDIA',
        () => fetch(url, {
          method:  'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(provider.api_key ? { Authorization: `Bearer ${provider.api_key}` } : {}),
          },
          body: JSON.stringify({
            model: 'nvidia/rerank-qa-mistral-4b',
            query: { text: query },
            passages: candidates.map((t) => ({ text: t })),
          }),
          signal: ac.signal,
        }),
        { signal: ac.signal },
      );
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        throw new Error(`nvidia rerank http ${resp.status}: ${body.slice(0, 200)}`);
      }
      const json: any = await resp.json();
      _recordEmbedUsage(json?.usage, 'nvidia/rerank-qa-mistral-4b', provider.name || 'NVIDIA');
      const rankings: Array<{ index: number; logit: number }> =
        Array.isArray(json?.rankings) ? json.rankings : [];
      const scores = new Array<number>(candidates.length).fill(-Infinity);
      for (const r of rankings) {
        if (typeof r.index === 'number' && r.index >= 0 && r.index < candidates.length) {
          scores[r.index] = typeof r.logit === 'number' ? r.logit : 0;
        }
      }
      return scores;
    } finally {
      clearTimeout(timer);
    }
  }

  logger.info('context-rag.embed.nvidia.created', { model, dim, endpoint: _trim(provider.endpoint) });

  return {
    provider: 'nvidia',
    modelId:  model,
    dim,
    embedBatch,
    rerank,
  };
}

export { createNvidiaClient, probeEmbedDim };
export type { NvidiaProviderRef };
