import { useEffect, useRef } from 'react';
import { useChatStore, useAppStore, useSessionStore } from '../stores/index.js';
import { runStatusAnim } from './chat-ui.js';

export function StatusIndicator() {
  const currentSession = useAppStore((s) => s.currentSession);
  const currentId = useSessionStore((s) => s.currentId);
  const streamKey = String(currentSession || currentId || 'default');
  const streamState = useChatStore((s) => s.sessionStreams[streamKey]);
  // Subscribe to the cached session entry too. If a session has never streamed
  // locally in this tab (fresh load, started in another tab, swap-in mid-run)
  // sessionStreams[streamKey] can be empty for the ~50–200 ms it takes
  // fetchList()'s reconcile loop to seed an entry — and longer on a slow
  // network. Falling back to the server-reported isRunning closes that gap so
  // the indicator stays visible while we catch up.
  const serverIsRunning = useSessionStore(
    (s) => s.sessions.find((sess) => String(sess.id) === streamKey)?.isRunning === true
  );
  const isRunning =
    !!(streamState && (streamState.localLive || streamState.reconnecting || streamState.serverActive)) ||
    serverIsRunning;
  const innerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isRunning) return;
    const el = innerRef.current;
    if (!el) return;
    const handle = runStatusAnim(el);
    return () => handle.stop();
  }, [isRunning, streamKey]);

  if (!isRunning) return null;
  return (
    <div className="chat-response-animation" aria-hidden="true">
      <div ref={innerRef} className="chat-response-animation-inner" />
    </div>
  );
}
