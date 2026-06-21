// ── context-rag embedding-client interface ────────────────────────────────────
// Every embedding backend (NIM, LM Studio, future providers) implements
// `EmbeddingClient`. The ingest runner and retrieve query layer never look at
// the concrete adapter — they take a client resolved by `client-for-db.ts`
// from a registry entry's `embedProvider`/`embedModel`.
//
// `embedBatch` returns Float32Array per input, in the same order, of length
// `dim`. The caller is responsible for chunking input arrays to whatever
// batch limit the upstream provider supports — these adapters do NOT chunk
// internally beyond passing the array straight through.
//
// `rerank` is optional. When present, it returns a score per candidate
// (higher = more relevant). When absent, callers fall back to similarity
// ordering from the vector store.
'use strict';

interface EmbeddingClient {
  /** Provider preset id this client is bound to ('nvidia' | 'lmstudio'). */
  readonly provider: 'nvidia' | 'lmstudio';
  /** EXACT upstream model id this client is bound to. */
  readonly modelId: string;
  /** Vector dimension produced by `modelId`. Frozen at construction time. */
  readonly dim: number;

  /** Embed N texts; returns N Float32Array(dim), same order.
   *
   *  `opts.kind` is a NIM-style hint: `'passage'` for ingest-side content
   *  going into the index, `'query'` for a user query going against it.
   *  Asymmetric NIM retrieval models (e5, nv-embedqa, nv-embedcode, …)
   *  produce noticeably worse search if both sides embed as `passage`.
   *  Adapters that don't have an upstream knob for this (LM Studio) should
   *  ignore it. Default is `'passage'` for back-compat with ingest callers. */
  embedBatch(texts: string[], opts?: { kind?: 'passage' | 'query' }): Promise<Float32Array[]>;

  /** Optional reranker. Returns one score per candidate, higher = better. */
  rerank?(query: string, candidates: string[]): Promise<number[]>;
}

/** Result shape used by `probeEmbedDim` — kept here so callers don't have
 *  to know whether the probe went through the NIM or LM Studio code path. */
interface ProbeResult {
  dim: number;
  /** The exact model id the upstream confirmed (some servers echo a
   *  canonical id different from what the caller sent). */
  modelId: string;
}

export type { EmbeddingClient, ProbeResult };
