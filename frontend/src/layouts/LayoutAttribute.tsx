// LayoutAttribute — React-side controller that keeps `<html data-layout>`
// in sync with `appStore.layoutMode`. Mirrors how ColorThemeToggle keeps
// `data-theme` / `data-variant` synced. Initial paint is handled by the
// inline script in `yha.html`; this effect picks up changes that happen
// after mount.

import { useEffect } from 'react';
import { useAppStore } from '../stores/appStore.js';

export function LayoutAttribute() {
  const layoutMode = useAppStore((s) => s.layoutMode);

  useEffect(() => {
    const root = document.documentElement;
    const prev = root.getAttribute('data-layout');
    if (prev !== layoutMode) {
      root.setAttribute('data-layout', layoutMode);
      try {
        window.dispatchEvent(new CustomEvent('yha:layout', { detail: { layoutMode } }));
      } catch { /* ignore (test/SSR env) */ }
    }
  }, [layoutMode]);

  return null;
}
