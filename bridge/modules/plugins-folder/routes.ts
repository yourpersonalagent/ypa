'use strict';

const fs = require('fs');
const { safeResolve } = require('../../config/paths');
const logger = require('../../core/logger');
const { scanPlugins } = require('./scanner');
const { resolveAsset, ASSET_CSP } = require('./assets');
const { loadTileData } = require('./data');

export function registerPluginsRoutes(app: any): void {
  // ── GET /v1/plugins?cwd=<path> ────────────────────────────────────────────
  // Returns the manifest tree for <cwd>/.yha-plugins/. Missing folder is
  // not an error — returns { exists: false, plugins: [] }.
  app.get('/v1/plugins', async (req: any, res: any) => {
    const rawCwd = String(req.query?.cwd || '');
    if (!rawCwd) return res.status(400).json({ success: false, error: 'cwd required' });
    let cwdResolved: string;
    try {
      cwdResolved = await safeResolve(rawCwd);
    } catch (e: any) {
      return res.status(e?.status || 400).json({ success: false, error: e?.message || String(e) });
    }
    try {
      const result = await scanPlugins(cwdResolved);
      res.json({ success: true, ...result });
    } catch (e: any) {
      logger.error?.('plugins.scan failed', { cwd: cwdResolved, err: e?.message });
      res.status(500).json({ success: false, error: e?.message || String(e) });
    }
  });

  // ── GET /v1/plugins/asset?cwd=<path>&plugin=<name>&tile=<id>&path=<rel> ──
  // Streams an allow-listed file from inside a plugin/tile folder. Sets a
  // tight CSP because tile HTML runs in a sandboxed iframe.
  app.get('/v1/plugins/asset', async (req: any, res: any) => {
    const rawCwd = String(req.query?.cwd || '');
    const plugin = String(req.query?.plugin || '');
    const tile = req.query?.tile ? String(req.query.tile) : undefined;
    const relPath = String(req.query?.path || '');
    if (!rawCwd) return res.status(400).json({ success: false, error: 'cwd required' });
    let cwdResolved: string;
    try {
      cwdResolved = await safeResolve(rawCwd);
    } catch (e: any) {
      return res.status(e?.status || 400).json({ success: false, error: e?.message || String(e) });
    }
    let asset: any;
    try {
      asset = await resolveAsset({ cwdResolved, plugin, tile, relPath });
    } catch (e: any) {
      return res.status(e?.status || 400).json({ success: false, error: e?.message || String(e) });
    }

    res.setHeader('Content-Type', asset.contentType);
    res.setHeader('Content-Security-Policy', ASSET_CSP);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    // Stream rather than buffer; tile bundles can include images/fonts.
    const stream = fs.createReadStream(asset.absPath);
    stream.on('error', (err: any) => {
      logger.error?.('plugins.asset stream error', { err: err?.message });
      if (!res.headersSent) res.status(500).end();
      else res.end();
    });
    stream.pipe(res);
  });

  // ── GET /v1/plugins/data?cwd=&plugin=&tile=&q.<k>=<v>… ────────────────────
  // Runs the tile's declared `data` loader (server-side Node) and returns
  // its JSON result. The loader filename is read from the tile manifest
  // rather than the query string — clients only address tiles by slug.
  app.get('/v1/plugins/data', async (req: any, res: any) => {
    const rawCwd = String(req.query?.cwd || '');
    const pluginName = String(req.query?.plugin || '');
    const tileId = String(req.query?.tile || '');
    if (!rawCwd) return res.status(400).json({ success: false, error: 'cwd required' });
    if (!pluginName) return res.status(400).json({ success: false, error: 'plugin required' });
    if (!tileId) return res.status(400).json({ success: false, error: 'tile required' });

    let cwdResolved: string;
    try {
      cwdResolved = await safeResolve(rawCwd);
    } catch (e: any) {
      return res.status(e?.status || 400).json({ success: false, error: e?.message || String(e) });
    }

    // Re-scan to locate the tile manifest. Cheap (a few readdir + readFile
    // calls), and guarantees the manifest seen here matches the validated
    // shape — clients can't smuggle a non-manifest `.ts` path through.
    let scan: any;
    try {
      scan = await scanPlugins(cwdResolved);
    } catch (e: any) {
      return res.status(500).json({ success: false, error: e?.message || String(e) });
    }
    const plugin = scan.plugins.find((p: any) => p.name === pluginName);
    if (!plugin) return res.status(404).json({ success: false, error: 'plugin not found' });
    const tile = plugin.tiles.find((t: any) => t.id === tileId);
    if (!tile) return res.status(404).json({ success: false, error: 'tile not found' });
    if (!tile.data) return res.status(404).json({ success: false, error: 'tile has no data loader' });

    // Extract `q.<key>=<value>` pairs into a flat object for the loader's ctx.query.
    const query: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.query || {})) {
      if (k.startsWith('q.') && typeof v === 'string') query[k.slice(2)] = v;
    }

    try {
      const result = await loadTileData({
        cwdResolved,
        plugin: pluginName,
        tile: tileId,
        dataFile: tile.data,
        query,
      });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ success: true, data: result });
    } catch (e: any) {
      const status = e?.status || 500;
      const message = e?.message || String(e);
      logger.error?.('plugins.data failed', { plugin: pluginName, tile: tileId, err: message });
      res.status(status).json({ success: false, error: message });
    }
  });
}
