// HubContextSessionPicker — "By context" view of the Context-Hub picker.
// New on 2026-05-06 per the user's "rethink the Sorter" brief:
//
//   ich dachte mehr an verlinkung untereinander -> quasi der context button
//   als sessionpicker nicht nach chronologie sondern nach context .. und die
//   stellt der sorter her hätte ich gedacht -> ein click im context picker
//   wechselt session -> im context picker statt normal click of item noch
//   nen button anbieten "post context" der dann den gesamten context
//   postet in die textarea input der chat input area
//
// What it does
// ────────────
//   • Renders sessions GROUPED BY CATEGORY (sorter-derived) instead of
//     chronologically. Each category is an accordion section with the
//     12-emoji + count badge.
//   • Click on a row → switches the active chat session (calls
//     `session.switchTo(sid)`).
//   • A separate "📋 Post context" button on each row → fetches the full
//     transcript via /v1/context/session-content and pastes it into the
//     chat input (same channel the existing context picker uses).
//   • Each row also lists the top related sids (computed by the sorter from
//     category + tag overlap) — clicking a related sid jumps directly to
//     that session.
//
// Notes integration (2026-05-07 — unified shells brief)
// ─────────────────────────────────────────────────────
// In addition to sessions, this component now also surfaces inline `#note`
// hits and note-tagged sessions/files in a synthetic 📝 Notes category,
// fetched from /v1/context/items?cat=notes. Note rows behave like session
// rows but with two click-flow differences:
//   • Click on the title → switches to the parent session AND scrolls the
//     exact note message into view (uses the same `setScrollIntent` channel
//     NotePanel/QuickContextPicker had wired up in Phase 1.10).
//   • "Post context" → pastes the note body (the 240-char teaser the
//     /v1/context/items endpoint already ships) as a `> **Note**` block
//     into the chat input.
// This keeps the QuickContextPicker (input-bar popover, default-open on the
// Notes section) and the Hub modal "By context" view a single visual
// component — see request "beide ident, nur input startet auf notes".
//
// Why server-side data?
// ─────────────────────
// The sorter already iterates every session to produce the wiki vault, so
// we recycle that pass to also write `bridge/context-graph.json`. The
// /v1/context/graph endpoint reads that file (or falls back to a live
// rebuild for fresh installs). The frontend never has to recompute the
// graph from raw session JSON — keeps the wire-payload small and the
// browser snappy.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { bus } from '../state.js';
import { session } from '../session.js';
import { fileEditor } from '../modals/file-editor.js';
import { setScrollIntent } from '../util/scrollIntent.js';
import { useContextStore } from './contextStore.js';
import { consume } from './usePendingConfirms.js';

// ── Types — mirror the bridge's context-graph.json shape ────────────────────

interface SessionStub {
  sid:          string;
  title:        string;
  category:     string;
  tags:         string[];
  /** Phase 4.3 — semantic search terms emitted by the categorizer. Used both
   *  for client-side filter matches and for the relevance-overlap that
   *  Phase 4.4 ranks categories by. Empty for legacy sessions. */
  keywords?:    string[];
  /** Phase 4.1/4.2 — file items have soft-categories (LLM-derived overlap
   *  with the 12-cat slug list); used to surface keep-notes under their
   *  themed categories in addition to the locked `keep-notes` primary. */
  topics?:      string[];
  sensitivity:  'public' | 'private' | 'system';
  updatedAt:    number;
  messageCount: number;
  // Note-row extension (added 2026-05-07). When `kind === 'note'` the row is
  // rendered as a note teaser and the click handler uses setScrollIntent to
  // jump to the exact message in the parent session.
  kind?:        'session' | 'note' | 'file';
  msgIdx?:      number;
  sessionName?: string;        // parent session label, shown beneath the title
  snippet?:     string;        // 240-char teaser for note/file rows
  itemId?:      string;        // `note:<sid>:<msgIdx>` or `file:<base64>` — used by the whitelist
  /** Phase 4.5 — absolute path of a `kind:'file'` item, opened via
   *  fileEditor.open() instead of session.switchTo(). */
  path?:        string;
}

interface ContextGraph {
  generatedAt:   number;
  totalSessions: number;
  fromCache?:    boolean;
  categories:    Record<string, { count: number; sessions: SessionStub[] }>;
  tags:          Record<string, SessionStub[]>;
  sessions:      Record<string, { related: string[] }>;
}

