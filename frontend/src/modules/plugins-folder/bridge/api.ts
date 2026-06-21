// Bridge API client for the plugins-folder module.
//
// Wraps GET /v1/plugins and builds asset URLs for GET /v1/plugins/asset.
// Shapes mirror bridge/modules/plugins-folder/scanner.ts — kept in sync
// by convention, not by import (different module systems).

export type TileTrust = 'declarative' | 'sandboxed' | 'esm';

export interface TileManifest {
  id: string;
  label: string;
  /** Built-in widget id when trust === 'declarative'. */
  template?: string;
  /** Template-specific config; the widget validates its own shape. */
  props?: Record<string, unknown>;
  /** Filename of a bridge-side data loader (e.g. "data.ts"). */
  data?: string;
  /** Refresh policy. */
  refresh?: { interval?: number } | 'manual';
  /** Iframe entry HTML when trust === 'sandboxed'. */
  entry?: string;
  size?: { w?: number; h?: number };
  headline?: { label?: string; trend?: boolean; from?: string };
  command?: { keywords?: string[] };
  inlineSupported?: boolean;
  permissions?: string[];
  trust?: TileTrust;
}

export interface PluginManifest {
  name: string;
  label: string;
  version?: string;
  icon?: string;
  trust?: TileTrust;
  registry?: { id?: string; homepage?: string; checksum?: string };
  tiles: TileManifest[];
}

export interface ScanResult {
  cwd: string;
  pluginsDir: string;
  exists: boolean;
  plugins: PluginManifest[];
  errors: Array<{ where: string; message: string }>;
}

export async function fetchManifest(cwd: string, signal?: AbortSignal): Promise<ScanResult> {
  const url = `/v1/plugins?cwd=${encodeURIComponent(cwd)}`;
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`/v1/plugins ${res.status}`);
  const body = await res.json();
  if (!body || body.success === false) {
    throw new Error(body?.error || 'plugin manifest fetch failed');
  }
  return body as ScanResult;
}

export function assetUrl(opts: {
  cwd: string;
  plugin: string;
  tile?: string;
  path: string;
  cacheBust?: string | number;
}): string {
  const params = new URLSearchParams({
    cwd: opts.cwd,
    plugin: opts.plugin,
    path: opts.path,
  });
  if (opts.tile) params.set('tile', opts.tile);
  if (opts.cacheBust !== undefined) params.set('v', String(opts.cacheBust));
  return `/v1/plugins/asset?${params.toString()}`;
}

export async function fetchTileData(opts: {
  cwd: string;
  plugin: string;
  tile: string;
  query?: Record<string, string | number | boolean>;
  signal?: AbortSignal;
}): Promise<unknown> {
  const params = new URLSearchParams({
    cwd: opts.cwd,
    plugin: opts.plugin,
    tile: opts.tile,
  });
  if (opts.query) {
    for (const [k, v] of Object.entries(opts.query)) params.set(`q.${k}`, String(v));
  }
  const res = await fetch(`/v1/plugins/data?${params.toString()}`, { signal: opts.signal });
  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.success === false) {
    throw new Error(body?.error || `/v1/plugins/data ${res.status}`);
  }
  return body.data;
}
