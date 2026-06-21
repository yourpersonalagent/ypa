// ── Routes for /v1/context-rag/* ──────────────────────────────────────────────
// Surfaces the context-rag module (registry + ingest + retrieve) to the UI:
//
//   GET    /v1/context-rag/dbs                         → list
//   GET    /v1/context-rag/dbs/:id                     → one, with live stats
//   POST   /v1/context-rag/dbs                         → create (probes dim, bootstraps file)
//   PATCH  /v1/context-rag/dbs/:id                     → patch source/sensitivity/displayName
//   DELETE /v1/context-rag/dbs/:id                     → remove (?purge=1 unlinks .db)
//   POST   /v1/context-rag/dbs/:id/refresh             → re-ingest from scratch
//   POST   /v1/context-rag/search                      → query the read path
//   GET    /v1/context-rag/status                      → queue depth + runner state
//
// All endpoints assume the context-generator module is enabled; if it isn't,
// `getModuleApi('context-generator')` returns null and we 503 cleanly. This
// keeps the UI honest: the tab is greyed out when the module is disabled.
'use strict';

const path = require('path');
const fs   = require('fs');

const { getModuleApi } = require('../core/modules');
const { BRIDGE_INTERNAL_KEY } = require('../core/state');

/** Bearer-token check for the /proxy/context-rag/* surface — used by the
 *  stdio MCP server (`bridge/mcp/rag-search-server.js`). authMiddleware
 *  already gates /v1/* on a session cookie; /proxy/* is open from localhost
 *  but the routes themselves still demand the internal key, mirroring the
 *  agent-tools pattern. */
function _isInternalAuthorized(req: any): boolean {
  const h = String(req.headers?.authorization || '');
  const token = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  return !!BRIDGE_INTERNAL_KEY && token === BRIDGE_INTERNAL_KEY;
}

function _rag() {
  const api = getModuleApi('context-generator');
  return api?.contextRag || null;
}

function _vectorStore() {
  // The vector-store layer is internal to the module but the routes need it
  // for live counts + handle close on delete. Require() goes through the
  // module's own require.cache so we don't fork state.
  try {
    return require('../modules/context-generator/context-rag/vector-store/db-instance');
  } catch { return null; }
}

function _registry() {
  try {
    return require('../modules/context-generator/context-rag/registry/store');
  } catch { return null; }
}

function _entitlements() {
  try {
    return require('../modules/context-generator/context-rag/registry/entitlements');
  } catch { return null; }
}

function _probeAdapter() {
  try {
    return require('../modules/context-generator/context-rag/embed/probe-entitlements');
  } catch { return null; }
}

function _embedNvidia() {
  try { return require('../modules/context-generator/context-rag/embed/nvidia'); }
  catch { return null; }
}

function _embedLmStudio() {
  try { return require('../modules/context-generator/context-rag/embed/lmstudio'); }
  catch { return null; }
}

