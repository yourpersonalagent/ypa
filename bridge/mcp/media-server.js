#!/usr/bin/env node
// @ts-check
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto'); // eslint-disable-line no-redeclare
const https = require('https');
const http = require('http');
const { StringDecoder } = require('string_decoder');
const _stdinDecoder = new StringDecoder('utf8');

// ── Config loader ────────────────────────────────────────────────────────────

function loadConfig() {
  const configPath = path.join(__dirname, '..', 'config.json');
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    const openai  = cfg.providers.find(p => p.name === 'OpenAI') || cfg.providers.find(p => p.name === 'OpenAI-Image');
    const google  = cfg.providers.find(p => p.name === 'Google');
    const grok    = cfg.providers.find(p => p.name === 'Grok');
    const grokInstances = Array.isArray(cfg.defaults?.grokInstances) ? cfg.defaults.grokInstances : [];
    return {
      openai_key: openai?.api_key || process.env.OPENAI_API_KEY || '',
      google_key: google?.api_key || process.env.GOOGLE_API_KEY || '',
      grok_key:   grok?.api_key   || process.env.XAI_API_KEY   || '',
      grok_instances: grokInstances,
    };
  } catch (e) {
    return { openai_key: process.env.OPENAI_API_KEY || '', google_key: '', grok_key: '', grok_instances: [] };
  }
}

// ── Grok-SUB OAuth token loader ──────────────────────────────────────────────
// Each grokInstance has a configDir (e.g. %USERPROFILE%\.grok) containing
// auth.json. Shape:
//   { "<issuer>::<client-id>": { key, refresh_token, expires_at, … } }
// We return the first usable `key` (OAuth access token). The grok CLI is
// responsible for refreshing — we only read.
function loadGrokSubToken(instanceIndex) {
  const cfg = loadConfig();
  const inst = cfg.grok_instances[instanceIndex];
  if (!inst || !inst.configDir) return null;
  try {
    const authPath = path.join(inst.configDir, 'auth.json');
    const raw = fs.readFileSync(authPath, 'utf8');
    const parsed = JSON.parse(raw);
    for (const v of Object.values(parsed || {})) {
      if (v && typeof v === 'object' && typeof v.key === 'string' && v.key.length > 0) {
        return { token: v.key, label: inst.label || '', configDir: inst.configDir };
      }
    }
  } catch (_) {}
  return null;
}

// Map a synthetic provider name (`Grok-SUB`, `Grok-SUB2`, …) to a zero-based
// instance index. `Grok-SUB` → 0, `Grok-SUB2` → 1, etc. — same convention as
// the LLM router in go-core.
function grokSubInstanceIndex(provider) {
  const m = String(provider || '').match(/^Grok-SUB(\d*)$/);
  if (!m) return -1;
  return m[1] ? parseInt(m[1], 10) - 1 : 0;
}

// ── Bridge active-model helper ────────────────────────────────────────────────

// Read active model defaults directly from config.json as fallback.
function _activeModelsFromConfig() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));
    const d = cfg.defaults || {};
    return {
      image: d.image_model ? { model: d.image_model, provider: d.image_provider || '' } : {},
      video: d.video_model ? { model: d.video_model, provider: d.video_provider || '' } : {},
      audio: d.audio_model ? { model: d.audio_model, provider: d.audio_provider || '' } : {},
    };
  } catch (_) { return {}; }
}

// Fetch the active model selections from the bridge (set by frontend model picker).
// Falls back to config.json defaults when the bridge is unreachable or returns an error.
async function fetchActiveModels() {
  return new Promise(resolve => {
    http.get('http://localhost:8443/v1/active-models/', res => {
      let data = '';
      res.on('data', d => { data += d; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed && !parsed.error) return resolve(parsed);
        } catch (_) {}
        resolve(_activeModelsFromConfig());
      });
    }).on('error', () => resolve(_activeModelsFromConfig()));
  });
}

// ── MCP stdio transport ──────────────────────────────────────────────────────

let inputBuffer = '';

function sendMessage(msg) {
  const json = JSON.stringify(msg);
  process.stdout.write('Content-Length: ' + Buffer.byteLength(json, 'utf8') + '\r\n\r\n' + json);
}

