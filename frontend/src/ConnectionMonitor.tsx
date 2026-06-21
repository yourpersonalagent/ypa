// ConnectionMonitor — heartbeat against /v1/me to detect server restarts.
// Pure side-effect component (renders nothing). Drives connectionStore which
// in turn drives ShutdownOverlay.
//
// Detection rules:
//   - 200            → status 'online' (or 'restored' if we were 'lost')
//   - 401            → status 'unauthorized' (overlay handles login redirect)
//   - network err / 5xx → bump fail counter; ≥2 in a row → status 'lost'
//
// We poll every 5s. /v1/me is cheap and already used at boot (see main.ts:60).
//
// Debug: window.yhaShutdown.{lost,restored,online,unauthorized}() lets you
// trigger the overlay from the DevTools console without stopping the server.

import { useEffect, useRef } from 'react';
import { useConnectionStore, type ConnectionStatus } from './stores/connectionStore.js';

const POLL_INTERVAL_MS = 5_000;
const FAIL_THRESHOLD = 2;

// One-time install of the debug hook on window. Idempotent.
function installDebugHook(): void {
  const w = window as unknown as { yhaShutdown?: Record<string, () => void> };
  if (w.yhaShutdown) return;
  const trigger = (s: ConnectionStatus) => () => useConnectionStore.getState().setStatus(s);
  w.yhaShutdown = {
    lost: trigger('lost'),
    restored: trigger('restored'),
    online: trigger('online'),
    unauthorized: trigger('unauthorized'),
    booting: trigger('booting'),
    booted: trigger('booted'),
  };
}

export function ConnectionMonitor() {
  const failCountRef = useRef(0);
  const inFlightRef = useRef(false);

  useEffect(() => {
    installDebugHook();
    let cancelled = false;

    async function ping() {
      if (inFlightRef.current) return;
      // Boot path owns the state machine until it settles to 'online' or
      // a downstream state — don't let a heartbeat clobber the reveal.
      const cur = useConnectionStore.getState().status;
      if (cur === 'booting' || cur === 'booted') return;
      inFlightRef.current = true;
      try {
        const res = await fetch('/v1/me', {
          method: 'GET',
          cache: 'no-store',
          credentials: 'same-origin',
        });
        if (cancelled) return;
        const { status, setStatus } = useConnectionStore.getState();

        if (res.status === 401) {
          setStatus('unauthorized');
          return;
        }
        if (!res.ok) {
          // Treat 5xx like a network failure
          failCountRef.current += 1;
          if (failCountRef.current >= FAIL_THRESHOLD && status !== 'lost') {
            setStatus('lost');
          }
          return;
        }
        // Success
        failCountRef.current = 0;
        if (status === 'lost') {
          setStatus('restored');
        } else if (status !== 'online' && status !== 'restored') {
          setStatus('online');
        }
      } catch (_err) {
        if (cancelled) return;
        const { status, setStatus } = useConnectionStore.getState();
        failCountRef.current += 1;
        if (failCountRef.current >= FAIL_THRESHOLD && status !== 'lost') {
          setStatus('lost');
        }
      } finally {
        inFlightRef.current = false;
      }
    }

    const id = setInterval(ping, POLL_INTERVAL_MS);
    // Don't ping immediately on mount — boot already validated /v1/me.

    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return null;
}
