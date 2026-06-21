// ── Proxy routes for Anthropic-compatible provider translation ────────────────
'use strict';

const logger = require('../core/logger');
const { findProvider, isGeminiModel } = require('../providers');
const {
  proxyCallOpenAI,
  proxyCallGemini,
  proxyStreamOpenAI,
  proxyStreamGemini,
} = require('../chat/translation');
const { logRaw } = require('../observability/raw-logs');
const { BRIDGE_INTERNAL_KEY } = require('../core/state');
const { timingSafeEqualStr } = require('../core/secure-compare');

function registerProxyRoutes(app) {
  app.post('/proxy/:externalModel/v1/messages', async (req, res) => {
    // Validate bridge-internal API key — reject unauthenticated callers.
    // Only subprocesses spawned by this bridge instance know the random key.
    const authHeader = String(req.headers['x-api-key'] || req.headers['authorization'] || '');
    const token =
      authHeader.startsWith('Bearer ') ? authHeader.slice(7) :
      authHeader.startsWith('x-api-key ') ? authHeader.slice(10) :
      authHeader;
    if (!timingSafeEqualStr(token, BRIDGE_INTERNAL_KEY) && !timingSafeEqualStr(token, `Bearer ${BRIDGE_INTERNAL_KEY}`)) {
      // Also accept the old env key if explicitly set (backwards compat)
      const envKey = process.env.ANTHROPIC_API_KEY;
      if (!envKey || !timingSafeEqualStr(token, envKey)) {
        return res.status(401).json({
          type: 'error',
          error: { type: 'authentication_error', message: 'Unauthorized: invalid bridge API key' },
        });
      }
    }

    const modelId = decodeURIComponent(req.params.externalModel);
    const body = req.body;
    const stream = body.stream === true;

    if (!body || typeof body !== 'object') {
      return res
        .status(400)
        .json({
          type: 'error',
          error: { type: 'invalid_request', message: 'Request body must be a JSON object' },
        });
    }
    if (!Array.isArray(body.messages)) {
      return res
        .status(400)
        .json({
          type: 'error',
          error: { type: 'invalid_request', message: 'Messages must be an array' },
        });
    }
    if (body.messages.length === 0) {
      return res
        .status(400)
        .json({
          type: 'error',
          error: { type: 'invalid_request', message: 'Messages array must not be empty' },
        });
    }
    for (const msg of body.messages) {
      if (!msg || typeof msg.role !== 'string') {
        return res
          .status(400)
          .json({
            type: 'error',
            error: { type: 'invalid_request', message: 'Each message must have a role' },
          });
      }
    }

    const sysPreview = typeof body.system === 'string' ? body.system.slice(0, 80) : '';
    logger.info('proxy.request', { modelId, stream, msgs: body.messages?.length, tools: body.tools?.length || 0, sys: sysPreview });
    logRaw('model', 'in', body, { route: '/proxy/:externalModel/v1/messages', modelId, stream });

    const found = findProvider(modelId);
    if (!found) {
      const err = {
        type: 'error',
        error: { type: 'not_found_error', message: `Unknown model: ${modelId}` },
      };
      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.write(`event: error\ndata: ${JSON.stringify(err)}\n\n`);
        return res.end();
      }
      return res.status(400).json(err);
    }

    try {
      // Dispatch by the provider's explicit api_style (set on its config entry).
      // Falls back to the model-name regex when the provider has no style set —
      // mirrors the previous isGeminiModel() routing.
      const style = found.provider?.api_style || (isGeminiModel(modelId) ? 'google' : 'openai');
      if (stream) {
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.flushHeaders();
        if (style === 'google') await proxyStreamGemini(body, modelId, found.provider, res);
        else await proxyStreamOpenAI(body, modelId, found.provider, res);
        return;
      }

      const resp = style === 'google'
        ? await proxyCallGemini(body, modelId, found.provider)
        : await proxyCallOpenAI(body, modelId, found.provider);
      logRaw('model', 'out', resp, {
        route: '/proxy/:externalModel/v1/messages',
        modelId,
        stream: false,
      });
      res.json(resp);
    } catch (e) {
      logger.error('proxy.error', { modelId, error: e instanceof Error ? e.message : String(e) });
      logRaw('model', 'out', e.message, {
        route: '/proxy/:externalModel/v1/messages',
        modelId,
        stream,
        error: true,
      });
      const err = { type: 'error', error: { type: 'api_error', message: e.message } };
      if (stream) {
        if (!res.headersSent) {
          res.setHeader('Content-Type', 'text/event-stream');
          res.flushHeaders();
        }
        res.write(`event: error\ndata: ${JSON.stringify(err)}\n\n`);
        res.end();
      } else {
        res.status(500).json(err);
      }
    }
  });
}

module.exports = {
  registerProxyRoutes,
};