const CATEGORY_EMOJI: Record<string, string> = {
  notes:          '📝',
  'keep-notes':   '🗒️',
  architecture:   '🏗️',
  frontend:       '🖥️',
  backend:        '⚙️',
  'ai-models':    '🤖',
  debugging:      '🔧',
  integrations:   '🔌',
  workflows:      '📋',
  data:           '📁',
  devops:         '🚀',
  documentation:  '📝',
  experiments:    '🧪',
  general:        '💬',
  // Phase 4.1 free-form themes
  psychology:     '🧠',
  religion:       '🕊️',
  erotic:         '🍑',
  family:         '👪',
  health:         '🩺',
  finance:        '💰',
  travel:         '✈️',
  cooking:        '🍳',
  shopping:       '🛒',
  media:          '🎬',
};

function _baseUrl(): string {
  return (api.config as { baseUrl?: string })?.baseUrl || '';
}

function _sensIcon(t: string): string {
  if (t === 'system')  return '⚙️🔒';
  if (t === 'private') return '🔒';
  return '';
}

// Mirror SessionPicker's lazy-load chunk size so the two pickers feel uniform.
const LAZY_PAGE = 50;

// Per-section IntersectionObserver sentinel. Lives inside an open accordion
// section; when it scrolls into view we ask the parent to grow that section's
// visible window by another LAZY_PAGE rows. One observer per sentinel keeps
// the wiring local — mount/unmount automatically tracks open/close.
function LazyCatSentinel(props: { cat: string; onIntersect: (cat: string) => void }) {
  const { cat, onIntersect } = props;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry?.isIntersecting) onIntersect(cat); },
      { threshold: 0 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [cat, onIntersect]);
  return <div ref={ref} aria-hidden style={{ height: 1 }} />;
}

// ── Component ───────────────────────────────────────────────────────────────

