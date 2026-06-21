// ContextHub — header-modal Shell #2 of the ContextGenerator pipeline.
// Phase 1b / Adaption 2 + 4 (Shell #2).
//
// Companion to the QuickContextPicker (Shell #1 in the chat input). Same
// engine underneath (`contextStore` + `ContextList` + `CategoryTabs`); this
// shell trades quick-pick speed for verbosity:
//   • All sensitivity tiers visible by default with badges.
//   • Pipeline status (TitleGen / Categorizer / Sorter / LINK).
//   • Bridge-Mode toggle (Standalone / MCP / Both) — persisted server-side.
//   • Sensitivity-policy radio group + manual overrides.
//
// Mounted unconditionally by App.tsx and toggled open via the
// `yha:open-context-hub` CustomEvent dispatched from ContextGenButton.
// Following the PrefsModal pattern: portal into document.body, escape-key
// + click-outside dismissal, last-tab persisted in localStorage.

import { lazy, Suspense, useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { store } from '../store.js';
import { HubPickerTab }    from './HubPickerTab.js';
// HubGeneratorTab is ~1700 lines — keep it out of the main bundle and
// only fetch the chunk when the user actually opens the Generator tab.
const HubGeneratorTab = lazy(() =>
  import('./HubGeneratorTab.js').then((m) => ({ default: m.HubGeneratorTab }))
);
import { HubLinkTab }      from './HubLinkTab.js';
import { HubBridgeTab }    from './HubBridgeTab.js';
import { HubSettingsTab }  from './HubSettingsTab.js';
import { HubRagTab }       from './HubRagTab.js';

type HubTab = 'picker' | 'generator' | 'rag' | 'link' | 'bridge' | 'settings';

interface TabSpec {
  id:       HubTab;
  label:    string;
  // `enabled === false` renders a disabled tab with a "Phase X" badge so the
  // user knows the surface is planned but not implemented yet — strictly
  // better UX than hiding it (which would imply "this feature does not exist").
  enabled:  boolean;
  comingIn?: string;
}

const TABS: ReadonlyArray<TabSpec> = Object.freeze([
  { id: 'picker',    label: '📋 Picker',    enabled: true },
  { id: 'generator', label: '⚙️ Generator', enabled: true },
  { id: 'rag',       label: '🧬 RAG',       enabled: true },
  { id: 'link',      label: '🔗 LINK',      enabled: true },
  { id: 'bridge',    label: '🛠️ Bridge',    enabled: true },
  { id: 'settings',  label: '⚙️ Settings',  enabled: true },
]);

function readStoredTab(): HubTab {
  const v = store.get('contextHubTab') as string | undefined;
  const valid = TABS.find((t) => t.id === v && t.enabled);
  return valid ? (v as HubTab) : 'picker';
}

export function ContextHub() {
  const [open, setOpen] = useState(false);
  const [tab, setTabState] = useState<HubTab>(() => readStoredTab());

  const close = useCallback(() => setOpen(false), []);

  const setTab = useCallback((next: HubTab) => {
    setTabState(next);
    store.set('contextHubTab', next);
  }, []);

  // Listen for the open-event the header button dispatches. Keeps the
  // header button decoupled from this modal — it just fires an event.
  // Pair: `yha:close-context-hub` lets nested tabs (e.g. HubRagTab's
  // "Attach to chat") dismiss the modal after a successful action without
  // having to drill the close callback through every child.
  useEffect(() => {
    function onOpen() { setOpen(true); }
    function onClose() { setOpen(false); }
    window.addEventListener('yha:open-context-hub', onOpen);
    window.addEventListener('yha:close-context-hub', onClose);
    return () => {
      window.removeEventListener('yha:open-context-hub', onOpen);
      window.removeEventListener('yha:close-context-hub', onClose);
    };
  }, []);

  // Cross-tab navigation — fired by inline "Manage" / "Open …" buttons inside
  // one tab that want to jump to another (e.g. the Generator-tab RAG card's
  // "Manage" button → 🧬 RAG tab). Detail = { tab: HubTab }.
  useEffect(() => {
    function onSetTab(e: Event) {
      const next = (e as CustomEvent<{ tab?: string }>).detail?.tab;
      const spec = TABS.find((t) => t.id === next && t.enabled);
      if (spec) setTab(spec.id);
    }
    window.addEventListener('yha:context-hub-set-tab', onSetTab as EventListener);
    return () => window.removeEventListener('yha:context-hub-set-tab', onSetTab as EventListener);
  }, [setTab]);

  // ESC closes the hub. Click-outside is handled inline on the overlay
  // backdrop (mousedown listener on the overlay div).
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') close();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, close]);

  if (!open) return null;

  return createPortal(
    <div
      className="prefs-modal-overlay context-hub-overlay"
      style={{ display: 'flex' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div
        className="prefs-modal-card context-hub-card"
        // Constrain height so long tabs scroll internally instead of
        // pushing the footer off-screen on small laptops.
        style={{ display: 'flex', flexDirection: 'column', maxHeight: '85vh', minHeight: 460 }}
      >
        <header className="prefs-header">
          <h3>Context Generator</h3>
          <button className="prefs-close" onClick={close} aria-label="Close">✕</button>
        </header>

        <nav className="prefs-tabs" aria-label="Context Hub sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              className={`prefs-tab${tab === t.id ? ' active' : ''}`}
              data-tab={t.id}
              onClick={() => t.enabled && setTab(t.id)}
              disabled={!t.enabled}
              title={t.enabled ? t.label : `${t.label} — coming in ${t.comingIn ?? 'a later phase'}`}
            >
              {t.label}
              {!t.enabled && (
                <span style={{
                  marginLeft: 6,
                  fontSize:   '10px',
                  opacity:    0.6,
                  textTransform: 'uppercase',
                }}>
                  {t.comingIn ?? 'soon'}
                </span>
              )}
            </button>
          ))}
        </nav>

        <div className="prefs-body" style={{ flex: 1, overflowY: 'auto' }}>
          <div className="prefs-panel">
            {tab === 'picker'    && <HubPickerTab />}
            {tab === 'generator' && (
              <Suspense fallback={<div style={{ padding: 16, opacity: 0.7 }}>Loading…</div>}>
                <HubGeneratorTab />
              </Suspense>
            )}
            {tab === 'rag'       && <HubRagTab />}
            {tab === 'link'      && <HubLinkTab />}
            {tab === 'bridge'    && <HubBridgeTab />}
            {tab === 'settings'  && <HubSettingsTab />}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
}
