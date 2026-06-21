// ── LLM classification ────────────────────────────────────────────────────────
// Single non-streaming completion + JSON-tolerant parsing helpers. Stateless
// (the rate-limiter held inside `core/rate-limiter` carries its own bucket).
'use strict';

const {
  CATEGORIZE_TIMEOUT_MS,
  VALID_CATEGORIES,
  CATEGORY_SET,
} = require('./constants');
const {
  _extractExcerpt,
  _extractWorkingDir,
  _deriveTags,
} = require('./extract');

// ── Category validation ───────────────────────────────────────────────────────
// The model occasionally adds quotes, punctuation, or a leading explanation
// despite the prompt. We strip and lowercase, then check membership.

function _validateCategory(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null;
  // Take only the first whitespace-delimited token, strip quotes/punct.
  const first = raw.trim().split(/\s+/)[0] || '';
  const cleaned = first.toLowerCase().replace(/[^a-z-]/g, '');
  if (!cleaned) return null;
  return CATEGORY_SET.has(cleaned) ? cleaned : null;
}

// ── LLM request ──────────────────────────────────────────────────────────────
// Single non-streaming completion. Returns the validated category slug or null.

// Tolerant JSON extraction — same shape as file-categorizer. Some models wrap
// the response in markdown fences; we strip those before parsing.
function _stripFences(s: string): string {
  return s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
}

function _tryParseJson(s: string): any | null {
  const cleaned = _stripFences(s.trim());
  try { return JSON.parse(cleaned); } catch { /* try braces */ }
  const first = cleaned.indexOf('{');
  const last  = cleaned.lastIndexOf('}');
  if (first >= 0 && last > first) {
    try { return JSON.parse(cleaned.slice(first, last + 1)); } catch { /* fail */ }
  }
  return null;
}

// Defense-in-depth against prompt-injection from user-controlled fields
// (session title, cwd, content excerpt) before they're interpolated into
// the user message. `JSON.stringify(v).slice(1,-1)` escapes quotes,
// backslashes, and control characters that a malicious title could use
// to confuse the model into emitting bogus categories. Final mitigation
// is still the slug allowlist in _sanitiseSlugList; this just narrows
// the surface.
function _escapeForPrompt(v: unknown): string {
  if (v == null) return '';
  return JSON.stringify(String(v)).slice(1, -1);
}

function _sanitiseSlugList(raw: any, opts: { maxLen: number; cap: number }): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    let s = v.trim().toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-+|-+$/g, '');
    if (!s) continue;
    // Truncate at a `-` boundary when over the cap so we don't mint
    // mid-word slugs like `typescript-vite-integrati`. Audit 2026-05-10
    // showed ~10–20 % of keywords were amputated by the old slice().
    if (s.length > opts.maxLen) {
      const cut = s.lastIndexOf('-', opts.maxLen);
      s = cut > Math.floor(opts.maxLen / 2) ? s.slice(0, cut) : s.slice(0, opts.maxLen);
    }
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
    if (out.length >= opts.cap) break;
  }
  return out;
}

async function _classify(
  s:        any,
  model:    string,
  provider: { api_key?: string; endpoint: string },
): Promise<{ category: string; tags: string[]; keywords: string[] } | null> {
  const title  = (s.name || '').trim();
  const cwd    = _extractWorkingDir(s);
  const excerpt = _extractExcerpt(s, 400);   // bumped from 200 — keywords need more context
  if (!title && !excerpt) return null;

  const ac    = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('categorize-timeout')), CATEGORIZE_TIMEOUT_MS);

  try {
    const url  = provider.endpoint.replace(/\/$/, '') + '/chat/completions';
    // ── Rate limiter (Phase 1.10) ──────────────────────────────────────────
    // Same per-provider bucket as auto-title — they share the upstream RPM.
    const rateLimiter = require('../../../core/rate-limiter');
    const providerName: string = (provider as any).name || 'NVIDIA';
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
              role:    'system',
              content:
                'You classify developer chat sessions for a context-graph index. ' +
                'Return STRICT JSON with three fields and nothing else:\n\n' +
                '  {\n' +
                '    "category": "...",         // EXACTLY ONE slug from this list:\n' +
                '                                //   ' + VALID_CATEGORIES.join(', ') + '\n' +
                '    "tags":     [...],         // 2–5 short labels (kebab-case, ≤ 20 chars)\n' +
                '    "keywords": [...]          // 3–8 semantic search terms (kebab-case, ≤ 25 chars)\n' +
                '  }\n\n' +
                'Rules:\n' +
                '- Reply with ONLY the JSON object. No prose, no fences, no ```.\n' +
                '- If unsure between two categories, pick the more specific one.\n' +
                '- "general" is the category-fallback when nothing else fits.\n' +
                '- "tags" are short identifiers (e.g. "react-hooks", "typo-fix").\n' +
                '- "keywords" are search terms a user would actually type to find this session.\n' +
                '- Lower-case kebab-case for everything. No emojis, no quotes.',
            },
            {
              role:    'user',
              content:
                `Session title: "${_escapeForPrompt(title)}"\n` +
                `Working directory: "${_escapeForPrompt(cwd)}"\n` +
                `Content excerpt: "${_escapeForPrompt(excerpt)}"\n\n` +
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
      // Phase 5.1 — surface the failure reason on the session so the
      // Inspector panel can show "rate-limited" / "http-503" instead of
      // a silent re-attempt-forever loop.
      (s as any)._categorySkipReason = resp.status === 429 ? 'rate-limited' : `http-${resp.status}`;
      return null;
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
    // Phase 4.3 — try JSON first; fall back to legacy single-slug parsing
    // when the model ignores the JSON instructions (older NVIDIA llama
    // checkpoints sometimes return just the slug). Keeps behaviour stable
    // across model swaps.
    const parsed = _tryParseJson(text);
    if (parsed && typeof parsed === 'object') {
      const category = _validateCategory(String(parsed.category || ''));
      if (!category) {
        (s as any)._categorySkipReason = 'invalid-category-slug';
        return null;
      }
      const llmTags     = _sanitiseSlugList(parsed.tags,     { maxLen: 20, cap: 5 });
      const llmKeywords = _sanitiseSlugList(parsed.keywords, { maxLen: 25, cap: 8 });
      // Mix LLM tags with the deterministic title/cwd-derived ones — the
      // deterministic set provides a stable floor (every session has at
      // least *some* tags) while LLM-derived tags add semantic depth.
      const detTags = _deriveTags(title, cwd);
      const tagsMerged: string[] = [];
      const seen = new Set<string>();
      for (const t of [...llmTags, ...detTags]) {
        if (!seen.has(t)) { seen.add(t); tagsMerged.push(t); if (tagsMerged.length >= 5) break; }
      }
      return { category, tags: tagsMerged, keywords: llmKeywords };
    }
    // Legacy fallback: single-slug response.
    const category = _validateCategory(text);
    if (!category) {
      (s as any)._categorySkipReason = text.trim().length === 0 ? 'empty-response' : 'invalid-response';
      return null;
    }
    const tags = _deriveTags(title, cwd);
    return { category, tags, keywords: [] };
  } catch (e) {
    clearTimeout(timer);
    (s as any)._categorySkipReason = e instanceof Error && e.message.includes('timeout')
      ? 'request-timeout'
      : 'request-error';
    return null;
  }
}

module.exports = {
  _classify,
  _validateCategory,
  _stripFences,
  _tryParseJson,
  _sanitiseSlugList,
};
