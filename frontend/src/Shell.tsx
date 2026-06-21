// Shell — top-level layout router.
//
// After the Phase 2 refactor (LayoutPlan.md), this is a thin component that:
//   1. Reads `layoutMode` from appStore and renders the matching layout
//      component from `frontend/src/layouts/`.
//   2. Mounts global modal hosts that every layout needs (#node-overlay,
//      #modal, #perm-modal, #cmd-helper, #add-node, #react-root). These hosts
//      are layout-agnostic — they live above the layout component so a
//      layout switch never unmounts them mid-flight.
//
// Anything that's *chrome* (header, rails, splitter, composer) belongs inside
// the layout, not here. ViewOverlay is the exception: it's shared across all
// layouts and lives here so it persists across layout switches.

import { useAppStore } from './stores/appStore.js';
import { getLayoutComponent } from './layouts/index.js';
import { registerCoreHeaderIconButtons } from './host/bootstrap-core-icons.js';
import { registerCoreHeaderSections } from './host/bootstrap-core-header-sections.js';
import { PanelsDrawer } from './panels/PanelsDrawer.js';
import { ViewOverlay } from './ViewOverlay.js';

// Register the core header icons exactly once (idempotent). Modules extend
// this set later via host.registers.headerIconButtons.add(...). Header icons
// are still used by `full`; `messenger` exposes a subset in its rail strip
// and `zen` ignores them entirely (palette-only).
registerCoreHeaderIconButtons();

// Same for the `headerSections` register — cwd / personnel / partner /
// global-context / icons start as core entries. The `plugins-folder` module
// slots its own entry in at order:20.
registerCoreHeaderSections();

export function Shell() {
  const layoutMode = useAppStore((s) => s.layoutMode);
  const Layout = getLayoutComponent(layoutMode);

  return (
    <>
      <Layout />

      {/* Header-section panels overlay (messenger/zen — no-op in full) */}
      <PanelsDrawer />

      {/* View overlay — visible in all layouts */}
      <ViewOverlay />

      {/* ── Global modal & popover hosts ───────────────────────────────
          These are not chrome — they are layout-agnostic mount points used
          by NodeOverlay, generic modals, the permission flow, etc. Mounted
          once at the Shell level so a layout switch never disrupts them. */}

      <div id="node-overlay" className="node-overlay" hidden>
        <div className="node-overlay-card" id="node-overlay-card" />
      </div>

      <div id="cmd-helper" className="popover" hidden />

      <div id="add-node" className="popover" hidden>
        <input id="add-node-input" type="text" placeholder="# command or plain prompt…" />
        <div id="add-node-list" className="popover-list" />
      </div>

      {/* Generic modal (import/export) */}
      <div id="modal" className="modal" hidden>
        <div className="modal-card">
          <header><span id="modal-title">—</span><button id="modal-close">✕</button></header>
          <div className="modal-body" id="modal-body" />
          <footer><button id="modal-ok">OK</button></footer>
        </div>
      </div>

      {/* Permission request modal */}
      <div id="perm-modal" className="perm-modal-overlay" hidden>
        <div className="perm-modal-card">
          <header className="perm-header">
            <h3>Permission Required</h3>
            <button className="perm-close">✕</button>
          </header>
          <div className="perm-body">
            <p className="perm-desc">Claude needs permission to use the following tools:</p>
            <ul className="perm-list" id="perm-list" />
            <label className="perm-session-label">
              <input type="checkbox" id="perm-remember" defaultChecked />
              Allow for this session
            </label>
          </div>
          <footer className="perm-footer">
            <button className="perm-btn perm-btn-secondary" id="perm-dismiss">Dismiss</button>
            <button className="perm-btn perm-btn-primary" id="perm-allow">Allow</button>
          </footer>
        </div>
      </div>

      {/* Legacy mount point (kept for any code that still references it) */}
      <div id="react-root" />
    </>
  );
}
