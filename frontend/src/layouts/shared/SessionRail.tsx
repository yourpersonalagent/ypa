// SessionRail — left-rail session list for the messenger layout.
//
// Tabs: "All" (every session) vs "Same CWD" (sessions whose working directory
// matches the currently active session — same logic as SessionPicker's sameDir
// mode). Pinned sessions always float to the top of whichever tab is active;
// busy sessions float above pinned. Each row exposes rename / pin / delete
// actions on hover, identical in behaviour to the SessionPicker.

import { useMemo, useEffect, useRef, useState, useCallback } from 'react';
import {
  useSessionStore,
  useChatStore,
  useAppStore,
  type SessionEntry,
} from '../../stores/index.js';
import { session } from '../../session.js';
import { api } from '../../api.js';
import { appName } from '../../branding.js';
import { NetworkNodeSwitcher } from '../../components/NetworkNodeSwitcher.js';
import {
  relativeTime,
  sessionSubtitle,
  isBusy,
  isUnread,
  busySinceOf,
  useActivityBusy,
  useSessionActions,
} from './sessionCommon.js';
import { RailSessionItem } from './RailSessionItem.js';

const HOLD_MS = 450;
const LAZY_PAGE = 50;
// Mirror of SessionPicker.MAX_PINNED_VISIBLE — keep the rail's pinned band
// focused on the most-recent pins and hide the rest behind a "Show all" link
// next to the header.
const MAX_PINNED_VISIBLE = 5;

interface SessionRailProps {
  /** Fired after a session is activated. Used by MessengerLayout to switch
   *  the mobile single-pane view from list → chat. */
  onPickSession?: (id: string | number) => void;
}

