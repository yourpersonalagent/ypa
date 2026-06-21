// TileRenderer — dispatches a manifest to the right view.
//
// Three paths:
//   • declarative (default when `template` is set) — fetch data via
//     `/v1/plugins/data` and render the matching widget. No iframe.
//   • sandboxed (legacy/escape hatch) — render the existing `<TileIframe>`.
//   • unknown — render a small "missing template" placeholder so the user
//     can debug the manifest without opening devtools.

import { useTileData } from './useTileData.js';
import { getWidget } from '../widgets/index.js';
import { TileIframe } from './TileIframe.js';
import type { TileManifest } from '../bridge/api.js';

interface TileRendererProps {
  cwd: string;
  plugin: string;
  tile: TileManifest;
  /** Bump to force a reload (cut 4 hot-swap, future use). */
  cacheBust?: string | number;
}

export function TileRenderer({ cwd, plugin, tile, cacheBust }: TileRendererProps) {
  const isSandboxed = tile.trust === 'sandboxed' || (!tile.template && !!tile.entry);
  if (isSandboxed) {
    return <TileIframe cwd={cwd} plugin={plugin} tile={tile} cacheBust={cacheBust} />;
  }
  return <DeclarativeTile cwd={cwd} plugin={plugin} tile={tile} />;
}

function DeclarativeTile({ cwd, plugin, tile }: { cwd: string; plugin: string; tile: TileManifest }) {
  const { data, loading, error, reload } = useTileData({ cwd, plugin, tile });
  const Widget = getWidget(tile.template);

  if (!Widget) {
    return (
      <div className="plugin-tile-decl plugin-tile-missing" role="alert">
        <div className="pw-tile-error-title">Unknown template: <code>{tile.template}</code></div>
        <div className="pw-tile-error-hint">Tile <code>{plugin}/{tile.id}</code> declares a template the host doesn't ship. Update YHA or change the manifest.</div>
      </div>
    );
  }

  const h = tile.size?.h;
  const w = tile.size?.w;
  // Chrome lives on the outer wrapper so it stays visible while the inner
  // content scrolls — and so its hit area doesn't overlap a scrollbar gutter.
  return (
    <div
      className="plugin-tile-decl"
      style={{
        width: '100%',
        maxWidth: w ? `${w}px` : undefined,
      }}
    >
      <div className="pw-tile-chrome">
        {loading && <span className="pw-tile-loading">…</span>}
        {error && <span className="pw-tile-error" title={error}>!</span>}
        {tile.data && (
          <button
            type="button"
            className="pw-tile-reload"
            title="Reload tile data"
            onClick={reload}
            disabled={loading}
          >↻</button>
        )}
      </div>
      <div
        className="pw-tile-scroll"
        style={{
          maxHeight: h ? `${h}px` : undefined,
          overflow: h ? 'auto' : undefined,
        }}
      >
        <Widget data={data} props={(tile.props as Record<string, unknown>) || {}} />
      </div>
    </div>
  );
}
