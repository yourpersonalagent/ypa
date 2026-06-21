// KeyboardShortcuts — global hotkey registrations in one place.
// Replaces scattered document.addEventListener('keydown', ...) calls as
// components migrate. Existing vanilla JS listeners coexist until removed.
//
// IMPORTANT: when you add or remove a hotkey here, update the static list
// rendered by ShortcutsModal.tsx so the user-visible cheat sheet stays in
// sync.

import { useHotkeys } from 'react-hotkeys-hook';
import { chat } from './chat.js';
import { colorTheme } from './color-theme.js';
import { composerMode } from './composer-mode.js';
import { layout } from './layout.js';
import { prefs } from './preferences.js';
import { useAppStore, getAppActions, getAppState, getToastActions } from './stores/index.js';
import { getSessionState } from './stores/sessionStore.js';
import { session } from './session.js';
import { registers } from './host/keys.js';
import { useRegisterList } from './host/useRegisterList.js';
import type { HotkeyBinding } from './host/keys.js';
import type { Entry } from './host/registers.js';

async function setRecentCwd(dir: string) {
  const sid = String(getSessionState().currentId || 'default');
  // session.setWorkingDir owns the PATCH + _cache + appStore sync. Without
  // the _cache update, the SessionPoller's 4 s tick would copy the stale
  // entry back over the freshly-set value — see session.ts.
  const d = await session.setWorkingDir(sid, dir);
  if (d.success) {
    const wd = d.workingDir || dir;
    getAppActions().addCwdToHistory(wd);
    getToastActions().show(wd, 'info', { title: 'Working dir' });
  } else {
    getToastActions().show(d.error || 'Failed to set directory', 'error', { title: 'Working dir' });
  }
}

