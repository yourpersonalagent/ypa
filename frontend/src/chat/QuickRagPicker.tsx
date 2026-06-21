// QuickRagPicker — input-popover for the context-rag retrieve path.
//
// Mounts at the #chat-rag-btn button in the chat input bar (rendered by
// QuickRagButton.tsx). Lets the user type a query, runs it against
// /v1/context-rag/search across all configured DBs, then attaches selected
// hits to the next chat message as `type: 'rag-hit'` attachments. The
// hit body is rendered inline into the prompt by chat.ts's buildDisplayInput
// so the LLM sees the retrieved chunks alongside the user's own text.
//
// Architecture mirrors QuickContextPicker:
//   • Popover shell + position math + ESC / click-outside dismissal here.
//   • Self-wires its trigger by reading `document.getElementById('chat-rag-btn')`.

import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import chatUI from './chat-ui.js';
import { api } from '../api.js';
import { useAppStore } from '../stores/index.js';

interface SearchHit {
  dbId: string;
  dbDisplayName?: string;
  sourceKind: string;
  sourceId: string;
  sourcePath: string | null;
  sourceUrl?: string | null;
  text: string;
  distance: number;
  rerankScore?: number;
  sensitivityTier?: 'public' | 'system' | 'sensitive' | null;
  sensitivityConf?: number | null;
}

interface DbSummary {
  id: string;
  source?: {
    sessions?: { mode?: string; cwd?: string };
    files?:    { mode?: string; cwd?: string };
  };
}

function _cwdsFromDbs(dbs: DbSummary[]): Set<string> {
  const out = new Set<string>();
  for (const d of dbs) {
    const s = d.source?.sessions;
    const f = d.source?.files;
    if (s?.mode === 'cwd' && s.cwd) out.add(String(s.cwd).replace(/\/+$/, ''));
    if (f?.mode === 'cwd' && f.cwd) out.add(String(f.cwd).replace(/\/+$/, ''));
  }
  return out;
}

type KindFilter = 'all' | 'session' | 'file' | 'knowledge';

interface EmbedModelInfo  { id: string; looksLikeCodeEmbed: boolean; curated?: boolean }
interface EmbedProviderInfo {
  embedProvider: 'nvidia' | 'lmstudio';
  configured:    boolean;
  displayName:   string;
  endpoint?:     string;
  embedModels:   EmbedModelInfo[];
  error?:        string;
}
interface SetupSelection {
  enabled: boolean;
  id: string;
  displayName: string;
  embedProvider: 'nvidia' | 'lmstudio';
  embedModel: string;
}

const KIND_ICON: Record<string, string> = {
  session:   '💬',
  file:      '📄',
  knowledge: '📚',
};

const KIND_LABELS: { value: KindFilter; label: string; icon: string }[] = [
  { value: 'all',       label: 'All',       icon: '✱'  },
  { value: 'session',   label: 'Sessions',  icon: '💬' },
  { value: 'file',      label: 'Files',     icon: '📄' },
  { value: 'knowledge', label: 'Knowledge', icon: '📚' },
];

interface PanelProps {
  onClose: () => void;
  anchor:  DOMRect | null;
}

function _baseUrl(): string {
  return (api.config as { baseUrl?: string })?.baseUrl || '';
}

// Last-search cache lives at module scope so it survives the popover unmount
// (the panel is fully torn down when the user clicks outside / hits ESC). TTL
// is refreshed on every interaction; once `touchedAt + TTL` passes the slot is
// considered empty and the next open starts fresh.
const _SEARCH_CACHE_TTL_MS = 2 * 60_000;
let _lastSearch: {
  query:         string;
  hits:          SearchHit[];
  picked:        Set<number>;
  kind:          KindFilter;
  includeSystem: boolean;
  rerank:        boolean;
  touchedAt:     number;
} | null = null;

function _readSearchCache(): typeof _lastSearch {
  if (!_lastSearch) return null;
  if (Date.now() - _lastSearch.touchedAt > _SEARCH_CACHE_TTL_MS) {
    _lastSearch = null;
    return null;
  }
  return _lastSearch;
}

