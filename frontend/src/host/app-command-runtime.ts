// Shared runtime for every app-command consumer.
//
// The command palette, browser-local agent API, tests and future automation
// adapters MUST use this file instead of rebuilding synthetic commands. That
// keeps newly registered module features immediately discoverable everywhere.

import type { MouseEvent as ReactMouseEvent } from 'react';
import { registers } from './keys.js';
import type {
  AppCommand,
  AppCommandCtx,
  HeaderIconButton,
  HeaderSection,
  HudButton,
  PrefsEntry,
  PrefsTab,
} from './keys.js';
import type { Entry } from './registers.js';
import { prefs } from '../preferences.js';
import { runAutoPaletteAction } from './slots/PrefsEntriesSlot.js';
import { recordCommandUse } from '../pickers/appCommandMru.js';
import { getAppActions, getAppState } from '../stores/appStore.js';

export interface AppCommandSources {
  headerIcons: ReadonlyArray<Entry<HeaderIconButton>>;
  hudButtons: ReadonlyArray<Entry<HudButton>>;
  prefsTabs: ReadonlyArray<Entry<PrefsTab>>;
  prefsEntries: ReadonlyArray<Entry<PrefsEntry>>;
  headerSections: ReadonlyArray<Entry<HeaderSection>>;
}

export function snapshotAppCommandSources(): AppCommandSources {
  return {
    headerIcons: registers.headerIconButtons.list(),
    hudButtons: registers.hudButtons.list(),
    prefsTabs: registers.prefsTabs.list(),
    prefsEntries: registers.prefsEntries.list(),
    headerSections: registers.headerSections.list(),
  };
}

function autoEntryVerb(entry: PrefsEntry): string {
  switch (entry.type) {
    case 'toggle': return 'Toggle';
    case 'radio': return 'Cycle';
    case 'layout': return 'Cycle';
    case 'color-theme': return 'Flip';
    case 'action': return 'Run';
    default: return 'Edit';
  }
}

function stateForEntry(entry: PrefsEntry): { active?: boolean; value?: string } {
  try {
    const value = entry.get();
    if (entry.type === 'toggle') return { active: !!value, value: value ? 'on' : 'off' };
    if (entry.type === 'radio') {
      const option = entry.options?.find((candidate) => candidate.id === value);
      return { value: option?.label ?? String(value ?? '') };
    }
    if (entry.type === 'layout' || entry.type === 'color-theme' ||
        entry.type === 'number' || entry.type === 'text') {
      return { value: String(value ?? '') };
    }
    return {};
  } catch {
    return {};
  }
}

/** Build synthetic commands for registers whose entries already describe UI actions. */
export function buildAutoWrappedCommands(
  sources: AppCommandSources = snapshotAppCommandSources(),
): AppCommand[] {
  const out: AppCommand[] = [];

  for (const entry of sources.headerIcons) {
    const localId = entry.id.replace(/^core\./, '');
    out.push({
      id: `header.${localId}`,
      group: 'header',
      label: entry.title || `Header — ${localId}`,
      keywords: [localId, 'header', 'button'],
      icon: 'circle',
      module: entry.module,
      run: ({ closePalette }) => {
        const domId = entry.domId || localId;
        const element = document.getElementById(domId);
        if (element) element.click();
        else if (entry.onClick) {
          entry.onClick(new MouseEvent('click') as unknown as ReactMouseEvent);
        }
        closePalette();
      },
    });
  }

  for (const section of sources.headerSections) {
    if (!section.panelLabel || !section.sectionId) continue;
    const shortId = section.sectionId.replace(/^hs-/, '');
    out.push({
      id: `header.section.${shortId}`,
      group: 'header',
      label: `Show ${section.panelLabel}`,
      icon: 'panel-top',
      keywords: ['header', 'section', shortId, ...(section.panelKeywords ?? [])],
      module: section.module,
      run: ({ closePalette }) => {
        if (getAppState().layoutMode === 'full') {
          document.getElementById(`btn-${shortId}`)?.click();
        } else {
          getAppActions().setOpenPanel(shortId);
        }
        closePalette();
      },
    });
  }

  for (const button of sources.hudButtons) {
    out.push({
      id: `workflow.${button.id}`,
      group: 'workflow',
      label: button.label,
      keywords: ['workflow', 'editor', 'hud', ...(button.keywords ?? [])],
      icon: 'workflow',
      state: button.state,
      module: button.module,
      run: ({ closePalette }) => {
        if (button.domId) document.getElementById(button.domId)?.click();
        else button.onClick?.();
        closePalette();
      },
    });
  }

  for (const tab of sources.prefsTabs) {
    out.push({
      id: `prefs.open.${tab.id}`,
      group: 'prefs',
      label: `Open ${tab.label}`,
      keywords: [tab.id, 'preferences', 'settings', tab.label.toLowerCase()],
      icon: 'settings',
      module: tab.module,
      run: ({ closePalette }) => {
        prefs.open(tab.id);
        closePalette();
      },
    });
  }

  for (const entry of sources.prefsEntries) {
    if (entry.paletteCommand === false) continue;
    out.push({
      id: `prefs.${entry.id}`,
      group: 'prefs',
      label: `${autoEntryVerb(entry)} ${entry.label}`,
      keywords: ['prefs', entry.tab, entry.id, ...(entry.keywords ?? [])],
      icon: 'sliders',
      state: () => stateForEntry(entry),
      module: entry.module,
      run: ({ closePalette }) => {
        runAutoPaletteAction(entry);
        closePalette();
      },
    });
  }

  return out;
}

/** Current live command catalog. Explicit appCommands win over synthetic ids. */
export function snapshotAppCommands(): AppCommand[] {
  const commands = new Map<string, AppCommand>();
  for (const command of registers.appCommands.list()) commands.set(command.id, command);
  for (const command of buildAutoWrappedCommands()) {
    if (!commands.has(command.id)) commands.set(command.id, command);
  }
  return [...commands.values()];
}

export function findAppCommand(id: string): AppCommand | undefined {
  return snapshotAppCommands().find((command) => command.id === id);
}

/** Run a command through the shared error/MRU path. */
export function runAppCommand(command: AppCommand, ctx: AppCommandCtx): boolean {
  try {
    command.run(ctx);
    recordCommandUse(command.id);
    return true;
  } catch (error) {
    console.warn(`[appCommands] "${command.id}" threw:`, error);
    return false;
  }
}

export function runAppCommandById(id: string, closePalette: () => void = () => {}): boolean {
  const command = findAppCommand(id);
  return command ? runAppCommand(command, { closePalette }) : false;
}
