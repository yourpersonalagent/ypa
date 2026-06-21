// Frontend module bootstrap.
//
// Each module's `index.ts` is statically imported here so the
// bundler can code-split it normally. Whether `activate()` actually
// runs is decided at boot:
//
//   - Modules with a bridge counterpart (BRIDGE_LINKED) only activate
//     when the bridge module is enabled in bridge/modules.json. That
//     way disabling pet/todos/welcome-messages on the bridge side
//     also hides their FE surfaces.
//   - FE-only modules (chat-minimap, voice, files-editor) activate
//     unconditionally — there's no bridge enable bit to gate on.
//
// We await `fetchBridgeModulesOnce()` before iterating so the gate
// decision is correct on first activation. If the fetch fails (or
// hasn't loaded yet — fail-open), every module activates.
//
// If two modules touch the same register slot, the first registered
// wins (the duplicate-id rule in `registers.ts`), so order matters.

import chatMinimap from '../modules/chat-minimap/index.js';
import welcomeMessages from '../modules/welcome-messages/index.js';
import voice from '../modules/voice/index.js';
import filesEditor from '../modules/files-editor/index.js';
import todos from '../modules/todos/index.js';
import pet from '../modules/pet/index.js';
import filesManager from '../modules/files-manager/index.js';
import contextGenerator from '../modules/context-generator/index.js';
import remoteBrowser from '../modules/remote-browser/index.js';
import filesRclone from '../modules/files-rclone/index.js';
import filesServePreview from '../modules/files-serve-preview/index.js';
import contextModule from '../modules/context/index.js';
import filesGithub from '../modules/files-github/index.js';
import knowledge from '../modules/knowledge/index.js';
import harnessClaudeBinary from '../modules/harness-claude-binary/index.js';
import harnessCodex from '../modules/harness-codex/index.js';
import harnessGrokBuild from '../modules/harness-grok-build/index.js';
import harnessAider from '../modules/harness-aider/index.js';
import harnessPi from '../modules/harness-pi/index.js';
import sharedApi from '../modules/shared-api/index.js';
import inputAutocomplete from '../modules/input-autocomplete/index.js';
import search from '../modules/search/index.js';
import observabilityPlus from '../modules/observability-plus/index.js';
import mcpClient from '../modules/mcp-client/index.js';
import multichatPartners from '../modules/multichat-partners/index.js';
import skillsEditor from '../modules/skills-editor/index.js';
import workflowsAndTriggers from '../modules/workflows-and-triggers/index.js';
import cwdManager from '../modules/cwd-manager/index.js';
import pluginsFolder from '../modules/plugins-folder/index.js';
import audioTtsOpenai from '../modules/audio-tts-openai/index.js';
import yhaNet from '../modules/yha-net/index.js';
import render from '../modules/render/index.js';
import { fetchBridgeModulesOnce, isBridgeModuleEnabled } from './bridge-modules.js';

interface FrontendModuleFactory {
  activate?: () => unknown | Promise<unknown>;
  deactivate?: () => void | Promise<void>;
}

const ENABLED: Array<{ name: string; mod: FrontendModuleFactory }> = [
  { name: 'chat-minimap', mod: chatMinimap as FrontendModuleFactory },
  { name: 'welcome-messages', mod: welcomeMessages as FrontendModuleFactory },
  { name: 'voice', mod: voice as FrontendModuleFactory },
  { name: 'files-editor', mod: filesEditor as FrontendModuleFactory },
  { name: 'todos', mod: todos as FrontendModuleFactory },
  { name: 'pet', mod: pet as FrontendModuleFactory },
  { name: 'files-manager', mod: filesManager as FrontendModuleFactory },
  { name: 'context-generator', mod: contextGenerator as FrontendModuleFactory },
  { name: 'remote-browser', mod: remoteBrowser as FrontendModuleFactory },
  { name: 'files-rclone', mod: filesRclone as FrontendModuleFactory },
  { name: 'files-serve-preview', mod: filesServePreview as FrontendModuleFactory },
  { name: 'context', mod: contextModule as FrontendModuleFactory },
  { name: 'files-github', mod: filesGithub as FrontendModuleFactory },
  { name: 'knowledge', mod: knowledge as FrontendModuleFactory },
  { name: 'harness-claude-binary', mod: harnessClaudeBinary as FrontendModuleFactory },
  { name: 'harness-codex', mod: harnessCodex as FrontendModuleFactory },
  { name: 'harness-grok-build', mod: harnessGrokBuild as FrontendModuleFactory },
  { name: 'harness-aider', mod: harnessAider as FrontendModuleFactory },
  { name: 'harness-pi', mod: harnessPi as FrontendModuleFactory },
  { name: 'shared-api', mod: sharedApi as FrontendModuleFactory },
  { name: 'input-autocomplete', mod: inputAutocomplete as FrontendModuleFactory },
  { name: 'search', mod: search as FrontendModuleFactory },
  { name: 'observability-plus', mod: observabilityPlus as FrontendModuleFactory },
  { name: 'mcp-client', mod: mcpClient as FrontendModuleFactory },
  { name: 'multichat-partners', mod: multichatPartners as FrontendModuleFactory },
  { name: 'skills-editor', mod: skillsEditor as FrontendModuleFactory },
  { name: 'workflows-and-triggers', mod: workflowsAndTriggers as FrontendModuleFactory },
  { name: 'cwd-manager', mod: cwdManager as FrontendModuleFactory },
  { name: 'plugins-folder', mod: pluginsFolder as FrontendModuleFactory },
  { name: 'audio-tts-openai', mod: audioTtsOpenai as FrontendModuleFactory },
  // FE-only: backend is the read-only /v1/net/self core route, no bridge module
  // to gate on — intentionally absent from BRIDGE_LINKED so it always activates.
  { name: 'yha-net', mod: yhaNet as FrontendModuleFactory },
  // FE-only, intentionally inert: provides generic render() / <RenderView/>
  // helpers to other frontend modules. No chat-pipeline wiring, no visible UI.
  { name: 'render', mod: render as FrontendModuleFactory },
];

