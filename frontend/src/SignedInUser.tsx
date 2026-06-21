// SignedInUser — populates the #user-info block (name/email/id) by hitting
// /v1/me on first mount. Replaces the inline post-load <script> that used to
// live at the bottom of yha.html.

import { useEffect } from 'react';

interface MeResponse {
  email?: string;
  name?: string;
  id?: string;
}

declare global {
  interface Window {
    __yhaSignedInName?: string;
    __yhaSignedInUser?: { name: string; email: string; id: string };
  }
}

export function SignedInUser() {
  useEffect(() => {
    // One-time cleanup for older installs that still have the previous service worker.
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker
        .getRegistrations()
        .then((regs) => Promise.all(regs.map((reg) => reg.unregister())))
        .catch(() => {});
    }

    fetch('/v1/me')
      .then((r) => (r.ok ? r.json() : ({} as MeResponse)))
      .then((u: MeResponse) => {
        if (!u.email) return;
        const nameEl = document.getElementById('user-info-name');
        const emailEl = document.getElementById('user-info-email');
        const idEl = document.getElementById('user-info-id');
        const userInfo = document.getElementById('user-info') || document.getElementById('hs-user-info');
        if (nameEl) nameEl.textContent = u.name || '';
        if (emailEl) emailEl.textContent = u.email || '';
        if (idEl) idEl.textContent = u.id || '';
        userInfo?.removeAttribute('hidden');
        window.__yhaSignedInName = u.name || '';
        window.__yhaSignedInUser = { name: u.name || '', email: u.email || '', id: u.id || '' };
        window.dispatchEvent(
          new CustomEvent('yha:signedinuser', {
            detail: { name: u.name || '', email: u.email || '', id: u.id || '' },
          }),
        );
      })
      .catch(() => {});
  }, []);

  return null;
}
