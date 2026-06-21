// plugins-folder frontend module — the loader.
//
// On activate: registers the `+`-or-headline section into `headerSections`
// at order:20 (slotted between cwd@10 and personnel@30), then subscribes
// to the active CWD. Every CWD change re-fetches `/v1/plugins`, diffs the
// manifest against the currently-registered per-tile `appCommands` entries,
// and adds/removes commands accordingly.
//
// Per-tile commands are tracked here (not via `removeAllByModule`) so the
// diff doesn't need to nuke and re-register everything — quieter for the
// register change listeners and friendlier to React.

import host from '../../host/index.js';
import { useAppStore } from '../../stores/appStore.js';
import { usePluginsStore, tileKey } from './store/pluginsStore.js';
import { fetchManifest } from './bridge/api.js';
import type { PluginManifest, TileManifest } from './bridge/api.js';
import { PluginsHeaderSection } from './components/PluginsHeaderSection.js';

const MODULE_NAME = 'plugins-folder';

let unsubCwd: (() => void) | null = null;
let inFlight: AbortController | null = null;
let registeredCommands = new Map<string, () => void>();

async function refreshFor(cwd: string | null): Promise<void> {
  const store = usePluginsStore.getState();
  store.setCwd(cwd);

  if (inFlight) { inFlight.abort(); inFlight = null; }

  if (!cwd) {
    store.setManifest(null);
    store.setError(null);
    diffCommands([]);
    return;
  }

  store.setLoading(true);
  store.setError(null);

  const ctl = new AbortController();
  inFlight = ctl;
  try {
    const result = await fetchManifest(cwd, ctl.signal);
    if (ctl.signal.aborted) return;
    if (usePluginsStore.getState().cwd !== cwd) return; // raced past us
    store.setManifest(result);
    diffCommands(result.plugins);
  } catch (e) {
    if (ctl.signal.aborted) return;
    store.setError(e instanceof Error ? e.message : String(e));
    store.setManifest(null);
    diffCommands([]);
  } finally {
    if (inFlight === ctl) inFlight = null;
    store.setLoading(false);
  }
}

function diffCommands(plugins: PluginManifest[]): void {
  const want = new Map<string, { plugin: PluginManifest; tile: TileManifest }>();
  for (const p of plugins) {
    for (const t of p.tiles) want.set(tileKey(p.name, t.id), { plugin: p, tile: t });
  }

  // Remove vanished.
  for (const [k, dispose] of registeredCommands) {
    if (!want.has(k)) {
      dispose();
      registeredCommands.delete(k);
    }
  }

  // Add new.
  for (const [k, { plugin, tile }] of want) {
    if (registeredCommands.has(k)) continue;
    const dispose = host.registers.appCommands.add(
      {
        id: `plugin.${plugin.name}.${tile.id}`,
        group: `module:plugins-folder`,
        label: `${plugin.label} · ${tile.label}`,
        keywords: ['plugin', plugin.name, tile.id, ...(tile.command?.keywords || [])],
        run: () => openTile(plugin.name, tile.id),
      },
      MODULE_NAME,
    );
    registeredCommands.set(k, dispose);
  }
}

function openTile(plugin: string, tile: string): void {
  const store = usePluginsStore.getState();
  const cwd = store.cwd;
  if (!cwd) return;

  // Activation is plugin-wide now — turning on the plugin renders every tile.
  store.activatePlugin(cwd, plugin);
  store.setDropdownOpen(true);

  requestAnimationFrame(() => {
    const row = document.querySelector<HTMLElement>(
      `.plugins-tile-row[data-tile-id="${CSS.escape(tile)}"]`,
    );
    row?.scrollIntoView({ block: 'nearest' });
  });
}

export default {
  activate() {
    host.registers.headerSections.add(
      {
        id: 'plugins-folder.section',
        sectionId: 'hs-plugins',
        bodyId: 'plugins-panel',
        order: 20,
        component: PluginsHeaderSection,
        panelLabel: 'Plugins',
        panelKeywords: ['plugins', 'tiles', 'cwd plugins', 'widgets'],
      },
      MODULE_NAME,
    );

    // Seed from current CWD, then subscribe for changes.
    const initial = useAppStore.getState().sessionWorkingDir;
    void refreshFor(initial);

    let prev = initial;
    unsubCwd = useAppStore.subscribe((state) => {
      const next = state.sessionWorkingDir;
      if (next === prev) return;
      prev = next;
      void refreshFor(next);
    });

    return { name: MODULE_NAME };
  },

  deactivate() {
    if (unsubCwd) { unsubCwd(); unsubCwd = null; }
    if (inFlight) { inFlight.abort(); inFlight = null; }
    for (const dispose of registeredCommands.values()) dispose();
    registeredCommands.clear();
    host.removeModuleEverywhere(MODULE_NAME);
  },
};
