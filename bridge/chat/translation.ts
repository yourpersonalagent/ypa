// ── Anthropic ↔ Provider proxy translation + context-length management ─────────
'use strict';

const { config } = require('../core/state');
const { isGeminiModel, findProvider } = require('../providers');
const { getModelPricing } = require('../models');
const { logRaw } = require('../observability/raw-logs');
const logger = require('../core/logger');
const { BridgeProviderError } = require('../core/errors');

// ── Anthropic → OpenAI message translation ────────────────────────────────────
function anthropicToOpenAI(body, targetModelId): any {
  const messages: any[] = [];

  if (body.system) {
    const txt =
      typeof body.system === 'string'
        ? body.system
        : Array.isArray(body.system)
          ? body.system
              .filter((b) => b.type === 'text')
              .map((b) => b.text)
              .join('\n')
          : '';
    if (txt) messages.push({ role: 'system', content: txt });
  }

  for (const msg of body.messages || []) {
    const { role, content } = msg;
    if (role === 'user') {
      if (typeof content === 'string') {
        messages.push({ role: 'user', content });
      } else if (Array.isArray(content)) {
        const toolResults = content.filter((b) => b.type === 'tool_result');
        const textBlocks = content.filter((b) => b.type === 'text');
        const imgBlocks = content.filter((b) => b.type === 'image');
        for (const tr of toolResults) {
          const c = Array.isArray(tr.content)
            ? tr.content
                .filter((b) => b.type === 'text')
                .map((b) => b.text)
                .join('\n')
            : String(tr.content ?? '');
          messages.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: c || '(empty)' });
        }
        if (textBlocks.length || imgBlocks.length) {
          if (!imgBlocks.length) {
            messages.push({ role: 'user', content: textBlocks.map((b) => b.text).join('') });
          } else {
            const parts: any[] = [];
            for (const img of imgBlocks) {
              if (img.source?.type === 'base64') {
                parts.push({
                  type: 'image_url',
                  image_url: {
                    url: `data:${img.source.media_type};base64,${img.source.data}`,
                    detail: 'auto',
                  },
                });
              } else if (img.source?.type === 'url') {
                parts.push({ type: 'image_url', image_url: { url: img.source.url } });
              }
            }
            if (textBlocks.length)
              parts.push({ type: 'text', text: textBlocks.map((b) => b.text).join('') });
            messages.push({ role: 'user', content: parts });
          }
        }
      }
    } else if (role === 'assistant') {
      if (typeof content === 'string') {
        messages.push({ role: 'assistant', content });
      } else if (Array.isArray(content)) {
        const textBlocks = content.filter((b) => b.type === 'text');
        const toolUseBlocks = content.filter((b) => b.type === 'tool_use');
        const thinkingBlocks = content.filter((b) => b.type === 'thinking');
        if (toolUseBlocks.length) {
          const msg: any = {
            role: 'assistant',
            content: textBlocks.length ? textBlocks.map((b) => b.text).join('') : null,
            tool_calls: toolUseBlocks.map((b) => ({
              id: b.id,
              type: 'function',
              function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
            })),
          };
          if (thinkingBlocks.length)
            msg.reasoning_content = thinkingBlocks.map((b) => b.thinking).join('');
          messages.push(msg);
        } else {
          const msg: any = { role: 'assistant', content: textBlocks.map((b) => b.text).join('') };
          if (thinkingBlocks.length)
            msg.reasoning_content = thinkingBlocks.map((b) => b.thinking).join('');
          messages.push(msg);
        }
      }
    }
  }

  const tools = (body.tools || []).map((t) => ({
    type: 'function',
    function: {
      name: t.name,
      description: t.description || '',
      parameters: t.input_schema || { type: 'object', properties: {} },
    },
  }));

  const out: any = { model: targetModelId, messages, stream: false };
  if (tools.length) {
    out.tools = tools;
    out.tool_choice = 'auto';
  }
  if (body.max_tokens) out.max_tokens = body.max_tokens;
  if (body.temperature !== undefined) out.temperature = body.temperature;
  return out;
}

