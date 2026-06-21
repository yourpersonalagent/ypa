'use strict';

const fs = require('fs');
const path = require('path');

export const SLUG_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const PLUGINS_DIRNAME = '.yha-plugins';

// Built-in widget templates the frontend ships. Plugins reference these by
// name in tile.json. The scanner doesn't enforce the list (forward-compat
// for new widgets shipped in newer frontends) — it just validates shape.
export type TileTrust = 'declarative' | 'sandboxed' | 'esm';

export interface TileManifest {
  id: string;
  label: string;
  /** Declarative widget id (e.g. "list", "table"). Optional iff `entry` is set. */
  template?: string;
  /** Free-form, template-specific config. Validated by the widget, not the scanner. */
  props?: Record<string, unknown>;
  /** Filename of a bridge-side data loader (e.g. "data.ts" / "data.mjs"). */
  data?: string;
  /** Refresh policy for the data loader. */
  refresh?: { interval?: number } | 'manual';
  /** Sandboxed-iframe entry HTML. Optional iff `template` is set. */
  entry?: string;
  size?: { w?: number; h?: number };
  /** Headline hook for the header rotator (cut 5). `from` reads a key out of the data result. */
  headline?: { label?: string; trend?: boolean; from?: string };
  command?: { keywords?: string[] };
  inlineSupported?: boolean;
  permissions?: string[];
  /** Render mode. Defaults to `declarative` if `template` is set, else `sandboxed`. */
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

function isSlug(s: unknown): s is string {
  return typeof s === 'string' && SLUG_RE.test(s);
}

async function readJson(file: string): Promise<any> {
  const raw = await fs.promises.readFile(file, 'utf8');
  return JSON.parse(raw);
}

function isPlainRelFilename(s: unknown): s is string {
  return typeof s === 'string' && !!s && !s.includes('..') && !s.startsWith('/') && !s.includes('\\');
}

function validateTile(raw: any): TileManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  if (!isSlug(raw.id)) return null;
  if (typeof raw.label !== 'string' || !raw.label) return null;

  const hasTemplate = typeof raw.template === 'string' && raw.template.length > 0;
  const hasEntry = typeof raw.entry === 'string' && raw.entry.length > 0;
  // Must declare at least one render mode.
  if (!hasTemplate && !hasEntry) return null;
  if (hasEntry && !isPlainRelFilename(raw.entry)) return null;
  if (raw.data != null && !isPlainRelFilename(raw.data)) return null;

  // Trust defaults: declarative if a template is declared, sandboxed if only
  // an entry HTML is present. Explicit `trust` in the manifest wins.
  let trust: TileTrust | undefined;
  if (raw.trust === 'declarative' || raw.trust === 'sandboxed' || raw.trust === 'esm') {
    trust = raw.trust;
  } else {
    trust = hasTemplate ? 'declarative' : 'sandboxed';
  }
  if (trust === 'declarative' && !hasTemplate) return null;
  if (trust === 'sandboxed' && !hasEntry) return null;

  const out: TileManifest = {
    id: raw.id,
    label: raw.label,
    trust,
  };
  if (hasTemplate) out.template = raw.template;
  if (hasEntry) out.entry = raw.entry;
  if (typeof raw.data === 'string' && raw.data) out.data = raw.data;
  if (raw.props && typeof raw.props === 'object' && !Array.isArray(raw.props)) {
    out.props = raw.props as Record<string, unknown>;
  }
  if (raw.refresh === 'manual') {
    out.refresh = 'manual';
  } else if (raw.refresh && typeof raw.refresh === 'object') {
    const interval = Number(raw.refresh.interval);
    if (Number.isFinite(interval) && interval >= 1) {
      out.refresh = { interval };
    }
  }
  if (raw.size && typeof raw.size === 'object') {
    const w = Number(raw.size.w);
    const h = Number(raw.size.h);
    out.size = {
      w: Number.isFinite(w) ? w : undefined,
      h: Number.isFinite(h) ? h : undefined,
    };
  }
  if (raw.headline && typeof raw.headline === 'object') {
    out.headline = {
      label: typeof raw.headline.label === 'string' ? raw.headline.label : undefined,
      trend: !!raw.headline.trend,
      from: typeof raw.headline.from === 'string' ? raw.headline.from : undefined,
    };
  }
  if (raw.command && Array.isArray(raw.command.keywords)) {
    out.command = {
      keywords: raw.command.keywords.filter((k: any) => typeof k === 'string'),
    };
  }
  if (typeof raw.inlineSupported === 'boolean') out.inlineSupported = raw.inlineSupported;
  if (Array.isArray(raw.permissions)) {
    out.permissions = raw.permissions.filter((p: any) => typeof p === 'string');
  }
  return out;
}

