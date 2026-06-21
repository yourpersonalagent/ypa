// harness-direct-api — module wrapper around the three direct-API
// streamers (OpenAI-compat, Gemini, Anthropic API).
//
// Why one harness covers three providers: the chat dispatcher already
// branches on `mainRoute.type` (external | direct-anthropic) and on
// `isGeminiModel(...)` to pick the right streamer. Wrapping those
// three callers under a single register entry keeps the existing
// dispatch ladder structure intact; reorganising into three separate
// register entries would require restructuring resolveRouteType()
// — explicitly out of scope per the batch instructions ("Don't change
// config-resolution logic").
//
// Why the source isn't moved: bridge/tools/stream.ts also hosts the
// tool-loop drainer (handleHashTool), btw-queue integration, and the
// shared `BridgeInputError` plumbing. Splitting the streamers off
// would mean fragmenting that shared infrastructure; out of scope.
'use strict';

const {
  streamDirectOpenAI,
  streamDirectGemini,
  streamDirectAnthropic,
} = require('../../tools/stream');

interface HarnessDirectApiApi {
  name: string;
}

module.exports = function harnessDirectApiFactory() {
  return {
    activate(ctx: any): HarnessDirectApiApi {
      ctx.registers.harnesses.add(
        {
          id: 'direct-api',
          label: 'Direct API',
          // streamDirectOpenAI is the canonical handler; gemini +
          // anthropic are sibling fields the dispatcher can pick by
          // model family.
          stream: streamDirectOpenAI,
          streamGemini: streamDirectGemini,
          streamAnthropic: streamDirectAnthropic,
        },
        ctx.name,
      );
      ctx.logger.info('registered harness "direct-api"');
      return { name: ctx.name };
    },
    deactivate() {
      // Register entry auto-removed by ctx.dispose().
    },
  };
};
