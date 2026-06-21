// TileIframe — renders a single plugin tile as a sandboxed iframe.
//
// `sandbox="allow-scripts"` (no allow-same-origin) means the tile cannot
// reach our cookies / localStorage / parent DOM. It can still postMessage
// up — cut 5 will wire the host listener for `yha.headline` so tiles can
// publish a value into the headlines register.
//
// Sizing: width takes the manifest hint or 100%; height likewise but
// clamps to a sensible default. Tiles can resize themselves later (cut 5)
// by sending a `yha.resize` postMessage — for now the manifest is law.

import { useMemo } from 'react';
import type { TileManifest } from '../bridge/api.js';
import { assetUrl } from '../bridge/api.js';

interface TileIframeProps {
  cwd: string;
  plugin: string;
  tile: TileManifest;
  /** Bump to force the iframe to reload (cut 4 hot-swap). */
  cacheBust?: string | number;
}

export function TileIframe({ cwd, plugin, tile, cacheBust }: TileIframeProps) {
  // `entry` is required for the sandboxed path; the scanner enforces this,
  // but TS sees the unified optional shape and needs a guard at the boundary.
  const entry = tile.entry || 'index.html';
  const src = useMemo(
    () => assetUrl({ cwd, plugin, tile: tile.id, path: entry, cacheBust }),
    [cwd, plugin, tile.id, entry, cacheBust],
  );

  const w = tile.size?.w;
  const h = tile.size?.h ?? 180;

  return (
    <iframe
      className="plugin-tile-iframe"
      title={`${plugin}/${tile.id}`}
      src={src}
      sandbox="allow-scripts"
      style={{
        width: w ? `${w}px` : '100%',
        height: `${h}px`,
        border: '1px solid var(--border, #333)',
        borderRadius: 4,
        background: 'var(--bg-2, #1a1a1a)',
      }}
    />
  );
}