function validatePlugin(raw: any, folderName: string): PluginManifest | null {
  if (!raw || typeof raw !== 'object') return null;
  // Plugin name must match its folder; folder is authoritative.
  const name = isSlug(raw.name) && raw.name === folderName ? raw.name : isSlug(folderName) ? folderName : null;
  if (!name) return null;
  const label = typeof raw.label === 'string' && raw.label ? raw.label : name;
  const out: PluginManifest = {
    name,
    label,
    tiles: [],
  };
  if (typeof raw.version === 'string') out.version = raw.version;
  if (typeof raw.icon === 'string') out.icon = raw.icon;
  if (raw.trust === 'sandboxed' || raw.trust === 'esm' || raw.trust === 'declarative') out.trust = raw.trust;
  if (raw.registry && typeof raw.registry === 'object') {
    out.registry = {
      id: typeof raw.registry.id === 'string' ? raw.registry.id : undefined,
      homepage: typeof raw.registry.homepage === 'string' ? raw.registry.homepage : undefined,
      checksum: typeof raw.registry.checksum === 'string' ? raw.registry.checksum : undefined,
    };
  }
  return out;
}

// Scan <cwdResolved>/.yha-plugins/. Caller is responsible for confining
// cwdResolved to allowed roots — scanner trusts the absolute path it
// gets. Malformed manifests are skipped with an error recorded; a missing
// .yha-plugins directory is the normal "no plugins yet" state and is not
// an error.
export async function scanPlugins(cwdResolved: string): Promise<ScanResult> {
  const pluginsDir = path.join(cwdResolved, PLUGINS_DIRNAME);
  const result: ScanResult = {
    cwd: cwdResolved,
    pluginsDir,
    exists: false,
    plugins: [],
    errors: [],
  };

  let entries: any[];
  try {
    entries = await fs.promises.readdir(pluginsDir, { withFileTypes: true });
    result.exists = true;
  } catch (e: any) {
    if (e?.code === 'ENOENT') return result;
    result.errors.push({ where: pluginsDir, message: e?.message || String(e) });
    return result;
  }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const folder = ent.name;
    if (!isSlug(folder)) continue; // ignore weird names silently
    const pluginRoot = path.join(pluginsDir, folder);
    const pluginJsonPath = path.join(pluginRoot, 'plugin.json');
    let raw: any;
    try {
      raw = await readJson(pluginJsonPath);
    } catch (e: any) {
      result.errors.push({ where: `${folder}/plugin.json`, message: e?.message || String(e) });
      continue;
    }
    const plugin = validatePlugin(raw, folder);
    if (!plugin) {
      result.errors.push({ where: `${folder}/plugin.json`, message: 'invalid manifest' });
      continue;
    }

    const tilesDir = path.join(pluginRoot, 'tiles');
    let tileEntries: any[] = [];
    try {
      tileEntries = await fs.promises.readdir(tilesDir, { withFileTypes: true });
    } catch (_) {
      // No tiles dir is fine — plugin contributes nothing yet.
    }

    for (const tEnt of tileEntries) {
      if (!tEnt.isDirectory()) continue;
      const tileFolder = tEnt.name;
      if (!isSlug(tileFolder)) continue;
      const tileJsonPath = path.join(tilesDir, tileFolder, 'tile.json');
      let tileRaw: any;
      try {
        tileRaw = await readJson(tileJsonPath);
      } catch (e: any) {
        result.errors.push({ where: `${folder}/tiles/${tileFolder}/tile.json`, message: e?.message || String(e) });
        continue;
      }
      // Folder name wins as the tile id.
      const tile = validateTile({ ...tileRaw, id: tileFolder });
      if (!tile) {
        result.errors.push({ where: `${folder}/tiles/${tileFolder}/tile.json`, message: 'invalid manifest' });
        continue;
      }
      plugin.tiles.push(tile);
    }

    plugin.tiles.sort((a, b) => a.label.localeCompare(b.label));
    result.plugins.push(plugin);
  }

  result.plugins.sort((a, b) => a.label.localeCompare(b.label));
  return result;
}
