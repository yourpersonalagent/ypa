// NotePanel — popover listing all #note messages across sessions.
// Filterable like SessionPicker. Click jumps to the source session and
// scrolls the message into view.
//
// Notes are streamed from the backend (`GET /v1/sessions/notes?q=...`) instead
// of being scanned client-side. The session-list payload no longer includes
// message bodies, so an in-store scan would always return zero hits.

import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { setScrollIntent } from './util/scrollIntent.js';
import { session } from './session.js';
import { api } from './api.js';

interface NoteHit {
  text: string;
  ts: number;
  mid: number | undefined;
  sessionId: string;
  sessionName: string;
  msgIdx: number;
}

function formatWhen(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const yest = new Date(now);
  yest.setDate(now.getDate() - 1);
  if (d.toDateString() === yest.toDateString())
    return 'Yesterday ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

interface PanelProps {
  onClose: () => void;
  anchor: DOMRect | null;
}

function PanelContent({ onClose, anchor }: PanelProps) {
  const [query, setQuery] = useState('');
  const [notes, setNotes] = useState<NoteHit[]>([]);
  const [loading, setLoading] = useState(true);
  const overlayRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (overlayRef.current && !overlayRef.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', onMouseDown, true);
    return () => document.removeEventListener('mousedown', onMouseDown, true);
  }, [onClose]);

  // Server-side note fetch — debounced 250ms, mirroring SessionPicker's search.
  // Empty query returns all notes; backend filters by text and session name.
  const fetchAc = useRef<AbortController | null>(null);
  const doFetch = useCallback((q: string) => {
    fetchAc.current?.abort();
    const ac = new AbortController();
    fetchAc.current = ac;
    setLoading(true);
    const base = (api.config as { baseUrl?: string }).baseUrl || window.location.origin;
    const url = `${base}/v1/sessions/notes${q ? `?q=${encodeURIComponent(q)}` : ''}`;
    fetch(url, { signal: ac.signal })
      .then((r) => r.json())
      .then((d) => {
        if (ac.signal.aborted) return;
        setNotes(Array.isArray(d.notes) ? (d.notes as NoteHit[]) : []);
        setLoading(false);
      })
      .catch(() => {
        if (!ac.signal.aborted) setLoading(false);
      });
  }, []);

  // Initial load — fire immediately when the panel opens.
  useEffect(() => {
    doFetch('');
    return () => fetchAc.current?.abort();
  }, [doFetch]);

  // Re-fetch on query change with a 250ms debounce. Skip the very first call —
  // the initial-load effect above already fired with q=''.
  const firstQueryRender = useRef(true);
  useEffect(() => {
    if (firstQueryRender.current) {
      firstQueryRender.current = false;
      return;
    }
    const timer = setTimeout(() => doFetch(query), 250);
    return () => { clearTimeout(timer); };
  }, [query, doFetch]);

  const filtered = notes;

  async function jumpTo(hit: NoteHit) {
    onClose();
    if (!session?.switchTo) return;
    // Tell MessageList to skip its stick-to-bottom for this switch and
    // jump to this specific message instead. Set BEFORE switchTo so the
    // intent is in place when the watcher effect fires on currentId change.
    // Keyed by sessionId so back-to-back clicks don't overwrite each other.
    setScrollIntent({
      sessionId: hit.sessionId,
      msgIdx: hit.msgIdx,
      flashClass: 'note-flash',
    });
    await session.switchTo(hit.sessionId);
  }

  const width = 360;
  const margin = 8;
  const vw = window.innerWidth;
  const style: React.CSSProperties = anchor
    ? {
        position: 'fixed',
        bottom: window.innerHeight - anchor.top + 6,
        left: Math.max(margin, Math.min(vw - width - margin, anchor.left)),
      }
    : {};

  return (
    <div className="popover note-panel" ref={overlayRef} style={style}>
      <div className="ss-header">
        <input
          ref={searchRef}
          className="ss-search"
          type="search"
          placeholder="Search notes…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>
      <div className="ss-scroll">
        {filtered.length === 0 ? (
          <div style={{ padding: '12px 16px', color: 'var(--fg-mute)', fontSize: '13px' }}>
            {loading
              ? 'Loading notes…'
              : query.trim()
                ? `No notes match "${query}"`
                : 'No notes yet. Type "#note <text>" to add one.'}
          </div>
        ) : (
          filtered.map((n) => (
            <div
              key={`${n.sessionId}-${n.msgIdx}-${n.ts}`}
              className="note-hit"
              onClick={() => jumpTo(n)}
              title={n.sessionName + ' · ' + new Date(n.ts).toLocaleString()}
            >
              <div className="note-hit-text">{n.text}</div>
              <div className="note-hit-meta">
                <span className="note-hit-session">{n.sessionName}</span>
                <span className="note-hit-when">{formatWhen(n.ts)}</span>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export function NotePanel() {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);

  useEffect(() => {
    function onBtnClick(e: Event) {
      const b = e.currentTarget as HTMLElement;
      setAnchor(b.getBoundingClientRect());
      setOpen((o) => !o);
      e.stopPropagation();
    }
    function wire() {
      const el = document.getElementById('chat-notes-btn');
      if (el) (el as HTMLButtonElement).onclick = onBtnClick;
    }
    wire();
    const obs = new MutationObserver(wire);
    obs.observe(document.body, { childList: true, subtree: true });
    return () => {
      obs.disconnect();
      const el = document.getElementById('chat-notes-btn');
      if (el) (el as HTMLButtonElement).onclick = null;
    };
  }, []);

  if (!open) return null;
  return createPortal(<PanelContent anchor={anchor} onClose={() => setOpen(false)} />, document.body);
}