function _invalidateClient(dbId: string): void {
  try {
    const m = require('../modules/context-generator/context-rag/embed/client-for-db');
    m?.invalidateClient?.(dbId);
  } catch (_) {}
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function _bad(res: any, msg: string, code = 400): void {
  res.status(code).json({ success: false, error: msg });
}

function _unavailable(res: any): void {
  res.status(503).json({
    success: false,
    error: 'context-generator module is disabled — enable it in the Modules tab',
  });
}

/** Resolve a provider record using the same preset_id mapping as runtime
 *  ingest. Returns null when no matching record is configured — UI must point
 *  users to the providers tab. */
function _resolveProvider(embedProvider: 'nvidia' | 'lmstudio'): any | null {
  try {
    const m = require('../modules/context-generator/context-rag/embed/client-for-db');
    return m.findProviderForEmbed(embedProvider) || null;
  } catch { return null; }
}

/** Probe the upstream model's embedding dimension. Used at create time to
 *  lock embedDim into the registry entry — this is the write-once field that
 *  makes the embedModel lock physically enforceable on every reopen. */
async function _probeDim(
  embedProvider: 'nvidia' | 'lmstudio',
  providerRecord: any,
  model: string,
): Promise<number> {
  if (embedProvider === 'nvidia') {
    const mod = _embedNvidia();
    if (!mod?.probeEmbedDim) throw new Error('nvidia adapter unavailable');
    const { dim } = await mod.probeEmbedDim(providerRecord, model);
    return dim;
  }
  if (embedProvider === 'lmstudio') {
    const mod = _embedLmStudio();
    if (!mod?.probeEmbedDim) throw new Error('lmstudio adapter unavailable');
    const { dim } = await mod.probeEmbedDim(providerRecord, model);
    return dim;
  }
  throw new Error(`unsupported embedProvider: ${embedProvider}`);
}

/** Augment a registry record with live counts from the open DB. The registry
 *  itself only stores `stats` as last-known; the route gives the UI fresh
 *  numbers without forcing a write back to disk on every read.
 *
 *  Also attaches `embedModelStatus`: a derived flag from the entitlement
 *  cache that the HubRagTab uses to render the migration nudge. `unknown`
 *  is the default — only `unavailable` should trigger UI alarm. */
function _withLiveStats(db: any): any {
  const vs   = _vectorStore();
  const ent  = _entitlements();
  let liveBlock: any;
  if (!vs) {
    liveBlock = db.live;
  } else {
    try {
      liveBlock = { chunkCount: vs.countChunks(db.id) };
    } catch (e: any) {
      liveBlock = { error: String(e?.message || e) };
    }
  }
  let embedModelStatus: 'available' | 'unavailable' | 'unknown' = 'unknown';
  try {
    if (ent?.statusFor) embedModelStatus = ent.statusFor(db.embedProvider, db.embedModel);
  } catch (_) { /* cache load failed — treat as unknown */ }
  return {
    ...db,
    ...(liveBlock ? { live: liveBlock } : {}),
    embedModelStatus,
  };
}

// ── Shared search handler (used by /v1 + /proxy variants) ────────────────────

async function _handleSearch(req: any, res: any): Promise<void> {
  const rag = _rag();
  if (!rag?.searchRag) return _unavailable(res);
  const body = req.body || {};
  if (typeof body.query !== 'string' || !body.query.trim()) return _bad(res, 'query required');
  try {
    const result = await rag.searchRag({
      query:       body.query,
      dbIds:       Array.isArray(body.dbIds) ? body.dbIds : undefined,
      cwd:         typeof body.cwd === 'string' ? body.cwd : undefined,
      all:         body.all === true,
      k:           Number.isInteger(body.k) ? body.k : 8,
      overFetch:   Number.isInteger(body.overFetch) ? body.overFetch : undefined,
      rerank:      body.rerank !== false,
      sourceKind:  body.sourceKind,
      allowTiers:  Array.isArray(body.allowTiers) ? body.allowTiers : undefined,
    });
    res.json({ success: true, ...result });
  } catch (e: any) {
    _bad(res, e?.message || String(e), 500);
  }
}

// ── Embed-provider enumeration (for the ⚡ setup form) ───────────────────────
//
// The setup-cwd form needs to know: (a) which of the two adapters has an
// actual provider record in `state.config.providers[]`, and (b) which model
// ids each one currently advertises. We could read the bridge-wide
// `modelCaches`, but local providers (LM Studio) aren't always covered by the
// background refresh, so we live-probe the provider's `/v1/models` endpoint
// with a tiny in-process cache (30 s) to keep the form responsive without
// pinging the user's local box on every keystroke.
//
// `looksLikeCodeEmbed` is a heuristic: names containing `code` (e.g.
// `nomic-embed-code`) get tagged so the form can pre-select them for the
// code-side DB. Names containing `embed` get included in the list at all.

interface EmbedModelInfo {
  id: string;
  looksLikeCodeEmbed: boolean;
  /** When true, the model is on the adapter's curated short-list — i.e.
   *  it's been verified to actually work on a typical account (so we won't
   *  hand the user a 404 at probe time). The setup form filters its model
   *  dropdown to `curated:true` by default with an "Advanced" toggle to
   *  reveal the rest of the catalogue. */
  curated: boolean;
}
interface EmbedProviderInfo {
  embedProvider: 'nvidia' | 'lmstudio';
  configured:    boolean;
  displayName:   string;
  endpoint?:     string;
  embedModels:   EmbedModelInfo[];
  error?:        string;
}

const _embedModelsCache = new Map<string, { at: number; models: EmbedModelInfo[] }>();
const EMBED_MODELS_TTL_MS = 30_000;

// Curated NVIDIA NIM embedding models — verified to be enabled on the free
// tier and produce sensible retrieval quality. NIM's /v1/models catalogue
// lists every embedder NVIDIA offers regardless of account entitlement, so
// surfacing the full list to the operator means most picks 404 at probe time.
// This short-list keeps the form honest by default; the "Advanced" toggle
// in the FE re-reveals everything for users whose accounts have more enabled.
const NVIDIA_CURATED_EMBED_MODELS = new Set<string>([
  'nvidia/nv-embedqa-e5-v5',
  'nvidia/llama-3.2-nv-embedqa-1b-v2',
  'nvidia/llama-3.2-nemoretriever-300m-embed-v1',
  'nvidia/llama-nemotron-embed-1b-v2',
  'nvidia/llama-nemotron-embed-vl-1b-v2',
  'nvidia/nv-embed-v1',
  'nvidia/nv-embedcode-7b-v1',
]);

function _normalizeModelEntries(json: any): string[] {
  if (Array.isArray(json?.data)) return json.data.map((m: any) => String(m?.id || '')).filter(Boolean);
  if (Array.isArray(json?.models)) return json.models.map((m: any) => String(m?.id || m?.name || '')).filter(Boolean);
  if (Array.isArray(json)) return json.map((m: any) => String(m?.id || m?.name || '')).filter(Boolean);
  return [];
}

function _scoreModel(id: string, kind: 'nvidia' | 'lmstudio'): EmbedModelInfo | null {
  const lower = id.toLowerCase();
  // Skip obvious LLMs / images / rerankers — the user wants embedders only.
  if (/(rerank|llama-?\d|qwen|mistral|gemma|deepseek|claude|gpt-|dall-?e|imagen|whisper|sora|veo)/i.test(id)
      && !lower.includes('embed')) return null;
  if (!lower.includes('embed')) return null;
  // LM Studio models are user-loaded locally — anything advertised by the
  // server is by definition installed and runnable, so the curated flag is
  // always true. For NVIDIA we hard-code the entitled subset.
  const curated = kind === 'lmstudio' ? true : NVIDIA_CURATED_EMBED_MODELS.has(id);
  return { id, looksLikeCodeEmbed: /code/.test(lower), curated };
}

async function _fetchEmbedModels(
  endpoint: string,
  apiKey:   string | undefined,
  kind:     'nvidia' | 'lmstudio',
): Promise<EmbedModelInfo[]> {
  const cacheKey = `${kind}|${endpoint}|${apiKey ? 'k' : '-'}`;
  const now      = Date.now();
  const cached   = _embedModelsCache.get(cacheKey);
  if (cached && now - cached.at < EMBED_MODELS_TTL_MS) return cached.models;
  const url = endpoint.replace(/\/$/, '') + '/models';
  const ac  = new AbortController();
  const t   = setTimeout(() => ac.abort(new Error('models probe timeout')), 8_000);
  try {
    const resp = await fetch(url, {
      method:  'GET',
      headers: { ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
      signal:  ac.signal,
    });
    if (!resp.ok) throw new Error(`http ${resp.status}`);
    const json   = await resp.json();
    const ids    = _normalizeModelEntries(json);
    const models = ids.map((id) => _scoreModel(id, kind)).filter((m): m is EmbedModelInfo => m !== null);
    // Belt-and-braces: if the live catalogue is missing any curated id
    // (NIM has rotated entries before), synthesise them so the form never
    // falls back to "no embed models advertised" with a known-good
    // entitlement still on offer.
    if (kind === 'nvidia') {
      const seen = new Set(models.map((m) => m.id));
      for (const id of NVIDIA_CURATED_EMBED_MODELS) {
        if (!seen.has(id)) {
          models.unshift({
            id,
            looksLikeCodeEmbed: /code/.test(id.toLowerCase()),
            curated: true,
          });
        }
      }
    }
    _embedModelsCache.set(cacheKey, { at: now, models });
    return models;
  } finally {
    clearTimeout(t);
  }
}

async function _enumerateEmbedProviders(): Promise<EmbedProviderInfo[]> {
  const adapters: Array<{ kind: 'nvidia' | 'lmstudio'; displayName: string }> = [
    { kind: 'nvidia',   displayName: 'NVIDIA NIM (cloud)' },
    { kind: 'lmstudio', displayName: 'LM Studio (local)'  },
  ];
  const out: EmbedProviderInfo[] = [];
  for (const a of adapters) {
    const rec = _resolveProvider(a.kind);
    if (!rec) {
      out.push({ embedProvider: a.kind, configured: false, displayName: a.displayName, embedModels: [] });
      continue;
    }
    try {
      const models = await _fetchEmbedModels(rec.endpoint, rec.api_key, a.kind);
      out.push({
        embedProvider: a.kind,
        configured:    true,
        displayName:   rec.name || a.displayName,
        endpoint:      rec.endpoint,
        embedModels:   models,
      });
    } catch (e: any) {
      out.push({
        embedProvider: a.kind,
        configured:    true,
        displayName:   rec.name || a.displayName,
        endpoint:      rec.endpoint,
        embedModels:   [],
        error:         e?.message || String(e),
      });
    }
  }
  return out;
}

// ── setup-cwd: transactional two-DB create for the active working directory ──
//
// Body shape (both sides optional — operator can skip either):
//   { cwd, basename, chats?: { id, displayName, embedProvider, embedModel },
//                    code?:  { id, displayName, embedProvider, embedModel } }
// Both ids are validated by the registry; on probe-or-bootstrap failure the
// route rolls back any DBs it already created so we never leave a half-built
// pair behind.

interface SetupSidePayload {
  id:            string;
  displayName:   string;
  embedProvider: 'nvidia' | 'lmstudio';
  embedModel:    string;
}

function _validateSide(side: SetupSidePayload | undefined, label: string): string | null {
  if (!side) return null;
  if (typeof side.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(side.id)) {
    return `${label}.id: must be kebab-case, ≤63 chars, starting with [a-z0-9]`;
  }
  if (typeof side.displayName !== 'string' || !side.displayName.trim()) return `${label}.displayName required`;
  if (!['nvidia', 'lmstudio'].includes(side.embedProvider)) return `${label}.embedProvider must be nvidia|lmstudio`;
  if (typeof side.embedModel !== 'string' || !side.embedModel.trim()) return `${label}.embedModel required`;
  return null;
}

// ── Registration ─────────────────────────────────────────────────────────────

function registerContextRagRoutes(app: any): void {
  // List
  app.get('/v1/context-rag/dbs', (_req: any, res: any) => {
    const reg = _registry();
    if (!reg) return _unavailable(res);
    try {
      const dbs = reg.listDbs().map((d: any) => _withLiveStats(d));
      res.json({ success: true, dbs });
    } catch (e: any) {
      _bad(res, e?.message || String(e), 500);
    }
  });

  // Get one
  app.get('/v1/context-rag/dbs/:id', (req: any, res: any) => {
    const reg = _registry();
    if (!reg) return _unavailable(res);
    const db = reg.getDb(req.params.id);
    if (!db) return _bad(res, `db "${req.params.id}" not found`, 404);
    res.json({ success: true, db: _withLiveStats(db) });
  });

  // Create. Body shape:
  // {
  //   id, displayName,
  //   embedProvider: 'nvidia'|'lmstudio',
  //   embedModel: <model id>,
  //   source:    <SourceFilter>,
  //   sensitivity?: { include: [], exclude: [] },
  // }
  // Probes the upstream model for embedDim, then writes to disk and opens
  // the .db file so `rag_meta` is stamped immediately. The provider record
  // is looked up by preset_id at create AND at runtime — there's exactly
  // one NVIDIA and one LM Studio entry in `config.providers[]`.
  app.post('/v1/context-rag/dbs', async (req: any, res: any) => {
    const reg = _registry();
    const vs  = _vectorStore();
    if (!reg || !vs) return _unavailable(res);

    const body = req.body || {};
    if (typeof body.id !== 'string' || !body.id) return _bad(res, 'id required');
    if (typeof body.displayName !== 'string' || !body.displayName) return _bad(res, 'displayName required');
    if (!['nvidia', 'lmstudio'].includes(body.embedProvider)) return _bad(res, 'embedProvider must be nvidia|lmstudio');
    if (typeof body.embedModel !== 'string' || !body.embedModel) return _bad(res, 'embedModel required');
    if (!body.source) return _bad(res, 'source required');

    const providerRecord = _resolveProvider(body.embedProvider);
    if (!providerRecord) {
      return _bad(res,
        `no ${body.embedProvider} provider configured. Add one in the Providers tab first.`);
    }

    let embedDim: number;
    try {
      embedDim = await _probeDim(body.embedProvider, providerRecord, body.embedModel);
    } catch (e: any) {
      return _bad(res, `embed dimension probe failed: ${e?.message || e}`, 502);
    }

    let saved: any;
    try {
      saved = reg.addDb({
        id: body.id,
        displayName: body.displayName,
        embedProvider: body.embedProvider,
        embedModel: body.embedModel,
        embedDim,
        source: body.source,
        sensitivity: body.sensitivity,
      });
    } catch (e: any) {
      return _bad(res, e?.message || String(e));
    }

    // Bootstrap the .db file — getHandle() runs schema + stamps rag_meta.
    try {
      vs.getHandle(saved.id);
    } catch (e: any) {
      // Roll back the registry entry so we don't leave a half-built record.
      try { reg.removeDb(saved.id); } catch (_) {}
      return _bad(res, `db bootstrap failed: ${e?.message || e}`, 500);
    }

    // Trigger an initial scan so the new DB starts populating immediately.
    const rag = _rag();
    try { rag?.scanAndEnqueueOnStartup?.(); } catch (_) {}
    try { rag?.reconcileWatchers?.(); } catch (_) {}
    try { rag?.reconcileKnowledgeWatcher?.(); } catch (_) {}
    try { rag?.kickContextRag?.('db-created'); } catch (_) {}

    res.json({ success: true, db: _withLiveStats(saved) });
  });

  // Patch — rename, change source/sensitivity. embedProvider/embedModel/
  // embedDim are write-once at the registry layer and silently dropped.
  app.patch('/v1/context-rag/dbs/:id', (req: any, res: any) => {
    const reg = _registry();
    if (!reg) return _unavailable(res);
    const body = req.body || {};
    try {
      const next = reg.updateDb(req.params.id, {
        ...(typeof body.displayName === 'string' ? { displayName: body.displayName } : {}),
        ...(body.source       ? { source:       body.source       } : {}),
        ...(body.sensitivity  ? { sensitivity:  body.sensitivity  } : {}),
      });
      _invalidateClient(req.params.id);
      try { _rag()?.reconcileWatchers?.(); } catch (_) {}
    try { _rag()?.reconcileKnowledgeWatcher?.(); } catch (_) {}
      res.json({ success: true, db: _withLiveStats(next) });
    } catch (e: any) {
      _bad(res, e?.message || String(e), e?.message?.includes('not found') ? 404 : 400);
    }
  });

  // Delete. `?purge=1` also unlinks the on-disk `.db` file.
  app.delete('/v1/context-rag/dbs/:id', (req: any, res: any) => {
    const reg = _registry();
    const vs  = _vectorStore();
    if (!reg || !vs) return _unavailable(res);
    const id = req.params.id;
    const db = reg.getDb(id);
    if (!db) return _bad(res, `db "${id}" not found`, 404);

    // Close any open handle first; the file lock won't release otherwise.
    try { vs.close(id); } catch (_) {}
    _invalidateClient(id);

    if (String(req.query?.purge || '') === '1') {
      try {
        const p = reg.getDbFilePath(id);
        if (fs.existsSync(p)) fs.unlinkSync(p);
        // Best-effort -wal / -shm cleanup; WAL mode leaves siblings.
        for (const ext of ['-wal', '-shm']) {
          try { fs.unlinkSync(p + ext); } catch (_) {}
        }
      } catch (e: any) {
        return _bad(res, `purge failed: ${e?.message || e}`, 500);
      }
    }

    const removed = reg.removeDb(id);
    try { _rag()?.reconcileWatchers?.(); } catch (_) {}
    try { _rag()?.reconcileKnowledgeWatcher?.(); } catch (_) {}
    res.json({ success: true, removed, purged: String(req.query?.purge || '') === '1' });
  });

  // Force re-ingest: clearAll() on the DB, then kick the runner. The runner
  // sees an empty DB and re-enqueues every matching source.
  app.post('/v1/context-rag/dbs/:id/refresh', (req: any, res: any) => {
    const reg = _registry();
    const vs  = _vectorStore();
    const rag = _rag();
    if (!reg || !vs || !rag) return _unavailable(res);
    const db = reg.getDb(req.params.id);
    if (!db) return _bad(res, `db "${req.params.id}" not found`, 404);
    try {
      vs.clearAll(db.id);
    } catch (e: any) {
      return _bad(res, `clear failed: ${e?.message || e}`, 500);
    }
    // Sessions: scan only sessions (the all-DBs walk would re-enqueue file
    // trees for unrelated DBs too — wasteful when only one DB was cleared).
    try { rag.scanAndEnqueueOnStartup?.(); } catch (_) {}
    // Files: scan only THIS DB's roots, so a cwd-mode DB refresh doesn't
    // drag every other DB's tree through the walker.
    try {
      if (db.source?.files?.mode && db.source.files.mode !== 'off') {
        rag.scanAndEnqueueForDb?.(db.id);
      }
    } catch (_) {}
    // Synthesis: cheap walk of the (small) bucket dirs; scanAllSynthesisDbs
    // already short-circuits when no DB wants synthesis.
    try { rag.scanAndEnqueueAllSynthesisDbs?.(); } catch (_) {}
    try { rag.kickContextRag?.('manual-refresh'); } catch (_) {}
    res.json({ success: true });
  });

  // Search — the read path used by the ⚡ picker and (step 8) the MCP tool.
  // Body: { query, dbIds?, cwd?, all?, k?, rerank?, sourceKind?, allowTiers? }
  app.post('/v1/context-rag/search', async (req: any, res: any) => {
    return _handleSearch(req, res);
  });

  // Verify integrity — counts orphan rows, missing fs sources, and meta-mismatch
  // per DB. Read-only; used by the Hub RAG tab's "verify integrity" button.
  app.get('/v1/context-rag/dbs/:id/verify-integrity', (req: any, res: any) => {
    const rag = _rag();
    if (!rag?.verifyIntegrity) return _unavailable(res);
    const id = String(req.params.id || '').trim();
    if (!id) return _bad(res, 'db id required');
    try {
      const report = rag.verifyIntegrity(id);
      res.json({ success: true, report });
    } catch (e: any) {
      _bad(res, e?.message || String(e), 500);
    }
  });

  // ── Entitlements (which embedding models work on this account) ───────
  //
  // GET returns the cache snapshot (or empty providers map if never probed).
  // POST runs the probe: NVIDIA gets the curated short-list + any model
  // currently in use by a registry DB (so a DB stuck on a non-curated id
  // still gets a real status). LM Studio gets every embedder its /v1/models
  // catalogue advertises — locally installed, so probes are free.
  app.get('/v1/context-rag/entitlements', (_req: any, res: any) => {
    const ent = _entitlements();
    if (!ent?.readCache) return _unavailable(res);
    try {
      const snapshot = ent.readCache();
      res.json({
        success: true,
        providers: snapshot.providers || {},
        stale: {
          nvidia:   ent.isStale('nvidia'),
          lmstudio: ent.isStale('lmstudio'),
        },
      });
    } catch (e: any) {
      _bad(res, e?.message || String(e), 500);
    }
  });

  app.post('/v1/context-rag/probe-entitlements', async (req: any, res: any) => {
    const ent     = _entitlements();
    const probe   = _probeAdapter();
    const reg     = _registry();
    if (!ent || !probe || !reg) return _unavailable(res);
    const body          = req.body || {};
    const onlyProvider  = body.provider === 'nvidia' || body.provider === 'lmstudio'
      ? body.provider as 'nvidia' | 'lmstudio'
      : null;

    // Build the model list to probe per provider: curated short-list
    // (NVIDIA only) + every model currently in use by a registered DB
    // (both providers). De-duped inside probeEntitlements.
    const inUseByProvider: Record<'nvidia' | 'lmstudio', Set<string>> = {
      nvidia: new Set(), lmstudio: new Set(),
    };
    try {
      for (const db of reg.listDbs()) {
        const p = db.embedProvider as 'nvidia' | 'lmstudio';
        if (inUseByProvider[p]) inUseByProvider[p].add(db.embedModel);
      }
    } catch (_) { /* registry walk failure — proceed with curated-only */ }

    const results: Partial<Record<'nvidia' | 'lmstudio', any>> = {};
    for (const provider of ['nvidia', 'lmstudio'] as const) {
      if (onlyProvider && provider !== onlyProvider) continue;
      const record = _resolveProvider(provider);
      if (!record) {
        results[provider] = { error: `no ${provider} provider configured` };
        continue;
      }
      let models: string[];
      if (provider === 'nvidia') {
        models = [...NVIDIA_CURATED_EMBED_MODELS, ...inUseByProvider.nvidia];
      } else {
        // LM Studio: probe every advertised embedder, plus in-use ids
        // (so an installed-then-uninstalled-then-re-referenced model is
        // still surfaced honestly as unavailable).
        try {
          const adv = await _fetchEmbedModels(record.endpoint, record.api_key, 'lmstudio');
          models = [...adv.map((m: any) => m.id), ...inUseByProvider.lmstudio];
        } catch (e: any) {
          results[provider] = { error: `lmstudio models probe failed: ${e?.message || e}` };
          continue;
        }
      }
      try {
        const entry = await probe.probeEntitlements(provider, record, models);
        ent.setProviderEntitlement(provider, entry);
        results[provider] = entry;
      } catch (e: any) {
        results[provider] = { error: e?.message || String(e) };
      }
    }
    res.json({ success: true, results });
  });

  // ── Migrate: clone DB with a new embed model, keep the old one live ──
  //
  // Body: { newId, targetModel, displayName? }
  // - newId must be available (registry uniqueness)
  // - source DB stays untouched until the operator chooses to archive it,
  //   so retrieval keeps working through the reindex window
  // - registry links the pair via migratedFrom/migratedTo so the UI can
  //   show "→ new-db (chunk 1247 / 2103 indexed)" on the source row
  // - the new DB inherits source filters + sensitivity verbatim
  app.post('/v1/context-rag/dbs/:id/migrate', async (req: any, res: any) => {
    const reg = _registry();
    const vs  = _vectorStore();
    const rag = _rag();
    if (!reg || !vs) return _unavailable(res);

    const sourceId = String(req.params.id || '').trim();
    const source   = reg.getDb(sourceId);
    if (!source) return _bad(res, `db "${sourceId}" not found`, 404);

    const body         = req.body || {};
    const newId        = typeof body.newId === 'string' ? body.newId.trim() : '';
    const targetModel  = typeof body.targetModel === 'string' ? body.targetModel.trim() : '';
    const displayName  = typeof body.displayName === 'string' && body.displayName.trim()
      ? body.displayName.trim()
      : `${source.displayName} (${targetModel.split('/').pop() || 'migrated'})`;
    if (!newId)       return _bad(res, 'newId required');
    if (!targetModel) return _bad(res, 'targetModel required');
    if (newId === sourceId) return _bad(res, 'newId must differ from source id');
    if (reg.getDb(newId)) return _bad(res, `db id "${newId}" already exists`);

    // Re-use the source's provider; the migration story is about swapping
    // models, not jumping vendors. (Cross-vendor migrations are a separate
    // flow because the source filter mode for sessions/files would need
    // operator confirmation.)
    const providerRecord = _resolveProvider(source.embedProvider);
    if (!providerRecord) {
      return _bad(res,
        `no ${source.embedProvider} provider configured. Add one in the Providers tab first.`);
    }

    let embedDim: number;
    try {
      embedDim = await _probeDim(source.embedProvider, providerRecord, targetModel);
    } catch (e: any) {
      return _bad(res, `embed dimension probe failed: ${e?.message || e}`, 502);
    }

    // Clone source/sensitivity by deep-copying — JSON round-trip is enough
    // here because both shapes are JSON-serialisable.
    const sourceClone      = JSON.parse(JSON.stringify(source.source));
    const sensitivityClone = JSON.parse(JSON.stringify(source.sensitivity));

    let saved: any;
    try {
      saved = reg.addDb({
        id:            newId,
        displayName,
        embedProvider: source.embedProvider,
        embedModel:    targetModel,
        embedDim,
        source:        sourceClone,
        sensitivity:   sensitivityClone,
        migratedFrom:  sourceId,
      });
    } catch (e: any) {
      return _bad(res, e?.message || String(e));
    }

    try {
      vs.getHandle(saved.id);
    } catch (e: any) {
      try { reg.removeDb(saved.id); } catch (_) {}
      return _bad(res, `db bootstrap failed: ${e?.message || e}`, 500);
    }

    // Stamp the back-pointer on the source. If this fails we still leave
    // the new DB in place — the operator can re-establish the link via
    // PATCH or just live without it; the new DB is fully functional.
    try {
      reg.updateDb(sourceId, { migratedTo: saved.id });
    } catch (_) { /* non-fatal */ }

    // Kick the runner to start populating the new DB. Source DB stays live.
    try { rag?.scanAndEnqueueOnStartup?.(); } catch (_) {}
    try { rag?.reconcileWatchers?.(); } catch (_) {}
    try { rag?.reconcileKnowledgeWatcher?.(); } catch (_) {}
    if (saved.source?.files?.mode && saved.source.files.mode !== 'off') {
      try { rag?.scanAndEnqueueForDb?.(saved.id); } catch (_) {}
    }
    try { rag?.kickContextRag?.('db-migrated'); } catch (_) {}

    res.json({
      success: true,
      source:  _withLiveStats(reg.getDb(sourceId)),
      target:  _withLiveStats(saved),
    });
  });

  // ── /proxy/context-rag/* — internal-key surface for the stdio MCP server.
  //    Mirrors agent-tools.ts: localhost-only via authMiddleware, then the
  //    routes themselves still check the bearer token explicitly so a
  //    misconfigured front-proxy can't accidentally tunnel external calls.
  app.get('/proxy/context-rag/dbs', (req: any, res: any) => {
    if (!_isInternalAuthorized(req)) return res.status(401).json({ success: false, error: 'Unauthorized' });
    const reg = _registry();
    if (!reg) return _unavailable(res);
    try {
      const dbs = reg.listDbs().map((d: any) => ({
        id: d.id,
        displayName: d.displayName,
        embedProvider: d.embedProvider,
        embedModel: d.embedModel,
        source: d.source,
        sensitivity: d.sensitivity,
      }));
      res.json({ success: true, dbs });
    } catch (e: any) {
      _bad(res, e?.message || String(e), 500);
    }
  });

  app.post('/proxy/context-rag/search', async (req: any, res: any) => {
    if (!_isInternalAuthorized(req)) return res.status(401).json({ success: false, error: 'Unauthorized' });
    return _handleSearch(req, res);
  });

  // Embed-provider enumeration for the ⚡ setup form. Returns one row per
  // adapter (nvidia, lmstudio) with `configured` reflecting whether a
  // matching provider record exists, plus a filtered model list.
  app.get('/v1/context-rag/embed-providers', async (_req: any, res: any) => {
    try {
      const providers = await _enumerateEmbedProviders();
      res.json({ success: true, providers });
    } catch (e: any) {
      _bad(res, e?.message || String(e), 500);
    }
  });

  // Two-DB transactional setup keyed off the current working directory.
  // Body: { cwd, basename, chats?: SetupSidePayload, code?: SetupSidePayload,
  //         sessionsMode?: 'cwd'|'all'  // defaults to 'cwd' }
  app.post('/v1/context-rag/setup-cwd', async (req: any, res: any) => {
    const reg = _registry();
    const vs  = _vectorStore();
    const rag = _rag();
    if (!reg || !vs) return _unavailable(res);

    const body = req.body || {};
    const cwd  = typeof body.cwd === 'string' ? body.cwd.trim() : '';
    if (!cwd || !cwd.startsWith('/')) return _bad(res, 'cwd: absolute path required');
    const chats = body.chats ? (body.chats as SetupSidePayload) : undefined;
    const code  = body.code  ? (body.code  as SetupSidePayload) : undefined;
    if (!chats && !code) return _bad(res, 'specify chats and/or code — at least one DB must be requested');
    const chatsErr = _validateSide(chats, 'chats');
    if (chatsErr) return _bad(res, chatsErr);
    const codeErr  = _validateSide(code, 'code');
    if (codeErr)  return _bad(res, codeErr);
    const sessionsMode: 'cwd' | 'all' =
      body.sessionsMode === 'all' ? 'all' : 'cwd';

    // Detect duplicate ids before doing any provider work.
    if (chats && code && chats.id === code.id) {
      return _bad(res, 'chats.id and code.id must differ');
    }
    const existing = new Set(reg.listDbs().map((d: any) => d.id));
    if (chats && existing.has(chats.id)) return _bad(res, `db id "${chats.id}" already exists`);
    if (code  && existing.has(code.id))  return _bad(res, `db id "${code.id}" already exists`);

    const created: string[] = [];
    async function _createOne(
      side: SetupSidePayload,
      source: any,
    ): Promise<any> {
      const provider = _resolveProvider(side.embedProvider);
      if (!provider) {
        throw new Error(`no ${side.embedProvider} provider configured. Add one in the Providers tab first.`);
      }
      const dim = await _probeDim(side.embedProvider, provider, side.embedModel);
      const saved = reg.addDb({
        id:            side.id,
        displayName:   side.displayName,
        embedProvider: side.embedProvider,
        embedModel:    side.embedModel,
        embedDim:      dim,
        source,
      });
      try {
        vs.getHandle(saved.id);
      } catch (e: any) {
        try { reg.removeDb(saved.id); } catch (_) {}
        throw new Error(`db bootstrap failed: ${e?.message || e}`);
      }
      created.push(saved.id);
      return saved;
    }

    const result: { chats?: any; code?: any } = {};
    try {
      if (chats) {
        const source = {
          sessions:  { mode: sessionsMode, ...(sessionsMode === 'cwd' ? { cwd } : {}) },
          files:     { mode: 'off' },
          knowledge: { mode: 'off' },
        };
        result.chats = await _createOne(chats, source);
      }
      if (code) {
        const source = {
          sessions:  { mode: 'off' },
          files:     { mode: 'cwd', cwd, watch: true },
          knowledge: { mode: 'off' },
        };
        result.code = await _createOne(code, source);
      }
    } catch (e: any) {
      // Roll back anything we already created so the operator can retry cleanly.
      for (const id of created) {
        try { vs.close(id); } catch (_) {}
        try { reg.removeDb(id); } catch (_) {}
        _invalidateClient(id);
      }
      return _bad(res, e?.message || String(e), 500);
    }

    try { rag?.scanAndEnqueueOnStartup?.(); } catch (_) {}
    try { rag?.reconcileWatchers?.(); } catch (_) {}
    try { rag?.reconcileKnowledgeWatcher?.(); } catch (_) {}
    try { rag?.kickContextRag?.('setup-cwd'); } catch (_) {}

    res.json({
      success: true,
      ...(result.chats ? { chats: _withLiveStats(result.chats) } : {}),
      ...(result.code  ? { code:  _withLiveStats(result.code)  } : {}),
    });
  });

  // Status — queue depth and runner state for the UI's status strip.
  app.get('/v1/context-rag/status', (_req: any, res: any) => {
    const rag = _rag();
    if (!rag?.getStatus) return _unavailable(res);
    try {
      res.json({ success: true, ...rag.getStatus() });
    } catch (e: any) {
      _bad(res, e?.message || String(e), 500);
    }
  });

  // Run-now — kicks the ingest worker outside the watchdog cadence. Surfaced
  // on the Generator-tab RAG StageCard's "Run now" button. Returns the same
  // `{ kicked, reason? }` shape the title/categorizer/sorter run-now endpoints
  // use so HubGeneratorTab's _formatActionResult helper handles it uniformly.
  app.post('/v1/context-rag/run-now', (_req: any, res: any) => {
    const rag = _rag();
    if (!rag?.runNow) return _unavailable(res);
    try {
      res.json({ success: true, ...rag.runNow() });
    } catch (e: any) {
      _bad(res, e?.message || String(e), 500);
    }
  });
}

module.exports = { registerContextRagRoutes };
