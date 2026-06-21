// HubRagTab — Context-RAG vector-DB administration panel.
// Pairs with the bridge routes registered in bridge/routes/context-rag.ts:
//   • lists DBs (poll every 5 s)
//   • create form: id, displayName, provider, model, source filters
//   • per-row: force refresh, delete (with optional purge)
//   • search test: query + db selection + rerank toggle
//
// The model picker uses the existing /v1/models/ list, filtered client-side
// by provider and by an embedding-name regex (show-all checkbox bypasses it).

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import chatUI from '../chat/chat-ui.js';

interface VectorDB {
  id: string;
  displayName: string;
  embedProvider: 'nvidia' | 'lmstudio';
  embedModel: string;
  embedDim: number;
  source: {
    sessions: { mode: 'all' | 'cwd' | 'off'; cwd?: string };
    files:    { mode: 'cwd' | 'roots' | 'off'; cwd?: string; roots?: string[]; ignore?: string[] };
    knowledge:{ mode: 'all' | 'off' };
  };
  sensitivity: { include: string[]; exclude: string[] };
  createdAt: number;
  stats: { chunks: number; lastIngestAt: number | null; lastError: string | null };
  live?: { chunkCount?: number; error?: string };
  embedModelStatus?: 'available' | 'unavailable' | 'unknown';
  migratedFrom?: string;
  migratedTo?: string;
}

interface ProviderEntitlement {
  probedAt: number;
  available: string[];
  unavailable: string[];
  errors: Record<string, string>;
}
interface EntitlementsSnapshot {
  providers: Partial<Record<'nvidia' | 'lmstudio', ProviderEntitlement | { error: string }>>;
  stale: { nvidia: boolean; lmstudio: boolean };
}

interface Status {
  enabled: boolean;
  isRunning: boolean;
  watchdogActive: boolean;
  queue: { total: number; byKind: Record<string, number> };
}

interface ModelRow { id: string; name?: string; provider?: string }

interface SearchHit {
  dbId: string;
  dbDisplayName?: string;
  sourceKind: string;
  sourceId: string;
  sourcePath: string | null;
  text: string;
  distance: number;
  rerankScore?: number;
}

function _baseUrl(): string {
  return (api.config as { baseUrl?: string })?.baseUrl || '';
}

// Last-search cache for the Search-test card. Module-scope so it survives the
// ContextHub modal unmount when the user clicks elsewhere; expires 2 min after
// the last interaction so a stale result never sticks around forever.
const _SEARCH_CACHE_TTL_MS = 2 * 60_000;
let _lastSearch: {
  query:          string;
  rerank:         boolean;
  selectedDbIds:  Set<string>;
  result:         { hits: SearchHit[]; ms?: number };
  pickedHits:     Set<number>;
  touchedAt:      number;
} | null = null;

function _readSearchCache(): typeof _lastSearch {
  if (!_lastSearch) return null;
  if (Date.now() - _lastSearch.touchedAt > _SEARCH_CACHE_TTL_MS) {
    _lastSearch = null;
    return null;
  }
  return _lastSearch;
}

const EMBED_NAME_RE = /embed|bge|e5|nomic|arctic|gte/i;

function _formatWhen(ts: number | null | undefined): string {
  if (!ts) return 'never';
  const diff = Date.now() - ts;
  if (diff < 60_000)        return `${Math.round(diff / 1_000)} s ago`;
  if (diff < 60 * 60_000)   return `${Math.round(diff / 60_000)} min ago`;
  if (diff < 24 * 60 * 60_000) return `${Math.round(diff / (60 * 60_000))} h ago`;
  return new Date(ts).toLocaleString();
}

function _bridgeKey(p?: string): 'nvidia' | 'lmstudio' | null {
  if (!p) return null;
  const s = p.toLowerCase();
  if (s.includes('nvidia') || s.includes('nim')) return 'nvidia';
  if (s.includes('lm studio') || s.includes('lmstudio')) return 'lmstudio';
  return null;
}

