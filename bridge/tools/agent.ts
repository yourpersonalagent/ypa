// ── Iterative agent loops for OpenAI-compat + Gemini providers ────────────────
'use strict';

const { config } = require('../core/state');
const { getSessionCwd, getHistory, pushHistory } = require('../sessions-internal');
const { findProvider, isGeminiModel } = require('../providers');
const { logRaw } = require('../observability/raw-logs');
const { BridgeInputError, BridgeProviderError } = require('../core/errors');
const { getBridgeToolDefs, getGeminiToolDefs } = require('./defs');
const { executeBridgeTool } = require('./exec');
const { drainBtw, formatBtwInjection } = require('../chat/btw-queue');
// #btw injection — see tools/stream.ts for the full plan; same pattern
// applies in these non-streaming agent loops.

// ── Agent loop for OpenAI-compatible providers ────────────────────────────────
async function runOpenAIWithTools(prompt, modelId, preset, sessionId, endpoint, apiKey, onChunk) {
  const messages = [];
  if (preset) messages.push({ role: 'system', content: preset });
  messages.push(...getHistory(sessionId));
  messages.push({ role: 'user', content: prompt });

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  const url = endpoint.replace(/\/$/, '') + '/chat/completions';

  const MAX_ITER = config.defaults?.agent_max_iter ?? 25;
  for (let iter = 0; iter < MAX_ITER; iter++) {
    const body = JSON.stringify({
      model: modelId,
      messages,
      tools: getBridgeToolDefs(),
      tool_choice: 'auto',
    });
    logRaw('model', 'in', body, { provider: 'openai-compatible', modelId, phase: 'tool-loop' });
    const res = await fetch(url, { method: 'POST', headers, body });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new BridgeProviderError(`${res.status}: ${t}`, 502, { upstreamStatus: res.status });
    }

    const data: any = await res.json();
    logRaw('model', 'out', data, { provider: 'openai-compatible', modelId, phase: 'tool-loop' });
    const message = data.choices?.[0]?.message;
    if (!message) throw new BridgeProviderError('No response from API');

    messages.push(message);

    if (!message.tool_calls?.length) {
      const text = message.content ?? '';
      pushHistory(sessionId, 'user', prompt);
      pushHistory(sessionId, 'assistant', text);
      return { text, cost: 0, tokens: data.usage?.total_tokens || 0 };
    }

    if (onChunk)
      onChunk({
        text: `\n🔧 Using tools: ${message.tool_calls.map((t) => t.function.name).join(', ')}…\n`,
        delta: '',
      });
    const toolResults = await Promise.all(
      message.tool_calls.map(async (tc) => {
        let input = {};
        try {
          input = JSON.parse(tc.function.arguments || '{}');
        } catch (_) {}
        let resultStr: string;
        try {
          const result = await executeBridgeTool(tc.function.name, input, getSessionCwd(sessionId), modelId);
          resultStr = String(result);
        } catch (toolErr) {
          resultStr = `[tool error] ${toolErr instanceof Error ? toolErr.message : String(toolErr)}`;
        }
        if (onChunk)
          onChunk({
            toolUse: { name: tc.function.name, input },
            toolResult: resultStr.slice(0, config.defaults?.tool_preview_limit ?? 200),
          });
        return { role: 'tool', tool_call_id: tc.id, content: resultStr };
      })
    );
    messages.push(...toolResults);

    const btw = drainBtw(sessionId);
    if (btw.length) messages.push({ role: 'user', content: formatBtwInjection(btw) });
  }
  return { text: '(max tool iterations reached)', cost: 0 };
}

// ── Agent loop for Gemini ─────────────────────────────────────────────────────
async function runGeminiWithTools(prompt, modelId, preset, sessionId, endpoint, apiKey, onChunk) {
  const contents = [];
  for (const msg of getHistory(sessionId)) {
    contents.push({
      role: msg.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: msg.content }],
    });
  }
  contents.push({ role: 'user', parts: [{ text: prompt }] });

  const baseUrl = endpoint.replace(/\/$/, '');
  const MAX_ITER = config.defaults?.tool_max_iter ?? 8;
  for (let iter = 0; iter < MAX_ITER; iter++) {
    const body: any = { contents, tools: getGeminiToolDefs() };
    if (preset) body.systemInstruction = { parts: [{ text: preset }] };

    const url = `${baseUrl}/models/${modelId}:generateContent?key=${apiKey}`;
    logRaw('model', 'in', body, { provider: 'gemini', modelId, phase: 'tool-loop' });
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      throw new BridgeProviderError(`Gemini ${res.status}: ${t}`, 502, { upstreamStatus: res.status });
    }

    const data: any = await res.json();
    logRaw('model', 'out', data, { provider: 'gemini', modelId, phase: 'tool-loop' });
    const candidate = data.candidates?.[0];
    const parts = candidate?.content?.parts ?? [];

    const fnCalls = parts.filter((p) => p.functionCall);
    if (!fnCalls.length) {
      const text = parts.map((p) => p.text || '').join('');
      pushHistory(sessionId, 'user', prompt);
      pushHistory(sessionId, 'assistant', text);
      return { text, cost: 0, tokens: 0 };
    }

    contents.push({ role: 'model', parts });

    if (onChunk)
      onChunk({
        text: `\n🔧 Using tools: ${fnCalls.map((p) => p.functionCall.name).join(', ')}…\n`,
        delta: '',
      });
    const funcResults = await Promise.all(
      fnCalls.map(async (p) => {
        const { name, args } = p.functionCall;
        let resultStr: string;
        try {
          const result = await executeBridgeTool(name, args || {}, getSessionCwd(sessionId), modelId);
          resultStr = String(result);
        } catch (toolErr) {
          resultStr = `[tool error] ${toolErr instanceof Error ? toolErr.message : String(toolErr)}`;
        }
        if (onChunk)
          onChunk({
            toolUse: { name, input: args },
            toolResult: resultStr.slice(0, config.defaults?.tool_preview_limit ?? 200),
          });
        return { functionResponse: { name, response: { result: resultStr } } };
      })
    );
    contents.push({ role: 'user', parts: funcResults });

    const btw = drainBtw(sessionId);
    if (btw.length) contents.push({ role: 'user', parts: [{ text: formatBtwInjection(btw) }] });
  }
  return { text: '(max tool iterations reached)', cost: 0 };
}

// ── Unified dispatcher — all external models get tool-calling ─────────────────
async function dispatchExec(prompt, modelId, preset, sessionId, onChunk) {
  const found = findProvider(modelId);
  if (!found) throw new BridgeInputError(`Unknown model: ${modelId}`, { modelId });
  const { provider } = found;

  const style = provider.api_style || (isGeminiModel(modelId) ? 'google' : 'openai');
  if (style === 'google') {
    return runGeminiWithTools(
      prompt,
      modelId,
      preset,
      sessionId,
      provider.endpoint,
      provider.api_key,
      onChunk
    );
  }
  return runOpenAIWithTools(
    prompt,
    modelId,
    preset,
    sessionId,
    provider.endpoint,
    provider.api_key,
    onChunk
  );
}

module.exports = {
  runOpenAIWithTools,
  runGeminiWithTools,
  dispatchExec,
};
