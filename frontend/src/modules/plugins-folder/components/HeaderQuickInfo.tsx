// HeaderQuickInfo — live quickinfo readout shown inside the plugins-header
// toggle button when one or more CWD plugins are installed.
//
// Picks the first tile across the manifest that declares `headline.from` and
// fetches its data through the normal `useTileData` pipeline (which respects
// the per-CWD trust gate). The resolved value is rendered as compact
// "<value> · <label>" text — replacing the cut-3 `+` glyph with something
// the user actually wants to glance at.
//
// Refresh: re-fetches periodically so the header text follows the underlying
// data without the user having to open the dropdown. Honours the headline
// tile's `refresh.interval` when set; otherwise falls back to a 60s soft
// tick. Also subscribes to the shared `tileReloadTicks` slot in the plugins
// store — when the user hits the per-tile reload button in the dropdown,
// the header re-fetches in lockstep.

import { useEffect, useState } from 'react';
import { fetchTileData } from '../bridge/api.js';
import { usePluginsStore, getOrderedPlugins, tileReloadKey } from '../store/pluginsStore.js';
import { getPath, toDisplay } from '../widgets/template.js';
import type { PluginManifest, ScanResult, TileManifest } from '../bridge/api.js';

interface HeadlineTarget {
  plugin: PluginManifest;
  tile: TileManifest;
  from: string;
  label: string | undefined;
}

function pickHeadlineTile(plugins: PluginManifest[]): HeadlineTarget | null {
  // Only the user-ordered TOP plugin drives the header. Falling through to the
  // next plugin would make the TOP badge lie when the top plugin has no
  // headline-bearing tile (the header would keep showing the second plugin's
  // headline after a reorder).
  const plugin = plugins[0];
  if (!plugin) return null;
  for (const tile of plugin.tiles) {
    const from = tile.headline?.from;
    if (typeof from === 'string' && from.length > 0 && tile.data) {
      return { plugin, tile, from, label: tile.headline?.label };
    }
  }
  return null;
}

function truncate(s: string, max = 38): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
}

interface Props {
  cwd: string;
  manifest: ScanResult;
  activeCount: number;
  pluginCount: number;
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'value'; value: string }
  | { kind: 'empty' }
  | { kind: 'error'; message: string };

export function HeaderQuickInfo({ cwd, manifest, activeCount, pluginCount }: Props) {
  const pluginOrder = usePluginsStore((s) => s.pluginOrder[cwd]);
  const ordered = getOrderedPlugins(manifest.plugins, pluginOrder);
  const target = pickHeadlineTile(ordered);
  const trust = usePluginsStore((s) => s.trust[cwd]);
  const allowed = trust === 'allow' && !!target;
  // Subscribe to the same shared reload tick the tile itself uses. When the
  // user hits the per-tile reload button in the dropdown, this bumps and the
  // header re-fetches in lockstep. 0 when no target (no key to subscribe to).
  const sharedTick = usePluginsStore((s) =>
    target ? s.tileReloadTicks[tileReloadKey(cwd, target.plugin.name, target.tile.id)] || 0 : 0,
  );

  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [tick, setTick] = useState(0);

  // Soft poll so the header text follows the underlying data without the user
  // opening the dropdown, but ONLY for tiles that explicitly opted into a
  // refresh interval.
  //
  // Important perf guard: `refresh: "manual"` must stay manual here too. Some
  // headline loaders are intentionally expensive (the built-in "biggest files"
  // sample walks the whole CWD tree). Polling those from the always-mounted
  // header turns an idle YPA tab into a periodic bridge event-loop stall, which
  // backs up unrelated dynamic surfaces such as prefs module tabs and the
  // GitHub panel.
  useEffect(() => {
    if (!allowed || !target) return;
    const refresh = target.tile.refresh;
    if (!refresh || refresh === 'manual' || typeof refresh !== 'object') return;
    const seconds = Number(refresh.interval);
    if (!Number.isFinite(seconds) || seconds < 1) return;
    const id = window.setInterval(() => setTick((n) => n + 1), seconds * 1000);
    return () => window.clearInterval(id);
  }, [allowed, target?.plugin.name, target?.tile.id, target?.tile.refresh]);

  useEffect(() => {
    if (!allowed || !target) {
      setPhase({ kind: 'idle' });
      return;
    }
    const ctl = new AbortController();
    // First load shows the spinner; background ticks keep the prior value
    // visible so the button doesn't flash on every poll.
    setPhase((prev) => (prev.kind === 'value' || prev.kind === 'empty' ? prev : { kind: 'loading' }));
    fetchTileData({
      cwd,
      plugin: target.plugin.name,
      tile: target.tile.id,
      signal: ctl.signal,
    })
      .then((data) => {
        if (ctl.signal.aborted) return;
        const resolved = getPath(data, target.from);
        const display = toDisplay(resolved);
        if (display) setPhase({ kind: 'value', value: display });
        else setPhase({ kind: 'empty' });
      })
      .catch((e: any) => {
        if (ctl.signal.aborted || e?.name === 'AbortError') return;
        setPhase({ kind: 'error', message: e?.message ? String(e.message) : 'error' });
      });
    return () => ctl.abort();
  }, [cwd, allowed, target?.plugin.name, target?.tile.id, target?.from, tick, sharedTick]);

  // Headline path: trust granted + data resolved.
  if (allowed && phase.kind === 'value') {
    return (
      <span className="plugins-quickinfo plugins-quickinfo-value">
        <span className="plugins-quickinfo-text">{truncate(phase.value)}</span>
        {target?.label && (
          <span className="plugins-quickinfo-label">{target.label}</span>
        )}
      </span>
    );
  }

  // Resolved but empty — surface the tile label so the user can tell the path
  // missed rather than seeing a perpetual loading state.
  if (allowed && phase.kind === 'empty') {
    return (
      <span className="plugins-quickinfo plugins-quickinfo-value">
        <span className="plugins-quickinfo-text">{truncate(target!.tile.label, 24)}</span>
        <span className="plugins-quickinfo-label">no data</span>
      </span>
    );
  }

  // Fetch errored — show a short hint so the user knows to look.
  if (allowed && phase.kind === 'error') {
    return (
      <span className="plugins-quickinfo plugins-quickinfo-error" title={phase.message}>
        <span className="plugins-quickinfo-text">{truncate(target!.tile.label, 18)}</span>
        <span className="plugins-quickinfo-label">err</span>
      </span>
    );
  }

  // Loading state (trust granted, fetch in flight).
  if (allowed && phase.kind === 'loading') {
    return (
      <span className="plugins-quickinfo plugins-quickinfo-loading">
        <span className="plugins-quickinfo-text">…</span>
      </span>
    );
  }

  // Fallback: counts/labels, no data fetch needed.
  if (activeCount > 0) {
    return (
      <span className="plugins-quickinfo plugins-quickinfo-count">
        <span className="plugins-quickinfo-text">{activeCount} active</span>
      </span>
    );
  }

  const firstLabel = ordered[0]?.label ?? manifest.plugins[0]?.label;
  return (
    <span className="plugins-quickinfo plugins-quickinfo-count">
      <span className="plugins-quickinfo-text">
        {firstLabel ? truncate(firstLabel, 18) : `${pluginCount} plugin${pluginCount === 1 ? '' : 's'}`}
      </span>
    </span>
  );
}