function handleMessage(msg) {
  if (msg.method === 'initialize') {
    sendMessage({
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'media-gen', version: '1.0.0' }
      }
    });
  } else if (msg.method === 'initialized' || msg.method === 'notifications/initialized') {
    // notification — no response
  } else if (msg.method === 'ping') {
    sendMessage({ jsonrpc: '2.0', id: msg.id, result: {} });
  } else if (msg.method === 'tools/list') {
    sendMessage({
      jsonrpc: '2.0', id: msg.id,
      result: {
        tools: [
          {
            name: 'generate_image',
            description: 'Generate an image using the user\'s selected image model. The model, provider, and API routing are handled automatically — just provide the prompt.',
            inputSchema: {
              type: 'object',
              properties: {
                prompt: { type: 'string', description: 'Image description/prompt' },
                model: { type: 'string', description: 'Model ID override (e.g. chatgpt-image-latest, gpt-image-2). When omitted, the active model from the frontend model picker is used.' },
                provider: { type: 'string', description: 'Provider override (e.g. "OpenAI", "Google", "Grok", "Grok-SUB", "Grok-SUB2"). Required when the same model id can be routed via API key vs subscription (grok-imagine-*). Omit to use the active picker selection.' },
                n: { type: 'number', description: 'Number of images to generate (default 1)' },
                aspect_ratio: { type: 'string', description: 'Aspect ratio — MUST use this parameter, never put aspect ratio in the prompt text. Values: "1:1" (square default), "9:16" (portrait/vertical), "16:9" (landscape/horizontal), "3:4", "4:3"' },
                quality: { type: 'string', description: 'Quality level: auto, low, medium, high (gpt-image-* only). Default: auto.' },
                output_format: { type: 'string', description: 'Output format: png, jpeg, webp. Default: png.' },
                background: { type: 'boolean', description: 'If true, use transparent background (PNG/WebP, gpt-image-1/1.5 only).' },
                style_hint: { type: 'string', description: 'Optional style hint appended to the prompt for Gemini models (e.g. "photorealistic", "oil painting").' }
              },
              required: ['prompt']
            }
          },
          {
            name: 'edit_image',
            description: 'Edit an existing image via OpenAI gpt-image inpainting. Transparent areas of the optional mask define where edits occur.',
            inputSchema: {
              type: 'object',
              properties: {
                prompt: { type: 'string', description: 'Edit instruction / description of what should appear' },
                image_base64: { type: 'string', description: 'Base64-encoded PNG image to edit' },
                mask_base64: { type: 'string', description: 'Optional base64-encoded PNG mask — transparent areas are edited' },
                size: { type: 'string', description: 'Output size: 1024x1024, 1024x1536 (portrait), or 1536x1024 (landscape)' }
              },
              required: ['prompt', 'image_base64']
            }
          },
          {
            name: 'vary_image',
            description: 'Create variations of an existing image via OpenAI gpt-image',
            inputSchema: {
              type: 'object',
              properties: {
                image_base64: { type: 'string', description: 'Base64-encoded PNG image to vary' },
                n: { type: 'number', description: 'Number of variations 1-4 (default 1)' },
                size: { type: 'string', description: 'Output size: 1024x1024, 1024x1536, or 1536x1024' }
              },
              required: ['image_base64']
            }
          },
          {
            name: 'generate_audio',
            description: 'Generate audio using the user\'s selected audio model. Supports Google Lyria (music) and OpenAI TTS (speech). Model and provider are resolved automatically from the active selection.',
            inputSchema: {
              type: 'object',
              properties: {
                prompt: { type: 'string', description: 'Audio description or text to speak' },
                bpm: { type: 'number', description: 'Beats per minute (Lyria music models only, 60–200)' },
                duration_secs: { type: 'number', description: 'Target duration in seconds (Lyria: 10–120)' },
                style_genre: { type: 'string', description: 'Style/genre description (Lyria only, e.g. "lo-fi hip hop, chill beats")' },
                avoid: { type: 'string', description: 'Negative prompt — what to avoid in the audio (Lyria only)' },
                voice: { type: 'string', description: 'Voice ID for TTS (OpenAI TTS only, e.g. alloy, echo, nova)' },
                voice_instructions: { type: 'string', description: 'Voice style instructions (gpt-4o-mini-tts only)' },
                speed: { type: 'number', description: 'Speech speed 0.5–2.0 (OpenAI TTS only, default 1.0)' },
                format: { type: 'string', description: 'Output format: mp3, opus, aac, flac, wav (OpenAI TTS only, default mp3)' }
              },
              required: ['prompt']
            }
          },
          {
            name: 'generate_video',
            description: 'Generate a video using the user\'s selected video model. Model and provider are resolved automatically from the active selection.',
            inputSchema: {
              type: 'object',
              properties: {
                prompt: { type: 'string', description: 'Video description/prompt' },
                model: { type: 'string', description: 'Model ID override (e.g. veo-3, grok-imagine-video). When omitted, the active video model from the frontend picker is used.' },
                provider: { type: 'string', description: 'Provider override (e.g. "Google", "Grok", "Grok-SUB"). Use a `Grok-SUB*` value to route grok-imagine-video through subscription credit instead of API key.' },
                aspect_ratio: { type: 'string', description: 'Aspect ratio: "1:1", "9:16", "16:9"' },
                duration_secs: { type: 'number', description: 'Target duration in seconds (Veo: 5–8; Grok: varies)' },
                negative_prompt: { type: 'string', description: 'Elements to avoid in the video (Veo only)' },
                n: { type: 'number', description: 'Number of videos (default 1, Grok only)' }
              },
              required: ['prompt']
            }
          },
          {
            name: 'get_active_model',
            description: 'Get the active media model selections from the frontend model picker (image, video, audio).',
            inputSchema: { type: 'object', properties: {}, required: [] }
          },
          {
            name: 'list_exchange',
            description: 'List generated images/files in the exchange folder',
            inputSchema: { type: 'object', properties: {}, required: [] }
          }
        ]
      }
    });
  } else if (msg.method === 'tools/call') {
    handleToolCall(msg.id, msg.params.name, msg.params.arguments || {});
  } else if (msg.id !== undefined) {
    sendMessage({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } });
  }
}

