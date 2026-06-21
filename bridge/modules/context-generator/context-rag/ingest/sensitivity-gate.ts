// ── context-rag sensitivity gate ──────────────────────────────────────────────
// Per-chunk pre-embed filter. Each chunk is classified via the shared
// `bridge/modules/context-generator/sensitivity.ts:proposeSensitivity()` helper (path rules
// first, then credential / PII heuristics on the chunk text). The DB's
// `sensitivity` filter then decides include/exclude.
//
// Auto-detected tiers below the confidence threshold (0.8 — categorizer
// convention) demote to 'public'. Path-rule hits are confidence 1.0 by
// definition and survive the threshold.
//
// `exclude` wins over `include` — if a tier is in both lists, the chunk is
// dropped. This matches the registry's documented contract.
'use strict';

const sensitivity = require('../../sensitivity');

import type { SensitivityFilter, SensitivityTier } from '../registry/types';

const CONF_THRESHOLD = 0.8;

interface ChunkGateInput {
  text:  string;
  title?: string | null;
  /** Absolute path when chunk came from a file or its container has a path;
   *  null for in-memory sessions. */
  path?: string | null;
}

interface ChunkGateResult {
  pass:        boolean;
  tier:        SensitivityTier;
  confidence:  number;
  source:      'path' | 'auto';
  /** When `pass === false`, the human-readable reason ('excluded:system',
   *  'not-in-include:private', etc.). Always undefined on pass. */
  reason?:     string;
}

function classifyAndGate(filter: SensitivityFilter, input: ChunkGateInput): ChunkGateResult {
  const proposal = sensitivity.proposeSensitivity({
    title:   input.title ?? '',
    content: input.text || '',
    path:    input.path ?? null,
  }) as {
    tier:       SensitivityTier;
    confidence: number;
    source:     'path' | 'auto';
    reasons:    string[];
  };

  // Demote low-confidence auto hits to 'public' so a faint signal doesn't
  // accidentally cordon off a chunk that belongs in the public DB.
  const effectiveTier: SensitivityTier =
    proposal.source === 'path' || proposal.confidence >= CONF_THRESHOLD
      ? proposal.tier
      : 'public';

  const excluded = filter.exclude.includes(effectiveTier);
  if (excluded) {
    return {
      pass: false,
      tier: effectiveTier,
      confidence: proposal.confidence,
      source: proposal.source,
      reason: `excluded:${effectiveTier}`,
    };
  }
  const included = filter.include.includes(effectiveTier);
  if (!included) {
    return {
      pass: false,
      tier: effectiveTier,
      confidence: proposal.confidence,
      source: proposal.source,
      reason: `not-in-include:${effectiveTier}`,
    };
  }
  return {
    pass: true,
    tier: effectiveTier,
    confidence: proposal.confidence,
    source: proposal.source,
  };
}

export { classifyAndGate, CONF_THRESHOLD };
export type { ChunkGateInput, ChunkGateResult };
