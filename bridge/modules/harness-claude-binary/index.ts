// harness-claude-binary — module wrapper around the `claude` CLI
// subprocess harness (the legacy `--print` path).
//
// The actual harness implementation stays at
// `bridge/providers/claude-{run,stream}.ts` because:
//   1. claude-stream.ts has tight internal coupling with claude-run.ts
//      (`getNiceness` is shared; both reach into provider/core.ts for
//      EFFORT_LEVELS, plugin dirs, agents.json, perm-denied patterns).
//   2. Multiple non-dispatcher callers still import from there
//      directly (`providers/claude.ts` barrel, `providers/index.ts`).
//      Moving the source would break those imports without a benefit
//      — Phase 3's payoff is making the dispatcher data-driven, not
//      relocating files. (See the note in the corresponding module
//      docs for the other harnesses.)
//
// What this module DOES:
//   - Adds a `claude-binary` entry into the `harnesses` register that
//     exposes `runClaude` as `.run` and `streamClaude` as `.stream`.
//   - When the module is disabled in modules.json, the entry
//     disappears from the register and `routes/chat.ts` /
//     `routes/command.ts` will throw "No harness 'claude-binary'
//     available" if the user's config selects the binary path. The
//     core-pinned `claude-sdk` entry stays available for the SDK path.
'use strict';

const { runClaude } = require('../../providers/claude-run');
const { streamClaude } = require('../../providers/claude-stream');

interface HarnessClaudeBinaryApi {
  name: string;
}

module.exports = function harnessClaudeBinaryFactory() {
  return {
    activate(ctx: any): HarnessClaudeBinaryApi {
      ctx.registers.harnesses.add(
        {
          id: 'claude-binary',
          label: 'Claude Binary',
          run: runClaude,
          stream: streamClaude,
        },
        ctx.name,
      );
      ctx.logger.info('registered harness "claude-binary"');
      return { name: ctx.name };
    },
    deactivate() {
      // Register entry auto-removed by the loader's removeAllByModule()
      // in ctx.dispose(). lifecycle.hot=false in module.json — Express
      // route teardown isn't relevant here (the dispatcher reads the
      // register on each request, so it picks up the new state
      // immediately even without restart, but the existing harnesses
      // require() chain may hold ESM imports that prevent a clean
      // hot-swap of the backing functions).
    },
  };
};
