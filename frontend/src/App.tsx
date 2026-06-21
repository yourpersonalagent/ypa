import { lazy, Suspense, useEffect } from 'react';
import { Shell } from './Shell.js';
import { ErrorBoundary } from './ErrorBoundary.js';
import { BgEffect } from './BgEffect.js';
import { SignedInUser } from './SignedInUser.js';
import { AppEffects } from './AppEffects.js';
import { SessionPoller } from './SessionPoller.js';
import { ConnectionMonitor } from './ConnectionMonitor.js';
import { ShutdownOverlay } from './ShutdownOverlay.js';
import { KeyboardShortcuts } from './KeyboardShortcuts.js';
import { ShortcutsModal } from './ShortcutsModal.js';
import { ColorThemeToggle } from './ColorThemeToggle.js';
import { LayoutAttribute } from './layouts/LayoutAttribute.js';
import { GlobalAppCommandPalette } from './pickers/GlobalAppCommandPalette.js';
import { ToastStack } from './ToastStack.js';
import { ConfirmModal } from './ConfirmModal.js';
import { EffortSelector } from './pickers/EffortSelector.js';
import { SessionPicker } from './SessionPicker.js';
import { ContextHub } from './context/ContextHub.js';
import { ModelBadge } from './pickers/ModelBadge.js';
import { ModelPicker } from './pickers/ModelPicker.js';
import { NodeOverlay } from './workflows/NodeOverlay.js';
import { CapabilityBadges } from './pickers/CapabilityBadges.js';
import { AttachmentStrip } from './chat/AttachmentStrip.js';
import { ChatEmptyBg } from './chat/ChatEmptyBg.js';
// ChatEmptyGreeting + ChatHeroGrowl moved into the welcome-messages
// module. They render via <PanelSlot id="chat-empty-greeting"/> and
// <PanelSlot id="chat-hero-growl"/> below.
import { MessageList } from './chat/MessageList.js';
import { PanelSlot } from './host/slots/PanelSlot.js';
import { activateEnabledModules } from './host/enabled-modules.js';
import { useBridgeModuleEnabled } from './host/bridge-modules.js';
import { registerCorePrefsTabs } from './host/bootstrap-core-prefs-tabs.js';
import { registerCoreAppCommands } from './host/bootstrap-core-commands.js';
import { registerCorePrefsEntries } from './host/bootstrap-core-prefs-entries.js';
import { Tutorial, registerTutorial } from './tutorial/index.js';

// Register the core prefs tabs exactly once (idempotent). Modules
// extend this set later via host.registers.prefsTabs.add(...).
registerCorePrefsTabs();

// Seed the `/` App Command Palette registry with layout / color-theme /
// view / panel / header / prefs commands. Modules contribute their own
// commands via `host.registers.appCommands.add(...)` in their activate().
registerCoreAppCommands();

// Seed the `prefsEntries` register with a few core settings (layout,
// color theme, enter-to-send, header visibility/orientation). Modules
// contribute their own entries via host.registers.prefsEntries.add(...).
// Phase 4 of LayoutPlan.md.
registerCorePrefsEntries();

// Register the `/tutorial` app command and arm the first-run guided tour.
// The overlay is mounted as <Tutorial/> below.
registerTutorial();

// Kick off bridge-module discovery + activate enabled FE modules.
// async — fire-and-forget; the components below subscribe to the
// store and re-render when /v1/modules resolves.
void activateEnabledModules();
// PersonnelPanel and PartnerPanel are now rendered inline by their
// HeaderSection registrations (bootstrap-core-header-sections.tsx) — no
// separate App-level mount.
// DebugModal moved into the observability-plus module. Mounts via
// <PanelSlot id="observability-plus-debug-modal" /> below.
import { ChatInput } from './chat/ChatInput.js';
import { SysPromptEditor } from './pickers/SysPromptEditor.js';
import { ForgeBar } from './forge-bar/ForgeBar.js';
// Heavy portal components — code-split into separate async chunks.
// All use createPortal so the Suspense fallback (null) is invisible to the user.
// FileManager → owned by `files-manager` module (PanelSlot id="files-manager-modal")
// BrowserWindow → owned by `remote-browser` module (PanelSlot id="remote-browser-modal")
// RcloneModal   → owned by `files-rclone` module    (PanelSlot id="files-rclone-modal")
// QuickContextPicker → owned by `context` module    (PanelSlot id="context-quick-picker")
// QuickRagPicker     → owned by `context-generator` module (PanelSlot id="context-rag-quick-picker")
const FilePicker     = lazy(() => import('./modals/FilePicker.js').then(m => ({ default: m.FilePicker })));
const FileEditor     = lazy(() => import('./modules/files-editor/FileEditor.js').then(m => ({ default: m.FileEditor })));
const PrefsModal     = lazy(() => import('./prefs/PrefsModal.js').then(m => ({ default: m.PrefsModal })));
const WorkflowEditor = lazy(() => import('./workflows/WorkflowEditor.js').then(m => ({ default: m.WorkflowEditor })));
const ServePreview   = lazy(() => import('./modals/ServePreview.js').then(m => ({ default: m.ServePreview })));
const BashConsole    = lazy(() => import('./modals/BashConsole.js').then(m => ({ default: m.BashConsole })));

