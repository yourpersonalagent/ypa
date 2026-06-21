// ── Direct token streaming for external (non-Claude) + Anthropic models ───────
'use strict';

const { config } = require('../core/state');
const { getSessionCwd, getHistory, pushHistory, getHistoryForEmployee } = require('../sessions-internal');

function _historyFor(opts, sessionId, historySessionId) {
  return opts?.selfEmpId
    ? getHistoryForEmployee(sessionId, opts.selfEmpId)
    : getHistory(historySessionId);
}
const { findProvider } = require('../providers');
const { getModelPricing } = require('../models');
const {
  PROVIDER_MAX_TOKENS,
  getContextLimit,
  trimMessagesToFit,
} = require('../chat/translation');
const { logRaw } = require('../observability/raw-logs');
const { BridgeInputError, BridgeProviderError, BridgeConfigError } = require('../core/errors');
const { getBridgeToolDefs, getGeminiToolDefs, addCwdToPreset } = require('./defs');
const { executeBridgeTool } = require('./exec');
const { drainBtw, formatBtwInjection } = require('../chat/btw-queue');

// ── Tool-result size knobs ────────────────────────────────────────────────────
// Single source of truth for the two limits applied to every tool result:
//   - preview: short string echoed to the UI via `toolResult.content`
//   - body:    truncation cap on what we feed back to the model as tool output
// Both are config-driven so a deployment can tune them without editing code.
function _previewLimit(): number {
  return Number(config.defaults?.tool_preview_limit ?? 200);
}
function _bodyLimit(): number {
  return Number(config.defaults?.tool_result_limit ?? 8000);
}

// ── Tool-call monitoring ──────────────────────────────────────────────────────
// Per-user (Q16) — routed via bridge/core/paths.ts.
const _monFs = require('fs');
const _monLogBase = require('../core/paths').monitoringLogDir;
let _monLogWarned = false;

function _logToolCall(entry) {
  try {
    _monFs.mkdirSync(_monLogBase, { recursive: true });
    const d = new Date();
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    _monFs.appendFileSync(
      require('path').join(_monLogBase, `${key}.ndjson`),
      JSON.stringify({ ts: d.toISOString(), source: 'tool', ...entry }) + '\n',
    );
  } catch (err: any) {
    // Warn once per process — silent failure here means lost tool telemetry
    // (full disk, permission error, read-only mount). After the first warning
    // we go quiet to avoid spamming logs on every tool call.
    if (!_monLogWarned) {
      _monLogWarned = true;
      try {
        require('../core/logger').warn('monitoring-log.write-failed', {
          dir: _monLogBase,
          error: err?.message || String(err),
        });
      } catch (_) {}
    }
  }
}

async function _execAndLog(toolName, toolInput, cwd, modelId, sessionId) {
  const t0 = Date.now();
  const mcpServer = toolName.startsWith('mcp__') ? toolName.split('__')[1] : null;
  const inputBytes = JSON.stringify(toolInput).length;
  try {
    const result = await executeBridgeTool(toolName, toolInput, cwd, modelId);
    _logToolCall({ toolName, mcpServer, modelId, sessionId, durationMs: Date.now() - t0, inputBytes, success: true });
    return result;
  } catch (e) {
    _logToolCall({ toolName, mcpServer, modelId, sessionId, durationMs: Date.now() - t0, inputBytes, success: false, error: e instanceof Error ? e.message : String(e) });
    throw e;
  }
}

// ── #btw mid-response injection ──────────────────────────────────────────────
// Plan: each direct tool-loop (OpenAI-compat, Anthropic, Gemini) calls this
// helper AFTER the tool-result roundtrip and BEFORE the next API call. If the
// user dropped a `#btw <text>` into POST /v1/sessions/:id/btw while we were
// streaming, drainBtw() returns it and we append it to the messages array as
// a synthetic user message so the model sees it on the next turn.
//
// Limits: only fires between tool calls. Pure text responses (no tools) won't
// see mid-stream injection — the queue persists and the next /v1/stream/
// request will pick it up via history.
//
// Harness paths (Claude Agent SDK in server-claude-agent.ts and Codex CLI in
// providers/codex.ts) cannot inject into a running session yet. They
// also drain the queue but only at start-of-turn — see TODOs there.


