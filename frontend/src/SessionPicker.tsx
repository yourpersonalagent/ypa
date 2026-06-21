// SessionPicker — popover session list driven by Zustand sessionStore.
// Replaces the vanilla DOM picker in session.ts.
// Actions (switch, new, delete, rename) still delegate to app.session.* for now;
// those will be migrated to React/store actions in Phase 3c.

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  useAppStore,
  useChatStore,
  useSessionStore,
  getSessionActions,
  type SessionEntry,
} from './stores/index.js';
import { confirm } from './stores/confirmStore.js';
import { session } from './session.js';
import { chat } from './chat.js';
import { api } from './api.js';
import {
  isBusy,
  isUnread,
  busySinceOf,
  useActivityBusy,
} from './layouts/shared/sessionCommon.js';
import { Pin, Folder } from './chat/icons.js';

type PickerMode = 'all' | 'sameDir';
const HOLD_MS = 450;
const LAZY_PAGE = 50;
// Pinned sessions are capped to this many rows by default; a toggle next to
// the "Pinned" header reveals the rest. Keeps the popover focused on the
// most-recent pins instead of pushing date-grouped history below the fold.
const MAX_PINNED_VISIBLE = 5;

// ── Helpers ────────────────────────────────────────────────────────────────

// Legacy localStorage key that used to hold the picker's "todo" pin set as a
// JSON array of session IDs. The pin now lives on the server (session.isTodo)
// so it syncs across browsers/devices. We migrate any leftover values once on
// first load (see migrateLegacyTodos below) and then clear the key.
const LEGACY_TODO_KEY = 'yha.sessionTodos';
const LEGACY_TODO_MIGRATED_KEY = 'yha.sessionTodos.migrated';

