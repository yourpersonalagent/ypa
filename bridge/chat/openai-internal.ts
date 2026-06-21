// ── Loopback-only OpenAI-compatible endpoint ──────────────────────────────────
// A separate Express app bound to 127.0.0.1 only.  This is what local clients
// (Hermes etc.) talk to.  Auth is the YHA API key (Authorization: Bearer yha_…)
// — *no* WorkOS session.  The route is a thin pass-through to the underlying
// OpenAI-compatible provider, injecting YHA's stored provider key on the way.
'use strict';

const express = require('express');
const http = require('http');

const { config } = require('../core/state');
const { findProvider } = require('../providers/core');
const { getModelPricing } = require('../models');
const { verifyApiKey, recordKeyUsage, getProxyPrefs } = require('../config/api-keys');
const { buildModelList } = require('../models');
// Phase 3: harness functions are looked up in the `harnesses` register
// rather than imported directly. The register is populated by
// `bridge/core/bootstrap-harnesses.ts` before any module loads.
const { bridgeRegisters } = require('../core/registers/keys');
function _getHarness(id: string) {
  const entry = bridgeRegisters.harnesses.list().find((h: any) => h.id === id);
  if (!entry) {
    throw new Error(`No harness "${id}" available — check bridge/modules.json`);
  }
  return entry as any;
}
const crypto = require('crypto');

function _extractToken(req): string | null {
  const h = req.headers.authorization || '';
  const m = /^Bearer\s+(\S+)/i.exec(h);
  if (m) return m[1];
  // Some clients send api_key in the body or query
  if (typeof req.query?.api_key === 'string') return req.query.api_key;
  if (typeof req.body?.api_key === 'string') return req.body.api_key;
  return null;
}