process.stdin.on('data', (chunk) => {
  inputBuffer += _stdinDecoder.write(chunk);
  while (true) {
    const headerEnd = inputBuffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;
    const clMatch = inputBuffer.slice(0, headerEnd).match(/Content-Length:\s*(\d+)/i);
    if (!clMatch) { inputBuffer = inputBuffer.slice(headerEnd + 4); break; }
    const len = parseInt(clMatch[1], 10);
    const bodyStart = headerEnd + 4;
    if (inputBuffer.length < bodyStart + len) break;
    const body = inputBuffer.slice(bodyStart, bodyStart + len);
    inputBuffer = inputBuffer.slice(bodyStart + len);
    try { handleMessage(JSON.parse(body)); } catch (e) { /* ignore */ }
  }
});

process.stdin.on('end', () => { inputBuffer += _stdinDecoder.end(); process.exit(0); });
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
require('./_parent-watchdog').installParentWatchdog();

// ── Exchange folder ──────────────────────────────────────────────────────────

const EXCHANGE_DIR = path.join(__dirname, 'exchange');
if (!fs.existsSync(EXCHANGE_DIR)) fs.mkdirSync(EXCHANGE_DIR, { recursive: true });

// ── Tool dispatch ────────────────────────────────────────────────────────────

function handleToolCall(id, name, args) {
  (async () => {
    try {
      let result;
      if (name === 'generate_image') result = await toolGenerateImage(args);
      else if (name === 'generate_audio') result = await toolGenerateAudio(args);
      else if (name === 'generate_video') result = await toolGenerateVideo(args);
      else if (name === 'list_media_models') result = await toolListModels();
      else if (name === 'get_active_model') result = await toolGetActiveModel();
      else if (name === 'edit_image') result = await toolEditImage(args);
      else if (name === 'vary_image') result = await toolVaryImage(args);
      else if (name === 'list_exchange') result = toolListExchange();
      else throw new Error('Unknown tool: ' + name);

      sendMessage({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] }
      });
    } catch (e) {
      sendMessage({
        jsonrpc: '2.0', id,
        result: { content: [{ type: 'text', text: 'Error: ' + e.message }], isError: true }
      });
    }
  })();
}

// ── HTTPS helpers ────────────────────────────────────────────────────────────

