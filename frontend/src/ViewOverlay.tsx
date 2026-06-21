import { useEffect, useRef } from 'react';
import { useAppStore } from './stores/index.js';
import { getAppActions, getAppState } from './stores/index.js';
import { save } from './state.js';
import { useBridgeModuleEnabled } from './host/bridge-modules.js';
import { cycleForward } from './layout.js';

const HOLD_MS = 450;
const CYCLE_REPEAT_MS = 320;

// ── Layout cycle helpers ──────────────────────────────────────────────────

function cycleBackward() {
  const { layoutMode, viewMode } = getAppState();
  const { setLayoutMode, setViewMode } = getAppActions();
  if (layoutMode === 'full' && viewMode !== 'chat') {
    setViewMode('chat');
    save.view();
  } else if (layoutMode === 'full') {
    // full(chat) ← zen
    setLayoutMode('zen');
  } else if (layoutMode === 'zen') {
    // zen ← messenger
    setLayoutMode('messenger');
  } else {
    // messenger ← full(chat)
    setLayoutMode('full');
    setViewMode('chat');
    save.view();
  }
}

export function ViewOverlay() {
  const viewMode    = useAppStore((s) => s.viewMode);
  const viewOrient  = useAppStore((s) => s.viewOrient);
  const viewSwap    = useAppStore((s) => s.viewSwap);
  const overlayPos  = useAppStore((s) => s.overlayPos);
  const headerOpen  = useAppStore((s) => s.headerOpen);
  const headerOrient = useAppStore((s) => s.headerOrient);
  const layoutMode  = useAppStore((s) => s.layoutMode);

  // Split button hold — long-press swaps chat ↔ workflow panels.
  const splitHoldTimer = useRef<number | null>(null);
  const splitDidHold   = useRef(false);

  // Menu button hold — long-press swaps header orientation h ↔ v.
  const menuHoldTimer = useRef<number | null>(null);
  const menuDidHold   = useRef(false);

  // Layout cycle button — hold repeats forward cycle; right-click cycles backward.
  const cycleHoldTimer    = useRef<number | null>(null);
  const cycleRepeatTimer  = useRef<number | null>(null);
  const cycleDidHold      = useRef(false);

  const isV = viewOrient === 'v';
  const effectivePos = viewMode === 'chat' && overlayPos === 'bottom' ? 'top' : overlayPos;
  const isVerticalPos = effectivePos === 'left' || effectivePos === 'right';

  const wfEnabled = useBridgeModuleEnabled('workflows-and-triggers');
  const isFullLayout = layoutMode === 'full';

  // Keep the cycle (chat/layout) button at the structural centre of the
  // overlay regardless of how many other buttons are visible. Whichever
  // side has fewer real buttons gets invisible spacers so the cycle button
  // always sits at the middle slot — that way the default centre-of-overlay
  // positioning lines it up at the same screen point in every mode.
  // Code-view button is full-layout only and adds one slot before the cycle.
  const buttonsBefore = (isFullLayout && wfEnabled ? 2 : 0) + (isFullLayout ? 1 : 0);
  const buttonsAfter  = isFullLayout ? 2 : 1;
  const startSpacers  = Math.max(0, buttonsAfter - buttonsBefore);
  const endSpacers    = Math.max(0, buttonsBefore - buttonsAfter);

  useEffect(() => {
    // When workflows module is disabled, split/workflow modes have nothing
    // to render — drop back to chat. Code view does not depend on the
    // workflow module, so leave it alone.
    if (!wfEnabled) {
      const m = getAppState().viewMode;
      if (m !== 'chat' && m !== 'code') {
        getAppActions().setViewMode('chat');
        save.view();
      }
    }
  }, [wfEnabled]);

  // ── Split button ──────────────────────────────────────────────────────────

  function handleSplitPointerDown() {
    splitDidHold.current = false;
    if (splitHoldTimer.current !== null) clearTimeout(splitHoldTimer.current);
    splitHoldTimer.current = window.setTimeout(() => {
      splitHoldTimer.current = null;
      splitDidHold.current = true;
      if (getAppState().viewMode !== 'split') getAppActions().setViewMode('split' as const);
      getAppActions().setViewSwap(!getAppState().viewSwap);
      save.view();
    }, HOLD_MS);
  }

  function cancelSplitHold() {
    if (splitHoldTimer.current !== null) {
      clearTimeout(splitHoldTimer.current);
      splitHoldTimer.current = null;
    }
  }

  function handleSplitClick(e: React.MouseEvent) {
    if (splitDidHold.current) { splitDidHold.current = false; return; }
    e.stopPropagation();
    if (getAppState().viewMode !== 'split') {
      getAppActions().setViewMode('split');
    } else {
      const cur = getAppState().viewOrient;
      getAppActions().setViewOrient(cur === 'h' ? 'v' : 'h');
    }
    save.view();
  }

  // ── Menu button ───────────────────────────────────────────────────────────

  function handleMenuPointerDown() {
    menuDidHold.current = false;
    if (menuHoldTimer.current !== null) clearTimeout(menuHoldTimer.current);
    menuHoldTimer.current = window.setTimeout(() => {
      menuHoldTimer.current = null;
      menuDidHold.current = true;
      const cur = getAppState().headerOrient;
      getAppActions().setHeaderOrient(cur === 'h' ? 'v' : 'h');
      save.view();
    }, HOLD_MS);
  }

  function cancelMenuHold() {
    if (menuHoldTimer.current !== null) {
      clearTimeout(menuHoldTimer.current);
      menuHoldTimer.current = null;
    }
  }

  function handleMenuClick(e: React.MouseEvent) {
    if (menuDidHold.current) { menuDidHold.current = false; return; }
    e.stopPropagation();
    getAppActions().setHeaderOpen(!getAppState().headerOpen);
    save.view();
  }

  // ── Layout cycle button ───────────────────────────────────────────────────

  function stopCycleRepeat() {
    if (cycleRepeatTimer.current !== null) {
      clearInterval(cycleRepeatTimer.current);
      cycleRepeatTimer.current = null;
    }
    if (cycleHoldTimer.current !== null) {
      clearTimeout(cycleHoldTimer.current);
      cycleHoldTimer.current = null;
    }
  }

  function handleCyclePointerDown() {
    cycleDidHold.current = false;
    stopCycleRepeat();
    cycleHoldTimer.current = window.setTimeout(() => {
      cycleHoldTimer.current = null;
      cycleDidHold.current = true;
      cycleForward();
      cycleRepeatTimer.current = window.setInterval(cycleForward, CYCLE_REPEAT_MS);
    }, HOLD_MS);
  }

  function handleCyclePointerUp() {
    stopCycleRepeat();
  }

  function handleCycleClick(e: React.MouseEvent) {
    if (cycleDidHold.current) { cycleDidHold.current = false; return; }
    e.stopPropagation();
    cycleForward();
  }

  function handleCycleContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    stopCycleRepeat();
    cycleBackward();
  }

  // ── Layout cycle icon ────────────────────────────────────────────────────

  function LayoutIcon() {
    if (layoutMode === 'messenger') {
      // Two-column: narrow left rail + wide pane
      return (
        <svg viewBox="0 0 24 24">
          <rect x="3" y="4" width="18" height="16" rx="1.5" />
          <path d="M8 4v16" />
        </svg>
      );
    }
    if (layoutMode === 'zen') {
      // Centered narrow column
      return (
        <svg viewBox="0 0 24 24">
          <rect x="7" y="4" width="10" height="16" rx="1.5" />
        </svg>
      );
    }
    // full — header bar + vertical split
    return (
      <svg viewBox="0 0 24 24">
        <rect x="3" y="4" width="18" height="16" rx="1.5" />
        <path d="M3 9h18M11 9v11" />
      </svg>
    );
  }

  const layoutTitles: Record<string, string> = {
    full: 'Full layout',
    messenger: 'Messenger layout',
    zen: 'Zen layout',
  };

  return (
    <nav
      id="view-overlay"
      className="view-overlay"
      aria-label="View mode"
      data-pos={effectivePos}
      style={isVerticalPos ? { flexDirection: 'column' } : undefined}
    >
      {Array.from({ length: startSpacers }, (_, i) => (
        <div key={`vo-spacer-${i}`} className="vo-spacer" aria-hidden="true" />
      ))}

      <div className="vo-pill">
      {/* Split / H↔V button — full layout + workflow module only */}
      {isFullLayout && wfEnabled && (
        <button
          className={`vo-btn${viewMode === 'split' ? ' active' : ''}`}
          data-action="split"
          data-swap={viewSwap ? 'true' : 'false'}
          title="Split view — click to toggle H/V; hold to swap sides [Alt+X]"
          onClick={handleSplitClick}
          onPointerDown={handleSplitPointerDown}
          onPointerUp={cancelSplitHold}
          onPointerLeave={cancelSplitHold}
          onPointerCancel={cancelSplitHold}
        >
          <svg className="ico-split-h" viewBox="0 0 24 24" style={isV ? { display: 'none' } : undefined}>
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M12 4v16" />
          </svg>
          <svg className="ico-split-v" viewBox="0 0 24 24" style={isV ? undefined : { display: 'none' }}>
            <rect x="3" y="4" width="18" height="16" rx="2" />
            <path d="M3 12h18" />
          </svg>
        </button>
      )}

      {/* Workflow-only — full layout + workflow module only */}
      {isFullLayout && wfEnabled && (
        <button
          className={`vo-btn${viewMode === 'workflow' ? ' active' : ''}`}
          data-mode="workflow"
          title="Workflow only [Alt+G]"
          onClick={() => { getAppActions().setViewMode('workflow'); save.view(); }}
        >
          <svg viewBox="0 0 24 24">
            <circle cx="7" cy="7" r="2.5" />
            <circle cx="17" cy="17" r="2.5" />
            <circle cx="17" cy="7" r="2.5" />
            <path d="M9 7h6M8.5 8.5l7 7" />
          </svg>
        </button>
      )}

      {/* Code view — full layout only. Tabbed editor + bottom terminal/browser/debug
          + right-side files/github/rewind, with chat surviving in the left column.
          Implemented as a viewMode (sub-view of Full) so toggling Full ↔ Code does
          not remount ChatView. */}
      {isFullLayout && (
        <button
          className={`vo-btn${viewMode === 'code' ? ' active' : ''}`}
          data-mode="code"
          title="Code view"
          onClick={() => { getAppActions().setViewMode('code'); save.view(); }}
        >
          <svg viewBox="0 0 24 24">
            <path d="M8 6 3 12l5 6M16 6l5 6-5 6M14 4l-4 16" />
          </svg>
        </button>
      )}

      {/* Layout cycle button — always visible so you can return to chat from split/workflow */}
      {<button
        className={`vo-btn${viewMode === 'chat' ? ' active' : ''}`}
        data-action="layout-cycle"
        data-layout={layoutMode}
        title={`${layoutTitles[layoutMode] ?? layoutMode} — click: next layout; right-click: previous; hold: auto-cycle`}
        onClick={handleCycleClick}
        onContextMenu={handleCycleContextMenu}
        onPointerDown={handleCyclePointerDown}
        onPointerUp={handleCyclePointerUp}
        onPointerLeave={stopCycleRepeat}
        onPointerCancel={stopCycleRepeat}
      >
        <LayoutIcon />
      </button>}

      {/* 4-arrow position cluster */}
      <div
        className="vo-btn vo-pos-cluster"
        id="btn-overlay-pos"
        data-action="pos"
        title={`Overlay position (${overlayPos})`}
      >
        {(['top', 'right', 'bottom', 'left'] as const).map((pos) => (
          <button
            key={pos}
            type="button"
            className={`vo-pos-arrow${overlayPos === pos ? ' current' : ''}`}
            data-pos={pos}
            title={`Move overlay to ${pos}`}
            aria-label={pos.charAt(0).toUpperCase() + pos.slice(1)}
            onClick={() => { getAppActions().setOverlayPos(pos); save.view(); }}
          >
            {pos === 'top'    && <svg viewBox="0 0 24 24"><polygon points="12,6 18,16 6,16" /></svg>}
            {pos === 'right'  && <svg viewBox="0 0 24 24"><polygon points="18,12 8,6 8,18" /></svg>}
            {pos === 'bottom' && <svg viewBox="0 0 24 24"><polygon points="12,18 6,8 18,8" /></svg>}
            {pos === 'left'   && <svg viewBox="0 0 24 24"><polygon points="6,12 16,6 16,18" /></svg>}
          </button>
        ))}
      </div>

      {/* Menu / header toggle — full layout only */}
      {isFullLayout && (
        <button
          className={`vo-btn${headerOpen ? ' active' : ''}`}
          data-action="menu"
          data-header-orient={headerOrient}
          title="Menu [Alt+H]  •  hold: swap vertical ↔ horizontal bar"
          onClick={handleMenuClick}
          onPointerDown={handleMenuPointerDown}
          onPointerUp={cancelMenuHold}
          onPointerLeave={cancelMenuHold}
          onPointerCancel={cancelMenuHold}
        >
          <svg viewBox="0 0 24 24"><path d="M4 7h16M4 12h16M4 17h16" /></svg>
        </button>
      )}
      </div>

      {Array.from({ length: endSpacers }, (_, i) => (
        <div key={`vo-spacer-end-${i}`} className="vo-spacer" aria-hidden="true" />
      ))}
    </nav>
  );
}