function startInternalApiServer() {
  if (process.env.YHA_INTERNAL_API_DISABLED === 'true') return;
  const port = Number(process.env.YHA_INTERNAL_API_PORT || 8444);
  const host = '127.0.0.1';

  const app = express();
  app.use(express.json({ limit: '5mb' }));

  // Auth gate — every request must carry a valid yha_ key
  app.use((req, res, next) => {
    const token = _extractToken(req);
    const rec = token ? verifyApiKey(token) : null;
    if (!rec) {
      return res.status(401).json({
        error: {
          message: 'Invalid or missing API key. Send Authorization: Bearer yha_…',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      });
    }
    (req as any).yhaKey = rec;
    next();
  });

  // GET /v1/models — list all models YHA knows about, in OpenAI shape.
  // IDs are namespaced as "<provider-slug>/<model-name>".  Anthropic
  // Subscription entries are kept — they're served by spawning the Claude
  // binary subprocess (OAuth) below.
  app.get('/v1/models', (_req, res) => {
    const list = buildModelList();
    const data = list.map((m) => ({
      id: _qualifiedId(m.provider, m.name),
      object: 'model',
      created: 0,
      owned_by: m.provider || 'yha',
    }));
    res.json({ object: 'list', data });
  });

  // POST /v1/chat/completions — proxy to underlying OpenAI-compatible provider
  app.post('/v1/chat/completions', async (req, res) => {
    const body = req.body || {};
    const rawModel = String(body.model || '');
    if (!rawModel) {
      return res.status(400).json({
        error: { message: 'Missing "model" field', type: 'invalid_request_error' },
      });
    }
    // Accept either "<provider-slug>/<model>" or just "<model>" (legacy).
    const { providerHint, modelId } = _parseQualifiedId(rawModel);
    const found = findProvider(modelId, providerHint);
    if (!found) {
      return res.status(404).json({
        error: { message: `Unknown model: ${rawModel}`, type: 'invalid_request_error' },
      });
    }
    const { provider } = found;
    if (!provider.endpoint) {
      return res.status(500).json({
        error: { message: `Provider "${provider.name}" has no endpoint configured`, type: 'server_error' },
      });
    }

    const isAnthropic = /^Anthropic( API| Subscription)?$/.test(provider.name);
    const wantStream = body.stream === true;
    const keyId = (req as any).yhaKey?.id as string;

    if (provider.name === 'Anthropic Subscription') {
      return _proxyClaudeBinary(req, res, modelId, body, wantStream, keyId);
    }

    if (isAnthropic) {
      return _proxyAnthropic(req, res, provider, body, modelId, wantStream, keyId);
    }

    const url = provider.endpoint.replace(/\/$/, '') + '/chat/completions';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (provider.api_key) headers['Authorization'] = `Bearer ${provider.api_key}`;

    const upstreamBody = { ...body, stream: wantStream };

    let upstream: Response;
    try {
      upstream = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(upstreamBody),
      });
    } catch (e) {
      return res.status(502).json({
        error: {
          message: `Upstream fetch failed: ${(e as Error).message}`,
          type: 'server_error',
        },
      });
    }

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => '');
      res.status(upstream.status);
      try {
        res.json(JSON.parse(text));
      } catch {
        res.type('text/plain').send(text || `Upstream error ${upstream.status}`);
      }
      return;
    }

    let promptTokens = 0;
    let completionTokens = 0;

    if (wantStream) {
      // Stream SSE through unchanged; tail-parse usage chunks for accounting.
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.flushHeaders?.();

      const reader = upstream.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value, { stream: true });
          buffer += chunk;
          // Parse complete SSE events out of buffer for usage extraction; pass
          // raw bytes through to the client so we don't reshape anything.
          res.write(value);
          let idx;
          while ((idx = buffer.indexOf('\n\n')) !== -1) {
            const evt = buffer.slice(0, idx);
            buffer = buffer.slice(idx + 2);
            for (const line of evt.split('\n')) {
              if (!line.startsWith('data:')) continue;
              const payload = line.slice(5).trim();
              if (!payload || payload === '[DONE]') continue;
              try {
                const j = JSON.parse(payload);
                if (j.usage) {
                  promptTokens = j.usage.prompt_tokens || promptTokens;
                  completionTokens = j.usage.completion_tokens || completionTokens;
                }
              } catch { /* skip */ }
            }
          }
        }
      } catch {
        /* client disconnect */
      } finally {
        res.end();
        if (keyId) {
          const cost = _calcCost(modelId, promptTokens, completionTokens);
          recordKeyUsage(keyId, modelId, promptTokens, completionTokens, cost);
        }
      }
      return;
    }

    // Non-streaming — buffer, forward, account
    const text = await upstream.text();
    try {
      const j = JSON.parse(text);
      if (j.usage) {
        promptTokens = j.usage.prompt_tokens || 0;
        completionTokens = j.usage.completion_tokens || 0;
      }
      res.status(upstream.status).json(j);
    } catch {
      res.status(upstream.status).type('text/plain').send(text);
    }
    if (keyId) {
      const cost = _calcCost(modelId, promptTokens, completionTokens);
      recordKeyUsage(keyId, modelId, promptTokens, completionTokens, cost);
    }
  });

  const server = http.createServer(app);
  server.listen(port, host, () => {
    console.log(`YHA internal OpenAI-compat API → http://${host}:${port}/v1 (loopback only)`);
  });
}

// ── Qualified-ID helpers — "<provider-slug>/<model-name>" ─────────────────────
// Slug = lowercase provider name with non-alphanumerics → "-".  Model name is
// kept verbatim (it can already contain "/" — e.g. OpenRouter "anthropic/…").

