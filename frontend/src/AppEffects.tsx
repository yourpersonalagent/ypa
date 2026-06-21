// AppEffects — renders nothing, just wires store subscriptions to DOM side effects.
// This is the bridge between Zustand state and vanilla JS DOM elements that
// haven't been migrated to React components yet.

import { useEffect, useRef } from 'react';
import { useChatStore, useSessionStore, useAppStore, getAppState, getAppActions } from './stores/index.js';
import { resolveAvatarColor } from './color-themes-config.js';
import { chat } from './chat.js';
import { chatStreaming } from './chat/chat-streaming.js';
import { session } from './session.js';
import { wireServeSessionTracking, probeServeRuntimes } from './stores/serveStore.js';
import { whenBridgeModuleEnabled } from './host/bridge-modules.js';

export function AppEffects() {
  // Boot-time wiring for the per-CWD live-preview tool: start pushing
  // active-session updates to the bridge reaper, and probe which runtimes
  // (python/node/php) are installed so the picker can disable cards.
  // Deferred until the bridge confirms `files-serve-preview` is enabled —
  // otherwise these fetches 404 against a disabled module.
  useEffect(() => {
    return whenBridgeModuleEnabled('files-serve-preview', () => {
      wireServeSessionTracking();
      probeServeRuntimes();
    });
  }, []);

  // appStore.currentSession is the canonical session key — it's what
  // chatStreaming.setSessionStreamState() and updateStreamingUI() both
  // read via getAppState().currentSession. sessionStore.currentId is a
  // separate copy that some boot paths (session.getCurrentId() with no
  // localStorage) leave behind, so subscribing to it can cause the
  // streamState lookup to miss the entry that *was* written under
  // appStore.currentSession.
  const currentSession = useAppStore((s) => s.currentSession);
  const currentId = useSessionStore((s) => s.currentId);
  const sessions = useSessionStore((s) => s.sessions);
  // Match chatStreaming.ts's exact key derivation: `currentSession || 'default'`.
  const streamKey = String(currentSession || currentId || 'default');
  const streamState = useChatStore((s) => s.sessionStreams[streamKey]);
  const reconnectKeyRef = useRef('');
  // Tracks which currentId the dedup key was stored for. When we navigate
  // away and back, currentId goes A→B→A. The detach-before-setCurrentId race
  // (await markViewed sits between detachStream and setCurrentId) causes
  // AppEffects to fire with currentId=A and the detached state, setting the
  // key to "A:streaming:1". Without this guard, returning to A hits the same
  // key and returns early — stream never reconnects until reload.
  const reconnectKeyForIdRef = useRef<string | number | undefined>(undefined);

  // Sync session button text when session changes
  useEffect(() => {
    const session = sessions.find((s) => String(s.id) === String(currentId));

    // Update session button text to show current session name
    const btn = document.getElementById('chat-session-btn');
    if (btn) {
      if (session && session.name) {
        btn.textContent = session.name;
        btn.title = `Session: ${session.name} — switch session [Alt+S]`;
      } else if (currentId) {
        // currentId points at a session not in the store yet — typically
        // a fresh ghost from session.create() that hasn't been persisted.
        // Show the same name a ghost would carry so the button stays
        // consistent ("new chat" was the legacy placeholder and looked
        // like a regression to users).
        btn.textContent = 'New session';
        btn.title = 'New (unsaved) session — switch session [Alt+S]';
      } else {
        btn.textContent = 'sessions';
        btn.title = 'Switch session [Alt+S]';
      }
    }
  }, [currentId, sessions]);

  // Sync send/stop button visibility off the same store subscription that
  // <StatusIndicator /> uses, so both flip in lockstep. The animation itself
  // is fully owned by <StatusIndicator /> now — no DOM poking from here.
  useEffect(() => {
    try { chat?.updateStreamingUI?.(); } catch (_) {}
  }, [streamKey, streamState]);

  // When the active session has an active or replayable server stream but no
  // local connection, let the React bridge trigger reconnect instead of
  // session.ts doing it imperatively.
  useEffect(() => {
    if (!currentId || !streamState) return;
    if (streamState.localLive || streamState.reconnecting) {
      reconnectKeyRef.current = '';
      return;
    }

    const shouldReconnect =
      streamState.serverActive || streamState.status === 'done' || streamState.status === 'streaming';
    if (!shouldReconnect) return;

    const nextKey = `${currentId}:${streamState.status}:${streamState.serverActive ? '1' : '0'}`;
    // If the dedup key belongs to a different session visit, clear it so
    // switch-back always retriggers reconnect.
    if (reconnectKeyForIdRef.current !== currentId) reconnectKeyRef.current = '';
    if (reconnectKeyRef.current === nextKey) return;
    reconnectKeyRef.current = nextKey;
    reconnectKeyForIdRef.current = currentId;

    chat?.reconnectStream?.(String(currentId));
  }, [currentId, streamState]);

  // Visibility wakeup: when the user tabs back, the SessionPoller's 4 s
  // tick has been throttled (background tabs run intervals at ~1 Hz, then
  // freeze entirely) — so a session whose `_end` SSE chunk was dropped while
  // we were backgrounded would keep showing the typing animation until the
  // next poll tick after focus. Run a one-shot reconcile of the current
  // session synchronously on focus so the FE catches up immediately.
  useEffect(() => {
    function onVisible() {
      if (document.visibilityState !== 'visible') return;
      const sid = String(getAppState().currentSession || '');
      if (!sid) return;
      const local = useChatStore.getState().sessionStreams[sid];
      if (!local) return;
      if (!(local.localLive || local.reconnecting || local.serverActive)) return;
      // Refresh isRunning, then reconcile if the server says idle. fetchList
      // updates the sessions store; the reconcile call is a no-op if there's
      // an active POST controller (in-flight send), so this is safe to call
      // even on a freshly-started stream the bridge hasn't observed yet.
      (async () => {
        try { await session?.fetchList?.(); } catch (_) {}
        const sess = useSessionStore.getState().sessions.find((s) => String(s.id) === sid);
        if (sess?.isRunning) return;
        chatStreaming.reconcileFromPersisted(sid).catch(() => {});
      })();
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []);

  // Sync the #user-info-avatar in the sidebar header with the store's
  // userName + userSymbolColor. The signed-in user name is delivered async
  // by the inline /v1/me fetch via a 'yha:signedinuser' CustomEvent.
  const layoutMode = useAppStore((s) => s.layoutMode);
  useEffect(() => {
    function syncAvatar(): void {
      const av = document.getElementById('user-info-avatar');
      if (!av) return;
      const s = getAppState();
      const name = (s.userName || '').trim();
      const letter = ((name || 'U')[0] || 'U').toUpperCase();
      if (av.textContent !== letter) av.textContent = letter;
      const wantColor = s.userSymbolColor ? resolveAvatarColor(s.userSymbolColor) : '';
      if (wantColor) {
        if (av.style.color !== wantColor) av.style.color = wantColor;
      } else if (av.style.color) {
        av.style.removeProperty('color');
      }
    }
    function onSignedIn(e: Event) {
      const ce = e as CustomEvent<{ name?: string }>;
      const n = ce.detail?.name || '';
      if (n && n !== getAppState().userName) getAppActions().setUserName(n);
      else syncAvatar();
    }
    const stash = (window as unknown as { __yhaSignedInName?: string }).__yhaSignedInName;
    if (stash && stash !== getAppState().userName) getAppActions().setUserName(stash);

    syncAvatar();
    window.addEventListener('yha:signedinuser', onSignedIn);
    const unsub = useAppStore.subscribe((state, prev) => {
      if (state.userName !== prev.userName || state.userSymbolColor !== prev.userSymbolColor) syncAvatar();
    });
    return () => {
      window.removeEventListener('yha:signedinuser', onSignedIn);
      unsub();
    };
  // layoutMode dep: after a layout switch React commits a fresh #user-info-avatar
  // (inside the remounted FullLayout). The effect re-runs post-commit and re-applies
  // the letter/color to the new node — the store subscription fires too early
  // (before React commits) so it can't do this.
  }, [layoutMode]);

  return null;
}
