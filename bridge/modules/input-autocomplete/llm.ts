// Single non-streaming completion call. Returns a short continuation for the
// caller's text, or null on failure / empty / clearly-bogus output. Modeled
// after auto-title.ts and categorizer/llm.ts — same OpenAI-compatible shape,
// same per-provider rate-limiter bucket.
'use strict';

const REQUEST_TIMEOUT_MS = 6_000;
const TOKEN_RECORD_WARN_INTERVAL_MS = 60_000;
let _lastTokenRecordWarnAt = 0;

function _maybeWarnTokenRecord(e: any): void {
  const now = Date.now();
  if (now - _lastTokenRecordWarnAt < TOKEN_RECORD_WARN_INTERVAL_MS) return;
  _lastTokenRecordWarnAt = now;
  const msg = (e && (e.message || e.code)) || String(e);
  console.warn('[autocomplete] token/cost record failed (rate-limited):', msg);
}

function _sanitiseSuggestion(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return null;
  let s = raw.replace(/^\s+/, '');
  // Strip wrapping quotes / fences the model occasionally adds.
  s = s.replace(/^```[a-z]*\s*/i, '').replace(/\s*```\s*$/, '');
  s = s.replace(/^["'`]+/, '').replace(/["'`]+$/, '');
  // Models sometimes echo the user's text back; the caller compares prefixes
  // and discards in that case, so we only do hard cleanup here.
  s = s.replace(/\r/g, '');
  // Hard cap — long suggestions become noise.
  if (s.length > 240) s = s.slice(0, 240);
  if (!s.trim()) return null;
  return s;
}

async function _complete(
  text:     string,
  model:    string,
  provider: { name?: string; api_key?: string; endpoint: string },
  opts:     { maxTokens?: number; temperature?: number; historyTail?: string; useCompletionsEndpoint?: boolean } = {},
): Promise<string | null> {
  if (!text || !text.trim()) return null;

  const ac    = new AbortController();
  const timer = setTimeout(() => ac.abort(new Error('autocomplete-timeout')), REQUEST_TIMEOUT_MS);

  try {
    const rateLimiter = require('../../core/rate-limiter');
    const providerName: string = provider.name || 'NVIDIA';
    const hasContext = !!(opts.historyTail && opts.historyTail.trim());
    const useCompletions = !!opts.useCompletionsEndpoint;
    const endpointPath = useCompletions ? '/completions' : '/chat/completions';
    const url = provider.endpoint.replace(/\/$/, '') + endpointPath;

    let body: string;
    if (useCompletions) {
      // FIM (Fill-in-Middle) completion. Wraps the text in starcoder2/codestral
      // FIM tokens: model predicts what belongs between <fim_prefix> and
      // <fim_suffix>. With an empty suffix (cursor at end) this is a clean
      // "continue from here" — same tokens work for bigcode/starcoder2-* and
      // mistralai/codestral-* on NVIDIA NIM.
      const prefix = hasContext
        ? opts.historyTail!.slice(-1000) + '\n\n' + text
        : text;
      const prompt = `<fim_prefix>${prefix}<fim_suffix><fim_middle>`;
      body = JSON.stringify({
        model,
        prompt,
        max_tokens:  opts.maxTokens   ?? 40,
        temperature: opts.temperature ?? 0.4,
        stop:        ['\n\n', '<fim_prefix>', '<fim_suffix>', '<fim_middle>'],
        stream:      false,
      });
    } else {
      const systemPrompt =
        'You are an inline autocomplete for a chat message that the user is in the middle of writing. ' +
        'Treat their text as an unfinished sentence and continue it directly.\n\n' +
        'Rules:\n' +
        '- Reply with ONLY the continuation text. No preamble, no quotes, no markdown, no explanations.\n' +
        '- Do NOT repeat or echo the user\'s text. Your output is concatenated to theirs as-is.\n' +
        '- 1–12 words, single line, never more than one sentence.\n' +
        '- Always produce a plausible continuation. Never reply with nothing, even for a short greeting like "hey" or "thanks" — guess what most users would say next.\n' +
        '- Do not reply *to* the user as if they were addressing you. You are completing what they are still typing, not answering them.\n' +
        '- Match the user\'s language and tone.' +
        (hasContext
          ? '\n- A preceding message from the conversation may be supplied in the user turn for context — use it to make the continuation relevant, but still only output the continuation, not a reply.'
          : '');
      const userContent = hasContext
        ? `(Previous message in conversation: "${opts.historyTail!.replace(/"/g, '\\"').slice(-1000)}")\n\nContinue this in-progress message: ${text}`
        : text;
      body = JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user',   content: userContent },
        ],
        stream:      false,
        max_tokens:  opts.maxTokens   ?? 40,
        temperature: opts.temperature ?? 0.4,
      });
    }

    const { response: resp } = await rateLimiter.withRateLimit(
      providerName,
      () => fetch(url, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(provider.api_key ? { Authorization: `Bearer ${provider.api_key}` } : {}),
        },
        body,
        signal: ac.signal,
      }),
      { signal: ac.signal },
    );
    clearTimeout(timer);
    if (!resp.ok) {
      const errBody = await resp.text().catch(() => '');
      console.warn(`[autocomplete] ${resp.status} from ${url} (model=${model}): ${errBody.slice(0, 200)}`);
      return null;
    }
    const json: any = await resp.json();
    try {
      const usage = json?.usage;
      if (usage) {
        const inTok  = usage.prompt_tokens    || 0;
        const outTok = usage.completion_tokens || 0;
        if (inTok || outTok) {
          const { recordTokens }    = require('../observability-plus/tokens');
          const { recordCost }      = require('../observability-plus/costs');
          const { getModelPricing } = require('../../models/config');
          recordTokens({ inputTokens: inTok, outputTokens: outTok, model, provider: providerName });
          const pricing = getModelPricing(model);
          if (pricing) {
            const cost = (inTok / 1_000_000) * (pricing.price_input || 0) +
                         (outTok / 1_000_000) * (pricing.price_output || 0);
            if (cost > 0) recordCost(cost, model, providerName);
          }
        }
      }
    } catch (e: any) {
      // Rate-limited warning: token+cost recording is observability, not
      // business-critical, but a permanent outage would silently under-count
      // autocomplete spend. Surface at most once every 60 s per process.
      _maybeWarnTokenRecord(e);
    }
    // Completions endpoint returns choices[0].text; chat returns choices[0].message.content.
    const raw: string = useCompletions
      ? (json?.choices?.[0]?.text ?? '')
      : (json?.choices?.[0]?.message?.content ?? '');
    if (!raw) {
      // Empty body — most common on NVIDIA free tier when the model queued past the
      // 6 s timeout (request was aborted before the model responded). Switch to a
      // smaller/faster model (e.g. nvidia/nemotron-mini-4b-instruct) to fix this.
      console.warn(`[autocomplete] empty body from ${model}:`, JSON.stringify(json).slice(0, 300));
    }
    const cleaned = _sanitiseSuggestion(raw);
    if (!cleaned) return null;
    // If the model ignored "don't repeat" and echoed the prefix, strip it.
    if (cleaned.startsWith(text)) {
      const rest = cleaned.slice(text.length);
      return rest.trim() ? rest : null;
    }
    return cleaned;
  } catch (err: unknown) {
    clearTimeout(timer);
    const msg = err instanceof Error ? err.message : String(err);
    // Abort = timeout or caller cancelled. Log timeouts so the user knows which
    // model is too slow for the 6 s window (common on NVIDIA free tier).
    if (msg.includes('autocomplete-timeout') || msg.includes('abort')) {
      console.warn(`[autocomplete] request timed out / aborted for model=${model} — free-tier queue lag? Switch to a faster model.`);
    }
    return null;
  }
}

module.exports = { _complete, _sanitiseSuggestion };
