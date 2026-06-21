// ── Bulk entitlement probe ────────────────────────────────────────────────────
// Given a provider record + a list of model ids, runs a tiny 1-token embed
// against each and partitions them into available / unavailable. Adapter-
// neutral: dispatches to `probeEmbedDim` from nvidia.ts or lmstudio.ts.
//
// Concurrency: sequential. NIM rate-limits aggressively when many models are
// hit in parallel, and the operator triggers this from a button so a few
// extra seconds is fine. LM Studio is local and fast anyway.
//
// "unavailable" semantics: any exception from the adapter is recorded. We
// intentionally do NOT try to distinguish "404 not entitled" from "transient
// network error" here — the error message is preserved verbatim so the UI
// can decide. Re-probing later naturally heals transient failures.
'use strict';

import type { EmbedProvider } from '../registry/types';
import type { ProviderEntitlement } from '../registry/entitlements';

const nvidia   = require('./nvidia');
const lmstudio = require('./lmstudio');

interface ProviderRecord {
  name:     string;
  endpoint: string;
  api_key?: string;
}

async function _probeOne(
  provider: EmbedProvider,
  record:   ProviderRecord,
  model:    string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    if (provider === 'nvidia') {
      const r = await nvidia.probeEmbedDim(record, model);
      return { ok: Number.isInteger(r?.dim) && r.dim > 0 };
    }
    if (provider === 'lmstudio') {
      const r = await lmstudio.probeEmbedDim(record, model);
      return { ok: Number.isInteger(r?.dim) && r.dim > 0 };
    }
    return { ok: false, error: `unsupported provider: ${provider}` };
  } catch (e: any) {
    return { ok: false, error: e?.message || String(e) };
  }
}

/** Probe every id in `models` against the provider. Returns a
 *  `ProviderEntitlement` ready to be passed to
 *  `entitlements.setProviderEntitlement`. */
async function probeEntitlements(
  provider: EmbedProvider,
  record:   ProviderRecord,
  models:   string[],
): Promise<ProviderEntitlement> {
  const available:   string[]                = [];
  const unavailable: string[]                = [];
  const errors:      Record<string, string>  = {};
  // De-dupe to avoid wasting probes when the curated list overlaps with
  // in-use ids (very common in practice — the chats default IS curated).
  const unique = Array.from(new Set(models));
  for (const id of unique) {
    const r = await _probeOne(provider, record, id);
    if (r.ok) available.push(id);
    else {
      unavailable.push(id);
      if (r.error) errors[id] = r.error;
    }
  }
  return { probedAt: Date.now(), available, unavailable, errors };
}

export { probeEntitlements };
export type { ProviderRecord };
