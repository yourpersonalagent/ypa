// ColorThemeToggle — React controller for the color theme.
// Keeps document.data-theme + data-variant in sync with appStore whenever
// colorTheme changes from any source (vanilla JS btn-theme click, hotkey,
// prefs dropdown, or direct store write).

import { useEffect } from 'react';
import { useAppStore } from './stores/index.js';
import { applyColorThemeToDom } from './color-themes-config.js';

export function ColorThemeToggle() {
  const id = useAppStore((s) => s.colorTheme);

  useEffect(() => {
    applyColorThemeToDom(id);
  }, [id]);

  return null;
}