// ── Tool result coercion ──────────────────────────────────────────────────────
// executeBridgeTool may return a string OR an array of Anthropic content blocks
// (when the underlying MCP tool emits image data). Helpers below adapt that to
// the shape each provider expects.
function _toolResultIsBlocks(result) {
  return Array.isArray(result) && result.every((b) => b && typeof b === 'object' && b.type);
}
function _toolResultToText(result) {
  if (_toolResultIsBlocks(result)) {
    const parts = result.map((b) => {
      if (b.type === 'text') return b.text || '';
      if (b.type === 'image') return '[image omitted — provider does not support inline images in tool results]';
      return JSON.stringify(b);
    });
    return parts.join('\n');
  }
  return String(result);
}
function _toolResultPreview(result, limit) {
  return _toolResultToText(result).slice(0, limit);
}

// ── Shared stream helpers ─────────────────────────────────────────────────────
async function _fetchWithAbort(url, options, signal, timeoutMs = 120_000) {
  const ac = new AbortController();
  const onExternalAbort = () => ac.abort(new Error('stopped'));
  if (signal) signal.addEventListener('abort', onExternalAbort, { once: true });
  const timer = setTimeout(() => ac.abort(new Error('stream timeout')), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: ac.signal });
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onExternalAbort);
  }
}

async function _consumeSSE(reader, onChunk) {
  const dec = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let chunk;
        try {
          chunk = JSON.parse(payload);
        } catch (_) {
          continue;
        }
        onChunk(chunk);
      }
    }
  } finally {
    reader.cancel().catch(() => {});
  }
}

function _calcCost(modelId, inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0) {
  const pricing = getModelPricing(modelId);
  if (!pricing) return 0;
  const pIn = pricing.price_input || 0;
  return (inputTokens / 1_000_000) * pIn +
    (outputTokens / 1_000_000) * (pricing.price_output || 0) +
    (cacheReadTokens / 1_000_000) * (pricing.price_cache_read ?? pIn * 0.1) +
    (cacheWriteTokens / 1_000_000) * (pricing.price_cache_write ?? pIn * 1.25);
}

