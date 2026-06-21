// harness-codex — module wrapper around the `codex` CLI subprocess
// harness (OpenAI Codex binary).
//
// Why the source isn't moved: bridge/providers/codex.ts also exports
// `splitAllowedToolsByProvider` which is consumed by the chat routes'
// tool-routing logic, not the harness dispatcher. Splitting that file
// would mean touching providers/index.ts barrel + every consumer; out
// of scope for this batch. The dispatcher payoff (data-driven harness
// lookup) is already shipped in Commit 1.
'use strict';

const { streamCodex } = require('../../providers/codex');

interface HarnessCodexApi {
  name: string;
}

module.exports = function harnessCodexFactory() {
  return {
    activate(ctx: any): HarnessCodexApi {
      ctx.registers.harnesses.add(
        {
          id: 'codex',
          label: 'Codex',
          stream: streamCodex,
        },
        ctx.name,
      );
      ctx.logger.info('registered harness "codex"');
      return { name: ctx.name };
    },
    deactivate() {
      // Register entry auto-removed by ctx.dispose().
    },
  };
};
