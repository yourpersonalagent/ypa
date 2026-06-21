// ── /v1/pet-vision/* + /proxy/pet-vision/* — Pet spatial-snapshot relay ──────
// Producer (frontend) → bridge in-memory store → consumer (MCP child).
//
//   POST /v1/pet-vision/snapshot    — FE pushes the latest PetWorldSnapshot.
//                                     Auth-gated like the rest of /v1/.
//   GET  /v1/pet-vision/snapshot    — FE can read back the stored snapshot
//                                     (useful for debugging; the FE already
//                                     has the live source, so this is mostly
//                                     for inspection / tests).
//   DELETE /v1/pet-vision/snapshot  — clear the stored snapshot. Called when
//                                     the pet goes hidden / behindUi so a
//                                     stale "the pet is at X,Y" reply can't
//                                     leak from the MCP tool.
//   GET  /proxy/pet-vision/snapshot — internal-key gated; the MCP child uses
//                                     this to fetch the snapshot for the
//                                     pet_observe tool.
//
// No SSE — the consumer is the MCP child, polled on-demand by a tool call.
// If we ever want push semantics (e.g. an MCP "subscribe" tool), the same
// in-memory store can grow an EventEmitter without changing this surface.
'use strict';

const {
  setSnapshot,
  clearSnapshot,
  getSnapshot,
  describeSnapshot,
  setCatalog,
  clearCatalog,
  getCatalog,
  describeCatalog,
  listCatalogGroups,
} = require('../lib/vision');
const { BRIDGE_INTERNAL_KEY } = require('../../../core/state');

function isInternalAuthorized(req): boolean {
  const authHeader = String(req.headers['x-api-key'] || req.headers['authorization'] || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  return token === BRIDGE_INTERNAL_KEY;
}

function registerPetVisionRoutes(app): void {
  // ── POST /v1/pet-vision/snapshot ─────────────────────────────────────────
  // Body: { snapshot: PetWorldSnapshot, viewport?: { width, height } }
  // The FE debounces this to fire once per "pet has come to rest" event,
  // so the bridge isn't asked to handle 60 Hz push traffic.
  app.post('/v1/pet-vision/snapshot', (req, res) => {
    try {
      const body = req.body || {};
      const snap = body.snapshot;
      if (!snap || typeof snap !== 'object') {
        return res.status(400).json({ ok: false, error: 'snapshot object required' });
      }
      const viewport =
        body.viewport && typeof body.viewport === 'object'
          && typeof body.viewport.width === 'number'
          && typeof body.viewport.height === 'number'
          ? { width: body.viewport.width, height: body.viewport.height }
          : undefined;
      setSnapshot(snap, viewport);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  // ── GET /v1/pet-vision/snapshot — read for inspection / tests ────────────
  app.get('/v1/pet-vision/snapshot', (_req, res) => {
    const stored = getSnapshot();
    if (!stored) {
      return res.status(404).json({ ok: false, error: 'no snapshot yet' });
    }
    res.json({ ok: true, ...stored });
  });

  // ── DELETE /v1/pet-vision/snapshot — clear (e.g. pet hidden) ─────────────
  app.delete('/v1/pet-vision/snapshot', (_req, res) => {
    clearSnapshot();
    res.json({ ok: true });
  });

  // ── GET /proxy/pet-vision/snapshot — MCP-child read path ─────────────────
  // Returns either the raw stored snapshot or, when ?prose=1 is set, the
  // English description the pet_observe tool surfaces directly. Two shapes
  // keep the MCP tool implementation tiny.
  app.get('/proxy/pet-vision/snapshot', (req, res) => {
    if (!isInternalAuthorized(req)) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    const stored = getSnapshot();
    if (!stored) {
      return res.status(404).json({ ok: false, error: 'no snapshot yet' });
    }
    if (req.query?.prose === '1') {
      return res.json({ ok: true, prose: describeSnapshot(stored), receivedAt: stored.receivedAt });
    }
    res.json({ ok: true, ...stored });
  });

  // ── POST /v1/pet-vision/catalog — FE pushes the appCommands snapshot ─────
  // Body: { commands: CatalogCommand[] }
  // Sent at FE boot and on every register mutation (debounced 200 ms).
  app.post('/v1/pet-vision/catalog', (req, res) => {
    try {
      const body = req.body || {};
      const cmds = body.commands;
      if (!Array.isArray(cmds)) {
        return res.status(400).json({ ok: false, error: 'commands array required' });
      }
      setCatalog(cmds);
      res.json({ ok: true, count: cmds.length });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  });

  // ── GET /v1/pet-vision/catalog — inspect (groups overview by default) ───
  app.get('/v1/pet-vision/catalog', (_req, res) => {
    const stored = getCatalog();
    if (!stored) {
      return res.status(404).json({ ok: false, error: 'no catalog yet' });
    }
    res.json({
      ok: true,
      receivedAt: stored.receivedAt,
      count: stored.commands.length,
      groups: listCatalogGroups(),
    });
  });

  // ── DELETE /v1/pet-vision/catalog — clear (rarely needed) ───────────────
  app.delete('/v1/pet-vision/catalog', (_req, res) => {
    clearCatalog();
    res.json({ ok: true });
  });

  // ── GET /proxy/pet-vision/catalog — MCP-child read path ──────────────────
  // Query params:
  //   ?prose=1                       → return the natural-language summary
  //   ?group=<name>                  → filter by group (works with prose=1)
  //   ?query=<substring>             → fuzzy filter (works with prose=1)
  //   (no params, no prose)          → raw JSON of all commands
  app.get('/proxy/pet-vision/catalog', (req, res) => {
    if (!isInternalAuthorized(req)) {
      return res.status(401).json({ ok: false, error: 'Unauthorized' });
    }
    const stored = getCatalog();
    if (!stored) {
      return res.status(404).json({ ok: false, error: 'no catalog yet' });
    }
    if (req.query?.prose === '1') {
      const group = typeof req.query.group === 'string' ? req.query.group : undefined;
      const query = typeof req.query.query === 'string' ? req.query.query : undefined;
      return res.json({
        ok: true,
        prose: describeCatalog({ group, query }),
        groups: listCatalogGroups(),
        count: stored.commands.length,
        receivedAt: stored.receivedAt,
      });
    }
    res.json({
      ok: true,
      receivedAt: stored.receivedAt,
      commands: stored.commands,
      groups: listCatalogGroups(),
    });
  });
}

module.exports = { registerPetVisionRoutes };