export function KeyboardShortcuts() {
  // Alt+1 … Alt+5 — switch the current session's working directory to the
  // n-th entry in the recent-folders list (same list shown under "recent" in
  // the file picker). Silently no-ops if fewer than n entries exist.
  const cwdHistory = useAppStore((s) => s.cwdHistory);
  useHotkeys('alt+1', (e) => { e.preventDefault(); const d = cwdHistory[0]; if (d) setRecentCwd(d); }, { enableOnFormTags: ['textarea', 'input'] }, [cwdHistory]);
  useHotkeys('alt+2', (e) => { e.preventDefault(); const d = cwdHistory[1]; if (d) setRecentCwd(d); }, { enableOnFormTags: ['textarea', 'input'] }, [cwdHistory]);
  useHotkeys('alt+3', (e) => { e.preventDefault(); const d = cwdHistory[2]; if (d) setRecentCwd(d); }, { enableOnFormTags: ['textarea', 'input'] }, [cwdHistory]);
  useHotkeys('alt+4', (e) => { e.preventDefault(); const d = cwdHistory[3]; if (d) setRecentCwd(d); }, { enableOnFormTags: ['textarea', 'input'] }, [cwdHistory]);
  useHotkeys('alt+5', (e) => { e.preventDefault(); const d = cwdHistory[4]; if (d) setRecentCwd(d); }, { enableOnFormTags: ['textarea', 'input'] }, [cwdHistory]);

  // Alt+T (down) — start hold timer (cycles forward after 350ms).
  // Alt+T (up)   — if no hold engaged, this falls through to colorTheme.click()
  //                (variant flip); if hold engaged, locks in current family.
  // Mirrors the mouse left-click+hold behavior on #btn-theme exactly.
  useHotkeys(
    'alt+t',
    (e) => {
      e.preventDefault();
      if (e.repeat) return; // OS key-repeat would re-arm the hold timer
      colorTheme.holdStart('forward');
    },
    { keydown: true, keyup: false, enableOnFormTags: ['textarea', 'input'] }
  );
  useHotkeys(
    'alt+t',
    (e) => {
      e.preventDefault();
      colorTheme.holdEnd();
    },
    { keydown: false, keyup: true, enableOnFormTags: ['textarea', 'input'] }
  );

  // Alt+Shift+T — same as Alt+T but cycles backward (mirrors right-click+hold).
  useHotkeys(
    'alt+shift+t',
    (e) => {
      e.preventDefault();
      if (e.repeat) return;
      colorTheme.holdStart('backward');
    },
    { keydown: true, keyup: false, enableOnFormTags: ['textarea', 'input'] }
  );
  useHotkeys(
    'alt+shift+t',
    (e) => {
      e.preventDefault();
      colorTheme.holdEnd();
    },
    { keydown: false, keyup: true, enableOnFormTags: ['textarea', 'input'] }
  );

  // Alt+H — mirrors the menu button on the view-overlay:
  //   tap   = toggle header open/closed (same as a click).
  //   hold  ≥ ~450 ms = swap header orientation (vertical ↔ horizontal bar).
  useHotkeys(
    'alt+h',
    (e) => {
      e.preventDefault();
      if (e.repeat) return; // OS key-repeat would re-arm the hold timer
      layout.headerHoldStart();
    },
    { keydown: true, keyup: false, enableOnFormTags: ['textarea', 'input'] }
  );
  useHotkeys(
    'alt+h',
    (e) => {
      e.preventDefault();
      layout.headerHoldEnd();
    },
    { keydown: false, keyup: true, enableOnFormTags: ['textarea', 'input'] }
  );

  // Alt+← / Alt+→ — browser history back / forward.
  // Session IDs are written into the URL, so this navigates through recent chat sessions.
  useHotkeys(
    'alt+left',
    (e) => { e.preventDefault(); history.back(); },
    { enableOnFormTags: ['textarea', 'input'] }
  );
  useHotkeys(
    'alt+right',
    (e) => { e.preventDefault(); history.forward(); },
    { enableOnFormTags: ['textarea', 'input'] }
  );

  // Alt+C — mirrors the layout-cycle button:
  //   full + not-chat  → go to chat (same as button's first step)
  //   otherwise        → cycleForward() through layouts
  // Focus textarea whenever we end up in full-chat mode.
  useHotkeys(
    'alt+c',
    (e) => {
      e.preventDefault();
      const { layoutMode, viewMode } = getAppState();
      if (layoutMode === 'full' && viewMode !== 'chat') {
        layout.setMode('chat');
      } else {
        layout.cycleForward();
      }
      setTimeout(() => {
        const ta = document.getElementById('chat-ta') as HTMLTextAreaElement | null;
        ta?.focus();
      }, 0);
    },
    { enableOnFormTags: ['textarea', 'input'] }
  );

  // Alt+G — workflow-only view (the data-mode value used by the existing
  // overlay button is 'workflow', not 'graph' — keep it aligned).
  // (Sole owner of Alt+G — the duplicate registration that opened the
  //  Context Generator hub was moved to Alt+C 2026-05-06.)
  useHotkeys(
    'alt+g',
    (e) => {
      e.preventDefault();
      layout.setMode('workflow');
    },
    { enableOnFormTags: ['textarea', 'input'] }
  );

  // Alt+X (down) — start hold timer. Tap = toggleSplitOrient (enter split /
  // flip H↔V). Hold ≥ ~450 ms = swap chat ↔ workflow positions.
  useHotkeys(
    'alt+x',
    (e) => {
      e.preventDefault();
      if (e.repeat) return; // OS key-repeat would re-arm the hold timer
      layout.holdStart();
    },
    { keydown: true, keyup: false, enableOnFormTags: ['textarea', 'input'] }
  );
  useHotkeys(
    'alt+x',
    (e) => {
      e.preventDefault();
      layout.holdEnd();
    },
    { keydown: false, keyup: true, enableOnFormTags: ['textarea', 'input'] }
  );

  // Alt+P — open preferences modal.
  useHotkeys(
    'alt+p',
    (e) => {
      e.preventDefault();
      prefs.open();
    },
    { enableOnFormTags: ['textarea', 'input'] }
  );

  // Alt+Shift+P — open the shared user/agent terminal.
  useHotkeys(
    'alt+shift+p',
    (e) => {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('yha:open-bash-console'));
    },
    { enableOnFormTags: ['textarea', 'input'] }
  );

  // Alt+Shift+C — open the Context Generator hub.
  useHotkeys(
    'alt+shift+c',
    (e) => {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('yha:open-context-hub'));
    },
    { enableOnFormTags: ['textarea', 'input'] }
  );

  // Alt+K — open the shortcuts cheat sheet modal.
  useHotkeys(
    'alt+k',
    (e) => {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('yha:open-shortcuts'));
    },
    { enableOnFormTags: ['textarea', 'input'] }
  );

  // Alt+N — mirrors the "+" new-session button: tap = new session,
  //         hold ≥ 450 ms = new session in the same working directory.
  useHotkeys(
    'alt+n',
    (e) => {
      e.preventDefault();
      if (e.repeat) return; // OS key-repeat would re-arm the hold timer
      chat.newSessionHoldStart();
    },
    { keydown: true, keyup: false, enableOnFormTags: ['textarea', 'input'] }
  );
  useHotkeys(
    'alt+n',
    (e) => {
      e.preventDefault();
      chat.newSessionHoldEnd();
    },
    { keydown: false, keyup: true, enableOnFormTags: ['textarea', 'input'] }
  );

  // Alt+F — open the file picker.
  useHotkeys(
    'alt+f',
    (e) => {
      e.preventDefault();
      document.getElementById('chat-file')?.click();
    },
    { enableOnFormTags: ['textarea', 'input'] }
  );

  // Ctrl+Shift+F / Cmd+Shift+F — open the File Manager (server-side file
  // browser with mkdir / rename / move / copy / drag-upload / trash). The
  // FileManager component listens for this event and uses the current
  // session's working dir as the starting path.
  useHotkeys(
    'ctrl+shift+f, meta+shift+f',
    (e) => {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('yha:open-file-manager'));
    },
    { enableOnFormTags: ['textarea', 'input'] }
  );

  // Alt+S — open the session picker.
  useHotkeys(
    'alt+s',
    (e) => {
      e.preventDefault();
      document.getElementById('chat-session-btn')?.click();
    },
    { enableOnFormTags: ['textarea', 'input'] }
  );

  // Alt+M — open the model picker.
  useHotkeys(
    'alt+m',
    (e) => {
      e.preventDefault();
      document.getElementById('chat-model-btn')?.click();
    },
    { enableOnFormTags: ['textarea', 'input'] }
  );

  // Ctrl+Alt+M (down) — start hold timer. Tap = advance one composer mode
  // (chat → image → audio → video → chat). Hold ≥ 350 ms = auto-cycle.
  useHotkeys(
    'ctrl+alt+m',
    (e) => {
      e.preventDefault();
      if (e.repeat) return;
      composerMode.holdStart();
    },
    { keydown: true, keyup: false, enableOnFormTags: ['textarea', 'input'] }
  );
  useHotkeys(
    'ctrl+alt+m',
    (e) => {
      e.preventDefault();
      composerMode.holdEnd();
    },
    { keydown: false, keyup: true, enableOnFormTags: ['textarea', 'input'] }
  );

  // Alt+V — toggle voice assistant (continuous conversation mode).
  useHotkeys(
    'alt+v',
    (e) => {
      e.preventDefault();
      window.dispatchEvent(new CustomEvent('yha:voice-mode-open'));
    },
    { enableOnFormTags: ['textarea', 'input'] }
  );

  // Alt+B (open remote desktop browser) is registered by the
  // `remote-browser` module via host.registers.hotkeys.add(...).

  // Escape — dismiss any open React-managed overlay (vanilla JS handles its own popups)
  useHotkeys(
    'escape',
    () => {
      window.dispatchEvent(new CustomEvent('yha:escape'));
    },
    { enableOnFormTags: true }
  );

  // ── Module-registered hotkeys ──────────────────────────────────────────
  // Modules can add their own hotkeys via:
  //   host.registers.hotkeys.add({ id, keys, handler, ... }, MODULE_NAME);
  // Each entry mounts a small subcomponent so useHotkeys can be called once
  // per binding without violating the rules of hooks (no loops over hooks).
  const moduleHotkeys = useRegisterList(registers.hotkeys);
  return (
    <>
      {moduleHotkeys.map((entry) => (
        <RegisteredHotkey key={entry.id} entry={entry} />
      ))}
    </>
  );
}

function RegisteredHotkey({ entry }: { entry: Entry<HotkeyBinding> }) {
  useHotkeys(
    entry.keys,
    (e) => entry.handler(e),
    { enableOnFormTags: entry.enableInInputs ?? false },
    []
  );
  return null;
}