function openAIRespToAnthropic(data, modelId) {
  const choice = data.choices?.[0];
  if (!choice) throw new BridgeProviderError('No choices in OpenAI response');
  const msg = choice.message;
  const content: any[] = [];
  if (msg.content) content.push({ type: 'text', text: msg.content });
  if (msg.tool_calls?.length) {
    for (const tc of msg.tool_calls) {
      let input = {};
      try {
        input = JSON.parse(tc.function.arguments || '{}');
      } catch (_) {}
      content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
    }
  }
  return {
    id: data.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: modelId,
    stop_reason: choice.finish_reason === 'tool_calls' ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: data.usage?.prompt_tokens || 0,
      output_tokens: data.usage?.completion_tokens || 0,
    },
  };
}

// Stream a complete Anthropic response object as Anthropic SSE events
function emitAnthropicSSE(res, resp) {
  const w = (ev, d) => res.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`);
  w('message_start', {
    type: 'message_start',
    message: {
      id: resp.id,
      type: 'message',
      role: 'assistant',
      content: [],
      model: resp.model,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: resp.usage?.input_tokens || 0, output_tokens: 0 },
    },
  });
  w('ping', { type: 'ping' });
  let idx = 0;
  for (const block of resp.content) {
    if (block.type === 'text') {
      w('content_block_start', {
        type: 'content_block_start',
        index: idx,
        content_block: { type: 'text', text: '' },
      });
      const CHUNK_SIZE = 200; // SSE text-delta chunk size: small enough for real-time feel, large enough to avoid per-character overhead
      for (let i = 0; i < block.text.length; i += CHUNK_SIZE)
        w('content_block_delta', {
          type: 'content_block_delta',
          index: idx,
          delta: { type: 'text_delta', text: block.text.slice(i, i + CHUNK_SIZE) },
        });
    } else if (block.type === 'tool_use') {
      w('content_block_start', {
        type: 'content_block_start',
        index: idx,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      });
      w('content_block_delta', {
        type: 'content_block_delta',
        index: idx,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input || {}) },
      });
    }
    w('content_block_stop', { type: 'content_block_stop', index: idx });
    idx++;
  }
  w('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: resp.stop_reason, stop_sequence: null },
    usage: { output_tokens: resp.usage?.output_tokens || 0 },
  });
  w('message_stop', { type: 'message_stop' });
}

// ── Context-length management ─────────────────────────────────────────────────
// Per-provider max_tokens cap (output tokens)
const PROVIDER_MAX_TOKENS = {
  DeepSeek: 8192,
  OpenAI: 16384,
  Notebook: 4096,
  Local: 4096,
  Ubuntu: 4096,
  Ubuntu2: 4096,
};

const MODEL_CONTEXT_LIMITS = {}; // modelId → maxTokens (filled dynamically)

const CONTEXT_LIMIT_PATTERNS = [
  [/^deepseek/i, 64000],
  [/^gpt-4o/i, 128000],
  [/^gpt-4-turbo/i, 128000],
  [/^gpt-4\.1/i, 1000000],
  [/^gpt-3\.5/i, 16000],
  [/^o1/i, 200000],
  [/^o3/i, 200000],
  [/^o4/i, 200000],
  [/^chatgpt-4o/i, 128000],
];

function getContextLimit(modelId) {
  if (MODEL_CONTEXT_LIMITS[modelId]) return MODEL_CONTEXT_LIMITS[modelId];
  const pricing = getModelPricing(modelId);
  if (pricing?.context_length) return pricing.context_length;
  for (const [pat, limit] of CONTEXT_LIMIT_PATTERNS) {
    if ((pat as any).test(modelId)) return limit;
  }
  return 128000;
}

// Token estimation heuristic — not exact (no tiktoken dependency), but better than char/3.
// For ASCII prose ~1 token/4 chars, for JSON ~1 token/2-3 chars, for Unicode ~1 token/1.5-2 chars.
// Tested against real tokenizers: accurate within ~20% for typical message payloads.
function estimateTokens(obj) {
  const s = typeof obj === 'string' ? obj : JSON.stringify(obj);
  if (!s) return 0;

  // Count non-ASCII characters (these tend to be multi-byte in UTF-8 and consume more tokens)
  let nonAscii = 0;
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 127) nonAscii++;
  }

  const asciiLen = s.length - nonAscii;
  // ASCII: ~1 token per 4 chars; Non-ASCII: ~1 token per 1.5 chars
  return Math.ceil(asciiLen / 4 + nonAscii / 1.5);
}

// Trim OpenAI-format messages to fit model context window
function trimMessagesToFit(messages, tools, maxContextTokens, maxOutputTokens) {
  const toolTokens = tools?.length ? estimateTokens(tools) : 0;
  const inputLimit = maxContextTokens - (maxOutputTokens || 4096) - toolTokens;
  if (estimateTokens(messages) <= inputLimit) return messages;

  let sysEnd = 0;
  while (sysEnd < messages.length && messages[sysEnd].role === 'system') sysEnd++;

  // Minimum: system messages + 2 (most recent exchange). Scales down for tiny-context models
  // instead of the old fixed 20 which could still overflow a 4096-token window.
  const minKeep = sysEnd + 2;
  const trimmed = messages.slice();
  while (trimmed.length > minKeep && estimateTokens(trimmed) > inputLimit) {
    trimmed.splice(sysEnd, 1);
    while (trimmed.length > sysEnd && trimmed[sysEnd].role === 'tool') {
      trimmed.splice(sysEnd, 1);
    }
  }
  logger.info('context.trim', { before: messages.length, after: trimmed.length, estTok: estimateTokens(trimmed), limit: inputLimit });
  return trimmed;
}

// Strip JSON-Schema fields not accepted by Gemini
const MAX_SCHEMA_DEPTH = 20;
function sanitizeGeminiSchema(schema, _depth = 0) {
  if (!schema || typeof schema !== 'object') return {};
  if (_depth > MAX_SCHEMA_DEPTH) return {}; // Guard against deeply nested / recursive schemas
  const out: Record<string, any> = {};
  if (schema.type) out.type = String(schema.type).toUpperCase();
  if (schema.description) out.description = schema.description;
  if (schema.enum) out.enum = schema.enum;
  if (schema.properties) {
    out.properties = Object.fromEntries(
      Object.entries(schema.properties).map(([k, v]) => [k, sanitizeGeminiSchema(v, _depth + 1)])
    );
  }
  if (Array.isArray(schema.required)) out.required = schema.required;
  if (schema.items) out.items = sanitizeGeminiSchema(schema.items, _depth + 1);
  return out;
}

// ── Proxy: OpenAI-compatible providers ───────────────────────────────────────
async function proxyCallOpenAI(body, modelId, provider) {
  const openAIBody = anthropicToOpenAI(body, modelId);
  const cap = PROVIDER_MAX_TOKENS[provider.name];
  if (cap && openAIBody.max_tokens > cap) openAIBody.max_tokens = cap;
  if (!openAIBody.max_tokens) openAIBody.max_tokens = cap || 4096;
  const ctxLimit = getContextLimit(modelId);
  openAIBody.messages = trimMessagesToFit(
    openAIBody.messages,
    openAIBody.tools,
    ctxLimit,
    openAIBody.max_tokens
  );

  const headers = { 'Content-Type': 'application/json' };
  if (provider.api_key) headers['Authorization'] = `Bearer ${provider.api_key}`;
  const url = provider.endpoint.replace(/\/$/, '') + '/chat/completions';
  logRaw('model', 'in', openAIBody, { provider: provider.name, modelId, phase: 'proxy-openai' });
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(openAIBody),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new BridgeProviderError(`${res.status}: ${t.slice(0, 400)}`, 502, { upstreamStatus: res.status });
  }
  const raw: any = await res.json();
  logRaw('model', 'out', raw, { provider: provider.name, modelId, phase: 'proxy-openai' });
  return openAIRespToAnthropic(raw, modelId);
}

// Real token-by-token streaming proxy for OpenAI-compatible providers
async function proxyStreamOpenAI(body, modelId, provider, res) {
  const openAIBody = anthropicToOpenAI(body, modelId);
  const cap = PROVIDER_MAX_TOKENS[provider.name];
  if (cap && openAIBody.max_tokens > cap) openAIBody.max_tokens = cap;
  if (!openAIBody.max_tokens) openAIBody.max_tokens = cap || 4096;
  const ctxLimit = getContextLimit(modelId);
  openAIBody.messages = trimMessagesToFit(
    openAIBody.messages,
    openAIBody.tools,
    ctxLimit,
    openAIBody.max_tokens
  );
  openAIBody.stream = true;

  const headers = { 'Content-Type': 'application/json' };
  if (provider.api_key) headers['Authorization'] = `Bearer ${provider.api_key}`;
  const url = provider.endpoint.replace(/\/$/, '') + '/chat/completions';
  logRaw('model', 'in', openAIBody, {
    provider: provider.name,
    modelId,
    phase: 'proxy-stream-openai',
  });

  const upstream = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(openAIBody),
    signal: AbortSignal.timeout(120000),
  });
  if (!upstream.ok) {
    const t = await upstream.text().catch(() => '');
    throw new BridgeProviderError(`${upstream.status}: ${t.slice(0, 400)}`, 502, { upstreamStatus: upstream.status });
  }

  const msgId = `msg_${Date.now()}`;
  const w = (ev, d) => res.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`);

  w('message_start', {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      content: [],
      model: modelId,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  w('ping', { type: 'ping' });

  if (!upstream.body) throw new Error('upstream response has no body');
  const reader = upstream.body.getReader();
  res.on('close', () => reader.cancel().catch(() => {}));
  const dec = new TextDecoder();
  let buf = '';
  let outputTokens = 0;
  let blockIndex = 0;
  let textBlockOpen = false;
  let reasoningBlockOpen = false;
  const toolCalls = new Map(); // index → { id, name, arguments }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload || payload === '[DONE]') continue;
      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch (_) {
        continue;
      }
      logRaw('model', 'out', chunk, {
        provider: provider.name,
        modelId,
        phase: 'proxy-stream-openai-sse',
      });
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      if (delta.reasoning_content) {
        if (!reasoningBlockOpen) {
          w('content_block_start', {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'thinking', thinking: '' },
          });
          reasoningBlockOpen = true;
        }
        w('content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
        });
      }

      if (delta.content) {
        if (reasoningBlockOpen) {
          w('content_block_stop', { type: 'content_block_stop', index: blockIndex });
          blockIndex++;
          reasoningBlockOpen = false;
        }
        if (!textBlockOpen) {
          w('content_block_start', {
            type: 'content_block_start',
            index: blockIndex,
            content_block: { type: 'text', text: '' },
          });
          textBlockOpen = true;
        }
        outputTokens++;
        w('content_block_delta', {
          type: 'content_block_delta',
          index: blockIndex,
          delta: { type: 'text_delta', text: delta.content },
        });
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
    }
  }

  if (reasoningBlockOpen) {
    w('content_block_stop', { type: 'content_block_stop', index: blockIndex });
    blockIndex++;
  }
  if (textBlockOpen) {
    w('content_block_stop', { type: 'content_block_stop', index: blockIndex });
    blockIndex++;
  }

  const sortedTools = [...toolCalls.entries()].sort((a, b) => a[0] - b[0]);
  for (const [, tc] of sortedTools) {
    w('content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: {
        type: 'tool_use',
        id: tc.id || `tu_${Date.now()}_${blockIndex}`,
        name: tc.name,
        input: {},
      },
    });
    w('content_block_delta', {
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'input_json_delta', partial_json: tc.arguments },
    });
    w('content_block_stop', { type: 'content_block_stop', index: blockIndex });
    blockIndex++;
  }

  const stopReason = sortedTools.length > 0 ? 'tool_use' : 'end_turn';
  w('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
  w('message_stop', { type: 'message_stop' });
  res.end();
}

