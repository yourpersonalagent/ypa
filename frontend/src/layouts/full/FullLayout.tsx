// FullLayout — the original Shell chrome lifted into the layout-router
// architecture. This is the default layout (`layoutMode === 'full'`).
//
// Owns: collapsible header sections, the chat / workflow split-view, and the
// menu ViewOverlay. Reads `viewMode`,
// `viewSplit`, `viewOrient`, `viewSwap`, `headerOpen`, `headerOrient` from
// appStore — these are full-only fields and other layouts ignore them.
//
// CSS lives in `frontend/css/layouts/full.css`, scoped under
// `[data-layout="full"]`. See `frontend/css/LAYOUTS.md`.

import { useState, useEffect, useRef, Suspense } from 'react';
import { useAppStore } from '../../stores/appStore.js';
import { HeaderBrand } from '../../HeaderBrand.js';
import { Splitter } from '../../Splitter.js';
import { ChatView } from '../../chat/ChatView.js';
import { HeaderSectionsSlot } from '../../host/slots/HeaderSectionsSlot.js';
import { WorkflowHudSlot } from '../../host/slots/WorkflowHudSlot.js';
import { useBridgeModuleEnabled } from '../../host/bridge-modules.js';
import { CodeView } from './code/index.js';
import { ChatResizeHandle } from './code/ChatResizeHandle.js';

// ── Collapsible header sections ───────────────────────────────────────────
// One-at-a-time open coordination across every entry in the `headerSections`
// register. Each `HeaderSectionsSlot`-rendered section calls back into
// `toggle(sectionId, bodyId)` to swap the active section, and we dispatch
// `hs:open` on the body so React panels (PersonnelPanel, PartnerPanel)
// lazy-fetch on first open.

function useSections() {
  const [open, setOpen] = useState<string | null>(null);

  function toggle(id: string, bodyId?: string) {
    const next = open === id ? null : id;
    setOpen(next);
    if (next && bodyId) {
      document.getElementById(bodyId)?.dispatchEvent(new CustomEvent('hs:open'));
    }
  }

  return { open, toggle };
}

