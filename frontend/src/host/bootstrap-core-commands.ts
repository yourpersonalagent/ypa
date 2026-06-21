// Seed the `appCommands` register with the layout-agnostic core commands
// for the `/` App Command Palette (LayoutPlan.md §Phase 3).
//
// What lives here:
//   • layout.set.* — switch to full / messenger / zen
//   • color-theme.set.* / .family.* / .variant.* — pick palette
//   • view.* — header toggle/orient, split toggle/orient, swap panes
//   • panel.toggle.* — auto-wrapped from the `panels` register at first run
//   • header.* — auto-wrapped from the `headerIconButtons` register
//   • prefs.open.* — auto-wrapped from the `prefsTabs` register
//
// What does NOT live here:
//   • module commands — each module registers its own via `host.registers.appCommands.add(...)`
//   • harness commands — added at harness-prefs activation when `surface: '/'` is set
//   • chat tools / MCP / skills — those live on the `#` Chat Command Picker (separate component)
//
// Called once from `App.tsx` (or `main-react.tsx`) before mount. Idempotent.

import { registers } from './keys.js';
import type { AppCommand } from './keys.js';
import { getAppActions, getAppState, type LayoutMode } from '../stores/appStore.js';
import { showDebugModal, DEBUG_MENU_ENTRIES } from '../panels/debug-panel.js';
import { LAYOUTS, listLayouts } from '../layouts/index.js';
import {
  COLOR_THEME_FAMILIES,
  COLOR_THEME_VARIANTS,
  colorThemeFamilyName,
  parseColorThemeId,
} from '../color-themes-config.js';
import { colorTheme } from '../color-theme.js';
import { useForgeStore } from '../forge-bar/forge-state.js';
import { DESIGN_THEMES } from '../design-themes-config.js';
import { designTheme } from '../design-theme.js';
import { store } from '../store.js';

let registered = false;

function add(entry: AppCommand) {
  registers.appCommands.add({ ...entry, core: true, module: '<core>' }, '<core>');
}

