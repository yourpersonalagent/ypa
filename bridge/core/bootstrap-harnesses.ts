// Core harness register population.
//
// Phase 3 of the modular migration: the dispatch ladder in
// `bridge/routes/chat.ts` + `bridge/routes/command.ts` no longer
// imports the harness functions directly — it looks them up in the
// `harnesses` register.
//
// What lives here vs. in modules:
//   - `claude-sdk` is the core-pinned default. It cannot be removed
//     by `removeAllByModule()`, so even with every harness module
//     disabled in modules.json, `claude-sdk` is always available.
//     This satisfies the registers-doc §1 rule about coreEntries: a
//     register that can't be empty needs a pinned default.
//   - `claude-binary`, `codex`, `direct-api` come from the modules
//     under `bridge/modules/harnesses/<id>/`. Toggling those entries
//     in modules.json adds/removes them from the register.
//
// Why claude-sdk is the chosen default:
//   - It has both `.run` (sync) and `.stream` (callback) variants so
//     `routes/command.ts` (sync) and `routes/chat.ts` (stream) both
//     work with this single fallback.
//   - It is the most stable production path, and it transparently
//     handles non-Anthropic models via the proxy route (see
//     bridge/chat/agent.ts comment header).
'use strict';

const { bridgeRegisters } = require('./registers/keys');

interface HarnessEntry {
  id: string;
  module?: string;
  core?: boolean;
  /** Human label used in UI dropdowns. */
  label: string;
  /** Sync-result variant (matches `runClaude` / `runClaudeViaSdk` shape). */
  run?: (...args: unknown[]) => Promise<unknown>;
  /** Streaming variant — callback-style (onChunk, onDone, onError). */
  stream?: (...args: unknown[]) => void;
  /** Direct-API harness only: Gemini-flavoured streaming variant. */
  streamGemini?: (...args: unknown[]) => Promise<unknown>;
  /** Direct-API harness only: Anthropic-flavoured streaming variant. */
  streamAnthropic?: (...args: unknown[]) => Promise<unknown>;
}

function registerCoreHarnesses(): void {
  // Lazy-require to keep the load order legal: `core/state` must be
  // initialised before `chat/` pulls on it. server.ts imports `state`
  // first, then this file is required, so by the time we ask for the
  // harness functions every prereq is in scope.
  const { runClaudeViaSdk, streamClaudeViaSdk } = require('../chat/agent');

  const entry: HarnessEntry = {
    id: 'claude-sdk',
    label: 'Claude SDK',
    core: true,
    run: runClaudeViaSdk,
    stream: streamClaudeViaSdk,
  };
  bridgeRegisters.harnesses.add(entry as never, '<core>');
}

module.exports = { registerCoreHarnesses };