export function App() {
  // Gate non-modular FE features by their backing bridge module's enabled bit.
  // Subscribed via the Zustand store so a /v1/modules refresh re-renders.
  // personnel/partners use the *strict* variant so their initial fetches
  // (/v1/employees, /v1/partners) don't fire during the bridge-module
  // unknown→loaded transition for users who have those modules disabled.
  const wfEnabled       = useBridgeModuleEnabled('workflows-and-triggers');

  // Rewind-watchdog heartbeat. The inline script in yha.html arms a 30s
  // timer at page-load; we bump this counter on mount and every 5s to
  // signal that React's render loop is alive. If the page bundle is
  // broken (or the JS chunk failed to load entirely) the counter stays
  // at zero and the watchdog injects the recovery overlay.
  useEffect(() => {
    const w = window as unknown as { __YPA_HEARTBEAT?: number };
    w.__YPA_HEARTBEAT = (w.__YPA_HEARTBEAT ?? 0) + 1;
    const id = setInterval(() => {
      w.__YPA_HEARTBEAT = (w.__YPA_HEARTBEAT ?? 0) + 1;
    }, 5000);
    return () => clearInterval(id);
  }, []);

  return (
    <>
      {/* Static page structure (header, main views, popovers, modal hosts) */}
      <Shell />

      {/* Infrastructure — render nothing, manage side effects */}
      <BgEffect />
      <SignedInUser />
      <ColorThemeToggle />
      <LayoutAttribute />
      <GlobalAppCommandPalette />
      <AppEffects />
      <KeyboardShortcuts />
      <ShortcutsModal />
      <ModelBadge />
      <CapabilityBadges />
      <SessionPoller />
      <ConnectionMonitor />
      <ErrorBoundary label="knowledge-wiring"><PanelSlot id="knowledge-wiring" /></ErrorBoundary>
      <ErrorBoundary label="observability-plus-debug-modal"><PanelSlot id="observability-plus-debug-modal" /></ErrorBoundary>
      <ErrorBoundary label="todos-modal"><PanelSlot id="todos-modal" /></ErrorBoundary>
      <ErrorBoundary label="files-github-modal"><PanelSlot id="files-github-modal" /></ErrorBoundary>
      <ErrorBoundary label="files-rclone-modal"><PanelSlot id="files-rclone-modal" /></ErrorBoundary>

      {/* Portals — render into existing DOM containers. Each is wrapped in
          its own ErrorBoundary so a stale-portal-target failure in one
          component (insertBefore on disconnected node) doesn't unmount the
          whole tree and cascade null-deref errors into vanilla init() calls. */}
      <ErrorBoundary label="ToastStack"><ToastStack /></ErrorBoundary>
      <ErrorBoundary label="ConfirmModal"><ConfirmModal /></ErrorBoundary>
      <ErrorBoundary label="EffortSelector"><EffortSelector /></ErrorBoundary>
      <ErrorBoundary label="SessionPicker"><SessionPicker /></ErrorBoundary>
      <ErrorBoundary label="context-quick-picker"><PanelSlot id="context-quick-picker" /></ErrorBoundary>
      <ErrorBoundary label="context-rag-quick-picker"><PanelSlot id="context-rag-quick-picker" /></ErrorBoundary>
      <ErrorBoundary label="ContextHub"><ContextHub /></ErrorBoundary>
      <ErrorBoundary label="pet-console-bubble"><PanelSlot id="pet-console-bubble" /></ErrorBoundary>
      <ErrorBoundary label="AttachmentStrip"><AttachmentStrip /></ErrorBoundary>
      <ErrorBoundary label="ChatEmptyBg"><ChatEmptyBg /></ErrorBoundary>
      <ErrorBoundary label="chat-empty-greeting"><PanelSlot id="chat-empty-greeting" /></ErrorBoundary>
      <ErrorBoundary label="chat-hero-growl"><PanelSlot id="chat-hero-growl" /></ErrorBoundary>
      <ErrorBoundary label="ChatInput"><ChatInput /></ErrorBoundary>
      <ErrorBoundary label="SysPromptEditor"><SysPromptEditor /></ErrorBoundary>
      <ErrorBoundary label="ModelPicker"><ModelPicker /></ErrorBoundary>
      <ErrorBoundary label="voice-mode-overlay"><PanelSlot id="voice-mode-overlay" /></ErrorBoundary>
      <ErrorBoundary label="pet-gallery-modal"><PanelSlot id="pet-gallery-modal" /></ErrorBoundary>
      <ErrorBoundary label="pet-frame-nudge-modal"><PanelSlot id="pet-frame-nudge-modal" /></ErrorBoundary>
      {wfEnabled && <ErrorBoundary label="NodeOverlay"><NodeOverlay /></ErrorBoundary>}

      {/* Heavy portal components — lazy-loaded, invisible until their chunk arrives */}
      <Suspense fallback={null}>
        <FilePicker />
        <FileEditor />
        <PanelSlot id="files-manager-modal" />
        <PrefsModal />
        {wfEnabled && <WorkflowEditor />}
        <PanelSlot id="remote-browser-modal" />
        <ServePreview />
        <BashConsole />
        <PanelSlot id="floating-pet" />
        <PanelSlot id="pet-hatch-modal" />
      </Suspense>

      <ErrorBoundary label="MessageList"><MessageList /></ErrorBoundary>
      <ErrorBoundary label="chat-minimap"><PanelSlot id="chat-minimap" /></ErrorBoundary>

      {/* Forge bar — conditional chrome, layout-agnostic.
          Shows only on module failure or recent edit; nil pixels at rest. */}
      <ErrorBoundary label="ForgeBar"><ForgeBar /></ErrorBoundary>

      {/* Guided tour overlay — inert until started (first-run or /tutorial) */}
      <ErrorBoundary label="Tutorial"><Tutorial /></ErrorBoundary>

      {/* Visible React UI */}
      <ShutdownOverlay />
    </>
  );
}