function readLegacyTodoIds(): string[] {
  try {
    const v = localStorage.getItem(LEGACY_TODO_KEY);
    if (!v) return [];
    const parsed = JSON.parse(v);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function groupLabel(ts: number): string {
  const now = new Date();
  const d = new Date(ts);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const diff = today - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round(diff / 86400000);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return d.toLocaleDateString('en', { weekday: 'long', month: 'short', day: 'numeric' });
  const weekStart = new Date(d);
  const dow = d.getDay(); // 0=Sun … 6=Sat
  weekStart.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1)); // back to Monday
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  // ISO week number via Thursday-anchor method
  const thu = new Date(Date.UTC(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate()));
  thu.setUTCDate(thu.getUTCDate() + 4 - (thu.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(thu.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil((((thu.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  const fmt = (date: Date) => date.toLocaleDateString('en', { month: 'short', day: 'numeric' });
  return `Week ${weekNum} · ${fmt(weekStart)} – ${fmt(weekEnd)}`;
}


// ── Row components ─────────────────────────────────────────────────────────

// Local-state rename input. Keeps every keystroke isolated to this component
// so the parent picker doesn't re-render on every character. Initial value is
// captured on mount; the parent only learns the new name on Enter/blur.
interface RenameInputProps {
  initialName: string;
  onCommit: (name: string) => void;
  onCancel: () => void;
}

function RenameInput({ initialName, onCommit, onCancel }: RenameInputProps) {
  const [value, setValue] = useState(initialName);
  return (
    <input
      className="ss-name-input"
      value={value}
      autoFocus
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onCommit(value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onCommit(value);
        if (e.key === 'Escape') onCancel();
      }}
      onClick={(e) => e.stopPropagation()}
    />
  );
}

// Memoized row. With stable callbacks and pre-computed booleans from the
// parent, rows whose props haven't changed skip re-render entirely — so
// typing in the search field or moving focus only re-renders the rows whose
// visibility/state actually flipped.
interface SessionItemProps {
  session: SessionEntry;
  isCurrent: boolean;
  isTodo: boolean;
  isFocused: boolean;
  isBusy: boolean;
  isUnread: boolean;
  isRenaming: boolean;
  onSwitchTo: (id: string | number) => void;
  onStartRename: (s: SessionEntry) => void;
  onCommitRename: (s: SessionEntry, name: string) => void;
  onCancelRename: () => void;
  onToggleTodo: (id: string) => void;
  onDelete: (s: SessionEntry) => void;
}

const SessionItem = memo(function SessionItem({
  session: s,
  isCurrent,
  isTodo,
  isFocused,
  isBusy: busy,
  isUnread: unread,
  isRenaming,
  onSwitchTo,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onToggleTodo,
  onDelete,
}: SessionItemProps) {
  const sid = String(s.id);
  return (
    <div
      className={[
        'ss-item',
        isCurrent ? 'current' : '',
        isTodo ? 'todo' : '',
        busy ? 'ss-busy' : '',
        unread ? 'ss-unread' : '',
        isFocused ? 'focused' : '',
      ]
        .filter(Boolean)
        .join(' ')}
      data-id={sid}
      onClick={() => !isRenaming && onSwitchTo(s.id)}
    >
      {isRenaming ? (
        <RenameInput
          initialName={s.name}
          onCommit={(name) => onCommitRename(s, name)}
          onCancel={onCancelRename}
        />
      ) : (
        <span className="ss-name" title={s.name}>
          {unread && (
            <span className="ss-unread-icon" aria-label="unread" title="Unread messages">✉</span>
          )}
          {s.name}
        </span>
      )}
      <span className="ss-actions">
        <span className="ss-meta">{s.messageCount ?? 0} msg{s.messageCount !== 1 ? 's' : ''}</span>
        <button
          className="ss-rename"
          title="Rename"
          onClick={(e) => { e.stopPropagation(); onStartRename(s); }}
        >
          ✎
        </button>
        <button
          className="ss-del"
          title="Delete session"
          onClick={(e) => { e.stopPropagation(); onDelete(s); }}
        >
          ✕
        </button>
        {isTodo ? (
          <button
            className="ss-todo-check"
            title="Unpin"
            onClick={(e) => { e.stopPropagation(); onToggleTodo(sid); }}
          >
            <Pin size={13} strokeWidth={1.75} fill="currentColor" />
          </button>
        ) : (
          <button
            className="ss-todo-add"
            title="Pin"
            onClick={(e) => { e.stopPropagation(); onToggleTodo(sid); }}
          >
            <Pin size={13} strokeWidth={1.75} />
          </button>
        )}
      </span>
    </div>
  );
});

// ── Picker content ─────────────────────────────────────────────────────────

interface PickerProps {
  onClose: () => void;
  anchor: DOMRect | null;
  mode: PickerMode;
  setMode: (m: PickerMode) => void;
}

function PickerContent({ onClose, anchor, mode, setMode }: PickerProps) {
  const sessions = useSessionStore((s) => s.sessions);
  const currentId = useSessionStore((s) => s.currentId);
  const defaultCwd = useSessionStore((s) => s.defaultWorkingDir);
  const sessionStreams = useChatStore((s) => s.sessionStreams);
  const activityBusy = useActivityBusy();
  const appCwd = useAppStore((s) => s.sessionWorkingDir) ?? '';
  // Trim trailing slashes so "/foo" and "/foo/" compare equal.
  // For session.workingDir, fall back to defaultCwd (server-side default, applied
  // when a session has no explicit cwd). For currentCwd we apply the same fallback
  // so a fresh session whose appCwd hasn't propagated yet still filters consistently.
  const trim = (p: string | null | undefined): string => (p ?? '').replace(/\/+$/, '');
  const norm = (p: string | null | undefined): string => trim(p) || trim(defaultCwd);
  const currentCwd = norm(appCwd);
  const [query, setQuery] = useState('');
  // Todo pins are server-side now (session.isTodo). Derive the id-set from
  // the live session list each render so a PATCH from another tab/device
  // shows up as soon as fetchList polls it back.
  const todos = useMemo<Set<string>>(
    () => new Set(sessions.filter((s) => s.isTodo).map((s) => String(s.id))),
    [sessions],
  );
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [visibleCount, setVisibleCount] = useState(LAZY_PAGE);
  const [pinnedExpanded, setPinnedExpanded] = useState(false);
  const searchRef   = useRef<HTMLInputElement>(null);
  const overlayRef  = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // Reset visible window when query or mode changes
  useEffect(() => { setVisibleCount(LAZY_PAGE); }, [query, mode]);

  // Grow the window when the sentinel scrolls into view
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry?.isIntersecting) setVisibleCount((n) => n + LAZY_PAGE); },
      { threshold: 0 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleCount]);

  // Close on outside click
  useEffect(() => {
    function onMouseDown(e: MouseEvent) {
      if (overlayRef.current && !overlayRef.current.contains(e.target as Node)) onClose();
    }
    document.addEventListener('mousedown', onMouseDown, true);
    return () => document.removeEventListener('mousedown', onMouseDown, true);
  }, [onClose]);

  // Close on global Esc (dispatched by KeyboardShortcuts).
  useEffect(() => {
    window.addEventListener('yha:escape', onClose);
    return () => window.removeEventListener('yha:escape', onClose);
  }, [onClose]);

  // When a local stream starts/stops, trigger a server refresh so isRunning
  // (wire field) catches up for sessions whose streams are tracked
  // server-side only (e.g. cross-tab, or freshly-loaded). Cheap because
  // fetchList is cached.
  const streamsKey = useMemo(
    () => Object.keys(sessionStreams).sort().join(','),
    [sessionStreams]
  );
  useEffect(() => {
    session?.fetchList?.();
  }, [streamsKey]);

  // One-time migration: if this browser still has a legacy localStorage
  // `yha.sessionTodos` set, push each id up to the server as isTodo:true and
  // mark the migration done. Runs only when the picker opens for the first
  // time post-upgrade — by then `sessions` is populated so we can skip ids
  // the server doesn't know about (deleted sessions, other-host ids).
  useEffect(() => {
    if (localStorage.getItem(LEGACY_TODO_MIGRATED_KEY) === '1') return;
    if (sessions.length === 0) return; // wait for the first list to arrive
    const legacyIds = readLegacyTodoIds();
    if (legacyIds.length === 0) {
      localStorage.setItem(LEGACY_TODO_MIGRATED_KEY, '1');
      localStorage.removeItem(LEGACY_TODO_KEY);
      return;
    }
    const known = new Set(sessions.map((s) => String(s.id)));
    const toMigrate = legacyIds.filter((id) => known.has(id));
    Promise.allSettled(
      toMigrate.map((id) =>
        fetch(`/v1/sessions/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ isTodo: true }),
        }),
      ),
    ).finally(() => {
      localStorage.setItem(LEGACY_TODO_MIGRATED_KEY, '1');
      localStorage.removeItem(LEGACY_TODO_KEY);
      session?.fetchList?.();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions.length === 0]);

  // Server-side full-text search — debounced 250ms. searchHits is null while no
  // query is set (show all), or a Set of matching session IDs when results are ready.
  const [searchHits, setSearchHits] = useState<Set<string> | null>(null);
  const searchAc = useRef<AbortController | null>(null);
  const doSearch = useCallback((q: string) => {
    searchAc.current?.abort();
    if (!q) { setSearchHits(null); return; }
    const ac = new AbortController();
    searchAc.current = ac;
    const base = (api.config as { baseUrl?: string }).baseUrl || window.location.origin;
    fetch(`${base}/v1/sessions/search?q=${encodeURIComponent(q)}`, { signal: ac.signal })
      .then((r) => r.json())
      .then((d) => {
        if (!ac.signal.aborted) {
          setSearchHits(new Set<string>((d.sessions ?? []).map((s: { id: string | number }) => String(s.id))));
        }
      })
      .catch(() => {});
  }, []);
  useEffect(() => {
    const timer = setTimeout(() => doSearch(query), 250);
    return () => { clearTimeout(timer); };
  }, [query, doSearch]);

  // In sameDir mode, restrict to sessions whose effective working directory
  // matches the active cwd. Sessions with workingDir == null/empty inherit
  // the server's defaultWorkingDir, so normalize both sides through `norm`
  // to avoid mismatches caused by trailing slashes or null-vs-default.
  const cwdFiltered = mode === 'sameDir'
    ? sessions.filter((s) => norm(s.workingDir) === currentCwd)
    : sessions;

  // When searchHits is set (results arrived from server), filter to matching IDs.
  // While a query is typed but results haven't arrived yet, show all (no flash of empty).
  const filtered = query && searchHits
    ? cwdFiltered.filter((s) => searchHits.has(String(s.id)))
    : cwdFiltered;

  const todoIds = todos;
  // Belt-and-braces: re-apply the cwd predicate inside each bucket so that
  // even if `filtered` were out of sync with `mode` (e.g. mid-render),
  // todo/running entries from other working directories cannot leak through.
  const inCwd = (s: SessionEntry) => mode !== 'sameDir' || norm(s.workingDir) === currentCwd;
  // Three buckets: Busy > Todo > date-grouped regulars. Busy wins
  // when a session is also pinned, so it appears only once in the list.
  const busySessions = filtered
    .filter((s) => isBusy(s, sessionStreams, activityBusy) && inCwd(s))
    .sort((a, b) => busySinceOf(b, sessionStreams) - busySinceOf(a, sessionStreams));
  const busyIds = new Set(busySessions.map((s) => String(s.id)));
  const todoSessions = filtered.filter(
    (s) => todoIds.has(String(s.id)) && !busyIds.has(String(s.id)) && inCwd(s),
  );
  const pinnedOverflow = todoSessions.length > MAX_PINNED_VISIBLE;
  const todoVisible = pinnedExpanded || !pinnedOverflow
    ? todoSessions
    : todoSessions.slice(0, MAX_PINNED_VISIBLE);
  const regularSessions = filtered
    .filter((s) => !todoIds.has(String(s.id)) && !busyIds.has(String(s.id)) && inCwd(s))
    .sort((a, b) => {
      const ta = new Date(a.lastUsed ?? a.createdAt ?? 0).getTime();
      const tb = new Date(b.lastUsed ?? b.createdAt ?? 0).getTime();
      return tb - ta;
    });

  // Only render the first visibleCount regular sessions; more load on scroll
  const regularVisible = regularSessions.slice(0, visibleCount);
  const hasMoreRegular = regularSessions.length > visibleCount;

  // Group regular sessions by date bucket
  const groups = new Map<string, SessionEntry[]>();
  for (const s of regularVisible) {
    const label = groupLabel(s.lastUsed ?? s.createdAt);
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label)!.push(s);
  }

  // Flat list in visual order (busy → todo → grouped regulars). Used for
  // keyboard navigation via arrow keys; index ↔ rendered .ss-item position.
  // Uses todoVisible so arrows skip pinned rows that are hidden behind the
  // "Show all" toggle.
  const flatList: SessionEntry[] = [
    ...busySessions,
    ...todoVisible,
    ...[...groups.values()].flat(),
  ];

  // Reset focus to the current session (or 0) whenever the visible list shape
  // changes — query change, sessions added/removed, etc.
  useEffect(() => {
    const i = flatList.findIndex((s) => String(s.id) === String(currentId));
    setFocusedIndex(i >= 0 ? i : 0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, flatList.length]);

  // Scroll the focused item into view when it changes.
  useEffect(() => {
    if (!overlayRef.current) return;
    const target = overlayRef.current.querySelector('.ss-item.focused');
    target?.scrollIntoView({ block: 'nearest' });
  }, [focusedIndex]);

  const switchTo = useCallback((id: string | number) => {
    session?.switchTo(id);
    onClose();
  }, [onClose]);

  function handleNavKey(e: React.KeyboardEvent): void {
    // Rename input owns its own Enter/Esc — don't hijack.
    if (renamingId !== null) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setFocusedIndex((i) => Math.min(flatList.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setFocusedIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowRight') {
      const target = flatList[focusedIndex];
      if (!target) return;
      // Don't hijack Space when typing into the search field — the user
      // probably meant to insert a space character. Treat Space as "apply"
      // only when the search field is empty.
      if (e.key === ' ' && query.length > 0) return;
      e.preventDefault();
      switchTo(target.id);
    }
  }

  // Optimistic updates create a new SessionEntry rather than mutating the
  // existing one — memoized rows compare props with === and would otherwise
  // miss the change. On failure we re-fetch to snap back to the server.
  const toggleTodo = useCallback(async (id: string) => {
    const all = useSessionStore.getState().sessions;
    const idx = all.findIndex((s) => String(s.id) === id);
    if (idx < 0) return;
    const target = all[idx];
    const next = !(target.isTodo === true);
    const updated = [...all];
    updated[idx] = { ...target, isTodo: next };
    getSessionActions().setSessions(updated);
    try {
      const r = await fetch(`/v1/sessions/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isTodo: next }),
      });
      if (!r.ok) throw new Error(`PATCH /v1/sessions/${id} failed: ${r.status}`);
    } catch {
      session?.fetchList?.();
    }
  }, []);

  const startRename = useCallback((s: SessionEntry) => {
    setRenamingId(String(s.id));
  }, []);

  const cancelRename = useCallback(() => {
    setRenamingId(null);
  }, []);

  const commitRename = useCallback(async (s: SessionEntry, name: string) => {
    const trimmed = name.trim();
    setRenamingId(null);
    if (!trimmed || trimmed === s.name) return;
    const all = useSessionStore.getState().sessions;
    const idx = all.findIndex((x) => x.id === s.id);
    if (idx >= 0) {
      const updated = [...all];
      updated[idx] = { ...all[idx], name: trimmed };
      getSessionActions().setSessions(updated);
    }
    try {
      await fetch(`/v1/sessions/${s.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: trimmed }),
      });
      await session?.fetchList?.();
    } catch {}
  }, []);

  const deleteSession = useCallback(async (s: SessionEntry) => {
    const ok = await confirm({
      scope: 'delete-session',
      title: 'Delete session',
      message: `Delete "${s.name}"? This cannot be undone.`,
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      danger: true,
      trustMs: 5 * 60_000,
    });
    if (ok) session?.delete?.(s.id);
  }, []);

  // Position relative to anchor button; clamp maxHeight + left so the popover
  // never extends past the viewport edges (overrides CSS max-height when space is tight).
  // Hidden-anchor fallback: when the trigger button is `display: none`
  // (Zen / Messenger layouts hide the chat bar entirely) the rect is all
  // zeros — fall back to a viewport-centered position so palette-driven
  // opens (Alt+S, `/chat session.switch`) stay visible.
  const style: React.CSSProperties = useMemo(() => {
    if (!anchor) return {};
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const margin = 8;
    const gap = 6;
    const width = 320; // mirrors #session-overlay width in chat.css
    if (anchor.width === 0 && anchor.height === 0) {
      const left = Math.max(margin, (vw - width) / 2);
      const top = Math.max(margin, vh * 0.15);
      const maxHeight = Math.max(120, vh - top - margin);
      return { position: 'fixed', top, left, maxHeight };
    }
    const left = Math.max(margin, Math.min(vw - width - margin, anchor.left));
    const bottom = vh - anchor.top + gap;
    const maxHeight = Math.max(120, vh - bottom - margin);
    return { position: 'fixed', bottom, left, maxHeight };
  }, [anchor]);

  const focusedId = flatList[focusedIndex] ? String(flatList[focusedIndex].id) : null;

  const renderRow = (s: SessionEntry) => {
    const sid = String(s.id);
    return (
      <SessionItem
        key={sid}
        session={s}
        isCurrent={sid === currentId}
        isTodo={todoIds.has(sid)}
        isFocused={sid === focusedId}
        isBusy={isBusy(s, sessionStreams, activityBusy)}
        isUnread={isUnread(s, currentId)}
        isRenaming={renamingId === sid}
        onSwitchTo={switchTo}
        onStartRename={startRename}
        onCommitRename={commitRename}
        onCancelRename={cancelRename}
        onToggleTodo={toggleTodo}
        onDelete={deleteSession}
      />
    );
  };

  return (
    <div
      id="session-overlay"
      className={`popover${mode === 'sameDir' ? ' ss-same-dir' : ''}`}
      ref={overlayRef}
      style={style}
      onKeyDown={handleNavKey}
    >
      <div className="ss-header">
        {mode === 'sameDir' ? (
          <div className="ss-header-btns">
            <button
              className="ss-new-btn"
              onClick={() => { chat?.startNewSessionSameDir?.(); onClose(); }}
            >
              ＋ New Session (same dir)
            </button>
          </div>
        ) : (
          <div className="ss-header-btns">
            <button
              className="ss-new-btn"
              onClick={() => { chat?.startNewSession?.(); onClose(); }}
            >
              ＋ New Session
            </button>
            <button
              className="ss-new-btn ss-new-dir-btn"
              onClick={() => { chat?.startNewSessionSameDir?.(); onClose(); }}
            >
              ＋ Same Dir
            </button>
          </div>
        )}
        {/* Mode toggle — clicking flips between 'all' and 'sameDir'. The active
            state shows the cwd being filtered so the user can verify which dir
            is in scope (helps diagnose cases where appCwd is unexpectedly the
            default — e.g. a fresh session before switchTo populated it). */}
        <button
          type="button"
          className={`ss-mode-toggle${mode === 'sameDir' ? ' active' : ''}`}
          onClick={() => setMode(mode === 'sameDir' ? 'all' : 'sameDir')}
          title={mode === 'sameDir'
            ? `Filtering to: ${currentCwd || '(no cwd)'} — click to show all`
            : 'Click to filter to current working directory'}
        >
          <span className="ss-mode-toggle-icon" aria-hidden="true">
            <Folder size={13} strokeWidth={1.75} />
          </span>
          <span className="ss-mode-toggle-label">
            {mode === 'sameDir'
              ? `same dir: ${currentCwd ? (currentCwd.split('/').filter(Boolean).slice(-2).join('/') || currentCwd) : '(no cwd)'}`
              : 'all dirs (click to filter)'}
          </span>
          <span className="ss-mode-toggle-count">
            {mode === 'sameDir' ? `${cwdFiltered.length}` : ''}
          </span>
        </button>
        <input
          ref={searchRef}
          className="ss-search"
          type="search"
          placeholder={mode === 'sameDir' ? 'Search same-dir sessions…' : 'Search sessions & messages… [↑↓ Enter]'}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <div className="ss-scroll">
        {busySessions.length > 0 && (
          <>
            <div className="ss-busy-header">Busy</div>
            {busySessions.map(renderRow)}
          </>
        )}
        {todoSessions.length > 0 && (
          <>
            <div className="ss-todo-header">
              <span className="ss-todo-header-label">Pinned</span>
              {pinnedOverflow && (
                <button
                  type="button"
                  className="ss-pinned-toggle"
                  onClick={() => setPinnedExpanded((v) => !v)}
                  title={pinnedExpanded
                    ? 'Collapse pinned list'
                    : `Show all ${todoSessions.length} pinned sessions`}
                >
                  {pinnedExpanded
                    ? 'Show fewer'
                    : `Show all (${todoSessions.length})`}
                </button>
              )}
            </div>
            {todoVisible.map(renderRow)}
          </>
        )}
        {[...groups.entries()].map(([label, list]) => (
          <div key={label}>
            <div className="popover-group">{label}</div>
            {list.map(renderRow)}
          </div>
        ))}
        {filtered.length === 0 && (
          <div style={{ padding: '12px 16px', color: 'var(--fg-mute)', fontSize: '13px' }}>
            No sessions match "{query}"
          </div>
        )}
        {hasMoreRegular && (
          <div ref={sentinelRef} className="ss-load-sentinel" aria-hidden />
        )}
      </div>
    </div>
  );
}

// ── Trigger button portal ──────────────────────────────────────────────────
// Intercepts clicks on the existing #chat-session-btn and opens the React picker.

export function SessionPicker() {
  const [open, setOpen] = useState(false);
  const [anchor, setAnchor] = useState<DOMRect | null>(null);
  const [mode, setMode] = useState<PickerMode>('all');
  const currentId = useSessionStore((s) => s.currentId);

  // Wire the button listeners — re-run if currentId changes (e.g. after new session).
  // Use DOM event-handler properties (onclick, onpointerdown, …) rather than
  // addEventListener so replacing the element (chat.init, cloneNode) won't
  // double-bind; MutationObserver re-wires onto the new element immediately.
  // Tap = open in 'all' mode. Hold ≥ HOLD_MS = open in 'sameDir' mode (filtered
  // by current cwd, single +new-same-dir button). Mirrors the new-session
  // tap/hold pattern in chat.ts.
  useEffect(() => {
    let holdTimer: number | null = null;
    let didHold = false;

    function clearHold() {
      if (holdTimer !== null) {
        clearTimeout(holdTimer);
        holdTimer = null;
      }
    }

    function openWith(b: HTMLElement, m: PickerMode, toggle: boolean) {
      setAnchor(b.getBoundingClientRect());
      setMode(m);
      if (toggle) setOpen((o) => !o);
      else setOpen(true);
      session?.fetchList?.();
    }

    function onPointerDown(e: PointerEvent) {
      didHold = false;
      clearHold();
      const b = e.currentTarget as HTMLElement;
      holdTimer = window.setTimeout(() => {
        holdTimer = null;
        didHold = true;
        openWith(b, 'sameDir', false);
      }, HOLD_MS);
    }

    function onBtnClick(e: Event) {
      e.stopPropagation();
      if (didHold) {
        // The pointerdown timer already opened in sameDir mode — swallow the
        // trailing click so it doesn't immediately toggle the picker shut.
        didHold = false;
        return;
      }
      openWith(e.currentTarget as HTMLElement, 'all', true);
    }

    function wire() {
      const el = document.getElementById('chat-session-btn') as HTMLButtonElement | null;
      if (!el) return;
      el.onclick = onBtnClick;
      el.onpointerdown = onPointerDown;
      el.onpointerup = clearHold;
      el.onpointerleave = clearHold;
      el.onpointercancel = clearHold;
    }

    wire();
    const obs = new MutationObserver(wire);
    obs.observe(document.body, { childList: true, subtree: true });

    return () => {
      obs.disconnect();
      clearHold();
      const el = document.getElementById('chat-session-btn') as HTMLButtonElement | null;
      if (el) {
        el.onclick = null;
        el.onpointerdown = null;
        el.onpointerup = null;
        el.onpointerleave = null;
        el.onpointercancel = null;
      }
    };
  }, [currentId]);  // Re-wire when currentId changes (state setters are stable)

  if (!open) return null;
  return createPortal(
    <PickerContent
      anchor={anchor}
      onClose={() => setOpen(false)}
      mode={mode}
      setMode={setMode}
    />,
    document.body
  );
}