export function HubRagTab() {
  const [dbs, setDbs] = useState<VectorDB[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [models, setModels] = useState<ModelRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Create form
  const [form, setForm] = useState({
    id:            '',
    displayName:   '',
    embedProvider: 'lmstudio' as 'nvidia' | 'lmstudio',
    embedModel:    '',
    showAllModels: false,
    sessionsMode:  'all' as 'all' | 'cwd' | 'off',
    sessionsCwd:   '',
    filesMode:     'off' as 'cwd' | 'roots' | 'off',
    knowledgeMode: 'off' as 'all' | 'off',
  });

  // Search test — hydrate from the 2-min cache so the last query + hits +
  // selection survive a ContextHub modal close/reopen. `useMemo` runs the cache
  // read exactly once on mount (lookup is side-effect-free aside from TTL
  // bookkeeping inside _readSearchCache).
  const _cachedSearch = useMemo(_readSearchCache, []);
  const [search, setSearch] = useState({
    query:         _cachedSearch?.query  ?? '',
    rerank:        _cachedSearch?.rerank ?? true,
    selectedDbIds: _cachedSearch ? new Set(_cachedSearch.selectedDbIds) : new Set<string>(),
  });
  const [searchResult, setSearchResult] = useState<{ hits: SearchHit[]; ms?: number } | null>(
    _cachedSearch?.result ?? null,
  );
  const [searchBusy, setSearchBusy] = useState(false);
  // Selection of hits to attach to the chat input. Reset each time a new
  // search runs so stale checkmarks don't carry over to fresh hits.
  const [pickedHits, setPickedHits] = useState<Set<number>>(
    () => _cachedSearch ? new Set(_cachedSearch.pickedHits) : new Set(),
  );
  const [attachNote, setAttachNote] = useState<string | null>(null);

  // Mirror the live state back into the module cache. Only writes when there's
  // a result to remember; the 2-min TTL is rolled forward on every interaction.
  useEffect(() => {
    if (!searchResult) return;
    _lastSearch = {
      query:         search.query,
      rerank:        search.rerank,
      selectedDbIds: new Set(search.selectedDbIds),
      result:        searchResult,
      pickedHits:    new Set(pickedHits),
      touchedAt:     Date.now(),
    };
  }, [searchResult, pickedHits, search.query, search.rerank, search.selectedDbIds]);

  // Per-DB integrity report (latest verify result), keyed by db id.
  interface IntegrityReport {
    dbId:           string;
    chunkCount:     number;
    vecCount:       number;
    orphanChunks:   number;
    orphanVecs:     number;
    missingSources: number;
    metaOk:         boolean;
  }
  const [verify, setVerify] = useState<Record<string, IntegrityReport | { error: string } | 'busy'>>({});

  // Entitlement cache snapshot + migration UI state. Probe is operator-
  // triggered (or stale-and-auto on boot); the per-row "migrate" button
  // opens an inline target-picker keyed by db id.
  const [entitlements, setEntitlements] = useState<EntitlementsSnapshot | null>(null);
  const [probing, setProbing] = useState(false);
  const [migrateState, setMigrateState] = useState<Record<string, {
    targetModel: string;
    newId:       string;
    displayName: string;
    busy:        boolean;
    error?:      string;
  } | null>>({});

  const load = useCallback(async () => {
    const url = _baseUrl();
    if (!url) return;
    try {
      const [d, s] = await Promise.all([
        fetch(`${url}/v1/context-rag/dbs`).then((r) => r.json()),
        fetch(`${url}/v1/context-rag/status`).then((r) => r.json()),
      ]);
      if (d?.success) setDbs(d.dbs as VectorDB[]);
      if (s?.success) setStatus(s as Status);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const loadModels = useCallback(async () => {
    const url = _baseUrl();
    if (!url) return;
    try {
      const r = await fetch(`${url}/v1/models/`);
      const j = await r.json();
      if (j?.success && Array.isArray(j.models)) setModels(j.models as ModelRow[]);
    } catch (_) { /* non-fatal */ }
  }, []);

  useEffect(() => {
    void load();
    void loadModels();
    const t = setInterval(load, 5_000);
    return () => clearInterval(t);
  }, [load, loadModels]);

  const filteredModels = useMemo(() => {
    const wanted = form.embedProvider;
    return models.filter((m) => {
      const key = _bridgeKey(m.provider);
      if (key !== wanted) return false;
      if (form.showAllModels) return true;
      const name = String(m.name || m.id || '');
      return EMBED_NAME_RE.test(name);
    });
  }, [models, form.embedProvider, form.showAllModels]);

  async function refreshModels() {
    const url = _baseUrl();
    if (!url) return;
    try {
      await fetch(`${url}/v1/models/refresh`);
      await loadModels();
    } catch (_) { /* swallowed */ }
  }

  async function createDb(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const body: any = {
        id: form.id.trim(),
        displayName: form.displayName.trim() || form.id.trim(),
        embedProvider: form.embedProvider,
        embedModel: form.embedModel.trim(),
        source: {
          sessions: form.sessionsMode === 'cwd'
            ? { mode: 'cwd', cwd: form.sessionsCwd.trim() }
            : { mode: form.sessionsMode },
          files:     { mode: form.filesMode },
          knowledge: { mode: form.knowledgeMode },
        },
      };
      const r = await fetch(`${_baseUrl()}/v1/context-rag/dbs`, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify(body),
      });
      const j = await r.json();
      if (!j?.success) throw new Error(j?.error || `HTTP ${r.status}`);
      setForm((f) => ({ ...f, id: '', displayName: '', embedModel: '' }));
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function refreshDb(id: string) {
    if (!confirm(`Clear and re-ingest "${id}"? Existing vectors are dropped first.`)) return;
    try {
      const r = await fetch(`${_baseUrl()}/v1/context-rag/dbs/${encodeURIComponent(id)}/refresh`, { method: 'POST' });
      const j = await r.json();
      if (!j?.success) throw new Error(j?.error || `HTTP ${r.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function verifyDb(id: string) {
    setVerify((v) => ({ ...v, [id]: 'busy' }));
    try {
      const r = await fetch(`${_baseUrl()}/v1/context-rag/dbs/${encodeURIComponent(id)}/verify-integrity`);
      const j = await r.json();
      if (!j?.success) throw new Error(j?.error || `HTTP ${r.status}`);
      setVerify((v) => ({ ...v, [id]: j.report as IntegrityReport }));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setVerify((v) => ({ ...v, [id]: { error: msg } }));
    }
  }

  const loadEntitlements = useCallback(async () => {
    const url = _baseUrl();
    if (!url) return;
    try {
      const r = await fetch(`${url}/v1/context-rag/entitlements`);
      const j = await r.json();
      if (j?.success) setEntitlements({ providers: j.providers, stale: j.stale });
    } catch (_) { /* non-fatal */ }
  }, []);

  useEffect(() => { void loadEntitlements(); }, [loadEntitlements]);

  async function probeEntitlements() {
    setProbing(true);
    setError(null);
    try {
      const r = await fetch(`${_baseUrl()}/v1/context-rag/probe-entitlements`, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({}),
      });
      const j = await r.json();
      if (!j?.success) throw new Error(j?.error || `HTTP ${r.status}`);
      await loadEntitlements();
      // DB list also needs a refresh — embedModelStatus on each row is
      // derived from the entitlement cache and we just rewrote it.
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProbing(false);
    }
  }

  function openMigrate(db: VectorDB) {
    // Default the target to the first entitled, non-current model of the same
    // provider; the operator can override before submitting.
    const entry = entitlements?.providers?.[db.embedProvider] as ProviderEntitlement | undefined;
    const candidate = (entry?.available || []).find((id) => id !== db.embedModel) || '';
    setMigrateState((s) => ({
      ...s,
      [db.id]: {
        targetModel: candidate,
        newId:       db.id + '-v2',
        displayName: '',
        busy:        false,
      },
    }));
  }

  function cancelMigrate(dbId: string) {
    setMigrateState((s) => ({ ...s, [dbId]: null }));
  }

  async function submitMigrate(db: VectorDB) {
    const m = migrateState[db.id];
    if (!m) return;
    setMigrateState((s) => ({ ...s, [db.id]: { ...m, busy: true, error: undefined } }));
    try {
      const r = await fetch(`${_baseUrl()}/v1/context-rag/dbs/${encodeURIComponent(db.id)}/migrate`, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({
          newId:       m.newId,
          targetModel: m.targetModel,
          ...(m.displayName.trim() ? { displayName: m.displayName.trim() } : {}),
        }),
      });
      const j = await r.json();
      if (!j?.success) throw new Error(j?.error || `HTTP ${r.status}`);
      setMigrateState((s) => ({ ...s, [db.id]: null }));
      await load();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setMigrateState((s) => ({ ...s, [db.id]: { ...m, busy: false, error: msg } }));
    }
  }

  async function deleteDb(id: string, purge: boolean) {
    if (!confirm(`Delete DB "${id}"?${purge ? ' The .db file will be unlinked.' : ''}`)) return;
    try {
      const r = await fetch(
        `${_baseUrl()}/v1/context-rag/dbs/${encodeURIComponent(id)}${purge ? '?purge=1' : ''}`,
        { method: 'DELETE' },
      );
      const j = await r.json();
      if (!j?.success) throw new Error(j?.error || `HTTP ${r.status}`);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }

  async function runSearch(e: React.FormEvent) {
    e.preventDefault();
    if (!search.query.trim()) return;
    setSearchBusy(true);
    setSearchResult(null);
    setPickedHits(new Set());
    setAttachNote(null);
    try {
      const t0 = Date.now();
      const body: any = {
        query:  search.query.trim(),
        k:      8,
        rerank: search.rerank,
      };
      if (search.selectedDbIds.size > 0) {
        body.dbIds = Array.from(search.selectedDbIds);
      } else {
        body.all = true;
      }
      const r = await fetch(`${_baseUrl()}/v1/context-rag/search`, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify(body),
      });
      const j = await r.json();
      if (!j?.success) throw new Error(j?.error || `HTTP ${r.status}`);
      setSearchResult({ hits: j.hits as SearchHit[], ms: Date.now() - t0 });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSearchBusy(false);
    }
  }

  function toggleDbInSearch(id: string) {
    setSearch((s) => {
      const next = new Set(s.selectedDbIds);
      if (next.has(id)) next.delete(id); else next.add(id);
      return { ...s, selectedDbIds: next };
    });
  }

  function togglePickedHit(i: number) {
    setPickedHits((p) => {
      const next = new Set(p);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  }

  // Push the picked hits onto the chat's pending-attachments queue and emit one
  // extra 'rag-hint' note pointing at the MCP `rag_search` tool — partner
  // agents (Claude Code / Codex / external MCP clients) read the hint and know
  // how to fetch further chunks from the same DB(s) without leaving the chat.
  function attachPickedToChat(allHits: SearchHit[]) {
    if (pickedHits.size === 0) return;
    const chosen = Array.from(pickedHits).sort((a, b) => a - b)
      .map((i) => allHits[i])
      .filter(Boolean) as SearchHit[];
    for (const h of chosen) {
      const tag  = h.dbDisplayName || h.dbId;
      const sid  = (h.sourceId || '').slice(0, 40);
      chatUI.addAttachment({
        type:           'rag-hit',
        name:           `${tag} · ${h.sourceKind}:${sid}`,
        dbId:           h.dbId,
        dbDisplayName:  h.dbDisplayName,
        sourceKind:     h.sourceKind,
        sourceId:       h.sourceId,
        sourcePath:     h.sourcePath,
        text:           h.text,
        distance:       h.distance,
        rerankScore:    h.rerankScore,
      });
    }
    const uniqDbIds = Array.from(new Set(chosen.map((h) => h.dbId)));
    chatUI.addAttachment({
      type:   'rag-hint',
      name:   `RAG hint · ${uniqDbIds.length} db${uniqDbIds.length === 1 ? '' : 's'}`,
      query:  search.query.trim(),
      dbIds:  uniqDbIds,
      rerank: search.rerank,
    });
    setAttachNote(`Attached ${chosen.length} hit${chosen.length === 1 ? '' : 's'} + MCP hint to chat.`);
    // Strip the picked set from the cache directly — the modal close that
    // follows unmounts this component before any setPickedHits() could flush,
    // so reopening would otherwise re-show stale checkmarks of hits already
    // attached.
    if (_lastSearch) {
      _lastSearch = { ..._lastSearch, pickedHits: new Set(), touchedAt: Date.now() };
    }
    window.dispatchEvent(new CustomEvent('yha:close-context-hub'));
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
      <header>
        <h4 style={{ margin: 0 }}>Context-RAG vector DBs</h4>
        <p style={{ margin: '4px 0 0', fontSize: '12px', color: 'var(--fg-mute, #aaa)' }}>
          Per-DB embedding indexes over sessions, files, and knowledge entries. Each
          DB locks an embedding model at create time; reads + writes never cross
          model lines.
        </p>
      </header>

      {error && (
        <div style={{
          padding: '8px 10px', border: '1px solid #844', borderRadius: 4,
          background: 'rgba(180,60,60,0.12)', color: '#e88', fontSize: '12px',
        }}>
          {error} <button className="prefs-btn" onClick={() => setError(null)} style={{ marginLeft: 8, fontSize: 11 }}>dismiss</button>
        </div>
      )}

      {/* ── Status strip ──────────────────────────────────────────────── */}
      <section style={{
        padding: '8px 10px', border: '1px solid var(--border, #2a2a2a)',
        borderRadius: 6, fontSize: '12px',
      }}>
        <strong>Runner:</strong>{' '}
        {status
          ? (status.enabled
              ? (status.isRunning ? '● running' : '○ idle')
              : 'disabled')
          : '…'}
        {' · '}
        <strong>Queue:</strong> {status?.queue?.total ?? 0}
        {status?.queue?.byKind && (
          <span style={{ marginLeft: 6, opacity: 0.7 }}>
            (sessions {status.queue.byKind.session ?? 0},
            files {status.queue.byKind.file ?? 0},
            knowledge {status.queue.byKind.knowledge ?? 0})
          </span>
        )}
      </section>

      {/* ── Entitlements strip ──────────────────────────────────────── */}
      <section style={{
        padding: '8px 10px', border: '1px solid var(--border, #2a2a2a)',
        borderRadius: 6, fontSize: '12px', display: 'flex', flexWrap: 'wrap',
        gap: 10, alignItems: 'center',
      }}>
        <strong>Entitlements:</strong>
        {(['nvidia', 'lmstudio'] as const).map((p) => {
          const entry = entitlements?.providers?.[p] as ProviderEntitlement | { error: string } | undefined;
          const stale = entitlements?.stale?.[p] !== false;
          if (!entry) return (
            <span key={p} style={{ opacity: 0.7 }}>{p}: <em>never probed</em></span>
          );
          if ('error' in entry) return (
            <span key={p} style={{ color: '#e88' }}>{p}: error ({entry.error})</span>
          );
          const age = Date.now() - entry.probedAt;
          const ageStr = age < 60_000 ? `${Math.round(age / 1_000)}s ago`
                       : age < 60 * 60_000 ? `${Math.round(age / 60_000)}m ago`
                       : age < 24 * 60 * 60_000 ? `${Math.round(age / 3600_000)}h ago`
                       : new Date(entry.probedAt).toLocaleString();
          return (
            <span key={p} style={{ color: stale ? '#dca' : 'inherit' }}>
              {p}: {entry.available.length} ok · {entry.unavailable.length} blocked
              {' · '}
              <span style={{ opacity: 0.7 }}>{ageStr}{stale ? ' (stale)' : ''}</span>
            </span>
          );
        })}
        <button
          className="prefs-btn"
          type="button"
          onClick={() => void probeEntitlements()}
          disabled={probing}
          style={{ fontSize: 12, marginLeft: 'auto' }}
          title="Probe every curated NVIDIA model + all in-use models against your provider"
        >
          {probing ? 'Probing…' : 'Probe entitlements'}
        </button>
      </section>

      {/* ── DB list ─────────────────────────────────────────────────── */}
      <section>
        <h5 style={{ margin: '0 0 8px' }}>Existing DBs ({dbs.length})</h5>
        {dbs.length === 0 && (
          <p style={{ fontSize: 12, color: 'var(--fg-mute, #888)' }}>
            No DBs yet. Create one below to start indexing.
          </p>
        )}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {dbs.map((db) => (
            <div key={db.id} style={{
              padding: '10px 12px', border: '1px solid var(--border, #2a2a2a)',
              borderRadius: 6,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
                <div>
                  <strong>{db.displayName}</strong>{' '}
                  <code style={{ fontSize: 11, opacity: 0.7 }}>{db.id}</code>
                </div>
                <div style={{ fontSize: 11, color: 'var(--fg-mute, #888)' }}>
                  {db.embedProvider} · {db.embedModel} · dim {db.embedDim}
                </div>
              </div>
              <div style={{ marginTop: 4, fontSize: 12, color: 'var(--fg-mute, #aaa)' }}>
                chunks: {db.live?.chunkCount ?? db.stats?.chunks ?? 0}
                {' · '}
                last ingest: {_formatWhen(db.stats?.lastIngestAt)}
                {db.stats?.lastError && (
                  <span style={{ color: '#e88', marginLeft: 6 }}>
                    error: {db.stats.lastError}
                  </span>
                )}
              </div>
              <div style={{ marginTop: 4, fontSize: 11, opacity: 0.7 }}>
                sessions={db.source.sessions.mode}
                {db.source.sessions.mode === 'cwd' && db.source.sessions.cwd && (
                  <code style={{ marginLeft: 4 }}>({db.source.sessions.cwd})</code>
                )}
                {' · '}files={db.source.files.mode}
                {' · '}knowledge={db.source.knowledge.mode}
              </div>
              {db.embedModelStatus === 'unavailable' && (
                <div style={{
                  marginTop: 6, padding: '6px 8px',
                  border: '1px solid #844', borderRadius: 4,
                  background: 'rgba(180,60,60,0.10)', fontSize: 11, color: '#dca',
                }}>
                  ⚠ embed model <code>{db.embedModel}</code> is no longer enabled on your{' '}
                  {db.embedProvider} account. Existing search keeps working
                  (vectors are already on disk); new content can't be indexed.
                  Migrate to an available model below.
                </div>
              )}
              {db.migratedTo && (
                <div style={{ marginTop: 6, fontSize: 11, color: 'var(--fg-mute, #888)' }}>
                  → migrated to <code>{db.migratedTo}</code> (old DB still live for search)
                </div>
              )}
              {db.migratedFrom && (
                <div style={{ marginTop: 6, fontSize: 11, color: 'var(--fg-mute, #888)' }}>
                  ← migration target from <code>{db.migratedFrom}</code>
                </div>
              )}
              <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button
                  className="prefs-btn"
                  type="button"
                  onClick={() => void refreshDb(db.id)}
                  style={{ fontSize: 12 }}
                >
                  Re-ingest
                </button>
                <button
                  className="prefs-btn"
                  type="button"
                  onClick={() => void verifyDb(db.id)}
                  disabled={verify[db.id] === 'busy'}
                  style={{ fontSize: 12 }}
                  title="Check chunk/vector consistency, meta lock, and missing source files"
                >
                  {verify[db.id] === 'busy' ? 'Verifying…' : 'Verify integrity'}
                </button>
                <button
                  className="prefs-btn"
                  type="button"
                  onClick={() => openMigrate(db)}
                  disabled={!!migrateState[db.id]}
                  style={{
                    fontSize: 12,
                    ...(db.embedModelStatus === 'unavailable'
                      ? { color: '#dca', borderColor: '#844' }
                      : {}),
                  }}
                  title="Create a new DB with the same sources but a different embed model"
                >
                  Migrate to…
                </button>
                <button
                  className="prefs-btn"
                  type="button"
                  onClick={() => void deleteDb(db.id, false)}
                  style={{ fontSize: 12 }}
                >
                  Delete
                </button>
                <button
                  className="prefs-btn-danger"
                  type="button"
                  onClick={() => void deleteDb(db.id, true)}
                  style={{ fontSize: 12 }}
                  title="Delete and unlink the .db file"
                >
                  Delete + purge file
                </button>
              </div>
              {(() => {
                const m = migrateState[db.id];
                if (!m) return null;
                const entry = entitlements?.providers?.[db.embedProvider] as ProviderEntitlement | undefined;
                const choices = (entry?.available || []).filter((id) => id !== db.embedModel);
                return (
                  <div style={{
                    marginTop: 8, padding: 10,
                    border: '1px solid var(--border, #333)', borderRadius: 4,
                    display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12,
                  }}>
                    <strong style={{ fontSize: 12 }}>Migrate <code>{db.id}</code> to…</strong>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <span>new id (kebab-case, unique)</span>
                      <input
                        className="prefs-input"
                        value={m.newId}
                        onChange={(e) => setMigrateState((s) => ({
                          ...s, [db.id]: { ...m, newId: e.target.value },
                        }))}
                        pattern="^[a-z0-9][a-z0-9-]{0,62}$"
                      />
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <span>display name (optional)</span>
                      <input
                        className="prefs-input"
                        value={m.displayName}
                        onChange={(e) => setMigrateState((s) => ({
                          ...s, [db.id]: { ...m, displayName: e.target.value },
                        }))}
                        placeholder={`${db.displayName} (${(m.targetModel || '').split('/').pop() || 'migrated'})`}
                      />
                    </label>
                    <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      <span>target embed model ({db.embedProvider})</span>
                      <select
                        className="prefs-select"
                        value={m.targetModel}
                        onChange={(e) => setMigrateState((s) => ({
                          ...s, [db.id]: { ...m, targetModel: e.target.value },
                        }))}
                        required
                      >
                        <option value="">— pick a model —</option>
                        {choices.map((id) => (
                          <option key={id} value={id}>{id}</option>
                        ))}
                      </select>
                      {choices.length === 0 && (
                        <span style={{ fontSize: 11, color: '#dca' }}>
                          No entitled alternatives in the cache. Run “Probe entitlements”
                          above first.
                        </span>
                      )}
                    </label>
                    {m.error && (
                      <div style={{ color: '#e88', fontSize: 11 }}>{m.error}</div>
                    )}
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        className="prefs-btn"
                        type="button"
                        onClick={() => void submitMigrate(db)}
                        disabled={m.busy || !m.newId || !m.targetModel}
                      >
                        {m.busy ? 'Migrating…' : 'Create migration target'}
                      </button>
                      <button
                        className="prefs-btn"
                        type="button"
                        onClick={() => cancelMigrate(db.id)}
                        disabled={m.busy}
                      >
                        Cancel
                      </button>
                      <span style={{ fontSize: 11, color: 'var(--fg-mute, #888)', alignSelf: 'center' }}>
                        Creates a new DB; existing one stays live until you delete it.
                      </span>
                    </div>
                  </div>
                );
              })()}
              {(() => {
                const v = verify[db.id];
                if (!v || v === 'busy') return null;
                if ('error' in v) {
                  return (
                    <div style={{ marginTop: 6, fontSize: 11, color: '#e88' }}>
                      verify error: {v.error}
                    </div>
                  );
                }
                const issues = (!v.metaOk ? 1 : 0) + v.orphanChunks + v.orphanVecs + v.missingSources;
                const tone = issues > 0 ? '#dca' : 'var(--fg-mute, #888)';
                return (
                  <div style={{ marginTop: 6, fontSize: 11, color: tone }}>
                    {issues === 0 ? '✅ ' : '⚠ '}
                    chunks={v.chunkCount} · vecs={v.vecCount}
                    {' · '}orphans(chunks/vecs)={v.orphanChunks}/{v.orphanVecs}
                    {' · '}missingSources={v.missingSources}
                    {' · '}meta={v.metaOk ? 'ok' : 'MISMATCH'}
                  </div>
                );
              })()}
            </div>
          ))}
        </div>
      </section>

      {/* ── Create form ─────────────────────────────────────────────── */}
      <section style={{
        padding: '12px', border: '1px solid var(--border, #2a2a2a)', borderRadius: 6,
      }}>
        <h5 style={{ margin: '0 0 8px' }}>Create new DB</h5>
        <form onSubmit={createDb} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ fontSize: 12 }}>id (kebab-case, immutable)</span>
            <input
              className="prefs-input"
              value={form.id}
              onChange={(e) => setForm((f) => ({ ...f, id: e.target.value }))}
              pattern="^[a-z0-9][a-z0-9-]{0,62}$"
              placeholder="my-rag-db"
              required
            />
          </label>

          <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ fontSize: 12 }}>display name</span>
            <input
              className="prefs-input"
              value={form.displayName}
              onChange={(e) => setForm((f) => ({ ...f, displayName: e.target.value }))}
              placeholder="My RAG DB"
            />
          </label>

          <fieldset style={{ border: '1px solid var(--border, #333)', padding: 8, borderRadius: 4 }}>
            <legend style={{ fontSize: 12 }}>embedding</legend>
            <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 6 }}>
              <label style={{ fontSize: 12 }}>
                <input
                  type="radio"
                  name="embedProvider"
                  checked={form.embedProvider === 'lmstudio'}
                  onChange={() => setForm((f) => ({ ...f, embedProvider: 'lmstudio', embedModel: '' }))}
                /> LM Studio
              </label>
              <label style={{ fontSize: 12 }}>
                <input
                  type="radio"
                  name="embedProvider"
                  checked={form.embedProvider === 'nvidia'}
                  onChange={() => setForm((f) => ({ ...f, embedProvider: 'nvidia', embedModel: '' }))}
                /> NVIDIA NIM
              </label>
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <select
                className="prefs-select"
                value={form.embedModel}
                onChange={(e) => setForm((f) => ({ ...f, embedModel: e.target.value }))}
                required
                style={{ flex: 1 }}
              >
                <option value="">— pick a model —</option>
                {filteredModels.map((m) => (
                  <option key={String(m.id) + ':' + String(m.name)} value={String(m.name || m.id)}>
                    {String(m.name || m.id)}
                  </option>
                ))}
              </select>
              <button className="prefs-btn" type="button" onClick={() => void refreshModels()} title="Re-fetch /v1/models/" style={{ fontSize: 12 }}>
                ↻
              </button>
            </div>
            <label style={{ fontSize: 11, color: 'var(--fg-mute, #888)', marginTop: 6, display: 'block' }}>
              <input
                type="checkbox"
                checked={form.showAllModels}
                onChange={(e) => setForm((f) => ({ ...f, showAllModels: e.target.checked }))}
              /> show all models (otherwise filtered by /embed|bge|e5|nomic|arctic|gte/i)
            </label>
          </fieldset>

          <fieldset style={{ border: '1px solid var(--border, #333)', padding: 8, borderRadius: 4 }}>
            <legend style={{ fontSize: 12 }}>sources</legend>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <label style={{ fontSize: 12 }}>
                sessions:{' '}
                <select
                  className="prefs-select"
                  value={form.sessionsMode}
                  onChange={(e) => setForm((f) => ({ ...f, sessionsMode: e.target.value as any }))}
                >
                  <option value="all">all</option>
                  <option value="cwd">only cwd</option>
                  <option value="off">off</option>
                </select>
                {form.sessionsMode === 'cwd' && (
                  <input
                    className="prefs-input"
                    value={form.sessionsCwd}
                    onChange={(e) => setForm((f) => ({ ...f, sessionsCwd: e.target.value }))}
                    placeholder="/abs/path"
                    style={{ marginLeft: 6, width: 260 }}
                    required
                  />
                )}
              </label>
              <label style={{ fontSize: 12 }}>
                files:{' '}
                <select
                  className="prefs-select"
                  value={form.filesMode}
                  onChange={(e) => setForm((f) => ({ ...f, filesMode: e.target.value as any }))}
                >
                  <option value="off">off</option>
                  <option value="cwd">only cwd (step 10)</option>
                </select>
              </label>
              <label style={{ fontSize: 12 }}>
                knowledge:{' '}
                <select
                  className="prefs-select"
                  value={form.knowledgeMode}
                  onChange={(e) => setForm((f) => ({ ...f, knowledgeMode: e.target.value as any }))}
                >
                  <option value="off">off</option>
                  <option value="all">all (step 11)</option>
                </select>
              </label>
            </div>
          </fieldset>

          <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <button className="prefs-btn" type="submit" disabled={busy || !form.id || !form.embedModel}>
              {busy ? 'Probing…' : 'Create DB'}
            </button>
            <span style={{ fontSize: 11, color: 'var(--fg-mute, #888)' }}>
              Creating probes the embedding model for its dimension, then stamps the new .db file.
            </span>
          </div>
        </form>
      </section>

      {/* ── Search test ─────────────────────────────────────────────── */}
      <section style={{
        padding: '12px', border: '1px solid var(--border, #2a2a2a)', borderRadius: 6,
      }}>
        <h5 style={{ margin: '0 0 8px' }}>Search test</h5>
        <form onSubmit={runSearch} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <input
            className="prefs-input"
            value={search.query}
            onChange={(e) => setSearch((s) => ({ ...s, query: e.target.value }))}
            placeholder="Type a query…"
            disabled={searchBusy}
          />
          <div style={{ fontSize: 12, display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {dbs.length === 0 && <span style={{ color: 'var(--fg-mute, #888)' }}>(no DBs yet)</span>}
            {dbs.map((db) => (
              <label key={db.id} style={{ fontSize: 12 }}>
                <input
                  type="checkbox"
                  checked={search.selectedDbIds.has(db.id)}
                  onChange={() => toggleDbInSearch(db.id)}
                />{' '}{db.displayName}
              </label>
            ))}
          </div>
          <label style={{ fontSize: 12 }}>
            <input
              type="checkbox"
              checked={search.rerank}
              onChange={(e) => setSearch((s) => ({ ...s, rerank: e.target.checked }))}
            /> rerank (NIM nv-rerankqa, if available)
          </label>
          <button className="prefs-btn" type="submit" disabled={searchBusy || !search.query.trim()} style={{ alignSelf: 'flex-start' }}>
            {searchBusy ? 'Searching…' : 'Search'}
          </button>
        </form>

        {searchResult && (
          <div style={{ marginTop: 10 }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 10,
              fontSize: 12, color: 'var(--fg-mute, #888)', marginBottom: 4,
            }}>
              <span style={{ flex: 1 }}>
                {searchResult.hits.length} hits · {searchResult.ms} ms total
                {pickedHits.size > 0 && <> · <strong>{pickedHits.size} selected</strong></>}
              </span>
              {searchResult.hits.length > 0 && (
                <button
                  className="prefs-btn"
                  type="button"
                  disabled={pickedHits.size === 0}
                  onClick={() => attachPickedToChat(searchResult.hits)}
                  title="Attach the selected hits to the chat input as RAG context, plus an MCP-tool hint so the model can re-query the same DB(s) via rag_search"
                >
                  Attach {pickedHits.size > 0 ? `${pickedHits.size} ` : ''}to chat
                </button>
              )}
            </div>
            {attachNote && (
              <div style={{ fontSize: 12, color: 'var(--accent, #4af)', marginBottom: 6 }}>
                {attachNote}
              </div>
            )}
            <ol style={{ paddingLeft: 18, fontSize: 12, lineHeight: 1.45 }}>
              {searchResult.hits.map((h, i) => {
                const isPicked = pickedHits.has(i);
                return (
                  <li
                    key={i}
                    style={{
                      marginBottom: 6,
                      padding: 4,
                      borderRadius: 4,
                      background: isPicked ? 'rgba(70,140,255,0.10)' : 'transparent',
                    }}
                  >
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input
                        type="checkbox"
                        checked={isPicked}
                        onChange={() => togglePickedHit(i)}
                      />
                      <code>{h.dbDisplayName || h.dbId}</code>
                      {' · '}
                      <code>{h.sourceKind}</code>
                      {' · '}
                      dist {h.distance.toFixed(4)}
                      {typeof h.rerankScore === 'number' && (
                        <> · rerank {h.rerankScore.toFixed(2)}</>
                      )}
                    </label>
                    <div style={{ marginTop: 2, whiteSpace: 'pre-wrap', maxHeight: 90, overflow: 'auto' }}>
                      {h.text}
                    </div>
                  </li>
                );
              })}
            </ol>
          </div>
        )}
      </section>
    </div>
  );
}