// ── Direct streaming for external (non-Claude) models ────────────────────────
// Both functions write YHA chunk format: {text,delta}, {reasoning}, {toolUse}, {toolResult}
async function streamDirectOpenAI(
  input,
  modelId,
  preset,
  sessionId,
  imageBlocks,
  send,
  signal,
  caps: any = {},
  opts: any = {}
) {
  const found = findProvider(modelId, opts.providerName || undefined);
  if (!found) throw new BridgeInputError(`Unknown model: ${modelId}`, { modelId });
  const { provider } = found;
  const historySessionId = String(opts.historySessionId || sessionId);

  const messages = [];
  const effectivePreset = addCwdToPreset(preset, getSessionCwd(sessionId));
  if (effectivePreset) messages.push({ role: 'system', content: effectivePreset });
  for (const h of _historyFor(opts, sessionId, historySessionId)) messages.push({ role: h.role, content: h.content });

  // Build user content: plain string, or multipart array when images are present
  let userContent;
  if (imageBlocks.length) {
    userContent = [];
    if (input.trim()) userContent.push({ type: 'text', text: input });
    for (const img of imageBlocks) {
      userContent.push({
        type: 'image_url',
        image_url: {
          url: `data:${img.source.media_type};base64,${img.source.data}`,
        },
      });
    }
  } else {
    userContent = input;
  }
  messages.push({ role: 'user', content: userContent });

  const cap = PROVIDER_MAX_TOKENS[provider.name];
  const ctxLimit = getContextLimit(modelId);
  const headers = { 'Content-Type': 'application/json' };
  if (provider.api_key) headers['Authorization'] = `Bearer ${provider.api_key}`;
  const url = provider.endpoint.replace(/\/$/, '') + '/chat/completions';

  let fullText = '';
  let totalInputTokens = 0,
    totalOutputTokens = 0,
    totalCacheReadTokens = 0,
    totalCacheCreationTokens = 0;
  let totalToolCalls = 0;
  const MAX_ITER = config.defaults?.tool_max_iter ?? 8;

  for (let iter = 0; iter < MAX_ITER; iter++) {
    if (signal?.aborted) throw new Error('stopped');
    const maxTok = cap || 4096;
    const defs = getBridgeToolDefs();
    const trimmedMsgs = trimMessagesToFit(messages, defs, ctxLimit, maxTok);
    const useTools = caps.tools !== false && defs.length > 0;
    const thinkingParam =
      caps.reasoning === 'enabled' || caps.reasoning === true
        ? { thinking: { type: 'enabled' } }
        : caps.reasoning === 'disabled'
          ? { thinking: { type: 'disabled' } }
          : {};
    const body = {
      model: modelId,
      messages: trimmedMsgs,
      stream: true,
      max_tokens: maxTok,
      stream_options: { include_usage: true },
      ...(useTools ? { tools: defs, tool_choice: 'auto' } : {}),
      ...thinkingParam,
    };
    logRaw('model', 'in', body, { provider: provider.name, modelId, phase: 'stream-openai' });

    const upstream = await _fetchWithAbort(
      url,
      { method: 'POST', headers, body: JSON.stringify(body) },
      signal
    );
    if (!upstream.ok) {
      const t = await upstream.text().catch(() => '');
      throw new BridgeProviderError(`${upstream.status}: ${t.slice(0, 400)}`, 502, { upstreamStatus: upstream.status });
    }

    let assistantText = '';
    let lastFinishReason = '';
    let streamError = null;
    const toolCalls = new Map(); // index → {id, name, arguments}

    await _consumeSSE(upstream.body.getReader(), (chunk) => {
      logRaw('model', 'out', chunk, {
        provider: provider.name,
        modelId,
        phase: 'stream-openai-sse',
      });
      // OpenRouter (and some providers) embed errors inside the SSE stream
      if (chunk.error) {
        const msg = chunk.error.message || JSON.stringify(chunk.error);
        const code = chunk.error.code ? ` [${chunk.error.code}]` : '';
        streamError = `${msg}${code}`;
        return;
      }
      if (chunk.usage) {
        // OpenAI / OpenRouter return prompt_tokens as the GROSS total (including any cached
        // tokens). Subtract the cached portion so inputTokens is NET (matching Anthropic's
        // convention) — otherwise input + cacheRead double-counts the cached slice.
        const cached = chunk.usage.prompt_tokens_details?.cached_tokens || 0;
        totalInputTokens += (chunk.usage.prompt_tokens || 0) - cached;
        totalOutputTokens += chunk.usage.completion_tokens || 0;
        totalCacheReadTokens += cached;
      }
      const choice = chunk.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) lastFinishReason = choice.finish_reason;
      const delta = choice.delta;
      if (!delta) return;
      if (delta.reasoning_content) {
        try {
          send({ reasoning: delta.reasoning_content });
        } catch (_) {}
      }
      if (delta.content) {
        assistantText += delta.content;
        fullText += delta.content;
        try {
          send({ text: delta.content, delta: delta.content });
        } catch (_) {}
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          if (!toolCalls.has(idx)) toolCalls.set(idx, { id: '', name: '', arguments: '' });
          const acc = toolCalls.get(idx);
          if (tc.id) acc.id += tc.id;
          if (tc.function?.name) acc.name += tc.function.name;
          if (tc.function?.arguments) acc.arguments += tc.function.arguments;
        }
      }
    });

    // Surface stream-level errors (OpenRouter embeds these in the SSE body)
    if (streamError && !assistantText && !toolCalls.size) {
      throw new BridgeProviderError(streamError);
    }

    if (!toolCalls.size) {
      // No tool calls — this is the final turn. Surface empty responses with context.
      if (!assistantText && !fullText) {
        const hint =
          lastFinishReason && lastFinishReason !== 'stop'
            ? `finish_reason: "${lastFinishReason}"`
            : streamError
              ? streamError
              : 'the model returned an empty response';
        throw new BridgeProviderError(
          `No content received from ${modelId} — ${hint}. The model may not support tool use, may be rate-limited (free tier), or the request was filtered.`,
          502,
          { modelId, hint }
        );
      }
      break;
    }

    const sortedTools = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]);
    totalToolCalls += sortedTools.length;
    // Mint a stable id per tool call ONCE, then reuse it for the assistant
    // turn's tool_calls[].id, the tool-result message's tool_call_id, and the
    // toolUse/toolResult chunks sent to the FE. OpenAI requires the assistant
    // id and the matching tool message's tool_call_id to be byte-identical;
    // the old code fell back to `tc_${Date.now()}` independently in each place,
    // so an id-less call could mismatch (API rejects the tool turn) and two
    // id-less calls in the same ms could collide. Mirrors the Gemini synthId
    // fix. tc objects live only in this turn's Map, so mutating .id is scoped.
    for (const [idx, tc] of sortedTools) {
      if (!tc.id) tc.id = `tc_${iter}.${idx}`;
    }
    messages.push({
      role: 'assistant',
      content: assistantText || null,
      tool_calls: sortedTools.map(([, tc]) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments },
      })),
    });

    const toolMessages = await Promise.all(
      sortedTools.map(async ([, tc]) => {
        let toolInput = {};
        try {
          toolInput = JSON.parse(tc.arguments || '{}');
        } catch (_) {}
        try {
          send({ toolUse: { id: tc.id, name: tc.name, input: toolInput } });
        } catch (_) {}
        let resultStr: string;
        try {
          const result = await _execAndLog(tc.name, toolInput, getSessionCwd(sessionId), modelId, sessionId);
          resultStr = _toolResultToText(result);
          try {
            send({
              toolResult: {
                id: tc.id,
                content: _toolResultPreview(result, _previewLimit()),
              },
            });
          } catch (_) {}
        } catch (toolErr) {
          resultStr = `[tool error] ${toolErr instanceof Error ? toolErr.message : String(toolErr)}`;
          try { send({ toolResult: { id: tc.id, content: resultStr.slice(0, _previewLimit()) } }); } catch (_) {}
        }
        return {
          role: 'tool',
          tool_call_id: tc.id,
          content: resultStr.slice(0, _bodyLimit()),
        };
      })
    );
    messages.push(...toolMessages);

    // #btw injection point — see top of file for plan
    const btw = drainBtw(sessionId);
    if (btw.length) {
      const injected = formatBtwInjection(btw);
      messages.push({ role: 'user', content: injected });
      try { send({ btwInjected: { items: btw } }); } catch (_) {}
    }
  }

  pushHistory(historySessionId, 'user', input);
  pushHistory(historySessionId, 'assistant', fullText);
  return {
    text: fullText,
    cost: _calcCost(modelId, totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheCreationTokens),
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheReadTokens: totalCacheReadTokens,
    cacheCreationTokens: totalCacheCreationTokens,
    toolCallCount: totalToolCalls,
  };
}

