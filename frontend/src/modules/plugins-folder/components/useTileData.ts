// useTileData — fetches a tile's bridge-side data loader on mount and on
// refresh ticks. `refresh: 'manual'` (default) fetches once. `refresh:
// { interval: N }` polls every N seconds. Returns the result plus a manual
// `reload()` for the chrome's refresh button.
//
// Race safety: each fetch carries its own AbortController; if the tile
// remounts (CWD change, prop change), in-flight requests abort.

import { useEffect, useRef, useState, useCallback } from 'react';
import { fetchTileData } from '../bridge/api.js';
import { usePluginsStore, tileReloadKey } from '../store/pluginsStore.js';
import type { TileManifest } from '../bridge/api.js';

export interface TileDataState {
  data: unknown;
  loading: boolean;
  error: string | null;
  reload: () => void;
}

export function useTileData(opts: {
  cwd: string;
  plugin: string;
  tile: TileManifest;
}): TileDataState {
  const { cwd, plugin, tile } = opts;
  const hasLoader = !!tile.data;
  const trust = usePluginsStore((s) => s.trust[cwd]);
  const allowed = trust === 'allow';
  // Shared reload tick — bumped by either the tile's own reload button or any
  // other consumer (e.g. HeaderQuickInfo) so all subscribers re-fetch together.
  const sharedTick = usePluginsStore(
    (s) => s.tileReloadTicks[tileReloadKey(cwd, plugin, tile.id)] || 0,
  );
  const bumpTileReload = usePluginsStore((s) => s.bumpTileReload);
  const [data, setData] = useState<unknown>(null);
  const [loading, setLoading] = useState<boolean>(hasLoader && allowed);
  const [error, setError] = useState<string | null>(null);
  const inflight = useRef<AbortController | null>(null);

  const reload = useCallback(() => {
    bumpTileReload(cwd, plugin, tile.id);
  }, [bumpTileReload, cwd, plugin, tile.id]);

  useEffect(() => {
    if (!hasLoader) {
      setData(null);
      setLoading(false);
      setError(null);
      return;
    }
    if (!allowed) {
      // CWD trust not granted (yet) — don't even attempt the call.
      setLoading(false);
      setError(null);
      return;
    }
    inflight.current?.abort();
    const ctl = new AbortController();
    inflight.current = ctl;
    setLoading(true);
    setError(null);
    fetchTileData({ cwd, plugin, tile: tile.id, signal: ctl.signal })
      .then((result) => {
        if (ctl.signal.aborted) return;
        setData(result);
        setError(null);
      })
      .catch((e: any) => {
        if (ctl.signal.aborted || e?.name === 'AbortError') return;
        setError(e instanceof Error ? e.message : String(e));
      })
      .finally(() => {
        if (ctl.signal.aborted) return;
        setLoading(false);
      });
    return () => ctl.abort();
  }, [cwd, plugin, tile.id, hasLoader, allowed, sharedTick]);

  // Interval-driven refresh, if requested (and trust granted).
  useEffect(() => {
    if (!hasLoader || !allowed) return;
    const refresh = tile.refresh;
    if (!refresh || refresh === 'manual') return;
    const seconds = Number(refresh.interval);
    if (!Number.isFinite(seconds) || seconds < 1) return;
    const id = window.setInterval(reload, seconds * 1000);
    return () => window.clearInterval(id);
  }, [hasLoader, allowed, tile.refresh, reload]);

  return { data, loading, error, reload };
}