function _slug(s: string): string {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function _qualifiedId(providerName: string | undefined, modelName: string): string {
  const slug = _slug(providerName || 'yha');
  return `${slug}/${modelName}`;
}

function _parseQualifiedId(raw: string): { providerHint: string | undefined; modelId: string } {
  // Build the set of provider names that buildModelList may emit.  This
  // includes synthetic labels ("Anthropic API", "Anthropic Subscription",
  // "OpenAI Subscription") that don't appear in config.providers.
  const fromConfig = (config.providers || []).map((p: any) => p.name as string);
  const synthetic = ['Anthropic API', 'Anthropic Subscription', 'OpenAI Subscription'];
  const all = Array.from(new Set([...synthetic, ...fromConfig]));
  // Sort by slug length desc so longer slugs match first (anthropic-api before
  // anthropic) — otherwise "anthropic-api/claude-…" would parse as the
  // "anthropic" prefix with modelId "api/claude-…".
  all.sort((a, b) => _slug(b).length - _slug(a).length);
  for (const name of all) {
    const slug = _slug(name);
    if (!slug) continue;
    if (raw === slug) return { providerHint: name, modelId: '' };
    if (raw.startsWith(slug + '/')) {
      return { providerHint: name, modelId: raw.slice(slug.length + 1) };
    }
  }
  return { providerHint: undefined, modelId: raw };
}

function _calcCost(modelId: string, promptTokens: number, completionTokens: number): number {
  const pricing = getModelPricing(modelId);
  if (!pricing) return 0;
  return (
    (promptTokens / 1_000_000) * (pricing.price_input || 0) +
    (completionTokens / 1_000_000) * (pricing.price_output || 0)
  );
}

// ── OpenAI ↔ Anthropic translation (text-only; tool calls not yet) ────────────

function _openAiMessagesToAnthropic(body: any): { system: string | undefined; messages: any[] } {
  let system: string | undefined;
  const out: any[] = [];
  for (const m of body.messages || []) {
    if (m.role === 'system') {
      const txt = typeof m.content === 'string'
        ? m.content
        : Array.isArray(m.content)
          ? m.content.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('\n')
          : '';
      system = system ? system + '\n\n' + txt : txt;
      continue;
    }
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
    } else if (Array.isArray(m.content)) {
      const blocks: any[] = [];
      for (const p of m.content) {
        if (p?.type === 'text' && typeof p.text === 'string') {
          blocks.push({ type: 'text', text: p.text });
        } else if (p?.type === 'image_url' && p.image_url?.url) {
          const url = String(p.image_url.url);
          const dataUrlMatch = /^data:([^;]+);base64,(.+)$/.exec(url);
          if (dataUrlMatch) {
            blocks.push({
              type: 'image',
              source: { type: 'base64', media_type: dataUrlMatch[1], data: dataUrlMatch[2] },
            });
          } else {
            blocks.push({ type: 'image', source: { type: 'url', url } });
          }
        }
      }
      if (blocks.length) out.push({ role: m.role, content: blocks });
    }
  }
  return { system, messages: out };
}

function _stopReasonToFinish(reason: string | undefined): string | null {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_calls';
    default:
      return reason ? 'stop' : null;
  }
}