function httpsPost(hostname, reqPath, data, apiKey, timeoutMs = 270000) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(data);
    const req = https.request({
      hostname, path: reqPath, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': 'Bearer ' + apiKey
      },
      timeout: timeoutMs,
    }, (res) => {
      let raw = '';
      res.on('data', d => { raw += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (e) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('HTTPS request timed out')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function httpsMultipart(hostname, reqPath, fields, files, apiKey) {
  return new Promise((resolve, reject) => {
    const boundary = '----Boundary' + crypto.randomUUID().replace(/-/g, '');
    const parts = [];

    for (const [k, v] of Object.entries(fields)) {
      parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + k + '"\r\n\r\n' + v + '\r\n'));
    }
    for (const [k, v] of Object.entries(files)) {
      parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + k + '"; filename="' + v.name + '"\r\nContent-Type: ' + v.type + '\r\n\r\n'));
      parts.push(Buffer.isBuffer(v.data) ? v.data : Buffer.from(v.data, 'base64'));
      parts.push(Buffer.from('\r\n'));
    }
    parts.push(Buffer.from('--' + boundary + '--\r\n'));

    const body = Buffer.concat(parts);
    const req = https.request({
      hostname, path: reqPath, method: 'POST',
      headers: {
        'Content-Type': 'multipart/form-data; boundary=' + boundary,
        'Content-Length': body.length,
        'Authorization': 'Bearer ' + apiKey
      }
    }, (res) => {
      let raw = '';
      res.on('data', d => { raw += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (e) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ── Tool implementations ─────────────────────────────────────────────────────

async function toolGetActiveModel() {
  const active = await fetchActiveModels();
  return {
    image: active.image  || { model: 'gpt-image-1.5', provider: 'OpenAI' },
    video: active.video  || null,
    audio: active.audio  || null,
    note:  'These reflect the model selections from the frontend model picker.'
  };
}

async function toolGenerateImage(args) {
  const cfg = loadConfig();
  let model = args.model;
  let provider = args.provider || '';
  if (!model) {
    const active = await fetchActiveModels();
    const imageState = active.image?.model ? active.image : { model: 'gpt-image-1.5', provider: 'OpenAI' };
    model = imageState.model;
    if (!provider) provider = imageState.provider || '';
  }

  const mid = model.toLowerCase();
  // Nano Banana aliases resolve to current Gemini image models; everything Gemini-based uses generateContent.
  // Only true imagen-* IDs use the :predict endpoint (and those sunset 2026-06-24).
  const nanoAlias = {
    'nano-banana-pro-preview': 'gemini-3-pro-image-preview',
    'nano-banana-pro': 'gemini-3-pro-image-preview',
    'nano-banana-2': 'gemini-3.1-flash-image-preview',
    'nano-banana': 'gemini-2.5-flash-image'
  };
  const resolved = nanoAlias[mid] || model;
  const rid = resolved.toLowerCase();

  // Provider takes precedence over model-id sniffing: a grok-imagine-* model
  // tagged `Grok-SUB*` is billed against subscription, not the API key.
  const subIdx = grokSubInstanceIndex(provider);
  if (subIdx >= 0 && /grok-imagine/.test(rid)) {
    return generateImageGrokSub(subIdx, resolved, args);
  }

  if (/^imagen/.test(rid)) {
    return generateImageImagen(cfg, resolved, args);
  } else if (/^gemini/.test(rid)) {
    return generateImageGemini(cfg, resolved, args);
  } else if (/grok-imagine/.test(rid)) {
    return generateImageGrok(cfg, resolved, args);
  } else {
    return generateImageOpenAI(cfg, resolved, args);
  }
}

async function generateImageOpenAI(cfg, model, args) {
  if (!cfg.openai_key) throw new Error('No OpenAI API key found in bridge/config.json');
  if (/^dall-e/i.test(model)) {
    throw new Error('DALL-E models (dall-e-2, dall-e-3) were shut down on 2026-05-12. Pick a gpt-image-* model in the model switcher.');
  }

  const sizeFromAR = (ar) => {
    if (ar === '9:16' || ar === '3:4') return '1024x1536';
    if (ar === '16:9' || ar === '4:3') return '1536x1024';
    return '1024x1024';
  };

  const fmt = args.output_format || 'png';
  const payload = {
    model,
    prompt: args.prompt,
    n: args.n || 1,
    size: args.size || sizeFromAR(args.aspect_ratio),
    output_format: fmt,
  };
  if (args.quality) payload.quality = args.quality;
  if (args.background === true) payload.background = 'transparent';
  // gpt-image-* always returns b64 in data[].b64_json — response_format is rejected by these models.

  const resp = await httpsPost('api.openai.com', '/v1/images/generations', payload, cfg.openai_key);
  if (resp.status !== 200) throw new Error('OpenAI error ' + resp.status + ': ' + JSON.stringify(resp.body));

  const saved = resp.body.data.map((img, i) => {
    const fname = 'img_' + Date.now() + '_' + i + '.' + fmt;
    fs.writeFileSync(path.join(EXCHANGE_DIR, fname), Buffer.from(img.b64_json, 'base64'));
    return { filename: fname, path: path.join(EXCHANGE_DIR, fname), revised_prompt: img.revised_prompt || args.prompt };
  });
  return { model, size: payload.size, images: saved, message: 'Generated ' + saved.length + ' image(s). The image is displayed automatically in the chat — do NOT mention the filename or write any img/markdown tags.' };
}

async function generateImageGemini(cfg, model, args) {
  if (!cfg.google_key) throw new Error('No Google API key found in bridge/config.json');
  // Gemini generateContent does not support imageGenerationConfig — encode aspect ratio and style in prompt
  const arHint = args.aspect_ratio ? ` [aspect ratio ${args.aspect_ratio}]` : '';
  const styleHint = args.style_hint ? `, ${args.style_hint} style` : '';
  const body = JSON.stringify({
    contents: [{ parts: [{ text: args.prompt + arHint + styleHint }] }],
    generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
  });
  const resp = await new Promise((resolve, reject) => {
    const path_ = `/v1beta/models/${model}:generateContent?key=${cfg.google_key}`;
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: path_, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 120000,
    }, (res) => {
      let raw = '';
      res.on('data', d => { raw += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (e) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Gemini image request timed out')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  if (resp.status !== 200) throw new Error('Google Gemini error ' + resp.status + ': ' + JSON.stringify(resp.body));

  const parts = resp.body.candidates?.[0]?.content?.parts || [];
  const saved = [];
  parts.forEach((part, i) => {
    if (!part.inlineData) return;
    const mime = part.inlineData.mimeType || 'image/png';
    const ext = mime.split('/')[1] || 'png';
    const fname = 'img_' + Date.now() + '_' + i + '.' + ext;
    fs.writeFileSync(path.join(EXCHANGE_DIR, fname), Buffer.from(part.inlineData.data, 'base64'));
    saved.push({ filename: fname, path: path.join(EXCHANGE_DIR, fname) });
  });
  if (!saved.length) throw new Error('Gemini returned no image parts. Response: ' + JSON.stringify(resp.body).slice(0, 300));
  return { model, images: saved, message: 'Generated ' + saved.length + ' image(s). The image is displayed automatically in the chat — do NOT mention the filename or write any img/markdown tags.' };
}

async function generateImageImagen(cfg, model, args) {
  if (!cfg.google_key) throw new Error('No Google API key found in bridge/config.json');
  const n = args.n || 1;
  const body = JSON.stringify({
    instances: [{ prompt: args.prompt }],
    parameters: { sampleCount: n, ...(args.aspect_ratio ? { aspectRatio: args.aspect_ratio } : {}) }
  });
  const resp = await new Promise((resolve, reject) => {
    const path_ = `/v1beta/models/${model}:predict?key=${cfg.google_key}`;
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: path_, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 120000,
    }, (res) => {
      let raw = '';
      res.on('data', d => { raw += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (e) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Imagen request timed out')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  if (resp.status !== 200) throw new Error('Google error ' + resp.status + ': ' + JSON.stringify(resp.body));

  const predictions = resp.body.predictions || [];
  const saved = predictions.map((pred, i) => {
    const b64 = pred.bytesBase64Encoded;
    const mime = pred.mimeType || 'image/png';
    const ext = mime.split('/')[1] || 'png';
    const fname = 'img_' + Date.now() + '_' + i + '.' + ext;
    fs.writeFileSync(path.join(EXCHANGE_DIR, fname), Buffer.from(b64, 'base64'));
    return { filename: fname, path: path.join(EXCHANGE_DIR, fname) };
  });
  return {
    model,
    images: saved,
    deprecation_warning: 'imagen-* models sunset on 2026-06-24. Switch to a Gemini image model (e.g. gemini-3-pro-image-preview) in the model picker before then.',
    message: 'Generated ' + saved.length + ' image(s). The image is displayed automatically in the chat — do NOT mention the filename or write any img/markdown tags.'
  };
}

async function generateImageGrok(cfg, model, args) {
  if (!cfg.grok_key) throw new Error('No Grok/xAI API key found in bridge/config.json');
  const payload = { model, prompt: args.prompt, n: args.n || 1 };

  const resp = await httpsPost('api.x.ai', '/v1/images/generations', payload, cfg.grok_key);
  if (resp.status !== 200) throw new Error('Grok error ' + resp.status + ': ' + JSON.stringify(resp.body));

  const saved = resp.body.data.map((img, i) => {
    const fname = 'img_' + Date.now() + '_' + i + '.png';
    if (img.b64_json) {
      fs.writeFileSync(path.join(EXCHANGE_DIR, fname), Buffer.from(img.b64_json, 'base64'));
    } else if (img.url) {
      // url-based response — return url directly
      return { filename: fname, url: img.url };
    }
    return { filename: fname, path: path.join(EXCHANGE_DIR, fname) };
  });
  return { model, images: saved, message: 'Generated ' + saved.length + ' image(s). The image is displayed automatically in the chat — do NOT mention the filename or write any img/markdown tags.' };
}

// Grok-SUB image: same xAI endpoint as the API-key path, but the Authorization
// header carries the user's OAuth access token from auth.json instead of the
// team API key. Subscription credit is consumed; no API charge.
async function generateImageGrokSub(instanceIndex, model, args) {
  const tok = loadGrokSubToken(instanceIndex);
  if (!tok) throw new Error('No Grok subscription token found for instance index ' + instanceIndex + ' (check auth.json in the grokInstance configDir).');

  const payload = { model, prompt: args.prompt, n: args.n || 1 };
  const resp = await httpsPost('api.x.ai', '/v1/images/generations', payload, tok.token);
  if (resp.status !== 200) {
    throw new Error('Grok-SUB image error ' + resp.status + ' (instance "' + tok.label + '"): ' + JSON.stringify(resp.body).slice(0, 400));
  }

  const saved = (resp.body.data || []).map((img, i) => {
    const fname = 'img_' + Date.now() + '_' + i + '.png';
    if (img.b64_json) {
      fs.writeFileSync(path.join(EXCHANGE_DIR, fname), Buffer.from(img.b64_json, 'base64'));
      return { filename: fname, path: path.join(EXCHANGE_DIR, fname) };
    }
    if (img.url) return { filename: fname, url: img.url };
    return { filename: fname };
  });
  return {
    model,
    provider: instanceIndex === 0 ? 'Grok-SUB' : 'Grok-SUB' + (instanceIndex + 1),
    instance: tok.label,
    images: saved,
    message: 'Generated ' + saved.length + ' image(s) via grok subscription (' + (tok.label || 'default') + '). Displayed automatically — do NOT mention filenames or write img/markdown tags.',
  };
}

// ── Audio generation ─────────────────────────────────────────────────────────

async function toolGenerateAudio(args) {
  const cfg = loadConfig();
  const active = await fetchActiveModels();
  const model = active.audio?.model;
  if (!model) throw new Error('No audio model selected. Please pick one in the model switcher.');
  const mid = model.toLowerCase();
  // Matches lyria-3-pro-preview (Google direct) and google/lyria-* (OpenRouter)
  if (/^lyria/.test(mid) || /google\/lyria/.test(mid)) return generateAudioLyria(cfg, model.replace(/^google\//, ''), args);
  if (/^(tts-|gpt-4o-mini-tts)/.test(mid)) return generateAudioOpenAITTS(cfg, model, args);
  if (/^gemini.*tts/.test(mid)) return generateAudioGeminiTTS(cfg, model, args);
  throw new Error('Unsupported audio model: ' + model);
}

async function generateAudioLyria(cfg, model, args) {
  if (!cfg.google_key) throw new Error('No Google API key found in bridge/config.json');

  let prompt = args.prompt || '';
  if (args.style_genre) prompt += ` Style: ${args.style_genre}.`;
  if (args.bpm) prompt += ` BPM: ${args.bpm}.`;
  if (args.duration_secs) prompt += ` Duration: approximately ${args.duration_secs} seconds.`;
  if (args.avoid) prompt += ` Avoid: ${args.avoid}.`;

  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
    }
  });

  const resp = await new Promise((resolve, reject) => {
    const p = `/v1beta/models/${model}:generateContent?key=${cfg.google_key}`;
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 270000,
    }, (res) => {
      let raw = '';
      res.on('data', d => { raw += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (e) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Lyria request timed out after 4.5 minutes')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  if (resp.status !== 200) throw new Error('Google Lyria error ' + resp.status + ': ' + JSON.stringify(resp.body).slice(0, 400));

  const parts = resp.body.candidates?.[0]?.content?.parts || [];
  const saved = [];
  parts.forEach((part, i) => {
    if (!part.inlineData) return;
    const mime = part.inlineData.mimeType || 'audio/mpeg';
    const ext = mime.includes('mpeg') ? 'mp3' : (mime.split('/')[1] || 'mp3');
    const fname = 'audio_' + Date.now() + '_' + i + '.' + ext;
    fs.writeFileSync(path.join(EXCHANGE_DIR, fname), Buffer.from(part.inlineData.data, 'base64'));
    saved.push({ filename: fname, path: path.join(EXCHANGE_DIR, fname) });
  });
  if (!saved.length) throw new Error('Lyria returned no audio parts. Response: ' + JSON.stringify(resp.body).slice(0, 400));
  return { model, audio: saved, message: 'Generated audio track saved as ' + saved.map(s => s.filename).join(', ') + '. The audio player will display it automatically.' };
}

async function generateAudioOpenAITTS(cfg, model, args) {
  if (!cfg.openai_key) throw new Error('No OpenAI API key found in bridge/config.json');
  const fmt = args.format || 'mp3';
  const payload = {
    model,
    input: args.prompt,
    voice: args.voice || 'alloy',
    speed: args.speed || 1.0,
    response_format: fmt
  };
  if (args.voice_instructions) payload.voice_instructions = args.voice_instructions;

  const audioBuffer = await new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.openai.com',
      path: '/v1/audio/speech', method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        'Authorization': 'Bearer ' + cfg.openai_key
      }
    }, (res) => {
      const chunks = [];
      res.on('data', d => chunks.push(d));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (res.statusCode !== 200) {
          reject(new Error('OpenAI TTS error ' + res.statusCode + ': ' + buf.toString('utf8').slice(0, 300)));
        } else {
          resolve(buf);
        }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  const fname = 'tts_' + Date.now() + '.' + fmt;
  fs.writeFileSync(path.join(EXCHANGE_DIR, fname), audioBuffer);
  return { model, audio: [{ filename: fname, path: path.join(EXCHANGE_DIR, fname) }], message: 'Generated TTS audio saved as ' + fname + '.' };
}

async function generateAudioGeminiTTS(cfg, model, args) {
  if (!cfg.google_key) throw new Error('No Google API key found in bridge/config.json');

  const fmt = args.output_format || 'mp3';
  const encoding = fmt === 'wav' ? 'LINEAR16' : fmt === 'flac' ? 'FLAC' : fmt === 'aac' ? 'AAC' : fmt === 'opus' ? 'OPUS' : 'MP3';

  const body = JSON.stringify({
    contents: [{ parts: [{ text: args.prompt || '' }] }],
    generationConfig: {
      responseModalities: ['AUDIO'],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName: args.voice || 'Aoede' }
        }
      },
      audioConfig: { audioEncoding: encoding }
    }
  });

  const resp = await new Promise((resolve, reject) => {
    const p = `/v1beta/models/${model}:generateContent?key=${cfg.google_key}`;
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 120000,
    }, (res) => {
      let raw = '';
      res.on('data', d => { raw += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (e) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Gemini TTS request timed out')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  if (resp.status !== 200) throw new Error('Gemini TTS error ' + resp.status + ': ' + JSON.stringify(resp.body).slice(0, 400));

  const parts = resp.body.candidates?.[0]?.content?.parts || [];
  const saved = [];
  parts.forEach((part, i) => {
    if (!part.inlineData) return;
    const ext = fmt;
    const fname = 'tts_' + Date.now() + '_' + i + '.' + ext;
    fs.writeFileSync(path.join(EXCHANGE_DIR, fname), Buffer.from(part.inlineData.data, 'base64'));
    saved.push({ filename: fname, path: path.join(EXCHANGE_DIR, fname) });
  });
  if (!saved.length) throw new Error('Gemini TTS returned no audio. Response: ' + JSON.stringify(resp.body).slice(0, 400));
  return { model, audio: saved, message: 'Generated TTS audio saved as ' + saved.map(s => s.filename).join(', ') + '.' };
}

// ── Video generation ─────────────────────────────────────────────────────────

async function toolGenerateVideo(args) {
  const cfg = loadConfig();
  let model = args.model;
  let provider = args.provider || '';
  if (!model) {
    const active = await fetchActiveModels();
    if (!active.video?.model) throw new Error('No video model selected. Please pick one in the model switcher.');
    model = active.video.model;
    if (!provider) provider = active.video.provider || '';
  }
  const mid = model.toLowerCase();

  const subIdx = grokSubInstanceIndex(provider);
  if (subIdx >= 0 && /grok-imagine-video/.test(mid)) {
    return generateVideoGrokSub(subIdx, model, args);
  }

  if (/grok-imagine-video/.test(mid)) return generateVideoGrok(cfg, model, args);
  if (/^veo/.test(mid)) return generateVideoVeo(cfg, model, args);
  throw new Error('Unsupported video model: ' + model + '. No video generation handler for this model yet.');
}

async function generateVideoGrok(cfg, model, args) {
  if (!cfg.grok_key) throw new Error('No Grok/xAI API key found in bridge/config.json');
  const payload = { model, prompt: args.prompt, n: args.n || 1 };
  if (args.aspect_ratio) payload.aspect_ratio = args.aspect_ratio;
  if (args.duration_secs) payload.duration = args.duration_secs;

  const resp = await httpsPost('api.x.ai', '/v1/video/generations', payload, cfg.grok_key);
  if (resp.status !== 200) throw new Error('Grok video error ' + resp.status + ': ' + JSON.stringify(resp.body).slice(0, 400));

  const videos = resp.body.data || [];
  const saved = videos.map((vid, i) => {
    const fname = 'video_' + Date.now() + '_' + i + '.mp4';
    if (vid.b64_json) {
      fs.writeFileSync(path.join(EXCHANGE_DIR, fname), Buffer.from(vid.b64_json, 'base64'));
      return { filename: fname, path: path.join(EXCHANGE_DIR, fname) };
    }
    if (vid.url) return { filename: fname, url: vid.url };
    return { raw: vid };
  });
  return { model, videos: saved, message: 'Generated ' + saved.length + ' video(s).' };
}

// Grok-SUB video: OAuth-billed counterpart of generateVideoGrok.
async function generateVideoGrokSub(instanceIndex, model, args) {
  const tok = loadGrokSubToken(instanceIndex);
  if (!tok) throw new Error('No Grok subscription token found for instance index ' + instanceIndex + ' (check auth.json in the grokInstance configDir).');

  const payload = { model, prompt: args.prompt, n: args.n || 1 };
  if (args.aspect_ratio) payload.aspect_ratio = args.aspect_ratio;
  if (args.duration_secs) payload.duration = args.duration_secs;

  const resp = await httpsPost('api.x.ai', '/v1/video/generations', payload, tok.token);
  if (resp.status !== 200) {
    throw new Error('Grok-SUB video error ' + resp.status + ' (instance "' + tok.label + '"): ' + JSON.stringify(resp.body).slice(0, 400));
  }

  const saved = (resp.body.data || []).map((vid, i) => {
    const fname = 'video_' + Date.now() + '_' + i + '.mp4';
    if (vid.b64_json) {
      fs.writeFileSync(path.join(EXCHANGE_DIR, fname), Buffer.from(vid.b64_json, 'base64'));
      return { filename: fname, path: path.join(EXCHANGE_DIR, fname) };
    }
    if (vid.url) return { filename: fname, url: vid.url };
    return { filename: fname };
  });
  return {
    model,
    provider: instanceIndex === 0 ? 'Grok-SUB' : 'Grok-SUB' + (instanceIndex + 1),
    instance: tok.label,
    videos: saved,
    message: 'Generated ' + saved.length + ' video(s) via grok subscription (' + (tok.label || 'default') + ').',
  };
}

async function generateVideoVeo(cfg, model, args) {
  if (!cfg.google_key) throw new Error('No Google API key found in bridge/config.json');

  let text = args.prompt || '';
  if (args.negative_prompt) text += ` Avoid: ${args.negative_prompt}.`;
  if (args.aspect_ratio && args.aspect_ratio !== '16:9') text += ` Aspect ratio: ${args.aspect_ratio}.`;

  const body = JSON.stringify({
    contents: [{ parts: [{ text }] }],
    generationConfig: {
      responseModalities: ['video'],
    }
  });

  const resp = await new Promise((resolve, reject) => {
    const p = `/v1beta/models/${model}:generateContent?key=${cfg.google_key}`;
    const req = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: p, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 300000,
    }, (res) => {
      let raw = '';
      res.on('data', d => { raw += d; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch (e) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('timeout', () => { req.destroy(new Error('Veo request timed out after 5 minutes')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });

  if (resp.status !== 200) throw new Error('Veo error ' + resp.status + ': ' + JSON.stringify(resp.body).slice(0, 400));

  const parts = resp.body.candidates?.[0]?.content?.parts || [];
  const saved = [];
  for (const [i, part] of parts.entries()) {
    if (part.inlineData) {
      const mime = part.inlineData.mimeType || 'video/mp4';
      const ext = mime.split('/')[1]?.split(';')[0] || 'mp4';
      const fname = 'video_' + Date.now() + '_' + i + '.' + ext;
      fs.writeFileSync(path.join(EXCHANGE_DIR, fname), Buffer.from(part.inlineData.data, 'base64'));
      saved.push({ filename: fname, path: path.join(EXCHANGE_DIR, fname) });
    } else if (part.fileData?.fileUri) {
      saved.push({ filename: 'veo_' + Date.now() + '_' + i + '.mp4', url: part.fileData.fileUri });
    }
  }
  if (!saved.length) throw new Error('Veo returned no video data. Response: ' + JSON.stringify(resp.body).slice(0, 400));
  return { model, videos: saved, message: 'Generated ' + saved.length + ' video(s).' };
}

async function toolListModels() {
  const active = await fetchActiveModels();
  return {
    active_image_model: active.image?.model || null,
    active_image_provider: active.image?.provider || null,
    note: 'generate_image will use the active_image_model automatically. This hint list is not exhaustive — the model picker pulls live data from each provider.',
    models: [
      {
        id: 'gpt-image-2',
        provider: 'OpenAI',
        capabilities: ['text-to-image', 'edit'],
        sizes: ['1024x1024', '1024x1536', '1536x1024'],
        quality_options: ['low', 'medium', 'high', 'auto']
      },
      {
        id: 'gpt-image-1.5',
        provider: 'OpenAI',
        capabilities: ['text-to-image', 'edit', 'transparent_background'],
        sizes: ['1024x1024', '1024x1536', '1536x1024'],
        quality_options: ['low', 'medium', 'high', 'auto']
      },
      {
        id: 'gpt-image-1',
        provider: 'OpenAI',
        capabilities: ['text-to-image', 'edit', 'transparent_background'],
        sizes: ['1024x1024', '1024x1536', '1536x1024'],
        quality_options: ['low', 'medium', 'high', 'auto']
      },
      {
        id: 'gpt-image-1-mini',
        provider: 'OpenAI',
        capabilities: ['text-to-image'],
        sizes: ['1024x1024', '1024x1536', '1536x1024']
      },
      {
        id: 'gemini-3-pro-image-preview',
        provider: 'Google',
        aliases: ['nano-banana-pro-preview', 'nano-banana-pro'],
        capabilities: ['text-to-image', 'edit_with_reference']
      },
      {
        id: 'gemini-3.1-flash-image-preview',
        provider: 'Google',
        aliases: ['nano-banana-2'],
        capabilities: ['text-to-image', 'edit_with_reference']
      },
      {
        id: 'gemini-2.5-flash-image',
        provider: 'Google',
        aliases: ['nano-banana'],
        capabilities: ['text-to-image']
      },
      {
        id: 'imagen-*',
        provider: 'Google',
        capabilities: ['text-to-image'],
        deprecation: 'All imagen-* models sunset 2026-06-24. Use a gemini-* image model instead.'
      },
      {
        id: 'grok-imagine-image-pro',
        provider: 'Grok',
        capabilities: ['text-to-image']
      },
      {
        id: 'grok-imagine-image',
        provider: 'Grok',
        capabilities: ['text-to-image']
      }
    ]
  };
}

async function toolEditImage(args) {
  const cfg = loadConfig();
  if (!cfg.openai_key) throw new Error('No OpenAI API key found in bridge/config.json');

  const files = {
    image: { name: 'image.png', type: 'image/png', data: args.image_base64 }
  };
  if (args.mask_base64) {
    files.mask = { name: 'mask.png', type: 'image/png', data: args.mask_base64 };
  }

  const resp = await httpsMultipart('api.openai.com', '/v1/images/edits', {
    prompt: args.prompt,
    n: '1',
    size: args.size || '1024x1024',
    response_format: 'b64_json'
  }, files, cfg.openai_key);

  if (resp.status !== 200) throw new Error('OpenAI error ' + resp.status + ': ' + JSON.stringify(resp.body));

  const fname = 'edit_' + Date.now() + '.png';
  fs.writeFileSync(path.join(EXCHANGE_DIR, fname), Buffer.from(resp.body.data[0].b64_json, 'base64'));
  return { filename: fname, path: path.join(EXCHANGE_DIR, fname) };
}

async function toolVaryImage(args) {
  const cfg = loadConfig();
  if (!cfg.openai_key) throw new Error('No OpenAI API key found in bridge/config.json');

  const resp = await httpsMultipart('api.openai.com', '/v1/images/variations', {
    n: String(args.n || 1),
    size: args.size || '1024x1024',
    response_format: 'b64_json'
  }, {
    image: { name: 'image.png', type: 'image/png', data: args.image_base64 }
  }, cfg.openai_key);

  if (resp.status !== 200) throw new Error('OpenAI error ' + resp.status + ': ' + JSON.stringify(resp.body));

  const saved = resp.body.data.map((img, i) => {
    const fname = 'vary_' + Date.now() + '_' + i + '.png';
    fs.writeFileSync(path.join(EXCHANGE_DIR, fname), Buffer.from(img.b64_json, 'base64'));
    return { filename: fname, path: path.join(EXCHANGE_DIR, fname) };
  });
  return { images: saved };
}

function toolListExchange() {
  try {
    return fs.readdirSync(EXCHANGE_DIR).map(f => {
      const stat = fs.statSync(path.join(EXCHANGE_DIR, f));
      return { name: f, size: stat.size, modified: stat.mtime.toISOString() };
    });
  } catch (e) {
    return [];
  }
}
