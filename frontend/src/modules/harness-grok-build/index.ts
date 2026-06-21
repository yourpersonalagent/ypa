// harness-grok-build — frontend module owning the Grok Build harness type.
//
// Registers the 'grok' entry into the `harnessTypes` register so the
// Harness prefs tab shows the Grok toggle and the standard subscription
// instances list. When the bridge module `harness-grok-build` is
// disabled in modules.json, this FE module is skipped at boot and the
// Grok UI disappears.

import host from '../../host/index.js';
import { GrokConfigSection } from './GrokConfigSection.js';

const MODULE_NAME = 'harness-grok-build';

export default {
  activate() {
    host.registers.harnessTypes.add(
      {
        id: 'harness-grok-build.type',
        order: 30,
        type: 'grok',
        label: 'Grok Build',
        category: 'subscription',
        binStorageKey: 'yha.grokBin',
        configBinKey: 'grokBin',
        // Notes surfaced (or available to) the generic harness prefs tab.
        // These explain the remaining "not 100% like local claude code"
        // realities while highlighting the parity we have (resume + rich
        // events + MCP via alias + broadcast routing).
        tokensNote: 'Token/cost often shows 0 for Grok Build subscription turns (xAI meters at account level; CLI streaming-json may omit). Estimator in the harness provides fallback numbers for ledger/busy bar when the CLI reports 0/0.',
        resumeAndEventsNote: 'Native --resume (cold: lossy 16-turn fold; warm: bare prompt + full CLI tool/plan/compact state) + ChunkTypeReasoning/ToolUse/ToolResult (thinking + tool cards exactly like claude-binary/codex) supported for primary chat and broadcast/versus employees. MCP-Tools (101) visible via alias stub.',
        authCmdTemplate: (bin, home, _dir, platform) => {
          const b = bin || 'grok';
          // Grok stores auth in OS keychain / user-data area, so the
          // only knob to isolate accounts is HOME. There is no
          // dedicated GROK_HOME env var (0.2.x).
          if (platform === 'win32') {
            return `$env:HOME='${home}'; & '${b}' login`;
          }
          return `HOME=${home} ${b} login`;
        },
        // Two routes for the local Grok Build CLI binary (clear parallel
        // to claude-binary vs claude-sdk):
        //   - default "grok" (HarnessInstance "grok" or provider "Grok-*"):
        //     headless binary (-p streaming-json + --resume + rich events).
        //   - "grok-acp": the Agent Client Protocol (`grok agent stdio`) path.
        //     Long-lived JSON-RPC agent process (the "sdk" / editor-style
        //     integration). Switch by setting HarnessInstance = "grok-acp"
        //     on the turn / employee / advanced instance config.
        // Both share the same polished features (resume, tool cards,
        // reasoning blocks, MCP alias for 101 YHA tools, cost estimator).
        // The acp label exists so a dedicated ACP client can be swapped
        // in later without any other code or UI changes.
        description: 'Grok Build (headless binary by default; use HarnessInstance="grok-acp" for the Agent Client Protocol / long-lived agent route)',
        configSection: GrokConfigSection,
      },
      MODULE_NAME,
    );

    return { name: MODULE_NAME };
  },
  deactivate() {
    host.removeModuleEverywhere(MODULE_NAME);
  },
};