// ── Proxy: Gemini ─────────────────────────────────────────────────────────────
function _buildGeminiContents(body) {
  // Pre-scan to build id→name map: Gemini requires functionResponse.name = tool name, not UUID
  const toolIdToName = new Map();
  for (const msg of body.messages || []) {
    if (msg.role === 'assistant' && Array.isArray(msg.content)) {
      for (const b of msg.content) {
        if (b.type === 'tool_use') toolIdToName.set(b.id, b.name);
      }
    }
  }
  const contents: any[] = [];
  for (const msg of body.messages || []) {
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const content = msg.content;
    if (typeof content === 'string') {
      contents.push({ role, parts: [{ text: content }] });
    } else if (Array.isArray(content)) {
      const toolUse = content.filter((b) => b.type === 'tool_use');
      const toolRes = content.filter((b) => b.type === 'tool_result');
      const texts = content.filter((b) => b.type === 'text');
      if (toolUse.length) {
        // Gemini requires thoughtSignature to be replayed on the exact functionCall
        // part where it was received. In parallel calls the signature is usually
        // only on the first functionCall. Older local builds briefly stashed this
        // as _geminiThoughts on the first tool_use block, so keep that fallback.
        const legacyThoughts = toolUse.flatMap((b: any) => b._geminiThoughts || []);
        contents.push({
          role: 'model',
          parts: toolUse.map((b, i) => {
            const part: any = { functionCall: { name: b.name, args: b.input || {} } };
            const sig = (b as any)._geminiThoughtSignature || legacyThoughts[i]?.thoughtSignature;
            if (sig) part.thoughtSignature = sig;
            return part;
          }),
        });
      } else if (toolRes.length) {
        contents.push({
          role: 'user',
          parts: toolRes.map((b) => ({
            functionResponse: {
              name: toolIdToName.get(b.tool_use_id) || b.tool_use_id,
              response: { result: String(b.content || '') },
            },
          })),
        });
      } else {
        const imageParts = content
          .filter((b) => b.type === 'image')
          .map((b) =>
            b.source?.type === 'base64'
              ? { inlineData: { mimeType: b.source.media_type, data: b.source.data } }
              : null
          )
          .filter(Boolean);
        const textParts = texts.map((b) => ({ text: b.text }));
        contents.push({ role, parts: [...imageParts, ...textParts] });
      }
    }
  }
  return contents;
}

