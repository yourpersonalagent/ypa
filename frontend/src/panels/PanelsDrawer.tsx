// PanelsDrawer — floating panel overlay for messenger/zen layouts.
//
// Full layout embeds header-section panels (CWD, GlobalContext, Personnel,
// Plugins, etc.) in its collapsible header sidebar. Messenger and Zen don't
// have that sidebar, so when a header.section.* command fires in those
// layouts it sets appStore.openPanel and this component renders the chosen
// panel as a fixed side drawer over the current layout.
//
// Generic over the headerSections register: any section that declares a
// `panelLabel` is openable as a drawer. The drawer renders the section's
// own `component` (the same one the full-layout HeaderSectionsSlot uses)
// with `open=true` and `onToggle=close`. The CSS in panels-drawer.css
// suppresses the inner `.hs-toggle` button since the drawer header
// already labels the panel.
//
// PanelsDrawer is mounted at Shell level (above the layout) so it survives
// layout switches. It is a no-op in the full layout — full handles its own
// panels. Switching to full automatically clears openPanel (setLayoutMode
// resets the field), so the drawer never leaks into full.

import { useEffect, useMemo } from 'react';
import { useAppStore } from '../stores/appStore.js';
import { registers } from '../host/keys.js';
import { useRegisterListAll } from '../host/useRegisterList.js';
import { useBridgeModulesStore } from '../host/bridge-modules.js';

/** sectionId → short id used by appStore.openPanel + DOM toggle id. */
function shortId(sectionId: string | undefined): string {
  if (!sectionId) return '';
  return sectionId.replace(/^hs-/, '');
}

export function PanelsDrawer() {
  const openPanel  = useAppStore((s) => s.openPanel);
  const setOpenPanel = useAppStore((s) => s.setOpenPanel);
  const layoutMode = useAppStore((s) => s.layoutMode);

  // Subscribe to bridge-modules transitions so when() predicates on
  // headerSections (Personnel/Partner) re-evaluate as their modules toggle.
  useBridgeModulesStore((s) => s.loadState);
  useBridgeModulesStore((s) => s.byName);

  const allSections = useRegisterListAll(registers.headerSections);
  const entry = useMemo(() => {
    if (!openPanel) return null;
    for (const e of allSections) {
      if (!e.panelLabel) continue;
      if (shortId(e.sectionId) !== openPanel) continue;
      if (e.when) {
        try { if (e.when() === false) return null; }
        catch { return null; }
      }
      return e;
    }
    return null;
  }, [allSections, openPanel]);

  function close() { setOpenPanel(null); }

  // Escape key handler
  useEffect(() => {
    if (!openPanel) return;
    function onKey(e: KeyboardEvent) { if (e.key === 'Escape') close(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [openPanel]);

  // Dispatch hs:open on the section's bodyId so lazy-loading panels
  // (PersonnelPanel, PartnerPanel) know to fetch their data. Uses rAF to
  // run after the body div is in DOM.
  useEffect(() => {
    if (!entry?.bodyId) return;
    const bodyId = entry.bodyId;
    const raf = requestAnimationFrame(() => {
      document.getElementById(bodyId)?.dispatchEvent(new CustomEvent('hs:open'));
    });
    return () => cancelAnimationFrame(raf);
  }, [entry?.bodyId]);

  if (layoutMode === 'full' || !openPanel || !entry) return null;
  const Component = entry.component;

  return (
    <div
      className="panels-drawer-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) close(); }}
    >
      <div className="panels-drawer">
        <div className="panels-drawer-header">
          <span className="panels-drawer-title">{entry.panelLabel}</span>
          <button className="panels-drawer-close" onClick={close} title="Close">✕</button>
        </div>
        <div className="panels-drawer-body">
          <Component open={true} onToggle={close} />
        </div>
      </div>
    </div>
  );
}
