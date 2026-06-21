// ── HTTP routes for /v1/mcp/sources/* — external MCP source CRUD + import ──────
// Sibling to mcp-client's /v1/mcp/* routes. These manage the user-added
// external source DEFINITIONS; lifecycle (start/stop) still goes through
// mcp-client's /v1/mcp/:name/start|stop, which sees external sources because
// readUpstreamRegistry() merges them in. Live running status comes from
// /v1/mcp/ (which now tags each server with `kind`).
'use strict';

const store = require('./store');

function _mcpApi() {
  try { return require('../../../core/modules').getModuleApi('mcp-client'); }
  catch (_) { return undefined; }
}

function registerExternalSourceRoutes(app) {
  // GET /v1/mcp/sources — list external source definitions
  app.get('/v1/mcp/sources', (_req, res) => {
    res.json({ success: true, sources: store.listSources() });
  });

  // POST /v1/mcp/sources — add one external source (disabled until started)
  app.post('/v1/mcp/sources', (req, res) => {
    const result = store.addSource(req.body || {});
    if (!result.ok) return res.status(400).json({ success: false, error: result.error });
    res.json({ success: true, source: result.source });
  });


  // GET /v1/mcp/sources/discover?q=github&limit=20 — search the official MCP
  // Registry and return importable candidates where registry metadata includes
  // a remote endpoint or package install recipe YHA can run.
  app.get('/v1/mcp/sources/discover', async (req, res) => {
    try {
      const { searchOfficialRegistry } = require('./discovery');
      const results = await searchOfficialRegistry(String(req.query.q || ''), Number(req.query.limit) || 20);
      res.json({ success: true, provider: 'official-registry', results });
    } catch (e) {
      res.status(502).json({ success: false, provider: 'official-registry', error: e instanceof Error ? e.message : String(e) });
    }
  });

  // POST /v1/mcp/sources/import-discovered — persist one candidate returned by
  // /discover. Like paste-import, it is added stopped/default-off for review.
  app.post('/v1/mcp/sources/import-discovered', (req, res) => {
    const cand = req.body && req.body.candidate;
    if (!cand?.transport) return res.status(400).json({ success: false, error: 'candidate.transport required' });
    const result = store.addSource({
      id: cand.id || cand.name,
      label: cand.label || cand.name || cand.id,
      transport: cand.transport,
      origin: 'registry',
      enabledByDefault: false,
    });
    if (!result.ok) return res.status(400).json({ success: false, error: result.error });
    res.json({ success: true, source: result.source });
  });

  // GET /v1/mcp/sources/:id
  app.get('/v1/mcp/sources/:id', (req, res) => {
    const src = store.getSource(req.params.id);
    if (!src) return res.status(404).json({ success: false, error: `unknown external source: ${req.params.id}` });
    res.json({ success: true, source: src });
  });

  // PATCH /v1/mcp/sources/:id — partial update (id immutable)
  app.patch('/v1/mcp/sources/:id', (req, res) => {
    const result = store.updateSource(req.params.id, req.body || {});
    if (!result.ok) return res.status(result.error.startsWith('unknown') ? 404 : 400).json({ success: false, error: result.error });
    res.json({ success: true, source: result.source });
  });

  // DELETE /v1/mcp/sources/:id — stop it if running, then drop the definition
  app.delete('/v1/mcp/sources/:id', (req, res) => {
    const { id } = req.params;
    if (!store.getSource(id)) return res.status(404).json({ success: false, error: `unknown external source: ${id}` });
    // Stop + record disable intent so the supervisor doesn't keep retrying a
    // server we just removed from the registry. Best-effort: deletion proceeds
    // even if mcp-client is unavailable.
    try { _mcpApi()?.setMcpDisabled?.(id); } catch (_) { /* ignore */ }
    try { _mcpApi()?.stopMcpServer?.(id); } catch (_) { /* ignore */ }
    const removed = store.deleteSource(id);
    res.json({ success: removed, id });
  });

  // POST /v1/mcp/sources/import — parse a Claude/Cursor/Codex mcpServers config
  // body: { config: <json string|object> }  → returns parsed candidates and
  // persists any that don't collide, all disabled-by-default for review.
  app.post('/v1/mcp/sources/import', (req, res) => {
    const parsed = store.parseImport((req.body && req.body.config) ?? req.body);
    if (!parsed.ok) return res.status(400).json({ success: false, error: parsed.error });
    const added: any[] = [];
    const skipped: { id: string; reason: string }[] = [];
    for (const cand of parsed.candidates) {
      const r = store.addSource(cand);
      if (r.ok) added.push(r.source);
      else skipped.push({ id: cand.id, reason: r.error });
    }
    res.json({ success: true, added, skipped });
  });
}

module.exports = { registerExternalSourceRoutes };