async function proxyCallGemini(body, modelId, provider) {
  const contents = _buildGeminiContents(body);
  const gemBody: any = { contents };
  if (body.system) {
    const txt =
      typeof body.system === 'string'
        ? body.system
        : (body.system || [])
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('\n');
    if (txt) gemBody.systemInstruction = { parts: [{ text: txt }] };
  }
  if (body.tools?.length) {
    gemBody.tools = [
      {
        function_declarations: body.tools.map((t) => ({
          name: t.name,
          description: t.description || '',
          parameters: sanitizeGeminiSchema(t.input_schema),
        })),
      },
    ];
  }
  const url = `${provider.endpoint.replace(/\/$/, '')}/models/${modelId}:generateContent?key=${provider.api_key}`;
  logRaw('model', 'in', gemBody, { provider: provider.name, modelId, phase: 'proxy-gemini' });
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(gemBody),
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new BridgeProviderError(`Gemini ${res.status}: ${t.slice(0, 400)}`, 502, { upstreamStatus: res.status });
  }
  const data: any = await res.json();
  logRaw('model', 'out', data, { provider: provider.name, modelId, phase: 'proxy-gemini' });
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const content: any[] = [];
  for (const p of parts) {
    if (p.text && !p.thought) {
      const textBlock: any = { type: 'text', text: p.text };
      if (p.thoughtSignature) textBlock._geminiThoughtSignature = p.thoughtSignature;
      content.push(textBlock);
    }
    if (p.functionCall)
      content.push({
        type: 'tool_use',
        id: `tu_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        name: p.functionCall.name,
        input: p.functionCall.args || {},
        ...(p.thoughtSignature ? { _geminiThoughtSignature: p.thoughtSignature } : {}),
      });
  }
  return {
    id: `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: modelId,
    stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
}

// Real streaming proxy for Gemini (streamGenerateContent?alt=sse)
async function proxyStreamGemini(body, modelId, provider, res) {
  const contents = _buildGeminiContents(body);
  const gemBody: any = { contents };
  if (body.system) {
    const txt =
      typeof body.system === 'string'
        ? body.system
        : (body.system || [])
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('\n');
    if (txt) gemBody.systemInstruction = { parts: [{ text: txt }] };
  }
  if (body.tools?.length) {
    gemBody.tools = [
      {
        function_declarations: body.tools.map((t) => ({
          name: t.name,
          description: t.description || '',
          parameters: sanitizeGeminiSchema(t.input_schema),
        })),
      },
    ];
  }

  const url = `${provider.endpoint.replace(/\/$/, '')}/models/${modelId}:streamGenerateContent?key=${provider.api_key}&alt=sse`;
  logRaw('model', 'in', gemBody, {
    provider: provider.name,
    modelId,
    phase: 'proxy-stream-gemini',
  });
  const upstream = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(gemBody),
    signal: AbortSignal.timeout(120000),
  });
  if (!upstream.ok) {
    const t = await upstream.text().catch(() => '');
    throw new BridgeProviderError(`Gemini ${upstream.status}: ${t.slice(0, 400)}`, 502, { upstreamStatus: upstream.status });
  }

  const msgId = `msg_${Date.now()}`;
  const w = (ev, d) => res.write(`event: ${ev}\ndata: ${JSON.stringify(d)}\n\n`);
  w('message_start', {
    type: 'message_start',
    message: {
      id: msgId,
      type: 'message',
      role: 'assistant',
      content: [],
      model: modelId,
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 0, output_tokens: 0 },
    },
  });
  w('ping', { type: 'ping' });

  if (!upstream.body) throw new Error('upstream response has no body');
  const reader = upstream.body.getReader();
  res.on('close', () => reader.cancel().catch(() => {}));
  const dec = new TextDecoder();
  let buf = '';
  let outputTokens = 0;
  let blockIndex = 0;
  let textBlockOpen = false;
  const fnCalls: any[] = [];

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith('data:')) continue;
      const payload = trimmed.slice(5).trim();
      if (!payload) continue;
      let chunk;
      try {
        chunk = JSON.parse(payload);
      } catch (_) {
        continue;
      }
      logRaw('model', 'out', chunk, {
        provider: provider.name,
        modelId,
        phase: 'proxy-stream-gemini-sse',
      });

      const parts = chunk.candidates?.[0]?.content?.parts ?? [];
      for (const p of parts) {
        if (p.text && !p.thought) {
          if (!textBlockOpen) {
            w('content_block_start', {
              type: 'content_block_start',
              index: blockIndex,
              content_block: { type: 'text', text: '' },
            });
            textBlockOpen = true;
          }
          outputTokens++;
          w('content_block_delta', {
            type: 'content_block_delta',
            index: blockIndex,
            delta: { type: 'text_delta', text: p.text },
          });
        }
        if (p.functionCall)
          fnCalls.push({
            name: p.functionCall.name,
            args: p.functionCall.args || {},
            thoughtSignature: p.thoughtSignature || '',
          });
      }
    }
  }

  if (textBlockOpen) {
    w('content_block_stop', { type: 'content_block_stop', index: blockIndex });
    blockIndex++;
  }

  for (let fi = 0; fi < fnCalls.length; fi++) {
    const fn = fnCalls[fi];
    const tuId = `tu_${Date.now()}_${blockIndex}`;
    const contentBlock: any = { type: 'tool_use', id: tuId, name: fn.name, input: {} };
    if (fn.thoughtSignature) contentBlock._geminiThoughtSignature = fn.thoughtSignature;
    w('content_block_start', {
      type: 'content_block_start',
      index: blockIndex,
      content_block: contentBlock,
    });
    w('content_block_delta', {
      type: 'content_block_delta',
      index: blockIndex,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(fn.args) },
    });
    w('content_block_stop', { type: 'content_block_stop', index: blockIndex });
    blockIndex++;
  }

  const stopReason = fnCalls.length > 0 ? 'tool_use' : 'end_turn';
  w('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: { output_tokens: outputTokens },
  });
  w('message_stop', { type: 'message_stop' });
  res.end();
}

module.exports = {
  anthropicToOpenAI,
  openAIRespToAnthropic,
  emitAnthropicSSE,
  PROVIDER_MAX_TOKENS,
  getContextLimit,
  trimMessagesToFit,
  sanitizeGeminiSchema,
  proxyCallOpenAI,
  proxyStreamOpenAI,
  proxyCallGemini,
  proxyStreamGemini,
};
