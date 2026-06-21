// audio-tts-openai — proxies OpenAI Text-to-Speech.
//
// Why a proxy and not a direct browser fetch: the OpenAI api_key lives in
// bridge config / .env and must not leak into the SPA. The browser sends
// { text, voice?, model?, format? } to /v1/tts/openai; the bridge attaches
// Authorization and streams the audio response back unchanged.
//
// No streaming chunking on the bridge side beyond the underlying fetch
// Response.body — OpenAI's /audio/speech is a single-shot HTTP response,
// not an SSE stream. We forward Content-Type so the frontend's
// HTMLAudioElement can play it directly.
'use strict';

const { config } = require('../../core/state');
const { recordTokens } = require('../observability-plus/tokens');
const { recordCost }   = require('../observability-plus/costs');

// Models per https://platform.openai.com/docs/guides/text-to-speech
// gpt-4o-mini-tts is the cheap/fast default; tts-1-hd is higher quality.
const DEFAULT_MODEL = 'gpt-4o-mini-tts';
const DEFAULT_VOICE = 'alloy';
const DEFAULT_FORMAT = 'mp3';

// USD per 1M characters. OpenAI bills TTS per input character, not per token.
// Hardcoded because the model registry has no per-char price field and these
// rates change rarely. Falls back to gpt-4o-mini-tts when an unknown model id
// is supplied. Recorded into tokens.json as `inputTokens` (a known small lie
// — 1 char = 1 "token") so it surfaces in the cost-tab without new plumbing.
const TTS_PRICE_PER_MILLION_CHARS: Record<string, number> = {
  'gpt-4o-mini-tts': 0.60,
  'tts-1':           15.00,
  'tts-1-hd':        30.00,
};

const ALLOWED_VOICES = new Set([
  'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable',
  'nova', 'onyx', 'sage', 'shimmer', 'verse',
]);
const ALLOWED_FORMATS = new Set(['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm']);
const FORMAT_MIME: Record<string, string> = {
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'audio/L16',
};
const MAX_TEXT_LEN = 4096; // OpenAI's documented cap for /audio/speech.

function findOpenAiKey(): string | null {
  const providers = (config && config.providers) || [];
  const p = providers.find((x: any) => x && x.name === 'OpenAI');
  const k = p && typeof p.api_key === 'string' ? p.api_key.trim() : '';
  if (k && k !== 'YOUR_OPENAI_API_KEY_HERE') return k;
  // Fall back to env directly — useful when the user has set
  // OPENAI_API_KEY in .env but hasn't run the boot migration yet.
  return process.env.OPENAI_API_KEY ? process.env.OPENAI_API_KEY : null;
}

function registerTtsRoute(app: any, logger: any): void {
  app.post('/v1/tts/openai', async (req: any, res: any) => {
    try {
      const body = (req.body || {}) as {
        text?: unknown; voice?: unknown; model?: unknown; format?: unknown; speed?: unknown;
      };

      const text = typeof body.text === 'string' ? body.text : '';
      if (!text.trim()) {
        res.status(400).json({ success: false, error: 'text is required' });
        return;
      }
      if (text.length > MAX_TEXT_LEN) {
        res.status(400).json({
          success: false,
          error: `text exceeds ${MAX_TEXT_LEN} characters (got ${text.length})`,
        });
        return;
      }

      const voice = typeof body.voice === 'string' && ALLOWED_VOICES.has(body.voice)
        ? body.voice : DEFAULT_VOICE;
      const model = typeof body.model === 'string' && body.model
        ? body.model : DEFAULT_MODEL;
      const format = typeof body.format === 'string' && ALLOWED_FORMATS.has(body.format)
        ? body.format : DEFAULT_FORMAT;
      const speed = typeof body.speed === 'number' && body.speed >= 0.25 && body.speed <= 4.0
        ? body.speed : undefined;

      const apiKey = findOpenAiKey();
      if (!apiKey) {
        res.status(503).json({
          success: false,
          error: 'OpenAI api_key not configured — set it under Settings → Providers → OpenAI.',
        });
        return;
      }

      const upstream = await fetch('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model,
          voice,
          input: text,
          response_format: format,
          ...(speed !== undefined ? { speed } : {}),
        }),
      });

      if (!upstream.ok) {
        // Surface OpenAI's error JSON verbatim so the frontend can show
        // the real message (bad key, rate limit, content policy, etc.).
        const errBody = await upstream.text().catch(() => '');
        let parsed: unknown = errBody;
        try { parsed = JSON.parse(errBody); } catch { /* keep text */ }
        res.status(upstream.status).json({
          success: false,
          error: 'OpenAI TTS upstream failure',
          status: upstream.status,
          detail: parsed,
        });
        return;
      }

      const buf = Buffer.from(await upstream.arrayBuffer());
      res.setHeader('Content-Type', FORMAT_MIME[format] || 'application/octet-stream');
      res.setHeader('Content-Length', String(buf.length));
      // Audio bytes change with input; tell the browser not to cache.
      res.setHeader('Cache-Control', 'no-store');
      res.status(200).end(buf);

      try {
        const chars = text.length;
        recordTokens({ inputTokens: chars, model, provider: 'OpenAI' });
        const rate = TTS_PRICE_PER_MILLION_CHARS[model]
          ?? TTS_PRICE_PER_MILLION_CHARS[DEFAULT_MODEL];
        const cost = (chars / 1_000_000) * rate;
        if (cost > 0) recordCost(cost, model, 'OpenAI');
      } catch (e: unknown) {
        logger.warn(`[audio-tts-openai] usage-record failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error(`[audio-tts-openai] ${msg}`);
      res.status(500).json({ success: false, error: msg });
    }
  });
}

module.exports = function audioTtsOpenaiFactory() {
  return {
    activate(ctx: any) {
      registerTtsRoute(ctx.app, ctx.logger);
      ctx.logger.info('mounted POST /v1/tts/openai on global app');
      return { name: ctx.name };
    },
    deactivate() {
      // No-op — Express has no built-in route-removal.
      // lifecycle.reload=idle-only in module.json.
    },
  };
};
