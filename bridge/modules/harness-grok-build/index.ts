// harness-grok-build — registration shim for the Go grokbuild harness.
//
// The actual subprocess + streaming-json parser live in
// go-core/internal/harness/grokbuild and dispatch through the Go core's
// in-process harness adapter map (label "grok"). Node never spawns the
// grok binary itself, so this module's only job is to register a
// `harnesses` entry whose stream function rejects — the Go core owns
// every grok turn. The register entry exists so the FE module gate
// (bridge-modules.ts) reports the bridge half as enabled.
'use strict';

interface HarnessGrokBuildApi {
  name: string;
}

module.exports = function harnessGrokBuildFactory() {
  return {
    activate(ctx: any): HarnessGrokBuildApi {
      ctx.registers.harnesses.add(
        {
          id: 'grok',
          label: 'Grok Build',
          stream: async () => {
            throw new Error(
              'harness-grok-build: Node has no streamGrok implementation; the Go core ' +
              '(internal/harness/grokbuild) owns this harness. Reaching this branch means ' +
              'the request bypassed the Go in-process adapter.',
            );
          },
        },
        ctx.name,
      );
      ctx.logger.info('registered harness "grok" (Go-backed)');
      return { name: ctx.name };
    },
    deactivate() {
      // Register entry auto-removed by ctx.dispose().
    },
  };
};