export function registerCoreAppCommands() {
  if (registered) return;
  registered = true;

  // Stable automation contract for the shared user/agent terminal. The
  // header button is also auto-wrapped, but commands should not depend on DOM.
  add({
    id: 'terminal.open',
    group: 'chat',
    label: 'Open Shared YPA Terminal',
    icon: 'terminal',
    keywords: ['terminal', 'shell', 'bash', 'powershell', 'shared', 'agent'],
    run: ({ closePalette }) => {
      window.dispatchEvent(new CustomEvent('yha:open-bash-console'));
      closePalette();
    },
  });
  add({
    id: 'terminal.close',
    group: 'chat',
    label: 'Close Shared YPA Terminal',
    icon: 'terminal',
    keywords: ['terminal', 'shell', 'close'],
    run: ({ closePalette }) => {
      window.dispatchEvent(new CustomEvent('yha:close-bash-console'));
      closePalette();
    },
  });
  add({
    id: 'frontend-agent.manifest.download',
    group: 'debug',
    label: 'Download Frontend Agent Manifest',
    icon: 'download',
    keywords: ['agent', 'automation', 'manifest', 'commands', 'documentation'],
    run: ({ closePalette }) => {
      const manifest = window.__ypa_agent?.listManifest();
      if (manifest) {
        const blob = new Blob([`${JSON.stringify(manifest, null, 2)}\n`], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `ypa-frontend-agent-${manifest.appVersion}.json`;
        link.click();
        URL.revokeObjectURL(url);
      }
      closePalette();
    },
  });

  // ── Layout group ────────────────────────────────────────────────────────
  for (const meta of listLayouts()) {
    add({
      id: `layout.set.${meta.id}`,
      group: 'layout',
      label: `Switch to ${meta.label}`,
      icon: meta.icon,
      keywords: ['layout', meta.id, meta.label.toLowerCase()],
      state: () => ({ active: getAppState().layoutMode === meta.id }),
      run: ({ closePalette }) => {
        getAppActions().setLayoutMode(meta.id as LayoutMode);
        closePalette();
      },
    });
  }

  // ── Color theme group ───────────────────────────────────────────────────
  // Family entries — change family while keeping the current variant.
  for (const fam of COLOR_THEME_FAMILIES) {
    add({
      id: `color-theme.family.${fam.id}`,
      group: 'color-theme',
      label: `${fam.icon} ${fam.name}`,
      icon: 'palette',
      keywords: ['theme', 'color', fam.id, fam.name.toLowerCase(), 'family'],
      state: () => ({ active: parseColorThemeId(getAppState().colorTheme).family === fam.id }),
      run: ({ closePalette }) => { colorTheme.setFamily(fam.id); closePalette(); },
    });
  }
  // Variant entries.
  for (const v of COLOR_THEME_VARIANTS) {
    add({
      id: `color-theme.variant.${v}`,
      group: 'color-theme',
      label: v === 'dark' ? '🌙 Dark' : '☀ Bright',
      icon: 'palette',
      keywords: ['theme', 'variant', v],
      state: () => ({ active: parseColorThemeId(getAppState().colorTheme).variant === v }),
      run: ({ closePalette }) => { colorTheme.setVariant(v); closePalette(); },
    });
  }
  // Combined presets — `family-variant` direct picks for one-shot selection.
  for (const fam of COLOR_THEME_FAMILIES) {
    for (const v of COLOR_THEME_VARIANTS) {
      const id = `${fam.id}-${v}`;
      add({
        id: `color-theme.set.${id}`,
        group: 'color-theme',
        label: `${colorThemeFamilyName(fam.id)} ${v === 'dark' ? 'Dark' : 'Bright'}`,
        icon: 'palette',
        keywords: ['theme', fam.id, v, fam.name.toLowerCase()],
        state: () => ({ active: getAppState().colorTheme === id }),
        run: ({ closePalette }) => { colorTheme.set(id); closePalette(); },
      });
    }
  }

  // ── Design-theme group ──────────────────────────────────────────────────
  // Each design ships an `/ design <name>` shortcut. The third visual axis
  // composes with colour-theme + layout — see DESIGNS.md.
  for (const d of DESIGN_THEMES) {
    add({
      id: `design.set.${d.id}`,
      group: 'design',
      label: `${d.icon} ${d.name} — ${d.description}`,
      icon: 'palette',
      keywords: ['design', 'skin', 'theme', d.id, d.name.toLowerCase()],
      state: () => ({ active: getAppState().designTheme === d.id }),
      run: ({ closePalette }) => { designTheme.set(d.id); closePalette(); },
    });
  }

  // ── View group (full-only fields — palette entries no-op cleanly on
  // other layouts thanks to the layout `respected fields` contract). ───────
  add({
    id: 'view.header.toggle',
    group: 'view',
    label: 'Toggle Header',
    icon: 'panel-top',
    keywords: ['header', 'show', 'hide', 'menu', 'bar'],
    state: () => ({ value: getAppState().headerOpen ? 'visible' : 'hidden' }),
    run: ({ closePalette }) => { getAppActions().setHeaderOpen(!getAppState().headerOpen); closePalette(); },
  });
  add({
    id: 'view.header.orient.top',
    group: 'view',
    label: 'Header on Top',
    icon: 'panel-top',
    keywords: ['header', 'horizontal', 'top'],
    state: () => ({ active: getAppState().headerOrient === 'h' }),
    run: ({ closePalette }) => { getAppActions().setHeaderOrient('h'); closePalette(); },
  });
  add({
    id: 'view.header.orient.side',
    group: 'view',
    label: 'Header on Side',
    icon: 'panel-left',
    keywords: ['header', 'vertical', 'side', 'left'],
    state: () => ({ active: getAppState().headerOrient === 'v' }),
    run: ({ closePalette }) => { getAppActions().setHeaderOrient('v'); closePalette(); },
  });
  add({
    id: 'view.split',
    group: 'view',
    label: 'Split View (Chat + Workflow)',
    icon: 'columns-2',
    keywords: ['split', 'workflow', 'graph'],
    state: () => ({ active: getAppState().viewMode === 'split' }),
    run: ({ closePalette }) => { getAppActions().setViewMode('split'); closePalette(); },
  });
  add({
    id: 'view.chat-only',
    group: 'view',
    label: 'Chat Only',
    icon: 'message-square',
    keywords: ['chat', 'focus'],
    state: () => ({ active: getAppState().viewMode === 'chat' }),
    run: ({ closePalette }) => { getAppActions().setViewMode('chat'); closePalette(); },
  });
  add({
    id: 'view.workflow-only',
    group: 'view',
    label: 'Workflow Only',
    icon: 'workflow',
    keywords: ['workflow', 'graph', 'editor'],
    state: () => ({ active: getAppState().viewMode === 'workflow' }),
    run: ({ closePalette }) => { getAppActions().setViewMode('workflow'); closePalette(); },
  });
  add({
    id: 'view.split.orient.horizontal',
    group: 'view',
    label: 'Split Horizontal',
    icon: 'rows-2',
    keywords: ['split', 'orientation', 'horizontal'],
    state: () => ({ active: getAppState().viewOrient === 'h' }),
    run: ({ closePalette }) => { getAppActions().setViewOrient('h'); closePalette(); },
  });
  add({
    id: 'view.split.orient.vertical',
    group: 'view',
    label: 'Split Vertical',
    icon: 'columns-2',
    keywords: ['split', 'orientation', 'vertical'],
    state: () => ({ active: getAppState().viewOrient === 'v' }),
    run: ({ closePalette }) => { getAppActions().setViewOrient('v'); closePalette(); },
  });
  add({
    id: 'view.swap',
    group: 'view',
    label: 'Swap Panes',
    icon: 'arrow-left-right',
    keywords: ['swap', 'flip', 'reverse'],
    state: () => ({ active: getAppState().viewSwap }),
    run: ({ closePalette }) => { getAppActions().setViewSwap(!getAppState().viewSwap); closePalette(); },
  });

  // Confirmation: layouts other than `full` ignore the view.* commands.
  // The commands still fire (they write to appStore), but `messenger` and
  // `zen` don't read those fields — so the writes have no visible effect
  // until the user switches back to `full`. This is intentional: it
  // means a user who tweaks split/orient/header from inside zen sees their
  // settings preserved when they return to full.

  // ── Header section dropdowns ────────────────────────────────────────────
  // `header.section.*` commands are auto-wrapped from the `headerSections`
  // register at palette-render time inside AppCommandPalette — any section
  // that declares a `panelLabel` is reachable from the palette. In full
  // layout the run() handler clicks `btn-<short-id>`; in messenger/zen it
  // sets appStore.openPanel and PanelsDrawer renders the section component
  // generically. This used to be a hardcoded array here, but that grew
  // dual-maintenance once modules (like plugins-folder) wanted in.

  // ── Chat input bar buttons ──────────────────────────────────────────────
  // Layouts other than `full` collapse some or all of these buttons via
  // CSS (`display: none`). They remain in the DOM, so click() still fires
  // their handlers — palette gives Zen/Messenger users access to controls
  // they'd otherwise have no way to reach. Module-owned buttons (voice,
  // context-notes) are registered by their modules so they appear/disappear
  // with the owning module.
  function clickById(id: string): void {
    const el = document.getElementById(id);
    if (el) (el as HTMLElement).click();
  }
  const CHAT_BUTTONS: Array<{
    id: string;
    label: string;
    domId: string;
    keywords: string[];
    icon?: string;
    run?: () => void;
  }> = [
    { id: 'files',         label: 'Files & Folders',        domId: 'chat-file',         keywords: ['files', 'folders', 'attach', 'upload', 'browse'], icon: 'folder' },
    { id: 'session.switch', label: 'Switch Session',         domId: 'chat-session-btn',  keywords: ['session', 'switch', 'picker', 'history'], icon: 'list' },
    { id: 'session.new',   label: 'New Session',            domId: 'chat-new-session',  keywords: ['session', 'new', 'create', 'fresh'], icon: 'plus' },
    { id: 'commands',      label: 'Open Chat Tools (#)',     domId: 'chat-cmd',          keywords: ['commands', 'tools', 'hash', '#', 'chat tools'], icon: 'hash' },
    { id: 'model',         label: 'Open Model Picker',       domId: 'chat-model-btn',    keywords: ['model', 'pick', 'llm', 'choose'], icon: 'sparkles' },
    {
      id: 'sys-prompt',
      label: 'Open System Prompt',
      domId: 'chat-sys-btn',
      keywords: ['system', 'prompt', 'override', 'persona', 'role'],
      icon: 'circle-dot',
      run: () => window.dispatchEvent(new CustomEvent('yha:open-sysprompt')),
    },
    { id: 'send',          label: 'Send Message',            domId: 'chat-send',         keywords: ['send', 'submit', 'play', 'go'], icon: 'play' },
    { id: 'stop',          label: 'Stop Generation',         domId: 'chat-stop',         keywords: ['stop', 'cancel', 'abort', 'interrupt'], icon: 'square' },
  ];
  for (const b of CHAT_BUTTONS) {
    add({
      id: `chat.${b.id}`,
      group: 'chat',
      label: b.label,
      icon: b.icon || 'circle',
      keywords: ['chat', 'input', 'bar', ...b.keywords],
      run: ({ closePalette }) => { (b.run || (() => clickById(b.domId)))(); closePalette(); },
    });
  }

  // Per-model capability toggles. The buttons are styled `display: none` on
  // models that don't support a given capability — calling click() on a
  // hidden node still fires the React onClick, but the toggle handler
  // self-checks `*Supported` and no-ops if unsupported.
  const CAP_BUTTONS: Array<{ id: string; label: string; domId: string; keywords: string[] }> = [
    { id: 'cap.vision',    label: 'Toggle Vision',    domId: 'cap-vision',    keywords: ['vision', 'image', 'multimodal', 'eye', 'capability'] },
    { id: 'cap.reasoning', label: 'Toggle Reasoning', domId: 'cap-reasoning', keywords: ['reasoning', 'think', 'thinking', 'extended', 'capability'] },
    { id: 'cap.tools',     label: 'Cycle Tools Mode', domId: 'cap-tools',     keywords: ['tools', 'tool use', 'mcp', 'cycle', 'filter', 'capability'] },
  ];
  for (const c of CAP_BUTTONS) {
    add({
      id: `chat.${c.id}`,
      group: 'chat',
      label: c.label,
      icon: 'sparkles',
      keywords: ['chat', 'capability', ...c.keywords],
      run: ({ closePalette }) => { clickById(c.domId); closePalette(); },
    });
  }

  // Effort levels — write through the same store key the EffortSelector
  // dots use, so the palette and the dots stay in sync.
  const EFFORT_LEVELS = [
    { id: 'low',    label: 'Low' },
    { id: 'medium', label: 'Medium' },
    { id: 'high',   label: 'High' },
    { id: 'xhigh',  label: 'X-High' },
    { id: 'max',    label: 'Max' },
  ] as const;
  for (const lvl of EFFORT_LEVELS) {
    add({
      id: `chat.effort.${lvl.id}`,
      group: 'chat',
      label: `Effort: ${lvl.label}`,
      icon: 'gauge',
      keywords: ['chat', 'effort', 'level', lvl.id, lvl.label.toLowerCase()],
      state: () => ({ active: getAppState().effort === lvl.id }),
      run: ({ closePalette }) => { store.set('effort', lvl.id); closePalette(); },
    });
  }
  add({
    id: 'chat.effort.off',
    group: 'chat',
    label: 'Effort: Default (off)',
    icon: 'gauge',
    keywords: ['chat', 'effort', 'off', 'default', 'reset'],
    state: () => ({ active: !getAppState().effort }),
    run: ({ closePalette }) => { store.set('effort', null); closePalette(); },
  });

  // ── Rewind safety-net ──────────────────────────────────────────────────
  // Same-origin via the bridge proxy (/__rewind → standalone yha-rewind
  // on :8445) so the path works through Tailscale Funnel without
  // exposing the recovery port separately. The standalone service
  // listens on its own pm2 process; if the bridge is down, the user
  // opens :8445 directly.
  //
  // The in-page overlay reuses the same DOM the watchdog injects (set
  // up in yha.html). Falls back to a new tab if the inline script
  // somehow didn't run.
  add({
    id: 'rewind.open',
    group: 'rewind',
    label: 'Rewind — open recovery overlay',
    icon: 'history',
    keywords: ['rewind', 'recover', 'restore', 'undo', 'safety', 'snapshot', 'edit', 'history'],
    run: ({ closePalette }) => {
      const w = window as unknown as { __ypa_showRewindOverlay?: (detail?: string) => void };
      const failed = useForgeStore.getState().failedModules;
      let detail: string | undefined;
      if (failed.length === 1) {
        detail = failed[0].error
          ? `${failed[0].name} failed to load — ${failed[0].error}`
          : `${failed[0].name} failed to load`;
      } else if (failed.length > 1) {
        detail = `${failed.length} modules failed to load`;
      }
      if (typeof w.__ypa_showRewindOverlay === 'function') {
        w.__ypa_showRewindOverlay(detail);
      } else {
        window.open('/__rewind/recover', '_blank', 'noopener,noreferrer');
      }
      closePalette();
    },
  });

  add({
    id: 'rewind.open.tab',
    group: 'rewind',
    label: 'Rewind — open recovery overlay in a new tab',
    icon: 'history',
    keywords: ['rewind', 'recover', 'restore', 'undo', 'tab', 'new'],
    run: ({ closePalette }) => {
      window.open('/__rewind/recover', '_blank', 'noopener,noreferrer');
      closePalette();
    },
  });

  // ── Debug modal ────────────────────────────────────────────────────────
  // Opens the debug modal exactly like #debug / /debug typed in chat.
  // Fetch is relative so it works through any proxy without a base-URL import.
  async function openDebug(subcmd: string, closePalette: () => void) {
    closePalette();
    const sid = String(getAppState().currentSession || 'default');
    try {
      const r = await fetch(`/v1/debug/${encodeURIComponent(subcmd)}/${encodeURIComponent(sid)}`);
      const j = await r.json() as { success?: boolean; data?: Record<string, unknown> };
      if (j.success && j.data) showDebugModal(subcmd, j.data);
    } catch (e) {
      console.warn('[debug cmd] fetch failed', e);
    }
  }

  // Entries come from DEBUG_MENU_ENTRIES (panels/debug-panel.ts) so the `/`
  // palette stays in sync with the CodeView Debug panel and the backend
  // REGISTRY. Keywords are derived from id + label tokens; 'inspect' /
  // 'internals' are seeded for the overview entry so "/inspect" still finds it.
  for (const sub of DEBUG_MENU_ENTRIES) {
    const labelTokens = sub.label.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const extras = sub.id === 'overview' ? ['inspect', 'internals'] : [];
    const keywords = Array.from(new Set(['debug', sub.id, ...labelTokens, ...extras]));
    add({
      id: `debug.${sub.id}`,
      group: 'debug',
      label: `Debug: ${sub.label}`,
      icon: 'bug',
      keywords,
      run: ({ closePalette }) => { void openDebug(sub.id, closePalette); },
    });
  }

  // ── Auto-wrapped registers ──────────────────────────────────────────────
  // `header.*` (icon buttons) and `prefs.open.*` are derived from existing
  // registers at palette-render time inside AppCommandPalette so the entries
  // stay live as modules add/remove header buttons or prefs tabs. We don't
  // seed those as static entries here to avoid stale ids.
  // `panel.toggle.*` was removed — see AppCommandPalette comment for why.

  void LAYOUTS; // type ref-keep to ensure the layouts module is referenced
}
