// YHA frontend entry point — boots the app by importing all modules and
// calling boot(). Zustand stores are the single source of truth for state;
// modules import each other directly via ESM.

import { useAppStore } from './stores/appStore.js';
import { useGraphStore } from './stores/graphStore.js';
import { getToastActions } from './stores/toastStore.js';
import { useConnectionStore } from './stores/connectionStore.js';
import { initShiki } from './vendor.js';
import { installNetMetrics, startFeSnapshotPusher } from './util/net-metrics.js';
import { useInputHistoryStore } from './stores/inputHistoryStore.js';

// Wrap fetch + EventSource at module init so the #debug monitoring panel can
// tally total bytes / per-endpoint hits across the whole app.
installNetMetrics();
// Periodically POST FE counters to /v1/debug/snapshot/fe so the bridge can
// interleave them with its own snapshots in monitoring-log/*.ndjson — single
// grep-able file across both sides for debugging-by-chat.
startFeSnapshotPusher();
import { restore } from './state.js';
import { store } from './store.js';
import { colorTheme } from './color-theme.js';
import { designTheme } from './design-theme.js';
import { applyBrandToDom } from './branding.js';
import { toast } from './toast.js';
import { editor } from './workflows/editor.js';
import { session } from './session.js';
import { chat } from './chat.js';
import { commands } from './commands.js';
import { workflow } from './workflows/workflow.js';
import { triggers } from './panels/triggers.js';
import { prefs } from './preferences.js';
import { fetchBridgeModulesOnce, isBridgeModuleEnabled } from './host/bridge-modules.js';

// ── Boot sequence ─────────────────────────────────────────────────────────────

const PENDING_HASH_KEY = 'yha.pendingHash';

function _stashHashForLogin(): void {
  // Hashes don't survive cross-origin OAuth bounces. Stash so we can restore
  // after the user comes back from login.
  try {
    if (window.location.hash) {
      sessionStorage.setItem(PENDING_HASH_KEY, window.location.hash);
    }
  } catch (_) {}
}

function _restoreHashAfterLogin(): void {
  try {
    const pending = sessionStorage.getItem(PENDING_HASH_KEY);
    if (!pending) return;
    sessionStorage.removeItem(PENDING_HASH_KEY);
    if (window.location.hash) return; // user already navigated somewhere with a hash
    history.replaceState(
      null,
      '',
      window.location.pathname + window.location.search + pending
    );
  } catch (_) {}
}

function _redirectToLogin(): void {
  _stashHashForLogin();
  window.location.replace('/');
}

async function ensureAuthenticated() {
  try {
    const res = await fetch('/v1/me');
    if (res.status === 401) {
      _redirectToLogin();
      return false;
    }
    if (!res.ok) {
      _redirectToLogin();
      return false;
    }
    const me = await res.json().catch(() => null);
    // When auth is disabled the server returns {} (no id field at all).
    // Only redirect when the response has content but is missing a valid user.
    if (me && Object.keys(me).length > 0 && !me.id) {
      _redirectToLogin();
      return false;
    }
  } catch (_) {
    // Leave network failures to the normal boot path.
  }
  return true;
}

async function boot() {
  // Body starts collapsed (yha.html inline script + connectionStore initial
  // state 'booting'). On auth failure we redirect, leaving the page collapsed —
  // which matches the bounce. On success, we flip to 'booted' at the end to
  // play the analog-TV reverse reveal.
  if (!(await ensureAuthenticated())) return;

  // Auth passed — if we stashed a hash before bouncing through login, put it back.
  _restoreHashAfterLogin();

  // Hydrate Zustand stores from legacy state (which has been populated by app.js
  // and the prefs store)
  useAppStore.getState().hydrateFromLegacy();
  useGraphStore.getState().hydrateFromLegacy();

  // Fetch server prefs before any module init() — modules read from store/app.state
  await store.load();

  // Pull bridge module state — gates workflow.init() / triggers.init() below
  // and the App-side conditional renders. Idempotent with the parallel fetch
  // kicked off by App.tsx → activateEnabledModules().
  await fetchBridgeModulesOnce();

  // Fire-and-forget — shikiHighlightElement returns early when shiki=null,
  // so highlight calls before this resolves are safe no-ops.
  void initShiki();

  // Re-hydrate after server prefs loaded
  useAppStore.getState().hydrateFromLegacy();

  // Init all modules
  colorTheme.init();
  designTheme.init();
  applyBrandToDom();
  toast.init();

  // Bridge toast → Zustand toastStore so <ToastStack /> renders reactively.
  // toast.ts._wire() calls toast.show/dismiss, which now go through the store.
  const _toastActions = getToastActions();
  toast.show = _toastActions.show.bind(_toastActions);
  toast.dismiss = _toastActions.dismiss.bind(_toastActions);
  toast.clear = _toastActions.clear.bind(_toastActions);

  // WorkflowEditor (lazy-loaded React component) may not have mounted yet, so
  // set the gate flag here before editor.init() so editor.ts skips its own
  // DOM event registration and render path.
  const _editorRoot = document.getElementById('editor-root');
  if (_editorRoot) _editorRoot.dataset.react = '1';
  const wfEnabled = isBridgeModuleEnabled('workflows-and-triggers');
  if (wfEnabled) editor.init();
  chat.init();
  commands.init();
  if (wfEnabled) {
    workflow.init();
    triggers.init();
  }
  prefs.init();

  // Merge local + server input history so ArrowUp recalls entries typed on
  // other devices. Fire-and-forget — the persist middleware has already
  // hydrated localStorage by now, so the UI is responsive immediately.
  void useInputHistoryStore.getState().hydrateFromServer();

  // Restore persisted graph state from localStorage first.
  // Chat history is loaded authoritatively via session.switchTo(); restoring and
  // rendering it here fights the React MessageList ownership of #chat-scroll.
  restore.graph();
  if (wfEnabled) editor.render();

  // Initialise hash routing so browser back/forward + bookmarks work.
  session.initHashRouting();

  // Pick the initial session: URL hash (#s/<id>) wins over localStorage.
  // Validate that the hashed session actually exists server-side before using
  // it; otherwise a stale bookmark would land the user on an empty ghost.
  let initialSid = session.getCurrentId();
  const hashSid = session.parseHashSession();
  if (hashSid) {
    await session.fetchList();
    if (session.sessionExists(hashSid)) initialSid = hashSid;
  }

  // Load authoritative server state, then reconnect to any active stream.
  // Use 'replace' so we don't leave a phantom history entry behind the boot URL.
  await session.switchTo(initialSid, { historyMode: 'replace' });

  // workflow init() registered subscriptions; _afterBoot picks up the last
  // active workflow once the rest of boot is finished.
  if (wfEnabled) workflow._afterBoot();

  // Reveal: flip 'booting' → 'booted' so ShutdownOverlay removes body.tv-off
  // (CSS expand) and plays the reverse scanline once. It auto-clears to
  // 'online' after RESTORED_HOLD_MS.
  useConnectionStore.getState().setStatus('booted');
}

boot().catch((err) => {
  console.error(err);
  // Don't leave the page collapsed if something throws after auth.
  try {
    const cur = useConnectionStore.getState().status;
    if (cur === 'booting') useConnectionStore.getState().setStatus('booted');
  } catch (_) {}
});