export function HubContextSessionPicker(props: {
  /** Optional close handler — called after the user picks "switch session"
   *  so the modal can dismiss itself. The caller may pass () => {} to
   *  keep the modal open after a switch. */
  onPicked?: () => void;
  /** If set, these category slugs start expanded instead of the default
   *  "top-3 by count" heuristic. Used by the input-bar QuickContextPicker
   *  to default-open the 📝 Notes section. */
  defaultOpenCategories?: ReadonlyArray<string>;
}) {
  const showAllTiers = useContextStore((s) => s.showAllTiers);
  const setShowAllTiers = useContextStore((s) => s.setShowAllTiers);

  const [graph, setGraph]     = useState<ContextGraph | null>(null);
  // Notes are not part of the sorter graph (they're inline messages, not
  // sessions). We fetch them from /v1/context/items?cat=notes and synthesize
  // a 📝 Notes accordion section client-side.
  const [notes, setNotes]     = useState<SessionStub[]>([]);
  // Phase 4.1/4.5 — keep-notes are file items the file-categorizer attached
  // category/topics/tags/keywords to. Fetched once and threaded into both
  // the locked 🗒️ Keep Notes section AND each topic-category they overlap.
  const [keepNotes, setKeepNotes] = useState<SessionStub[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);
  const [openCats, setOpenCats] = useState<Record<string, boolean>>({});
  // Per-category lazy-render window. Same pattern as SessionPicker: each open
  // section starts at LAZY_PAGE rows and grows by LAZY_PAGE when the sentinel
  // at its bottom scrolls into view. Independent per cat so opening "📝 Notes"
  // doesn't reset the scroll progress in "🧠 psychology".
  const [visiblePerCat, setVisiblePerCat] = useState<Record<string, number>>({});
  const bumpCat = useCallback((cat: string) => {
    setVisiblePerCat((m) => ({ ...m, [cat]: (m[cat] ?? LAZY_PAGE) + LAZY_PAGE }));
  }, []);
  const [busy, setBusy]       = useState<string | null>(null);   // row currently being posted (sid or note-id)
  const [filter, setFilter]   = useState('');
  // Phase 4.4 — current session id, used to compute relevance overlap so we
  // can split categories into "▸ Relevant" + "▸ All".
  const [currentSid, setCurrentSid] = useState<string>(() => {
    try { return String(session.getCurrentId() || ''); } catch { return ''; }
  });
  useEffect(() => {
    // Refresh on session-switch so the relevance ranking follows the user.
    function onSwitch() {
      try { setCurrentSid(String(session.getCurrentId() || '')); } catch { /* noop */ }
    }
    window.addEventListener('yha:session:switched', onSwitch as EventListener);
    return () => window.removeEventListener('yha:session:switched', onSwitch as EventListener);
  }, []);

  async function loadGraph(opts?: { fresh?: boolean }) {
    const url = _baseUrl();
    if (!url) return;
    setLoading(true);
    setError(null);
    try {
      // Fetch graph + notes + keep-notes in parallel — they're independent.
      const tier = showAllTiers ? 'public,private,system' : 'public';
      const [graphR, notesR, keepR] = await Promise.all([
        fetch(`${url}/v1/context/graph${opts?.fresh ? '?fresh=1' : ''}`),
        fetch(`${url}/v1/context/items?cat=notes&tier=${encodeURIComponent(tier)}&limit=200`),
        fetch(`${url}/v1/context/items?cat=keep-notes&tier=${encodeURIComponent(tier)}&limit=500`),
      ]);
      const graphJ = await graphR.json();
      if (!graphJ?.success) throw new Error(graphJ?.error || `HTTP ${graphR.status}`);
      const nextGraph = graphJ.graph as ContextGraph;
      setGraph(nextGraph);

      // Convert /v1/context/items note rows into SessionStub-shaped rows so
      // the accordion renderer can treat them uniformly.
      const noteRows: SessionStub[] = [];
      try {
        if (notesR.ok) {
          const notesJ = await notesR.json();
          for (const it of (notesJ?.items || []) as Array<Record<string, unknown>>) {
            if (it.kind === 'note') {
              noteRows.push({
                kind:         'note',
                sid:          String(it.sid || ''),
                msgIdx:       Number(it.msgIdx) || 0,
                sessionName:  String(it.sessionName || ''),
                title:        String(it.title || '(untitled note)'),
                category:     'notes',
                tags:         Array.isArray(it.tags) ? (it.tags as string[]) : [],
                sensitivity:  (it.sensitivity as SessionStub['sensitivity']) || 'public',
                updatedAt:    Number(it.updatedAt) || 0,
                messageCount: 0,
                snippet:      String(it.snippet || ''),
                itemId:       String(it.id || ''),
              });
            }
          }
        }
      } catch { /* notes are optional — graph alone is fine */ }
      setNotes(noteRows);

      // Phase 4.1 — keep-notes file items. Each item already carries the
      // categorizer's frontmatter fields (category, topics, tags, keywords)
      // exposed by the bridge route via the new `_readFileFrontmatterFields`
      // helper. We map them to `SessionStub`-shaped rows with `kind:'file'`.
      const fileRows: SessionStub[] = [];
      try {
        if (keepR.ok) {
          const keepJ = await keepR.json();
          for (const it of (keepJ?.items || []) as Array<Record<string, unknown>>) {
            if (it.kind !== 'file') continue;
            fileRows.push({
              kind:         'file',
              sid:          '',                                  // file items don't have a session id
              title:        String(it.title || '(untitled)'),
              category:     String(it.category || 'keep-notes'),
              tags:         Array.isArray(it.tags)     ? (it.tags     as string[]) : [],
              keywords:     Array.isArray(it.keywords) ? (it.keywords as string[]) : [],
              topics:       Array.isArray(it.topics)   ? (it.topics   as string[]) : [],
              sensitivity:  (it.sensitivity as SessionStub['sensitivity']) || 'public',
              updatedAt:    Number(it.updatedAt) || 0,
              messageCount: 0,
              snippet:      String(it.snippet || ''),
              itemId:       String(it.id || ''),
              path:         String(it.path || ''),
            });
          }
        }
      } catch { /* keep-notes optional */ }
      setKeepNotes(fileRows);

      // Open the user-requested defaults (e.g. 📝 Notes for the popover) if
      // they have any rows; otherwise fall back to the top-3-by-count heuristic
      // so the modal Hub still surfaces content immediately.
      const open: Record<string, boolean> = {};
      const requested = props.defaultOpenCategories || [];
      let opened = 0;
      for (const slug of requested) {
        // "notes" gets opened if EITHER the graph has a 'notes' bucket
        // (sessions tagged notes) OR we synthesized note rows above.
        if (slug === 'notes' && (noteRows.length > 0 || nextGraph.categories?.notes)) {
          open[slug] = true; opened++;
        } else if (nextGraph.categories?.[slug]) {
          open[slug] = true; opened++;
        }
      }
      if (opened === 0) {
        const sorted = Object.entries(nextGraph.categories)
          .sort((a, b) => b[1].count - a[1].count)
          .slice(0, 3)
          .map(([k]) => k);
        for (const k of sorted) open[k] = true;
      }
      setOpenCats(open);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadGraph();
    // SSE: refresh when the sorter writes a new graph.
    const onWiki = () => { void loadGraph(); };
    window.addEventListener('yha:context:wiki-updated', onWiki as EventListener);
    return () => window.removeEventListener('yha:context:wiki-updated', onWiki as EventListener);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // When the tier toggle flips we have to re-pull notes (the items endpoint
  // gates them server-side). Graph is unaffected — sessions there always
  // include all tiers and we filter client-side.
  useEffect(() => {
    void loadGraph();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showAllTiers]);

  // Reset per-category visible windows whenever the row set changes shape —
  // a new filter or tier toggle resorts/refilters every bucket, so the old
  // counts no longer line up with the rows underneath them.
  useEffect(() => { setVisiblePerCat({}); }, [filter, showAllTiers]);

  // Build a flat "all sessions" map for related-sid lookups (the graph
  // lists relations as sids, but we want titles in the UI without an
  // extra round-trip).
  const titleMap: Record<string, SessionStub> = useMemo(() => {
    if (!graph) return {};
    const m: Record<string, SessionStub> = {};
    for (const cat of Object.values(graph.categories)) {
      for (const s of cat.sessions) m[s.sid] = s;
    }
    return m;
  }, [graph]);

  function _handleSwitch(stub: SessionStub) {
    void (async () => {
      try {
        // Phase 4.5 — file items open in the MarkdownEditor modal instead of
        // switching the chat session. Reuses the same `fileEditor.open()`
        // bridge the FilePicker uses, so the user gets a consistent editor
        // experience whether they reach the file via the file tree or the
        // context picker.
        if (stub.kind === 'file' && stub.path) {
          if (stub.itemId) consume(stub.itemId);
          fileEditor.open?.(stub.path, stub.title);
          if (props.onPicked) props.onPicked();
          return;
        }
        // Notes use the same scrollIntent channel NotePanel/QuickContextPicker
        // wired up — switching the session, then auto-scrolling to the exact
        // note message and flashing it.
        if (stub.kind === 'note' && typeof stub.msgIdx === 'number') {
          if (stub.itemId) consume(stub.itemId);
          setScrollIntent({
            sessionId:  stub.sid,
            msgIdx:     stub.msgIdx,
            flashClass: 'note-flash',
          });
        }
        await session.switchTo(stub.sid);
        if (props.onPicked) props.onPicked();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
  }

  async function _handlePostContext(stub: SessionStub) {
    const url = _baseUrl();
    if (!url) return;
    const busyKey =
      stub.kind === 'note' ? (stub.itemId || `${stub.sid}:${stub.msgIdx}`) :
      stub.kind === 'file' ? (stub.itemId || stub.path || stub.title) :
      stub.sid;
    setBusy(busyKey);
    try {
      // ── File row — paste the full body via /v1/context/file. Sensitive
      //    files require an active whitelist entry (handled the same way the
      //    inline note flow does); we surface a 403 as an inline error so
      //    the user knows to confirm via the gate first.
      if (stub.kind === 'file' && stub.path) {
        const r = await fetch(`${url}/v1/context/file?path=${encodeURIComponent(stub.path)}`);
        if (r.status === 403) {
          const j = await r.json();
          setError(`Note is ${j.tier ?? 'sensitive'} — confirm in the gate first.`);
          return;
        }
        const j = await r.json();
        if (!j?.success) throw new Error(j?.error || `HTTP ${r.status}`);
        // Strip frontmatter so the chat-input gets the readable body only.
        const body = String(j.content || '').replace(/^---[\s\S]*?---\s*/, '').trim();
        const tagLine = stub.tags.length ? ` · #${stub.tags.join(' #')}` : '';
        const block = [
          `> **Note** — ${stub.title}`,
          `> _${stub.path.split('/').slice(-2).join('/')}_${stub.category ? ` · ${stub.category}` : ''}${tagLine}`,
          '',
          body || '_(empty file)_',
          '',
        ].join('\n');
        const ta =
          document.querySelector<HTMLTextAreaElement>('#chat-ta[data-react-owned="1"]') ??
          document.querySelector<HTMLTextAreaElement>('#chat-ta') ??
          document.querySelector<HTMLTextAreaElement>('#chat-ta-legacy');
        const existing = ta?.value || '';
        const next = existing.trim() ? `${block}\n${existing}` : block;
        bus.emit('chat:set-input', next);
        if (stub.itemId) consume(stub.itemId);
        return;
      }
      // ── Note row — paste the note teaser as a `> **Note**` block. The
      //    /v1/context/items endpoint already shipped us the (240-char)
      //    snippet, so no extra round-trip is needed.
      if (stub.kind === 'note') {
        const tagLine = stub.tags.length ? ` · #${stub.tags.join(' #')}` : '';
        const body = (stub.snippet || '').trim() || '_(empty note)_';
        const block = [
          `> **Note** — ${stub.title}`,
          `> _note:${stub.sid}:${stub.msgIdx}_${stub.sessionName ? ` · from ${stub.sessionName}` : ''}${tagLine}`,
          '',
          body,
          '',
        ].join('\n');
        const ta =
          document.querySelector<HTMLTextAreaElement>('#chat-ta[data-react-owned="1"]') ??
          document.querySelector<HTMLTextAreaElement>('#chat-ta') ??
          document.querySelector<HTMLTextAreaElement>('#chat-ta-legacy');
        const existing = ta?.value || '';
        const next = existing.trim() ? `${block}\n${existing}` : block;
        bus.emit('chat:set-input', next);
        if (stub.itemId) consume(stub.itemId);
        return;
      }
      // ── Session row — assemble transcript via /v1/context/session-content.
      const r = await fetch(`${url}/v1/context/session-content?sid=${encodeURIComponent(stub.sid)}`);
      if (r.status === 403) {
        const j = await r.json();
        setError(`Session is ${j.tier ?? 'sensitive'} — confirm in the gate first.`);
        return;
      }
      const j = await r.json();
      if (!j?.success) throw new Error(j?.error || `HTTP ${r.status}`);
      const tags = (j.tags || []) as string[];
      const tagLine = tags.length ? ` · #${tags.join(' #')}` : '';
      const block = [
        `> **Context** — ${j.title}`,
        `> _session:${stub.sid}_${j.category ? ` · ${j.category}` : ''}${tagLine}`,
        '',
        j.transcript || '_(empty transcript)_',
        j.truncated ? '\n_…transcript truncated_' : '',
        '',
      ].filter(Boolean).join('\n');

      const ta =
        document.querySelector<HTMLTextAreaElement>('#chat-ta[data-react-owned="1"]') ??
        document.querySelector<HTMLTextAreaElement>('#chat-ta') ??
        document.querySelector<HTMLTextAreaElement>('#chat-ta-legacy');
      const existing = ta?.value || '';
      const next = existing.trim() ? `${block}\n${existing}` : block;
      bus.emit('chat:set-input', next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }

  // Phase 4.4 — current-session signature for relevance scoring. Lookup the
  // active session in the graph (it knows about title/category/tags/keywords)
  // and build a Set of "things that count as relevance overlap". Cheap;
  // recomputes only when graph or currentSid changes.
  const currentSig = useMemo(() => {
    if (!graph || !currentSid) return null;
    const stub = graph.sessions[currentSid] ? null : null; // graph.sessions only holds related[]
    // Walk every category to find the actual stub for currentSid.
    let found: SessionStub | null = null;
    for (const info of Object.values(graph.categories)) {
      const m = info.sessions.find((s) => s.sid === currentSid);
      if (m) { found = m; break; }
    }
    if (!found) return null;
    void stub; // silence unused — kept for future graph-shape extensions
    const tokens = new Set<string>();
    for (const t of found.tags) tokens.add(`tag:${t}`);
    for (const k of (found.keywords || [])) tokens.add(`kw:${k}`);
    return { category: found.category, tokens };
  }, [graph, currentSid]);

  function _scoreCat(cat: string, rows: ReadonlyArray<SessionStub>): number {
    if (!currentSig) return 0;
    let score = 0;
    if (cat === currentSig.category) score += 5;        // exact category match
    for (const r of rows) {
      if (r.sid && r.sid === currentSid) continue;       // self
      for (const t of r.tags)                if (currentSig.tokens.has(`tag:${t}`)) score++;
      for (const k of (r.keywords || []))    if (currentSig.tokens.has(`kw:${k}`))  score++;
      for (const tp of (r.topics || []))     if (tp === currentSig.category)        score++;
    }
    return score;
  }

  const { relevantCats, restCats } = useMemo(() => {
    const empty = { relevantCats: [] as Array<[string, { count: number; sessions: SessionStub[]; relevance: number }]>,
                    restCats:     [] as Array<[string, { count: number; sessions: SessionStub[]; relevance: number }]> };
    if (!graph) return empty;
    const q = filter.trim().toLowerCase();
    const tierOk = (t: string) => showAllTiers || t === 'public';

    // Build a working copy of the categories map so we can splice notes into
    // it without mutating graph state. Notes append into (or create) the
    // 'notes' bucket so the section ordering stays stable across reloads.
    const merged: Record<string, { count: number; sessions: SessionStub[] }> = {};
    for (const [cat, info] of Object.entries(graph.categories)) {
      merged[cat] = { count: info.count, sessions: [...info.sessions] };
    }
    if (notes.length > 0) {
      const bucket = merged['notes'] || { count: 0, sessions: [] };
      bucket.sessions = [...bucket.sessions, ...notes];
      bucket.count    = bucket.sessions.length;
      merged['notes'] = bucket;
    }
    // Phase 4.1/4.5 — splice keep-notes into both their primary `keep-notes`
    // bucket AND each of their soft-category `topics` so a psychology note
    // shows up under 🧠 psychology in addition to 🗒️ keep-notes.
    if (keepNotes.length > 0) {
      const primary = merged['keep-notes'] || { count: 0, sessions: [] };
      primary.sessions = [...primary.sessions, ...keepNotes];
      primary.count    = primary.sessions.length;
      merged['keep-notes'] = primary;
      for (const f of keepNotes) {
        for (const topic of (f.topics || [])) {
          if (!topic || topic === 'keep-notes') continue;
          const bucket = merged[topic] || { count: 0, sessions: [] };
          bucket.sessions = [...bucket.sessions, f];
          bucket.count    = bucket.sessions.length;
          merged[topic]   = bucket;
        }
      }
    }

    const all: Array<[string, { count: number; sessions: SessionStub[]; relevance: number }]> = [];
    for (const [cat, info] of Object.entries(merged)) {
      const sessions = info.sessions.filter((s) => {
        if (!tierOk(s.sensitivity)) return false;
        if (!q) return true;
        return (
          s.title.toLowerCase().includes(q) ||
          s.tags.some((t) => t.toLowerCase().includes(q)) ||
          (s.keywords || []).some((k) => k.toLowerCase().includes(q)) ||
          (s.topics || []).some((t) => t.toLowerCase().includes(q)) ||
          (s.snippet ? s.snippet.toLowerCase().includes(q) : false) ||
          (s.sessionName ? s.sessionName.toLowerCase().includes(q) : false)
        );
      });
      if (sessions.length === 0 && q) continue;
      const relevance = _scoreCat(cat, sessions);
      all.push([cat, { count: sessions.length, sessions, relevance }]);
    }
    // Two buckets: relevant (score > 0, ranked by score) + rest (ranked by count).
    // The current session's own category counts as "relevant" via the +5 bonus.
    const relevantCats = all.filter(([, v]) => v.relevance > 0).sort((a, b) => b[1].relevance - a[1].relevance);
    const restCats     = all.filter(([, v]) => v.relevance === 0).sort((a, b) => b[1].count - a[1].count);
    return { relevantCats, restCats };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [graph, notes, keepNotes, filter, showAllTiers, currentSig, currentSid]);

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <input
          className="ss-search"
          type="search"
          placeholder="Filter by title or tag…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ flex: 1 }}
        />
        <button
          type="button"
          onClick={() => void loadGraph({ fresh: true })}
          className="prefs-btn"
          style={{ padding: '4px 10px', fontSize: '11.5px' }}
          disabled={loading}
          title="Rebuild the graph from in-memory sessions (bypass cache)."
        >
          {loading ? '…' : '↻'} Refresh
        </button>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, fontSize: '11.5px', color: 'var(--fg-mute, #888)' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer' }}>
          <input type="checkbox" checked={showAllTiers} onChange={(e) => setShowAllTiers(e.target.checked)} />
          Show 🔒 / ⚙️🔒
        </label>
        <span style={{ marginLeft: 'auto' }}>
          {graph
            ? `${graph.totalSessions} session${graph.totalSessions === 1 ? '' : 's'}${graph.fromCache ? ' · cached' : ' · live'}`
            : '—'}
        </span>
      </div>

      {error && (
        <div style={{
          padding: '6px 10px', border: '1px solid #844', borderRadius: 4,
          background: 'rgba(180,60,60,0.12)', color: '#e88', fontSize: '12px',
        }}>{error}</div>
      )}

      {graph === null && !loading && (
        <div style={{ fontSize: '12px', color: 'var(--fg-mute, #888)' }}>
          No graph yet. The sorter builds it once the categorizer has classified some sessions.
          Use the Generator tab "Run now" buttons to kick the pipeline.
        </div>
      )}

      <div
        style={{
          flex:        1,
          minHeight:   240,
          maxHeight:   '52vh',
          overflowY:   'auto',
          border:      '1px solid var(--border, #2a2a2a)',
          borderRadius: 6,
          padding:     6,
          display:     'flex',
          flexDirection: 'column',
          gap:         6,
        }}
      >
        {/* Phase 4.4 — "Relevant to this session" group sits above the rest
            when the user has a current session AND at least one category
            scored above zero. Header is an unobtrusive divider — the row
            renderer below is shared with the rest section. */}
        {currentSig && relevantCats.length > 0 && (
          <div style={{
            fontSize: '11px', color: 'var(--fg-mute, #888)',
            padding: '4px 6px', borderBottom: '1px dashed var(--border, #2a2a2a)',
          }}>
            ▸ Relevant zur aktuellen Session ({relevantCats.length})
          </div>
        )}
        {[...relevantCats, ...(currentSig && relevantCats.length > 0 ? [['__divider__', null] as const] : []), ...restCats].map((entry) => {
          // Sentinel divider row between the two groups.
          if (entry[0] === '__divider__') {
            return (
              <div key="__divider__" style={{
                fontSize: '11px', color: 'var(--fg-mute, #888)',
                padding: '8px 6px 4px', borderBottom: '1px dashed var(--border, #2a2a2a)',
                marginTop: 4,
              }}>
                ▸ All categories ({restCats.length})
              </div>
            );
          }
          const [cat, info] = entry as [string, { count: number; sessions: SessionStub[]; relevance: number }];
          const open = !!openCats[cat];
          return (
            <section key={cat} style={{ border: '1px solid var(--border, #222)', borderRadius: 4 }}>
              <button
                type="button"
                onClick={() => setOpenCats((m) => ({ ...m, [cat]: !open }))}
                style={{
                  width: '100%', textAlign: 'left',
                  padding: '8px 10px',
                  background: open ? 'var(--bg-soft, #1f1f1f)' : 'transparent',
                  border: 'none', cursor: 'pointer',
                  display: 'flex', alignItems: 'center', gap: 8,
                  color: 'var(--fg, #ccc)', fontSize: '13px',
                }}
              >
                <span style={{ width: 14 }}>{open ? '▾' : '▸'}</span>
                <span>{CATEGORY_EMOJI[cat] || '•'}</span>
                <strong style={{ flex: 1 }}>{cat}</strong>
                <span style={{ fontSize: '11.5px', color: 'var(--fg-mute, #888)' }}>
                  {info.count} item{info.count === 1 ? '' : 's'}
                  {currentSig && info.relevance > 0 && (
                    <span style={{ marginLeft: 6, color: 'var(--fg-mute, #6aa)' }}>· ★{info.relevance}</span>
                  )}
                </span>
              </button>
              {open && (() => {
                const cap     = visiblePerCat[cat] ?? LAZY_PAGE;
                const visible = info.sessions.slice(0, cap);
                const hasMore = info.sessions.length > cap;
                return (
                <div style={{ display: 'flex', flexDirection: 'column' }}>
                  {visible.map((s, idx) => {
                    const isNote = s.kind === 'note';
                    const isFile = s.kind === 'file';
                    const rowKey =
                      isNote ? (s.itemId || `${s.sid}:${s.msgIdx}:${idx}`) :
                      isFile ? (s.itemId || s.path || `${s.title}:${idx}`) :
                      s.sid;
                    const busyKey =
                      isNote ? (s.itemId || `${s.sid}:${s.msgIdx}`) :
                      isFile ? (s.itemId || s.path || s.title) :
                      s.sid;
                    const related = (isNote || isFile)
                      ? []
                      : (graph!.sessions[s.sid]?.related || []).slice(0, 4);
                    const isBusy = busy === busyKey;
                    const switchTitle =
                      isNote ? 'Switch to source session and scroll to this note' :
                      isFile ? 'Open this note in the markdown editor' :
                      'Switch to this session';
                    const postTitle =
                      isNote ? 'Paste this note into the chat input.' :
                      isFile ? "Paste this note's content into the chat input." :
                      "Paste this session's transcript into the chat input.";
                    const postLabel =
                      isNote ? '📝 Post note' :
                      isFile ? '🗒️ Post note' :
                      '📋 Post context';
                    return (
                      <div
                        key={rowKey}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 8,
                          padding: '6px 10px',
                          borderTop: '1px solid var(--border, #1a1a1a)',
                          fontSize: '12.5px',
                        }}
                      >
                        <button
                          type="button"
                          onClick={() => _handleSwitch(s)}
                          title={switchTitle}
                          style={{
                            flex: 1, textAlign: 'left',
                            background: 'transparent', border: 'none', color: 'var(--fg, #ccc)',
                            cursor: 'pointer', padding: 0,
                            display: 'flex', flexDirection: 'column', gap: 2,
                          }}
                        >
                          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            {isNote && <span aria-hidden style={{ fontSize: '11px' }}>📝</span>}
                            {isFile && <span aria-hidden style={{ fontSize: '11px' }}>🗒️</span>}
                            <strong>{s.title}</strong>
                            {_sensIcon(s.sensitivity) && (
                              <span style={{ fontSize: '11px' }}>{_sensIcon(s.sensitivity)}</span>
                            )}
                            {!isNote && !isFile && (
                              <span style={{ fontSize: '10.5px', color: 'var(--fg-mute, #777)' }}>
                                · {s.messageCount} msg
                              </span>
                            )}
                          </span>
                          {isNote && s.snippet && (
                            <span
                              style={{
                                fontSize: '11px',
                                color:    'var(--fg-mute, #aaa)',
                                display:  '-webkit-box',
                                WebkitBoxOrient: 'vertical',
                                WebkitLineClamp: 2,
                                overflow: 'hidden',
                              }}
                            >
                              {s.snippet}
                            </span>
                          )}
                          {isNote && s.sessionName && (
                            <span style={{ fontSize: '10.5px', color: 'var(--fg-mute, #777)' }}>
                              <span aria-hidden style={{ marginRight: 4 }}>↳</span>
                              {s.sessionName}
                            </span>
                          )}
                          {isFile && s.snippet && (
                            <span
                              style={{
                                fontSize: '11px',
                                color:    'var(--fg-mute, #aaa)',
                                display:  '-webkit-box',
                                WebkitBoxOrient: 'vertical',
                                WebkitLineClamp: 2,
                                overflow: 'hidden',
                              }}
                            >
                              {s.snippet}
                            </span>
                          )}
                          {isFile && (s.tags.length > 0 || (s.topics?.length || 0) > 0) && (
                            <span style={{ fontSize: '10.5px', color: 'var(--fg-mute, #777)' }}>
                              {s.tags.length > 0 && <>#{s.tags.join(' #')}</>}
                              {(s.topics?.length || 0) > 0 && (
                                <> · topics: {(s.topics || []).slice(0, 3).join(' · ')}</>
                              )}
                            </span>
                          )}
                          {!isNote && !isFile && (s.tags.length > 0 || related.length > 0) && (
                            <span style={{ fontSize: '10.5px', color: 'var(--fg-mute, #777)' }}>
                              {s.tags.length > 0 && (
                                <>#{s.tags.join(' #')}</>
                              )}
                              {related.length > 0 && (
                                <> · related: {related.map((rsid) => titleMap[rsid]?.title || rsid).slice(0, 3).join(' · ')}</>
                              )}
                            </span>
                          )}
                        </button>
                        <button
                          type="button"
                          className="prefs-btn"
                          style={{ padding: '3px 8px', fontSize: '11px' }}
                          onClick={() => void _handlePostContext(s)}
                          disabled={isBusy}
                          title={postTitle}
                        >
                          {isBusy ? '…' : postLabel}
                        </button>
                      </div>
                    );
                  })}
                  {hasMore && (
                    <LazyCatSentinel cat={cat} onIntersect={bumpCat} />
                  )}
                </div>
                );
              })()}
            </section>
          );
        })}
      </div>

      <div style={{ fontSize: '11px', color: 'var(--fg-mute, #888)' }}>
        Click the title to switch session. "📋 Post context" pastes the transcript into the chat input.
      </div>
    </div>
  );
}