async function streamDirectGemini(
  input,
  modelId,
  preset,
  sessionId,
  imageBlocks,
  send,
  signal,
  caps: any = {},
  opts: any = {}
) {
  const found = findProvider(modelId, opts.providerName || undefined);
  if (!found) throw new BridgeInputError(`Unknown model: ${modelId}`, { modelId });
  const { provider } = found;
  const historySessionId = String(opts.historySessionId || sessionId);

  const contents = [];
  for (const h of _historyFor(opts, sessionId, historySessionId)) {
    contents.push({
      role: h.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: h.content }],
    });
  }
  const userParts = [];
  for (const img of imageBlocks) {
    if (img.source?.type === 'base64')
      userParts.push({ inlineData: { mimeType: img.source.media_type, data: img.source.data } });
  }
  if (input.trim()) userParts.push({ text: input });
  contents.push({ role: 'user', parts: userParts });

  const baseUrl = provider.endpoint.replace(/\/$/, '');
  let fullText = '';
  let totalInputTokens = 0,
    totalOutputTokens = 0,
    totalCacheReadTokens = 0;
  let totalToolCalls = 0;
  const MAX_ITER = config.defaults?.tool_max_iter ?? 8;

  for (let iter = 0; iter < MAX_ITER; iter++) {
    if (signal?.aborted) throw new Error('stopped');
    const gemBody: any = {
      contents,
      ...(caps.tools !== false ? { tools: getGeminiToolDefs() } : {}),
    };
    const effectiveGeminiPreset = addCwdToPreset(preset, getSessionCwd(sessionId));
    if (effectiveGeminiPreset)
      gemBody.systemInstruction = { parts: [{ text: effectiveGeminiPreset }] };
    logRaw('model', 'in', gemBody, { provider: 'gemini', modelId, phase: 'stream-gemini' });

    const url = `${baseUrl}/models/${modelId}:streamGenerateContent?key=${provider.api_key}&alt=sse`;
    const upstream = await _fetchWithAbort(
      url,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(gemBody),
      },
      signal
    );
    if (!upstream.ok) {
      const t = await upstream.text().catch(() => '');
      throw new BridgeProviderError(`Gemini ${upstream.status}: ${t.slice(0, 400)}`, 502, { upstreamStatus: upstream.status });
    }

    let assistantText = '';
    const fnCalls = [];

    await _consumeSSE(upstream.body.getReader(), (chunk) => {
      logRaw('model', 'out', chunk, { provider: 'gemini', modelId, phase: 'stream-gemini-sse' });
      if (chunk.usageMetadata) {
        totalInputTokens = chunk.usageMetadata.promptTokenCount || totalInputTokens;
        totalOutputTokens = chunk.usageMetadata.candidatesTokenCount || totalOutputTokens;
        // Gemini's implicit context cache hit count
        totalCacheReadTokens = chunk.usageMetadata.cachedContentTokenCount || totalCacheReadTokens;
      }
      for (const p of chunk.candidates?.[0]?.content?.parts ?? []) {
        if (p.text && !p.thought) {
          assistantText += p.text;
          fullText += p.text;
          try {
            send({ text: p.text, delta: p.text });
          } catch (_) {}
        }
        if (p.functionCall) {
          fnCalls.push({
            ...p.functionCall,
            _geminiThoughtSignature: p.thoughtSignature || '',
          });
        }
      }
    });

    if (!fnCalls.length) break;
    totalToolCalls += fnCalls.length;

    contents.push({
      role: 'model',
      parts: fnCalls.map((f) => {
        const { _geminiThoughtSignature, ...functionCall } = f;
        const part: any = { functionCall };
        if (_geminiThoughtSignature) part.thoughtSignature = _geminiThoughtSignature;
        return part;
      }),
    });

    // BUGFIX 2026-04-30: Gemini's functionCall has no id field, so previously
    // we sent `id: fn.name` — meaning two parallel calls to the same tool
    // (e.g. two WebSearch calls) collided in the frontend's tool-id map and
    // results got attributed to the wrong call. Mint a synthetic per-iter
    // unique id `${name}#${counter}` and use it consistently for toolUse +
    // toolResult chunks so the frontend can pair them deterministically.
    const funcResults = await Promise.all(
      fnCalls.map(async (fn, idx) => {
        const synthId = `${fn.name}#${iter}.${idx}`;
        try {
          send({ toolUse: { id: synthId, name: fn.name, input: fn.args } });
        } catch (_) {}
        let resultStr: string;
        try {
          const result = await _execAndLog(fn.name, fn.args || {}, getSessionCwd(sessionId), modelId, sessionId);
          resultStr = _toolResultToText(result);
          try {
            send({
              toolResult: {
                id: synthId,
                content: _toolResultPreview(result, _previewLimit()),
              },
            });
          } catch (_) {}
        } catch (toolErr) {
          resultStr = `[tool error] ${toolErr instanceof Error ? toolErr.message : String(toolErr)}`;
          try { send({ toolResult: { id: synthId, content: resultStr.slice(0, _previewLimit()) } }); } catch (_) {}
        }
        return {
          functionResponse: {
            name: fn.name,
            response: { result: resultStr.slice(0, _bodyLimit()) },
          },
        };
      })
    );
    contents.push({ role: 'user', parts: funcResults });

    // #btw injection point — see top of file for plan
    const btw = drainBtw(sessionId);
    if (btw.length) {
      const injected = formatBtwInjection(btw);
      contents.push({ role: 'user', parts: [{ text: injected }] });
      try { send({ btwInjected: { items: btw } }); } catch (_) {}
    }
  }

  pushHistory(historySessionId, 'user', input);
  pushHistory(historySessionId, 'assistant', fullText);
  return {
    text: fullText,
    cost: _calcCost(modelId, totalInputTokens, totalOutputTokens, totalCacheReadTokens, 0),
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheReadTokens: totalCacheReadTokens,
    cacheCreationTokens: 0,
    toolCallCount: totalToolCalls,
  };
}

