// PrefsModal — React shell that owns open/close/tab state.
// Tabs come from the `prefsTabs` register (see `host/keys.ts`); core
// tabs are registered by `host/bootstrap-core-prefs-tabs.ts`, modules
// add their own via `host.registers.prefsTabs.add(...)`.

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { registers, PREFS_TAB_GROUPS } from '../host/keys.js';
import { useRegisterList } from '../host/useRegisterList.js';
import { loadCosts, clearCosts, getHiddenModels } from './costs.js';
import { prefs } from '../preferences.js';
import { store } from '../store.js';

type ViewMode = 'simple' | 'advanced';

const FALLBACK_TAB = 'stats';

function readStoredTab(): string {
  const v = store.get('prefsTab') as string | undefined;
  return v || FALLBACK_TAB;
}

export function PrefsModal() {
  const tabs = useRegisterList(registers.prefsTabs);

  const [isOpen, setIsOpen] = useState(false);
  const [activeTab, setActiveTabState] = useState<string>(() => readStoredTab());
  const [view, setView] = useState<ViewMode>(() => {
    const v = store.get('prefsView') as string | undefined;
    return v === 'advanced' ? 'advanced' : 'simple';
  });
  const btnRef = useRef<HTMLElement | null>(null);

  const setActiveTab = useCallback((tab: string) => {
    setActiveTabState(tab);
    store.set('prefsTab', tab);
  }, []);

  const closeModal = useCallback(() => setIsOpen(false), []);

  const visibleTabs = useMemo(
    () => tabs.filter((t) => view === 'advanced' || t.simpleMode !== null),
    [tabs, view],
  );

  // Cluster the visible tabs into the rail's section groups. Groups render in
  // `PREFS_TAB_GROUPS` order; tabs within a group keep their register order
  // (visibleTabs is already order-sorted). Empty groups are dropped so no
  // orphan header shows (e.g. a group whose only tabs are advanced-only).
  const groupedTabs = useMemo(
    () =>
      PREFS_TAB_GROUPS
        .map((g) => ({ ...g, tabs: visibleTabs.filter((t) => t.group === g.id) }))
        .filter((g) => g.tabs.length > 0),
    [visibleTabs],
  );

  const openModal = useCallback((tab?: string) => {
    const wanted = tab ?? readStoredTab();
    const known = tabs.some((t) => t.id === wanted);
    setActiveTab(known ? wanted : (tabs[0]?.id ?? FALLBACK_TAB));
    setIsOpen(true);
  }, [setActiveTab, tabs]);

  // Wire #btn-prefs click and override prefs.open / close
  useEffect(() => {
    function handleClick() { openModal(); }

    function wireBtn() {
      const btn = document.getElementById('btn-prefs');
      if (!btn || btn.dataset.reactOwned) return;
      btn.dataset.reactOwned = '1';
      btnRef.current = btn;
      btn.addEventListener('click', handleClick);
    }

    wireBtn();
    const obs = new MutationObserver(wireBtn);
    obs.observe(document.body, { childList: true, subtree: true });

    const p = prefs as unknown as Record<string, unknown>;
    p.open = (tab?: string) => openModal(tab);
    p.close = closeModal;
    p.loadCosts = loadCosts;
    p.clearCosts = clearCosts;
    p.getHiddenModels = getHiddenModels;
    p.trackCost = () => {};

    return () => {
      obs.disconnect();
      const btn = btnRef.current;
      if (btn) {
        btn.removeEventListener('click', handleClick);
        delete btn.dataset.reactOwned;
        btnRef.current = null;
      }
    };
  }, [openModal, closeModal]);

  // Reflect view mode on <body> for CSS-driven section hiding
  useEffect(() => {
    if (isOpen) document.body.dataset.prefsView = view;
    else delete document.body.dataset.prefsView;
    return () => { delete document.body.dataset.prefsView; };
  }, [isOpen, view]);

  // If active tab is hidden in current view, fall back to first visible tab
  useEffect(() => {
    if (!isOpen) return;
    const meta = tabs.find((t) => t.id === activeTab);
    if (!meta || (view === 'simple' && meta.simpleMode === null)) {
      setActiveTab(visibleTabs[0]?.id ?? FALLBACK_TAB);
    }
  }, [isOpen, view, activeTab, tabs, visibleTabs, setActiveTab]);

  // Escape key
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeModal(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [isOpen, closeModal]);

  function changeView(next: ViewMode) {
    if (next === view) return;
    setView(next);
    store.set('prefsView', next);
  }

  if (!isOpen) return null;

  const ActiveComponent = visibleTabs.find((t) => t.id === activeTab)?.component
    ?? tabs.find((t) => t.id === activeTab)?.component;

  return createPortal(
    <div
      className="prefs-modal-overlay"
      style={{ display: 'flex' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) closeModal(); }}
    >
      <div className="prefs-modal-card">
        <header className="prefs-header">
          <h3>Settings &amp; Preferences</h3>
          <div className="prefs-view-toggle" role="group" aria-label="Settings view mode">
            <button
              type="button"
              className={`prefs-view-btn${view === 'simple' ? ' active' : ''}`}
              onClick={() => changeView('simple')}
              title="Simple — show only essentials"
            >Simple</button>
            <button
              type="button"
              className={`prefs-view-btn${view === 'advanced' ? ' active' : ''}`}
              onClick={() => changeView('advanced')}
              title="Advanced — show all settings"
            >Advanced</button>
          </div>
          <button className="prefs-close" onClick={closeModal}>✕</button>
        </header>

        <div className="prefs-shell">
          <nav className="prefs-rail" aria-label="Settings sections">
            {groupedTabs.map((g) => (
              <Fragment key={g.id}>
                <div className="prefs-rail-group">{g.label}</div>
                {g.tabs.map(({ id, label, icon }) => (
                  <button
                    key={id}
                    className={`prefs-rail-tab${activeTab === id ? ' active' : ''}`}
                    data-tab={id}
                    onClick={() => setActiveTab(id)}
                  >
                    {icon ? <span className="prefs-rail-tab-icon" aria-hidden="true">{icon}</span> : null}
                    {label}
                  </button>
                ))}
              </Fragment>
            ))}
          </nav>

          <div className="prefs-body">
            <div className="prefs-panel">
              {ActiveComponent && <ActiveComponent close={closeModal} />}
            </div>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