export function SessionRail({ onPickSession }: SessionRailProps = {}) {
  const sessions      = useSessionStore((s) => s.sessions);
  const currentId     = useSessionStore((s) => s.currentId);
  const defaultCwd    = useSessionStore((s) => s.defaultWorkingDir);
  const loading       = useSessionStore((s) => s.loading);
  const sessionStreams = useChatStore((s) => s.sessionStreams);
  const activityBusy  = useActivityBusy();
  const appCwd        = useAppStore((s) => s.sessionWorkingDir) ?? '';

  const [query, setQuery]   = useState('');
  const [filter, setFilter] = useState<'all' | 'sameDir'>('all');
  const [pinnedExpanded, setPinnedExpanded] = useState(false);

  const actions = useSessionActions();

  // Fresh-on-open: the global SessionPoller keeps the list current in the
  // background, but when the messenger layout mounts we want the rail to
  // reflect server state immediately rather than up to a poll-interval stale.
  // Mirrors SessionPicker's fetch-on-open.
  useEffect(() => {
    void session?.fetchList?.();
  }, []);

  // Hold detection for the new-session button
  const holdTimerRef = useRef<number | null>(null);
  const didHoldRef   = useRef(false);

  // Lazy rendering — only render the first N regular sessions, expand on scroll
  const [visibleCount, setVisibleCount] = useState(LAZY_PAGE);
  const listRef     = useRef<HTMLUListElement>(null);
  const sentinelRef = useRef<HTMLLIElement>(null);

  // Reset visible window when query or filter changes
  useEffect(() => { setVisibleCount(LAZY_PAGE); }, [query, filter]);

  // Server-side full-text search — mirrors SessionPicker. null = show all.
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

  // Grow the window when the sentinel scrolls into view.
  // root = the scroll container itself so the observer isn't affected by the
  // parent .layout-messenger overflow:hidden clipping the viewport root.
  useEffect(() => {
    const el   = sentinelRef.current;
    const root = listRef.current;
    if (!el || !root) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry?.isIntersecting) setVisibleCount((n) => n + LAZY_PAGE); },
      { root, threshold: 0 },
    );
    obs.observe(el);
    return () => obs.disconnect();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleCount]);

  // Normalise a path: strip trailing slash, fall back to server default.
  // Inlined inside useMemo so defaultCwd + appCwd are explicit deps.
  const { busy, pinned, regular, sameDirCount } = useMemo(() => {
    const tr = (p: string | null | undefined) => (p ?? '').replace(/\/+$/, '');
    const nm = (p: string | null | undefined) => tr(p) || tr(defaultCwd);
    const currentCwd = nm(appCwd);

    const cwdPool = filter === 'sameDir'
      ? sessions.filter((s) => nm(s.workingDir) === currentCwd)
      : sessions;

    // When searchHits is populated (server results arrived), filter by matching
    // IDs across all sessions — same logic as SessionPicker's server-side search.
    // While a query is typed but results haven't arrived yet, show all (no flash).
    const pool = query && searchHits
      ? cwdPool.filter((s) => searchHits.has(String(s.id)))
      : cwdPool;

    const byRecent = (a: SessionEntry, b: SessionEntry) =>
      (b.lastUsed ?? b.viewedAt ?? b.createdAt) -
      (a.lastUsed ?? a.viewedAt ?? a.createdAt);

    const busy = pool
      .filter((s) => isBusy(s, sessionStreams, activityBusy))
      .sort((a, b) => busySinceOf(b, sessionStreams) - busySinceOf(a, sessionStreams));
    const busyIds = new Set(busy.map((s) => String(s.id)));

    const pinned = pool
      .filter((s) => s.isTodo && !busyIds.has(String(s.id)))
      .sort(byRecent);
    const pinnedIds = new Set(pinned.map((s) => String(s.id)));

    const regular = pool
      .filter((s) => !busyIds.has(String(s.id)) && !pinnedIds.has(String(s.id)))
      .sort(byRecent);

    const sameDirCount = sessions.filter((s) => nm(s.workingDir) === currentCwd).length;

    return { busy, pinned, regular, sameDirCount };
  }, [sessions, query, filter, searchHits, sessionStreams, activityBusy, defaultCwd, appCwd]);

  const regularVisible = regular.slice(0, visibleCount);
  const hasMore        = regular.length > visibleCount;
  const total          = busy.length + pinned.length + regular.length;
  const pinnedOverflow = pinned.length > MAX_PINNED_VISIBLE;
  const pinnedVisible  = pinnedExpanded || !pinnedOverflow
    ? pinned
    : pinned.slice(0, MAX_PINNED_VISIBLE);
  const hasAbove       = busy.length > 0 || pinned.length > 0;

  function activate(id: string | number) {
    void session.switchTo(id);
    onPickSession?.(id);
  }

  function newSession() {
    try { session.create(); } catch { /* ignore */ }
    onPickSession?.('');
  }

  function onNewPointerDown() {
    didHoldRef.current = false;
    if (holdTimerRef.current !== null) clearTimeout(holdTimerRef.current);
    holdTimerRef.current = window.setTimeout(() => {
      holdTimerRef.current = null;
      didHoldRef.current = true;
      try { session.createWithDir(appCwd || ''); } catch { /* ignore */ }
      onPickSession?.('');
    }, HOLD_MS);
  }

  function clearNewHold() {
    if (holdTimerRef.current !== null) {
      clearTimeout(holdTimerRef.current);
      holdTimerRef.current = null;
    }
  }

  function onNewClick() {
    if (didHoldRef.current) { didHoldRef.current = false; return; }
    newSession();
  }

  const renderItem = (s: SessionEntry) => (
    <RailSessionItem
      key={String(s.id)}
      session={s}
      isCurrent={String(s.id) === String(currentId)}
      busy={isBusy(s, sessionStreams, activityBusy)}
      unread={isUnread(s, String(currentId))}
      isRenaming={actions.renamingId === String(s.id)}
      relTime={relativeTime(s.lastUsed ?? s.viewedAt ?? s.createdAt)}
      subtitle={sessionSubtitle(s)}
      onSwitchTo={activate}
      onStartRename={actions.startRename}
      onCommitRename={actions.commitRename}
      onCancelRename={actions.cancelRename}
      onToggleTodo={actions.toggleTodo}
      onDelete={actions.deleteSession}
    />
  );

  return (
    <div className="session-rail">
      <header className="session-rail-header">
        <NetworkNodeSwitcher compact title={`${appName()} — switch YPA network node`}>
          <span className="session-rail-title brand-name">
            <span style={{ color: 'var(--accent)' }}>█</span> {appName()}
          </span>
        </NetworkNodeSwitcher>
        <button
          type="button"
          className="session-rail-new"
          title="New session · hold for same dir"
          onClick={onNewClick}
          onPointerDown={onNewPointerDown}
          onPointerUp={clearNewHold}
          onPointerLeave={clearNewHold}
          onPointerCancel={clearNewHold}
        >
          +
        </button>
      </header>

      <div className="session-rail-search">
        <input
          type="text"
          placeholder="Search sessions…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          className={query ? 'has-clear' : undefined}
        />
        {query && (
          <button
            type="button"
            className="session-rail-search-clear"
            onClick={() => setQuery('')}
            title="Clear search"
          >
            ✕
          </button>
        )}
      </div>

      <div className="session-rail-tabs">
        <button
          type="button"
          className={`session-rail-tab${filter === 'all' ? ' is-active' : ''}`}
          onClick={() => setFilter('all')}
        >
          All
        </button>
        <button
          type="button"
          className={`session-rail-tab${filter === 'sameDir' ? ' is-active' : ''}`}
          onClick={() => setFilter('sameDir')}
          title={defaultCwd ? `Sessions in: ${defaultCwd}` : 'Filter by current working directory'}
        >
          Same CWD
          {filter === 'sameDir' && (
            <span className="session-rail-tab-count">{sameDirCount}</span>
          )}
        </button>
      </div>

      <ul ref={listRef} className="session-rail-list" role="listbox">
        {loading && !total && (
          <li className="session-rail-empty">Loading…</li>
        )}
        {!loading && !total && (
          <li className="session-rail-empty">
            No sessions
            {query
              ? ' match'
              : filter === 'sameDir'
                ? ' in this directory'
                : ''}
            .
          </li>
        )}

        {busy.length > 0 && (
          <li className="session-rail-section-header is-busy">Busy</li>
        )}
        {busy.map(renderItem)}

        {pinned.length > 0 && (
          <li className="session-rail-section-header is-pinned">
            <span className="session-rail-section-label">Pinned</span>
            {pinnedOverflow && (
              <button
                type="button"
                className="session-rail-pinned-toggle"
                onClick={() => setPinnedExpanded((v) => !v)}
                title={pinnedExpanded
                  ? 'Collapse pinned list'
                  : `Show all ${pinned.length} pinned sessions`}
              >
                {pinnedExpanded
                  ? 'Show fewer'
                  : `Show all (${pinned.length})`}
              </button>
            )}
          </li>
        )}
        {pinnedVisible.map(renderItem)}

        {regularVisible.length > 0 && hasAbove && (
          <li className="session-rail-section-header">Recent</li>
        )}
        {regularVisible.map(renderItem)}
        {hasMore && (
          <li ref={sentinelRef} className="session-rail-load-more" aria-hidden />
        )}
      </ul>
    </div>
  );
}