function _snip(s: string, max: number): string {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

/** Derive a kebab-case slug from an absolute path's basename. Used to
 *  pre-fill the chats/code DB ids so the user usually doesn't have to
 *  edit them. Trailing slash + dot-prefix safe. */
function _slugFromCwd(cwd: string | null | undefined): string {
  const parts = String(cwd || '').replace(/\/+$/, '').split('/').filter(Boolean);
  const base  = parts.length ? parts[parts.length - 1] : 'cwd';
  return base
    .toLowerCase()
    .replace(/^\.+/, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'cwd';
}

/** Pick a sensible default model from a provider's list. Prefers `code`
 *  embedders when `wantCode` is true; otherwise prefers e5 / nv-embedqa /
 *  text embedders. Curated models take priority over uncurated catalogue
 *  entries (the latter routinely 404 on a fresh NVIDIA account). Falls back
 *  to the first id if no heuristic matches. */
function _defaultModel(models: EmbedModelInfo[], wantCode: boolean): string {
  if (!models.length) return '';
  const curated   = models.filter((m) => m.curated);
  const pool      = curated.length ? curated : models;
  if (wantCode) {
    // Specific known-good code embedder first, then any code-looking model.
    const known = pool.find((m) => /nv-embedcode/i.test(m.id));
    if (known) return known.id;
    const code = pool.find((m) => m.looksLikeCodeEmbed);
    if (code) return code.id;
  } else {
    const known = pool.find((m) => /nv-embedqa-e5-v5/i.test(m.id));
    if (known) return known.id;
  }
  const text = pool.find((m) => /text|qa|e5|embed-v|nomic-embed-text/.test(m.id.toLowerCase()) && !m.looksLikeCodeEmbed);
  return (text || pool[0]).id;
}

// ── SetupView ────────────────────────────────────────────────────────────────
// Renders the "set up RAG for this folder" form. Pre-fills two DB sections
// (chats + code) derived from the active session's working_dir, lets the
// operator pick an embed-capable provider+model per side, and submits both
// in one transactional POST. The route rolls back on partial failure, so the
// UI just shows the error and lets the user retry.

interface SetupViewProps {
  cwd:    string;
  onDone: () => void;
  onCancel: () => void;
}

function SetupView({ cwd, onDone, onCancel }: SetupViewProps) {
  const slug = useMemo(() => _slugFromCwd(cwd), [cwd]);
  const display = useMemo(() => {
    const parts = String(cwd || '').replace(/\/+$/, '').split('/').filter(Boolean);
    return parts.length ? parts[parts.length - 1] : 'cwd';
  }, [cwd]);

  const [providers, setProviders] = useState<EmbedProviderInfo[] | null>(null);
  const [pLoading, setPLoading]   = useState(true);
  const [pError,   setPError]     = useState<string | null>(null);
  const [submitErr, setSubmitErr] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // Default to the curated short-list — entries the adapter has verified
  // are likely to actually work. Operators who know their NVIDIA account
  // has extra entitlements can flip this on to reveal the full catalogue.
  const [showAdvanced, setShowAdvanced] = useState(false);

  const [chats, setChats] = useState<SetupSelection>({
    enabled: true,
    id: `${slug}-chats`,
    displayName: `${display} · chats`,
    embedProvider: 'nvidia',
    embedModel: '',
  });
  const [code, setCode] = useState<SetupSelection>({
    enabled: true,
    id: `${slug}-code`,
    displayName: `${display} · code`,
    embedProvider: 'nvidia',
    embedModel: '',
  });

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setPLoading(true);
      setPError(null);
      try {
        const r = await fetch(`${_baseUrl()}/v1/context-rag/embed-providers`);
        const j = await r.json();
        if (cancelled) return;
        if (!j?.success) throw new Error(j?.error || `HTTP ${r.status}`);
        const list = (j.providers || []) as EmbedProviderInfo[];
        setProviders(list);

        // Auto-pick first configured provider for each side, plus best model.
        const firstConfigured = list.find((p) => p.configured && p.embedModels.length);
        if (firstConfigured) {
          setChats((c) => ({
            ...c,
            embedProvider: firstConfigured.embedProvider,
            embedModel: _defaultModel(firstConfigured.embedModels, false),
          }));
          const codeProv = list.find((p) => p.configured && p.embedModels.some((m) => m.looksLikeCodeEmbed))
                       || firstConfigured;
          setCode((c) => ({
            ...c,
            embedProvider: codeProv.embedProvider,
            embedModel: _defaultModel(codeProv.embedModels, true),
          }));
        }
      } catch (e) {
        if (cancelled) return;
        setPError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setPLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  function modelsFor(p: 'nvidia' | 'lmstudio'): EmbedModelInfo[] {
    const all = providers?.find((x) => x.embedProvider === p)?.embedModels || [];
    if (showAdvanced) return all;
    // If any model is tagged curated, hide the rest. If none are tagged
    // (e.g. an LM Studio response we didn't curate), show everything so we
    // don't accidentally render an empty dropdown.
    const curated = all.filter((m) => m.curated);
    return curated.length ? curated : all;
  }
  function providerIsConfigured(p: 'nvidia' | 'lmstudio'): boolean {
    return !!providers?.find((x) => x.embedProvider === p)?.configured;
  }

  async function submit() {
    setSubmitErr(null);
    if (!chats.enabled && !code.enabled) {
      setSubmitErr('Enable at least one side (chats or code).');
      return;
    }
    if (!cwd) {
      setSubmitErr('No working directory set on the active session. Set one in Preferences → Working Dir first.');
      return;
    }
    setSubmitting(true);
    try {
      const body: Record<string, unknown> = { cwd, basename: display };
      if (chats.enabled) {
        body.chats = {
          id: chats.id, displayName: chats.displayName,
          embedProvider: chats.embedProvider, embedModel: chats.embedModel,
        };
      }
      if (code.enabled) {
        body.code = {
          id: code.id, displayName: code.displayName,
          embedProvider: code.embedProvider, embedModel: code.embedModel,
        };
      }
      const r = await fetch(`${_baseUrl()}/v1/context-rag/setup-cwd`, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify(body),
      });
      const j = await r.json();
      if (!j?.success) throw new Error(j?.error || `HTTP ${r.status}`);
      onDone();
    } catch (e) {
      setSubmitErr(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  function renderSide(
    label: string,
    side: SetupSelection,
    setSide: (next: SetupSelection) => void,
    forCode: boolean,
  ) {
    const cfg = providerIsConfigured(side.embedProvider);
    const models = modelsFor(side.embedProvider);
    return (
      <div style={{
        border: '1px solid var(--border, #2a2a2a)', borderRadius: 6, padding: 8,
        opacity: side.enabled ? 1 : 0.55,
      }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
          <input
            type="checkbox" checked={side.enabled}
            onChange={(e) => setSide({ ...side, enabled: e.target.checked })}
          />
          {label}
        </label>
        <div style={{ display: 'grid', gridTemplateColumns: '70px 1fr', gap: 4, fontSize: 11, alignItems: 'center' }}>
          <span style={{ color: 'var(--fg-mute, #888)' }}>id</span>
          <input
            className="prefs-input"
            type="text" value={side.id} disabled={!side.enabled}
            onChange={(e) => setSide({ ...side, id: e.target.value })}
            style={{ fontSize: 11, padding: '3px 6px' }}
          />
          <span style={{ color: 'var(--fg-mute, #888)' }}>name</span>
          <input
            className="prefs-input"
            type="text" value={side.displayName} disabled={!side.enabled}
            onChange={(e) => setSide({ ...side, displayName: e.target.value })}
            style={{ fontSize: 11, padding: '3px 6px' }}
          />
          <span style={{ color: 'var(--fg-mute, #888)' }}>provider</span>
          <select
            className="prefs-select"
            value={side.embedProvider} disabled={!side.enabled}
            onChange={(e) => {
              const next = e.target.value as 'nvidia' | 'lmstudio';
              const nextModels = modelsFor(next);
              setSide({
                ...side,
                embedProvider: next,
                embedModel: _defaultModel(nextModels, forCode),
              });
            }}
            style={{ fontSize: 11, padding: '3px 6px' }}
          >
            {providers?.map((p) => (
              <option key={p.embedProvider} value={p.embedProvider} disabled={!p.configured}>
                {p.displayName}{p.configured ? '' : ' (not configured)'}
              </option>
            )) || <option value={side.embedProvider}>{side.embedProvider}</option>}
          </select>
          <span style={{ color: 'var(--fg-mute, #888)' }}>model</span>
          <select
            className="prefs-select"
            value={side.embedModel} disabled={!side.enabled || !models.length}
            onChange={(e) => setSide({ ...side, embedModel: e.target.value })}
            style={{ fontSize: 11, padding: '3px 6px' }}
          >
            {models.length === 0 && <option value="">{cfg ? 'no embed models advertised' : 'provider not configured'}</option>}
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
                {m.looksLikeCodeEmbed ? '  · code' : ''}
                {showAdvanced && m.curated ? '  · curated' : ''}
              </option>
            ))}
          </select>
        </div>
      </div>
    );
  }

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>🛠️ Set up RAG for this folder</span>
        <span style={{ fontSize: 11, color: 'var(--fg-mute, #888)', flex: 1 }}>
          {cwd || '(no working directory)'}
        </span>
      </div>

      {pLoading && (
        <div style={{ fontSize: 12, color: 'var(--fg-mute, #888)', padding: '8px 4px' }}>
          Probing providers…
        </div>
      )}
      {pError && (
        <div style={{
          padding: '6px 8px', border: '1px solid #844', borderRadius: 4,
          background: 'rgba(180,60,60,0.12)', color: '#e88', fontSize: 12,
        }}>{pError}</div>
      )}

      {providers && !pLoading && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={{
            display: 'flex', alignItems: 'center', gap: 6, fontSize: 11,
            color: 'var(--fg-mute, #888)',
          }} title="Show every embed model the provider's /v1/models lists, including ones your NVIDIA account may not be entitled to call.">
            <input
              type="checkbox"
              checked={showAdvanced}
              onChange={(e) => {
                const next = e.target.checked;
                setShowAdvanced(next);
                if (!next && providers) {
                  // Snap each side back to a curated default if the operator
                  // had picked an uncurated model with Advanced on.
                  for (const [side, setSide, wantCode] of [
                    [chats, setChats, false] as const,
                    [code,  setCode,  true]  as const,
                  ]) {
                    const all = providers.find((p) => p.embedProvider === side.embedProvider)?.embedModels || [];
                    const isCurated = all.find((m) => m.id === side.embedModel)?.curated;
                    if (!isCurated) {
                      const curated = all.filter((m) => m.curated);
                      const fallback = _defaultModel(curated.length ? curated : all, wantCode);
                      setSide({ ...side, embedModel: fallback });
                    }
                  }
                }
              }}
            />
            Advanced: show every catalogue model (may include unentitled ids)
          </label>
          {renderSide('💬 Chats (sessions in this cwd)', chats, setChats, false)}
          {renderSide('📄 Code (files in this cwd, watched)', code, setCode, true)}

          {submitErr && (
            <div style={{
              padding: '6px 8px', border: '1px solid #844', borderRadius: 4,
              background: 'rgba(180,60,60,0.12)', color: '#e88', fontSize: 12,
            }}>{submitErr}</div>
          )}

          <div style={{ fontSize: 11, color: 'var(--fg-mute, #888)', lineHeight: 1.5 }}>
            Each DB is locked to its embed model at create time. The code-side DB will
            walk this folder once and then watch for file changes; the chats DB picks up
            sessions whose working_dir matches.
          </div>
        </div>
      )}

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', borderTop: '1px solid var(--border, #2a2a2a)', paddingTop: 8 }}>
        <span style={{ fontSize: 11, color: 'var(--fg-mute, #888)', flex: 1 }}>
          Probes embed dim, creates DB(s), then scans.
        </span>
        <button className="prefs-btn" onClick={onCancel} style={{ fontSize: 12 }} disabled={submitting}>Cancel</button>
        <button
          className="prefs-btn"
          onClick={submit}
          disabled={submitting || pLoading || !providers
                    || (!chats.enabled && !code.enabled)
                    || (chats.enabled && !chats.embedModel)
                    || (code.enabled  && !code.embedModel)}
          style={{ fontSize: 12, fontWeight: 600 }}
        >
          {submitting ? 'Creating…' : 'Create & scan'}
        </button>
      </div>
    </>
  );
}

function PanelContent({ onClose, anchor }: PanelProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const inputRef   = useRef<HTMLInputElement>(null);

  const sessionCwd = useAppStore((s) => s.sessionWorkingDir) ?? '';

  // View modes: 'loading' (initial DB probe), 'search' (normal), 'setup'
  // (the empty-state form OR user-requested via the ⚙️ button).
  const [view,  setView]    = useState<'loading' | 'search' | 'setup'>('loading');
  const [dbs,   setDbs]     = useState<DbSummary[]>([]);
  const dbCount = dbs.length;
  const hasCwdMatch = useMemo(() => {
    if (!sessionCwd) return true; // no cwd → no mismatch to warn about
    const cwdSet = _cwdsFromDbs(dbs);
    const norm = String(sessionCwd).replace(/\/+$/, '');
    return cwdSet.has(norm);
  }, [dbs, sessionCwd]);

  // Pull the cached search snapshot once at mount-time. If it's still fresh
  // (within the 2-min TTL) the input + hit list + filter selections rehydrate
  // so the user picks up where they left off after a brief close/reopen.
  const _cached = useMemo(_readSearchCache, []);
  const [query, setQuery]   = useState(_cached?.query ?? '');
  const [busy,  setBusy]    = useState(false);
  const [error, setError]   = useState<string | null>(null);
  const [hits,  setHits]    = useState<SearchHit[] | null>(_cached?.hits ?? null);
  const [rerank, setRerank] = useState(_cached?.rerank ?? true);
  const [picked, setPicked] = useState<Set<number>>(_cached ? new Set(_cached.picked) : new Set());
  const [kind,   setKind]   = useState<KindFilter>(_cached?.kind ?? 'all');
  // Sensitivity allow-list. Default is public-only to match the back-end
  // default and avoid accidentally pulling system-tier chunks into a chat
  // the model will paste back into the conversation. Operator opt-in.
  const [includeSystem, setIncludeSystem] = useState(_cached?.includeSystem ?? false);

  // Keep the module-scope cache in sync with whatever the user is doing in
  // the current session. We only write when there's an actual hit list — no
  // point caching an empty/loading state. Every write refreshes touchedAt so
  // the 2-min TTL counts from the last interaction, not the original search.
  useEffect(() => {
    if (hits === null) return;
    _lastSearch = {
      query,
      hits,
      picked:        new Set(picked),
      kind,
      includeSystem,
      rerank,
      touchedAt:     Date.now(),
    };
  }, [hits, picked, query, kind, includeSystem, rerank]);

  // Probe DBs once on open to decide whether to show the setup CTA.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await fetch(`${_baseUrl()}/v1/context-rag/dbs`);
        const j = await r.json();
        if (cancelled) return;
        const list = Array.isArray(j?.dbs) ? (j.dbs as DbSummary[]) : [];
        setDbs(list);
        setView(list.length === 0 ? 'setup' : 'search');
      } catch {
        if (cancelled) return;
        setView('search'); // fail open — let the user search/retry
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Close on outside click + ESC, mirroring QuickContextPicker.
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (overlayRef.current && !overlayRef.current.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') onClose(); }
    document.addEventListener('mousedown', onMouseDown, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onMouseDown, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  useEffect(() => { inputRef.current?.focus(); }, []);

  async function runSearch() {
    const q = query.trim();
    if (!q) return;
    setBusy(true);
    setError(null);
    setHits(null);
    setPicked(new Set());
    try {
      const allowTiers: string[] = ['public'];
      if (includeSystem) allowTiers.push('system');
      const r = await fetch(`${_baseUrl()}/v1/context-rag/search`, {
        method:  'POST',
        headers: { 'content-type': 'application/json' },
        body:    JSON.stringify({
          query: q,
          all: true,
          k: 8,
          rerank,
          ...(kind !== 'all' ? { sourceKind: kind } : {}),
          allowTiers,
        }),
      });
      const j = await r.json();
      if (!j?.success) throw new Error(j?.error || `HTTP ${r.status}`);
      setHits(j.hits as SearchHit[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  function toggleHit(i: number) {
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(i)) next.delete(i); else next.add(i);
      return next;
    });
  }

  function attachSelected() {
    if (!hits) return;
    const chosen = Array.from(picked).sort().map((i) => hits[i]).filter(Boolean) as SearchHit[];
    for (const h of chosen) {
      const tag  = h.dbDisplayName || h.dbId;
      const name = `${tag} · ${h.sourceKind}:${_snip(h.sourceId, 40)}`;
      chatUI.addAttachment({
        type: 'rag-hit',
        name,
        dbId: h.dbId,
        dbDisplayName: h.dbDisplayName,
        sourceKind: h.sourceKind,
        sourceId: h.sourceId,
        sourcePath: h.sourcePath,
        sourceUrl: h.sourceUrl,
        text: h.text,
        distance: h.distance,
        rerankScore: h.rerankScore,
        sensitivityTier: h.sensitivityTier,
      });
    }
    // Strip the picked set from the cache directly — onClose() unmounts the
    // panel immediately so a setPicked() here would never flush. We leave
    // hits/query intact so the next open shows the same results with a clean
    // checkbox slate (otherwise reopening would re-show stale checkmarks of
    // hits already attached to the chat input).
    if (_lastSearch) {
      _lastSearch = { ..._lastSearch, picked: new Set(), touchedAt: Date.now() };
    }
    onClose();
  }

  const width  = 480;
  const margin = 8;
  const gap    = 6;
  const vw     = window.innerWidth;
  const availableAbove = anchor ? Math.max(160, anchor.top - margin - gap) : 0;
  const style: React.CSSProperties = anchor
    ? {
        position: 'fixed',
        bottom:   window.innerHeight - anchor.top + gap,
        left:     Math.max(margin, Math.min(vw - width - margin, anchor.left)),
        width,
        maxHeight: `min(72vh, ${availableAbove}px)`,
        background: 'var(--bg, #1a1a1a)',
        border:     '1px solid var(--border, #333)',
        borderRadius: 8,
        boxShadow:  '0 12px 40px rgba(0,0,0,0.5)',
        display:    'flex',
        flexDirection: 'column',
        overflow:   'hidden',
        zIndex:     200,
        padding:    10,
        gap:        8,
      }
    : { display: 'none' };

  const rowBase: React.CSSProperties = {
    padding: '6px 8px',
    border: '1px solid var(--border, #2a2a2a)',
    borderRadius: 4,
    fontSize: 12,
    cursor: 'pointer',
    display: 'flex',
    gap: 8,
    alignItems: 'flex-start',
  };

  if (view === 'loading') {
    return (
      <div ref={overlayRef} className="popover quick-rag-picker" style={style}>
        <div style={{ fontSize: 12, color: 'var(--fg-mute, #888)', padding: '8px 4px' }}>
          Checking RAG state…
        </div>
      </div>
    );
  }

  if (view === 'setup') {
    return (
      <div ref={overlayRef} className="popover quick-rag-picker quick-rag-picker--setup" style={style}>
        <div className="quick-rag-picker__scroll quick-rag-picker__scroll--setup">
          <SetupView
            cwd={sessionCwd}
            onDone={() => {
              // Re-probe DBs so the cwd-match banner reflects the new state.
              (async () => {
                try {
                  const r = await fetch(`${_baseUrl()}/v1/context-rag/dbs`);
                  const j = await r.json();
                  if (Array.isArray(j?.dbs)) setDbs(j.dbs as DbSummary[]);
                } catch { /* ignore */ }
              })();
              setView('search');
            }}
            onCancel={() => { if (dbCount > 0) setView('search'); else onClose(); }}
          />
        </div>
      </div>
    );
  }

  return (
    <div ref={overlayRef} className="popover quick-rag-picker" style={style}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>⚡ RAG search</span>
        <span style={{ fontSize: 11, color: 'var(--fg-mute, #888)', flex: 1 }}>
          Attach matching chunks to your next message
        </span>
        <button
          type="button"
          onClick={() => setView('setup')}
          title="Set up RAG for the current working directory"
          style={{
            fontSize: 11, padding: '2px 6px', borderRadius: 4,
            background: 'transparent', border: '1px solid var(--border, #333)',
            color: 'var(--fg-mute, #888)', cursor: 'pointer',
          }}
        >
          ⚙ setup
        </button>
        <label style={{ fontSize: 11, color: 'var(--fg-mute, #888)' }} title="Include system-tier chunks (default: public only)">
          <input type="checkbox" checked={includeSystem} onChange={(e) => setIncludeSystem(e.target.checked)} /> +system
        </label>
        <label style={{ fontSize: 11, color: 'var(--fg-mute, #888)' }}>
          <input type="checkbox" checked={rerank} onChange={(e) => setRerank(e.target.checked)} /> rerank
        </label>
      </div>

      {!hasCwdMatch && sessionCwd && (
        <div style={{
          padding: '6px 8px',
          border: '1px solid var(--border, #2a4)', borderRadius: 4,
          background: 'rgba(70,170,90,0.08)', fontSize: 11,
          display: 'flex', gap: 8, alignItems: 'center',
        }}>
          <span style={{ flex: 1, color: 'var(--fg-mute, #9aa)' }}>
            No RAG DB for this folder. Search runs against existing DBs only.
          </span>
          <button
            type="button"
            onClick={() => setView('setup')}
            style={{
              fontSize: 11, padding: '3px 8px', borderRadius: 4,
              border: '1px solid var(--accent, #4af)',
              background: 'transparent', color: 'var(--accent, #4af)', cursor: 'pointer',
            }}
          >
            Set up
          </button>
        </div>
      )}

      <div style={{ display: 'flex', gap: 4 }}>
        {KIND_LABELS.map((k) => {
          const active = kind === k.value;
          return (
            <button
              key={k.value}
              type="button"
              onClick={() => setKind(k.value)}
              style={{
                fontSize: 11,
                padding: '3px 8px',
                borderRadius: 999,
                border: '1px solid',
                borderColor: active ? 'var(--accent, #4af)' : 'var(--border, #333)',
                background:  active ? 'rgba(70,140,255,0.12)' : 'transparent',
                color:       active ? 'var(--fg, #ddd)' : 'var(--fg-mute, #888)',
                cursor: 'pointer',
              }}
            >
              {k.icon} {k.label}
            </button>
          );
        })}
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); runSearch(); }}
        style={{ display: 'flex', gap: 6 }}
      >
        <input
          ref={inputRef}
          className="prefs-input"
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search across all RAG DBs…"
          style={{ flex: 1, padding: '6px 8px', fontSize: 13 }}
        />
        <button className="prefs-btn" type="submit" disabled={busy || !query.trim()} style={{ padding: '6px 12px' }}>
          {busy ? '…' : 'Search'}
        </button>
      </form>

      {error && (
        <div style={{
          padding: '6px 8px', border: '1px solid #844', borderRadius: 4,
          background: 'rgba(180,60,60,0.12)', color: '#e88', fontSize: 12,
        }}>{error}</div>
      )}

      <div className="quick-rag-picker__scroll" style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
        {hits && hits.length === 0 && (
          <div style={{ fontSize: 12, color: 'var(--fg-mute, #888)', padding: '12px 8px' }}>
            No hits. Try a different phrasing, or check the Hub → 🧬 RAG tab to see
            which DBs are populated.
          </div>
        )}
        {hits && hits.map((h, i) => {
          const isPicked = picked.has(i);
          const score = h.rerankScore != null
            ? `rerank ${h.rerankScore.toFixed(2)}`
            : `dist ${h.distance.toFixed(3)}`;
          return (
            <div
              key={i}
              onClick={() => toggleHit(i)}
              style={{
                ...rowBase,
                borderColor: isPicked ? 'var(--accent, #4af)' : 'var(--border, #2a2a2a)',
                background:  isPicked ? 'rgba(70,140,255,0.08)' : 'transparent',
              }}
            >
              <input
                type="checkbox"
                checked={isPicked}
                onChange={() => toggleHit(i)}
                onClick={(e) => e.stopPropagation()}
                style={{ marginTop: 2 }}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 6, fontSize: 11, color: 'var(--fg-mute, #888)', marginBottom: 3, alignItems: 'center' }}>
                  <span title={`source kind: ${h.sourceKind}`}>{KIND_ICON[h.sourceKind] || '•'}</span>
                  <span>{h.dbDisplayName || h.dbId}</span>
                  <span>·</span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                    {h.sourceId}
                  </span>
                  {h.sourceUrl && h.sourceUrl.startsWith('file://') && (
                    <a
                      href={h.sourceUrl}
                      onClick={(e) => e.stopPropagation()}
                      title="Open the original file"
                      style={{ color: 'var(--accent, #4af)', textDecoration: 'none', fontSize: 10 }}
                    >
                      ↗
                    </a>
                  )}
                  {h.sensitivityTier && h.sensitivityTier !== 'public' && (
                    <span
                      title={`sensitivity: ${h.sensitivityTier}${h.sensitivityConf != null ? ` (conf ${h.sensitivityConf.toFixed(2)})` : ''}`}
                      style={{
                        padding: '0 5px',
                        borderRadius: 3,
                        background: h.sensitivityTier === 'sensitive' ? 'rgba(220,80,80,0.18)' : 'rgba(220,170,40,0.18)',
                        color:      h.sensitivityTier === 'sensitive' ? '#e88' : '#dca',
                        fontSize: 10,
                      }}
                    >
                      {h.sensitivityTier}
                    </span>
                  )}
                  <span>{score}</span>
                </div>
                <div style={{ lineHeight: 1.4 }}>{_snip(h.text, 280)}</div>
              </div>
            </div>
          );
        })}
      </div>

      {hits && hits.length > 0 && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', borderTop: '1px solid var(--border, #2a2a2a)', paddingTop: 8 }}>
          <span style={{ fontSize: 11, color: 'var(--fg-mute, #888)', flex: 1 }}>
            {picked.size} of {hits.length} selected
          </span>
          <button className="prefs-btn" onClick={onClose} style={{ fontSize: 12 }}>Cancel</button>
          <button
            className="prefs-btn"
            onClick={attachSelected}
            disabled={picked.size === 0}
            style={{ fontSize: 12, fontWeight: 600 }}
          >
            Attach {picked.size > 0 ? `(${picked.size})` : ''}
          </button>
        </div>
      )}
    </div>
  );
}

// ── Mount ────────────────────────────────────────────────────────────────────

export function QuickRagPicker() {
  const [open,   setOpen]   = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  useEffect(() => {
    function onBtnClick(e: Event) {
      const b = e.currentTarget as HTMLElement;
      setAnchor(b.getBoundingClientRect());
      setOpen((o) => !o);
      e.stopPropagation();
    }
    function wire() {
      const el = document.getElementById('chat-rag-btn');
      if (el) (el as HTMLButtonElement).onclick = onBtnClick;
    }
    wire();
    const obs = new MutationObserver(wire);
    obs.observe(document.body, { childList: true, subtree: true });
    return () => {
      obs.disconnect();
      const el = document.getElementById('chat-rag-btn');
      if (el) (el as HTMLButtonElement).onclick = null;
    };
  }, []);

  if (!open) return null;
  return createPortal(
    <PanelContent anchor={anchor} onClose={() => setOpen(false)} />,
    document.body,
  );
}
