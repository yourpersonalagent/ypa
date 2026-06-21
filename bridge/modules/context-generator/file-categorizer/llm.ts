// ── File-Categorizer LLM call ─────────────────────────────────────────────────
// One non-streaming completion per file. Asks for strict JSON; falls back to
// best-effort extraction if the model wraps it in markdown fences.
'use strict';

const path = require('path');
const { FILE_CAT_TIMEOUT_MS, TOPIC_SLUGS, TOPIC_SET } = require('./constants');

interface ClassifyResult {
  topics:   string[];
  tags:     string[];
  keywords: string[];
}

// Phase 5.2 — return type now carries either the parsed result or a
// machine-readable skip reason so the run-loop can persist `_attempts++`
// alongside an explanatory string for the Inspector.
type ClassifyOutcome =
  | { ok: true;  result: ClassifyResult }
  | { ok: false; reason: string };

function _stripFences(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
}

function _tryParseJson(s: string): any | null {
  const cleaned = _stripFences(s.trim());
  try { return JSON.parse(cleaned); } catch { /* try braces */ }
  // Find the outermost JSON object.
  const first = cleaned.indexOf('{');
  const last  = cleaned.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(cleaned.slice(first, last + 1)); } catch { /* fail */ }
  }
  return null;
}

// Defense-in-depth against prompt-injection from user-controlled fields
// (filename, body excerpt). `JSON.stringify(v).slice(1,-1)` escapes quotes,
// backslashes, and control characters that a malicious filename could use
// to confuse the model into emitting bogus topics. Final mitigation is
// still the allowlist in _sanitiseStringList; this narrows the surface.
function _escapeForPrompt(v: unknown): string {
  if (v == null) return '';
  return JSON.stringify(String(v)).slice(1, -1);
}

function _sanitiseStringList(raw: any, opts: { allowed?: Set<string>; maxLen?: number; cap?: number }): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    let s = v.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
    if (!s) continue;
    // Truncate at a `-` boundary when over the cap. Mirrors the session
    // categorizer's _sanitiseSlugList — see audit 2026-05-10.
    if (opts.maxLen && s.length > opts.maxLen) {
      const cut = s.lastIndexOf('-', opts.maxLen);
      s = cut > Math.floor(opts.maxLen / 2) ? s.slice(0, cut) : s.slice(0, opts.maxLen);
    }
    if (opts.allowed && !opts.allowed.has(s)) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (opts.cap && out.length >= opts.cap) break;
  }
  return out;
}

async function _classify(
  filePath: string,
  body:     string,
  model:    string,
  provider: { name?: string; api_key?: string; endpoint: string },
): Promise<ClassifyOutcome> {
  const ac    = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('file-categorize-timeout')), FILE_CAT_TIMEOUT_MS);

  try {
    const url = provider.endpoint.replace(/\/$/, '') + '/chat/completions';
    const rateLimiter = require('../../../core/rate-limiter');
    const providerName: string = provider.name || 'NVIDIA';
    const filename = path.basename(filePath, '.md');

    const { response: resp } = await rateLimiter.withRateLimit(
      providerName,
      () => fetch(url, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(provider.api_key ? { Authorization: `Bearer ${provider.api_key}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [
            {
              role: 'system',
              content:
                'You classify personal notes for a context-graph index. ' +
                'Return STRICT JSON with three fields and nothing else:\n\n' +
                '  {\n' +
                '    "topics":   [...],   // 0–3 slugs from this allowlist:\n' +
                '                          //   ' + TOPIC_SLUGS.join(', ') + '\n' +
                '    "tags":     [...],   // 1–5 short labels (kebab-case, ≤ 20 chars)\n' +
                '    "keywords": [...]    // 3–8 semantic search terms (kebab-case, ≤ 25 chars)\n' +
                '  }\n\n' +
                'Rules:\n' +
                '- Reply with ONLY the JSON object. No prose, no fences, no ```.\n' +
                '- "topics" MUST be a subset of the allowlist; pick none if nothing fits well.\n' +
                '- "tags" are descriptive labels (e.g. "shopping-list", "trip-paris-2024").\n' +
                '- "keywords" are search terms a user would actually type.\n' +
                '- Lower-case kebab-case for everything. No emojis, no quotes.',
            },
            {
              role: 'user',
              content:
                `Filename: "${_escapeForPrompt(filename)}"\n` +
                `Content (truncated):\n${_escapeForPrompt(body)}\n\n` +
                `JSON:`,
            },
          ],
          stream:      false,
          max_tokens:  220,
          temperature: 0.1,
        }),
        signal: ac.signal,
      }),
      { signal: ac.signal },
    );

    clearTimeout(timer);
    if (!resp.ok) {
      return { ok: false, reason: resp.status === 429 ? 'rate-limited' : `http-${resp.status}` };
    }
    const json: any = await resp.json();
    try {
      const usage = json?.usage;
      if (usage) {
        const inTok  = usage.prompt_tokens    || 0;
        const outTok = usage.completion_tokens || 0;
        if (inTok || outTok) {
          const { recordTokens }    = require('../../observability-plus/tokens');
          const { recordCost }      = require('../../observability-plus/costs');
          const { getModelPricing } = require('../../../models/config');
          recordTokens({ inputTokens: inTok, outputTokens: outTok, model, provider: providerName });
          const pricing = getModelPricing(model);
          if (pricing) {
            const cost = (inTok / 1_000_000) * (pricing.price_input || 0) +
                         (outTok / 1_000_000) * (pricing.price_output || 0);
            if (cost > 0) recordCost(cost, model, providerName);
          }
        }
      }
    } catch (_) {}
    const text: string = json?.choices?.[0]?.message?.content ?? '';
    const parsed = _tryParseJson(text);
    if (!parsed || typeof parsed !== 'object') {
      return { ok: false, reason: text.trim().length === 0 ? 'empty-response' : 'invalid-json' };
    }

    const topics   = _sanitiseStringList(parsed.topics,   { allowed: TOPIC_SET, cap: 3 });
    const tags     = _sanitiseStringList(parsed.tags,     { maxLen: 20, cap: 5 });
    const keywords = _sanitiseStringList(parsed.keywords, { maxLen: 25, cap: 8 });

    // We accept a result with empty topics, but require at least one
    // non-empty list otherwise so we don't write blank frontmatter.
    if (tags.length === 0 && keywords.length === 0 && topics.length === 0) {
      return { ok: false, reason: 'all-lists-empty' };
    }

    return { ok: true, result: { topics, tags, keywords } };
  } catch (e) {
    clearTimeout(timer);
    return {
      ok: false,
      reason: e instanceof Error && e.message.includes('timeout')
        ? 'request-timeout'
        : 'request-error',
    };
  }
}

module.exports = {
  _classify,
  _stripFences,
  _tryParseJson,
  _sanitiseStringList,
};