async function _proxyAnthropic(
  _req,
  res,
  provider,
  body: any,
  modelId: string,
  wantStream: boolean,
  keyId: string | null
): Promise<void> {
  const { system, messages } = _openAiMessagesToAnthropic(body);
  const anthropicBody: any = {
    model: modelId,
    messages,
    max_tokens: Number(body.max_tokens) || 4096,
    stream: wantStream,
  };
  if (system) anthropicBody.system = system;
  if (typeof body.temperature === 'number') anthropicBody.temperature = body.temperature;
  if (typeof body.top_p === 'number') anthropicBody.top_p = body.top_p;
  if (Array.isArray(body.stop)) anthropicBody.stop_sequences = body.stop;
  else if (typeof body.stop === 'string') anthropicBody.stop_sequences = [body.stop];

  const url = provider.endpoint.replace(/\/$/, '') + '/messages';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };
  if (provider.api_key) headers['x-api-key'] = provider.api_key;

  let upstream: Response;
  try {
    upstream = await fetch(url, { method: 'POST', headers, body: JSON.stringify(anthropicBody) });
  } catch (e) {
    res.status(502).json({ error: { message: `Upstream fetch failed: ${(e as Error).message}`, type: 'server_error' } });
    return;
  }

  if (!upstream.ok || !upstream.body) {
    const text = await upstream.text().catch(() => '');
    res.status(upstream.status);
    try { res.json(JSON.parse(text)); }
    catch { res.type('text/plain').send(text || `Upstream error ${upstream.status}`); }
    return;
  }

  const completionId = `chatcmpl-${Math.random().toString(36).slice(2, 12)}`;
  const created = Math.floor(Date.now() / 1000);

  if (!wantStream) {
    const text = await upstream.text();
    let aResp: any;
    try { aResp = JSON.parse(text); }
    catch {
      res.status(502).type('text/plain').send(text);
      return;
    }
    const contentText = Array.isArray(aResp.content)
      ? aResp.content.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('')
      : '';
    const promptTokens = aResp.usage?.input_tokens || 0;
    const completionTokens = aResp.usage?.output_tokens || 0;
    const openAiResp = {
      id: completionId,
      object: 'chat.completion',
      created,
      model: modelId,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: contentText },
          finish_reason: _stopReasonToFinish(aResp.stop_reason) || 'stop',
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    };
    res.json(openAiResp);
    if (keyId) recordKeyUsage(keyId, modelId, promptTokens, completionTokens, _calcCost(modelId, promptTokens, completionTokens));
    return;
  }

  // ── Streaming: Anthropic SSE → OpenAI SSE ──
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  const writeChunk = (delta: any, finishReason: string | null = null) => {
    const chunk = {
      id: completionId,
      object: 'chat.completion.chunk',
      created,
      model: modelId,
      choices: [{ index: 0, delta, finish_reason: finishReason }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  let promptTokens = 0;
  let completionTokens = 0;
  let stopReason: string | undefined;
  let roleEmitted = false;

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf('\n\n')) !== -1) {
        const evt = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        let dataLine = '';
        for (const line of evt.split('\n')) {
          if (line.startsWith('data:')) dataLine = line.slice(5).trim();
        }
        if (!dataLine) continue;
        let j: any;
        try { j = JSON.parse(dataLine); } catch { continue; }
        switch (j.type) {
          case 'message_start': {
            promptTokens = j.message?.usage?.input_tokens || 0;
            if (!roleEmitted) {
              writeChunk({ role: 'assistant', content: '' });
              roleEmitted = true;
            }
            break;
          }
          case 'content_block_delta': {
            if (j.delta?.type === 'text_delta' && j.delta.text) {
              writeChunk({ content: j.delta.text });
            }
            break;
          }
          case 'message_delta': {
            if (j.usage?.output_tokens != null) completionTokens = j.usage.output_tokens;
            if (j.delta?.stop_reason) stopReason = j.delta.stop_reason;
            break;
          }
          case 'message_stop': {
            // emitted after the loop
            break;
          }
        }
      }
    }
  } catch {
    /* client disconnect */
  }

  writeChunk({}, _stopReasonToFinish(stopReason) || 'stop');
  res.write(`data: ${JSON.stringify({
    id: completionId,
    object: 'chat.completion.chunk',
    created,
    model: modelId,
    choices: [],
    usage: {
      prompt_tokens: promptTokens,
      completion_tokens: completionTokens,
      total_tokens: promptTokens + completionTokens,
    },
  })}\n\n`);
  res.write('data: [DONE]\n\n');
  res.end();

  if (keyId) recordKeyUsage(keyId, modelId, promptTokens, completionTokens, _calcCost(modelId, promptTokens, completionTokens));
}

// ── Anthropic Subscription path — spawn Claude binary via streamClaude() ──────
// Hermes sends each call with the full message history, so we don't try to
// resume Claude-side sessions; every call is fresh.  Prior turns are inlined
// into the prompt as a context preamble (same shape streamClaude itself uses
// when it has no resumable session).

function _flattenOpenAiMessagesForClaude(body: any): { prompt: string; system: string | undefined } {
  const sysParts: string[] = [];
  const turns: { role: string; content: string }[] = [];
  for (const m of body.messages || []) {
    const txt = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content)
        ? m.content.filter((p: any) => p?.type === 'text').map((p: any) => p.text).join('')
        : '';
    if (m.role === 'system') {
      if (txt) sysParts.push(txt);
    } else if (m.role === 'user' || m.role === 'assistant') {
      turns.push({ role: m.role, content: txt });
    }
  }
  // Last user turn becomes the live prompt; everything else is preamble.
  let lastUserIdx = -1;
  for (let i = turns.length - 1; i >= 0; i--) {
    if (turns[i].role === 'user') { lastUserIdx = i; break; }
  }
  let prompt = '';
  if (lastUserIdx >= 0) {
    const prior = turns.slice(0, lastUserIdx);
    prompt = turns[lastUserIdx].content;
    if (prior.length) {
      const ctx = prior
        .map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`)
        .join('\n\n');
      prompt = `[Previous conversation:\n${ctx}\n]\n\n${prompt}`;
    }
  } else {
    // No user turn? Hand whatever we have over verbatim.
    prompt = turns.map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}: ${t.content}`).join('\n\n');
  }
  const system = sysParts.length ? sysParts.join('\n\n') : undefined;
  return { prompt, system };
}

