// UserInfoHeaderButton — extracted from `Shell.tsx` so the
// `headerIconButtons` register can carry the popover as a single
// component entry. Behaviour identical to the previous inline JSX:
// avatar button toggles the popover; clicking outside closes it.
//
// Owns its user data (name/email/id) to survive layout remounts.
// On mount, reads from window.__yhaSignedInUser (set by SignedInUser
// once /v1/me resolves). When that stash is empty, listens to the
// yha:signedinuser window event so a slow /v1/me still populates the
// popover when the response lands.

import { useState, useRef, useEffect } from 'react';

interface UserData { name: string; email: string; id: string }

function readStash(): UserData | null {
  return (typeof window !== 'undefined' && window.__yhaSignedInUser) || null;
}

export function UserInfoHeaderButton() {
  const [open, setOpen] = useState(false);
  const [userData, setUserData] = useState<UserData | null>(readStash);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [open]);

  // Populate user data from the window stash (survives any remount) and
  // from the yha:signedinuser event for the initial-load race where the
  // component mounts before /v1/me resolves.
  useEffect(() => {
    const stash = readStash();
    if (stash) { setUserData(stash); return; }

    const onSignedIn = (e: Event) => {
      const ce = e as CustomEvent<{ name?: string; email?: string; id?: string }>;
      const d: UserData = {
        name: ce.detail?.name || '',
        email: ce.detail?.email || '',
        id: ce.detail?.id || '',
      };
      window.__yhaSignedInUser = d;
      setUserData(d);
    };
    window.addEventListener('yha:signedinuser', onSignedIn);
    return () => window.removeEventListener('yha:signedinuser', onSignedIn);
  }, []);

  return (
    <div
      ref={ref}
      className={`hs-section${open ? ' hs-open' : ''}`}
      id="hs-user-info"
    >
      <button
        className={`hm-item hs-toggle user-info-toggle${open ? ' hs-open' : ''}`}
        id="btn-user-info"
        title="Signed-in user — click for details"
        onClick={() => setOpen((v) => !v)}
      >
        <span id="user-info-avatar">U</span>
      </button>
      <div
        className={`hs-body hs-body-user-info${open ? ' hs-open' : ''}`}
        id="user-info-panel"
      >
        <div className="user-info-body">
          <span id="user-info-name">{userData?.name ?? ''}</span>
          <span id="user-info-email">{userData?.email ?? ''}</span>
          <div className="user-info-actions">
            <a id="user-info-logout" href="/auth/logout" title="Sign out">logout</a>
            <a id="user-info-switch" href="/auth/logout?switch=1" title="Switch to another account">switch account</a>
          </div>
          <span id="user-info-id">{userData?.id ?? ''}</span>
        </div>
      </div>
    </div>
  );
}