// ── Direct streaming for Anthropic API (non-subscription Claude models) ───────
// Bypasses the Claude binary for true token-by-token SSE streaming.
// Same YHA chunk format as streamDirectOpenAI / streamDirectGemini.
async function streamDirectAnthropic(
  input,
  modelId,
  preset,
  sessionId,
  imageBlocks,
  send,
  signal,
  caps: any = {},
  opts: any = {}
) {
  const ap = config.providers.find((p) => p.name === 'Anthropic');
  if (!ap?.api_key) throw new BridgeConfigError('No Anthropic API key configured');
  const ENDPOINT =
    (ap.endpoint || 'https://api.anthropic.com').replace(/\/v1\/?$/, '').replace(/\/$/, '') +
    '/v1/messages';
  const historySessionId = String(opts.historySessionId || sessionId);

  // Map effort → thinking budget_tokens
  const EFFORT_BUDGET = { low: 2000, medium: 5000, high: 10000, xhigh: 16000, max: 32000 };
  const useThinking = caps.reasoning === 'enabled' || caps.reasoning === true;
  const budgetTokens = useThinking ? EFFORT_BUDGET[caps.effort] || 8000 : 0;
  const maxTokens = useThinking ? Math.max(16384, budgetTokens + 8192) : 16384;

  // Build message history — Anthropic uses 'user'/'assistant' roles only
  const messages = [];
  for (const h of _historyFor(opts, sessionId, historySessionId)) {
    messages.push({ role: h.role === 'assistant' ? 'assistant' : 'user', content: h.content });
  }

  // User content: text + optional base64 images (Anthropic format)
  let userContent;
  if (imageBlocks.length) {
    userContent = [];
    if (input.trim()) userContent.push({ type: 'text', text: input });
    for (const img of imageBlocks) userContent.push(img); // source.type/media_type/data matches
  } else {
    userContent = input;
  }
  messages.push({ role: 'user', content: userContent });

  // Convert bridge tool defs from OpenAI format → Anthropic format
  const defs = getBridgeToolDefs();
  const useTools = caps.tools !== false && defs.length > 0;
  const anthropicTools = useTools
    ? defs.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }))
    : [];

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': ap.api_key,
    'anthropic-version': '2023-06-01',
    ...(useThinking ? { 'anthropic-beta': 'interleaved-thinking-2025-05-14' } : {}),
  };

  let fullText = '';
  let totalInputTokens = 0,
    totalOutputTokens = 0,
    totalCacheCreationTokens = 0,
    totalCacheReadTokens = 0;
  let totalToolCalls = 0;
  const MAX_ITER = config.defaults?.tool_max_iter ?? 8;
  const cwd = getSessionCwd(sessionId);
  const effectiveAnthropicPreset = addCwdToPreset(preset, cwd);

  for (let iter = 0; iter < MAX_ITER; iter++) {
    if (signal?.aborted) throw new Error('stopped');

    const trimmedMsgs = trimMessagesToFit(messages, anthropicTools, 200_000, maxTokens);
    const body = {
      model: modelId,
      max_tokens: maxTokens,
      messages: trimmedMsgs,
      stream: true,
      ...(effectiveAnthropicPreset ? { system: effectiveAnthropicPreset } : {}),
      ...(useThinking ? { thinking: { type: 'enabled', budget_tokens: budgetTokens } } : {}),
      ...(anthropicTools.length ? { tools: anthropicTools, tool_choice: { type: 'auto' } } : {}),
    };
    logRaw('model', 'in', body, { provider: 'anthropic', modelId, phase: 'stream-anthropic' });

    const upstream = await _fetchWithAbort(
      ENDPOINT,
      { method: 'POST', headers, body: JSON.stringify(body) },
      signal,
      300_000
    );
    if (!upstream.ok) {
      const t = await upstream.text().catch(() => '');
      throw new BridgeProviderError(`Anthropic ${upstream.status}: ${t.slice(0, 400)}`, 502, { upstreamStatus: upstream.status });
    }

    // Parse Anthropic-compatible SSE — data lines carry JSON events with a
    // 'type' field. Some provider adapters attach provider-private metadata to
    // content_block_start; preserve known fields needed for subsequent turns.
    // index → { type, content, input, signature, id, name, _parsedInput, ... }
    const contentBlocks = new Map();
    const toolUseBlocks = []; // completed tool_use blocks (in order of completion)
    let stopReason = 'end_turn';
    let sseError = null;

    await _consumeSSE(upstream.body.getReader(), (ev) => {
      logRaw('model', 'out', ev, { provider: 'anthropic', modelId, phase: 'stream-anthropic-sse' });
      if (ev.type === 'message_start') {
        totalInputTokens += ev.message?.usage?.input_tokens || 0;
        // Anthropic exposes cache breakdown in usage. cache_creation_input_tokens
        // are billed at 1.25× input; cache_read_input_tokens at 0.1× — visible
        // breakdown matters because heavy reuse can flatten cost while keeping
        // token counts huge.
        totalCacheCreationTokens += ev.message?.usage?.cache_creation_input_tokens || 0;
        totalCacheReadTokens += ev.message?.usage?.cache_read_input_tokens || 0;
      } else if (ev.type === 'content_block_start') {
        const cb = ev.content_block;
        contentBlocks.set(ev.index, {
          type: cb.type,
          content: '',
          input: '',
          signature: '',
          id: cb.id || '',
          name: cb.name || '',
          _geminiThoughtSignature: cb._geminiThoughtSignature || '',
          _geminiThoughts: Array.isArray(cb._geminiThoughts) ? cb._geminiThoughts : undefined,
        });
      } else if (ev.type === 'content_block_delta') {
        const cb = contentBlocks.get(ev.index);
        if (!cb) return;
        const d = ev.delta;
        if (d.type === 'thinking_delta') {
          cb.content += d.thinking;
          try {
            send({ reasoning: d.thinking });
          } catch (_) {}
        } else if (d.type === 'text_delta') {
          cb.content += d.text;
          fullText += d.text;
          try {
            send({ text: d.text, delta: d.text });
          } catch (_) {}
        } else if (d.type === 'input_json_delta') {
          cb.input += d.partial_json;
        } else if (d.type === 'signature_delta') {
          cb.signature += d.signature; // needed to preserve thinking blocks across turns
        }
      } else if (ev.type === 'content_block_stop') {
        const cb = contentBlocks.get(ev.index);
        if (cb?.type === 'tool_use') {
          let parsedInput = {};
          try {
            parsedInput = JSON.parse(cb.input || '{}');
          } catch (_) {}
          cb._parsedInput = parsedInput;
          toolUseBlocks.push({
            index: ev.index,
            id: cb.id,
            name: cb.name,
            input: parsedInput,
            _geminiThoughtSignature: cb._geminiThoughtSignature || '',
            _geminiThoughts: cb._geminiThoughts,
          });
          try {
            send({ toolUse: { id: cb.id, name: cb.name, input: parsedInput } });
          } catch (_) {}
        }
      } else if (ev.type === 'message_delta') {
        totalOutputTokens += ev.usage?.output_tokens || 0;
        stopReason = ev.delta?.stop_reason || stopReason;
      } else if (ev.type === 'error') {
        sseError = `Anthropic API error: ${ev.error?.message || ev.error?.type || JSON.stringify(ev.error)}`;
      }
    });
    if (sseError) throw new BridgeProviderError(sseError);

    if (!toolUseBlocks.length) break;
    totalToolCalls += toolUseBlocks.length;

    // Build assistant turn with all blocks in order (thinking + text + tool_use)
    const assistantContent = [];
    for (const [, cb] of [...contentBlocks.entries()].sort((a, b) => a[0] - b[0])) {
      if (cb.type === 'thinking' && (cb.content || cb.signature)) {
        assistantContent.push({ type: 'thinking', thinking: cb.content, signature: cb.signature });
      } else if (cb.type === 'text' && cb.content) {
        assistantContent.push({ type: 'text', text: cb.content });
      } else if (cb.type === 'tool_use') {
        const block: any = {
          type: 'tool_use',
          id: cb.id,
          name: cb.name,
          input: cb._parsedInput || {},
        };
        if (cb._geminiThoughtSignature) block._geminiThoughtSignature = cb._geminiThoughtSignature;
        if (Array.isArray(cb._geminiThoughts)) block._geminiThoughts = cb._geminiThoughts;
        assistantContent.push(block);
      }
    }
    messages.push({ role: 'assistant', content: assistantContent });

    // Execute tools and build user tool_result message
    const toolResults = await Promise.all(
      toolUseBlocks.map(async (tc) => {
        let result: any;
        let toolErr: Error | null = null;
        try {
          result = await _execAndLog(tc.name, tc.input, cwd, modelId, sessionId);
        } catch (e) {
          toolErr = e instanceof Error ? e : new Error(String(e));
        }
        if (toolErr) {
          const errContent = `[tool error] ${toolErr.message}`;
          try { send({ toolResult: { id: tc.id, content: errContent.slice(0, _previewLimit()) } }); } catch (_) {}
          return {
            type: 'tool_result',
            tool_use_id: tc.id,
            content: errContent.slice(0, _bodyLimit()),
          };
        }
        try {
          send({
            toolResult: {
              id: tc.id,
              content: _toolResultPreview(result, _previewLimit()),
            },
          });
        } catch (_) {}
        // Anthropic accepts either a string or an array of content blocks
        // (text + image). Pass through structured blocks so Claude can see
        // images returned by MCP tools (e.g. screenshot_view).
        if (_toolResultIsBlocks(result)) {
          return { type: 'tool_result', tool_use_id: tc.id, content: result };
        }
        return {
          type: 'tool_result',
          tool_use_id: tc.id,
          content: String(result).slice(0, _bodyLimit()),
        };
      })
    );
    messages.push({ role: 'user', content: toolResults });

    // #btw injection point — see top of file for plan
    const btw = drainBtw(sessionId);
    if (btw.length) {
      const injected = formatBtwInjection(btw);
      messages.push({ role: 'user', content: injected });
      try { send({ btwInjected: { items: btw } }); } catch (_) {}
    }
  }

  pushHistory(historySessionId, 'user', input);
  pushHistory(historySessionId, 'assistant', fullText);
  return {
    text: fullText,
    cost: _calcCost(modelId, totalInputTokens, totalOutputTokens, totalCacheReadTokens, totalCacheCreationTokens),
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    cacheCreationTokens: totalCacheCreationTokens,
    cacheReadTokens: totalCacheReadTokens,
    toolCallCount: totalToolCalls,
  };
}

module.exports = {
  streamDirectOpenAI,
  streamDirectGemini,
  streamDirectAnthropic,
};