function _proxyClaudeBinary(
  _req,
  res,
  modelId: string,
  body: any,
  wantStream: boolean,
  keyId: string | null
): void {
  const { prompt, system } = _flattenOpenAiMessagesForClaude(body);
  const sessionId = `openai-proxy-${crypto.randomBytes(8).toString('hex')}`;
  const completionId = `chatcmpl-${Math.random().toString(36).slice(2, 12)}`;
  const created = Math.floor(Date.now() / 1000);

  // modelProvider is the trigger that makes streamClaude clear ANTHROPIC_API_KEY
  // from the spawned binary's env so the OAuth subscription path is used
  // instead of the API path (which would error "Credit balance is too low").
  const claudeOpts: any = {
    sysMode: system ? 'append' : undefined,
    modelProvider: 'Anthropic Subscription',
  };

  if (wantStream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    let roleEmitted = false;
    const writeChunk = (delta: any, finishReason: string | null = null) => {
      const chunk = {
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: modelId,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    };

    const onChunk = (c: any) => {
      if (typeof c.delta === 'string' && c.delta.length) {
        if (!roleEmitted) {
          writeChunk({ role: 'assistant', content: '' });
          roleEmitted = true;
        }
        writeChunk({ content: c.delta });
      }
      // toolUse / toolResult / reasoning are dropped — Hermes doesn't speak
      // them in OpenAI-SSE form, and the binary will resolve them itself.
    };

    const onDone = (d: any) => {
      const finish = _stopReasonToFinish(d.stopReason) || 'stop';
      writeChunk({}, finish);
      res.write(`data: ${JSON.stringify({
        id: completionId,
        object: 'chat.completion.chunk',
        created,
        model: modelId,
        choices: [],
        usage: {
          prompt_tokens: d.inputTokens || 0,
          completion_tokens: d.outputTokens || 0,
          total_tokens: (d.inputTokens || 0) + (d.outputTokens || 0),
        },
      })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      if (keyId) {
        const cost = d.cost || _calcCost(modelId, d.inputTokens || 0, d.outputTokens || 0);
        recordKeyUsage(keyId, modelId, d.inputTokens || 0, d.outputTokens || 0, cost);
      }
    };

    const onError = (err: Error) => {
      try {
        res.write(`data: ${JSON.stringify({
          error: { message: err.message || String(err), type: 'server_error' },
        })}\n\n`);
        res.end();
      } catch { /* already closed */ }
    };

    const mode = getProxyPrefs().subscriptionMode;
    if (mode === 'binary') {
      _getHarness('claude-binary').stream(prompt, modelId, system, sessionId, onChunk, onDone, onError, [], claudeOpts);
    } else {
      _getHarness('claude-sdk').stream(prompt, modelId, system || '', sessionId, onChunk, onDone, onError, [], claudeOpts);
    }
    return;
  }

  // Non-streaming — buffer text, return one OpenAI chat.completion
  let buffered = '';
  const onChunk = (c: any) => {
    if (typeof c.delta === 'string') buffered += c.delta;
  };
  const onDone = (d: any) => {
    const text = d.text || buffered;
    const promptTokens = d.inputTokens || 0;
    const completionTokens = d.outputTokens || 0;
    res.json({
      id: completionId,
      object: 'chat.completion',
      created,
      model: modelId,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: text },
          finish_reason: _stopReasonToFinish(d.stopReason) || 'stop',
        },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    });
    if (keyId) {
      const cost = d.cost || _calcCost(modelId, promptTokens, completionTokens);
      recordKeyUsage(keyId, modelId, promptTokens, completionTokens, cost);
    }
  };
  const onError = (err: Error) => {
    res.status(502).json({ error: { message: err.message || String(err), type: 'server_error' } });
  };

  _getHarness('claude-binary').stream(prompt, modelId, system, sessionId, onChunk, onDone, onError, [], claudeOpts);
}

module.exports = { startInternalApiServer };
