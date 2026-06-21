// Bridge-side register keys + their declared instances.
//
// Lists every register the plan (`YHA-modular-registers.md` §2.1) names
// for the bridge, declares the singleton instance, and exposes them
// via `bridgeRegisters`. Modules import this via the loader's
// `ctx.registers.<key>` rather than reaching here directly.
//
// Adding a new register: add a key here, add its entry-shape interface
// in the comment block, and the migration follows the same pattern as
// `tools` (the validated reference).
'use strict';

const { declareRegister } = require('./index');

// ── Entry-shape contracts (documentation; runtime is duck-typed) ────────
//
// tools — `bridge/tools/defs.ts`
//   { name: string, description: string, parameters: object,
//     exec?: (args, ctx) => unknown, security?: SecurityPolicy }
//
// systemPromptFragments — `bridge/providers/core.ts:getDefaultSystem()`
//   { section: 'prelude' | 'identity' | 'capabilities' | 'constraints' | 'postlude',
//     text: string | (ctx) => string }
//
// harnesses — the dispatch ladder over runtime/routeType in
//   `bridge/routes/chat.ts` + `bridge/routes/command.ts`. Each entry
//   exposes the call functions matching the legacy shapes (registered
//   via `bridge/core/bootstrap-harnesses.ts`):
//     { id: 'claude-sdk' | 'claude-binary' | 'codex' | 'direct-api',
//       label: string,
//       run?(prompt, modelId, preset, sessionId, imageBlocks?, opts?) → Promise<RunResult>,
//       stream?(prompt, modelId, preset, sessionId, onChunk, onDone, onError, imageBlocks?, opts?) → void,
//       streamGemini?(...args) → Promise<...>,
//       streamAnthropic?(...args) → Promise<...>,
//       core?: boolean }
//   At least one entry MUST be `core: true` so the loader rejects an
//   empty harness register (claude-sdk is the pinned default).
//
// mcpServers — `bridge/mcp-registry.json`
//   { id: string, command: string, args: string[], env?: Record<string,string>,
//     autostart?: boolean, scope?: 'global' | 'cwd' | 'session' }
//
// skillSources — `bridge/meta/skills/*`
//   { id: string, dir: string, kind: 'agent' | 'tool', readonly?: boolean }
//
// pipelineStages — bridges YHA-modular-plan.md to YHAModularRoutingPlan.md
//   { stage: string, run: (input) => output | Promise<output> }
//
// commandsBridge — `bridge/routes/command.ts`
//   { id: string, exec: (ctx, args) => Promise<...> }
//
// participantKinds — employees + partners + broadcast groups
//   { kind: string, resolve: (id) => Persona, send: (callDescriptor) => Promise<...> }
//
// welcomeMessages — `bridge/welcomeMsg/index.ts`
//   { id: string, applies: (now: Date, locale: string) => boolean,
//     render: (ctx) => ChatBlock }
//
// prefsSchema — server-owned config keys
//   { key: string, type: string, default?: unknown, secret?: boolean,
//     scope?: 'global' | 'cwd' }
//
// triggerHandlers — trigger-engine producers + consumers
//   { id: string, kind: 'producer' | 'consumer', handle: (event) => unknown }
//
// searchProviders — `bridge/search/providers/*`
//   { id: string, query: (q, opts) => Promise<Result[]> }
//
// contextSources — what the context-gen pipeline pulls from
//   { id: string, scan: (cwd, since) => Promise<ContextItem[]> }

// ── Declared register singletons ────────────────────────────────────────

const bridgeRegisters = {
  tools: declareRegister('tools'),
  systemPromptFragments: declareRegister('systemPromptFragments'),
  harnesses: declareRegister('harnesses'),
  mcpServers: declareRegister('mcpServers'),
  skillSources: declareRegister('skillSources'),
  pipelineStages: declareRegister('pipelineStages'),
  commandsBridge: declareRegister('commandsBridge'),
  participantKinds: declareRegister('participantKinds'),
  welcomeMessages: declareRegister('welcomeMessages'),
  prefsSchema: declareRegister('prefsSchema'),
  triggerHandlers: declareRegister('triggerHandlers'),
  searchProviders: declareRegister('searchProviders'),
  contextSources: declareRegister('contextSources'),
};

module.exports = { bridgeRegisters };