/** FE modules whose name matches a bridge module — gating applies. */
const BRIDGE_LINKED = new Set([
  'welcome-messages', 'todos', 'pet',
  'files-manager', 'context-generator', 'files-rclone',
  'files-serve-preview', 'context',
  'files-github', 'knowledge',
  'remote-browser',
  'harness-claude-binary', 'harness-codex', 'harness-grok-build',
  'shared-api', 'chat-minimap',
  'input-autocomplete',
  'search', 'observability-plus', 'mcp-client',
  'multichat-partners', 'skills-editor',
  'workflows-and-triggers', 'cwd-manager',
  'plugins-folder',
  'audio-tts-openai',
]);

let activated = false;
// Tracks which FE modules are currently active in the running tab. Seeded
// during activateEnabledModules() and updated by setFEModuleActive() so the
// Modules tab can toggle FE-half on/off at runtime without a page reload.
const activeStates = new Map<string, boolean>();

export async function activateEnabledModules(): Promise<void> {
  if (activated) return;
  activated = true;
  await fetchBridgeModulesOnce();
  for (const { name, mod } of ENABLED) {
    if (BRIDGE_LINKED.has(name) && !isBridgeModuleEnabled(name)) {
      console.log(`[host] FE module "${name}" skipped — bridge half disabled in modules.json`);
      activeStates.set(name, false);
      continue;
    }
    try {
      const result = mod.activate?.();
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        (result as Promise<unknown>).catch((e) =>
          console.warn(`[host] module "${name}" activate() rejected:`, e),
        );
      }
      activeStates.set(name, true);
    } catch (e) {
      console.error(`[host] module "${name}" activate() threw:`, e);
      activeStates.set(name, false);
    }
  }
}

export function listEnabledModules(): string[] {
  return ENABLED.map((e) => e.name);
}

export interface FEToggleResult {
  /** True if the request was honoured (or no-op because already in target state). */
  ok: boolean;
  /** False when the module can't do this transition at runtime — caller must reload page. */
  supported: boolean;
  /** Populated on failure or unsupported transitions. */
  reason?: string;
}

/**
 * Flip a frontend module's lifecycle at runtime. Used by the Modules tab so
 * toggling a `kind: "frontend"` or `kind: "both"` module reflects in the
 * running tab immediately — no page reload, no bridge restart.
 *
 * Returns `supported: false` if the module doesn't expose the needed hook
 * (typically: no `deactivate()`); the caller should then prompt for a page
 * reload to apply.
 */
export async function setFEModuleActive(name: string, on: boolean): Promise<FEToggleResult> {
  const entry = ENABLED.find((e) => e.name === name);
  if (!entry) return { ok: false, supported: false, reason: 'module not statically imported' };
  const isActive = activeStates.get(name) === true;
  if (on === isActive) return { ok: true, supported: true };
  if (on) {
    if (!entry.mod.activate) {
      return { ok: false, supported: false, reason: 'module has no activate()' };
    }
    try {
      const result = entry.mod.activate();
      if (result && typeof (result as Promise<unknown>).then === 'function') {
        await (result as Promise<unknown>);
      }
      activeStates.set(name, true);
      return { ok: true, supported: true };
    } catch (e) {
      return { ok: false, supported: true, reason: e instanceof Error ? e.message : String(e) };
    }
  } else {
    if (!entry.mod.deactivate) {
      return { ok: false, supported: false, reason: 'module has no deactivate()' };
    }
    try {
      await entry.mod.deactivate();
      activeStates.set(name, false);
      return { ok: true, supported: true };
    } catch (e) {
      return { ok: false, supported: true, reason: e instanceof Error ? e.message : String(e) };
    }
  }
}

/** True if the FE half is currently active in this tab. */
export function isFEModuleActive(name: string): boolean {
  return activeStates.get(name) === true;
}