export function FullLayout() {
  const viewMode    = useAppStore((s) => s.viewMode);
  const viewSplit   = useAppStore((s) => s.viewSplit);
  const viewOrient  = useAppStore((s) => s.viewOrient);
  const viewSwap    = useAppStore((s) => s.viewSwap);
  const headerOpen  = useAppStore((s) => s.headerOpen);
  const headerOrient = useAppStore((s) => s.headerOrient);

  const headerRef = useRef<HTMLElement>(null);
  const { open: openSection, toggle: toggleSection } = useSections();

  // Keep --header-h CSS variable in sync with the header's rendered height so
  // #main sits flush underneath in horizontal-bar mode.
  //
  // ResizeObserver re-runs update() when the header transitions from
  // display:none (still active from the previous layout's scoped CSS while
  // LayoutAttribute's useEffect hasn't fired yet) to its real size. Without
  // it, offsetHeight reads 0 on initial mount after a layout switch and
  // --header-h stays wrong until the user manually toggles the header.
  useEffect(() => {
    function update() {
      if (!headerRef.current) return;
      if (headerOrient === 'h' && headerOpen) {
        document.documentElement.style.setProperty('--header-h', `${headerRef.current.offsetHeight}px`);
      } else {
        document.documentElement.style.removeProperty('--header-h');
      }
    }
    update();
    window.addEventListener('resize', update);
    const ro = new ResizeObserver(update);
    if (headerRef.current) ro.observe(headerRef.current);
    return () => {
      window.removeEventListener('resize', update);
      ro.disconnect();
    };
  }, [headerOpen, headerOrient]);

  // Horizontal-bar mode: clamp open .hs-body popovers to the viewport.
  // CSS anchors each body to its toggle (left:0, or right:0 for user-info).
  // On narrow phone widths the natural anchor can push the popup past either
  // edge; we apply an inline translateX to nudge it back inside. Using
  // transform (not left/right) keeps the CSS anchor intact and works the
  // same regardless of which side the body is anchored to.
  //
  // A ResizeObserver re-runs the clamp whenever the body itself resizes —
  // important because panels like PersonnelPanel portal their content in
  // *after* the initial click (body starts at min-width 240 px and grows
  // up to max-width once the API responds).
  useEffect(() => {
    if (headerOrient !== 'h' || !openSection) return;

    function adjustBody(body: HTMLElement) {
      const margin = 8;
      const vw = window.innerWidth;
      body.style.transform = '';
      const rect = body.getBoundingClientRect();
      const overflowRight = rect.right - (vw - margin);
      const overflowLeft = margin - rect.left;
      let shift = 0;
      if (overflowRight > 0) {
        shift = -Math.min(overflowRight, Math.max(0, rect.left - margin));
      } else if (overflowLeft > 0) {
        shift = Math.min(overflowLeft, Math.max(0, (vw - margin) - rect.right));
      }
      if (shift !== 0) body.style.transform = `translateX(${shift}px)`;
    }

    const bodies = Array.from(
      document.querySelectorAll<HTMLElement>('#header[data-orient="h"] .hs-body'),
    );
    const adjustAll = () => bodies.forEach(adjustBody);

    const raf = requestAnimationFrame(adjustAll);
    window.addEventListener('resize', adjustAll);

    const ro = new ResizeObserver((entries) => {
      entries.forEach((e) => adjustBody(e.target as HTMLElement));
    });
    bodies.forEach((b) => ro.observe(b));

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', adjustAll);
      ro.disconnect();
      bodies.forEach((b) => { b.style.transform = ''; });
    };
  }, [openSection, headerOrient]);

  // Compute flex values for chat / workflow panels in split mode.
  const chatFlex = viewSwap ? 1 - viewSplit : viewSplit;
  const wfFlex   = viewSwap ? viewSplit     : 1 - viewSplit;

  // Workflow editor surface is still gated inline (it lives in the main
  // area, not the header). Personnel / Partner gating moved into their
  // `headerSections` registrations via `when:` predicates so the slot
  // renders them in lockstep with bridge-module enablement.
  const wfEnabled = useBridgeModuleEnabled('workflows-and-triggers');

  // Code view replaces the workflow region with a CodeView shell beside
  // the chat column. ChatView keeps its place in #view-chat so React
  // never remounts it when toggling Full ↔ Code. Only the chat/code
  // flex values matter here — split-only knobs are ignored.
  const isCode = viewMode === 'code';
  // In code mode the chat column width is owned by `code.css`
  // (`--cv-chat-width` custom property driven by ChatResizeHandle). We
  // intentionally clear the inline flex style so the CSS rule wins.
  const chatFlexStyle = isCode ? undefined : `${chatFlex} 1 0`;
  const chatOrder = isCode ? 0 : (viewSwap ? 2 : 0);

  return (
    <>
      <header
        ref={headerRef}
        id="header"
        data-open={headerOpen ? 'true' : 'false'}
        data-orient={headerOrient}
      >
        <div className="brand">
          <HeaderBrand />
        </div>
        <div className="header-actions">
          <HeaderSectionsSlot
            openSection={openSection}
            toggleSection={toggleSection}
          />
        </div>
      </header>

      <main id="main">
        <div
          id="main-views"
          data-mode={viewMode}
          data-orientation={viewOrient}
        >
          <section
            id="view-chat"
            className="view view-chat"
            style={chatFlexStyle ? { flex: chatFlexStyle, order: chatOrder } : { order: chatOrder }}
          >
            <ChatView />
          </section>
          {isCode && <ChatResizeHandle />}
          {!isCode && wfEnabled && <Splitter />}
          {!isCode && wfEnabled && (
            <section
              id="view-workflow"
              className="view view-workflow"
              style={{ flex: `${wfFlex} 1 0`, order: viewSwap ? 0 : 2 }}
            >
              <div id="editor-root">
                <svg id="edge-layer" />
                <div id="node-layer" />
                <div className="editor-hud">
                  <div className="hud-row">
                    <WorkflowHudSlot />
                  </div>
                </div>
              </div>
            </section>
          )}
          {isCode && (
            <Suspense
              fallback={
                <div className="code-view" data-region-host="loading">
                  <div className="cv-center">
                    <div className="cv-editor-region">
                      <div className="cv-placeholder"><p>Loading code view…</p></div>
                    </div>
                  </div>
                </div>
              }
            >
              <CodeView />
            </Suspense>
          )}
        </div>
      </main>
    </>
  );
}
