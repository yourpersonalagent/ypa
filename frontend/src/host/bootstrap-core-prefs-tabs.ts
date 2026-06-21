// Register the core (non-module) preferences tabs.
//
// Mirrors `bootstrap-core-icons.tsx` for the `prefsTabs` register.
// Every existing tab ships as a `core: true` entry so it survives a
// module's `removeModuleEverywhere(...)` call. As tabs migrate into
// individual modules, each entry below moves into that module's
// `activate()` and is removed from this file.
//
// Every tab declares a `group` (intelligence | capabilities | workspace |
// platform) — the settings rail renders one section header per group. `order`
// is now scoped *within* a group (10, 20, 30, …); cross-group layout is driven
// by `PREFS_TAB_GROUPS` order in `host/keys.ts`, not by these numbers.

import { registers } from './keys.js';
import { TabApiKeys }  from '../prefs/TabApiKeys.js';
// TabApi (the "API" tab — public keys for external callers) moved to the
// `shared-api` module. See frontend/src/modules/shared-api/.
// TabSearch / TabStats / TabMcp / TabPartners / TabSkills also moved out — see
// frontend/src/modules/{search,observability-plus,mcp-client,multichat-partners,skills-editor}/.
import { TabHarness }  from '../prefs/TabHarness.js';
import { TabModels }   from '../prefs/TabModels.js';
import { TabModules }  from '../prefs/TabModules.js';
import { TabSystem }   from '../prefs/TabSystem.js';
import { TabDependencies } from '../prefs/TabDependencies.js';
import { TabPrompts }  from '../prefs/TabPrompts.js';
import { TabTools }    from '../prefs/TabTools.js';
import { TabUpdates }  from '../prefs/TabUpdates.js';

let registered = false;

export function registerCorePrefsTabs() {
  if (registered) return;
  registered = true;

  // ── Intelligence — the agent's mind ──────────────────────────────────────
  registers.prefsTabs.add({ id: 'apikeys', group: 'intelligence', order: 10, label: 'Providers',      simpleMode: 'all',     component: TabApiKeys,  icon: '🔑', core: true }, '<core>');
  registers.prefsTabs.add({ id: 'models',  group: 'intelligence', order: 20, label: 'Models',         simpleMode: 'partial', component: TabModels,   icon: '🧠', core: true }, '<core>');
  registers.prefsTabs.add({ id: 'harness', group: 'intelligence', order: 30, label: 'Harness',        simpleMode: null,      component: TabHarness,  icon: '🧰', core: true }, '<core>');
  registers.prefsTabs.add({ id: 'prompts', group: 'intelligence', order: 40, label: 'System Prompts', simpleMode: null,      component: TabPrompts,  icon: '💬', core: true }, '<core>');

  // ── Capabilities — what it can do ─────────────────────────────────────────
  registers.prefsTabs.add({ id: 'tools',   group: 'capabilities', order: 10, label: 'Tools',          simpleMode: null,      component: TabTools,   icon: '🔧', core: true }, '<core>');
  //   'skills'   (capabilities, 20) → skills-editor module
  //   'mcp'      (capabilities, 30) → mcp-client module
  //   'search'   (capabilities, 40) → search module
  //   'partners' (capabilities, 50) → multichat-partners module

  // ── Workspace — how it looks & feels to you ───────────────────────────────
  registers.prefsTabs.add({ id: 'system',  group: 'workspace',    order: 10, label: 'System',         simpleMode: 'partial', component: TabSystem,  icon: '⚙️', core: true }, '<core>');
  //   'autocomplete' (workspace, 20) → input-autocomplete module

  // ── Platform — plumbing & admin ───────────────────────────────────────────
  registers.prefsTabs.add({ id: 'modules',      group: 'platform', order: 10, label: 'Modules',      simpleMode: null,      component: TabModules,      icon: '📦', core: true }, '<core>');
  registers.prefsTabs.add({ id: 'dependencies', group: 'platform', order: 20, label: 'Dependencies', simpleMode: null,      component: TabDependencies, icon: '🔗', core: true }, '<core>');
  registers.prefsTabs.add({ id: 'updates',      group: 'platform', order: 30, label: 'Updates',      simpleMode: null,      component: TabUpdates,      icon: '⬆️', core: true }, '<core>');
  //   'stats' (platform, 40) → observability-plus module
  //   'api'   (platform, 50) → shared-api module
}
