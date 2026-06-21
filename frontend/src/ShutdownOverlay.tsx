// ShutdownOverlay — analog-TV switch-off effect when the server is unreachable,
// and the matching switch-on reveal on initial page load.
// Reads connectionStore.status; toggles `body.tv-off` to drive the CSS animation
// in shutdown.css. Renders a centered status text on top of the bg-canvas
// (which is left untouched by the TV-off transform — see shutdown.css selector).
//
// Auto-recovery: when status flips 'lost' → 'restored', show a brief
// "Reconnected" message, run the reverse animation, then clear back to
// 'online' so the overlay unmounts.
//
// Boot reveal: status starts as 'booting' (body collapsed, no overlay UI);
// main.ts flips to 'booted' once boot completes, which plays the reverse
// scanline (no message) and auto-clears to 'online'.

import { useEffect, useRef, useState } from 'react';
import { useConnectionStore } from './stores/connectionStore.js';

const RESTORED_HOLD_MS = 700;

export function ShutdownOverlay() {
  const status = useConnectionStore((s) => s.status);
  const setStatus = useConnectionStore((s) => s.setStatus);

  // Drive the TV-off body class. Removing it triggers the reverse animation.
  // 'unauthorized' keeps the collapse: we're about to redirect to /, and
  // un-revealing stale content for the 400ms hold would just flash old UI.
  useEffect(() => {
    const cls = document.body.classList;
    if (status === 'lost' || status === 'booting' || status === 'unauthorized') {
      cls.add('tv-off');
    } else {
      cls.remove('tv-off');
    }
    return () => {
      // Don't strip on unmount in development hot-reload — the next mount
      // will re-evaluate. Only strip when status is no longer collapsed.
    };
  }, [status]);

  // After the brief 'restored' or 'booted' reveal, drop back to 'online' so
  // the overlay unmounts entirely.
  useEffect(() => {
    if (status !== 'restored' && status !== 'booted') return;
    const t = window.setTimeout(() => {
      // Guard: only flip if still in the reveal state (heartbeat may have advanced)
      const cur = useConnectionStore.getState().status;
      if (cur === 'restored' || cur === 'booted') {
        setStatus('online');
      }
    }, RESTORED_HOLD_MS);
    return () => window.clearTimeout(t);
  }, [status, setStatus]);

  // Hard redirect to the login page on auth failure. Keeps the URL hash
  // intact so the user lands back on the same session after re-auth.
  useEffect(() => {
    if (status !== 'unauthorized') return;
    // Stash the hash like main.ts does, so OAuth bounce restores it.
    try {
      if (window.location.hash) {
        sessionStorage.setItem('yha.pendingHash', window.location.hash);
      }
    } catch (e) {
      console.warn('[ShutdownOverlay] sessionStorage unavailable:', e);
    }
    // Brief delay so the user sees the TV-off transition before the bounce.
    const t = window.setTimeout(() => window.location.replace('/'), 400);
    return () => window.clearTimeout(t);
  }, [status]);

  if (status === 'online') return null;
  // 'booting' keeps the body collapsed via the class effect above. The
  // reveal animation is owned by 'booted'; here we just surface a tiny
  // bottom-center counter so the 3–5s gap doesn't look frozen.
  if (status === 'booting') return <BootProgress />;

  const message =
    status === 'restored'
      ? 'Reconnected'
      : status === 'unauthorized'
        ? 'Session closed — redirecting to login ...'
        : status === 'booted'
          ? ''
          : 'No response from server, reconnecting ...';

  return (
    <div
      className={`shutdown-overlay shutdown-${status}`}
      role="status"
      aria-live="polite"
    >
      <div className="shutdown-line" aria-hidden="true" />
      <div className="shutdown-msg">{message}</div>
    </div>
  );
}

// Bulk of boot time is server work, not bytes — the real fetch counter shows
// ~2 kb after 2 s, which reads as "stuck". Use a perceptual progress curve
// instead: an asymptotic ramp toward TOTAL_MB that feels fast early and slows
// near the end, so the user sees motion that maps to "we're working."
const FAKE_TOTAL_MB = 9.8;
const FAKE_TAU_S = 1.6;

function BootProgress() {
  const t0Ref = useRef<number>(performance.now());
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 100);
    return () => window.clearInterval(id);
  }, []);

  void tick; // re-render driver
  const elapsed = (performance.now() - t0Ref.current) / 1000;
  const loadedMb = FAKE_TOTAL_MB * (1 - Math.exp(-elapsed / FAKE_TAU_S));
  const pct = Math.min(0.99, loadedMb / FAKE_TOTAL_MB);

  return (
    <div className="shutdown-overlay shutdown-booting" role="status" aria-live="polite">
      <div className="boot-progress">
        <div className="boot-progress-text">
          {elapsed.toFixed(1)}s · {loadedMb.toFixed(1)} / {FAKE_TOTAL_MB.toFixed(1)} mb
        </div>
        <div className="boot-progress-bar" aria-hidden="true">
          <div
            className="boot-progress-fill"
            style={{ width: `${(pct * 100).toFixed(1)}%` }}
          />
          <div className="boot-progress-shimmer" />
        </div>
      </div>
    </div>
  );
}
